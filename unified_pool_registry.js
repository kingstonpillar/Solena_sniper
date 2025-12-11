// unified_pool_registry.js
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

let JSON_FALLBACK = null;
try {
  const p = path.resolve(process.cwd(), "fallback_pool_registry.json");
  if (fs.existsSync(p)) {
    JSON_FALLBACK = JSON.parse(fs.readFileSync(p, "utf8"));
  }
} catch (e) {
  console.warn("Could not load fallback JSON:", e?.message || e);
}

export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  ORCA_AMM: new PublicKey("9WwRZjZJ9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5")
  // Meteora removed as requested
};

const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 6,
  concurrency: 6
});

// WSOL mint (standard)
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gwYgPDaXJ8";
const USDT_MINT = "Es9vMFrzaCERo7L12buuA2YkxZB1rAxHefeK11NeLLks";

// ---------------- Utility for Token Balances ----------------
async function getTokenAmountFromAccount(pubkey) {
  try {
    if (!pubkey) return 0;
    const info = await rpcQueue.add(() =>
      conn.getParsedAccountInfo(new PublicKey(pubkey)).catch(() => null)
    );
    if (!info || !info.value) return 0;
    const parsed = info.value.data?.parsed;
    if (parsed && parsed.type === "account") {
      // uiAmount is decimal-adjusted; fallback to raw amount if needed
      const ui = parsed.info.tokenAmount?.uiAmount;
      if (typeof ui === "number") return Number(ui);
      return Number(parsed.info.tokenAmount?.amount || 0);
    }
    return 0;
  } catch {
    return 0;
  }
}

// ------------------- Raydium Vault Auto-Detection -------------------
async function fetchRaydiumVaults(poolPubkey) {
  try {
    const acc = await rpcQueue.add(() =>
      conn.getAccountInfo(new PublicKey(poolPubkey))
    );
    if (!acc || !acc.data || acc.data.length < 160)
      return { vaultA: null, vaultB: null };
    const data = acc.data;
    const vaultA = new PublicKey(data.slice(72, 104)).toBase58();
    const vaultB = new PublicKey(data.slice(104, 136)).toBase58();
    return { vaultA, vaultB };
  } catch {
    return { vaultA: null, vaultB: null };
  }
}

// ------------------- Orca AMM Auto-Detection -------------------
async function fetchOrcaAmm(poolPubkey) {
  try {
    const acc = await rpcQueue.add(() =>
      conn.getAccountInfo(new PublicKey(poolPubkey))
    );
    if (!acc || !acc.data || acc.data.length < 168)
      return { vaultA: null, vaultB: null, mintA: null, mintB: null, lpMint: null };
    const data = acc.data;
    const mintA = new PublicKey(data.slice(8, 40)).toBase58();
    const mintB = new PublicKey(data.slice(40, 72)).toBase58();
    const vaultA = new PublicKey(data.slice(72, 104)).toBase58();
    const vaultB = new PublicKey(data.slice(104, 136)).toBase58();
    const lpMint = new PublicKey(data.slice(136, 168)).toBase58();
    return { mintA, mintB, vaultA, vaultB, lpMint };
  } catch {
    return { mintA: null, mintB: null, vaultA: null, vaultB: null, lpMint: null };
  }
}

// ---------------- Output Formatting ----------------
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
    // price fields (populated later by scanAllPools)
    priceInSOL: null,
    priceInUSD: null
  };
}

function applyJsonFallback(poolPubkey, decoded) {
  if (!JSON_FALLBACK) return { merged: decoded, usesSerum: false };
  const candidate = JSON_FALLBACK[poolPubkey] || null;
  if (!candidate) return { merged: decoded, usesSerum: false };
  const merged = { ...decoded, ...candidate };
  const usesSerum = !!(merged.marketId || merged.openOrders);
  return { merged, usesSerum };
}

// ------------------- Main Scanner -------------------
export async function scanPools(poolAccounts, opts = {}) {
  const out = [];
  if (!poolAccounts || !Array.isArray(poolAccounts)) return out;

  const minVaultBalance = opts.minVaultBalance || 1;

  for (const accPub of poolAccounts) {
    try {
      let poolInfo = JSON_FALLBACK?.[accPub] || { pool: accPub, ammId: accPub };

      // ---- Raydium Dynamic
      if (!poolInfo.vaultA || !poolInfo.vaultB) {
        const ray = await fetchRaydiumVaults(accPub);
        poolInfo.vaultA = poolInfo.vaultA || ray.vaultA;
        poolInfo.vaultB = poolInfo.vaultB || ray.vaultB;
      }

      // ---- Orca Dynamic (only attempt if opts.program === "orca")
      if ((!poolInfo.vaultA || !poolInfo.vaultB) && opts.program === "orca") {
        const orca = await fetchOrcaAmm(accPub);
        poolInfo = { ...orca, ...poolInfo };
      }

      const amountA = await getTokenAmountFromAccount(poolInfo.vaultA);
      const amountB = await getTokenAmountFromAccount(poolInfo.vaultB);
      if ((amountA + amountB) < minVaultBalance) continue;

      const { merged, usesSerum } = applyJsonFallback(accPub, {
        ...poolInfo,
        amountA,
        amountB
      });

      out.push(makePoolOutput({ ...merged, usesSerum }));
    } catch (e) {
      // swallow errors but continue scanning others
    }
  }

  return out;
}

