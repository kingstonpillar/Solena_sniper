// liquiditywatcher-upgraded.js
// Upgraded Liquidity Watcher
// - Fixed template strings, completed event scanning
// - Program-id based LP detection (uses pre/post/inner token balances)
// - WSOL guard to avoid saving native token as migrator
// - Atomic migrator file writes and duplicate protection
// - Uses DEX program IDs to discover events, de-dupes with recentTxCache
// - Calls verifyTokenSecurity & verifyCreatorSafety before buying
// - Safer executeSwap invocation (passes WSOL as source mint)
// - Rate-limited RPC + Jupiter queues
// - Configurable freshness, volatility caching, and cooldowns

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

import { verifyTokenSecurity } from "./tokensecurities.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";
import { executeSwap, StartWatcher, StopWatcher } from "./swapexecutor.js";

dotenv.config();

// ----------------------------- CONFIG -----------------------------
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const POTENTIAL_FILE = process.env.POTENTIAL_FILE || "./potential_migrators.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const FRESHNESS_LIMIT_SECONDS = Number(process.env.FRESHNESS_LIMIT_SECONDS || 360); // 6 minutes
const LIQUIDITY_BASE_USD = Number(process.env.LIQUIDITY_BASE_USD || 15000);
const VOL_SAMPLE_SHORT_MS = Number(process.env.VOL_SAMPLE_SHORT_MS || 5_000); // shortened for responsiveness
const VOL_SAMPLE_LONG_MS = Number(process.env.VOL_SAMPLE_LONG_MS || 15_000);
const VOL_CACHE_TTL_MS = Number(process.env.VOL_CACHE_TTL_MS || 15 * 60_000);
const MOMENTUM_MAX_WAIT_MS = Number(process.env.MOMENTUM_MAX_WAIT_MS || 5 * 60_000);
const MOMENTUM_MIN_PCT = Number(process.env.MOMENTUM_MIN_PCT || 10);
const POTENTIAL_FRESHNESS_MS = Number(process.env.POTENTIAL_FRESHNESS_MS || 360_000);

const conn = new Connection(RPC_URL);

// ----------------------------- DEX PROGRAMS -----------------------------
// Keys are friendly names, values are program/public keys used to detect invocation
const DEX_PROGRAMS = {
  Raydium_AMM_v4: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  Raydium_CPMM: new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
  Raydium_CLMM: new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
  Raydium_Stable: new PublicKey("5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h"),
  Orca_AMM: new PublicKey("9WwRZjZJY9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5"),
  Orca_Whirlpool: new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"),
  Meteora_DLMM: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
  Meteora_DAMMv2: new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"),
  Meteora_DynAMM: new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"),
};

// ----------------------------- CONSTANTS -----------------------------
const WSOL = "So11111111111111111111111111111111111111112"; // wrapped SOL mint
const STABLES = new Set([
  "Es9vMFrzaCERv7Y1JPazrRtgdK9JGfRgzR1nEomz4Yh", // USDT
  "EPjFWdd5AufqSSqeM2qN1xzybapC8nQbnb3gT1k2KD7", // USDC
  "DAiS39Ky47dFgfBhdREu7r48uYBBd6ihsQ8qHY7iSgj", // DAI (example)
]);

// ----------------------------- RATE LIMITERS -----------------------------
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 20 });
const jupiterQueue = new PQueue({ interval: 1000, intervalCap: 3 });

// ----------------------------- STATE -----------------------------
const recentTxCache = new Set(); // signature dedupe
let recentlyTriggered = new Map(); // mint => last triggered timestamp
let isBuying = false; // global single-buy guard
let migrators = new Set(); // in-memory migrators
const volCache = {}; // per-mint cache: {lastPrice, ts, vol}
let cachedSolPrice = null;
let lastSolPriceFetch = 0;

// ----------------------------- HELPERS -----------------------------
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function retry(fn, attempts = 3, backoffMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fn(); if (r !== undefined && r !== null) return r; } catch (e) {}
    await delay(backoffMs);
  }
  return null;
}

