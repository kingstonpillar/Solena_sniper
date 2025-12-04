// liquiditywatcher.js (fixed, on-chain price in SOL, RPC-limited, awaited init)
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

import { getOnchainPrice, initJupiter } from "./jupiterOnchain.js";
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
const VOL_SAMPLE_SHORT_MS = Number(process.env.VOL_SAMPLE_SHORT_MS || 15_000); // short < long
const VOL_SAMPLE_LONG_MS = Number(process.env.VOL_SAMPLE_LONG_MS || 60_000);
const VOL_CACHE_TTL_MS = Number(process.env.VOL_CACHE_TTL_MS || 15 * 60_000);
const MOMENTUM_MAX_WAIT_MS = Number(process.env.MOMENTUM_MAX_WAIT_MS || 5 * 60_000);
const MOMENTUM_MIN_PCT = Number(process.env.MOMENTUM_MIN_PCT || 10);
const POTENTIAL_FRESHNESS_MS = Number(process.env.POTENTIAL_FRESHNESS_MS || 360_000);

const conn = new Connection(RPC_URL);

// ----------------------------- DEX PROGRAMS -----------------------------
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
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8nQbnb3gT1k2KD7";
const SOL_MINT = WSOL; // canonical SOL mint used for price fetch to match autosell

// ----------------------------- RATE LIMITERS -----------------------------
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });
const jupiterQueue = new PQueue({ interval: 1000, intervalCap: 3 });

// helper wrapper to route RPC calls through limiter
const rpc = (fn) => rpcQueue.add(fn);

// ----------------------------- STATE -----------------------------
const recentTxCache = new Set();
let recentlyTriggered = new Map();
let isBuying = false;
let migrators = new Set();
const volCache = {};
let cachedSolPrice = null;
let lastSolPriceFetch = 0;

// ----------------------------- HELPERS -----------------------------
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function retry(fn, attempts = 3, backoffMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r !== undefined && r !== null) return r;
    } catch (e) {
      // swallow and retry
    }
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
    if (list.find(r => r.mintAddress === mintAddress)) return true;
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

// ----------------------------- PRICE CACHE / HELPERS -----------------------------
const PRICE_CACHE_MS = 60_000; // 1 minute
const DEFAULT_DECIMALS = 6;    // fallback when decimals can't be read

async function getTokenDecimals(mint) {
  try {
    const info = await rpc(() => conn.getParsedAccountInfo(new PublicKey(mint)));
    return info?.value?.data?.parsed?.info?.decimals ?? DEFAULT_DECIMALS;
  } catch (e) {
    return DEFAULT_DECIMALS;
  }
}

function nowMs() { return Date.now(); }

// ----------------------------- BOOT: Init Jupiter (awaited) -----------------------------
let jupiterReady = false;
(async () => {
  try {
    // await Jupiter init with RPC string (jupiterOnchain should create its own Connection)
    await initJupiter(RPC_URL);
    jupiterReady = true;
    console.log("✔ Jupiter on-chain initialized");
  } catch (err) {
    console.error("❌ Jupiter init failed:", err.message || err);
    // don't exit — watcher can still run but price calls will return null
  }
})();

// ----------------------------- SOL PRICE (ON-CHAIN via Jupiter) -----------------------------
async function fetchSolPriceUSD() {
  const now = nowMs();
  if (cachedSolPrice && (now - lastSolPriceFetch) < PRICE_CACHE_MS) return cachedSolPrice;

  try {
    // quote 1 SOL in lamports (1 SOL = 1_000_000_000 lamports)
    const oneSolLamports = 1_000_000_000;
    if (!jupiterReady) return null;

    const quote = await jupiterQueue.add(() => getOnchainPrice(SOL_MINT, USDC_MINT, oneSolLamports));
    const price = quote?.price ?? null;

    if (price && Number.isFinite(price)) {
      cachedSolPrice = price;
      lastSolPriceFetch = now;
      return price;
    } else {
      return null;
    }
  } catch (err) {
    console.log("fetchSolPriceUSD (on-chain) error:", err?.message || err);
    return null;
  }
}

// ----------------------------- TOKEN PRICE (ON-CHAIN via Jupiter in SOL) -----------------------------
async function fetchTokenPriceInSOL(mint) {
  const cache = volCache[mint];

  // short caching window
  if (cache && (nowMs() - (cache.ts || 0)) < VOL_SAMPLE_SHORT_MS) {
    return cache.lastPrice ?? null;
  }

  try {
    const decimals = await getTokenDecimals(mint);
    // request quote for 1 token, expressed in smallest unit
    const amountBig = 10n ** BigInt(decimals);
    const numericAmount = amountBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(amountBig);

    if (!jupiterReady) return null;

    // quote token -> SOL (we want token price in SOL)
    const quote = await jupiterQueue.add(() => getOnchainPrice(mint, SOL_MINT, numericAmount));
    const priceSOL = quote?.price ?? null;

    if (priceSOL && Number.isFinite(priceSOL)) {
      volCache[mint] = { lastPrice: priceSOL, ts: nowMs() };
      return priceSOL;
    } else {
      volCache[mint] = { lastPrice: null, ts: nowMs() };
      return null;
    }
  } catch (err) {
    console.log("fetchTokenPriceInSOL (on-chain) error:", err?.message || err);
    volCache[mint] = { lastPrice: null, ts: nowMs() };
    return null;
  }
}

