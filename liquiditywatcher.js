// liquiditywatcher.js (production-hardened)
// Fixed: decimals, balance handling, rep-mint selection, SOL price priming,
// scanMintFast compatibility, RPC retry/backoff, per-mint locks, per-dex cooldown.

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

import { scanMintFast } from "./priceScanner.js";
import { verifyTokenSecurity } from "./tokensecurities.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";
import { executeSwap, StartWatcher, StopWatcher } from "./swapexecutor.js";

dotenv.config();

// ----------------------------- CONFIG -----------------------------
const RPC_URL = process.env.RPC_URL_1 || "https://api.mainnet-beta.solana.com";
const POTENTIAL_FILE = process.env.POTENTIAL_FILE || "./potential_migrators.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const FRESHNESS_LIMIT_SECONDS = Number(process.env.FRESHNESS_LIMIT_SECONDS || 360); // 6 minutes
const LIQUIDITY_BASE_USD = Number(process.env.LIQUIDITY_BASE_USD || 15000);
const VOL_SAMPLE_SHORT_MS = Number(process.env.VOL_SAMPLE_SHORT_MS || 15_000);
const VOL_SAMPLE_LONG_MS = Number(process.env.VOL_SAMPLE_LONG_MS || 60_000);
const VOL_CACHE_TTL_MS = Number(process.env.VOL_CACHE_TTL_MS || 15 * 60_000);
const MOMENTUM_MAX_WAIT_MS = Number(process.env.MOMENTUM_MAX_WAIT_MS || 5 * 60_000);
const MOMENTUM_MIN_PCT = Number(process.env.MOMENTUM_MIN_PCT || 10);
const POTENTIAL_FRESHNESS_MS = Number(process.env.POTENTIAL_FRESHNESS_MS || 360_000);

const conn = new Connection(RPC_URL, "confirmed");



// ----------------------------- DEX PROGRAMS -----------------------------
   const DEX_PROGRAMS = {
  Raydium_AMM_v4: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  Orca_AMM: new PublicKey("9WwRZjZJ9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5"),
};
// ----------------------------- CONSTANTS -----------------------------
const WSOL = "So11111111111111111111111111111111111111112"; // wrapped SOL mint
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gT1k2KD7"; // canonical USDC
const SOL_MINT = WSOL; // canonical SOL mint used for price fetch

// ----------------------------- RATE LIMITERS -----------------------------
const rpcQueue = new PQueue({
  interval: 1000,     // 1 second window
  intervalCap: 6,     // MAX 6 requests per second
  concurrency: 6      // allow up to 6 running at the same time
});
const rpc = (fn) => rpcQueue.add(fn);

// wrapper with retry/backoff for RPC functions
async function rpcRetry(fn, attempts = 3, backoffMs = 700) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await rpc(fn);
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
    }
  }
  return null;
}

// ----------------------------- STATE -----------------------------
const recentTxCache = new Set();
let recentlyTriggered = new Map();
let buyLocks = new Set(); // per-mint lock to avoid concurrent buys
let migrators = new Set();
const volCache = {};
let cachedSolPrice = null;
let lastSolPriceFetch = 0;


// ----------------------------- FILE HELPERS (robust / atomic) -----------------------------
const POTENTIAL_FILE_PATH = path.resolve(process.cwd(), POTENTIAL_FILE);

function ensurePotentialFile() {
  try {
    if (!fs.existsSync(POTENTIAL_FILE_PATH)) {
      fs.writeFileSync(POTENTIAL_FILE_PATH, "[]", "utf8");
      migrators = new Set();
    }
  } catch (e) {
    console.log("ensurePotentialFile error:", e?.message || e);
    migrators = new Set();
  }
}

function readMigratorsFile() {
  try {
    ensurePotentialFile();
    const raw = fs.readFileSync(POTENTIAL_FILE_PATH, "utf8");
    const list = JSON.parse(raw || "[]");
    if (!Array.isArray(list)) return [];
    return list;
  } catch (e) {
    console.log("readMigratorsFile error:", e?.message || e);
    return [];
  }
}

