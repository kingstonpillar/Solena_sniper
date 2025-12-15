import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import PQueue from "p-queue";
import WebSocket from "ws";
import { Connection, PublicKey } from "@solana/web3.js";

// ----------------------------- CONFIG -----------------------------
const RPC_ENDPOINTS = [
  process.env.LAVA_RPC_URL_1,     // Lava first
  process.env.HELIUS_RPC_URL_1,   // Helius next
  process.env.HELIUS_RPC_URL_2    // Helius last
];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const OUTPUT_FILE = path.resolve("./potential_migrators.json");

const STABLESET = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gxYGpDaXJ8", // USDC
  "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks" // USDT
]);

const RAYDIUM_AMM_PROGRAM_ID =
  "RVKd61ztZW9LhZ8k5DdENkdu2z1gQUh5k1ayk2vA1tQ";

// ----------------------------- STATE -----------------------------
let pools = [];
let rpcIndex = 0;
let ws = null;

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6, concurrency: 6 });
const messageQueue = new PQueue({ concurrency: 1, interval: 50, intervalCap: 1 });

// ----------------------------- HELPERS -----------------------------
function nowMs() { return Date.now(); }
function nextRpc() {
  const url = RPC_ENDPOINTS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPC_ENDPOINTS.length;
  return url;
}
async function rpcFetch(body, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const RPC_URL = nextRpc();
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeout: 8000
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 300)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries) return null;
      await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
  }
}
async function fetchMultipleAccountsInfo(pubkeys) {
  return Promise.all(
    pubkeys.map(pk => rpcQueue.add(async () => {
      const json = await rpcFetch({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [pk.toBase58(), { encoding: "base64" }]
      });
      return json?.result?.value || null;
    }))
  );
}

// ----------------------------- FRESH MINT CHECK -----------------------------
async function isFreshMint(mint, maxAgeSec = 300) {
  try {
    if (!mint) return false;
    const connection = new Connection(RPC_ENDPOINTS[0], "confirmed");
    const pubkey = new PublicKey(mint);
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 1 });
    if (!signatures || signatures.length === 0) return true; // treat as fresh
    const firstTx = signatures[0];
    const txTime = firstTx.blockTime || 0;
    const ageSec = Math.floor(Date.now() / 1000) - txTime;
    return ageSec <= maxAgeSec;
  } catch (err) {
    console.log("isFreshMint error:", err?.message || err);
    return false;
  }
}

// ----------------------------- VAULT & TOKEN INFO -----------------------------
async function getVaultBalances(vaultList) {
  const vaultPubkeys = vaultList.map(v => new PublicKey(v));
  const accounts = await fetchMultipleAccountsInfo(vaultPubkeys);
  const map = {};
  accounts.forEach((acc, i) => {
    const vault = vaultList[i];
    if (!acc) { map[vault] = 0; return; }
    try {
      const buf = Buffer.from(acc.data[0], "base64");
      map[vault] = Number(buf.readBigUInt64LE(64));
    } catch { map[vault] = 0; }
  });
  return map;
}
async function getTokenInfo(mint) {
  const account = await fetchMultipleAccountsInfo([mint]);
  if (!account[0]) return { name: mint, symbol: mint, decimals: 0 };
  try {
    const data = Buffer.from(account[0].data[0], "base64");
    const decimals = data.readUInt8(44);
    return { name: mint, symbol: mint, decimals };
  } catch { return { name: mint, symbol: mint, decimals: 0 }; }
}

// ----------------------------- TELEGRAM -----------------------------
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" })
    });
  } catch {}
}

// ----------------------------- SAVE -----------------------------
async function savePoolsJSON(pool) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(pools, null, 2));
  console.log(`✅ Pools saved: ${pools.length}`);
  if (pool) {
    const msg = `🆕 *New Raydium LP Detected!*\n\n` +
      `Pool ID: ${pool.poolId}\nToken A: ${pool.tokenA.symbol} (${pool.mintA})\n` +
      `Token B: ${pool.tokenB.symbol} (${pool.mintB})\nReserve A: ${pool.reserveA}\n` +
      `Reserve B: ${pool.reserveB}\nPrice USD: ${pool.priceUSD}`;
    await sendTelegram(msg);
  }
}

