// liquiditywatcher.js
// Upgraded: SOL-only liquidity watcher with dynamic liquidity threshold (min $15k),
// volatility-based adjustment, security + creator checks, 30s freshness window,
// multi-WS Chainstack, and momentum-based buy (10% within 5 min).
//
// Drop-in replacement for your watcher. Keep backups of originals.

import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import WebSocket from "ws";
import { Connection } from "@solana/web3.js";
import PQueue from "p-queue";

import { verifyTokenSecurity } from "./tokensecurities.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";
import { executeSwap, StartWatcher, StopWatcher } from "./swapexecutor.js";

dotenv.config();

// -----------------------------------------------
// CONFIG
// -----------------------------------------------
const RPC_URL = process.env.RPC_URL;
const POTENTIAL_FILE = "./potential_migrators.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!RPC_URL) {
  console.error("❌ RPC_URL not set in .env - liquiditywatcher will not run.");
}

const conn = new Connection(RPC_URL);

// Chainstack WS endpoints (3 recommended)
const CHAINSTACK_WSS = [
  process.env.CHAINSTACK_WSS_1,
  process.env.CHAINSTACK_WSS_2,
  process.env.CHAINSTACK_WSS_3
].filter(Boolean);

// DEX Program IDs to watch
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const ORCA = "9WwRZjZJY9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5";
const METEORA = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const DEX_PROGRAMS = new Set([RAYDIUM, ORCA, METEORA]);

// SOL/WSOL & stablecoins
const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "Es9vMFrzaCERv7Y1JPazrRtgdK9JGfRgzR1nEomz4Yh", // USDT
  "EPjFWdd5AufqSSqeM2qN1xzybapC8nQbnb3gT1k2KD7", // USDC
  "DAiS39Ky47dFgfBhdREu7r48uYBBd6ihsQ8qHY7iSgj", // DAI (sol)
]);

// Liquidity baseline (USD)
const LIQUIDITY_BASE_USD = Number(process.env.LIQUIDITY_BASE_USD || 15000); // 15k default
// Volatility sampling config
const VOL_SAMPLE_SHORT_MS = Number(process.env.VOL_SAMPLE_SHORT_MS || 60_000); // 60s
const VOL_SAMPLE_LONG_MS = Number(process.env.VOL_SAMPLE_LONG_MS || 180_000); // 3 min (after first)
const VOL_CACHE_TTL_MS = Number(process.env.VOL_CACHE_TTL_MS || 15 * 60_000); // 15 minutes cache
// Momentum follow window (max wait for 10% increase)
const MOMENTUM_MAX_WAIT_MS = Number(process.env.MOMENTUM_MAX_WAIT_MS || 5 * 60_000); // 5 minutes
const MOMENTUM_MIN_PCT = Number(process.env.MOMENTUM_MIN_PCT || 10); // 10%

// Misc
const POTENTIAL_FRESHNESS_MS = 30_000; // 30s freshness requirement after detection
const RECENT_COOLDOWN_MS = 180_000; // 3 minutes cooldown per mint to avoid re-processing

// RPC queue (avoid >25 rps; we use 20)
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 20 });

// -----------------------------------------------
// STATE
// -----------------------------------------------
let recentlyTriggered = new Map();
let isBuying = false;
let migrators = new Set();

// Volatility cache: { [mint]: { vol: number, ts: number } }
const volCache = {};

// -----------------------------------------------
// JSON helpers
// -----------------------------------------------
function loadMigrators() {
  try {
    if (!fs.existsSync(POTENTIAL_FILE)) {
      fs.writeFileSync(POTENTIAL_FILE, "[]");
    }
    const fileData = fs.readFileSync(POTENTIAL_FILE, "utf8").trim();
    if (!fileData) {
      migrators = new Set();
      return;
    }
    const list = JSON.parse(fileData);
    migrators = new Set(list.map(x => x.mintAddress));
    console.log(`📂 Loaded ${migrators.size} migrators`);
  } catch (err) {
    console.warn("⚠️ loadMigrators failed, resetting migrators:", err.message);
    migrators = new Set();
  }
}