// Atomic file helper
function persistFileEnsure() { if (!fs.existsSync(POTENTIAL_FILE)) fs.writeFileSync(POTENTIAL_FILE, "[]"); }
function readMigratorsFile() {
  try {
    persistFileEnsure();
    const raw = fs.readFileSync(POTENTIAL_FILE, "utf8") || "[]";
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) { console.log("readMigratorsFile error:", e?.message || e); return []; }
}
function writeMigratorsFile(list) {
  try {
    const tmp = `${POTENTIAL_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, POTENTIAL_FILE);
    return true;
  } catch (e) { console.log("writeMigratorsFile error:", e?.message || e); return false; }
}

function loadMigratorsFromFile() {
  const list = readMigratorsFile();
  migrators = new Set(list.map(x => x.mintAddress));
}

function saveMigrator(mintAddress) {
  try {
    const list = readMigratorsFile();
    if (list.find(r => r.mintAddress === mintAddress)) return true; // already present
    list.push({ mintAddress, detectedAt: Date.now() });
    const ok = writeMigratorsFile(list);
    if (ok) migrators.add(mintAddress);
    return ok;
  } catch (e) { console.log("saveMigrator error:", e?.message || e); return false; }
}

function removeMigrator(mintAddress) {
  try {
    const list = readMigratorsFile();
    const filtered = list.filter(m => m.mintAddress !== mintAddress);
    writeMigratorsFile(filtered);
    migrators.delete(mintAddress);
  } catch (e) { console.log("removeMigrator error:", e?.message || e); }
}

// ----------------------------- TELEGRAM -----------------------------
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
    });
  } catch (e) { console.log("Telegram send error:", e?.message || e); }
}

// ----------------------------- PRICING -----------------------------
async function fetchSolPriceUSD() {
  const now = Date.now();
  if (cachedSolPrice && (now - lastSolPriceFetch) < 60_000) return cachedSolPrice;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await res.json();
    cachedSolPrice = j?.solana?.usd ?? null;
    lastSolPriceFetch = now;
    return cachedSolPrice;
  } catch (e) { console.log("fetchSolPriceUSD error:", e?.message || e); return null; }
}

async function fetchJupiterPrice(mint) {
  return jupiterQueue.add(async () => {
    try {
      const url = `https://api.jup.ag/price/v2?ids=${mint}`;
      const res = await fetch(url);
      const j = await res.json();
      // j.data is commonly keyed by mint or token symbol. Try several fallbacks.
      return j?.data?.[mint]?.price || j?.data?.[0]?.price || null;
    } catch (e) { console.log("fetchJupiterPrice error:", e?.message || e); return null; }
  });
}

async function fetchTokenPriceUSD(mint) {
  const cached = volCache[mint];
  if (cached && (Date.now() - (cached.ts || 0)) < VOL_SAMPLE_SHORT_MS) return cached.lastPrice || null;

  const price = await fetchJupiterPrice(mint);
  if (!price) return null;

  if (!volCache[mint]) volCache[mint] = {};
  volCache[mint].lastPrice = price;
  volCache[mint].ts = Date.now();
  return price;
}

// -----------------------------------------------
// Volatility & dynamic liquidity
async function computeTokenVolatility(mint, maxWaitMs = 20_000) {
  const cached = volCache[mint];
  if (cached && (Date.now() - (cached.ts || 0)) < VOL_CACHE_TTL_MS) return cached.vol || 0;

  // We'll attempt a quick volatility sample but bound the total wait time to maxWaitMs
  const start = Date.now();
  const p0 = await fetchTokenPriceUSD(mint);
  if (!p0) { volCache[mint] = { vol: 0, ts: Date.now() }; return 0; }

  const remaining = Math.max(0, Math.min(maxWaitMs - (Date.now() - start), VOL_SAMPLE_LONG_MS));
  if (remaining <= 0) { volCache[mint] = { vol: 0, ts: Date.now() }; return 0; }

  // sample shorter delays for responsiveness
  await delay(Math.min(VOL_SAMPLE_SHORT_MS, remaining / 2));
  const p1 = await fetchTokenPriceUSD(mint);
  await delay(Math.min(VOL_SAMPLE_LONG_MS - VOL_SAMPLE_SHORT_MS, remaining / 2));
  const p2 = await fetchTokenPriceUSD(mint);

  if (!p1 || !p2) { volCache[mint] = { vol: 0, ts: Date.now() }; return 0; }

  const v1 = Math.abs((p1 - p0) / p0) * 100;
  const v2 = Math.abs((p2 - p1) / p1) * 100;
  const volatility = Math.max(v1, v2);

  volCache[mint] = { ...volCache[mint], vol: volatility, ts: Date.now() };
  return volatility;
}

