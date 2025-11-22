// liquidityGuard.js
// Robusted version: safe fetch + JSON parsing + timeouts + guarded logic
// Full protection: 2x take-profit, price rug, liquidity drain,
// big-sell detection, creator score fallback (tokenCreatorScanner.js)
// + Telegram alerts

import fs from "fs";
import fetch from "node-fetch";
import { Connection } from "@solana/web3.js";
import dotenv from "dotenv";

import { markSellStart, markSellComplete, allSellsComplete } from "./sellmonitor.js";
import { executeAutoSell } from "./autosell.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";

dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC_URL);

// --- CONFIG ---
const ACTIVE_POSITIONS_FILE = "./active_positions.json";
const LIQUIDITY_MIN_USD = Number(process.env.LIQUIDITY_MIN_USD || 3000); // change via .env
const PRICE_DROP_TRIGGER = 0.35;
const PROFIT_TAKE_MULTIPLIER = 2;
const BIG_SELL_THRESHOLD = 0.35;
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL_MS || 15000);
const SCAN_CREATOR_INTERVAL = Number(process.env.SCAN_CREATOR_INTERVAL_MS || 60_000);

// Panic sell config
const PANIC_DROP_THRESHOLD = 0.3; // 30% liquidity drop
const PANIC_DROP_WINDOW = 10_000; // 10s window
const lastLiquidity = new Map();

// Telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// Cache: prevent scanning creator wallet too frequently
const lastCreatorScan = new Map();

// Generic fetch timeout (ms)
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 5000);

// =====================================================
// Utilities: safe JSON fetch with timeout + retries
// =====================================================
async function safeJsonFetch(url, { retries = 1, timeout = FETCH_TIMEOUT } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);

      // Accept only 2xx responses
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`⚠️ safeJsonFetch: ${res.status} from ${url} — body len ${String(body).length}`);
        return null;
      }

      // Quick content-type check (if present). Some services return HTML on errors.
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json") && !ct.includes("json")) {
        // still try parse (some APIs don't set header), but be defensive
        const txt = await res.text();
        try {
          return JSON.parse(txt);
        } catch (err) {
          console.warn(`⚠️ safeJsonFetch: Invalid JSON from ${url} (content-type: ${ct})`);
          return null;
        }
      }

      // parse JSON safely
      const txt = await res.text();
      try {
        return JSON.parse(txt);
      } catch (err) {
        console.warn(`⚠️ safeJsonFetch: JSON.parse failed from ${url}: ${err.message}`);
        return null;
      }

    } catch (err) {
      clearTimeout(id);
      if (err.name === "AbortError") {
        console.warn(`⚠️ safeJsonFetch: timeout ${timeout}ms for ${url}`);
      } else {
        console.warn(`⚠️ safeJsonFetch: network error for ${url}: ${err.message}`);
      }

      // retry logic
      if (attempt < retries) {
        const backoff = 200 * (attempt + 1);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      return null;
    }
  }

  return null;
}

function safeReadJsonFile(path) {
  try {
    if (!fs.existsSync(path)) return null;
    const txt = fs.readFileSync(path, "utf8");
    return JSON.parse(txt);
  } catch (err) {
    console.warn(`⚠️ safeReadJsonFile: failed to read/parse ${path}: ${err.message}`);
    return null;
  }
}

// =====================================================
// Telegram Alert
// =====================================================
async function telegramAlert(text) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TG_BOT}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" })
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`⚠️ Telegram API returned ${res.status}: ${body}`);
    }

  } catch (err) {
    console.log(`⚠️ Telegram send error: ${err.message}`);
  }
}

