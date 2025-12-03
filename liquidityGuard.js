// =======================
//   LiquidityGuard.js
//   Pure On-Chain Version
// =======================

import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

import { getOnchainPrice, initJupiter } from "./jupiterOnchain.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";
import { executeAutoSell } from "./autosell.js";
import { markSellStart, markSellComplete, allSellsComplete } from "./sellmonitor.js";

dotenv.config();


// =======================
//   RPC CONNECTION + LIMIT
// =======================
const RPC_URL = process.env.RPC_URL_2 || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC_URL, "confirmed");

const rpcLimiter = new PQueue({
  intervalCap: 6,
  interval: 1000,
  carryoverConcurrencyCount: true
});

const rpc = fn => rpcLimiter.add(fn);


// =======================
//   CONSTANTS
// =======================
const ACTIVE_POSITIONS_FILE = "./active_positions.json";

const PRICE_DROP_TRIGGER = 0.35;
const PROFIT_TAKE_MULTIPLIER = 2;
const PANIC_DROP_THRESHOLD = 0.4;
const PANIC_DROP_WINDOW = 10_000;

const SCAN_CREATOR_INTERVAL = Number(process.env.SCAN_CREATOR_INTERVAL_MS || 60000);
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL_MS || 15000);

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8nQbnb3gT1k2KD7";

// telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;


// =======================
//   STATE
// =======================
const lastLiquidity = new Map();
const positionLiquidity = new Map();
const lastCreatorScan = new Map();


// =======================
//   TELEGRAM
// =======================
async function telegramAlert(text) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" })
    });
  } catch {}
}


// =======================
//   INIT JUPITER ON-CHAIN
// =======================
let jupiterReady = false;

(async () => {
  try {
    await initJupiter({ connection: conn });
    jupiterReady = true;
    console.log("✔ Jupiter on-chain initialized");
  } catch (err) {
    console.error("❌ Jupiter init failed:", err.message);
  }
})();


// =======================
//   ON-CHAIN TOKEN DECIMALS
// =======================
async function getTokenDecimals(mint) {
  const info = await rpc(() =>
    conn.getParsedAccountInfo(new PublicKey(mint))
  );

  return info.value?.data?.parsed?.info?.decimals || 0;
}


// =======================
//   ON-CHAIN PRICE
// =======================
async function fetchOnchainPrice(mintAddress) {
  if (!jupiterReady) return null;

  try {
    const decimals = await getTokenDecimals(mintAddress);
    const rawAmount = 10 ** decimals;

    const quote = await getOnchainPrice(mintAddress, USDC_MINT, rawAmount);

    if (!quote) return null;

    if (quote.price) return quote.price;

    if (quote.outAmount && quote.inAmount)
      return Number(quote.outAmount) / Number(quote.inAmount);

    return null;
  } catch (err) {
    console.error(`onchain price error for ${mintAddress}:`, err.message);
    return null;
  }
}


// =======================
//   CREATOR SAFETY
// =======================
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
    return { safe: false, error: true };
  }
}


// =======================
//   LIQUIDITY SCANNING
// =======================
async function scanLiquidity(mintAddress) {
  const largest = await rpc(() =>
    conn.getTokenLargestAccounts(new PublicKey(mintAddress))
  );

  const infos = await Promise.all(
    largest.value.map(a =>
      rpc(() => conn.getParsedAccountInfo(a.address))
    )
  );

  return infos
    .map(info => Number(info.value?.data?.parsed?.info?.tokenAmount?.uiAmount || 0))
    .reduce((a, b) => a + b, 0);
}


// =======================
//   MAIN POSITION CHECK
// =======================
async function checkTokenPosition(pos) {
  const { mintAddress, buyPrice, symbol, amount } = pos;

  let action = null;
  let reason = "";
  let currentPrice = buyPrice;

  try {
    // ----- PRICE -----
    const p = await fetchOnchainPrice(mintAddress);
    if (p) currentPrice = p;

    // ----- LIQUIDITY -----
    const liquidity = await scanLiquidity(mintAddress);

    const prev = lastLiquidity.get(mintAddress);
    const now = Date.now();

    if (prev?.value > 0) {
      const drop = (prev.value - liquidity) / prev.value;
      if (drop >= PANIC_DROP_THRESHOLD &&
          now - prev.timestamp <= PANIC_DROP_WINDOW) {
        action = "SELL_FULL";
        reason = `Fast liquidity drop ${(drop * 100).toFixed(1)}%`;
      }
    }

    lastLiquidity.set(mintAddress, { value: liquidity, timestamp: now });

    if (!action && liquidity < 30) {
      action = "SELL_FULL";
      reason = "Liquidity extremely low";
    }

    if (!action && currentPrice < buyPrice * PRICE_DROP_TRIGGER) {
      action = "SELL_FULL";
      reason = "Price rug";
    }

    if (!action && currentPrice >= buyPrice * PROFIT_TAKE_MULTIPLIER) {
      action = "SELL_FULL";
      reason = "Take profit 2x";
    }

    // ----- CREATOR -----
    const creator = await creatorStillSafe(mintAddress);
    if (!action && creator.safe === false) {
      action = "SELL_FULL";
      reason = "Creator flagged";
    }

  } catch (err) {
    console.error(`checkTokenPosition error ${mintAddress}:`, err.message);
    return;
  }


  // ===== Execute Sell =====
  if (!action) return;

  try {
    markSellStart(mintAddress);

    const profitPct = ((currentPrice - buyPrice) / buyPrice) * 100;

    await telegramAlert(
      `🚨 <b>SELL SIGNAL</b>\n` +
      `Token: <b>${symbol}</b>\n` +
      `Reason: <b>${reason}</b>\n` +
      `Profit: <b>${profitPct.toFixed(2)}%</b>`
    );

    await executeAutoSell(mintAddress, amount);

    markSellComplete(mintAddress);

    await telegramAlert(
      `✔️ <b>SELL COMPLETED</b>\nToken: ${symbol}\nProfit: ${profitPct.toFixed(2)}%`
    );

  } catch (err) {
    await telegramAlert(
      `❌ Sell failed ${symbol}\nError: ${err.message}`
    );
  }
}


// =======================
//   LOOP
// =======================
export async function monitorLiquidity() {
  if (!fs.existsSync(ACTIVE_POSITIONS_FILE)) return;

  const positions = JSON.parse(fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8"));
  if (!Array.isArray(positions)) return;

  for (const pos of positions) {
    await checkTokenPosition(pos).catch(() => {});
  }

  if (allSellsComplete()) {
    console.log("🟢 All positions stable.");
  }
}

setInterval(() => {
  monitorLiquidity().catch(err =>
    console.error(`Monitor error: ${err.message}`)
  );
}, CHECK_INTERVAL);

console.log(`🤖 LiquidityGuard running (ON-CHAIN PRICE ONLY) every ${CHECK_INTERVAL}ms`);