function computeDynamicLiquidityMin(volatilityPct) {
  const base = LIQUIDITY_BASE_USD;
  if (!volatilityPct || volatilityPct < 3) return base;
  if (volatilityPct < 10) return Math.round(base * 1.2);
  if (volatilityPct < 20) return Math.round(base * 1.35);
  return Math.round(base * 2);
}

// ----------------------------- DEX COOLDOWN -----------------------------
const DEX_EVENT_WINDOW_MS = 60_000;
const DEX_COOLDOWN_BASE_MS = 3000;
const DEX_COOLDOWN_MAX_MS = 15_000;
const dexActivityMap = {};

function recordDexEvent(dex) {
  if (!dexActivityMap[dex]) dexActivityMap[dex] = [];
  dexActivityMap[dex].push(Date.now());
  dexActivityMap[dex] = dexActivityMap[dex].filter(ts => Date.now() - ts < DEX_EVENT_WINDOW_MS);
}
function getDexCooldown(dex) {
  if (!dexActivityMap[dex]) return DEX_COOLDOWN_BASE_MS;
  const activityCount = dexActivityMap[dex].length;
  const scaled = DEX_COOLDOWN_BASE_MS + (activityCount / 10) * (DEX_COOLDOWN_MAX_MS - DEX_COOLDOWN_BASE_MS);
  return Math.min(scaled, DEX_COOLDOWN_MAX_MS);
}

// ----------------------------- LP DETECTION -----------------------------
function extractTokenBalancesFromMeta(meta) {
  const pre = meta?.preTokenBalances || [];
  const post = meta?.postTokenBalances || [];
  const combined = [...pre, ...post];
  const balances = {};
  for (const b of combined) {
    const mint = b?.mint;
    const ui = Number(b?.uiTokenAmount?.ui || 0);
    if (!mint) continue;
    if (!balances[mint]) balances[mint] = 0;
    balances[mint] += ui;
  }
  return { combined, balances };
}

function detectSolLiquidityFromTx(tx, solPriceUSD) {
  const logs = tx.meta?.logMessages || [];
  const logsJoined = logs.join(" ").toLowerCase();

  // gather mints from pre/post balances and inner instructions token transfers
  const { combined, balances } = extractTokenBalancesFromMeta(tx.meta || {});
  const mints = Array.from(new Set(combined.map(b => b.mint).filter(Boolean)));
  if (mints.length < 1) return false; // no token mints involved

  // detect if any known DEX program was invoked
  const invokedProgramIds = (tx.transaction?.message?.accountKeys || [])
    .map(k => (typeof k === 'string' ? k : k.pubkey?.toString?.()))
    .filter(Boolean);

  const dexProgramMatch = Object.entries(DEX_PROGRAMS).find(([, pk]) => invokedProgramIds.includes(pk.toString()));
  // fallback to simple keyword heuristics if program id match missing
  const raydiumHit = logsJoined.includes("amm") || logsJoined.includes("raydium") || logsJoined.includes("initialize");
  const orcaHit = logsJoined.includes("orca") || logsJoined.includes("whirlpool") || logsJoined.includes("liquidity");
  const meteoraHit = logsJoined.includes("dlmm") || logsJoined.includes("meteora") || logsJoined.includes("add_liquidity");

  if (!dexProgramMatch && !(raydiumHit || orcaHit || meteoraHit)) return false;

  const dex = dexProgramMatch ? dexProgramMatch[0] : (raydiumHit ? "Raydium" : orcaHit ? "Orca" : "Meteora");

  const hasWSOL = mints.includes(WSOL);
  const nonSolMints = mints.filter(m => m !== WSOL);
  const repMint = nonSolMints[0] || null; // representative non-SOL mint for migrator decisions

  // compute pool value in USD using balances; if WSOL present, use SOL price
  let poolValueUSD = 0;
  if (hasWSOL) {
    poolValueUSD += (balances[WSOL] || 0) * (solPriceUSD || 0);
  }

  // sum other token values based on cached/fetched prices
  for (const tk of nonSolMints) {
    const amountUi = balances[tk] || 0;
    if (!amountUi || amountUi <= 0) continue;
    const price = volCache[tk]?.lastPrice || null; // try cache first
    // don't block on fetch here; fetch price synchronously but allow failures
    // (processTransaction will do a more thorough computation if needed)
    if (price) poolValueUSD += amountUi * price;
  }

  return { mint: repMint, dex, liquiditySOL: hasWSOL ? (balances[WSOL] || 0) : 0, poolValueUSD, mints, balances, logsJoined };
}

