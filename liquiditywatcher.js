// liquiditywatcher.js (PQueue Birdeye integrated)
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
const RPC_URL = process.env.RPC_URL;
const POTENTIAL_FILE = "./potential_migrators.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const conn = new Connection(RPC_URL);

const CHAINSTACK_WSS = [
  process.env.CHAINSTACK_WSS_1,
  process.env.CHAINSTACK_WSS_2,
  process.env.CHAINSTACK_WSS_3
].filter(Boolean);

const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const ORCA = "9WwRZjZJY9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5";
const METEORA = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const DEX_PROGRAMS = new Set([RAYDIUM, ORCA, METEORA]);

const WSOL = "So11111111111111111111111111111111111111112"; // LP detection
const SOL = "SOL"; // swap input

const STABLES = new Set([
  "Es9vMFrzaCERv7Y1JPazrRtgdK9JGfRgzR1nEomz4Yh",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8nQbnb3gT1k2KD7",
  "DAiS39Ky47dFgfBhdREu7r48uYBBd6ihsQ8qHY7iSgj",
]);

const LIQUIDITY_BASE_USD = Number(process.env.LIQUIDITY_BASE_USD || 15000);
const VOL_SAMPLE_SHORT_MS = Number(process.env.VOL_SAMPLE_SHORT_MS || 60_000);
const VOL_SAMPLE_LONG_MS = Number(process.env.VOL_SAMPLE_LONG_MS || 180_000);
const VOL_CACHE_TTL_MS = Number(process.env.VOL_CACHE_TTL_MS || 15 * 60_000);
const MOMENTUM_MAX_WAIT_MS = Number(process.env.MOMENTUM_MAX_WAIT_MS || 5 * 60_000);
const MOMENTUM_MIN_PCT = Number(process.env.MOMENTUM_MIN_PCT || 10);
const POTENTIAL_FRESHNESS_MS = 30_000;

// -----------------------------------------------
// PQueue for RPC and Birdeye
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 20 });
const birdeyeQueue = new PQueue({ interval: 1000, intervalCap: 1 });

async function fetchBirdeye(url) {
  return birdeyeQueue.add(async () => {
    const res = await fetch(url, { headers: { "x-chain": "solana" } });
    return res.json();
  });
}

// -----------------------------------------------
// Adaptive per-DEX cooldown
const DEX_COOLDOWN_BASE_MS = 3000;
const DEX_COOLDOWN_MAX_MS = 15000;
const DEX_EVENT_WINDOW_MS = 60000;
const dexActivityMap = {};
function getDexCooldown(dex) {
  const now = Date.now();
  if (!dexActivityMap[dex]) dexActivityMap[dex] = [];
  dexActivityMap[dex] = dexActivityMap[dex].filter(ts => now - ts < DEX_EVENT_WINDOW_MS);
  const activityCount = dexActivityMap[dex].length;
  return Math.min(
    DEX_COOLDOWN_BASE_MS + (activityCount / 10) * (DEX_COOLDOWN_MAX_MS - DEX_COOLDOWN_BASE_MS),
    DEX_COOLDOWN_MAX_MS
  );
}
function recordDexEvent(dex) {
  const now = Date.now();
  if (!dexActivityMap[dex]) dexActivityMap[dex] = [];
  dexActivityMap[dex].push(now);
}

// -----------------------------------------------
// STATE
let recentlyTriggered = new Map();
let isBuying = false;
let migrators = new Set();
const volCache = {};
let cachedSolPrice = null;
let lastSolPriceFetch = 0;

// WebSocket state
let paused = false;
let wsInstances = [];

// -----------------------------------------------
// HELPERS
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
async function retry(fn, attempts = 3, backoffMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fn(); if (r) return r; } catch {}
    await delay(backoffMs);
  }
  return null;
}

// -----------------------------------------------
// Migrators file management
function loadMigrators() {
  try {
    if (!fs.existsSync(POTENTIAL_FILE)) fs.writeFileSync(POTENTIAL_FILE, "[]");
    const fileData = fs.readFileSync(POTENTIAL_FILE, "utf8").trim();
    const list = fileData ? JSON.parse(fileData) : [];
    migrators = new Set(list.map(x => x.mintAddress));
  } catch { migrators = new Set(); }
}
function saveMigrator(mintAddress) {
  try {
    const now = Date.now();
    const list = fs.existsSync(POTENTIAL_FILE) ? JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8")) : [];
    list.push({ mintAddress, detectedAt: now });
    fs.writeFileSync(POTENTIAL_FILE, JSON.stringify(list, null, 2));
    migrators.add(mintAddress);
    return now;
  } catch { return null; }
}
function removeMigrator(mintAddress) {
  try {
    const list = fs.existsSync(POTENTIAL_FILE) ? JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8")) : [];
    fs.writeFileSync(POTENTIAL_FILE, JSON.stringify(list.filter(m => m.mintAddress !== mintAddress), null, 2));
    migrators.delete(mintAddress);
  } catch {}
}

