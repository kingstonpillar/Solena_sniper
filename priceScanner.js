// priceScanner.js
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { scanAllPools } from "./unified_pool_registry.js";

// ---------------- Constants ----------------
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gT1k2KD7", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" // USDT
]);

// ---------------- Load pool JSON ----------------
let POOL_KEYS = [];
try {
  const jsonPath = path.resolve(process.cwd(), "unified_pool_registry_backup.json");
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  POOL_KEYS = Array.isArray(raw) ? raw.map(p => p.pool) : Object.keys(raw);
  console.log(`✅ Loaded ${POOL_KEYS.length} pools from registry JSON`);
} catch {
  console.warn("⚠️ Pool registry JSON missing – price scan limited");
}

// ---------------- MAIN EXPORT ----------------
export async function scanMintFast(tokenMint, _unused = [], solUsd = null) {
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
      reserves: null
    };
  }

  // ---- Scan pools dynamically ----
  const poolsByProgram = {
    raydium: POOL_KEYS,
    orca: POOL_KEYS,
    meteora: POOL_KEYS
  };

  const scanned = await scanAllPools(poolsByProgram, { minVaultBalance: 1 });
  const allPools = [...scanned.raydium, ...scanned.orca, ...scanned.meteora];

  for (const p of allPools) {
    if (p.mintA !== mint && p.mintB !== mint) continue;

    const baseIsA = p.mintA === mint;
    const baseAmt = baseIsA ? p.amountA : p.amountB;
    const quoteAmt = baseIsA ? p.amountB : p.amountA;
    const quoteMint = baseIsA ? p.mintB : p.mintA;

    if (!baseAmt || !quoteAmt) continue;

    const price = quoteAmt / baseAmt;

    let priceUSD = null;
    if (STABLECOINS.has(quoteMint)) priceUSD = price;
    else if (quoteMint === WSOL_MINT && solUsd) priceUSD = price * solUsd;

    return {
      found: true,
      dex: "AMM",
      pool: p.pool,
      baseMint: mint,
      quoteMint,
      price,
      priceUSD,
      reserves: {
        base: baseAmt,
        quote: quoteAmt
      }
    };
  }

  return { found: false, reason: "no_valid_pool" };
}

export default { scanMintFast };