function writeMigratorsFile(list) {
  try {
    // atomic write: write to tmp then rename
    const tmp = `${POTENTIAL_FILE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
    fs.renameSync(tmp, POTENTIAL_FILE_PATH);
    return true;
  } catch (e) {
    console.log("writeMigratorsFile error:", e?.message || e);
    return false;
  }
}

function loadMigratorsFromFile() {
  try {
    const list = readMigratorsFile();
    // normalize list items: ensure each has mintAddress + detectedAt
    const normalized = (Array.isArray(list) ? list : []).map(item => {
      return {
        mintAddress: (item && item.mintAddress) ? String(item.mintAddress) : null,
        detectedAt: Number(item?.detectedAt) || Date.now()
      };
    }).filter(i => i.mintAddress);
    migrators = new Set(normalized.map(m => m.mintAddress));
    // keep the file consistent by rewriting normalized form (optional)
    // writeMigratorsFile(normalized);
    return normalized;
  } catch (e) {
    console.log("loadMigratorsFromFile error:", e?.message || e);
    migrators = new Set();
    return [];
  }
}

function saveMigrator(mintAddress) {
  try {
    if (!mintAddress) return false;
    const list = readMigratorsFile();
    if (list.find(r => r.mintAddress === mintAddress)) return true;
    list.push({ mintAddress, detectedAt: Date.now() });
    const ok = writeMigratorsFile(list);
    if (ok) migrators.add(mintAddress);
    return ok;
  } catch (e) {
    console.log("saveMigrator error:", e?.message || e);
    return false;
  }
}

async function saveMigratorWithPrice(mintAddress) {
  try {
    if (!mintAddress) return false;
    const list = readMigratorsFile();
    if (list.find(r => r.mintAddress === mintAddress)) return true;
    const priceSOL = await fetchTokenPriceInSOL(mintAddress).catch(() => null);
    list.push({
      mintAddress,
      detectedAt: Date.now(),
      priceSOL: priceSOL ?? null
    });
    const ok = writeMigratorsFile(list);
    if (ok) migrators.add(mintAddress);
    return ok;
  } catch (e) {
    console.log("saveMigratorWithPrice error:", e?.message || e);
    return false;
  }
}

function removeMigrator(mintAddress) {
  try {
    if (!mintAddress) return false;
    const list = readMigratorsFile();
    const filtered = list.filter(m => m.mintAddress !== mintAddress);
    const ok = writeMigratorsFile(filtered);
    if (ok) migrators.delete(mintAddress);
    return ok;
  } catch (e) {
    console.log("removeMigrator error:", e?.message || e);
    return false;
  }
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

// ----------------------------- PRICE CACHE / HELPERS -----------------------------
const PRICE_CACHE_MS = 60_000; // 1 minute
const DEFAULT_DECIMALS = 6;
function nowMs() { return Date.now(); }

async function getTokenDecimals(mint) {
  try {
    const info = await rpcRetry(() => conn.getParsedAccountInfo(new PublicKey(mint), "confirmed"));
    return info?.value?.data?.parsed?.info?.decimals ?? DEFAULT_DECIMALS;
  } catch (_) {
    return DEFAULT_DECIMALS;
  }
}

// fetch SOL price (USD) using scanMintFast; ensure cached prior to token valuations


async function fetchSolPriceUSD() {
  const now = nowMs();

  if (cachedSolPrice && (now - lastSolPriceFetch) < PRICE_CACHE_MS) {
    return cachedSolPrice;
  }

  try {
    if (typeof scanMintFast !== "function") {
      throw new Error("scanMintFast not implemented");
    }

    // scan SOL mint only – no pool registry
    const solInfo = await scanMintFast(SOL_MINT);
if (!solInfo) {
  console.warn("scanMintFast returned no data for SOL");
  return null;
}

    const priceUSD =
      solInfo?.priceInUSD ??
      solInfo?.priceUSD ??
      solInfo?.price ??
      null;

    if (Number.isFinite(priceUSD) && priceUSD > 0) {
      cachedSolPrice = priceUSD;
      lastSolPriceFetch = now;
      return priceUSD;
    }

    return null;
  } catch (err) {
    console.log("fetchSolPriceUSD error:", err?.message || err);
    return null;
  }
}
// fetch token price in SOL using scanMintFast; preserves cache
// fetch token price in SOL using scanMintFast; cached
async function fetchTokenPriceInSOL(mintAddress) {
  const now = nowMs();

  const cache = volCache[mintAddress];
  if (cache && (now - (cache.ts || 0)) < VOL_SAMPLE_SHORT_MS) {
    return cache.lastPrice ?? null;
  }

  try {
    if (typeof scanMintFast !== "function") {
      throw new Error("scanMintFast not implemented");
    }

    const info = await scanMintFast(mintAddress);
if (!info) {
  console.warn(`scanMintFast returned no data for ${mintAddress}`);
  volCache[mintAddress] = { lastPrice: null, ts: now };
  return null;
}

    const priceSOL =
      info?.priceInSOL ??
      info?.priceSOL ??
      info?.price ??
      null;

    volCache[mintAddress] = {
      lastPrice: (Number.isFinite(priceSOL) && priceSOL > 0) ? priceSOL : null,
      ts: now
    };

    return volCache[mintAddress].lastPrice;
  } catch (err) {
    console.log("fetchTokenPriceInSOL error:", err?.message || err);
    volCache[mintAddress] = { lastPrice: null, ts: now };
    return null;
  }
}

// ----------------------------- UTILS -----------------------------
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
async function retry(fn, attempts = 3, backoffMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r !== undefined && r !== null) return r;
    } catch (e) { /* continue */ }
    await delay(backoffMs * (i + 1));
  }
  return null;
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
function getDexCooldown(dex, mint) {
  // combine dex activity and per-token cool-off
  const dexBase = (() => {
    if (!dexActivityMap[dex]) return DEX_COOLDOWN_BASE_MS;
    const activityCount = dexActivityMap[dex].length;
    const scaled = DEX_COOLDOWN_BASE_MS + (activityCount / 10) * (DEX_COOLDOWN_MAX_MS - DEX_COOLDOWN_BASE_MS);
    return Math.min(scaled, DEX_COOLDOWN_MAX_MS);
  })();

  const tokenLast = recentlyTriggered.get(mint) || 0;
  const tokenCooldown = tokenLast ? Math.min(Math.max(DEX_COOLDOWN_BASE_MS, Date.now() - tokenLast), DEX_COOLDOWN_MAX_MS) : dexBase;
  return Math.max(dexBase, tokenCooldown);
}

// ----------------------------- LP DETECTION -----------------------------
/**
 * Extract token balances from transaction meta.
 * Prefers postTokenBalances (final state). Falls back to preTokenBalances if missing.
 * Handles various representations of amounts and guards against NaN.
 *
 * @param {object} meta - Transaction meta object
 * @returns {{ source: Array, balances: Record<string, number> }}
 */
function extractTokenBalancesFromMeta(meta) {
  // Use postTokenBalances if available, else preTokenBalances
  const post = Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : [];
  const pre = Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : [];
  const source = post.length > 0 ? post : (pre.length > 0 ? pre : []);

  const balances = {};

  for (const b of source) {
    const mint = b?.mint;
    if (!mint) continue;

    let ui = 0;

    try {
      // Prefer uiAmount, then uiAmountString, then raw amount
      if (b?.uiTokenAmount) {
        ui = typeof b.uiTokenAmount.uiAmount === "number"
          ? b.uiTokenAmount.uiAmount
          : Number(b.uiTokenAmount.uiAmountString) || 0;
      } else if (typeof b?.uiAmount === "number") {
        ui = b.uiAmount;
      } else if (typeof b?.amount === "string") {
        ui = Number(b.amount) || 0;
      }
    } catch (_) {
      ui = 0;
    }

    if (!Number.isFinite(ui)) ui = 0;

    // Sum balances if multiple accounts exist for the same mint
    balances[mint] = (balances[mint] || 0) + ui;
  }

  return { source, balances };
}

// =============================
// 🔴 Detect Liquidity by Transaction
// =============================
/**
 * Detect liquidity from a Solana transaction.
 * Handles WSOL, USDC, USDT, BONK, or any token.
 * Computes pool USD value using SOL and token prices.
 *
 * @param {object} tx - Transaction object
 * @param {number} solPrice - Current SOL price in USD
 * @returns {Promise<{ repMint: string, dex: string, poolValueUSD: number, mints: string[], balances: Record<string, number> } | null>}
 */
async function detectSolLiquidityFromTx(tx, solPrice) {
  if (!tx || !tx.meta) return null;

  const { balances } = extractTokenBalancesFromMeta(tx.meta);
  const mints = Object.keys(balances).filter(mint => balances[mint] > 0);
  if (!mints.length) return null;

  // -----------------------
  // Fetch all token prices in parallel
  // -----------------------
  const priceResults = await Promise.all(
    mints.map(async (mint) => {
      let priceUSD = null;

      if (mint === WSOL) {
        priceUSD = solPrice;
      } else {
        const priceSOL = await fetchTokenPriceInSOL(mint).catch(() => null);
        if (priceSOL != null && solPrice != null) {
          priceUSD = priceSOL * solPrice;
        }
      }

      return { mint, priceUSD };
    })
  );

  // Filter out tokens without valid USD prices
  const pricedTokens = priceResults.filter(p => p.priceUSD && p.priceUSD > 0);
  if (!pricedTokens.length) return null;

  // -----------------------
  // Pick representative mint (highest USD value)
  // -----------------------
  let repMint = null;
  let maxValue = -1;
  for (const { mint, priceUSD } of pricedTokens) {
    const val = balances[mint] * priceUSD;
    if (val > maxValue) {
      maxValue = val;
      repMint = mint;
    }
  }

  if (!repMint) return null;

  // -----------------------
  // Compute total pool USD value
  // -----------------------
  let poolValueUSD = 0;
  for (const { mint, priceUSD } of pricedTokens) {
    poolValueUSD += balances[mint] * priceUSD;
  }

  return { repMint, dex: "unknown", poolValueUSD, mints, balances };
}
// ----------------------------- PROCESS TRANSACTION -----------------------------
async function processTransaction(signature) {
  try {
    if (recentTxCache.has(signature)) return;
    recentTxCache.add(signature);
    if (recentTxCache.size > 10_000) recentTxCache.clear();

    console.log(`\n--- CHECK SIG ${signature} ---`);
    const solPrice = await fetchSolPriceUSD();
    if (!solPrice) { console.log("No SOL price available, skipping."); return; }

    const tx = await rpcRetry(() =>
      conn.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      })
    );
    if (!tx || !tx.meta) { console.log(`Missing tx/meta for ${signature}`); return; }

    const liquidityData = await detectSolLiquidityFromTx(tx, solPrice);
    if (!liquidityData) { console.log(`No LP detected for ${signature}`); return; }

    const { repMint, dex, poolValueUSD: poolValueFromWSOL, mints, balances } = liquidityData;
    if (!repMint) { console.log("No representative non-WSOL mint identified — skipping."); return; }
    if (migrators.has(repMint)) { console.log(`Already in migrators: ${repMint}`); return; }

    const cooldown = getDexCooldown(dex, repMint);
    if (recentlyTriggered.has(repMint)) {
      const last = recentlyTriggered.get(repMint);
      if (Date.now() - last < cooldown) { console.log(`Cooldown active for ${repMint} on ${dex}`); return; }
    }

    const blockTime = tx.blockTime;
    if (!blockTime) { console.log("No blockTime, skipping."); return; }
    const now = Math.floor(Date.now() / 1000);
    const age = now - blockTime;
    if (age > FRESHNESS_LIMIT_SECONDS) { console.log(`TX too old (${age}s) — skipping`); return; }
    console.log(`LP age ${age}s — within freshness.`);

    let poolValueUSD = poolValueFromWSOL || 0;
    if (!poolValueUSD || poolValueUSD <= 0) {
      // compute token valuations by fetching token prices
      let sum = 0;
      let ok = true;
      for (const tk of mints) {
        const amountUi = balances[tk] || 0;
        if (!amountUi || amountUi <= 0) continue;
        if (tk === WSOL) { sum += amountUi * solPrice; continue; }
        const tokenPriceSOL = await fetchTokenPriceInSOL(tk);
        if (!tokenPriceSOL || tokenPriceSOL <= 0) { ok = false; break; }
        sum += amountUi * tokenPriceSOL * solPrice;
      }
      if (ok) poolValueUSD = sum;
    }

    if (!poolValueUSD || poolValueUSD < 0) {
      console.log(`Could not compute pool USD for ${repMint} — skipping.`);
      return;
    }

    const volatility = await computeTokenVolatility(repMint, 10_000);
    const dynamicMinUSD = computeDynamicLiquidityMin(volatility);

    console.log(`[INFO] dex=${dex} repMint=${repMint} poolUSD=${poolValueUSD.toFixed(2)} vol=${volatility.toFixed(2)} dynMin=${dynamicMinUSD}`);

    if (!poolValueUSD || poolValueUSD < dynamicMinUSD) {
      await sendTelegram(`❌ Token ${repMint} rejected — pool USD $${(poolValueUSD || 0).toFixed(2)} < dynamic min $${dynamicMinUSD}.`);
      console.log(`Rejected ${repMint}: pool ${poolValueUSD} < ${dynamicMinUSD}`);
      return;
    }

    
    // Security checks (with retries)
try {
  // Make sure the functions exist before calling
  if (typeof verifyTokenSecurity !== "function" || typeof verifyCreatorSafety !== "function") {
    console.warn(`Security functions not available for ${repMint}, skipping checks.`);
    return;
  }

  const tokenSafe = await retry(() => verifyTokenSecurity(repMint), 2, 1000).catch(err => {
    console.warn(`verifyTokenSecurity failed for ${repMint}:`, err?.message || err);
    return false;
  });

  const creatorSafe = await retry(() => verifyCreatorSafety(repMint), 2, 1000).catch(err => {
    console.warn(`verifyCreatorSafety failed for ${repMint}:`, err?.message || err);
    return false;
  });

  if (!tokenSafe || !creatorSafe) {
    await sendTelegram(`⚠️ Token ${repMint} failed security checks. Skipping buy.`);
    console.log(`Security check failed for ${repMint}. tokenSafe=${tokenSafe} creatorSafe=${creatorSafe}`);
    return;
  }

} catch (e) {
  console.log("Security checks unexpected error:", e?.message || e);
  return;
}

    // Mark and trigger
    await saveMigratorWithPrice(repMint);
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
    for (const [dexName, programId] of Object.entries(DEX_PROGRAMS)) {
      try {
        const sigInfos = await rpcRetry(() => conn.getSignaturesForAddress(programId, { limit: 25 }));
        if (!Array.isArray(sigInfos) || sigInfos.length === 0) continue;
        for (const s of sigInfos) {
          const sig = s.signature;
          if (!sig || recentTxCache.has(sig)) continue;
          await processTransaction(sig);
          await delay(50);
        }
      } catch (e) {
        console.log(`fetchNewLPEvents error for ${dexName}:`, e?.message || e);
      }
    }
  } catch (e) { console.log("fetchNewLPEvents top-level error:", e?.message || e); }
}

// ----------------------------- Volatility & dynamic liquidity -----------------------------
async function computeTokenVolatility(mint, maxWaitMs = 20_000) {
  const cached = volCache[mint];
  if (cached && (Date.now() - (cached.ts || 0)) < VOL_CACHE_TTL_MS) return cached.vol || 0;

  const start = Date.now();
  const p0 = await fetchTokenPriceInSOL(mint);
  if (!p0) { volCache[mint] = { vol: 0, ts: Date.now() }; return 0; }

  const remaining = Math.max(0, Math.min(maxWaitMs - (Date.now() - start), VOL_SAMPLE_LONG_MS));
  if (remaining <= 0) { volCache[mint] = { vol: 0, ts: Date.now() }; return 0; }

  await delay(Math.min(VOL_SAMPLE_SHORT_MS, remaining / 2));
  const p1 = await fetchTokenPriceInSOL(mint);
  await delay(Math.min(VOL_SAMPLE_LONG_MS - VOL_SAMPLE_SHORT_MS, remaining / 2));
  const p2 = await fetchTokenPriceInSOL(mint);

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

// ----------------------------- HANDLE AUTO BUY -----------------------------
async function handleAutoBuy(mintAddress) {
  // Per-mint lock to avoid concurrent buys
  if (buyLocks.has(mintAddress)) {
    console.log(`Buy already in-flight for ${mintAddress}, skipping.`);
    return;
  }
  buyLocks.add(mintAddress);

  try {
    // ------------------- Persist & Validate -------------------
    ensurePotentialFile();
    const rec = readMigratorsFile().find(r => r.mintAddress === mintAddress);
    if (!rec || Date.now() - rec.detectedAt > POTENTIAL_FRESHNESS_MS) {
      console.log("Record missing or stale. Removing migrator if any.");
      removeMigrator(mintAddress);
      return; // early exit
    }

    // ------------------- Notify Telegram -------------------
    await sendTelegram(`<b>Potential SOL Migrator Detected</b>\n<code>${mintAddress}</code>`);

    // ------------------- Initial Price Fetch -------------------
    const price0 = await retry(() => fetchTokenPriceInSOL(mintAddress), 3);
    if (!price0) {
      console.log("Initial price fetch failed, aborting buy.");
      return;
    }

 
    // ------------------- Momentum Wait (10% Rise) -------------------
let priceNow = price0;
const start = Date.now();

while (((priceNow - price0) / price0 * 100) < MOMENTUM_MIN_PCT
       && Date.now() - start < MOMENTUM_MAX_WAIT_MS) {

  await delay(10_000);

  const info = await scanMintFast(mintAddress);
  const newPrice = info?.priceInSOL ?? info?.priceSOL ?? info?.price;

  if (newPrice && newPrice > 0) {
    priceNow = newPrice;
    console.log(`Updated price for ${mintAddress}: ${priceNow}`);
  }
}

if (((priceNow - price0) / price0 * 100) < MOMENTUM_MIN_PCT) {
  console.log("Momentum not reached. Skipping buy.");
  return;
}

    // ------------------- Execute Swap -------------------
    try {
      await StartWatcher();
      await executeSwap(SOL_MINT, mintAddress);
      await StopWatcher();

      removeMigrator(mintAddress);

      const movePct = ((priceNow - price0) / price0 * 100).toFixed(2);
      await sendTelegram(`✅ BOUGHT\n<code>${mintAddress}</code>\nPrice move: ${movePct}%`);
      console.log(`Auto-buy executed for ${mintAddress}`);
    } catch (err) {
      console.log("Buy error:", err?.message || err);
      await sendTelegram(`❌ Buy failed for ${mintAddress}: ${err?.message || err}`);
    } finally {
      recentlyTriggered.set(mintAddress, Date.now());
    }

  } finally {
    // Release per-mint lock
    buyLocks.delete(mintAddress);
  }
}

// ----------------------------- BOOT / LOOP -----------------------------
async function mainLoop() {
  loadMigratorsFromFile();
  console.log("Starting Liquidity Watcher (production-hardened)");
  while (true) {
    try {
      await fetchNewLPEvents();
    } catch (e) { console.log("mainLoop fetch error:", e?.message || e); }
    await delay(2000);
  }
}

if (process.argv[1] && process.argv[1].endsWith(path.basename(process.argv[1]))) {
  mainLoop().catch(e => console.log("Fatal error:", e));
}
