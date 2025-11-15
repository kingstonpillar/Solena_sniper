// walletbalance.js
// Computes the true trade amount AFTER deducting:
// Buy gas, Sell gas, Compute unit (Buy + Sell)
// Slippage is applied only during execution in autosell.js
// Exports: currentTradeAmount + computeUnitPerTrade

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

const computeUnitPerTx = parseFloat(process.env.COMPUTE_UNIT_SOL || "0.001"); // applied to buy + sell
const maxEntries = parseInt(process.env.MAX_ENTRIES || "5");

const TRADE_FILE = "./trade_config.json";
const TELEG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEG_CHAT = process.env.TELEGRAM_CHAT_ID;

const conn = new Connection(RPC_URL, "confirmed");

// ============ EXPORTS ==============
export let currentTradeAmount = 0;
export let computeUnitPerTrade = computeUnitPerTx; // SWAP EXECUTOR WILL USE THIS

// ============ TELEGRAM =============
async function sendTelegram(text) {
  if (!TELEG_TOKEN || !TELEG_CHAT) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEG_CHAT,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

// ============ WALLET BALANCE ============
export async function getWalletBalance() {
  try {
    const lamports = await conn.getBalance(new PublicKey(WALLET_ADDRESS));
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    console.log("Balance fetch fail:", err.message);
    return 0;
  }
}

// ============ MAIN TRADE COMPUTATION ============
export async function computeTradeAmount() {
  const sold = await allSellsComplete();
  if (!sold) return;

  const bal = await getWalletBalance();
  if (bal <= 0) return;

  fs.writeFileSync(TRADE_FILE, JSON.stringify({}, null, 2)); // reset old config

  // ---- TOTAL COMPUTE UNIT COST ----
  // Each entry performs: BUY + SELL = 2 compute-unit calls
  const totalCU = maxEntries * computeUnitPerTx * 2;

  // ---- TOTAL GAS ----
  const totalGas = maxEntries * (buyGas + sellGas);

  // ---- BALANCE AFTER FEES ONLY ----
  const balAfterFees = bal - totalGas - totalCU;

  // ---- PER TRADE AMOUNT ----
  const tradePerEntry = Number((balAfterFees / maxEntries).toFixed(6));

  currentTradeAmount = tradePerEntry; // exported for swap executor
  computeUnitPerTrade = computeUnitPerTx;

  // SAVE to file
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
        timestamp: Date.now(),
      },
      null,
      2
    )
  );

  // Notify telegram
  await sendTelegram(
    `📊 *New Trade Round Computed*\n\n` +
      `💰 Wallet Balance: *${bal.toFixed(6)} SOL*\n` +
      `⚡ Gas → Buy: ${buyGas} | Sell: ${sellGas}\n` +
      `💻 Compute Unit per TX: ${computeUnitPerTx} SOL\n\n` +
      `📝 Entries: *${maxEntries}*\n` +
      `🧾 Total Gas Cost: *${totalGas.toFixed(6)} SOL*\n` +
      `🧾 Total CU Cost: *${totalCU.toFixed(6)} SOL*\n\n` +
      `✅ Final Trade Amount per Entry: *${tradePerEntry} SOL*`
  );
}