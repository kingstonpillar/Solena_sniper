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
  Meteora_DLMM: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
};
// ----------------------------- CONSTANTS -----------------------------
const WSOL = "So11111111111111111111111111111111111111112"; // wrapped SOL mint
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8nQbnb3gT1k2KD7";
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

// ----------------------------- FILE HELPERS -----------------------------
function saveMigrator(mintAddress) {
  try {
    const list = readMigratorsFile();
    if (list.find(r => r.mintAddress === mintAddress)) return true;
    list.push({ mintAddress, detectedAt: Date.now() });
    const ok = writeMigratorsFile(list);
    if (ok) migrators.add(mintAddress);
    return ok;
  } catch (e) { console.log("saveMigrator error:", e?.message || e); return false; }
}

// ------------------- NEW: Save Migrator With Price -------------------
async function saveMigratorWithPrice(mintAddress) {
  try {
    const list = readMigratorsFile();
    if (list.find(r => r.mintAddress === mintAddress)) return true;

    const priceSOL = await fetchTokenPriceInSOL(mintAddress);

    list.push({ 
      mintAddress, 
      detectedAt: Date.now(),
      priceSOL: priceSOL || null
    });
    writeMigratorsFile(list);
    migrators.add(mintAddress);
    return true;
  } catch (e) { console.log("saveMigratorWithPrice error:", e?.message || e); return false; }
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
  if (cachedSolPrice && now - lastSolPriceFetch < PRICE_CACHE_MS) return cachedSolPrice;

  try {
    if (typeof scanMintFast !== "function") throw new Error("scanMintFast not implemented");

    const solInfo = await scanMintFast(conn, SOL_MINT, {
      dataSliceLen: 320,
      maxProgramAccountsToCheck: 200
    });

    // accept either priceInUSD or price (backward compat)
    const price = solInfo?.priceInUSD ?? solInfo?.price ?? null;
    if (price && Number.isFinite(price)) {
      cachedSolPrice = price;
      lastSolPriceFetch = now;
      return price;
    }
    return null;
  } catch (err) {
    console.log("fetchSolPriceUSD error:", err?.message || err);
    return null;
  }
}