// ---------------- Helper: find USD price of a mint from scanned pools ----------------
function findUSDPriceOfMint(mint, combinedPools, solUSDPrice) {
  // Look for direct mint <-> USDC/USDT
  for (const p of combinedPools) {
    if (!p.mintA || !p.mintB) continue;
    // case: mint (A) paired with USD (B)
    if (p.mintA === mint && (p.mintB === USDC_MINT || p.mintB === USDT_MINT)) {
      if (p.amountA && p.amountB) return p.amountB / p.amountA;
    }
    // case: mint (B) paired with USD (A)
    if (p.mintB === mint && (p.mintA === USDC_MINT || p.mintA === USDT_MINT)) {
      if (p.amountA && p.amountB) return p.amountA / p.amountB;
    }
    // case: mint paired with WSOL
    if (p.mintA === mint && p.mintB === WSOL_MINT && solUSDPrice) {
      if (p.amountA && p.amountB) {
        const priceMintInSOL = p.amountB / p.amountA; // mint in SOL
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

// Compute solUSDPrice from a combined pool list (prefers direct WSOL/USDC then WSOL/USDT)
function findSolUSDPrice(combinedPools) {
  // prefer pool where one side is WSOL and other is USDC (or USDT)
  for (const p of combinedPools) {
    if (!p.mintA || !p.mintB) continue;
    if ((p.mintA === WSOL_MINT && p.mintB === USDC_MINT) || (p.mintB === WSOL_MINT && p.mintA === USDC_MINT)) {
      // Determine which side is SOL and which is USDC
      if (p.mintA === WSOL_MINT) {
        if (p.amountA && p.amountB) return p.amountB / p.amountA; // USDC per SOL
      } else {
        if (p.amountA && p.amountB) return p.amountA / p.amountB;
      }
    }
  }
  // fallback try WSOL/USDT
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
  // try fallback JSON if present and contains a WSOL/USDC entry with amount fields
  if (JSON_FALLBACK) {
    for (const key of Object.keys(JSON_FALLBACK)) {
      const entry = JSON_FALLBACK[key];
      if (!entry) continue;
      if ((entry.mintA === WSOL_MINT && (entry.mintB === USDC_MINT || entry.mintB === USDT_MINT)) ||
          (entry.mintB === WSOL_MINT && (entry.mintA === USDC_MINT || entry.mintA === USDT_MINT))) {
        // if fallback provides amountA/amountB numeric fields, use them
        if (typeof entry.amountA === "number" && typeof entry.amountB === "number") {
          if (entry.mintA === WSOL_MINT) return entry.amountB / entry.amountA;
          return entry.amountA / entry.amountB;
        }
      }
    }
  }
  return null;
}

// ---------------- Scan by Program + compute priceInSOL/priceInUSD ----------------
export async function scanAllPools(poolAccountsByProgram = {}, opts = {}) {
  // Scan per program (dynamic-first, fallback used inside scanPools)
  const raydiumPools = await scanPools(poolAccountsByProgram.raydium || [], { ...opts, program: "raydium" });
  const orcaPools = await scanPools(poolAccountsByProgram.orca || [], { ...opts, program: "orca" });

  // Combined list for price discovery
  const combined = [...raydiumPools, ...orcaPools];

  // Find SOL -> USD price (USDC per SOL)
  const solUSDPrice = findSolUSDPrice(combined);

  // For each pool, compute priceInUSD then priceInSOL
  for (const p of combined) {
    // default nulls
    p.priceInUSD = null;
    p.priceInSOL = null;

    // basic sanity
    if (!p.amountA || !p.amountB || p.amountA === 0) continue;

    // price A in terms of B (A priced in B)
    const priceAinB = p.amountB / p.amountA;

    // Determine price in USD:
    // - if B is USDC/USDT -> A priced in USD directly
    if (p.mintB === USDC_MINT || p.mintB === USDT_MINT) {
      p.priceInUSD = priceAinB; // A in USD
    } else if (p.mintB === WSOL_MINT) {
      // B is SOL, need solUSDPrice
      if (solUSDPrice) {
        p.priceInUSD = priceAinB * solUSDPrice;
      } else {
        // Try fallback JSON or null
        p.priceInUSD = null;
      }
    } else {
      // try to find mintB's USD price from other pools
      const tokenBUsd = findUSDPriceOfMint(p.mintB, combined, solUSDPrice);
      if (tokenBUsd) {
        p.priceInUSD = priceAinB * tokenBUsd;
      } else {
        p.priceInUSD = null;
      }
    }

    // Compute priceInSOL if solUSDPrice known
    if (solUSDPrice && p.priceInUSD != null) {
      p.priceInSOL = p.priceInUSD / solUSDPrice;
    } else if (p.mintB === WSOL_MINT) {
      // If B is WSOL, priceAinB is already in SOL
      p.priceInSOL = priceAinB;
    } else {
      p.priceInSOL = null;
    }
  }

  // Return grouped output (each pool has priceInUSD & priceInSOL where resolvable)
  return {
    raydium: raydiumPools,
    orca: orcaPools,
    // convenience fields
    solUSDPrice: solUSDPrice || null,
    combined
  };
}

export default {
  PROGRAMS,
  scanPools,
  scanAllPools
};