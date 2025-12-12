// priceScanner.js
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { scanPools } from "./unified_pool_registry.js";

// ---------------- Constants ----------------
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gwYgPDaXJ8", // USDC
  "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks" // USDT
]);



// ---------------- MAIN EXPORT ----------------
export async function scanMintFast(tokenMint) {
  const mint = tokenMint.toString();

  if (STABLECOINS.has(mint)) {
    return {
      found: true,
      dex: "STABLE",
      pool: null,
      baseMint: mint,
      quoteMint: "USD",
      price: 1,
      priceUSD: 1,
      priceSOL: null,
      reserves: null
    };
  }

  // FULL SCAN (all on-chain pools)
  const scanned = await scanPools();
  const combined = scanned.pools;   // all on-chain pools
  const solUSD = scanned.solUsd;    // global SOL price reference

  for (const p of combined) {
    if (p.mintA !== mint && p.mintB !== mint) continue;

    const priceUSD = p.priceUSD;
    const priceSOL = p.priceSOL;
    const pool = p.poolPubkey || p.ammID;

    const baseIsA = p.mintA === mint;
    const baseAmt  = baseIsA ? p.amountA : p.amountB;
    const quoteAmt = baseIsA ? p.amountB : p.amountA;
    const quoteMint = baseIsA ? p.mintB : p.mintA;

    return {
      found: true,
      dex: "AMM",
      pool,
      baseMint: mint,
      quoteMint,
      priceUSD,
      priceSOL,
      solUSD,
      reserves: {
        base: baseAmt,
        quote: quoteAmt
      }
    };
  }

  return { found: false, reason: "no_valid_pool" };
}