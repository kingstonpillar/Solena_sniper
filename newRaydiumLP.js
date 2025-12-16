import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import PQueue from "p-queue";
import { PublicKey } from "@solana/web3.js";
import "dotenv/config";

/* ============================= CONFIG ============================= */

const RPC_URLS = [
  process.env.LAVA_RPC_URL_1,
  process.env.HELIUS_RPC_URL_1,
  process.env.HELIUS_RPC_URL_2
];

const OUTPUT_FILE = path.resolve("./potential_migrators.json");

const STABLESET = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gxYGpDaXJ8",
  "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks"
]);

const RAYDIUM_AMM_PROGRAM_ID =
  "RVKd61ztZW9LhZ8k5DdENkdu2z1gQUh5k1ayk2vA1tQ";

const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/* ============================= STATE ============================= */

let rpcIndex = 0;
const rpcQueue = new PQueue({ interval: 2000, intervalCap: 6, concurrency: 6 });
const processedPoolIds = new Set();

/* ============================= HELPERS ============================= */

function nextRpc() {
  const url = RPC_URLS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  return url;
}

/* ============================= HELPERS ============================= */

async function rpcFetch(body, retries = 2) {
  // Wrap the fetch inside PQueue to respect rate limit
  return rpcQueue.add(async () => {
    for (let i = 0; i <= retries; i++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const res = await fetch(nextRpc(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        if (i === retries) return null;
        await new Promise(r => setTimeout(r, 250));
      } finally {
        clearTimeout(timeout);
      }
    }
  });
}
/* ============================= RPC ============================= */

async function getAccountInfo(pubkey) {
  const json = await rpcFetch({
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [pubkey, { encoding: "base64" }]
  });
  return json?.result?.value || null;
}

async function getSignaturesForAddress(address, limit = 1) {
  const json = await rpcFetch({
    jsonrpc: "2.0",
    id: 1,
    method: "getSignaturesForAddress",
    params: [address, { limit }]
  });
  return json?.result || [];
}

/* ============================= SECURITY ============================= */

async function isFreshMint(mintAddress, maxAgeSec = 300) {
  const sigs = await getSignaturesForAddress(mintAddress, 1);
  if (!sigs.length) return true;
  const age =
    Math.floor(Date.now() / 1000) - (sigs[0].blockTime || 0);
  return age <= maxAgeSec;
}

async function isFreshPool(poolId, minAgeSec = 30, maxAgeSec = 300) {
  if (process.env.TEST_MODE === "true") {
    console.log("[TEST_MODE] Skipping pool age check");
    return true;
  }

  const sigs = await getSignaturesForAddress(poolId, 1);
  if (!sigs.length || !sigs[0].blockTime) return false;

  const age = Math.floor(Date.now() / 1000) - sigs[0].blockTime;
  return age >= minAgeSec && age <= maxAgeSec;
}

async function verifyRaydiumAmmLayout(poolId, vaultA, vaultB) {
  const info = await getAccountInfo(poolId);
  if (!info || info.owner !== RAYDIUM_AMM_PROGRAM_ID) return false;

  const data = Buffer.from(info.data[0], "base64");
  if (data.length < 624) return false;

  const status = Number(data.readBigUInt64LE(0));
  if (status !== 1) return false;

  const coinVault = new PublicKey(data.slice(72, 104)).toBase58();
  const pcVault = new PublicKey(data.slice(104, 136)).toBase58();

  return (
    (coinVault === vaultA && pcVault === vaultB) ||
    (coinVault === vaultB && pcVault === vaultA)
  );
}

function passesLiquidityGuard(mintB, reserveB) {
  if (mintB === "So11111111111111111111111111111111111111112") {
    return reserveB >= 1_000_000_000;
  }
  return reserveB >= 500_000_000;
}

/* ============================= TOKEN ============================= */

async function getVaultBalance(vault) {
  const info = await getAccountInfo(vault);
  if (!info || info.owner !== TOKEN_PROGRAM_ID) return 0;
  const buf = Buffer.from(info.data[0], "base64");
  return Number(buf.readBigUInt64LE(64));
}



/* ============================= CORE ============================= */

async function processNewLP(poolId, mintAddress, mintB, vaultA, vaultB) {
  if (processedPoolIds.has(poolId)) return;
  processedPoolIds.add(poolId);

  // Pool age guard
  if (!(await isFreshPool(poolId, 30, 300))) return;

  // Mint age guard
  if (!(await isFreshMint(mintAddress, 300))) return;

  if (!(await verifyRaydiumAmmLayout(poolId, vaultA, vaultB))) return;

  const reserveA = await getVaultBalance(vaultA);
  const reserveB = await getVaultBalance(vaultB);

  if (!passesLiquidityGuard(mintB, reserveB)) return;

  const priceSOL = STABLESET.has(mintB)
    ? reserveB / (reserveA || 1)
    : null;

  const pool = {
    poolId,
    mintAddress,
    mintB,
    vaultA,
    vaultB,
    reserveA,
    reserveB,
    priceSOL,
    priceUSD: priceSOL
  };

  appendToOutput(pool); // ✅ call the append + Telegram function
}

/* ============================= APPEND & TELEGRAM ============================= */
/* ============================= APPEND & TELEGRAM ============================= */

function appendToOutput(pool) {
  let data = [];

  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8")) || [];
    } catch {
      data = [];
    }
  }

  // Prevent duplicate poolId writes
  if (data.some(p => p.poolId === pool.poolId)) return;

  data.push(pool);

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  //  Telegram call MUST be inside the function
  sendTelegramAlert(pool);
}


/* ============================= TELEGRAM ============================= */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Your bot token
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;   // Your chat ID

async function sendTelegramAlert(pool) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const text = `🆕 New LP Detected!\n\n` +
               `Mint: ${pool.mintAddress}\n` +
               `Pair: ${pool.mintB}\n` +
               `ReserveA: ${pool.reserveA}\n` +
               `ReserveB: ${pool.reserveB}\n` +
               `PriceSOL: ${pool.priceSOL}\n` +
               `PriceUSD: ${pool.priceUSD}`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
  } catch (err) {
    console.error("Telegram alert failed:", err);
  }
}
/* ============================= MAIN ============================= */

async function main() {
  const candidateLPs = process.env.TEST_MODE === "true"
  ? [
      {
        poolId: "8HoQnePLqPj4M7PUDzfw8e3Ymdwgc7NLGnaTUapubyvu",
        mintAddress: "So11111111111111111111111111111111111111112",
        mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gxYGpDaXJ8",
        vaultA: "So11111111111111111111111111111111111111112",
        vaultB: "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gxYGpDaXJ8"
      }
    ]
  : [
      // ORIGINAL CANDIDATE POOLS (or leave empty if dynamic)
    ];

  for (const lp of candidateLPs) {
    if (!(await isFreshMint(lp.mintAddress))) continue;
    await processNewLP(
      lp.poolId,
      lp.mintAddress,
      lp.mintB,
      lp.vaultA,
      lp.vaultB
    );
  }
}

main();