function saveMigrator(mintAddress) {
  try {
    const now = Date.now();
    const list = fs.existsSync(POTENTIAL_FILE)
      ? JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8"))
      : [];
    list.push({ mintAddress, detectedAt: now });
    fs.writeFileSync(POTENTIAL_FILE, JSON.stringify(list, null, 2));
    migrators.add(mintAddress);
    return now;
  } catch (err) {
    console.error("⚠️ Failed to write migrator:", err.message);
    return null;
  }
}

function removeMigrator(mintAddress) {
  try {
    const list = fs.existsSync(POTENTIAL_FILE)
      ? JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8"))
      : [];
    const updated = list.filter(m => m.mintAddress !== mintAddress);
    fs.writeFileSync(POTENTIAL_FILE, JSON.stringify(updated, null, 2));
    migrators.delete(mintAddress);
  } catch (err) {
    console.warn("⚠️ removeMigrator failed:", err?.message || err);
  }
}

// -----------------------------------------------
// Telegram helper
// -----------------------------------------------
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.warn("⚠️ Telegram send error:", err.message);
  }
}

// -----------------------------------------------
// Price helpers (Birdeye token price)
async function fetchTokenPriceUSD(mint) {
  try {
    const r = await fetch(`https://public-api.birdeye.so/public/price?address=${mint}`, {
      headers: { "x-chain": "solana" }
    });
    const json = await r.json();
    return json?.data?.value ?? null;
  } catch (err) {
    return null;
  }
}

async function fetchSolPriceUSD() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await res.json();
    return j?.solana?.usd ?? null;
  } catch {
    return null;
  }
}

// -----------------------------------------------
// Volatility measurement & dynamic threshold
// -----------------------------------------------
async function computeTokenVolatility(mint) {
  try {
    // use cache if recent
    const cached = volCache[mint];
    if (cached && (Date.now() - cached.ts) < VOL_CACHE_TTL_MS) {
      return cached.vol;
    }

    const p0 = await fetchTokenPriceUSD(mint);
    if (!p0 || p0 <= 0) {
      volCache[mint] = { vol: 0, ts: Date.now() };
      return 0;
    }

    await delay(VOL_SAMPLE_SHORT_MS);
    const p1 = await fetchTokenPriceUSD(mint);
    await delay(Math.max(0, VOL_SAMPLE_LONG_MS - VOL_SAMPLE_SHORT_MS));
    const p2 = await fetchTokenPriceUSD(mint);

    const safeP1 = p1 || p0;
    const safeP2 = p2 || safeP1;

    const v1 = Math.abs((safeP1 - p0) / p0) * 100;
    const v2 = safeP1 > 0 ? Math.abs((safeP2 - safeP1) / safeP1) * 100 : 0;
    const volatility = Math.max(v1, v2);

    volCache[mint] = { vol: volatility, ts: Date.now() };
    console.log(`[volatility] ${mint} => ${volatility.toFixed(2)}%`);
    return volatility;
  } catch (err) {
    console.warn("⚠️ computeTokenVolatility error:", err.message || err);
    volCache[mint] = { vol: 0, ts: Date.now() };
    return 0;
  }
}

function computeDynamicLiquidityMin(volatilityPct) {
  const base = LIQUIDITY_BASE_USD;
  if (!volatilityPct || volatilityPct < 3) return base;
  if (volatilityPct < 10) return Math.round(base * 1.2);
  if (volatilityPct < 20) return Math.round(base * 1.35);
  return Math.round(base * 2);
}

