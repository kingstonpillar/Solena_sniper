import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";
import WebSocket from "ws";

// ----------------------------- CONFIG -----------------------------
const RPC_ENDPOINTS = [
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY_1}`,
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY_2}`,
  `https://solana-mainnet.rpc.lava.build/?api-key=${process.env.LAVA_API_KEY}`
];

const WS_ENDPOINTS = [
  `wss://api.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY_11}`,
  `wss://api.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY_21}`
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
let wsIndex = 0;
let rpcIndex = 0;
let ws = null;

// ----------------------------- RATE LIMIT -----------------------------
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6, concurrency: 6 });
const messageQueue = new PQueue({ concurrency: 1, interval: 50, intervalCap: 1 });

// ----------------------------- HELPERS -----------------------------
function nowMs() {
  return Date.now();
}

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

      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries) return null;
      await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
  }
}

// ----------------------------- RPC ACCOUNT FETCH -----------------------------
async function fetchMultipleAccountsInfo(pubkeys) {
  return Promise.all(
    pubkeys.map(pk =>
      rpcQueue.add(async () => {
        const json = await rpcFetch({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [pk.toBase58(), { encoding: "base64" }]
        });
        return json?.result?.value || null;
      })
    )
  );
}

// ----------------------------- VAULT BALANCES -----------------------------
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
    } catch {
      map[vault] = 0;
    }
  });
  return map;
}

// ----------------------------- TOKEN INFO -----------------------------
async function getTokenInfo(mint) {
  const account = await fetchMultipleAccountsInfo([mint]);
  if (!account[0]) return { name: mint, symbol: mint, decimals: 0 };
  try {
    const data = Buffer.from(account[0].data[0], "base64");
    const decimals = data.readUInt8(44);
    return { name: mint, symbol: mint, decimals };
  } catch {
    return { name: mint, symbol: mint, decimals: 0 };
  }
}

// ----------------------------- TELEGRAM ALERT -----------------------------
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });
  } catch {}
}

// ----------------------------- SAVE -----------------------------
async function savePoolsJSON(pool) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(pools, null, 2));
  console.log(`✅ Pools saved: ${pools.length}`);
  if (pool) {
    const msg = `🆕 *New Raydium LP Detected!*\n\n` +
      `Pool ID: ${pool.poolId}\n` +
      `Token A: ${pool.tokenA.symbol} (${pool.mintA})\n` +
      `Token B: ${pool.tokenB.symbol} (${pool.mintB})\n` +
      `Reserve A: ${pool.reserveA}\n` +
      `Reserve B: ${pool.reserveB}\n` +
      `Price USD: ${pool.priceUSD}`;
    await sendTelegram(msg);
  }
}

// ----------------------------- NEW LP DETECTION -----------------------------
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
  if (newMints.length === 0) return false;

  return true;
}

// ----------------------------- WEBSOCKET -----------------------------
function startWebSocket() {
  if (ws) ws.terminate();
  const WS_URL = WS_ENDPOINTS[wsIndex];
  ws = new WebSocket(WS_URL);

  ws.on("open", () => console.log(`🟢 WS connected #${wsIndex + 1}`));
  ws.on("close", () => switchWS());
  ws.on("error", () => ws.close());

  ws.on("message", async (msg) => {
    messageQueue.add(async () => {
      try {
        const data = JSON.parse(msg);
        const tx = data?.result;
        if (!tx) return;

        if (!isNewRaydiumLP(tx)) return;

        const post = tx.meta.postTokenBalances || [];
        const vaultA = post[0]?.accountIndex;
        const vaultB = post[1]?.accountIndex;
        const mintA = post[0]?.mint;
        const mintB = post[1]?.mint;
        const poolId = tx.transaction.signatures[0];

        if (pools.find(p => p.poolId === poolId)) return;

        const vaults = await getVaultBalances([vaultA, vaultB]);
        const reserveA = vaults[vaultA] || 0;
        const reserveB = vaults[vaultB] || 0;

        const tokenA = await getTokenInfo(mintA);
        const tokenB = await getTokenInfo(mintB);

        let priceSOL = null;
        if (STABLESET.has(mintB)) priceSOL = reserveB / (reserveA || 1);
        else if (STABLESET.has(mintA)) priceSOL = reserveA / (reserveB || 1));

        const pool = {
          poolId,
          programId: RAYDIUM_AMM_PROGRAM_ID,
          mintA,
          mintB,
          tokenA,
          tokenB,
          vaultA,
          vaultB,
          reserveA,
          reserveB,
          priceSOL,
          priceUSD: priceSOL,
          timestamp: nowMs()
        };

        pools.push(pool);
        await savePoolsJSON(pool);

      } catch (e) {
        console.log("WS message error:", e?.message || e);
      }
    });
  });
}

function switchWS() {
  wsIndex = (wsIndex + 1) % WS_ENDPOINTS.length;
  console.log(`🔁 Switching WS → #${wsIndex + 1}`);
  setTimeout(startWebSocket, 300);
}

// At the bottom of newRaydiumToken.js
// ----------------------------- EXPORT FOR TESTING -----------------------------

/**
 * Starts a temporary WebSocket listener and returns detected new LPs.
 * Can be called from another file.
 */
export async function testNewRaydiumLPDetection(durationMs = 5000) {
  return new Promise((resolve) => {
    const detectedPools = [];

    // Wrap your existing startWebSocket logic
    const originalSavePoolsJSON = savePoolsJSON;
    savePoolsJSON = async (pool) => {
      if (pool) detectedPools.push(pool);
      // Still save to file as usual
      await originalSavePoolsJSON(pool);
    };

    startWebSocket();

    // Stop the WS after durationMs
    setTimeout(() => {
      if (ws) ws.terminate();
      resolve(detectedPools);
    }, durationMs);
  });
}

