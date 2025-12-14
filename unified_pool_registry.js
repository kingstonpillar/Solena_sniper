// unified_pool_registry.js
// Raydium v4 pool scanner for Solana using Helius getProgramAccountsV2

import { PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

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
const rpcQueue = new PQueue({ interval: 30000, intervalCap: 180, concurrency: 6 });

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
   PAGINATED Helius getProgramAccountsV2
-----------------------------------------*/
async function fetchProgramAccounts(programId) {
  let allAccounts = [];
  let cursor = null;

  console.log("Fetching program accounts via Helius getProgramAccountsV2...");

  while (true) {
    const res = await rpcQueue.add(() => fetchProgramAccountsV2HeliusRPC(programId, cursor));

    if (!res?.value?.length) break;

    allAccounts.push(...res.value);

    if (!res.cursor) break;
    cursor = res.cursor;

    console.log(`Fetched ${allAccounts.length} accounts so far...`);
  }

  console.log(`✅ Total program accounts fetched: ${allAccounts.length}`);
  return allAccounts;
}

// Low-level Helius RPC call
async function fetchProgramAccountsV2HeliusRPC(programId, cursor = null) {
  const RPC_URL = process.env.HELIUS_RPC_URL;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccountsV2",
    params: [
      programId.toBase58(),
      {
        cursor,
        commitment: "confirmed",
        dataSlice: null
      }
    ]
  };

  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = await response.json();
  return json.result; // { value: [...], cursor: ... }
}

/* ---------------------------------------
   Get vault token balances (parsed)
-----------------------------------------*/
async function getVaultBalances(vaultList) {
  const vaultPubkeys = vaultList.map(v => new PublicKey(v));
  const accounts = await rpcQueue.add(() =>
    fetchMultipleAccountsInfo(vaultPubkeys)
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

// Simple helper to fetch multiple accounts via Helius
async function fetchMultipleAccountsInfo(pubkeys) {
  const promises = pubkeys.map(pk => rpcQueue.add(async () => {
    const res = await fetch(process.env.HELIUS_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [pk.toBase58(), { commitment: "confirmed", encoding: "base64" }]
      })
    });
    const json = await res.json();
    return json.result?.value || null;
  }));

  return Promise.all(promises);
}

/* ---------------------------------------
   Scan all Raydium pools
-----------------------------------------*/
export async function scanPools() {
  console.log("Scanning Raydium pools on-chain...");

  const accounts = await fetchProgramAccounts(PROGRAMS.RAYDIUM_AMM);
  console.log("Total accounts fetched:", accounts.length);

  const pools = [];
  const vaultList = [];

  for (const acc of accounts) {
    const info = decodeV4(acc.account.data);
    if (!info) continue;

    pools.push({
      address: acc.pubkey,
      ammID: acc.pubkey,
      poolPubkey: acc.pubkey,
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
  const tokenPrices = {};
  for (const p of pools) {
    if (p.amountA <= 0 || p.amountB <= 0) continue;

    const priceAinB = p.amountB / p.amountA;
    const priceBinA = p.amountA / p.amountB;

    let priceAUSD = null, priceASOL = null;
    if (p.mintB === WSOL) {
      priceASOL = priceAinB;
      priceAUSD = solUsd ? priceAinB * solUsd : null;
    } else if ([USDC, USDT].includes(p.mintB)) {
      priceAUSD = priceAinB;
      priceASOL = solUsd ? priceAinB / solUsd : null;
    }

    let priceBUSD = null, priceBSOL = null;
    if (p.mintA === WSOL) {
      priceBSOL = priceBinA;
      priceBUSD = solUsd ? priceBinA * solUsd : null;
    } else if ([USDC, USDT].includes(p.mintA)) {
      priceBUSD = priceBinA;
      priceBSOL = solUsd ? priceBinA / solUsd : null;
    }

    p.priceUSD = priceAUSD || priceBUSD || null;
    p.priceSOL = priceASOL || priceBSOL || null;

    if (priceAUSD || priceASOL) tokenPrices[p.mintA] = { priceUSD: priceAUSD, priceSOL: priceASOL };
    if (priceBUSD || priceBSOL) tokenPrices[p.mintB] = { priceUSD: priceBUSD, priceSOL: priceBSOL };
  }

  return { solUsd, pools, tokenPrices, timestamp: Date.now() };
}

/* ---------------------------------------
   Compute token price (helper)
-----------------------------------------*/
export async function computePrice(mintAddress) {
  const data = await scanPools();
  const tokenData = data.pools.find(p => p.mintA === mintAddress || p.mintB === mintAddress);

  return {
    solUsd: data.solUsd,
    blockhash: "dummy",
    pools: tokenData ? [{ ammID: tokenData.ammID, priceSOL: tokenData.priceSOL, priceUSD: tokenData.priceUSD }] : []
  };
}