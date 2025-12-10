// =======================
//   LiquidityGuard.js
//   Pure On-Chain Version
// =======================

import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

// ---- Your Modules (NO Jupiter SDK links) ----
import { scanMintFast } from "./priceScanner.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";
import { executeAutoSell } from "./autosell.js";
import { markSellStart, markSellComplete, allSellsComplete } from "./sellmonitor.js";

dotenv.config();


// =======================
//   RPC CONNECTION + LIMIT
// =======================
const RPC_URL = process.env.RPC_URL_2;
if (!RPC_URL) throw new Error("RPC_URL_2 missing");

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
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL_MS || 10000);

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8nQbnb3gT1k2KD7";

// telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;


// =======================
//   STATE
// =======================
const lastLiquidity = new Map();
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
//   TOKEN DECIMALS

// =======================
async function getTokenDecimals(mint) {
  const info = await rpc(() =>
    conn.getParsedAccountInfo(new PublicKey(mint))
  );

  return info?.value?.data?.parsed?.info?.decimals ?? 0;
}

// =======================
//   ONCHAIN PRICE WRAPPER
// =======================
/**
 * Fetch on-chain price for a token
 * Returns both SOL and USD prices
 *
 * @param {string} mintAddress - token mint
 * @param {Array} pools - array of known pools for scanMintFast
 * @param {number|null} solUsd - current SOL price in USD
 */
async function fetchOnchainPrice(mintAddress, pools = [], solUsd = null) {
  try {
    // 1️⃣ Get decimals first
    const decimals = await getTokenDecimals(mintAddress);

    // 2️⃣ Scan using priceScanner
    const result = await scanMintFast(mintAddress, pools, solUsd);

    if (!result || !result.found) {
      return { priceSOL: null, priceUSD: null, decimals };
    }

    // 3️⃣ Compute price in SOL
    let priceSOL = null;
    if (result.quoteMint === "So11111111111111111111111111111111111111112") {
      priceSOL = result.price;
    } else if (result.priceUSD && solUsd) {
      priceSOL = result.priceUSD / solUsd;
    }

    // 4️⃣ Compute price in USD
    let priceUSD = null;
    if (result.quoteMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gT1k2KD7" || result.quoteMint === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") {
      priceUSD = result.price;
    } else if (result.quoteMint === "So11111111111111111111111111111111111111112" && solUsd) {
      priceUSD = result.price * solUsd;
    }

    return {
      priceSOL,
      priceUSD,
      decimals
    };
  } catch (err) {
    console.error(`scanMintFast price error for ${mintAddress}:`, err?.message || err);
    return { priceSOL: null, priceUSD: null, decimals: null };
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
    .map(info =>
      Number(info.value?.data?.parsed?.info?.tokenAmount?.uiAmount || 0)
    )
    .reduce((a, b) => a + b, 0);
}


// =======================
//   MAIN CHECK
// =======================
async function checkTokenPosition(pos) {
  const { mintAddress, buyPrice, symbol, amount } = pos;

  let currentPrice = buyPrice;
  let action = null;
  let reason = "";

  try {
    // Fetch latest price in SOL and USD
    const { priceSOL, priceUSD } = await fetchOnchainPrice(mintAddress);

    if (priceSOL != null) currentPrice = priceSOL;

    // Fetch liquidity
    const liquidity = await scanLiquidity(mintAddress);
    const prev = lastLiquidity.get(mintAddress);
    const now = Date.now();

    // Check fast liquidity drop
    if (prev?.value > 0) {
      const drop = (prev.value - liquidity) / prev.value;
      if (drop >= PANIC_DROP_THRESHOLD &&
          now - prev.timestamp <= PANIC_DROP_WINDOW) {
        action = "SELL_FULL";
        reason = `Fast liquidity drop ${ (drop * 100).toFixed(1) }%`;
      }
    }

    lastLiquidity.set(mintAddress, { value: liquidity, timestamp: now });

    // Low liquidity check
    if (!action && liquidity < 30) {
      action = "SELL_FULL";
      reason = "Low liquidity";
    }

    // Price rug / profit take
    if (!action && currentPrice < buyPrice * PRICE_DROP_TRIGGER) {
      action = "SELL_FULL";
      reason = "Price rug detected";
    }

    if (!action && currentPrice >= buyPrice * PROFIT_TAKE_MULTIPLIER) {
      action = "SELL_FULL";
      reason = "Take profit";
    }

    // Creator safety
    const creator = await creatorStillSafe(mintAddress);
    if (!action && creator.safe === false) {
      action = "SELL_FULL";
      reason = "Creator flagged";
    }

  } catch (err) {
    console.error(`checkTokenPosition ${mintAddress}:`, err.message);
    return;
  }

  if (!action) return;

  // SELL EXECUTION
  try {
    markSellStart(mintAddress);

    const profitPct = ((currentPrice - buyPrice) / buyPrice) * 100;

    await telegramAlert(
      `🚨 SELL SIGNAL\nToken: ${symbol}\nReason: ${reason}\nProfit: ${profitPct.toFixed(2)}%`
    );

    await executeAutoSell(mintAddress, amount);

    markSellComplete(mintAddress);

    await telegramAlert(
      `✔ Sell Completed\nToken: ${symbol}\nProfit: ${profitPct.toFixed(2)}%`
    );

  } catch (err) {
    await telegramAlert(`❌ Sell failed ${symbol}\n${err.message}`);
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

  if (await allSellsComplete()) {
    console.log("🟢 All positions stable.");
  }
}


setInterval(() => {
  monitorLiquidity().catch(err =>
    console.error(`Monitor error: ${err.message}`)
  );
}, CHECK_INTERVAL);

console.log(`🤖 LiquidityGuard running every ${CHECK_INTERVAL}ms`);