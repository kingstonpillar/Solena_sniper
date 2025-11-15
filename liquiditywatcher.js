import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import WebSocket from "ws";
import { Connection } from "@solana/web3.js";
import PQueue from "p-queue";

import { verifyTokenSecurity } from "./tokensecurities.js";
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

// Program IDs
const PROGRAM_IDS = [
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",   // Raydium
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",   // Meteora
  "ockr9mVC3E6Y8c9wvL7jkd2ysbnZZaAa5kzuG7XzKrb"    // OCRA
];

// -----------------------------------------------
// STATE
// -----------------------------------------------
const recentlyTriggered = new Map(); // cooldown map
let isBuying = false;
let migrators = new Set();

// Queue for RPC calls (max 20/sec)
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 20 });

// -----------------------------------------------
// Load JSON safely
// -----------------------------------------------
function loadMigrators() {
  try {
    const fileData = fs.readFileSync(POTENTIAL_FILE, "utf8");
    if (!fileData.trim().startsWith("[")) throw new Error("Invalid JSON");

    const data = JSON.parse(fileData);
    migrators = new Set(data.map(x => x.mintAddress));
    console.log(`📂 Loaded ${migrators.size} migrators`);
  } catch (e) {
    console.error("⚠️ JSON read error, resetting migrators.");
    migrators = new Set();
  }
}

loadMigrators();
fs.watchFile(POTENTIAL_FILE, loadMigrators);

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

      ws.on("message", (msg) => {
        const data = JSON.parse(msg);
        const result = data.params?.result?.value;
        if (!result) return;

        const signature = result.signature;

        // ✅ Queue RPC calls
        rpcQueue.add(async () => {
          try {
            const tx = await conn.getTransaction(signature, { commitment: "confirmed" });
            if (!tx) return;

            const post = tx.meta?.postTokenBalances || [];
            if (post.length < 2) return;

            const mint1 = post[0].mint;
            const mint2 = post[1].mint;

            let mintAddress = null;
            if (migrators.has(mint1)) mintAddress = mint1;
            if (migrators.has(mint2)) mintAddress = mint2;
            if (!mintAddress) return;

            const lastTrigger = recentlyTriggered.get(mintAddress);
            if (lastTrigger && Date.now() - lastTrigger < 180_000) return;

            recentlyTriggered.set(mintAddress, Date.now());
            await handleAutoBuy(mintAddress);
          } catch (err) {
            console.error(`❌ WS[${index}] RPC error:`, err.message);
          }
        });
      });

      ws.on("close", () => {
        console.warn(`⚠️ WS[${index}] closed. Reconnecting in ${reconnectDelay/1000}s...`);
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
      });

      ws.on("error", (err) => {
        console.error(`❌ WS[${index}] error:`, err.message);
        ws.close();
      });
    }

    connect();
  });
}

startChainstackWS();

// -----------------------------------------------
// HANDLE AUTO BUY LOGIC
// -----------------------------------------------
async function handleAutoBuy(mintAddress) {
  if (isBuying) return;
  isBuying = true;

  await sendTelegram(`🔍 <b>Potential Migrator Detected</b>\n<code>${mintAddress}</code>`);

  let sec = null;
  for (let i = 1; i <= 3; i++) {
    sec = await verifyTokenSecurity(mintAddress);
    if (sec.safe) break;
    await delay(4000);
  }

  if (!sec || !sec.safe) {
    isBuying = false;
    return;
  }

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

  removeMintFromJson(mintAddress);
  await sendTelegram(`✅ BOUGHT\n<code>${mintAddress}</code>`);

  isBuying = false;
}

// ----------------------------------------------------
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

function removeMintFromJson(mintAddress) {
  try {
    const list = JSON.parse(fs.readFileSync(POTENTIAL_FILE, "utf8"));
    const updated = list.filter(m => m.mintAddress !== mintAddress);
    fs.writeFileSync(POTENTIAL_FILE, JSON.stringify(updated, null, 2));
    migrators.delete(mintAddress);
  } catch {}
}