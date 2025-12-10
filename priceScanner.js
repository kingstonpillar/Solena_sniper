// priceScanner.js (minimal RPC compatible)
import dotenv from "dotenv";
dotenv.config();

import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL =
  process.env.RPC_URL_9 ||
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";

console.log("🔗 Connecting to RPC:", RPC_URL);

const connection = new Connection(RPC_URL, "confirmed");

// -------- Constants --------
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gT1k2KD7"; // canonical
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// -------- Helpers --------
async function readVaultAmount(vault) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(vault));
    if (!info?.value) return 0;

    // Handle token accounts
    const parsed = info.value.data?.parsed;
    if (parsed?.info?.tokenAmount) {
      return parsed.info.tokenAmount.uiAmount || 0;
    }

    // Fallback: raw lamports
    return info.value.lamports ? info.value.lamports / 1e9 : 0;
  } catch (e) {
    console.warn("readVaultAmount error:", e?.message || e);
    return 0;
  }
}

function priceFromReserves(baseAmt, quoteAmt) {
  if (baseAmt <= 0 || quoteAmt <= 0) return null;
  return quoteAmt / baseAmt;
}

// ---------------------------------------------------------
// MAIN EXPORT
// ---------------------------------------------------------
/**
 * scanMintFast
 *
 * @param {string} mint - token mint to price
 * @param {Array} pools - array of KNOWN pool objects:
 *   [{
 *     dex,
 *     pool,
 *     mintA,
 *     mintB,
 *     vaultA,
 *     vaultB
 *   }]
 * @param {number|null} solUsd
 */
export async function scanMintFast(mint, pools = [], solUsd = null) {
  const mintStr = mint.toString();

  for (const p of pools) {
    if (p.mintA !== mintStr && p.mintB !== mintStr) continue;

    const baseIsA = p.mintA === mintStr;
    const baseVault = baseIsA ? p.vaultA : p.vaultB;
    const quoteVault = baseIsA ? p.vaultB : p.vaultA;
    const quoteMint = baseIsA ? p.mintB : p.mintA;

    const baseAmt = await readVaultAmount(baseVault);
    const quoteAmt = await readVaultAmount(quoteVault);
    if (baseAmt <= 0 || quoteAmt <= 0) continue;

    const price = priceFromReserves(baseAmt, quoteAmt);
    if (!price) continue;

    let priceUSD = null;
    if (quoteMint === USDC || quoteMint === USDT) priceUSD = price;
    else if (quoteMint === WSOL && solUsd) priceUSD = price * solUsd;

    return {
      found: true,
      mint: mintStr,
      dex: p.dex || "amm",
      pool: p.pool,
      baseMint: mintStr,
      quoteMint,
      price,
      priceUSD,
      reserves: { base: baseAmt, quote: quoteAmt }
    };
  }

  return { found: false, mint: mintStr, reason: "no_valid_pool" };
}

// -------- RPC sanity check --------
(async () => {
  try {
    const slot = await connection.getSlot();
    console.log("✅ RPC OK. Slot:", slot);
  } catch (e) {
    console.error("❌ RPC failed:", e.message);
  }
})();