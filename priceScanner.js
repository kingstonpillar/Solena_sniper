// priceScanner.js
import dotenv from "dotenv";
dotenv.config();

import { PublicKey } from "@solana/web3.js";
import { scanAllPools, scanPools, PROGRAMS } from "./unified_pool_registry.js";

const STABLECOINS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gT1k2KD7", // USDC
  "Es9vMFrzaCERz3QZ6i7jfjhGqVEF2vnS3r7WzExb6eE"  // USDT canonical (example)
];

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export async function scanMintFast(tokenMint, extraPools = [], solPriceUSD = null) {
  const mintKey = tokenMint.toString();

  // --- STEP 1: Handle stablecoins ---
  if (STABLECOINS.includes(mintKey)) {
    return {
      found: true,
      dex: "STABLECOIN",
      pool: null,
      baseMint: mintKey,
      quoteMint: "USD",
      price: 1,
      priceUSD: 1,
      reserves: null
    };
  }

  // --- STEP 2: Fetch all known pools dynamically ---
  let allPools = [];
  try {
    const poolAccountsByProgram = {
      raydium: [],
      orca: [],
      meteora: []
    };
    const all = await scanAllPools(poolAccountsByProgram);
    allPools = [...all.raydium, ...all.orca, ...all.meteora, ...extraPools];
  } catch (err) {
    console.warn("Failed to fetch dynamic pools:", err.message || err);
    allPools = [...extraPools];
  }

  // --- STEP 3: Find token pools ---
  const tokenPools = allPools.filter(p =>
    p.mintA === mintKey || p.mintB === mintKey
  );

  if (!tokenPools.length) {
    return { found: false, reason: "no_valid_pool" };
  }

  // --- STEP 4: Price calculation ---
  for (const pool of tokenPools) {
    try {
      let baseMint, quoteMint, baseAmount, quoteAmount;

      if (pool.mintA === mintKey) {
        baseMint = pool.mintA;
        quoteMint = pool.mintB;
        baseAmount = pool.amountA;
        quoteAmount = pool.amountB;
      } else {
        baseMint = pool.mintB;
        quoteMint = pool.mintA;
        baseAmount = pool.amountB;
        quoteAmount = pool.amountA;
      }

      if (!baseAmount || !quoteAmount) continue;

      const price = quoteAmount / baseAmount;

      let priceUSD = null;

      if (STABLECOINS.includes(quoteMint)) {
        priceUSD = price; // direct USD
      } else if (quoteMint === WSOL_MINT && solPriceUSD) {
        priceUSD = price * solPriceUSD;
      }

      return {
        found: true,
        dex: pool.ammId || "unknown",
        pool: pool.pool,
        baseMint,
        quoteMint,
        price,
        priceUSD,
        reserves: { baseAmount, quoteAmount }
      };
    } catch { continue; }
  }

  return { found: false, reason: "no_valid_pool" };
}

export default { scanMintFast };