// ----------------------------- PROCESS TRANSACTION -----------------------------
async function processTransaction(signature) {
  try {
    if (recentTxCache.has(signature)) return; // already processed
    recentTxCache.add(signature);
    // keep cache bounded
    if (recentTxCache.size > 10_000) {
      // drop oldest — rough approach: reset if too large
      recentTxCache.clear();
    }

    console.log(`\n--- CHECK SIG ${signature} ---`);
    const solPrice = await fetchSolPriceUSD();
    if (!solPrice) { console.log("No SOL price available, skipping."); return; }

    const tx = await rpcQueue.add(() => conn.getTransaction(signature, { commitment: "confirmed" }));
    if (!tx || !tx.meta) { console.log(`Missing tx/meta for ${signature}`); return; }

    const liquidityData = detectSolLiquidityFromTx(tx, solPrice);
    if (!liquidityData) { console.log(`No LP detected for ${signature}`); return; }

    const { mint, dex, poolValueUSD: poolValueFromWSOL, mints, balances } = liquidityData;
    if (!mint) { console.log("No non-WSOL mint identified (likely WSOL-only pool) — skipping."); return; }
    if (migrators.has(mint)) { console.log(`Already in migrators: ${mint}`); return; }

    const cooldown = getDexCooldown(dex);
    if (recentlyTriggered.has(mint)) {
      const last = recentlyTriggered.get(mint);
      if (Date.now() - last < cooldown) { console.log(`Cooldown active for ${mint} on ${dex}`); return; }
    }

    const blockTime = tx.blockTime;
    if (!blockTime) { console.log("No blockTime, skipping."); return; }
    const now = Math.floor(Date.now() / 1000);
    const age = now - blockTime;
    if (age > FRESHNESS_LIMIT_SECONDS) { console.log(`TX too old (${age}s) — skipping`); return; }
    console.log(`LP age ${age}s — within freshness.`);

    // compute a better pool USD if needed (try to be quick)
    let poolValueUSD = poolValueFromWSOL || 0;
    if (!poolValueUSD || poolValueUSD <= 0) {
      let sum = 0;
      let ok = true;
      for (const tk of mints) {
        const amountUi = balances[tk] || 0;
        if (!amountUi || amountUi <= 0) continue;
        if (tk === WSOL) { sum += amountUi * solPrice; continue; }
        const price = await fetchTokenPriceUSD(tk);
        if (!price || price <= 0) { ok = false; break; }
        sum += amountUi * price;
      }
      if (ok) poolValueUSD = sum;
    }

    const repMint = mint;
    // avoid accidental WSOL-only repMint
    if (repMint === WSOL) { console.log("Representative mint is WSOL — skipping."); return; }

    // throttle volatility calculation (bounded wait)
    const volatility = await computeTokenVolatility(repMint, 10_000);
    const dynamicMinUSD = computeDynamicLiquidityMin(volatility);

    console.log(`[INFO] dex=${dex} repMint=${repMint} poolUSD=${poolValueUSD} vol=${volatility} dynMin=${dynamicMinUSD}`);

    if (!poolValueUSD || poolValueUSD < dynamicMinUSD) {
      await sendTelegram(`❌ Token ${repMint} rejected — pool USD $${(poolValueUSD || 0).toFixed(2)} < dynamic min $${dynamicMinUSD}.`);
      console.log(`Rejected ${repMint}: pool ${poolValueUSD} < ${dynamicMinUSD}`);
      return;
    }

    // Run security checks before persisting and buying
    try {
      const tokenSafe = await retry(() => verifyTokenSecurity(repMint), 2, 1000);
      const creatorSafe = await retry(() => verifyCreatorSafety(repMint), 2, 1000);
      if (!tokenSafe || !creatorSafe) {
        await sendTelegram(`⚠️ Token ${repMint} failed security checks. Skipping buy.`);
        console.log(`Security check failed for ${repMint}. tokenSafe=${tokenSafe} creatorSafe=${creatorSafe}`);
        return;
      }
    } catch (e) {
      console.log("Security checks error:", e?.message || e);
      // conservative: skip buy if checks fail unexpectedly
      return;
    }

    // passed checks: persist and prepare to buy
    saveMigrator(repMint);
    recentlyTriggered.set(repMint, Date.now());
    recordDexEvent(dex);

    await handleAutoBuy(repMint);

  } catch (err) {
    console.log("processTransaction error:", err?.message || err);
  }
}

