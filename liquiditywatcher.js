import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import WebSocket from "ws";
import { Connection } from "@solana/web3.js";
import PQueue from "p-queue";

import { verifyTokenSecurity } from "./tokensecurities.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";
import { executeSwap, StartWatcher, StopWatcher } from "./swapexecutor.js";

dotenv.config();

// -----------------------------------------------
// CONFIG
// -----------------------------------------------
const RPC_URL = process.env.RPC_URL;
const POTENTIAL_FILE = "./potential_migrators.json";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const conn = new Connection(RPC_URL);

// Multiple Chainstack WS endpoints
const CHAINSTACK_WSS = [
  process.env.CHAINSTACK_WSS_1,
  process.env.CHAINSTACK_WSS_2,
  process.env.CHAINSTACK_WSS_3
].filter(Boolean);

// Program IDs to watch
const PROGRAM_IDS = [
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora
  "ockr9mVC3E6Y8c9wvL7jkd2ysbnZZaAa5kzuG7XzKrb"  // OCRA
];

// -----------------------------------------------
// STATE
// -----------------------------------------------
const recentlyTriggered = new Map();
let isBuying = false;
let migrators = new Set();

// Queue for RPC calls (max 20/sec)
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 20 });

// -----------------------------------------------
// Load/Write JSON safely
// -----------------------------------------------
function loadMigrators() {
  try {
    const fileData = fs.readFileSync(POTENTIAL_FILE, "utf8");
    if (!fileData.trim().startsWith("[")) throw new Error("Invalid JSON");

    const data = JSON.parse(fileData);
    migrators = new Set(data.map(x => x.mintAddress));
    console.log(`📂 Loaded ${migrators.size} migrators`);
  } catch {
    migrators = new Set();
  }
}

function saveMigrator(mintAddress) {
  try {
    const now = Date.now();
    const list = fs.existsSync(POTENTIAL_FILE)
      ? JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8"))
      : [];

    list.push({ mintAddress, detectedAt: now });
    fs.writeFileSync(POTENTIAL_FILE, JSON.stringify(list, null, 2));
    migrators.add(mintAddress);
    return now;
  } catch (err) {
    console.error("⚠️ Failed to write migrator:", err.message);
    return null;
  }
}

function removeMigrator(mintAddress) {
  try {
    const list = fs.existsSync(POTENTIAL_FILE)
      ? JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8"))
      : [];
    const updated = list.filter(m => m.mintAddress !== mintAddress);
    fs.writeFileSync(POTENTIAL_FILE, JSON.stringify(updated, null, 2));
    migrators.delete(mintAddress);
  } catch {}
}

// -----------------------------------------------
// Telegram Alert
// -----------------------------------------------
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" })
  });
}

// -----------------------------------------------
// MULTI WS CONNECTIONS
// -----------------------------------------------
function startChainstackWS() {
  CHAINSTACK_WSS.forEach((url, index) => {
    let reconnectDelay = 1000;
    const MAX_RECONNECT = 30000;

    function connect() {
      const ws = new WebSocket(url);

      ws.on("open", () => {
        console.log(`🟢 WS[${index}] connected`);
        reconnectDelay = 1000;

        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: PROGRAM_IDS }, { commitment: "confirmed" }]
        }));
      });

      ws.on("message", msg => {
        const data = JSON.parse(msg);
        const result = data.params?.result?.value;
        if (!result) return;

        const signature = result.signature;
        rpcQueue.add(async () => processTransaction(signature, index));
      });

      ws.on("close", () => {
        console.warn(`⚠️ WS[${index}] closed. Reconnecting in ${reconnectDelay/1000}s...`);
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
      });

      ws.on("error", err => {
        console.error(`❌ WS[${index}] error:`, err.message);
        ws.close();
      });
    }

    connect();
  });
}

// -----------------------------------------------
// PROCESS TRANSACTION
// -----------------------------------------------
async function processTransaction(signature, wsIndex) {
  try {
    const tx = await conn.getTransaction(signature, { commitment: "confirmed" });
    if (!tx) return;

    const post = tx.meta?.postTokenBalances || [];
    if (post.length < 1) return;

    for (const balance of post) {
      const mintAddress = balance.mint;
      if (!mintAddress || migrators.has(mintAddress)) continue;

      // Immediate write to JSON
      const detectedAt = saveMigrator(mintAddress);

      // --- 30-second liquidity freshness filter ---
      if (!detectedAt || (Date.now() - detectedAt > 30_000)) {
        migrators.delete(mintAddress);
        continue;
      }

      const lastTrigger = recentlyTriggered.get(mintAddress);
      if (lastTrigger && Date.now() - lastTrigger < 180_000) continue;
      recentlyTriggered.set(mintAddress, Date.now());

      await handleAutoBuy(mintAddress);
    }
  } catch (err) {
    console.error(`❌ WS[${wsIndex}] RPC error:`, err.message);
  }
}

// -----------------------------------------------
// HANDLE AUTO BUY LOGIC
// -----------------------------------------------
async function handleAutoBuy(mintAddress) {
  if (isBuying) return;
  isBuying = true;

  await sendTelegram(`🔍 <b>Potential Migrator Detected</b>\n<code>${mintAddress}</code>`);

  // --- Token & Creator Security ---
  let safeToken = false;
  let safeCreator = false;

  for (let i = 1; i <= 3; i++) {
    const tokenSec = await verifyTokenSecurity(mintAddress);
    if (tokenSec.safe) { safeToken = true; break; }
    await delay(4000);
  }

  for (let i = 1; i <= 3; i++) {
    const creatorSec = await verifyCreatorSafety(mintAddress);
    if (creatorSec.safe) { safeCreator = true; break; }
    await delay(4000);
  }

  if (!safeToken || !safeCreator) { isBuying = false; return; }

  // --- Price Momentum Check ---
  const price0 = await retry(() => fetchPrice(mintAddress), 3);
  await delay(60000);
  const price1 = await retry(() => fetchPrice(mintAddress), 3);

  if (!price0 || !price1 || price1 < price0 || ((price1 - price0)/price0)*100 < 12) {
    isBuying = false;
    return;
  }

  await StartWatcher();
  await executeSwap("So11111111111111111111111111111111111111112", mintAddress);
  await StopWatcher();

  removeMigrator(mintAddress);
  await sendTelegram(`✅ BOUGHT\n<code>${mintAddress}</code>`);

  isBuying = false;
}

// -----------------------------------------------
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function retry(fn, attempts) {
  for (let i = 1; i <= attempts; i++) {
    const r = await fn();
    if (r) return r;
    await delay(3000);
  }
  return null;
}

async function fetchPrice(mint) {
  try {
    const r = await fetch(`https://public-api.birdeye.so/public/price?address=${mint}`, {
      headers: { "x-chain": "solana" }
    });
    const json = await r.json();
    return json?.data?.value ?? null;
  } catch {
    return null;
  }
}

// -----------------------------------------------
// START WATCHER
// -----------------------------------------------
loadMigrators();
fs.watchFile(POTENTIAL_FILE, loadMigrators);
startChainstackWS();
console.log("🔍 Liquidity watcher started with multi-WS + security checks + 30s filter");