// =====================================================
// Big Sell Detection (uses birdeye trades)
// =====================================================
async function detectBigSell(mintAddress) {
  try {
    const url = `https://public-api.birdeye.so/public/trades?address=${mintAddress}&offset=0&limit=10`;
    const json = await safeJsonFetch(url, { retries: 1, timeout: 4000 });
    if (!json || !json.data) return false;

    const tradesData = json.data.items || [];
    if (!tradesData.length) return false;

    const total = tradesData.reduce((s, t) => s + (t.amount_usd || 0), 0);
    if (!total) return false; // nothing meaningful

    const sell = tradesData.reduce((s, t) => (t.side === "sell" ? s + (t.amount_usd || 0) : s), 0);
    const ratio = sell / total;
    if (ratio > BIG_SELL_THRESHOLD) {
      console.log(`⚠️ detectBigSell: ${mintAddress} sell ratio ${(ratio * 100).toFixed(1)}%`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`⚠️ detectBigSell error for ${mintAddress}: ${err.message}`);
    return false;
  }
}

// =====================================================
// Creator wallet safety (cached)
// =====================================================
async function creatorStillSafe(mintAddress) {
  try {
    const now = Date.now();

    if (lastCreatorScan.has(mintAddress) &&
        now - lastCreatorScan.get(mintAddress) < SCAN_CREATOR_INTERVAL) {
      return { safe: true };
    }

    lastCreatorScan.set(mintAddress, now);

    // verifyCreatorSafety may throw — guard it
    try {
      return await verifyCreatorSafety(mintAddress);
    } catch (err) {
      console.warn(`⚠️ creatorStillSafe: verifyCreatorSafety error for ${mintAddress}: ${err.message}`);
      return { safe: true }; // fallback: don't panic-sell on scanner errors
    }
  } catch (err) {
    console.warn(`⚠️ creatorStillSafe unexpected error: ${err.message}`);
    return { safe: true };
  }
}

// =====================================================
// Check single token position
// =====================================================
async function checkTokenPosition(pos) {
  const { mintAddress, buyPrice, symbol, amount } = pos;
  let action = null;
  let reason = "";
  let currentPrice = buyPrice;

  try {
    // Fetch token summary from birdeye
    const url = `https://public-api.birdeye.so/public/token/${mintAddress}`;
    const json = await safeJsonFetch(url, { retries: 1, timeout: 4000 });
    if (!json || !json.data) {
      console.warn(`⚠️ checkTokenPosition: token data missing for ${mintAddress}`);
      return; // skip this token for now, but do not crash
    }

    const token = json.data;
    const liquidity = Number(token.liquidity || 0);
    currentPrice = Number(token.price || buyPrice);

    // -------------------- PANIC SELL --------------------
    const now = Date.now();
    const prev = lastLiquidity.get(mintAddress) || null;

    if (prev && prev.value > 0) {
      const drop = (prev.value - liquidity) / prev.value;
      if (drop >= PANIC_DROP_THRESHOLD && now - prev.timestamp <= PANIC_DROP_WINDOW) {
        action = "SELL_FULL";
        reason = `⚠️ Panic sell — liquidity dropped ${(drop * 100).toFixed(1)}% in ${PANIC_DROP_WINDOW/1000}s`;
      }
    }

    lastLiquidity.set(mintAddress, { value: liquidity, timestamp: now });

    // -------------------- STANDARD RULES --------------------
    if (liquidity < LIQUIDITY_MIN_USD && !action) {
      action = "SELL_FULL";
      reason = `Liquidity drained below $${LIQUIDITY_MIN_USD}`;
    }

    if (currentPrice < buyPrice * PRICE_DROP_TRIGGER && !action) {
      action = "SELL_FULL";
      reason = "Price rug detected";
    }

    if (currentPrice >= buyPrice * PROFIT_TAKE_MULTIPLIER && !action) {
      action = "SELL_FULL";
      reason = "Reached 2× take profit";
    }

    // Detect big sell pressure
    const bigSell = await detectBigSell(mintAddress);
    if (bigSell && !action) {
      action = "SELL_FULL";
      reason = "Large sell pressure detected";
    }

    // Creator check (fallback)
    const creatorCheck = await creatorStillSafe(mintAddress);
    if (creatorCheck && creatorCheck.safe === false && !action) {
      action = "SELL_FULL";
      reason = "Creator wallet score dropped (unsafe)";
    }

  } catch (err) {
    console.error(`⚠️ checkTokenPosition error for ${mintAddress}: ${err.message}`);
    return;
  }

  if (!action) return;

  // -------------------- EXECUTE SELL --------------------
  try {
    const profitPerc = ((currentPrice - buyPrice) / buyPrice) * 100;
    const birdeyeLink = `https://birdeye.so/token/${mintAddress}`;

    console.log(`🚨 SELL: ${symbol || mintAddress} — ${reason} — Profit: ${profitPerc.toFixed(2)}%`);

    markSellStart(mintAddress);

    await telegramAlert(
      `🚨 <b>SELL SIGNAL</b>\n` +
      `Token: <b>${symbol}</b>\n` +
      `Reason: <b>${reason}</b>\n` +
      `Profit: <b>${profitPerc.toFixed(2)}%</b>\n` +
      `📊 <a href="${birdeyeLink}">View on Birdeye</a>`
    );

    await executeAutoSell(mintAddress, amount);
    markSellComplete(mintAddress);

    await telegramAlert(
      `✅ <b>SELL COMPLETED</b>\n` +
      `Token: ${symbol}\n` +
      `Price: $${Number(currentPrice).toFixed(4)}\n` +
      `Profit: ${profitPerc.toFixed(2)}%`
    );

  } catch (err) {
    await telegramAlert(`❌ Sell failed: ${symbol}\nError: ${err.message}`);
    console.error(`❌ Sell failed for ${mintAddress}: ${err.message}`);
  }
}

// =====================================================
// Main liquidity monitor loop
// =====================================================
export async function monitorLiquidity() {
  try {
    if (!fs.existsSync(ACTIVE_POSITIONS_FILE)) return;

    const positions = safeReadJsonFile(ACTIVE_POSITIONS_FILE);
    if (!Array.isArray(positions)) {
      console.warn("⚠️ monitorLiquidity: active_positions.json missing or invalid");
      return;
    }

    // Process tokens sequentially to avoid hammering APIs
    for (const pos of positions) {
      try {
        await checkTokenPosition(pos);
      } catch (err) {
        console.warn(`⚠️ monitorLiquidity: checkTokenPosition error for ${pos?.mintAddress}: ${err.message}`);
        // continue with next token
      }
    }

    if (allSellsComplete()) {
      console.log("🟢 All monitored tokens stable.");
    }
  } catch (err) {
    console.error(`❌ monitorLiquidity top-level error: ${err.message}`);
  }
}

// start interval safely
setInterval(() => {
  monitorLiquidity().catch(err => {
    console.error("❌ monitorLiquidity uncaught error:", err.message);
  });
}, CHECK_INTERVAL);

console.log(`🧠 LiquidityGuard running (${CHECK_INTERVAL}ms intervals + Telegram alerts).`);