// -----------------------------------------------
// Telegram
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
    });
  } catch {}
}

// -----------------------------------------------
// Price fetchers
async function fetchSolPriceUSD() {
  const now = Date.now();
  if (cachedSolPrice && (now - lastSolPriceFetch) < 60_000) return cachedSolPrice;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await res.json();
    cachedSolPrice = j?.solana?.usd ?? null;
    lastSolPriceFetch = now;
    return cachedSolPrice;
  } catch { return null; }
}
async function fetchTokenPriceUSD(mint) {
  const cached = volCache[mint];
  if (cached && (Date.now() - cached.ts) < VOL_SAMPLE_SHORT_MS) return cached.lastPrice || null;

  try {
    const j = await fetchBirdeye(`https://public-api.birdeye.so/public/price?address=${mint}`);
    const val = j?.data?.value ?? null;
    if (!volCache[mint]) volCache[mint] = {};
    volCache[mint].lastPrice = val;
    return val;
  } catch { return null; }
}

// -----------------------------------------------
// Volatility & dynamic liquidity
async function computeTokenVolatility(mint) {
  const cached = volCache[mint];
  if (cached && (Date.now() - cached.ts) < VOL_CACHE_TTL_MS) return cached.vol || 0;
  const p0 = await fetchTokenPriceUSD(mint);
  if (!p0) { volCache[mint] = { vol: 0, ts: Date.now() }; return 0; }
  await delay(VOL_SAMPLE_SHORT_MS);
  const p1 = await fetchTokenPriceUSD(mint);
  await delay(Math.max(0, VOL_SAMPLE_LONG_MS - VOL_SAMPLE_SHORT_MS));
  const p2 = await fetchTokenPriceUSD(mint);
  const v1 = Math.abs((p1 - p0)/p0)*100;
  const v2 = Math.abs((p2 - p1)/p1)*100;
  const volatility = Math.max(v1, v2);
  volCache[mint] = { vol: volatility, ts: Date.now() };
  return volatility;
}
function computeDynamicLiquidityMin(volatilityPct) {
  const base = LIQUIDITY_BASE_USD;
  if (!volatilityPct || volatilityPct < 3) return base;
  if (volatilityPct < 10) return Math.round(base * 1.2);
  if (volatilityPct < 20) return Math.round(base * 1.35);
  return Math.round(base * 2);
}

// -----------------------------------------------
// SOL-based liquidity detector
function detectSolLiquidityFromTx(tx, solPriceUSD) {
  const logs = tx.meta?.logMessages || [];
  const post = tx.meta?.postTokenBalances || [];
  if (post.length < 2) return false;
  const mints = Array.from(new Set(post.map(b => b.mint)));
  if (!mints.includes(WSOL) || mints.length !== 2) return false; // LP detection uses WSOL
  const nonSolMint = mints.find(m => m !== WSOL);
  if (STABLES.has(nonSolMint)) return false;

  const solUi = Number(post.find(b => b.mint === WSOL)?.uiTokenAmount?.ui || 0);
  const poolValueUSD = solUi * (solPriceUSD || 0);

  const joined = logs.join(" ").toLowerCase();
  const raydiumHit = joined.includes("initialize") || joined.includes("amm") || joined.includes("pool") || joined.includes("mintto");
  const orcaHit = joined.includes("swap") || joined.includes("create") || joined.includes("liquidity");
  const meteoraHit = joined.includes("dlmm") || joined.includes("rebalance") || joined.includes("add_liquidity");
  if (!(raydiumHit || orcaHit || meteoraHit)) return false;

  return { mint: nonSolMint, dex: raydiumHit ? "Raydium" : orcaHit ? "Orca" : "Meteora", liquiditySOL: solUi, poolValueUSD };
}

