// newtoken-pump.js
// Watches Pump.fun & PumpSwap for newly created tokens
// + retries, Telegram alerts, optional Birdeye enrichment, hourly summary (basic)

import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const PUMP_FUN_API = "https://frontend-api.pump.fun/coins/latest";
const PUMPSWAP_API = "https://pumpswap.xyz/api/tokens";
const SAVE_FILE = "./pumpfun_mints.json";

// env
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || null; // optional
const RETRY_MAX = Number(process.env.PUMP_RETRY_MAX || 3);
const RETRY_BASE_MS = Number(process.env.PUMP_RETRY_BASE_MS || 500);
const FETCH_TIMEOUT_MS = Number(process.env.PUMP_FETCH_TIMEOUT_MS || 8000);

// in-memory sets + counters
let pumpFunMints = new Set();
let hourlyCounters = {
  pumpFunNew: 0,
  pumpSwapNew: 0,
  fetchFailures: 0,
  lastReset: Date.now(),
};

// --- load previous mints ---
if (fs.existsSync(SAVE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    pumpFunMints = new Set(loaded || []);
  } catch (e) {
    console.warn("⚠️ Failed to load local mint list — resetting file");
    pumpFunMints = new Set();
    try { fs.writeFileSync(SAVE_FILE, JSON.stringify([], null, 2)); } catch {}
  }
}

// --- helpers ---
function saveMints() {
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify([...pumpFunMints], null, 2));
    console.log(`💾 Saved ${pumpFunMints.size} mints to ${SAVE_FILE}`);
  } catch (err) {
    console.warn("⚠️ Save mints failed:", err.message);
  }
}

async function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchWithRetry(url, opts = {}) {
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} ${text.slice(0,200)}`);
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        throw new Error("Invalid JSON");
      }
      return json;
    } catch (err) {
      const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`⚠️ fetch attempt ${attempt} failed for ${url}: ${err.message}. backoff=${backoff}ms`);
      hourlyCounters.fetchFailures++;
      if (attempt < RETRY_MAX) await sleep(backoff);
      else throw err;
    }
  }
}

// Telegram: minimal wrapper (no throw)
async function telegramAlert(text) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.warn("⚠️ Telegram send error:", err.message);
  }
}

// Optional Birdeye enrichment (best-effort)
async function fetchBirdeyeMetadata(mint) {
  try {
    // If user provided key, use recommended endpoint format (example header)
    const url = `https://public-api.birdeye.so/public/token/${mint}`;
    const headers = { "x-chain": "solana" };
    if (BIRDEYE_KEY) headers["Authorization"] = `Bearer ${BIRDEYE_KEY}`;
    const json = await fetchWithRetry(url, { headers });
    return json?.data || null;
  } catch (err) {
    // Best-effort, don't crash
    return null;
  }
}

// Build Telegram message for a found token
function buildNewTokenMessage(source, token, birdeye) {
  // token from pump.fun: { mint, name, symbol, ... } or pumpswap: similar
  const name = token.name || token.tokenName || token.symbol || token.mint || "unknown";
  const symbol = token.symbol || token.tokenSymbol || "";
  const mint = token.mint || token.address || token.id || "unknown";
  const liquidity = (birdeye && birdeye.liquidity) ? `$${Number(birdeye.liquidity).toFixed(0)}` : "unknown";
  const price = (birdeye && birdeye.price) ? `$${Number(birdeye.price).toFixed(6)}` : "unknown";
  const birdeyeLink = `https://birdeye.so/token/${mint}`;

  return (
    `🆕 <b>New ${source} token</b>\n` +
    `Name: <b>${escapeHtml(name)}</b> ${symbol ? `(${escapeHtml(symbol)})\n` : "\n"}` +
    `Mint: <code>${mint}</code>\n` +
    `Price: <b>${price}</b>\n` +
    `Liquidity: <b>${liquidity}</b>\n` +
    `🔗 <a href="${birdeyeLink}">View on Birdeye</a>`
  );
}

// tiny HTML escape for Telegram
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- fetchers ---
async function fetchPumpFun() {
  try {
    const data = await fetchWithRetry(PUMP_FUN_API);
    const coins = data?.coins || [];
    let added = false;

    for (const token of coins) {
      const mint = token.mint;
      if (!mint) continue;
      if (!pumpFunMints.has(mint)) {
        pumpFunMints.add(mint);
        hourlyCounters.pumpFunNew++;
        added = true;

        // Enrich with Birdeye (best-effort)
        const birdeye = await fetchBirdeyeMetadata(mint);
        const msg = buildNewTokenMessage("Pump.fun", token, birdeye);
        console.log(`🆕 Pump.fun: ${token.name || mint} ${token.symbol || ""}`);
        await telegramAlert(msg);
      }
    }

    if (added) saveMints();
  } catch (err) {
    console.error("Pump.fun fetch error:", err.message || err);
  }
}

async function fetchPumpSwap() {
  try {
    const data = await fetchWithRetry(PUMPSWAP_API);
    const tokens = data?.tokens || [];
    let added = false;

    for (const token of tokens) {
      const mint = token.mint || token.address || token.id;
      if (!mint) continue;
      if (!pumpFunMints.has(mint)) {
        pumpFunMints.add(mint);
        hourlyCounters.pumpSwapNew++;
        added = true;

        const birdeye = await fetchBirdeyeMetadata(mint);
        const msg = buildNewTokenMessage("PumpSwap", token, birdeye);
        console.log(`🆕 PumpSwap: ${token.name || mint}`);
        await telegramAlert(msg);
      }
    }

    if (added) saveMints();
  } catch (err) {
    console.error("PumpSwap fetch error:", err.message || err);
  }
}

// Hourly summary (Report A - Basic)
async function hourlySummary() {
  try {
    const now = Date.now();
    const since = new Date(now).toISOString();
    const totalMints = pumpFunMints.size;
    const { pumpFunNew, pumpSwapNew, fetchFailures } = hourlyCounters;

    const text =
      `⏱️ <b>Hourly Pump Summary</b>\n` +
      `Since: <code>${since}</code>\n` +
      `New Pump.fun tokens: <b>${pumpFunNew}</b>\n` +
      `New PumpSwap tokens: <b>${pumpSwapNew}</b>\n` +
      `Failed fetch attempts: <b>${fetchFailures}</b>\n` +
      `Total stored mints: <b>${totalMints}</b>`;

    console.log(text.replace(/<[^>]+>/g, "")); // log plain text
    await telegramAlert(text);

    // reset counters
    hourlyCounters = { pumpFunNew: 0, pumpSwapNew: 0, fetchFailures: 0, lastReset: now };
  } catch (err) {
    console.warn("⚠️ hourlySummary failed:", err.message);
  }
}

// Graceful unhandled rejection log
process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason && reason.message ? reason.message : reason);
});

// --- main ---
async function startWatcher() {
  console.log("🔍 Starting Pump.fun + PumpSwap watcher...");
  // initial run
  try { await fetchPumpFun(); } catch (e) { console.warn("Initial Pump.fun failed:", e.message); }
  try { await fetchPumpSwap(); } catch (e) { console.warn("Initial PumpSwap failed:", e.message); }

  // intervals
  setInterval(fetchPumpFun, 10000);   // every 10s
  setInterval(fetchPumpSwap, 20000);  // every 20s
  setInterval(hourlySummary, 60 * 60 * 1000); // hourly summary
}

startWatcher();