// -----------------------------------------------
// Strong SOL-based liquidity detector
function detectSolLiquidityFromTx(tx, solPriceUSD) {
  try {
    const logs = tx.meta?.logMessages || [];
    const post = tx.meta?.postTokenBalances || [];
    if (post.length < 2) return false;

    const mints = Array.from(new Set(post.map(b => b.mint)));
    if (mints.length !== 2 || !mints.includes(WSOL)) return false;

    const nonSolMint = mints.find(m => m !== WSOL);
    if (!nonSolMint) return false;
    if (STABLES.has(nonSolMint)) return false;

    const solEntry = post.find(b => b.mint === WSOL);
    const solUi = Number(solEntry?.uiTokenAmount?.ui || 0);
    const poolValueUSD = solUi * (solPriceUSD || 0);

    const joined = logs.join(" ").toLowerCase();
    const raydiumHit = joined.includes("initialize") || joined.includes("amm") || joined.includes("pool") || joined.includes("mintto");
    const orcaHit = joined.includes("swap") || joined.includes("create") || joined.includes("liquidity");
    const meteoraHit = joined.includes("dlmm") || joined.includes("rebalance") || joined.includes("add_liquidity");

    if (!(raydiumHit || orcaHit || meteoraHit)) return false;

    return {
      mint: nonSolMint,
      dex: raydiumHit ? "Raydium" : orcaHit ? "Orca" : "Meteora",
      liquiditySOL: solUi,
      poolValueUSD
    };
  } catch (err) {
    console.warn("⚠️ detectSolLiquidityFromTx error:", err.message || err);
    return false;
  }
}

// -----------------------------------------------
// PROCESS TRANSACTION
async function processTransaction(signature, wsIndex) {
  try {
    const solPrice = await fetchSolPriceUSD();
    if (!solPrice) {
      console.warn("⚠️ Couldn't fetch SOL price, skipping tx");
      return;
    }

    const tx = await conn.getTransaction(signature, { commitment: "confirmed" });
    if (!tx) return;

    const liquidityData = detectSolLiquidityFromTx(tx, solPrice);
    if (!liquidityData) return;

    const mint = liquidityData.mint;
    if (!mint) return;
    if (migrators.has(mint)) return;

    const volatility = await computeTokenVolatility(mint);
    const dynamicMinUSD = computeDynamicLiquidityMin(volatility);

    console.log(`[liquidity] ${mint} poolValue=$${(liquidityData.poolValueUSD||0).toFixed(2)} required=$${dynamicMinUSD}`);

    if (!liquidityData.poolValueUSD || liquidityData.poolValueUSD < dynamicMinUSD) {
      console.log(`[liquidity] ${mint} rejected — pool <$${dynamicMinUSD}`);
      return;
    }

    const detectedAt = saveMigrator(mint);
    if (!detectedAt) return;

    recentlyTriggered.set(mint, Date.now());

    await handleAutoBuy(mint, liquidityData, volatility);
  } catch (err) {
    console.error(`❌ WS[${wsIndex}] RPC error:`, err.message || err);
  }
}

