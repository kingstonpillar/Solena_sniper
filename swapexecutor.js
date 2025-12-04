// swapexecutor.js — on-chain Jupiter swap executor (keyless Jupiter: build unsigned -> sign locally -> send)
// Exports: StartWatcher, StopWatcher, executeSwap
import fs from "fs";
import path from "path";
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
import crypto from "crypto";
import PQueue from "p-queue";

import { allSellsComplete } from "./sellmonitor.js";
import { currentTradeAmount, computeUnitPerTrade } from "./walletbalance.js";

import {
  initJupiter,
  getBestRoute,
  simulateSwap,
  executeSwapJupiter,
} from "./jupiterOnchain.js";

dotenv.config();

// ------------------------------------------------------
// Rate limiter
// ------------------------------------------------------
const limiter = new PQueue({
  intervalCap: 6,
  interval: 1000,
  carryoverConcurrencyCount: true
});
async function limit(fn) { return limiter.add(fn); }

// ----------------------------------------------------
const RPC_URL = process.env.RPC_URL_5 || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const ACTIVE_POSITIONS_FILE = path.resolve(process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json");
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_ACTIVE_POSITIONS = parseInt(process.env.MAX_ACTIVE_POSITIONS || "20", 10);

const JUPITER_QUOTE_RETRY = Number(process.env.JUPITER_QUOTE_RETRY || 2);
const JUPITER_SWAP_RETRY = Number(process.env.JUPITER_SWAP_RETRY || 2);
const SEND_TX_RETRY = Number(process.env.SEND_TX_RETRY || 2);

const conn = new Connection(RPC_URL);

// ----------------------------------------------------
// AES decrypt private key helper (used to sign locally)
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
  const secretKey = bs58.decode(decrypted);
  const wallet = Keypair.fromSecretKey(secretKey);

  // debug: confirm decrypt
  console.log("🔐 Wallet decrypted OK:", wallet.publicKey.toBase58());
  return wallet;
}

// Telegram helper (rate-limited)
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  return limit(async () => {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" }),
      });
    } catch (err) {
      console.error("❌ Telegram send error:", err.message);
    }
  });
}

// small utils
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
async function retry(fn, attempts = 3, backoffMs = 1000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) { last = err; if (i < attempts - 1) await delay(backoffMs * (i + 1)); }
  }
  throw last;
}