// -----------------------------------------------
// PROCESS TRANSACTION
async function processTransaction(signature) {
  if (paused) return;
  const solPrice = await fetchSolPriceUSD();
  if (!solPrice) return;
  const tx = await conn.getTransaction(signature, { commitment: "confirmed" });
  if (!tx) return;

  const liquidityData = detectSolLiquidityFromTx(tx, solPrice);
  if (!liquidityData) return;

  const { mint, dex, poolValueUSD } = liquidityData;
  if (!mint || migrators.has(mint)) return;

  const cooldown = getDexCooldown(dex);
  if (recentlyTriggered.has(mint) && Date.now() - recentlyTriggered.get(mint) < cooldown) return;

  const volatility = await computeTokenVolatility(mint);
  const dynamicMinUSD = computeDynamicLiquidityMin(volatility);
  if (!poolValueUSD || poolValueUSD < dynamicMinUSD) return;

  saveMigrator(mint);
  recentlyTriggered.set(mint, Date.now());
  recordDexEvent(dex);

  await handleAutoBuy(mint);
}

// -----------------------------------------------
// HANDLE AUTO BUY
async function handleAutoBuy(mintAddress) {
  if (isBuying) return;

  const rec = fs.existsSync(POTENTIAL_FILE) ? JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8")).find(r => r.mintAddress === mintAddress) : null;
  if (!rec || Date.now() - rec.detectedAt > POTENTIAL_FRESHNESS_MS) { removeMigrator(mintAddress); return; }

  isBuying = true;
  await sendTelegram(`<b>Potential SOL Migrator Detected</b>\n<code>${mintAddress}</code>`);

  // Birdeye token & creator safety
  let safeToken = false;
  for (let i = 0; i < 3; i++) {
    try {
      const ts = await birdeyeQueue.add(() => verifyTokenSecurity(mintAddress));
      if (ts?.safe) { safeToken = true; break; }
    } catch {}
    await delay(4000);
  }

  let safeCreator = false;
  for (let i = 0; i < 3; i++) {
    try { const cs = await verifyCreatorSafety(mintAddress); if (cs?.safe) { safeCreator = true; break; } } catch {}
    await delay(4000);
  }

  if (!safeToken || !safeCreator) { isBuying = false; return; }

  const price0 = await retry(() => fetchTokenPriceUSD(mintAddress), 3);
  if (!price0) { isBuying = false; return; }

  let priceNow = price0;
  const start = Date.now();
  while (((priceNow - price0)/price0*100) < MOMENTUM_MIN_PCT && Date.now() - start < MOMENTUM_MAX_WAIT_MS) {
    await delay(10000);
    const tmp = await fetchTokenPriceUSD(mintAddress);
    if (tmp && tmp > 0) priceNow = tmp;
  }
  if (((priceNow - price0)/price0*100) < MOMENTUM_MIN_PCT) { isBuying = false; return; }

  try {
    await StartWatcher();
    await executeSwap(SOL, mintAddress); // USE SOL as trade input
    await StopWatcher();
    removeMigrator(mintAddress);
    await sendTelegram(`✅ BOUGHT\n<code>${mintAddress}</code>\nPrice move: ${((priceNow-price0)/price0*100).toFixed(2)}%`);
  } catch(err) {
    await sendTelegram(`❌ Buy failed for ${mintAddress}: ${err.message}`);
  } finally { isBuying = false; }
}

// -----------------------------------------------
// Multi-WS setup
function createWS(url) {
  let reconnectDelay = 1000;
  const MAX_RECONNECT = 30000;

  function connect() {
    if (paused) return;
    const ws = new WebSocket(url);
    wsInstances.push(ws);

    ws.on("open", () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: Array.from(DEX_PROGRAMS) }, { commitment: "confirmed" }]
      }));
    });

    ws.on("message", msg => {
      if (paused) return;
      let parsed;
      try { parsed = JSON.parse(msg); } catch { return; }
      const sig = parsed?.params?.result?.value?.signature;
      if (sig) rpcQueue.add(() => processTransaction(sig));
    });

    ws.on("close", () => {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
    });

    ws.on("error", err => { try { ws.close(); } catch {} });
  }

  connect();
}

// ----------------------
// WebSocket pause/resume
// ----------------------
function pauseWS() {
  paused = true;
  wsInstances.forEach(ws => { try { ws.close(); } catch {} });
  wsInstances = [];
  console.log("WebSockets paused due to StopWatcher signal.");
}

function resumeWS() {
  paused = false;
  console.log("WebSockets resuming due to StartWatcher signal.");
  CHAINSTACK_WSS.forEach(url => createWS(url));
}

// ----------------------
// Hook into swapexecutor signals
// ----------------------
StopWatcher(pauseWS);
StartWatcher(resumeWS);

// -----------------------------------------------
// STARTUP
loadMigrators();
fs.watchFile(POTENTIAL_FILE, loadMigrators);
CHAINSTACK_WSS.forEach(url => createWS(url));
console.log("Liquidity watcher started with pause/resume WS logic (Birdeye queue integrated).");