// fetch token price in SOL using scanMintFast; preserves cache
async function fetchTokenPriceInSOL(mintAddress) {
  const now = nowMs();
  const cache = volCache[mintAddress];
  if (cache && now - (cache.ts || 0) < VOL_SAMPLE_SHORT_MS) {
    return cache.lastPrice ?? null;
  }

  try {
    if (typeof scanMintFast !== "function") throw new Error("scanMintFast not implemented");

    const info = await scanMintFast(conn, mintAddress, {
      dataSliceLen: 300,
      maxProgramAccountsToCheck: 200,
      solPriceUsd: cachedSolPrice || null
    });

    // accept either priceInSOL or price (back-compat: price could be token price relative to SOL)
    const priceSOL = info?.priceInSOL ?? info?.price ?? null;

    volCache[mintAddress] = { lastPrice: priceSOL, ts: now };
    return priceSOL;
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
function extractTokenBalancesFromMeta(meta) {
  // Prefer postTokenBalances (final state). If missing, use preTokenBalances (best-effort).
  const post = meta?.postTokenBalances || [];
  const pre = meta?.preTokenBalances || [];
  const source = post.length > 0 ? post : (pre.length > 0 ? pre : []);
  const balances = {};
  for (const b of source) {
    const mint = b?.mint;
    const ui = Number(b?.uiTokenAmount?.ui || 0);
    if (!mint) continue;
    balances[mint] = (balances[mint] || 0) + ui; // sum if multiple accounts
  }
  return { source, balances };
}

function detectSolLiquidityFromTx(tx, solPriceUSD) {
  const logs = tx.meta?.logMessages || [];
  const logsJoined = logs.join(" ").toLowerCase();

  const { source, balances } = extractTokenBalancesFromMeta(tx.meta || {});
  const mints = Object.keys(balances);
  if (mints.length < 1) return false;

  const invokedProgramIds = (tx.transaction?.message?.accountKeys || [])
    .map(k => (typeof k === 'string' ? k : k.pubkey?.toString?.()))
    .filter(Boolean);

  const dexProgramMatch = Object.entries(DEX_PROGRAMS).find(([, pk]) => invokedProgramIds.includes(pk.toString()));
  const raydiumHit = logsJoined.includes("amm") || logsJoined.includes("raydium") || logsJoined.includes("initialize");
  const orcaHit = logsJoined.includes("orca") || logsJoined.includes("whirlpool") || logsJoined.includes("liquidity");
  const meteoraHit = logsJoined.includes("dlmm") || logsJoined.includes("meteora") || logsJoined.includes("add_liquidity");

  if (!dexProgramMatch && !(raydiumHit || orcaHit || meteoraHit)) return false;

  const dex = dexProgramMatch ? dexProgramMatch[0] : (raydiumHit ? "Raydium" : orcaHit ? "Orca" : "Meteora");

  const hasWSOL = mints.includes(WSOL);
  const nonSolMints = mints.filter(m => m !== WSOL);

  // Representative mint = largest non-WSOL token by ui balance (best-effort)
  let repMint = null;
  if (nonSolMints.length === 1) repMint = nonSolMints[0];
  else if (nonSolMints.length > 1) {
    repMint = nonSolMints.reduce((a, b) => (balances[a] >= balances[b] ? a : b), nonSolMints[0]);
  }

  let poolValueUSD = 0;
  if (hasWSOL) {
    poolValueUSD += (balances[WSOL] || 0) * (solPriceUSD || 0);
  }

  for (const tk of nonSolMints) {
    const amountUi = balances[tk] || 0;
    // price may be missing here; caller will attempt token price fetch later
    const tokenPriceSOL = volCache[tk]?.lastPrice || null;
    if (tokenPriceSOL && solPriceUSD) {
      poolValueUSD += amountUi * tokenPriceSOL * solPriceUSD;
    }
  }

  return { repMint, dex, liquiditySOL: hasWSOL ? (balances[WSOL] || 0) : 0, poolValueUSD, mints, balances, source, logsJoined };
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

    const liquidityData = detectSolLiquidityFromTx(tx, solPrice);
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
      const tokenSafe = await retry(() => verifyTokenSecurity(repMint), 2, 1000);
      const creatorSafe = await retry(() => verifyCreatorSafety(repMint), 2, 1000);
      if (!tokenSafe || !creatorSafe) {
        await sendTelegram(`⚠️ Token ${repMint} failed security checks. Skipping buy.`);
        console.log(`Security check failed for ${repMint}. tokenSafe=${tokenSafe} creatorSafe=${creatorSafe}`);
        return;
      }
    } catch (e) {
      console.log("Security checks error:", e?.message || e);
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

    // ------------------- Momentum Wait -------------------
    let priceNow = price0;
    const start = Date.now();
    while (((priceNow - price0) / price0 * 100) < MOMENTUM_MIN_PCT && Date.now() - start < MOMENTUM_MAX_WAIT_MS) {
      await delay(10_000);
      const tmp = await fetchTokenPriceInSOL(mintAddress);
      if (tmp && tmp > 0) priceNow = tmp;
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

// Mock test block (unchanged)
if (process.argv.includes('--mock-autobuy')) {
  console.log("Running AutoBuy Mock Test...");
  let mockPrice = 1.0;
  async function mockFetchTokenPriceUSD() {
    mockPrice += 0.12;
    return mockPrice;
  }
  global.fetchTokenPriceUSD = mockFetchTokenPriceUSD;
  global.StartWatcher = async () => console.log("[MOCK] StartWatcher called");
  global.StopWatcher = async () => console.log("[MOCK] StopWatcher called");
  global.executeSwap = async (src, dst) => {
    console.log(`[MOCK] executeSwap called: ${src} -> ${dst}`);
  };
  persistFileEnsure();
  writeMigratorsFile([{ mintAddress: "MockMint111111111111111111111111111111111", detectedAt: Date.now() }]);
  (async () => {
    await handleAutoBuy("MockMint111111111111111111111111111111111");
    console.log("AutoBuy Mock Test Complete");
    process.exit(0);
  })();
}