// priceScanner.js
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { scanAllPools } from "./unified_pool_registry.js";

// ---------------- Constants ----------------
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gwYgPDaXJ8", // USDC
  "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks" // USDT
]);

// ---------------- Load pool JSON ----------------
let POOL_KEYS = [];
try {
  const jsonPath = path.resolve(process.cwd(), "unified_pool_registry_backup.json");
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  POOL_KEYS = Array.isArray(raw) ? raw.map(p => p.pool) : Object.keys(raw);
  console.log(`✅ Loaded ${POOL_KEYS.length} pool addresses`);
} catch {
  console.warn("⚠️ No fallback registry found. Dynamic scan only.");
}

// ---------------- MAIN EXPORT ----------------
export async function scanMintFast(tokenMint) {
  const mint = tokenMint.toString();

  // ---- Stablecoin shortcut ----
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

  // ---- Prepare pools list ----
  const poolsByProgram = {
    raydium: POOL_KEYS, // static Raydium pools
    orca: [],           // Orca will be dynamic from unified scan
  };

  // ---- FULL SCAN (with priceInUSD + priceInSOL already calculated)
  const scanned = await scanAllPools(poolsByProgram, { minVaultBalance: 1 });

  const combined = scanned.combined;      // all pools, Raydium + Orca
  const solUSD = scanned.solUSDPrice;     // global SOL→USD reference

  // ---- Search through all pools for this mint ----
  for (const p of combined) {
    if (p.mintA !== mint && p.mintB !== mint) continue;

    // Already computed by unified scanner:
    const priceUSD = p.priceInUSD;
    const priceSOL = p.priceInSOL;

    // Optional: direct reserve info
    const baseIsA = p.mintA === mint;
    const baseAmt  = baseIsA ? p.amountA : p.amountB;
    const quoteAmt = baseIsA ? p.amountB : p.amountA;
    const quoteMint = baseIsA ? p.mintB : p.mintA;

    return {
      found: true,
      dex: "AMM",
      pool: p.pool,
      baseMint: mint,
      quoteMint,
      priceUSD,       // <---- READY TO USE
      priceSOL,       // <---- READY TO USE
      solUSD,         // <---- global SOL price reference
      reserves: {
        base: baseAmt,
        quote: quoteAmt
      }
    };
  }

  return { found: false, reason: "no_valid_pool" };
}

export default { scanMintFast };