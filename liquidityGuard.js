// liquidityGuard.js (fixed: template strings + creator-scan error policy)
import fs from "fs";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import PQueue from "p-queue";

import { markSellStart, markSellComplete, allSellsComplete } from "./sellmonitor.js";
import { executeAutoSell } from "./autosell.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";

dotenv.config();

// ------------------- RPC -------------------
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC_URL);

// ------------------- Files / Constants -------------------
const ACTIVE_POSITIONS_FILE = "./active_positions.json";

const PRICE_DROP_TRIGGER = 0.35;
const PROFIT_TAKE_MULTIPLIER = 2;
const BIG_SELL_THRESHOLD = 0.35;
const PANIC_DROP_THRESHOLD = 0.4;
const PANIC_DROP_WINDOW = 10_000;

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL_MS || 15000);
const SCAN_CREATOR_INTERVAL = Number(process.env.SCAN_CREATOR_INTERVAL_MS || 60000);

// Telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// ------------------- Caching -------------------
const lastCreatorScan = new Map();
const lastLiquidity = new Map();
const positionLiquidity = new Map();

// ------------------- GLOBAL JUPITER QUEUE -------------------
export const jupiterQueue = new PQueue({
  intervalCap: 2, // 2 requests/sec, adjust as needed
  interval: 1000,
  carryoverConcurrencyCount: true
});

// ------------------- Utilities -------------------
async function safeJsonFetch(url, { retries = 1, timeout = 5000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) return null;

      const txt = await res.text();
      return JSON.parse(txt);

    } catch (err) {
      clearTimeout(id);
      if (attempt < retries) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      else return null;
    }

  }
  return null;
}

async function jupiterFetch(url, opts = {}) {
  return jupiterQueue.add(async () => safeJsonFetch(url, opts));
}

function safeReadJsonFile(path) {
  try {
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function telegramAlert(text) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        parse_mode: "HTML"
      })
    });
  } catch {}
}

// ------------------- Big Sell Detection -------------------
async function detectBigSell(mintAddress) {
  try {
    const tradeData = await jupiterFetch(
      `https://price.jup.ag/v6/swap?ids=${mintAddress}&limit=10`
    );
    const trades = tradeData?.data || [];
    const total = trades.reduce((s, t) => s + (t.amount_usd || 0), 0);
    if (!total) return false;

    const sell = trades
      .filter(t => t.side === "sell")
      .reduce((s, t) => s + (t.amount_usd || 0), 0);

    return sell / total > BIG_SELL_THRESHOLD;

  } catch {
    return false;
  }
}

// ------------------- Creator Safety -------------------
async function creatorStillSafe(mintAddress) {
  const now = Date.now();

  if (lastCreatorScan.has(mintAddress) &&
    now - lastCreatorScan.get(mintAddress) < SCAN_CREATOR_INTERVAL) {
    return { safe: true };
  }

  lastCreatorScan.set(mintAddress, now);

  try {
    return await verifyCreatorSafety(mintAddress);
  } catch (err) {
    // IMPORTANT: treat scanner failures conservatively as *unsafe*
    // so we don't skip selling when the scanner is down or errors.
    console.error(`Creator scanner error for ${mintAddress}: ${err?.message || err}`);
    return { safe: false, error: true, reason: "scanner_error" };
  }
}

// ------------------- Dynamic Liquidity Tracking -------------------
async function updateLiquidityReference(mintAddress, currentLiquidity) {
  const record = positionLiquidity.get(mintAddress) || {
    boughtLiquidity: currentLiquidity,
    highestLiquidity: currentLiquidity
  };

  record.highestLiquidity = Math.max(record.highestLiquidity, currentLiquidity);
  positionLiquidity.set(mintAddress, record);
  return record;
}