// -----------------------------------------------
// HANDLE AUTO BUY LOGIC
async function handleAutoBuy(mintAddress, liquidityData = null, volatility = null) {
  if (isBuying) {
    console.log(`[buy] skipping ${mintAddress} because another buy is in progress`);
    return;
  }

  const fileList = fs.existsSync(POTENTIAL_FILE) ? JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8")) : [];
  const rec = fileList.find(r => r.mintAddress === mintAddress);
  if (!rec) {
    console.log(`[buy] ${mintAddress} not found in potential file (race)`);
    return;
  }
  if (Date.now() - (rec.detectedAt || 0) > POTENTIAL_FRESHNESS_MS) {
    console.log(`[buy] ${mintAddress} too old (>${POTENTIAL_FRESHNESS_MS}ms), ignoring`);
    removeMigrator(mintAddress);
    return;
  }

  isBuying = true;
  await sendTelegram(`🔍 <b>Potential SOL Migrator Detected</b>\n<code>${mintAddress}</code>`);

  let safeToken = false;
  let safeCreator = false;

  for (let i = 0; i < 3; i++) {
    try {
      const tokenSec = await verifyTokenSecurity(mintAddress);
      if (tokenSec && tokenSec.safe) { safeToken = true; break; }
    } catch (err) {
      console.warn("⚠️ verifyTokenSecurity error:", err.message || err);
    }
    await delay(4000);
  }

  for (let i = 0; i < 3; i++) {
    try {
      const creatorSec = await verifyCreatorSafety(mintAddress);
      if (creatorSec && creatorSec.safe) { safeCreator = true; break; }
    } catch (err) {
      console.warn("⚠️ verifyCreatorSafety error:", err.message || err);
    }
    await delay(4000);
  }

  if (!safeToken || !safeCreator) {
    console.log(`[buy] ${mintAddress} failed security checks (token:${safeToken} creator:${safeCreator})`);
    isBuying = false;
    return;
  }

  const price0 = await retry(() => fetchTokenPriceUSD(mintAddress), 3);
  if (!price0) {
    console.log(`[buy] ${mintAddress} failed to fetch initial price`);
    isBuying = false;
    return;
  }

  let priceNow = price0;
  const start = Date.now();
  while (((priceNow - price0) / price0) * 100 < MOMENTUM_MIN_PCT &&
         Date.now() - start < MOMENTUM_MAX_WAIT_MS) {
    await delay(5000);
    const tmp = await fetchTokenPriceUSD(mintAddress);
    if (tmp && tmp > 0) priceNow = tmp;
  }

  const pct = ((priceNow - price0) / price0) * 100;
  if (pct < MOMENTUM_MIN_PCT) {
    console.log(`[buy] ${mintAddress} momentum failure: only ${pct.toFixed(2)}% in ${Math.round((Date.now()-start)/1000)}s`);
    isBuying = false;
    return;
  }

  try {
    await StartWatcher();
    await executeSwap("So11111111111111111111111111111111111111112", mintAddress);
    await StopWatcher();

    removeMigrator(mintAddress);
    await sendTelegram(`✅ BOUGHT\n<code>${mintAddress}</code>\nPrice move: ${pct.toFixed(2)}%`);
  } catch (err) {
    console.error("❌ executeSwap error:", err.message || err);
    await sendTelegram(`❌ Buy failed for ${mintAddress}: ${err.message}`);
  } finally {
    isBuying = false;
  }
}

// -----------------------------------------------
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function retry(fn, attempts = 3, backoffMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (err) { /* ignore */ }
    await delay(backoffMs);
  }
  return null;
}

// -----------------------------------------------
// Multi-WS setup (Chainstack)
function startChainstackWS() {
  if (!CHAINSTACK_WSS || !CHAINSTACK_WSS.length) {
    console.warn("⚠️ No CHAINSTACK_WSS endpoints configured. Exiting watcher.");
    return;
  }

  CHAINSTACK_WSS.forEach((url, index) => {
    let reconnectDelay = 1000;
    const MAX_RECONNECT = 30000;

    function connect() {
      const ws = new WebSocket(url);

      ws.on("open", () => {
        console.log(`🟢 WS[${index}] connected to ${url}`);
        reconnectDelay = 1000;

        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: Array.from(DEX_PROGRAMS) }, { commitment: "confirmed" }]
        }));
      });

      ws.on("message", (msg) => {
        let parsed;
        try { parsed = JSON.parse(msg); } catch (e) { return; }
        const result = parsed.params?.result?.value;
        if (!result) return;
        const signature = result.signature;
        rpcQueue.add(async () => processTransaction(signature, index));
      });

      ws.on("close", () => {
        console.warn(`⚠️ WS[${index}] closed. Reconnecting in ${reconnectDelay/1000}s...`);
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
      });

      ws.on("error", (err) => {
        console.error(`❌ WS[${index}] error:`, err.message || err);
        try { ws.close(); } catch {}
      });
    }

    connect();
  });
}

// -----------------------------------------------
// STARTUP
loadMigrators();
fs.watchFile(POTENTIAL_FILE, loadMigrators);
startChainstackWS();

console.log("🔍 Liquidity watcher started (SOL-only, min $15k baseline, dynamic threshold, momentum & security checks)");