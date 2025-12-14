// unified_pool_registry.js
// Raydium v4 pool scanner for Solana (works with @solana/web3.js current SDK)

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
   Canonical mints
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
   Decode Raydium v4 pool
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
   Fetch all program accounts
-----------------------------------------*/
async function fetchProgramAccounts(programId) {
  const accounts = await rpcQueue.add(() =>
    conn.getProgramAccounts(programId, {
      commitment: "confirmed",
      encoding: "base64"
    })
  );
  return accounts;
}

/* ---------------------------------------
   Get vault token balances (parsed)
-----------------------------------------*/
async function getVaultBalances(vaultList) {
  const vaultPubkeys = vaultList.map(v => new PublicKey(v));
  const accounts = await rpcQueue.add(() =>
    conn.getMultipleAccountsInfo(vaultPubkeys)
  );

  const vaultMap = {};
  accounts.forEach((acc, i) => {
    const key = vaultList[i];
    if (!acc) {
      vaultMap[key] = 0;
      return;
    }
    try {
      // decode token amount using standard SPL Token layout
      const tok = acc.data.readBigUInt64LE(64);
      vaultMap[key] = Number(tok);
    } catch {
      vaultMap[key] = 0;
    }
  });
  return vaultMap;
}

/* ---------------------------------------
   Scan all Raydium pools
-----------------------------------------*/
export async function scanPools() {
  console.log("Fetching Raydium pools on-chain...");

  const accounts = await fetchProgramAccounts(PROGRAMS.RAYDIUM_AMM);
  console.log("Total accounts fetched:", accounts.length);

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
      priceSOL: null
    });

    vaultList.push(info.vaultA, info.vaultB);
  }

  // Fetch vault reserves
  const vaultMap = await getVaultBalances(vaultList);

  for (const p of pools) {
    p.reserveA = vaultMap[p.vaultA] || 0;
    p.reserveB = vaultMap[p.vaultB] || 0;
    p.amountA = p.reserveA;
    p.amountB = p.reserveB;
  }

  // Compute SOL/USD from WSOL<>USDC/USDT
  let solUsd = null;
  for (const p of pools) {
    if (p.mintA === WSOL && [USDC, USDT].includes(p.mintB))
      solUsd = p.reserveB / p.reserveA;
    else if (p.mintB === WSOL && [USDC, USDT].includes(p.mintA))
      solUsd = p.reserveA / p.reserveB;
    if (solUsd) break;
  }

  // Compute token prices for each pool
  const tokenPrices = {}; // mint => { priceUSD, priceSOL }

  for (const p of pools) {
    if (p.amountA <= 0 || p.amountB <= 0) continue;

    const priceAinB = p.amountB / p.amountA;
    const priceBinA = p.amountA / p.amountB;

    // mintA price
    let priceAUSD = null, priceASOL = null;
    if (p.mintB === WSOL) {
      priceASOL = priceAinB;
      priceAUSD = solUsd ? priceAinB * solUsd : null;
    } else if ([USDC, USDT].includes(p.mintB)) {
      priceAUSD = priceAinB;
      priceASOL = solUsd ? priceAinB / solUsd : null;
    }

    // mintB price
    let priceBUSD = null, priceBSOL = null;
    if (p.mintA === WSOL) {
      priceBSOL = priceBinA;
      priceBUSD = solUsd ? priceBinA * solUsd : null;
    } else if ([USDC, USDT].includes(p.mintA)) {
      priceBUSD = priceBinA;
      priceBSOL = solUsd ? priceBinA / solUsd : null;
    }

    // Assign generic price fields
    p.priceUSD = priceAUSD || priceBUSD || null;
    p.priceSOL = priceASOL || priceBSOL || null;

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

/* ---------------------------------------
   Compute token price (helper)
-----------------------------------------*/
export async function computePrice(mintAddress) {
  const data = await scanPools();

  // Placeholder logic (replace with actual pool selection)
  const tokenData = data.pools.find(p => p.mintA === mintAddress || p.mintB === mintAddress);

  return {
    solUsd: data.solUsd,
    blockhash: "dummy",
    pools: tokenData ? [{ ammID: tokenData.ammID, priceSOL: tokenData.priceSOL, priceUSD: tokenData.priceUSD }] : []
  };
}