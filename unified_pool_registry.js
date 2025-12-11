// unified_pool_registry.js
// Raydium-only unified AMM pool registry (v4-focused, high-performance)
// - Dynamic on-chain detection (mintA/mintB, vaultA/vaultB, lpMint when available)
// - Fallback JSON used only to fill missing fields (never overwrites dynamic data)
// - Rate-limited RPC via PQueue
// - Exports: PROGRAMS, scanPools, scanAllPools (function names preserved)

import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import PQueue from "p-queue";

const RPC_URL = process.env.RPC_URL_9 || "https://solana-mainnet.lava.build";
const conn = new Connection(RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false
});

conn._rpcWebSocket?.on("close", () => {
  console.log("Lava WS closed – reconnecting...");
});

// load fallback (optional)
let JSON_FALLBACK = null;
try {
  const p = path.resolve(process.cwd(), "fallback_pool_registry.json");
  if (fs.existsSync(p)) JSON_FALLBACK = JSON.parse(fs.readFileSync(p, "utf8"));
} catch (e) {
  console.warn("Could not load fallback JSON:", e?.message || e);
}

// ONLY RAYDIUM (v4 focus)
export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")
};

const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 6,
  concurrency: 6
});

// canonical mints
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gwYgPDaXJ8";
const USDT_MINT = "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks";

// ---------------- helpers ----------------
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// safe wrapper for getMultipleAccountsInfo (via rpcQueue)
async function getMultipleAccountsInfoBatched(pubkeys) {
  return rpcQueue.add(() => conn.getMultipleAccountsInfo(pubkeys).catch(() => null));
}

// ---------------- Utility: safely read token balance from a token account ----------------
async function getTokenAmountFromAccount(pubkey) {
  try {
    if (!pubkey) return 0;
    // Use parsed account endpoint to get uiAmount when available
    const info = await rpcQueue.add(() => conn.getParsedAccountInfo(new PublicKey(pubkey)).catch(() => null));
    if (!info || !info.value) return 0;
    const parsed = info.value.data?.parsed;
    if (parsed && parsed.type === "account") {
      const tokenAmount = parsed.info?.tokenAmount || {};
      if (typeof tokenAmount.uiAmount === "number") return Number(tokenAmount.uiAmount);
      const amt = tokenAmount.amount ?? tokenAmount.uiAmountString;
      return Number(amt || 0);
    }
    return 0;
  } catch {
    return 0;
  }
}

// ---------------- Raydium v4 decoder (single account buffer) ----------------
// Raydium v4 layout tested: mintA @ 8..40, mintB @ 40..72, vaultA @ 72..104, vaultB @ 104..136
function decodeRaydiumV4FromBuffer(buf) {
  if (!buf || buf.length < 136) return { mintA: null, mintB: null, vaultA: null, vaultB: null };
  try {
    const mintA = new PublicKey(buf.slice(8, 40)).toBase58();
    const mintB = new PublicKey(buf.slice(40, 72)).toBase58();
    const vaultA = new PublicKey(buf.slice(72, 104)).toBase58();
    const vaultB = new PublicKey(buf.slice(104, 136)).toBase58();
    return { mintA, mintB, vaultA, vaultB };
  } catch {
    return { mintA: null, mintB: null, vaultA: null, vaultB: null };
  }
}

// ---------------- Output shaping ----------------
function makePoolOutput(base) {
  return {
    pool: base.pool || null,
    ammId: base.ammId || null,
    vaultA: base.vaultA || null,
    vaultB: base.vaultB || null,
    mintA: base.mintA || null,
    mintB: base.mintB || null,
    lpMint: base.lpMint || null,
    feeNumerator: base.feeNumerator ?? null,
    feeDenominator: base.feeDenominator ?? null,
    ampFactor: base.ampFactor ?? null,
    stable: base.stable ?? null,
    volatile: base.volatile ?? null,
    amountA: base.amountA ?? 0,
    amountB: base.amountB ?? 0,
    usesSerum: base.usesSerum || false,
    // price fields (populated by scanAllPools)
    priceInSOL: null,
    priceInUSD: null
  };
}