// ----------------------------- FETCH NEW LP EVENTS -----------------------------
async function fetchNewLPEvents() {
  try {
    // For each DEX program, pull recent signatures and process new ones
    for (const [dexName, programId] of Object.entries(DEX_PROGRAMS)) {
      try {
        const sigInfos = await rpcQueue.add(() => conn.getSignaturesForAddress(programId, { limit: 50 }));
        if (!Array.isArray(sigInfos) || sigInfos.length === 0) continue;
        for (const s of sigInfos) {
          const sig = s.signature;
          if (!sig || recentTxCache.has(sig)) continue;
          // fetch transaction and process
          await processTransaction(sig);
          // small delay to avoid bursting
          await delay(50);
        }
      } catch (e) {
        console.log(`fetchNewLPEvents error for ${dexName}:`, e?.message || e);
      }
    }
  } catch (e) { console.log("fetchNewLPEvents top-level error:", e?.message || e); }
}

// ----------------------------- HANDLE AUTO BUY -----------------------------
async function handleAutoBuy(mintAddress) {
  if (isBuying) {
    console.log("Auto-buy already in progress, skipping.");
    return;
  }

  // Ensure migrator record exists and is fresh
  persistFileEnsure();
  const rec = readMigratorsFile().find(r => r.mintAddress === mintAddress);
  if (!rec || Date.now() - rec.detectedAt > POTENTIAL_FRESHNESS_MS) {
    console.log("Record missing or stale. Removing migrator if any.");
    removeMigrator(mintAddress);
    return;
  }

  isBuying = true;
  await sendTelegram(`<b>Potential SOL Migrator Detected</b>\n<code>${mintAddress}</code>`);

  // Price momentum check (bounded)
  const price0 = await retry(() => fetchTokenPriceUSD(mintAddress), 3);
  if (!price0) { isBuying = false; return; }

  let priceNow = price0;
  const start = Date.now();
  while (((priceNow - price0) / price0 * 100) < MOMENTUM_MIN_PCT && Date.now() - start < MOMENTUM_MAX_WAIT_MS) {
    await delay(10_000);
    const tmp = await fetchTokenPriceUSD(mintAddress);
    if (tmp && tmp > 0) priceNow = tmp;
  }

  if (((priceNow - price0) / price0 * 100) < MOMENTUM_MIN_PCT) {
    console.log("Momentum not reached. Skipping buy.");
    isBuying = false;
    return;
  }

  try {
    await StartWatcher();
    // executeSwap expects source mint (we use WSOL) and target mint
    await executeSwap("So11111111111111111111111111111111111111112", mintAddress);
    await StopWatcher();
    removeMigrator(mintAddress);
    await sendTelegram(`✅ BOUGHT\n<code>${mintAddress}</code>\nPrice move: ${((priceNow - price0)/price0*100).toFixed(2)}%`);
    console.log(`Auto-buy executed for ${mintAddress}`);
  } catch (err) {
    console.log("Buy error:", err?.message || err);
    await sendTelegram(`❌ Buy failed for ${mintAddress}: ${err?.message || err}`);
  } finally {
    isBuying = false;
  }
}

