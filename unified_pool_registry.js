// unified_pool_registry.js
// Raydium v4 pool scanner using getProgramAccountsV2 + pagination

import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

/* ---------------------------------------
   Connection
-----------------------------------------*/
const RPC_URL = process.env.RPC_URL_9 || "https://api.mainnet-beta.solana.com";
export const conn = new Connection(RPC_URL, { commitment: "confirmed" });

/* ---------------------------------------
   Raydium v4 AMM program
-----------------------------------------*/
export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")
};

/* ---------------------------------------
   Canonical mints for price
-----------------------------------------*/
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gxYGpDaXJ8";
const USDT = "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks";

/* ---------------------------------------
   Rate limiter
-----------------------------------------*/
const rpcQueue = new PQueue({
  interval: 30000,
  intervalCap: 180,
  concurrency: 6
});

/* ---------------------------------------
   Decode Raydium v4 AMM pool
-----------------------------------------*/
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

/* ---------------------------------------
   PAGINATED getProgramAccountsV2
-----------------------------------------*/
async function fetchProgramAccountsV2(programId) {
  let all = [];
  let cursor = null;

  while (true) {
    const res = await rpcQueue.add(() =>
      conn.getProgramAccountsV2({
        programId,
        cursor,
        dataSlice: null
      })
    );

    all.push(...res.value);

    if (!res.cursor) break;
    cursor = res.cursor;  // pagination continues
  }
  return all;
}

/* ---------------------------------------
   Scan all Raydium pools
-----------------------------------------*/
export async function scanPools() {
  console.log("Fetching Raydium pools via programAccountV2 + pagination...");

  const accounts = await fetchProgramAccountsV2(PROGRAMS.RAYDIUM_AMM);
  console.log("Total accounts decoded:", accounts.length);

  const pools = [];
  const vaultList = [];

  for (const acc of accounts) {
    const info = decodeV4(acc.account.data);
    if (!info) continue;

    pools.push({
      address: acc.pubkey.toBase58(),
      ammID: acc.pubkey.toBase58(),
      poolPubkey: acc.pubkey.toBase58(),
      programId: PROGRAMS.RAYDIUM_AMM.toBase58(),

      mintA: info.mintA,
      mintB: info.mintB,
      vaultA: info.vaultA,
      vaultB: info.vaultB,

      amountA: 0,
      amountB: 0,
      reserveA: 0,
      reserveB: 0,

      priceUSD: null,
      priceSOL: null,

      extraAccounts: [],
      instructionKeys: [
        acc.pubkey.toBase58(),
        info.mintA,
        info.mintB,
        info.vaultA,
        info.vaultB
      ]
    });

    vaultList.push(info.vaultA, info.vaultB);
  }

  // Batch fetch vault reserves
  const vaultAccounts = await rpcQueue.add(() =>
    conn.getMultipleAccountsInfo(vaultList.map(v => new PublicKey(v)))
  );

  const vaultMap = {};
  vaultAccounts.forEach((acc, i) => {
    const key = vaultList[i];
    if (!acc) {
      vaultMap[key] = 0;
      return;
    }
    try {
      const tok = acc.data.readBigUInt64LE(64);
      vaultMap[key] = Number(tok);
    } catch {
      vaultMap[key] = 0;
    }
  });

  // Assign vault reserves
  for (const p of pools) {
    p.reserveA = vaultMap[p.vaultA] || 0;
    p.reserveB = vaultMap[p.vaultB] || 0;
    p.amountA = p.reserveA;
    p.amountB = p.reserveB;
  }

  // Compute SOL/USD using WSOL⇄USDC/USDT
  let solUsd = null;
  for (const p of pools) {
    if (p.mintA === WSOL && [USDC, USDT].includes(p.mintB))
      solUsd = p.reserveB / p.reserveA;
    if (p.mintB === WSOL && [USDC, USDT].includes(p.mintA))
      solUsd = p.reserveA / p.reserveB;
    if (solUsd) break;
  }

  // Compute priceUSD & priceSOL for each pool
  const tokenPrices = {}; // tokenMint => { priceUSD, priceSOL }

  for (const p of pools) {
    if (p.amountA <= 0 || p.amountB <= 0) continue;

    const priceAinB = p.amountB / p.amountA;
    const priceBinA = p.amountA / p.amountB;

    // mintA price
    let priceAUSD = null;
    let priceASOL = null;

    if (p.mintB === WSOL) {
      priceASOL = priceAinB;
      priceAUSD = solUsd ? priceAinB * solUsd : null;
    } else if ([USDC, USDT].includes(p.mintB)) {
      priceAUSD = priceAinB;
      priceASOL = solUsd ? priceAinB / solUsd : null;
    }

    // mintB price
    let priceBUSD = null;
    let priceBSOL = null;

    if (p.mintA === WSOL) {
      priceBSOL = priceBinA;
      priceBUSD = solUsd ? priceBinA * solUsd : null;
    } else if ([USDC, USDT].includes(p.mintA)) {
      priceBUSD = priceBinA;
      priceBSOL = solUsd ? priceBinA / solUsd : null;
    }

    // Assign generic price fields for dexBuilders
    p.priceUSD = priceAUSD || priceBUSD || null;
    p.priceSOL = priceASOL || priceBSOL || null;

    // Collect token prices
    if (priceAUSD || priceASOL) tokenPrices[p.mintA] = { priceUSD: priceAUSD, priceSOL: priceASOL };
    if (priceBUSD || priceBSOL) tokenPrices[p.mintB] = { priceUSD: priceBUSD, priceSOL: priceBSOL };
  }

  return {
    solUsd,
    pools,
    tokenPrices,
    timestamp: Date.now()
  };
}