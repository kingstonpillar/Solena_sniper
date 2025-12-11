// unified_pool_registry.js
// Pure Raydium v4 on-chain pool scanner (6 pools only, from .env)

import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

/* ---------------------------------------------------------
   Connection
--------------------------------------------------------- */
const RPC_URL = process.env.RPC_URL_9 || "https://api.mainnet-beta.solana.com";
export const conn = new Connection(RPC_URL, { commitment: "confirmed" });

/* ---------------------------------------------------------
   Required Raydium v4 Program
--------------------------------------------------------- */
export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")
};

// canonical mints
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gxYGpDaXJ8"; 
const USDT = "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks";
const RAY  = "4k3Dyjzvzp8eMZWUXbBCn1brfS8VQg6BhgM4j3qbKQ8P";
const BONK = "DezXAZ8z7PnrnRJjz3iTPYZPEvWKMzjCQkRMBJXn61ss";


/* ---------------------------------------------------------
   Load 6 Pool Addresses from .env
--------------------------------------------------------- */
const POOL_KEYS = [
  "POOL_SOL_USDC",
  "POOL_SOL_USDT",
  "POOL_USDC_USDT",
  "POOL_RAY_USDC",
  "POOL_RAY_SOL",
  "POOL_BONK_SOL"
];

export function loadPoolsFromEnv() {
  const pools = [];

  for (const key of POOL_KEYS) {
    const addr = process.env[key];
    if (!addr) throw new Error(`❌ Missing ${key} in .env`);
    try {
      pools.push(addr);
    } catch {
      throw new Error(`❌ Invalid pool address for ${key}: ${addr}`);
    }
  }

  return pools;
}

const SIX_POOLS = loadPoolsFromEnv();

/* ---------------------------------------------------------
   Rate limiter
--------------------------------------------------------- */
const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 8,
  concurrency: 8
});

/* ---------------------------------------------------------
   Decode Raydium v4 AMM layout
--------------------------------------------------------- */
function decodeV4(buf) {
  if (!buf || buf.length < 136) return null;

  try {
    return {
      mintA: new PublicKey(buf.slice(8, 40)).toBase58(),
      mintB: new PublicKey(buf.slice(40, 72)).toBase58(),
      vaultA: new PublicKey(buf.slice(72, 104)).toBase58(),
      vaultB: new PublicKey(buf.slice(104, 136)).toBase58()
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------
   Get SPL token vault amount
--------------------------------------------------------- */
async function getAmount(pubkey) {
  try {
    const info = await rpcQueue.add(() =>
      conn.getParsedAccountInfo(new PublicKey(pubkey))
    );

    const data = info?.value?.data?.parsed?.info?.tokenAmount;
    if (!data) return 0;

    return Number(data.uiAmount ?? data.amount ?? 0);
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------
   Main pool scanner (decode + vault balances)
--------------------------------------------------------- */
export async function scanPools(poolAddresses) {
  const output = [];

  const accounts = await rpcQueue.add(() =>
    conn.getMultipleAccountsInfo(poolAddresses.map((p) => new PublicKey(p)))
  );

  for (let i = 0; i < poolAddresses.length; i++) {
    const pk = poolAddresses[i];
    const ai = accounts[i];

    if (!ai?.data) continue;

    const dec = decodeV4(ai.data);
    if (!dec) continue;
    if (!dec.mintA || !dec.mintB) continue;

    const amountA = await getAmount(dec.vaultA);
    const amountB = await getAmount(dec.vaultB);

    if (amountA + amountB === 0) continue;

    output.push({
      pool: pk,
      ...dec,
      amountA,
      amountB
    });
  }

  return output;
}
/* ---------------------------------------------------------
   Compute prices using ONLY the 6 pools from .env
--------------------------------------------------------- */
export async function scanAllPools() {
  // 1) Load pools
  const pools = await scanPools(SIX_POOLS);

  // 2) Find SOL/USD from SOL-USDC or SOL-USDT
  let solUsd = null;

  for (const p of pools) {
    const { mintA, mintB, amountA, amountB } = p;

    // SOL / USDC
    if (mintA === WSOL && mintB === USDC) solUsd = amountB / amountA;
    if (mintB === WSOL && mintA === USDC) solUsd = amountA / amountB;

    // SOL / USDT
    if (mintA === WSOL && mintB === USDT) solUsd = amountB / amountA;
    if (mintB === WSOL && mintA === USDT) solUsd = amountA / amountB;
  }

  // 3) Compute token prices
  for (const p of pools) {
    const { mintA, mintB, amountA, amountB } = p;

    if (amountA === 0 || amountB === 0) {
      p.priceInUSD = null;
      p.priceInSOL = null;
      continue;
    }

    const priceAinB = amountB / amountA;

    // USD PRICES
    if (mintB === USDC || mintB === USDT) {
      p.priceInUSD = priceAinB;
    } else if (mintB === WSOL && solUsd) {
      p.priceInUSD = priceAinB * solUsd;
    } else {
      p.priceInUSD = null;
    }

    // SOL PRICES
    if (mintB === WSOL) {
      p.priceInSOL = priceAinB;
    } else if (p.priceInUSD && solUsd) {
      p.priceInSOL = p.priceInUSD / solUsd;
    } else {
      p.priceInSOL = null;
    }
  }

  return { pools, solUsd };
}
/* ---------------------------------------------------------
   Default export
--------------------------------------------------------- */
export default {
  PROGRAMS,
  scanPools,
  scanAllPools,
  loadPoolsFromEnv
};