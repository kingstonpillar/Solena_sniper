// swapexecutor.js — safer, retrying Jupiter swap executor
import fs from "fs";
import { 
  Connection, 
  Keypair, 
  VersionedTransaction,
  ComputeBudgetProgram 
} from "@solana/web3.js";
import bs58 from "bs58";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import PQueue from "p-queue";   //  <<<<<< ADDED

import { allSellsComplete } from "./sellmonitor.js";
import { currentTradeAmount, computeUnitPerTrade } from "./walletbalance.js";

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

// --- 🔐 AES decrypt private key ---
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWallet() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("❌ ENCRYPTED_KEY missing in .env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("❌ Passphrase file missing.");
  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();

  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

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

let watcherActive = true;

export async function StartWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 *Liquidity Watcher Started*");
}

export async function StopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 *Liquidity Watcher Stopped — waiting for sells...*");
}

export async function executeSwap(inputMint, outputMint) {

  if (!currentTradeAmount || currentTradeAmount <= 0) {
    console.log("⚠️ currentTradeAmount not ready.");
    return null;
  }

  if (computeUnitPerTrade == null) {
    console.log("⚠ computeUnitPerTrade missing.");
    return null;
  }

  const wallet = getWallet();
  const userPubkey = wallet.publicKey.toBase58();

  let currentData = safeReadJsonFile(ACTIVE_POSITIONS_FILE);

  if (currentData.length >= MAX_ACTIVE_POSITIONS) {
    console.log(`🕒 Max active positions reached.`);
    await StopWatcher();
    await allSellsComplete();
    console.log("Restarting watcher...");
    await StartWatcher();
    currentData = [];
  }

  console.log(`🪙 Requesting quote for ${currentTradeAmount} SOL → ${outputMint}`);

  // ------------------------------------------------
  // ⭐ Jupiter Quote under rate limit
  // ------------------------------------------------
  const getQuote = () => limit(async () => {
    const qUrl =
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}` +
      `&outputMint=${outputMint}&amount=${Math.floor(currentTradeAmount * 1e9)}` +
      `&slippageBps=100`;

    const res = await fetch(qUrl);
    if (!res.ok) throw new Error(`Quote failed ${res.status}`);
    return res.json();
  });

  let quote;
  try {
    quote = await retry(getQuote, JUPITER_QUOTE_RETRY, 1200);
  } catch (err) {
    console.error("❌ Quote error:", err.message);
    return null;
  }

  const route =
    quote?.routePlan ||
    quote?.route ||
    quote?.data?.[0] ||
    quote?.routes?.[0] ||
    null;

  if (!route) {
    console.error("❌ Invalid Jupiter quote:", quote);
    return null;
  }

  let outputSymbol = route?.outToken?.symbol ?? "UNK";

  // ------------------------------------------------
  // ⭐ Jupiter Swap under rate limit
  // ------------------------------------------------
  const getSwap = () => limit(async () => {
    const res = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userPublicKey: userPubkey,
        wrapAndUnwrapSol: true,
        quoteResponse: quote,
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Swap failed ${res.status} ${t}`);
    }

    return res.json();
  });

  let swapData;
  try {
    swapData = await retry(getSwap, JUPITER_SWAP_RETRY, 1200);
  } catch (err) {
    console.error("❌ Jupiter swap fail:", err.message);
    return null;
  }

  const swapTransactionB64 = swapData?.swapTransaction;
  if (!swapTransactionB64) {
    console.error("❌ No swap transaction returned.");
    return null;
  }

  let tx;
  try {
    tx = VersionedTransaction.deserialize(
      Buffer.from(swapTransactionB64, "base64")
    );
  } catch (err) {
    console.error("❌ Deserialize fail:", err.message);
    return null;
  }

  // ------------------------------------------------
  // SIGN + SEND TX (RPC) under rate limit
  // ------------------------------------------------
  try {
    tx.sign([wallet]);
  } catch (err) {
    console.error("❌ Sign fail:", err.message);
    return null;
  }

  const serialized = tx.serialize();

  const sendTx = () => limit(async () => {
    const sig = await conn.sendRawTransaction(serialized, { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  });

  let signature;
  try {
    signature = await retry(sendTx, SEND_TX_RETRY, 1500);
  } catch (err) {
    console.error("❌ RPC send fail:", err.message);
    return null;
  }

  console.log(`✅ SWAP EXECUTED: https://solscan.io/tx/${signature}`);

  try {
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

  } catch (err) {
    console.error("⚠ Save/notify fail:", err.message);
  }

  return signature;
}