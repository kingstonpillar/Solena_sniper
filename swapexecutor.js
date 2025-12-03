// swapexecutor.js — on-chain Jupiter swap executor (no HTTP Jupiter API)
// Uses: jupiterOnchain.js -> initJupiter, getBestRoute, simulateSwap, executeSwap
// Keeps: AES decrypt keyflow, rate limiting, retries, telegram, position persistence.

import fs from "fs";
import path from "path";
import {
  Connection,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
import crypto from "crypto";
import PQueue from "p-queue";

import { allSellsComplete } from "./sellmonitor.js";
import { currentTradeAmount, computeUnitPerTrade } from "./walletbalance.js";

// Jupiter on-chain helpers (no HTTP). Must exist in your project.
import {
  initJupiter,
  getBestRoute,
  simulateSwap,
  executeSwap,
} from "./jupiterOnchain.js";

dotenv.config();

// ------------------------------------------------------
// 🔥 LOCAL RATE LIMITER — MAX 6 REQUESTS PER SECOND
// ------------------------------------------------------
const limiter = new PQueue({
  intervalCap: 6,
  interval: 1000,
  carryoverConcurrencyCount: true
});

async function limit(fn) {
  return limiter.add(fn);
}

// ----------------------------------------------------
const RPC_URL = process.env.RPC_URL_5 || "https://api.mainnet-beta.solana.com";
const ACTIVE_POSITIONS_FILE = path.resolve(process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json");
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_ACTIVE_POSITIONS = parseInt(process.env.MAX_ACTIVE_POSITIONS || "20", 10);

const JUPITER_QUOTE_RETRY = Number(process.env.JUPITER_QUOTE_RETRY || 2);
const JUPITER_SWAP_RETRY = Number(process.env.JUPITER_SWAP_RETRY || 2);
const SEND_TX_RETRY = Number(process.env.SEND_TX_RETRY || 2);

const conn = new Connection(RPC_URL);

// ----------------------------------------------------
// AES decrypt private key (existing flow)
// ----------------------------------------------------
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWalletFromEnvEncrypted() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("❌ ENCRYPTED_KEY missing in .env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("❌ Passphrase file missing.");
  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();

  const decrypted = decryptPrivateKey(encrypted, passphrase);

  // decrypted is expected to be base58 secret key (your previous flow).
  // bs58 decode returns the secretKey bytes (Uint8Array-like Buffer)
  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

// ----------------------------------------------------
// Telegram helper
// ----------------------------------------------------
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  return limit(async () => {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      });
    } catch (err) {
      console.error("❌ Telegram send error:", err.message);
    }
  });
}

// ----------------------------------------------------
// small util
// ----------------------------------------------------
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function retry(fn, attempts = 3, backoffMs = 1000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await delay(backoffMs * (i + 1));
    }
  }
  throw lastErr;
}

