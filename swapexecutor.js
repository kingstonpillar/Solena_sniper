// swapexecutor-grade1.js
// Grade-1 Production / Fast-mode (AUTO-dynamic slippage)
// - Default mode: FAST (no simulation) as requested
// - Auto-dynamic slippage (1C): computed from two quick price samples (best-effort)
// - RPC limit: 6 RPS (per-file limiter)
// - Maintains compatibility with your dexBuilders API

import fs from "fs";
import path from "path";
import {
  Connection,
  Keypair,
  VersionedTransaction,
  Transaction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
import crypto from "crypto";
import PQueue from "p-queue";

import { allSellsComplete } from "./sellmonitor.js";
import { currentTradeAmount, computeUnitPerTrade } from "./walletbalance.js";

import {
  selectDexForMint,
  buildSwapTx,
  dryRun,
  findPoolsForPair
} from "./dexBuilders.js";

import { scanMintFast } from "./priceScanner.js"; // used for price sampling & entry price determination

dotenv.config();

/* -------------------------------------------------------------------------- */
/*                                RATE LIMITER                                */
/* -------------------------------------------------------------------------- */
/*
  Per your instruction: single file single RPC limiter of 6 requests/sec.
  This limiter is used for outgoing RPC (and heavy ops) within this module.
*/
const limiter = new PQueue({
  interval: 1000,
  intervalCap: 6,
  carryoverConcurrencyCount: true
});
async function limit(fn) { return limiter.add(fn); }

/* -------------------------------------------------------------------------- */

const RPC_URL =
  process.env.RPC_URL_5 ||
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const ACTIVE_POSITIONS_FILE = path.resolve(
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json"
);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_ACTIVE_POSITIONS = Number(process.env.MAX_ACTIVE_POSITIONS || "20");
const SEND_TX_RETRY = Number(process.env.SEND_TX_RETRY || "2");

// Modes: FAST / SAFE / NITRO - you asked default FAST_MODE (FAST)
const MODE = (process.env.SWAP_MODE || "FAST").toUpperCase();

const conn = new Connection(RPC_URL, "confirmed");

/* -------------------------------------------------------------------------- */
/*                         AES DECRYPT PRIVATE KEY                            */
/* -------------------------------------------------------------------------- */

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
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in .env");

  const passphrasePath =
    process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath))
    throw new Error("Passphrase file missing.");

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secretKey = bs58.decode(decrypted);

  const wallet = Keypair.fromSecretKey(secretKey);
  console.log("🔐 Wallet decrypted OK:", wallet.publicKey.toBase58());

  return wallet;
}

/* -------------------------------------------------------------------------- */
/*                               TELEGRAM SEND                                */
/* -------------------------------------------------------------------------- */

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  return limit(async () => {
    try {
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: msg,
            parse_mode: "Markdown"
          })
        }
      );
    } catch (err) {
      console.error("Telegram send error:", err.message);
    }
  });
}

/* -------------------------------------------------------------------------- */
/*                              UTIL / RETRY HELPERS                           */
/* -------------------------------------------------------------------------- */

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function retry(fn, attempts = 3, backoff = 1000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (i < attempts - 1) await delay(backoff * (i + 1));
    }
  }
  throw last;
}

function safeRead(pathStr) {
  try {
    if (!fs.existsSync(pathStr)) return [];
    return JSON.parse(fs.readFileSync(pathStr, "utf8") || "[]");
  } catch { return []; }
}