// ----------------------------- LP DETECTION -----------------------------
function isNewRaydiumLP(tx) {
  const meta = tx.meta;
  if (!tx.transaction?.message?.instructions || !meta) return false;
  const ix = tx.transaction.message.instructions.find(i =>
    tx.transaction.message.accountKeys[i.programIdIndex] === RAYDIUM_AMM_PROGRAM_ID
  );
  if (!ix) return false;
  const preMints = new Set((meta.preTokenBalances || []).map(b => b.mint));
  const postMints = new Set((meta.postTokenBalances || []).map(b => b.mint));
  const newMints = [...postMints].filter(m => !preMints.has(m));
  return newMints.length > 0;
}

// ----------------------------- WEBSOCKET -----------------------------
function startWebSocket() {
  if (ws) { try { ws.terminate(); } catch {} }

  const WS_URL = process.env.HELIUS_WS_1;
  ws = new WebSocket(WS_URL);

  ws.on("open", () => console.log("🟢 WS connected (Raydium LP monitor)"));
  ws.on("close", () => console.log("🔴 WS closed. Manual restart required."));
  ws.on("error", (err) => console.log("🔴 WS error:", err?.message || err));

  ws.on("message", async (msg) => {
    messageQueue.add(async () => {
      try {
        const data = JSON.parse(msg);
        const tx = data?.result;
        if (!tx) return;
        if (!isNewRaydiumLP(tx)) return;

        const post = tx.meta?.postTokenBalances || [];
        if (post.length < 2) return;

        const mintA = post[0]?.mint; // new token
        const mintB = post[1]?.mint; // stable
        if (!mintA || !mintB || !STABLESET.has(mintB)) return;

        const poolId = tx.transaction.signatures[0];
        if (pools.find(p => p.poolId === poolId)) return;

        const isFresh = await isFreshMint(mintA, 300); // 5 minutes
        if (!isFresh) return;

        const vaultA = post[0].accountIndex;
        const vaultB = post[1].accountIndex;
        const vaults = await getVaultBalances([vaultA, vaultB]);
        const reserveA = vaults[vaultA] || 0;
        const reserveB = vaults[vaultB] || 0;

        const tokenA = await getTokenInfo(mintA);
        const tokenB = await getTokenInfo(mintB);

        const priceSOL = reserveB / (reserveA || 1);

        const pool = { poolId, programId: RAYDIUM_AMM_PROGRAM_ID, mintA, mintB,
          tokenA, tokenB, vaultA, vaultB, reserveA, reserveB, priceSOL, priceUSD: priceSOL,
          timestamp: nowMs()
        };

        pools.push(pool);
        await savePoolsJSON(pool);
        console.log("🆕 REAL NEW RAYDIUM LP detected:", mintA, "/", mintB);
      } catch (e) { console.log("WS message error:", e?.message || e); }
    });
  });
}

// ----------------------------- EXPORT TEST FUNCTION -----------------------------
/**
 * Temporarily starts the WebSocket listener and returns detected new Raydium LPs.
 * @param {number} durationMs - How long to listen for new LPs (default 5000ms = 5s)
 * @returns {Promise<Array>} - Array of detected LP objects
 */
export async function testNewRaydiumLP(durationMs = 5000) {
  return new Promise((resolve) => {
    const detectedPools = [];

    // Wrap savePoolsJSON to capture detected pools
    const originalSavePoolsJSON = savePoolsJSON;
    savePoolsJSON = async (pool) => {
      if (pool) detectedPools.push(pool);
      await originalSavePoolsJSON(pool);
    };

    // Start WebSocket
    startWebSocket();

    // Stop after duration
    setTimeout(() => {
      if (ws) ws.terminate();
      resolve(detectedPools);
    }, durationMs);
  });
}

export { startWebSocket, pools, isFreshMint };