// ---------------- Fallback merging (CRITICAL): fallback fills missing fields ONLY ----------------
function applyJsonFallback(poolPubkey, decoded) {
  if (!JSON_FALLBACK) return { merged: decoded, usesSerum: false };
  const candidate = JSON_FALLBACK[poolPubkey] || null;
  if (!candidate) return { merged: decoded, usesSerum: false };

  // candidate (fallback) first, then decoded (dynamic) overwrites fallback
  const merged = { ...candidate, ...decoded };

  const usesSerum = !!(merged.marketId || merged.openOrders || merged.marketBids || merged.marketAsks);
  return { merged, usesSerum };
}

// ------------------- Main scanner for a list of pool account addresses -------------------
export async function scanPools(poolAccounts, opts = {}) {
  const out = [];
  if (!poolAccounts || !Array.isArray(poolAccounts) || poolAccounts.length === 0) return out;

  const minVaultBalance = Number(opts.minVaultBalance ?? 1);
  const batchSize = Number(opts.batchSize ?? 50); // fetch pools in groups to reduce overhead

  // Work in chunks: fetch many pool accounts per RPC call
  const chunks = chunkArray(poolAccounts, batchSize);

  for (const chunk of chunks) {
    try {
      // map to PublicKey array
      const pubkeys = chunk.map((a) => new PublicKey(a));
      // fetch account infos in one call (rate-limited)
      const infos = await getMultipleAccountsInfoBatched(pubkeys);

      // collect required vault addresses for downstream balance checks
      const poolsToCheck = [];
      const vaultSet = new Set();

      for (let i = 0; i < chunk.length; i++) {
        const accPub = chunk[i];
        const ai = Array.isArray(infos) ? infos[i] : null;
        // start with fallback if available
        let poolInfo = JSON_FALLBACK?.[accPub]
          ? { ...(JSON_FALLBACK[accPub]), pool: accPub, ammId: JSON_FALLBACK[accPub].ammId || accPub }
          : { pool: accPub, ammId: accPub };

       // decode Raydium v4 from buffer (if present)
if (ai && ai.data) {
  const decoded = decodeRaydiumV4FromBuffer(ai.data);
  poolInfo = { ...poolInfo, ...decoded };
} else {
  if (!JSON_FALLBACK?.[accPub]) continue;
}

// ✔ FIXED: mint must be validated AFTER fallback merge
if (!poolInfo.mintA || !poolInfo.mintB) {
  continue;
}
        // collect for later balance reading
        poolsToCheck.push(poolInfo);
        if (poolInfo.vaultA) vaultSet.add(poolInfo.vaultA);
        if (poolInfo.vaultB) vaultSet.add(poolInfo.vaultB);
      }

      // Fetch balances for unique vault accounts (deduplicated)
      const vaults = Array.from(vaultSet);
      // read balances in parallel but through rpcQueue inside getTokenAmountFromAccount
      const vaultBalanceMap = {};
      if (vaults.length) {
        const balancePromises = vaults.map(async (v) => {
          const amt = await getTokenAmountFromAccount(v).catch(() => 0);
          vaultBalanceMap[v] = Number(amt || 0);
        });
        await Promise.all(balancePromises);
      }

      // assemble final pool outputs
      for (const p of poolsToCheck) {
        const amountA = Number(vaultBalanceMap[p.vaultA] || 0);
        const amountB = Number(vaultBalanceMap[p.vaultB] || 0);
        if ((amountA + amountB) < minVaultBalance) continue;

        const { merged, usesSerum } = applyJsonFallback(p.pool, { ...p, amountA, amountB });
        out.push(makePoolOutput({ ...merged, usesSerum }));
      }
    } catch (e) {
      // swallow per-chunk error, continue with next chunk
      // console.debug("scanPools chunk error:", e?.message || e);
    }
  }

  return out;
}

