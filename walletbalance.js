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
const TELEG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEG_CHAT = process.env.TELEGRAM_CHAT_ID;

const conn = new Connection(RPC_URL, "confirmed");

// === EXPORTS ===
export let currentTradeAmount = 0;
export let computeUnitPerTrade = 0;

// ============ TELEGRAM ============
export async function sendTelegram(text) {
if (!TELEG_TOKEN || !TELEG_CHAT) return;
try {
await fetch("https://api.telegram.org/bot${TELEG_TOKEN}/sendMessage", {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ chat_id: TELEG_CHAT, text, parse_mode: "Markdown" })
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

fs.writeFileSync(TRADE_FILE, JSON.stringify({}, null, 2));

const totalCU = maxEntries * computeUnitPerTx * 2;
const totalGas = maxEntries * (buyGas + sellGas);
const balAfterFees = bal - totalGas - totalCU;
const tradePerEntry = Number((balAfterFees / maxEntries).toFixed(6));

currentTradeAmount = tradePerEntry;
computeUnitPerTrade = computeUnitPerTx;

fs.writeFileSync(
TRADE_FILE,
JSON.stringify({
balanceBefore: bal.toFixed(6),
balanceAfterFees: balAfterFees.toFixed(6),
tradePerEntry,
maxEntries,
totalGas,
totalCU,
timestamp: Date.now()
}, null, 2)
);

await sendTelegram(
"📊 *New Trade Round Computed*\n\n" +
"💰 Wallet Balance: *${bal.toFixed(6)} SOL*\n" +
"⚡ Gas → Buy: ${buyGas} | Sell: ${sellGas}\n" +
"🔗 Compute Unit per TX: ${computeUnitPerTx} SOL\n\n" +
"📋 Entries: *${maxEntries}*\n" +
"🧾 Total Gas Cost: *${totalGas.toFixed(6)} SOL*\n" +
"🧾 Total CU Cost: *${totalCU.toFixed(6)} SOL*\n\n" +
"✅ Final Trade Amount per Entry: *${tradePerEntry} SOL*"
);
}

// =============== BALANCE HEARTBEAT ============
export async function sendBalanceHeartbeat() {
const bal = await getWalletBalance();

console.log("[Heartbeat] Balance: ${bal.toFixed(6)} SOL | Trade Amount: ${currentTradeAmount} SOL");

await sendTelegram(
"⏱ *30m Balance Update*\n\n" +
"💰 Wallet: *${bal.toFixed(6)} SOL*\n" +
"📖 Current Trade Amount: *${currentTradeAmount} SOL*\n" +
"🕒 Timestamp: ${new Date().toLocaleString()}"
);

fs.writeFileSync(
TRADE_FILE,
JSON.stringify({ tradeAmount: currentTradeAmount, balance: bal, timestamp: Date.now() }, null, 2)
);
}

// =============== START LOOP ============
export async function startLoop() {
console.log("Wallet balance heartbeat started (every 30 minutes)");

await sendBalanceHeartbeat(); // run once immediately
setInterval(sendBalanceHeartbeat, 30 * 60 * 1000);
}