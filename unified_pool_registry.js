// unified_pool_registry.js
// Pure on-chain Raydium v4 scanner — NO fallback, NO program accounts
// Uses ONLY 6 core pools (hardcoded OR .env override)
// Exports: PROGRAMS, scanPools, scanAllPools

import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.RPC_URL_9 || "https://solana-mainnet.lava.build";
const conn = new Connection(RPC_URL, { commitment: "confirmed" });

export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")
};

// canonical mints
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gwYgPDaXJ8";
const USDT = "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks";
const RAY  = "4k3Dyjzvzp8eMZWUXbBCn1brfS8VQg6BhgM4j3qbKQ8P";
const BONK = "DezXAZ8z7PnrnRJjz3iTPYZPEvWKMzjCQkRMBJXn61ss";

// six core pricing pools
const HARDCODED_POOLS = [
  WSOL, USDC,  // SOL/USDC
  WSOL, USDT,  // SOL/USDT
  USDC, USDT,  // USDC/USDT
  RAY, USDC,   // RAY/USDC
  RAY, WSOL,   // RAY/SOL
  BONK, WSOL   // BONK/SOL
];

// optional override via .env
const PAIRS = process.env.POOL_PAIRS
  ? process.env.POOL_PAIRS.split(",").map((v) => v.trim())
  : HARDCODED_POOLS;

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6, concurrency: 6 });

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

// main pool scan (no JSON)
export async function scanPools(poolAddresses) {
  const out = [];
  if (!poolAddresses.length) return out;

  const infos = await rpcQueue.add(() =>
    conn.getMultipleAccountsInfo(poolAddresses.map((x) => new PublicKey(x)))
  );

  for (let i = 0; i < poolAddresses.length; i++) {
    const pk = poolAddresses[i];
    const ai = infos[i];
    if (!ai?.data) continue;

    const dec = decodeV4(ai.data);
    if (!dec) continue;

    if (!dec.mintA || !dec.mintB) continue;

    // balances
    const amountA = await getAmount(dec.vaultA);
    const amountB = await getAmount(dec.vaultB);
    if (amountA + amountB <= 0) continue;

    out.push({
      pool: pk,
      ...dec,
      amountA,
      amountB
    });
  }

  return out;
}

// compute SOL/USD + token price
export async function scanAllPools() {
  const uniquePools = Array.from(new Set(PAIRS));

  // map mint pairs to pool addresses
  const poolKeys = [];

  for (let i = 0; i < PAIRS.length; i += 2) {
    const mintA = new PublicKey(PAIRS[i]);
    const mintB = new PublicKey(PAIRS[i + 1]);

    const seeds = [
      Buffer.from("amm_v4"),
      mintA.toBuffer(),
      mintB.toBuffer()
    ];

    const [amm] = await PublicKey.findProgramAddress(
      seeds,
      PROGRAMS.RAYDIUM_AMM
    );

    poolKeys.push(amm.toBase58());
  }

  const pools = await scanPools(poolKeys);

  // derive SOL/USD
  let solUsd = null;
  for (const p of pools) {
    if (p.mintA === WSOL && p.mintB === USDC) solUsd = p.amountB / p.amountA;
    if (p.mintB === WSOL && p.mintA === USDC) solUsd = p.amountA / p.amountB;
  }

  // compute price per pool
  for (const p of pools) {
    const priceAinB = p.amountB / p.amountA;

    if (p.mintB === USDC || p.mintB === USDT) {
      p.priceInUSD = priceAinB;
    } else if (p.mintB === WSOL && solUsd) {
      p.priceInUSD = priceAinB * solUsd;
    } else {
      p.priceInUSD = null;
    }
  }

  return { pools, solUsd };
}

export default { PROGRAMS, scanPools, scanAllPools };