function safeReadJsonFile(pathStr) {
  try {
    if (!fs.existsSync(pathStr)) return [];
    const raw = fs.readFileSync(pathStr, "utf8");
    return JSON.parse(raw || "[]");
  } catch { return []; }
}
function atomicWrite(pathStr, obj) {
  const tmp = `${pathStr}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, pathStr);
}

// Watcher control
let watcherActive = true;
export async function StartWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 *Liquidity Watcher Started*");
}
export async function StopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 *Liquidity Watcher Stopped — waiting for sells...*");
}

// Main executeSwap (this module's exported function)
export async function executeSwap(inputMint, outputMint) {
  if (!currentTradeAmount || currentTradeAmount <= 0) {
    console.log("⚠️ currentTradeAmount not ready.");
    return null;
  }
  if (computeUnitPerTrade == null) {
    console.log("⚠ computeUnitPerTrade missing.");
    return null;
  }

  // decrypt local wallet (we sign locally; we DO NOT inject into env)
  let wallet;
  try {
    wallet = getWalletFromEnvEncrypted();
  } catch (err) {
    console.error("❌ Wallet load error:", err.message || err);
    return null;
  }
  const userPubkey = wallet.publicKey.toBase58();

  // ensure active positions file
  let currentData = safeReadJsonFile(ACTIVE_POSITIONS_FILE);
  if (!Array.isArray(currentData)) currentData = [];

  if (currentData.length >= MAX_ACTIVE_POSITIONS) {
    console.log("🕒 Max active positions reached.");
    await StopWatcher();
    await allSellsComplete();
    await StartWatcher();
    currentData = safeReadJsonFile(ACTIVE_POSITIONS_FILE) || [];
  }

  // Init Jupiter (keyless) with same RPC
  try {
    await initJupiter({ rpc: RPC_URL, cluster: "mainnet-beta" });
  } catch (err) {
    console.error("❌ initJupiter failed:", err.message || err);
    return null;
  }

  // amount in lamports for SOL -> numeric raw amount expected by SDK
  const amountRaw = Math.floor(currentTradeAmount * 1e9); // SOL -> lamports
  console.log(`🪙 Requesting on-chain quote for ${currentTradeAmount} SOL -> ${outputMint}`);

  // Get best route, retry if needed
  let route = null;
  try {
    route = await retry(() => getBestRoute(inputMint, outputMint, amountRaw, { preferDex: null }), JUPITER_QUOTE_RETRY, 1200);
  } catch (err) {
    console.error("❌ Quote (on-chain) error:", err.message || err);
    return null;
  }
  if (!route) { console.error("❌ No route available."); return null; }

  // simulate (optional, nonblocking)
  try {
    const sim = await limit(() => simulateSwap(route));
    if (sim) console.log("🔎 Simulation result:", typeof sim === "object" ? JSON.stringify(sim).slice(0, 400) : String(sim));
  } catch (err) {
    console.warn("⚠ Simulation failed (continuing):", err.message || err);
  }

  // DRY RUN: abort early, return route summary (no fund movement)
  if (process.env.DRY_RUN === "true") {
    const outAmount = Number(route?.outAmount ?? route?.bestRoute?.outAmount ?? 0);
    const outDecimals = Number(route?.outDecimals ?? route?.bestRoute?.outDecimals ?? 0);
    const expectedOutput = outDecimals ? (outAmount / (10 ** outDecimals)) : outAmount;

    console.log("🧪 DRY RUN MODE — NO TRANSACTION WILL BE SENT");
    console.log("🧪 Route summary:", {
      inputMint,
      outputMint,
      amountSOL: currentTradeAmount,
      expectedOutput,
      routeSummary: {
        inAmount: route?.inAmount,
        outAmount: route?.outAmount,
        slippageBps: route?.slippageBps
      }
    });

    return { dryRun: true, routeUsed: route, expectedOutput, message: "Dry-run completed. No on-chain transaction executed." };
  }

  // REAL EXECUTION: ask Jupiter to build unsigned tx, sign locally, send raw
  let signature;
  try {
    const jresp = await retry(async () => {
      const r = await limit(() => executeSwapJupiter(route, { skipPreflight: false }));
      if (!r || !r.unsignedTx) throw new Error("Jupiter returned no unsignedTx");
      return r;
    }, JUPITER_SWAP_RETRY, 1200);

    // normalize unsignedTx to Buffer
    const raw = jresp.unsignedTx;
    const unsignedBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    // deserialize -> sign -> serialize -> send
    const tx = VersionedTransaction.deserialize(unsignedBuf);

    // optionally add compute budget before signing here (not modifying message in this snippet)
    tx.sign([wallet]); // local signing

    const signedSerialized = tx.serialize();

    signature = await retry(() => conn.sendRawTransaction(signedSerialized, { skipPreflight: false }), SEND_TX_RETRY, 1000);
    await retry(() => conn.confirmTransaction(signature, "confirmed"), 3, 1000);

  } catch (err) {
    console.error("❌ Sign & send failed:", err.message || err);
    return null;
  }

  // persist position + notify
  try {
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

    await sendTelegram(`🚀 *BUY EXECUTED*\nToken: ${outputSymbol}\nAmount: ${currentTradeAmount} SOL\nhttps://solscan.io/tx/${signature}`);
    console.log(`✅ SWAP EXECUTED: https://solscan.io/tx/${signature}`);
  } catch (err) {
    console.error("⚠ Save/notify fail:", err.message || err);
  }

  return signature;
}