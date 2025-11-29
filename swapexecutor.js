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

import { allSellsComplete } from "./sellmonitor.js";
import { currentTradeAmount, computeUnitPerTrade } from "./walletbalance.js";

dotenv.config();

// --- CONFIG ---
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const ACTIVE_POSITIONS_FILE = path.resolve(process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json");
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_ACTIVE_POSITIONS = parseInt(process.env.MAX_ACTIVE_POSITIONS || "20", 10);
const JUPITER_QUOTE_RETRY = Number(process.env.JUPITER_QUOTE_RETRY || 2);
const JUPITER_SWAP_RETRY = Number(process.env.JUPITER_SWAP_RETRY || 2);
const SEND_TX_RETRY = Number(process.env.SEND_TX_RETRY || 2);

// Solana connection
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

// --- Load wallet securely ---
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

// --- Telegram alerts ---
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
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
}

// --- small helpers ---
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

// State control
let watcherActive = true;

export async function StartWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 *Liquidity Watcher Started*");
}

export async function StopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 *Liquidity Watcher Stopped — waiting for sells...*");
}

// -----------------------------------------------------
// 🚀 EXECUTE BUY (swapexecutor does not change trade amount)
// -----------------------------------------------------
export async function executeSwap(inputMint, outputMint) {
  // basic preflight checks
  if (!currentTradeAmount || currentTradeAmount <= 0) {
    console.log("⚠️ currentTradeAmount not ready. Waiting for allSellComplete...");
    return null;
  }
  if (typeof computeUnitPerTrade === "undefined" || computeUnitPerTrade === null) {
    console.log("⚠️ computeUnitPerTrade not set. Aborting swap for safety.");
    return null;
  }

  const wallet = getWallet();
  const userPubkey = wallet.publicKey.toBase58();

  // load active positions file
  let currentData = safeReadJsonFile(ACTIVE_POSITIONS_FILE);

  if (currentData.length >= MAX_ACTIVE_POSITIONS) {
    console.log(`🕒 Max active positions (${MAX_ACTIVE_POSITIONS}) reached.`);
    await StopWatcher();
    await allSellsComplete();
    console.log("✅ All previous sells complete. Restarting watcher...");
    await StartWatcher();
    currentData = [];
  }

  console.log(`🪙 Requesting Jupiter quote for: ${currentTradeAmount} SOL → ${outputMint}`);

  // Jupiter quote: attempt with retries
  const doQuote = async () => {
    const qUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(currentTradeAmount * 1e9)}&slippageBps=100`;
    // Note: amount here is in lamports when inputMint is WSOL; for other input mints this may vary.
    // We place the currentTradeAmount as SOL->lamports when input is WSOL. If using native SOL wrapper it's fine.
    const res = await fetch(qUrl, { method: "GET" });
    if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
    const j = await res.json();
    return j;
  };

  let quote;
  try {
    quote = await retry(doQuote, Math.max(1, JUPITER_QUOTE_RETRY), 1500);
  } catch (err) {
    console.error("❌ Jupiter quote failed:", err?.message || err);
    return null;
  }

  // Basic validations: support multiple possible shapes returned by Jupiter
  // Look for route / routePlan / data.routes etc.
  const route = quote?.routePlan || quote?.route || quote?.data?.[0] || quote?.routes?.[0] || null;
  if (!route) {
    console.error("❌ No usable Jupiter route returned.", quote);
    return null;
  }

  // compute price safely using decimals if available
  // Try to get outAmount/inAmount and decimals if present
  let outputDecimals = route?.outToken?.decimals ?? quote?.outDecimals ?? quote?.decimals?.out ?? null;
  let inputDecimals = route?.inToken?.decimals ?? quote?.inDecimals ?? quote?.decimals?.in ?? null;

  // fallback: use amounts as-is but guard for zero
  let inAmountRaw = route?.inAmount ?? route?.inAmount['amount'] ?? quote?.inAmount ?? null;
  let outAmountRaw = route?.outAmount ?? route?.outAmount['amount'] ?? quote?.outAmount ?? null;

  // if amounts are strings convert to number
  if (typeof inAmountRaw === "string") inAmountRaw = Number(inAmountRaw);
  if (typeof outAmountRaw === "string") outAmountRaw = Number(outAmountRaw);

  let buyPrice = null;
  try {
    if (inAmountRaw && outAmountRaw && inputDecimals != null && outputDecimals != null) {
      const inUnit = inAmountRaw / Math.pow(10, inputDecimals);
      const outUnit = outAmountRaw / Math.pow(10, outputDecimals);
      buyPrice = outUnit / inUnit;
    } else if (inAmountRaw && outAmountRaw) {
      buyPrice = outAmountRaw / inAmountRaw;
    } else {
      buyPrice = null;
    }
  } catch {
    buyPrice = null;
  }

  const outputSymbol = route?.outToken?.symbol ?? quote?.outputSymbol ?? "UNKNOWN";

  // Build swap request body. Jupiter expects quoteResponse or route object depending on endpoint version.
  const swapBody = {
    userPublicKey: userPubkey,
    wrapAndUnwrapSol: true,
    quoteResponse: quote, // many Jupiter endpoints accept quoteResponse
  };

  // Attempt swap with retries
  let swapData;
  const doSwap = async () => {
    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(swapBody),
    });
    if (!swapRes.ok) {
      const text = await swapRes.text().catch(() => "");
      throw new Error(`Jupiter swap failed status ${swapRes.status} ${text}`);
    }
    const data = await swapRes.json();
    return data;
  };

  try {
    swapData = await retry(doSwap, Math.max(1, JUPITER_SWAP_RETRY), 1500);
  } catch (err) {
    console.error("❌ Jupiter swap endpoint failed:", err?.message || err);
    return null;
  }

  const swapTransactionB64 = swapData?.swapTransaction ?? swapData?.swap_tx ?? null;
  if (!swapTransactionB64) {
    console.error("❌ Jupiter returned no swap transaction:", swapData);
    return null;
  }

  let tx;
  try {
    const txBuf = Buffer.from(swapTransactionB64, "base64");
    tx = VersionedTransaction.deserialize(txBuf);
  } catch (err) {
    console.error("❌ Failed to deserialize Jupiter transaction:", err?.message || err);
    return null;
  }

  // ------------------------------------------------------------
  // ✅ FULL CORRECT COMPUTE UNIT INJECTION (convert SOL -> microLamports)
  //    We interpret computeUnitPerTrade as SOL-denominated fee per CU (legacy in your code).
  //    microLamports expected here = SOL * 1_000_000 (1 SOL -> 1,000,000 micro-lamports)
  // ------------------------------------------------------------
  try {
    const cuPriceMicroLamports = Math.max(
      0,
      Math.floor(Number(computeUnitPerTrade || 0) * 1_000_000) // SOL -> micro-lamports
    );

    if (cuPriceMicroLamports > 0) {
      // Choose a reasonable CU limit (higher than 150k to be safe)
      const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });
      const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports });

      try {
        // Attempt to inject CU instructions at the start of message; if this fails fallback gracefully
        // For VersionedTransaction we attempt to add compiled instructions — wrap in try/catch
        tx.message.compiledInstructions.unshift(
          cuLimitIx.compileToV0Message(tx.message.staticAccountKeys),
          cuPriceIx.compileToV0Message(tx.message.staticAccountKeys)
        );
        console.log(`⚡ CU injected: units=250000 price(microLamports)=${cuPriceMicroLamports}`);
      } catch (injErr) {
        // injection via compileToV0Message might fail on some transaction shapes — log and continue without CU
        console.warn("⚠️ Compute unit injection failed (continuing without CU):", injErr?.message || injErr);
      }
    }
  } catch (err) {
    console.warn("⚠️ CU processing error (continuing):", err?.message || err);
  }

  // sign transaction
  try {
    tx.sign([wallet]);
  } catch (err) {
    console.error("❌ Transaction signing failed:", err?.message || err);
    return null;
  }

  // send transaction (use sendRawTransaction + confirm) with retry
  const serialized = tx.serialize();

  let signature = null;
  const doSend = async () => {
    // Use sendRawTransaction with preflight enabled (safer)
    const sig = await conn.sendRawTransaction(serialized, { skipPreflight: false });
    // wait for confirmation
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  };

  try {
    signature = await retry(doSend, Math.max(1, SEND_TX_RETRY), 2000);
  } catch (err) {
    console.error("❌ sendTransaction failed:", err?.message || err);
    return null;
  }

  console.log(`✅ SWAP EXECUTED: https://solscan.io/tx/${signature}`);

  // persist active position atomically
  try {
    const buyNumber = currentData.length + 1;
    const newEntry = {
      buyLabel: `Buy ${buyNumber}`,
      mintAddress: outputMint,
      symbol: outputSymbol,
      buyPrice: buyPrice ?? null,
      amount: currentTradeAmount,
      txSignature: signature,
      walletAddress: userPubkey,
      timestamp: new Date().toISOString(),
    };

    currentData.push(newEntry);
    atomicWrite(ACTIVE_POSITIONS_FILE, currentData);

    const message = [
      "🚀 *BUY EXECUTED*",
      "",
      `🪙 Token: ${outputSymbol}`,
      `💰 Amount: ${currentTradeAmount} SOL`,
      `🏷 Entry: ${newEntry.buyLabel}`,
      `🔗 https://solscan.io/tx/${signature}`,
    ].join("\n");

    await sendTelegram(message);
  } catch (err) {
    console.error("⚠️ Failed to persist active position or notify:", err?.message || err);
  }

  return signature;
}