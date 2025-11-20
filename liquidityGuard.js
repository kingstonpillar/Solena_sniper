// liquidityGuard.js  
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
const LIQUIDITY_MIN_USD = 5000;
const PRICE_DROP_TRIGGER = 0.35;
const PROFIT_TAKE_MULTIPLIER = 2;
const BIG_SELL_THRESHOLD = 0.35;
const CHECK_INTERVAL = 15000;
const SCAN_CREATOR_INTERVAL = 60_000;

// Panic sell config
const PANIC_DROP_THRESHOLD = 0.3; // 30% liquidity drop
const PANIC_DROP_WINDOW = 10_000; // 10s window
const lastLiquidity = new Map();

// Telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// Cache: prevent scanning creator wallet too frequently
const lastCreatorScan = new Map();

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
// Big Sell Detection
// =====================================================
async function detectBigSell(mintAddress) {
  try {
    const res = await fetch(
      `https://public-api.birdeye.so/public/trades?address=${mintAddress}&offset=0&limit=10`,
      { headers: { "x-chain": "solana" } }
    );

    const text = await res.text();
    let tradesData;
    try {
        tradesData = JSON.parse(text)?.data?.items || [];
    } catch (err) {
        console.warn(`⚠️ detectBigSell fetch error for ${mintAddress}: Invalid JSON`, err.message);
        return false; // prevent crash
    }

    if (!tradesData.length) return false;

    const total = tradesData.reduce((s, t) => s + (t.amount_usd || 0), 0);
    if (!total) return false;

    const sell = tradesData.reduce((s, t) => (
      t.side === "sell" ? s + (t.amount_usd || 0) : s
    ), 0);

    return sell / total > BIG_SELL_THRESHOLD;

  } catch (err) {
    console.warn(`⚠️ detectBigSell error for ${mintAddress}: ${err.message}`);
    return false;
  }
}

// =====================================================
// Creator wallet safety
// =====================================================
async function creatorStillSafe(mintAddress) {
  const now = Date.now();

  if (lastCreatorScan.has(mintAddress) &&
      now - lastCreatorScan.get(mintAddress) < SCAN_CREATOR_INTERVAL) {
    return { safe: true };
  }

  lastCreatorScan.set(mintAddress, now);

  return await verifyCreatorSafety(mintAddress);
}

// =====================================================
// Main token position check
// =====================================================
async function checkTokenPosition(pos) {
  const { mintAddress, buyPrice, symbol, amount } = pos;
  let action = null;
  let reason = "";
  let currentPrice = buyPrice;

  try {
    const res = await fetch(
      `https://public-api.birdeye.so/public/token/${mintAddress}`,
      { headers: { "x-chain": "solana" } }
    );

    const text = await res.text();
    let token;
    try {
        token = JSON.parse(text)?.data;
    } catch (err) {
        console.warn(`⚠️ Pump.fun fetch error for ${mintAddress}: Invalid JSON`, err.message);
        return; // prevent crash
    }

    const liquidity = token?.liquidity || 0;
    currentPrice = token?.price || buyPrice;

    // -------------------- PANIC SELL --------------------
    const now = Date.now();
    const prev = lastLiquidity.get(mintAddress);

    if (prev && prev.value > 0) {
      const drop = (prev.value - liquidity) / prev.value;

      if (drop >= PANIC_DROP_THRESHOLD &&
          now - prev.timestamp <= PANIC_DROP_WINDOW) {
        action = "SELL_FULL";
        reason = `⚠️ Panic sell — liquidity dropped ${(drop * 100).toFixed(1)}% in 10s`;
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

    const bigSell = await detectBigSell(mintAddress);
    if (bigSell && !action) {
      action = "SELL_FULL";
      reason = "Large sell pressure detected";
    }

    const creatorCheck = await creatorStillSafe(mintAddress);
    if (!creatorCheck.safe && !action) {
      action = "SELL_FULL";
      reason = "Creator wallet score dropped (unsafe)";
    }

  } catch (err) {
    console.error(`⚠️ checkTokenPosition error for ${mintAddress}: ${err.message}`);
    return;
  }

  if (!action) return;

  // -------------------- EXECUTE SELL --------------------
  const profitPerc = ((currentPrice - buyPrice) / buyPrice) * 100;
  const birdeyeLink = `https://birdeye.so/token/${mintAddress}`;

  console.log(
    `🚨 SELL: ${symbol || mintAddress} — ${reason} — Profit: ${profitPerc.toFixed(2)}%`
  );

  markSellStart(mintAddress);

  await telegramAlert(
    `🚨 <b>SELL SIGNAL</b>\n` +
    `Token: <b>${symbol}</b>\n` +
    `Reason: <b>${reason}</b>\n` +
    `Profit: <b>${profitPerc.toFixed(2)}%</b>\n` +
    `📊 <a href="${birdeyeLink}">View on Birdeye</a>`
  );

  try {
    await executeAutoSell(mintAddress, amount);
    markSellComplete(mintAddress);

    await telegramAlert(
      `✅ <b>SELL COMPLETED</b>\n` +
      `Token: ${symbol}\n` +
      `Price: $${currentPrice.toFixed(4)}\n` +
      `Profit: ${profitPerc.toFixed(2)}%`
    );

  } catch (err) {
    await telegramAlert(
      `❌ Sell failed: ${symbol}\nError: ${err.message}`
    );
    console.error(`❌ Sell failed: ${err.message}`);
  }
}

// =====================================================
// Main liquidity monitor loop
// =====================================================
export async function monitorLiquidity() {
  if (!fs.existsSync(ACTIVE_POSITIONS_FILE)) return;

  let positions;
  try {
    const text = fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8");
    positions = JSON.parse(text);
  } catch (err) {
    console.warn("⚠️ Failed to read active_positions.json:", err.message);
    return;
  }

  for (const pos of positions) {
    await checkTokenPosition(pos);
  }

  if (allSellsComplete()) {
    console.log("🟢 All monitored tokens stable.");
  }
}

setInterval(monitorLiquidity, CHECK_INTERVAL);
console.log("🧠 LiquidityGuard running (15s intervals + Telegram alerts)");