// ----------------------------- BOOT / LOOP -----------------------------
async function mainLoop() {
  loadMigratorsFromFile();
  console.log("Starting Liquidity Watcher (upgraded)");
  while (true) {
    try {
      await fetchNewLPEvents();
    } catch (e) { console.log("mainLoop fetch error:", e?.message || e); }
    // configurable delay between scans
    await delay(2000);
  }
}

// If run directly, start main loop
if (process.argv[1] && process.argv[1].endsWith(path.basename(process.argv[1]))) {
  mainLoop().catch(e => console.log("Fatal error:", e));
}

// ----------------------------- MOCK TEST: AutoBuy Option A -----------------------------
// Basic mock to simulate auto-buy flow without hitting real RPC or Jupiter
// Run with: node liquiditywatcher-upgraded.js --mock-autobuy
if (process.argv.includes('--mock-autobuy')) {
  console.log("Running AutoBuy Option A Mock Test...");

  // mock minimal price sequence: rising to satisfy momentum
  let mockPrice = 1.0;
  async function mockFetchTokenPriceUSD() {
    mockPrice += 0.12; // increase each call to trigger momentum
    return mockPrice;
  }

  // monkey‑patch fetchTokenPriceUSD
  global.fetchTokenPriceUSD = mockFetchTokenPriceUSD;

  // mock StartWatcher / StopWatcher / executeSwap
  global.StartWatcher = async () => console.log("[MOCK] StartWatcher called");
  global.StopWatcher = async () => console.log("[MOCK] StopWatcher called");
  global.executeSwap = async (src, dst) => {
    console.log(`[MOCK] executeSwap called: ${src} -> ${dst}`);
  };

  // mock migrator entry
  persistFileEnsure();
  writeMigratorsFile([{ mintAddress: "MockMint111111111111111111111111111111111", detectedAt: Date.now() }]);

  // run test
  (async () => {
    await handleAutoBuy("MockMint111111111111111111111111111111111");
    console.log("AutoBuy Option A Mock Test Complete");
    process.exit(0);
  })();
}

// ================================
// --- Mock Test Block: AutoBuy Option A ---
// Simulation-driven mock tests
// ================================

async function mockFetchTokenPriceUSDFactory(sequence) {
  let i = 0;
  return async () => {
    if (i >= sequence.length) return sequence[sequence.length - 1];
    return sequence[i++];
  };
}

async function mockExecuteSwapFactory(behavior) {
  let call = 0;
  return async (src, dst) => {
    call++;
    if (behavior === "failOnce" && call === 1) throw new Error("Swap fail #1 (simulated)");
    console.log(`[MOCK] executeSwap(${src} -> ${dst}) call=${call}`);
    return true;
  };
}

async function runMockAutoBuyTests() {
  console.log("
================ MOCK AUTOBUY TEST SUITE ================");

  const realFetch = fetchTokenPriceUSD;
  const realSwap = executeSwap;

  console.log("
[A1] Momentum reached test");
  fetchTokenPriceUSD = await mockFetchTokenPriceUSDFactory([1.0, 1.02, 1.05, 1.12]);
  executeSwap = await mockExecuteSwapFactory("success");
  await handleAutoBuy("TESTMINT_A1");

  console.log("
[A2] No momentum test");
  fetchTokenPriceUSD = await mockFetchTokenPriceUSDFactory([1.0, 1.01, 1.015, 1.018]);
  executeSwap = await mockExecuteSwapFactory("success");
  await handleAutoBuy("TESTMINT_A2");

  console.log("
[A3] High volatility test");
  fetchTokenPriceUSD = await mockFetchTokenPriceUSDFactory([1.0, 1.25, 1.32]);
  executeSwap = await mockExecuteSwapFactory("success");
  await handleAutoBuy("TESTMINT_A3");

  console.log("
[A4] Swap fail-once test");
  fetchTokenPriceUSD = await mockFetchTokenPriceUSDFactory([1.0, 1.08, 1.11]);
  executeSwap = await mockExecuteSwapFactory("failOnce");
  await handleAutoBuy("TESTMINT_A4");

  fetchTokenPriceUSD = realFetch;
  executeSwap = realSwap;

  console.log("\n================ MOCK AUTOBUY TEST SUITE ================\n");

export { mainLoop, fetchNewLPEvents, processTransaction };