// ----------------------------- EXPORTS -----------------------------
export {
  fetchSolPriceUSD,
  fetchTokenPriceInSOL as fetchTokenPriceUSD // keep external name but returns SOL price
};

// -----------------------------------------------
// Volatility & dynamic liquidity
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

  const { combined, balances } = extractTokenBalancesFromMeta(tx.meta || {});
  const mints = Array.from(new Set(combined.map(b => b.mint).filter(Boolean)));
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
  const repMint = nonSolMints[0] || null;

  let poolValueUSD = 0;
  if (hasWSOL) {
    poolValueUSD += (balances[WSOL] || 0) * (solPriceUSD || 0);
  }

  for (const tk of nonSolMints) {
    const amountUi = balances[tk] || 0;
    if (!amountUi || amountUi <= 0) continue;
    const priceSOL = volCache[tk]?.lastPrice || null;
    if (priceSOL) poolValueUSD += amountUi * priceSOL * (solPriceUSD || 0); // tokenPriceInSOL * SOL_USD
  }

  return { mint: repMint, dex, liquiditySOL: hasWSOL ? (balances[WSOL] || 0) : 0, poolValueUSD, mints, balances, logsJoined };
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

    const tx = await rpc(() =>
      conn.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      })
    );
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

    let poolValueUSD = poolValueFromWSOL || 0;
    if (!poolValueUSD || poolValueUSD <= 0) {
      let sum = 0;
      let ok = true;
      for (const tk of mints) {
        const amountUi = balances[tk] || 0;
        if (!amountUi || amountUi <= 0) continue;
        if (tk === WSOL) { sum += amountUi * solPrice; continue; }
        const tokenPriceSOL = await fetchTokenPriceInSOL(tk);
        if (!tokenPriceSOL || tokenPriceSOL <= 0) { ok = false; break; }
        sum += amountUi * tokenPriceSOL * solPrice; // tokenPriceSOL * SOL_USD
      }
      if (ok) poolValueUSD = sum;
    }

    const repMint = mint;
    if (repMint === WSOL) { console.log("Representative mint is WSOL — skipping."); return; }

    const volatility = await computeTokenVolatility(repMint, 10_000);
    const dynamicMinUSD = computeDynamicLiquidityMin(volatility);

    console.log(`[INFO] dex=${dex} repMint=${repMint} poolUSD=${poolValueUSD} vol=${volatility} dynMin=${dynamicMinUSD}`);

    if (!poolValueUSD || poolValueUSD < dynamicMinUSD) {
      await sendTelegram(`❌ Token ${repMint} rejected — pool USD $${(poolValueUSD || 0).toFixed(2)} < dynamic min $${dynamicMinUSD}.`);
      console.log(`Rejected ${repMint}: pool ${poolValueUSD} < ${dynamicMinUSD}`);
      return;
    }

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
    for (const [dexName, programId] of Object.entries(DEX_PROGRAMS)) {
      try {
        const sigInfos = await rpc(() => conn.getSignaturesForAddress(programId, { limit: 50 }));
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

// ----------------------------- HANDLE AUTO BUY -----------------------------
async function handleAutoBuy(mintAddress) {
  if (isBuying) {
    console.log("Auto-buy already in progress, skipping.");
    return;
  }

  persistFileEnsure();
  const rec = readMigratorsFile().find(r => r.mintAddress === mintAddress);
  if (!rec || Date.now() - rec.detectedAt > POTENTIAL_FRESHNESS_MS) {
    console.log("Record missing or stale. Removing migrator if any.");
    removeMigrator(mintAddress);
    return;
  }

  isBuying = true;
  await sendTelegram(`<b>Potential SOL Migrator Detected</b>\n<code>${mintAddress}</code>`);

  const price0 = await retry(() => fetchTokenPriceInSOL(mintAddress), 3);
  if (!price0) { isBuying = false; return; }

  let priceNow = price0;
  const start = Date.now();
  while (((priceNow - price0) / price0 * 100) < MOMENTUM_MIN_PCT && Date.now() - start < MOMENTUM_MAX_WAIT_MS) {
    await delay(10_000);
    const tmp = await fetchTokenPriceInSOL(mintAddress);
    if (tmp && tmp > 0) priceNow = tmp;
  }

  if (((priceNow - price0) / price0 * 100) < MOMENTUM_MIN_PCT) {
    console.log("Momentum not reached. Skipping buy.");
    isBuying = false;
    return;
  }

  try {
    await StartWatcher();
    // executeSwap inputs: source SOL mint, destination token mint
    await executeSwap(SOL_MINT, mintAddress);
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
  console.log("Starting Liquidity Watcher (fixed)");
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