// ------------------- Single Position Checker -------------------
async function checkTokenPosition(pos) {
  const { mintAddress, buyPrice, symbol, amount } = pos;

  let action = null;
  let reason = "";
  let currentPrice = buyPrice;
  const reasons = [];

  try {
    // Jupiter price fetch
    const jupData = await jupiterFetch(`https://price.jup.ag/v4/price?ids=${mintAddress}`);
    currentPrice = jupData?.[mintAddress]?.price || buyPrice;

    // On-chain liquidity check
    const largestAccounts = await conn.getTokenLargestAccounts(new PublicKey(mintAddress));
    const accountInfos = await Promise.all(
      largestAccounts.value.map(a => conn.getParsedAccountInfo(a.address))
    );
    const tokenAccounts = accountInfos.map(info => ({
      owner: info.value?.data?.parsed?.info?.owner,
      amount: info.value?.data?.parsed?.info?.tokenAmount?.ui || 0
    })).sort((a, b) => b.amount - a.amount);

    const holders = tokenAccounts.filter(a => a.amount > 0).length;
    const totalLiquidity = tokenAccounts.reduce((sum, a) => sum + a.amount, 0);

    const owner = tokenAccounts[0]?.owner;

    if (totalLiquidity < 30) {
      // Previously this returned early and prevented sells on low LP.
      // Now treat very low LP as an emergency sell condition.
      reasons.push("🔥 LP too low — token fails security");
      action = "SELL_FULL";
      reason = "Liquidity too low — emergency exit";
    }

    const { highestLiquidity } = await updateLiquidityReference(
      mintAddress,
      totalLiquidity
    );

    // ------------------- PANIC LIQUIDITY DROP -------------------
    const prev = lastLiquidity.get(mintAddress);
    const now = Date.now();

    if (prev?.value > 0) {
      const drop = (prev.value - totalLiquidity) / prev.value;

      if (drop >= PANIC_DROP_THRESHOLD && (now - prev.timestamp) <= PANIC_DROP_WINDOW) {
        action = "SELL_FULL";
        reason = `⚠️ Liquidity dropped ${(drop * 100).toFixed(1)}% in ${PANIC_DROP_WINDOW/1000}s`;
      }
    }

    lastLiquidity.set(mintAddress, { value: totalLiquidity, timestamp: now });

    // ------------------- STANDARD PRICE RULES -------------------
    if (!action && currentPrice < buyPrice * PRICE_DROP_TRIGGER) {
      action = "SELL_FULL";
      reason = "Price rug detected";
    }

    if (!action && currentPrice >= buyPrice * PROFIT_TAKE_MULTIPLIER) {
      action = "SELL_FULL";
      reason = "Reached 2× take profit";
    }

    // ------------------- BIG SELL PRESSURE -------------------
    const bigSell = await detectBigSell(mintAddress);
    if (!action && bigSell) {
      action = "SELL_FULL";
      reason = "Large sell pressure detected";
    }

    // ------------------- CREATOR SAFETY -------------------
    const creatorCheck = await creatorStillSafe(mintAddress);
    if (!action && creatorCheck?.safe === false) {
      action = "SELL_FULL";
      reason = "Creator wallet score dropped (unsafe)";
    }

  } catch (err) {
    console.error(`⚠️ checkTokenPosition error for ${mintAddress}: ${err?.message || err}`);
    return;
  }

  if (!action) return;

  // ------------------- Execute Sell -------------------
  try {
    const profitPerc = ((currentPrice - buyPrice) / buyPrice) * 100;
    const link = `https://jup.ag/token/${mintAddress}`;

    console.log(`🚨 SELL: ${symbol || mintAddress} — ${reason} — Profit: ${profitPerc.toFixed(2)}%`);

    markSellStart(mintAddress);

    await telegramAlert(
      `🚨 <b>SELL SIGNAL</b>\n` +
      `Token: <b>${symbol}</b>\n` +
      `Reason: <b>${reason}</b>\n` +
      `Profit: <b>${profitPerc.toFixed(2)}%</b>\n` +
      `📊 <a href="${link}">View on Jupiter</a>`
    );

    await executeAutoSell(mintAddress, amount);
    markSellComplete(mintAddress);

    await telegramAlert(
      `✅ <b>SELL COMPLETED</b>\n` +
      `Token: ${symbol}\n` +
      `Price: $${Number(currentPrice).toFixed(4)}\n` +
      `Profit: ${profitPerc.toFixed(2)}%`
    );

    positionLiquidity.delete(mintAddress);

  } catch (err) {
    await telegramAlert(`❌ Sell failed: ${symbol}\nError: ${err?.message}`);
    console.error(`❌ Sell failed for ${mintAddress}: ${err?.message}`);
  }
}

// ------------------- Main Loop -------------------
export async function monitorLiquidity() {
  try {
    if (!fs.existsSync(ACTIVE_POSITIONS_FILE)) return;

    const positions = safeReadJsonFile(ACTIVE_POSITIONS_FILE);
    if (!Array.isArray(positions)) return;

    for (const pos of positions) {
      try {
        await checkTokenPosition(pos);
      } catch (e) { /* ignore per-position errors */ }
    }

    if (allSellsComplete()) {
      console.log("🟢 All monitored tokens stable.");
    }

  } catch (err) {
    console.error(`❌ monitorLiquidity top-level error: ${err?.message}`);
  }
}

// ------------------- Start Interval -------------------
setInterval(() => {
  monitorLiquidity().catch(err =>
    console.error(`❌ monitorLiquidity uncaught error: ${err?.message}`)
  );
}, CHECK_INTERVAL);

console.log(`🧠 LiquidityGuard running (${CHECK_INTERVAL}ms intervals, Jupiter rate-limited).`);