function safeReadJsonFile(pathStr) {
  try {
    if (!fs.existsSync(pathStr)) return [];
    const raw = fs.readFileSync(pathStr, "utf8");
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

function atomicWrite(pathStr, obj) {
  const tmp = `${pathStr}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, pathStr);
}

// ----------------------------------------------------
// Watcher control
// ----------------------------------------------------
let watcherActive = true;

export async function StartWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 *Liquidity Watcher Started*");
}

export async function StopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 *Liquidity Watcher Stopped — waiting for sells...*");
}

// ----------------------------------------------------
// Main executeSwap (on-chain Jupiter v6 SDK flow)
// ----------------------------------------------------
export async function executeSwap(inputMint, outputMint) {

  // Guard: trade amount ready
  if (!currentTradeAmount || currentTradeAmount <= 0) {
    console.log("⚠️ currentTradeAmount not ready.");
    return null;
  }

  if (computeUnitPerTrade == null) {
    console.log("⚠ computeUnitPerTrade missing.");
    return null;
  }

  // Load wallet (decrypt)
  let wallet;
  try {
    wallet = getWalletFromEnvEncrypted();
  } catch (err) {
    console.error("❌ Wallet load error:", err.message || err);
    return null;
  }
  const userPubkey = wallet.publicKey.toBase58();

  // Ensure ACTIVE_POSITIONS_FILE doesn't overflow
  let currentData = safeReadJsonFile(ACTIVE_POSITIONS_FILE);
  if (!Array.isArray(currentData)) currentData = [];

  if (currentData.length >= MAX_ACTIVE_POSITIONS) {
    console.log(`🕒 Max active positions reached.`);
    await StopWatcher();
    // wait until sells complete (caller will manage long-term behavior)
    await allSellsComplete();
    console.log("Restarting watcher...");
    await StartWatcher();
    currentData = safeReadJsonFile(ACTIVE_POSITIONS_FILE) || [];
  }

  // initialize Jupiter on-chain SDK with this wallet
  // The jupiterOnchain.initJupiter expects PRIVATE_KEY env as JSON array OR uses user param.
  // To keep jupiterOnchain's loadWalletFromEnv intact we set process.env.PRIVATE_KEY as JSON array.
  try {
    const secret = wallet.secretKey;
    // convert to JSON array form expected by jupiterOnchain
    process.env.PRIVATE_KEY = JSON.stringify(Array.from(secret));
  } catch (e) {
    console.warn("Could not set process.env.PRIVATE_KEY for jupiterOnchain init. Proceeding — initJupiter may still accept user param.");
  }

  // init jupiter with connection and wallet
  try {
    // pass rpc so jupiterOnchain uses same RPC as this module
    await initJupiter({ rpc: RPC_URL, cluster: "mainnet-beta" });
  } catch (err) {
    console.error("❌ initJupiter failed:", err.message || err);
    return null;
  }

  // amount in lamports for SOL -> numeric raw amount expected by SDK
  const amountRaw = Math.floor(currentTradeAmount * 1e9); // SOL -> lamports

  console.log(`🪙 Requesting on-chain quote for ${currentTradeAmount} SOL -> ${outputMint}`);

  // ------------------------------------------------
  // ⭐ Get best route via on-chain Jupiter
  // ------------------------------------------------
  let route = null;
  try {
    route = await retry(
      async () => {
        // getBestRoute returns the route object (uses on-chain quoting, no HTTP)
        const r = await getBestRoute(inputMint, outputMint, amountRaw, { preferDex: null });
        if (!r) throw new Error("No route returned");
        return r;
      },
      JUPITER_QUOTE_RETRY,
      1200
    );
  } catch (err) {
    console.error("❌ Quote (on-chain) error:", err.message || err);
    return null;
  }

  if (!route) {
    console.error("❌ No route available.");
    return null;
  }

  // Optionally simulate (non-essential but useful)
  try {
    const sim = await limit(() => simulateSwap(route));
    // some SDK shapes return simulationResult or object. We won't abort on simulation failures,
    // but log results if available.
    if (sim) {
      console.log("🔎 Simulation result:", typeof sim === "object" ? JSON.stringify(sim).slice(0, 400) : String(sim));
    }
  } catch (err) {
    console.warn("⚠ Simulation failed (continuing to swap):", err.message || err);
  }

  // ------------------------------------------------
  // ⭐ Execute swap using jupiterOnchain.executeSwap
  //    This function in jupiterOnchain will perform swapPost and send the tx
  //    using the wallet that was loaded during initJupiter().
  // ------------------------------------------------
  let execResult;
  try {
    execResult = await retry(
      async () => {
        // wrap with limiter to control rate of swap requests
        return await limit(() => executeSwap(route, { skipPreflight: false }));
      },
      JUPITER_SWAP_RETRY,
      1200
    );
  } catch (err) {
    console.error("❌ Jupiter executeSwap failed:", err.message || err);
    return null;
  }

  // execResult expected shape: { txid: <sig>, confirmed: <confirmation> } (per jupiterOnchain.executeSwap)
  const signature = execResult?.txid ?? execResult?.signature ?? null;
  if (!signature) {
    console.error("❌ executeSwap returned no txid:", execResult);
    return null;
  }

  // wait+confirm was done inside jupiterOnchain.executeSwap, but if not, we could confirm here.
  try {
    // persist position + notify
    const outputSymbol = route?.outToken?.symbol ?? route?.outTokenAddress ?? "UNK";

    const newEntry = {
      buyLabel: `Buy ${currentData.length + 1}`,
      mintAddress: outputMint,
      symbol: outputSymbol,
      buyPrice: null,
      amount: currentTradeAmount,
      txSignature: signature,
      walletAddress: userPubkey,
      timestamp: new Date().toISOString(),
    };

    currentData.push(newEntry);
    atomicWrite(ACTIVE_POSITIONS_FILE, currentData);

    await sendTelegram(
      `🚀 *BUY EXECUTED*\n` +
      `Token: ${outputSymbol}\n` +
      `Amount: ${currentTradeAmount} SOL\n` +
      `https://solscan.io/tx/${signature}`
    );

    console.log(`✅ SWAP EXECUTED: https://solscan.io/tx/${signature}`);

  } catch (err) {
    console.error("⚠ Save/notify fail:", err.message || err);
  }

  return signature;
}