// ---------------- Helper: price discovery helpers (unchanged approach) ----------------
function findUSDPriceOfMint(mint, combinedPools, solUSDPrice) {
  for (const p of combinedPools) {
    if (!p.mintA || !p.mintB) continue;
    if (p.mintA === mint && (p.mintB === USDC_MINT || p.mintB === USDT_MINT)) {
      if (p.amountA && p.amountB) return p.amountB / p.amountA;
    }
    if (p.mintB === mint && (p.mintA === USDC_MINT || p.mintA === USDT_MINT)) {
      if (p.amountA && p.amountB) return p.amountA / p.amountB;
    }
    if (p.mintA === mint && p.mintB === WSOL_MINT && solUSDPrice) {
      if (p.amountA && p.amountB) {
        const priceMintInSOL = p.amountB / p.amountA;
        return priceMintInSOL * solUSDPrice;
      }
    }
    if (p.mintB === mint && p.mintA === WSOL_MINT && solUSDPrice) {
      if (p.amountA && p.amountB) {
        const priceMintInSOL = p.amountA / p.amountB;
        return priceMintInSOL * solUSDPrice;
      }
    }
  }
  return null;
}

function findSolUSDPrice(combinedPools) {
  for (const p of combinedPools) {
    if (!p.mintA || !p.mintB) continue;
    if ((p.mintA === WSOL_MINT && p.mintB === USDC_MINT) || (p.mintB === WSOL_MINT && p.mintA === USDC_MINT)) {
      if (p.mintA === WSOL_MINT) {
        if (p.amountA && p.amountB) return p.amountB / p.amountA;
      } else {
        if (p.amountA && p.amountB) return p.amountA / p.amountB;
      }
    }
  }
  for (const p of combinedPools) {
    if (!p.mintA || !p.mintB) continue;
    if ((p.mintA === WSOL_MINT && p.mintB === USDT_MINT) || (p.mintB === WSOL_MINT && p.mintA === USDT_MINT)) {
      if (p.mintA === WSOL_MINT) {
        if (p.amountA && p.amountB) return p.amountB / p.amountA;
      } else {
        if (p.amountA && p.amountB) return p.amountA / p.amountB;
      }
    }
  }

  // fallback JSON fallback chance
  if (JSON_FALLBACK) {
    for (const key of Object.keys(JSON_FALLBACK)) {
      const entry = JSON_FALLBACK[key];
      if (!entry) continue;
      if ((entry.mintA === WSOL_MINT && (entry.mintB === USDC_MINT || entry.mintB === USDT_MINT)) ||
          (entry.mintB === WSOL_MINT && (entry.mintA === USDC_MINT || entry.mintA === USDT_MINT))) {
        if (typeof entry.amountA === "number" && typeof entry.amountB === "number") {
          if (entry.mintA === WSOL_MINT) return entry.amountB / entry.amountA;
          return entry.amountA / entry.amountB;
        }
      }
    }
  }

  return null;
}

// ---------------- Scan by program + compute priceInSOL/priceInUSD ----------------
export async function scanAllPools(poolAccountsByProgram = {}, opts = {}) {
  // Only raydium supported now
  const raydiumPools = await scanPools(poolAccountsByProgram.raydium || [], { ...opts, program: "raydium" });

  const combined = [...raydiumPools];

  const solUSDPrice = findSolUSDPrice(combined);

  for (const p of combined) {
    p.priceInUSD = null;
    p.priceInSOL = null;

    if (!p.amountA || !p.amountB || p.amountA === 0) continue;
    const priceAinB = p.amountB / p.amountA;

    if (p.mintB === USDC_MINT || p.mintB === USDT_MINT) {
      p.priceInUSD = priceAinB;
    } else if (p.mintB === WSOL_MINT) {
      if (solUSDPrice) p.priceInUSD = priceAinB * solUSDPrice;
      else p.priceInUSD = null;
    } else {
      const tokenBUsd = findUSDPriceOfMint(p.mintB, combined, solUSDPrice);
      if (tokenBUsd) p.priceInUSD = priceAinB * tokenBUsd;
      else p.priceInUSD = null;
    }

    if (solUSDPrice && p.priceInUSD != null) {
      p.priceInSOL = p.priceInUSD / solUSDPrice;
    } else if (p.mintB === WSOL_MINT) {
      p.priceInSOL = priceAinB;
    } else {
      p.priceInSOL = null;
    }
  }

  return {
    raydium: raydiumPools,
    solUSDPrice: solUSDPrice || null,
    combined
  };
}

export default {
  PROGRAMS,
  scanPools,
  scanAllPools
};