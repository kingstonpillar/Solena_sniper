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

// Chainstack WS endpoints
const CHAINSTACK_WSS = [
  process.env.CHAINSTACK_WSS_1,
  process.env.CHAINSTACK_WSS_2,
  process.env.CHAINSTACK_WSS_3
].filter(Boolean);

// DEX Program IDs
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const ORCA = "9WwRZjZJY9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5";
const METEORA = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const DEX_PROGRAMS = new Set([RAYDIUM, ORCA, METEORA]);

const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "Es9vMFrzaCERv7Y1JPazrRtgdK9JGfRgzR1nEomz4Yh",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8nQbnb3gT1k2KD7",
  "DAiS39Ky47dFgfBhdREu7r48uYBBd6ihsQ8qHY7iSgj",
]);

// -----------------------------------------------
// STATE
// -----------------------------------------------
let recentlyTriggered = new Map();
let isBuying = false;
let migrators = new Set();
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 20 });

// -----------------------------------------------
// JSON helpers
// -----------------------------------------------
function loadMigrators() {
  try {
    const fileData = fs.readFileSync(POTENTIAL_FILE, "utf8");
    migrators = new Set(JSON.parse(fileData).map(x => x.mintAddress));
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
// Telegram
// -----------------------------------------------
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
  });
}

// -----------------------------------------------
// Fetch SOL price
// -----------------------------------------------
async function fetchSolPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const json = await res.json();
    return json?.solana?.usd ?? 0;
  } catch {
    return 0;
  }
}

// -----------------------------------------------
// Detect SOL-based liquidity
// -----------------------------------------------
function isSolBasedLiquidity(tx, solPrice) {
  const logs = tx.meta?.logMessages || [];
  const post = tx.meta?.postTokenBalances || [];
  if (post.length < 2) return false;

  const mints = Array.from(new Set(post.map(b => b.mint)));
  if (mints.length !== 2 || !mints.includes(WSOL)) return false;

  const nonSolMint = mints.find(m => m !== WSOL);
  if (!nonSolMint || STABLES.has(nonSolMint)) return false;

  const solBalance = post.find(b => b.mint === WSOL)?.uiTokenAmount?.ui || 0;
  if (solBalance * solPrice < 10000) return false; // min $10k liquidity

  const joined = logs.join(" ").toLowerCase();
  const raydiumHit = joined.includes("initialize") || joined.includes("amm") || joined.includes("pool") || joined.includes("mintto");
  const orcaHit = joined.includes("swap") || joined.includes("create") || joined.includes("liquidity");
  const meteoraHit = joined.includes("dlmm") || joined.includes("rebalance") || joined.includes("add_liquidity");

  if (!(raydiumHit || orcaHit || meteoraHit)) return false;

  return {
    mint: nonSolMint,
    dex: raydiumHit ? "Raydium" : orcaHit ? "Orca" : "Meteora",
    liquiditySOL: solBalance,
  };
}

// -----------------------------------------------
// Process transaction
// -----------------------------------------------
async function processTransaction(signature, wsIndex) {
  try {
    const solPrice = await fetchSolPrice();
    if (!solPrice) return;

    const tx = await conn.getTransaction(signature, { commitment: "confirmed" });
    if (!tx) return;

    const liquidityData = isSolBasedLiquidity(tx, solPrice);
    if (!liquidityData) return;

    const { mint } = liquidityData;
    if (!mint || migrators.has(mint)) return;

    const detectedAt = saveMigrator(mint);
    if (!detectedAt) return;

    // 30-second freshness window
    recentlyTriggered.set(mint, Date.now());

    await handleAutoBuy(mint);
  } catch (err) {
    console.error(`❌ WS[${wsIndex}] RPC error:`, err.message);
  }
}

// -----------------------------------------------
// Handle auto-buy
// -----------------------------------------------
async function handleAutoBuy(mintAddress) {
  if (isBuying) return;
  isBuying = true;

  await sendTelegram(`🔍 <b>Potential SOL Migrator Detected</b>\n<code>${mintAddress}</code>`);

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

  // --- Record initial price
  const price0 = await retry(() => fetchPrice(mintAddress), 3);
  if (!price0) { isBuying = false; return; }

  // --- Track until 10% price increase
  let price1 = price0;
  const startTime = Date.now();
  while ((price1 - price0)/price0*100 < 10 && Date.now() - startTime < 300000) { // 5 min max follow
    await delay(5000);
    const tempPrice = await fetchPrice(mintAddress);
    if (tempPrice) price1 = tempPrice;
  }

  if (price1/price0 - 1 < 0.10) { isBuying = false; return; }

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
// Multi-WS setup
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
          params: [{ mentions: Array.from(DEX_PROGRAMS) }, { commitment: "confirmed" }]
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
// START WATCHER
// -----------------------------------------------
loadMigrators();
fs.watchFile(POTENTIAL_FILE, loadMigrators);
startChainstackWS();
console.log("🔍 Liquidity watcher started with SOL-only, min $10k liquidity, momentum & security checks");