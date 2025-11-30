// walletbalance.js — LIVE PNL + ALERTS + DAILY SUMMARY

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";
import { allSellsComplete } from "./sellmonitor.js";

dotenv.config();

// === CONFIG ===
const RPC_URL = process.env.RPC_URL;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

const buyGas = parseFloat(process.env.BUY_GAS_FEE || "0.001");
const sellGas = parseFloat(process.env.SELL_GAS_FEE || "0.001");
const computeUnitPerTx = parseFloat(process.env.COMPUTE_UNIT_SOL || "0.001");
const maxEntries = parseInt(process.env.MAX_ENTRIES || "5");

const TRADE_FILE = "./trade_config.json";
const PNL_FILE = "./pnl_history.json";

const TELEG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEG_CHAT = process.env.TELEGRAM_CHAT_ID;

const conn = new Connection(RPC_URL, "confirmed");

// === EXPORTS ===
export let currentTradeAmount = 0;
export let computeUnitPerTrade = 0;

// === STATE ===
let lastBalance = null;
let lastTradeAmount = null;

let previousDayBalance = null;
let dailyTradeStats = {
  buys: 0,
  sells: 0,
  totalBuyVolume: 0,
  totalSellVolume: 0,
  feesPaid: 0
};

// ======================================================
// TELEGRAM
// ======================================================
export async function sendTelegram(text) {
  if (!TELEG_TOKEN || !TELEG_CHAT) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEG_CHAT,
        text,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

// ======================================================
// WALLET BALANCE
// ======================================================
export async function getWalletBalance() {
  try {
    const lamports = await conn.getBalance(new PublicKey(WALLET_ADDRESS));
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    console.log("Balance fetch fail:", err.message);
    return 0;
  }
}

// ======================================================
// DAILY TRADE STATS EXTERNAL HOOK
// ======================================================
export function recordTrade(type, amount, fee = 0) {
  if (type === "buy") {
    dailyTradeStats.buys++;
    dailyTradeStats.totalBuyVolume += amount;
  } else if (type === "sell") {
    dailyTradeStats.sells++;
    dailyTradeStats.totalSellVolume += amount;
  }
  dailyTradeStats.feesPaid += fee;
}

// ======================================================
// 🔥 RESET PNL FILE DAILY (ADDED)
// ======================================================
function resetPnlFile() {
  fs.writeFileSync(PNL_FILE, JSON.stringify({ lastBalance: 0 }, null, 2));
  console.log("PNL history reset for new day.");
}

// ======================================================
// DAILY SUMMARY
// ======================================================
async function sendDailySummary() {
  const bal = await getWalletBalance();

  if (previousDayBalance === null) {
    previousDayBalance = bal;
    return;
  }

  const pnl = bal - previousDayBalance;
  const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";

  await sendTelegram(
    `📊 *Daily Bot Summary*\n\n` +
    `💰 *Start:* ${previousDayBalance.toFixed(4)} SOL\n` +
    `💰 *Now:*   ${bal.toFixed(4)} SOL\n` +
    `${pnlEmoji} *PnL:* ${pnl.toFixed(4)} SOL\n\n` +
    `🔁 Buys: ${dailyTradeStats.buys}\n` +
    `💸 Buy Volume: ${dailyTradeStats.totalBuyVolume.toFixed(4)} SOL\n\n` +
    `📤 Sells: ${dailyTradeStats.sells}\n` +
    `💵 Sell Volume: ${dailyTradeStats.totalSellVolume.toFixed(4)} SOL\n\n` +
    `⚙️ Fees Paid: ${dailyTradeStats.feesPaid.toFixed(6)} SOL\n` +
    `🕒 ${new Date().toLocaleString()}`
  );

  previousDayBalance = bal;
  dailyTradeStats = {
    buys: 0,
    sells: 0,
    totalBuyVolume: 0,
    totalSellVolume: 0,
    feesPaid: 0
  };

  // 🔥 Clear PNL history daily (ADDED)
  resetPnlFile();
}

// ======================================================
// COMPUTE TRADE AMOUNT
// ======================================================
export async function computeTradeAmount() {
  const sold = await allSellsComplete();

  if (sold) {
    await sendTelegram(`✅ *All Sells Completed* — new trade cycle starting...`);
  }

  if (!sold) return;

  const bal = await getWalletBalance();
  if (bal <= 0) return;

  fs.writeFileSync(TRADE_FILE, JSON.stringify({}, null, 2));

  const totalCU = maxEntries * computeUnitPerTx * 2;
  const totalGas = maxEntries * (buyGas + sellGas);
  const balAfterFees = bal - totalGas - totalCU;

  const tradePerEntry = Number((balAfterFees / maxEntries).toFixed(6));

  if (lastTradeAmount !== null && tradePerEntry !== lastTradeAmount) {
    await sendTelegram(
      `🔄 *Trade Amount Updated*\n\n` +
      `Old: *${lastTradeAmount} SOL*\nNew: *${tradePerEntry} SOL*`
    );
  }

  lastTradeAmount = tradePerEntry;
  currentTradeAmount = tradePerEntry;
  computeUnitPerTrade = computeUnitPerTx;

  fs.writeFileSync(
    TRADE_FILE,
    JSON.stringify(
      {
        balanceBefore: bal.toFixed(6),
        balanceAfterFees: balAfterFees.toFixed(6),
        tradePerEntry,
        maxEntries,
        totalGas,
        totalCU,
        timestamp: Date.now()
      },
      null,
      2
    )
  );

  await sendTelegram(
    `📊 *New Trade Round Computed*\n\n` +
    `💰 Balance: *${bal.toFixed(6)} SOL*\n` +
    `🛠 Gas Total: *${totalGas.toFixed(6)} SOL*\n` +
    `🛠 CU Total: *${totalCU.toFixed(6)} SOL*\n` +
    `📋 Entries: *${maxEntries}*\n\n` +
    `✔ Trade per Entry: *${tradePerEntry} SOL*`
  );
}

// ======================================================
// LIVE PNL
// ======================================================
function savePnL(pnlObj) {
  fs.writeFileSync(PNL_FILE, JSON.stringify(pnlObj, null, 2));
}

async function computePnL(currentBalance) {
  let previous = 0;

  if (fs.existsSync(PNL_FILE)) {
    const data = JSON.parse(fs.readFileSync(PNL_FILE, "utf8"));
    previous = data.lastBalance || 0;
  }

  if (previous === 0) {
    savePnL({ lastBalance: currentBalance });
    return;
  }

  const pnl = currentBalance - previous;
  const pct = ((pnl / previous) * 100).toFixed(2);

  if (pnl !== 0) {
    await sendTelegram(
      `📈 *PnL Update*\n\n` +
      `PnL: *${pnl.toFixed(6)} SOL*\n` +
      `Percent: *${pct}%*`
    );
  }

  savePnL({ lastBalance: currentBalance });
}

// ======================================================
// BALANCE HEARTBEAT
// ======================================================
export async function sendBalanceHeartbeat() {
  const bal = await getWalletBalance();

  if (lastBalance !== null && bal < lastBalance) {
    const drop = lastBalance - bal;
    await sendTelegram(
      `⚠️ *Balance Drop Detected*\n\n` +
      `Old: *${lastBalance.toFixed(6)} SOL*\n` +
      `New: *${bal.toFixed(6)} SOL*\n` +
      `Drop: *-${drop.toFixed(6)} SOL*`
    );
  }

  await computePnL(bal);

  lastBalance = bal;

  await sendTelegram(
    `⏱ *Balance Update*\n\n` +
    `💰 Balance: *${bal.toFixed(6)} SOL*\n` +
    `📈 Trade Amount: *${currentTradeAmount} SOL*\n` +
    `🕒 ${new Date().toLocaleString()}`
  );

  fs.writeFileSync(
    TRADE_FILE,
    JSON.stringify(
      {
        tradeAmount: currentTradeAmount,
        balance: bal,
        timestamp: Date.now()
      },
      null,
      2
    )
  );
}

// ======================================================
// LOOP
// ======================================================
export async function startLoop() {
  console.log("Wallet balance heartbeat running (30 min)...");

  await sendBalanceHeartbeat();
  setInterval(sendBalanceHeartbeat, 30 * 60 * 1000);

  // Daily summary every 24h
  setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
  setTimeout(sendDailySummary, 5000); // first summary 5 sec after boot
}