function atomicWrite(pathStr, obj) {
  const tmp = `${pathStr}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, pathStr);
}

/* -------------------------------------------------------------------------- */
/*                               WATCHER CONTROL                              */
/* -------------------------------------------------------------------------- */

let watcherActive = true;

export async function StartWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 *Liquidity Watcher Started*");
}

export async function StopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 *Liquidity Watcher Stopped*");
}


  /* -------------------------------------------------------------------------- */
/*                     AUTO-DYNAMIC SLIPPAGE (BPS)                             */
/* -------------------------------------------------------------------------- */

/**
 * Sample token price quickly to estimate short-term volatility
 * @param {string} mint - token mint address
 * @param {number} samples - number of samples (default 2)
 * @param {number} delayMs - delay between samples in ms (default 500)
 * @returns {object|null} - { volatilityPct, lastPriceSOL } or null if failed
 */
async function samplePriceForVolatility(mint, samples = 2, delayMs = 500) {
  try {
    const prices = [];
    for (let i = 0; i < samples; i++) {
      const p = await limit(() => scanMintFast(conn, mint, { dataSliceLen: 220, retries: 1 }));
      const priceSOL = p?.priceInSOL ?? p?.price ?? null;
      prices.push(priceSOL);
      if (i < samples - 1) await delay(delayMs);
    }

    const valid = prices.filter(v => typeof v === "number" && isFinite(v));
    if (valid.length < 2) return null;

    let maxPct = 0;
    for (let i = 1; i < valid.length; i++) {
      const pct = Math.abs((valid[i] - valid[i - 1]) / valid[i - 1]) * 100;
      if (pct > maxPct) maxPct = pct;
    }

    return { volatilityPct: maxPct, lastPriceSOL: valid[valid.length - 1] };
  } catch {
    return null;
  }
}

/**
 * Compute dynamic slippage in basis points (bps) from volatility
 * @param {number} volatilityPct - percent volatility (e.g., 0.8 for 0.8%)
 * @param {string} mode - "FAST" | "SAFE" | "NITRO" (default: MODE)
 * @returns {number} - slippage in bps
 */
function computeSlippageFromVolatilityBps(volatilityPct, mode = MODE) {
  // Base slippage (bps) per mode
  const base = mode === "SAFE" ? 25 : (mode === "NITRO" ? 50 : 35);
  const mult = 15; // 15 bps per 1% volatility
  const min = 15; // minimum 15 bps
  const max = 500; // maximum 500 bps

  const v = Math.max(0, volatilityPct || 0);
  let s = base + Math.round(v * mult);

  if (s < min) s = min;
  if (s > max) s = max;

  return s; // bps
}


/* -------------------------------------------------------------------------- */
/*                          BUILD / SEND / SAVE SWAP                           */
/* -------------------------------------------------------------------------- */

/**
 * executeSwap(inputMint, outputMint)
 * - BUY only: swaps inputMint -> outputMint using dexBuilders.buildSwapTx
 * - Default FAST_MODE: no simulation, minimal checks
 * - Slippage: AUTO-DYNAMIC (sample-based) as chosen: 1C
 */
export async function executeSwap(inputMint, outputMint) {
  // Validate currentTradeAmount
  if (!currentTradeAmount || currentTradeAmount <= 0) {
    console.log("currentTradeAmount not ready.");
    return null;
  }

  if (computeUnitPerTrade == null) {
    console.log("computeUnitPerTrade missing.");
    return null;
  }

  // Decrypt wallet
  let wallet;
  try {
    wallet = getWalletFromEnvEncrypted();
  } catch (err) {
    console.error("Wallet decrypt error:", err.message);
    return null;
  }
  const userPubkey = wallet.publicKey.toBase58();

  // Active positions guard
  let active = safeRead(ACTIVE_POSITIONS_FILE);
  if (!Array.isArray(active)) active = [];
  if (active.length >= MAX_ACTIVE_POSITIONS) {
    console.log("Max positions reached. Pausing watcher.");
    await StopWatcher();
    await allSellsComplete();
    await StartWatcher();
    active = safeRead(ACTIVE_POSITIONS_FILE);
  }

  // Amount raw in lamports (SOL)
  const amountRaw = Math.floor(currentTradeAmount * 1e9);
  console.log(`🪙 Swap request: ${currentTradeAmount} SOL -> ${outputMint} (raw ${amountRaw})`);

  // Select DEX (best-effort)
  let dex;
  try {
    dex = await limit(() => selectDexForMint(conn, outputMint));
    console.log("🔎 Selected DEX:", dex);
  } catch (err) {
    console.error("DEX detection error:", err?.message || err);
  }

  // --- Auto-dynamic slippage (BPS) ---
  let volInfo = await samplePriceForVolatility(outputMint, 2, 500);
  const volPct = volInfo?.volatilityPct ?? 0;
  const dynamicSlippageBps = computeSlippageFromVolatilityBps(volPct, MODE);
  console.log(`Dynamic slippage: ${dynamicSlippageBps} bps (${volPct.toFixed(2)}% volatility)`);

  // Build swap transaction
  let built = null;
  let buildDex = dex || "unknown";

  try {
    built = await limit(() => buildSwapTx(conn, wallet.publicKey, inputMint, outputMint, amountRaw, {
      slippageBps: dynamicSlippageBps,
      mode: MODE,
    }));
  } catch (err) {
    console.warn("buildSwapTx initial attempt failed:", err?.message || err);

    // Fallback: on-chain pool discovery
    try {
      const found = await limit(() => findPoolsForPair(conn, inputMint, outputMint));
      if (!found || !found.pools || found.pools.length === 0) {
        console.error("No candidate pools found on-chain for pair.");
        return null;
      }
      let success = false;
      for (const p of found.pools) {
        console.log("Trying discovered pool:", p.poolPubkey, "dex:", p.dex);
        try {
          built = await limit(() => buildSwapTx(conn, wallet.publicKey, inputMint, outputMint, amountRaw, {
            slippageBps: dynamicSlippageBps,
            poolHint: p,
            mode: MODE
          }));
          if (built) {
            buildDex = p.dex || buildDex;
            success = true;
            console.log("buildSwapTx succeeded after on-chain probe");
            break;
          }
        } catch (e2) {
          console.warn("Retry build failed for pool", p.poolPubkey, e2?.message || e2);
        }
      }
      if (!success) {
        console.error("All build attempts failed — cannot build swap instructions.");
        return null;
      }
    } catch (disErr) {
      console.error("Pool discovery/auto-register error:", disErr?.message || disErr);
      return null;
    }
  }

  // Normalize built -> instructions
  let instructions = [];
  if (built instanceof Transaction) instructions = built.instructions || [];
  else if (built && Array.isArray(built.instructions)) instructions = built.instructions;
  else if (Array.isArray(built)) instructions = built;
  else if (built && built.instruction) instructions = [built.instruction];
  else if (built && Array.isArray(built.ix)) instructions = built.ix;
  else if (built && Array.isArray(built.i)) instructions = built.i;
  else if (built && built.programId && built.keys && built.data) instructions = [built];

  if (!instructions || instructions.length === 0) {
    console.error("No instructions returned from buildSwapTx.");
    return null;
  }

  // SAFE mode simulation
  if (MODE === "SAFE") {
    try {
      const txSim = new Transaction().add(...instructions);
      txSim.feePayer = wallet.publicKey;
      const latest = await limit(() => conn.getLatestBlockhash("finalized"));
      txSim.recentBlockhash = latest.blockhash;
      const sim = await limit(() => dryRun(conn, txSim));
      console.log("DRY RUN RESULT:", sim?.value || sim);
      if (sim && sim.value && sim.value.err) {
        console.error("Simulation indicates error; aborting swap.");
        return null;
      }
    } catch (e) {
      console.warn("Simulation failed / skipped:", e?.message || e);
    }
  }

  // SIGN & SEND
  let signature = null;
  try {
    const latest = await limit(() => conn.getLatestBlockhash("finalized"));
    let tx = new Transaction().add(...instructions);
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = wallet.publicKey;

    const vtx = new VersionedTransaction(tx.compileMessage());
    vtx.sign([wallet]);
    const serialized = vtx.serialize();

    signature = await retry(
      () => limit(() => conn.sendRawTransaction(serialized, { skipPreflight: MODE === "FAST" ? false : true })),
      SEND_TX_RETRY,
      1200
    );

    try { await limit(() => conn.confirmTransaction(signature, "confirmed")); }
    catch (e) { console.warn("ConfirmTransaction warning:", e?.message || e); }

    console.log("✅ SWAP SENT:", signature);
  } catch (err) {
    console.error("SIGN/SEND ERROR:", err?.message || err);
    return null;
  }

  // Fetch executed price (best-effort)
  let entryBuyPriceSOL = null;
  try {
    const priceInfo = await limit(() => scanMintFast(conn, outputMint, { dataSliceLen: 220, retries: 1 }));
    entryBuyPriceSOL = priceInfo?.priceInSOL ?? priceInfo?.price ?? null;
  } catch { entryBuyPriceSOL = null; }

  // SAVE POSITION
  try {
    const entry = {
      buyLabel: `Buy ${active.length + 1}`,
      mintAddress: outputMint,
      symbol: outputMint.substring(0, 6),
      buyPriceSOL: entryBuyPriceSOL,
      amount: currentTradeAmount,
      txSignature: signature,
      walletAddress: userPubkey,
      timestamp: new Date().toISOString(),
      dex: buildDex,
      slippageBps: dynamicSlippageBps
    };

    active.push(entry);
    atomicWrite(ACTIVE_POSITIONS_FILE, active);

    await sendTelegram(
      `🚀 *BUY EXECUTED*\nMint: ${outputMint}\nAmount: ${currentTradeAmount} SOL\nSig: https://solscan.io/tx/${signature}`
    );
  } catch (err) {
    console.error("Save/notify error:", err?.message || err);
  }

  return signature;
}