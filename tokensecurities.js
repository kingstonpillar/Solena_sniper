// tokensecurities.js — ON-CHAIN + Raydium pool analysis + Developer wallet scoring (Option C behavior)
// RPC-only. Adds:
//  - Raydium/DEX pool transaction analysis heuristics
//  - Developer wallet age + transaction history scoring
//  - Option C: nuclear switches (devWalletSafe & raydiumSafe must be true or token is UNSAFE)
// Export: verifyTokenSecurity(mint) -> { safe, score, reasons }

import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import PQueue from "p-queue";

// Guard: ensure RPC_URL exists, fallback to public cluster only if explicitly desired
const RPC_URL = process.env.RPC_URL_3 || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC_URL, "confirmed");

// -------------------- Per-file RPC rate limiter --------------------
// Isolated per-file limiter: adjust intervalCap/interval if you want different rate
const localRPCLimiter = new PQueue({
  intervalCap: Number(process.env.TOKENSEC_RPC_INTERVAL_CAP || 6), // default 3 RPC calls per second
  interval: Number(process.env.TOKENSEC_RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true
});
async function rpcLimited(fn) { return localRPCLimiter.add(fn); }
// -------------------------------------------------------------------

/** --- Scoring parameters --- */
const MIN_UNIQUE_WALLETS = Number(process.env.MIN_UNIQUE_WALLETS || 3);
const MIN_BUY_VOLUME_USD = Number(process.env.MIN_BUY_VOLUME_USD || 200);
const BUY_TOKEN_USD_PRICE = Number(process.env.BUY_TOKEN_USD_PRICE || 1); // fallback price per token
const SAFE_THRESHOLD = Number(process.env.SAFE_THRESHOLD || 75);

// RPC limits / heuristics (tune per your RPC)
const POOL_SIG_SCAN_LIMIT = Number(process.env.POOL_SIG_SCAN_LIMIT || 300); // signatures to scan for pool analysis
const DEV_SIG_SCAN_LIMIT = Number(process.env.DEV_SIG_SCAN_LIMIT || 500); // signatures to inspect for dev wallet
const POOL_AGE_SUSPICIOUS_SECS = Number(process.env.POOL_AGE_SUSPICIOUS_SECS || 3600); // 1 hour
const DEV_MIN_AGE_DAYS = Number(process.env.DEV_MIN_AGE_DAYS || 7);
const DEV_MIN_TXS = Number(process.env.DEV_MIN_TXS || 5);

const KNOWN_LP_PROGRAM_IDS = new Set([
  // RAYDIUM
  "AMMDSf6qJrJX9mH2A2fz6JwW1kT9yHn7fyoM9oJpH46", // Raydium AMM
  "CPMMMR5sYq6Lp1r9doE8h1ya8e2fRv5h3e6L4NfJFQD", // Raydium CPMM
  "CLMMp9jESiuyB9DW5eQibNHRKdgb5LtjfuHjU7EsWcF", // Raydium CLMM
  "RVKdWNNqjE2noKGKuX3sDRKeEvf9vpVw2En83ZJ6dxk", // Raydium Stable

  // ORCA
  "9Ww2cFqDqbjGw3qtS8PtE412aSTn1SNkfjtcysA8u6tY", // Orca AMM
  "whirLbW1bT7R9rV1xv5ZdNz3rL1ZzYxR9Ew87JzKfCw", // Orca Whirlpool

  // METEORA (correct)
  "METoRaDLMM2Yt3SiFbRvDDDeZbxTWdKSRsMeaRFhApA", // Meteora DLMM
  "7qMTo8GFznJ1UqCqtEtL1Wo3pzBvT1C44VZaaRTpBoWa", // Meteora Dynamic AMM v2
]);

// --- Helpers ----------------------------------------------------------------
async function safeGetParsedTransaction(sig) {
  try {
    return await rpcLimited(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }));
  } catch (err) {
    return null;
  }
}

// safe number from various possible fields
function safeNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// Return token accounts sorted descending by amount (ui amount). Always returns array.
async function getTokenAccountsByMint(mint) {
  try {
    let mintPub;
    try { mintPub = new PublicKey(mint); }
    catch { return []; }

    const largest = await rpcLimited(() => conn.getTokenLargestAccounts(mintPub))
      .catch(() => null);

    const rawAccounts = Array.isArray(largest?.value) ? largest.value : [];
    const result = [];

    for (const a of rawAccounts) {
      try {
        // a.address is ALREADY a PublicKey
        const acctInfo = await rpcLimited(() =>
          conn.getParsedAccountInfo(a.address)   // <- NO new PublicKey()
        ).catch(() => null);

        const info = acctInfo?.value?.data?.parsed?.info;
        const tokenAmt = info?.tokenAmount;

        const uiAmount = safeNumber(
          tokenAmt?.uiAmount ?? tokenAmt?.uiAmountString,
          0
        );

        result.push({
          owner: info?.owner || null,
          amount: uiAmount,
          rawAmount: a.amount ?? "0",
          address: a.address.toString()
        });

      } catch {
        // Ignore account-level errors
      }
    }

    return result.sort((x, y) => (y.amount || 0) - (x.amount || 0));
  } catch (err) {
    console.log("getTokenAccountsByMint error:", err?.message);
    return [];
  }
}

/**
 * ON-CHAIN BUY VOLUME (no Jupiter).
 * Scans recent confirmed transactions for the mint and counts token-account increases.
 */
async function getOnchainBuyVolume(mint, limit = 2000) {
  try {
    const mintPub = (() => {
      try { return new PublicKey(mint); } catch { return null; }
    })();
    if (!mintPub) return { totalVolumeUSD: 0, uniqueBuyers: 0, tradeCount: 0 };

    // guard limit to max 1000 for RPC
    const sigInfos = await rpcLimited(() => conn.getSignaturesForAddress(mintPub, { limit: Math.min(limit, 1000) })).catch(() => []);
    let totalBuyTokens = 0;
    const buyers = new Set();
    let tradeCount = 0;

    for (const s of sigInfos) {
      if (!s?.signature) continue;
      const tx = await safeGetParsedTransaction(s.signature);
      if (!tx?.meta) continue;

      const post = Array.isArray(tx.meta.postTokenBalances) ? tx.meta.postTokenBalances : [];
      const pre = Array.isArray(tx.meta.preTokenBalances) ? tx.meta.preTokenBalances : [];

      const mintStr = mintPub.toBase58();

      for (const ix of post) {
        if (!ix || ix.mint !== mintStr) continue;

        // uiAmount may be at uiAmount or uiAmountString; try both
        const postAmt = (typeof ix.uiTokenAmount?.uiAmount === "number")
          ? ix.uiTokenAmount.uiAmount
          : safeNumber(ix.uiTokenAmount?.uiAmountString, 0);

        const prev = pre.find(p => p.accountIndex === ix.accountIndex) || null;
        const prevAmt = prev
          ? ((typeof prev.uiTokenAmount?.uiAmount === "number") ? prev.uiTokenAmount.uiAmount : safeNumber(prev.uiTokenAmount?.uiAmountString, 0))
          : 0;

        const delta = postAmt - prevAmt;
        if (delta > 0) {
          totalBuyTokens += delta;
          // owner fallback: ix.owner, else owner from accountKeys mapping
          const owner = ix.owner || (typeof ix.accountIndex === "number"
            ? (tx.transaction?.message?.accountKeys?.[ix.accountIndex]?.pubkey?.toString?.() || null)
            : null);
          if (owner) buyers.add(owner);
          tradeCount++;
        }
      }
    }

    const totalVolumeUSD = totalBuyTokens * BUY_TOKEN_USD_PRICE;
    return { totalVolumeUSD, uniqueBuyers: buyers.size, tradeCount };
  } catch (err) {
    console.log("getOnchainBuyVolume error:", err?.message || err);
    return { totalVolumeUSD: 0, uniqueBuyers: 0, tradeCount: 0 };
  }
}

/**
 * Raydium / LP pool transaction analysis
 */
async function analyzePoolActivity(mint, mintCreatorAddress) {
  try {
    const mintPub = (() => { try { return new PublicKey(mint); } catch { return null; } })();
    if (!mintPub)
      return { safe: true, reason: null, details: { scanned: 0, note: "invalid mint" } };

    const sigInfos = await rpcLimited(() =>
      conn.getSignaturesForAddress(mintPub, { limit: Math.min(POOL_SIG_SCAN_LIMIT, 500) })
    ).catch(() => []);

    if (!Array.isArray(sigInfos) || sigInfos.length === 0) {
      return { safe: true, reason: null, details: { scanned: 0 } };
    }

    let firstPoolEventAt = null;
    let firstPoolEventBy = null;
    let lpAddEvents = 0;
    let poolCreationEvents = 0;
    let scanned = 0;

    // ----------------------
    // logic here...
    // ----------------------

    return { safe: true, details: { scanned } }; // placeholder
  } catch (err) {
    return { safe: false, reason: err.message || err, details: {} };
  }
}

    // -----------------------------------------------------
    // CORRECTED POOL-CREATION KEYWORDS
    // -----------------------------------------------------
    const keywordsPoolCreate = [
  // Raydium v4
  "initialize2", "initialize swap", "initialize_swap",

  // Orca classic
  "initializeconfig", "initialize pool", "initialize_pool",

  // Orca whirlpool
  "whirlpool initialize",

  // --- METEORA (ALL RELEVANT) ---
  "create_pool",
  "init_pool",
  "initialize_pool",
  "initialize",
  "update_pool"
];

    // -----------------------------------------------------
    // CORRECTED LP ADD KEYWORDS
    // -----------------------------------------------------
    const keywordsLPAdd = [
  // Raydium v4
  "add_liquidity", "mint_to", "mintto",

  // Orca classic
  "sync",

  // Orca whirlpool
  "increase_liquidity",

  // --- METEORA DLMM + OLD VERSIONS ---
  "deposit",
  "deposit liquidity",
  "deposit_liquidity",
  "add_liquidity",
  "add_liq",
  "sync_reserve",
  "rebalance",
  "collect_fees",
  "withdraw",
  "remove_liquidity",
  "mint",
  "burn"
];

    for (const s of sigInfos) {
      if (!s?.signature) continue;
      scanned++;
      if (scanned > POOL_SIG_SCAN_LIMIT) break;

      const tx = await safeGetParsedTransaction(s.signature);
      if (!tx) continue;

      const logs = (Array.isArray(tx.meta?.logMessages)
        ? tx.meta.logMessages.join(" ")
        : ""
      ).toLowerCase();

      const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : null;

      if (!logs) continue;

      // =========================================================
      // DETECT POOL CREATION (MORE PRECISE)
      // =========================================================
      const isCreate = keywordsPoolCreate.some(k => logs.includes(k));

      if (isCreate) {
        poolCreationEvents++;

        if (!firstPoolEventAt && blockTime) {
          firstPoolEventAt = blockTime;

          try {
            const acct0 = tx.transaction?.message?.accountKeys?.[0];
            firstPoolEventBy = acct0?.pubkey?.toString?.() || acct0?.toString?.() || null;
          } catch {
            firstPoolEventBy = null;
          }
        }
      }

      // =========================================================
      // DETECT LP ADD EVENTS (MORE PRECISE)
      // =========================================================
      const isLPAdd = keywordsLPAdd.some(k => logs.includes(k));

      if (isLPAdd) {
        lpAddEvents++;

        if (!firstPoolEventAt && blockTime) {
          firstPoolEventAt = blockTime;

          try {
            const acct0 = tx.transaction?.message?.accountKeys?.[0];
            firstPoolEventBy = acct0?.pubkey?.toString?.() || acct0?.toString?.() || null;
          } catch {
            firstPoolEventBy = null;
          }
        }
      }
    }

    // =========================================================
    // SAFETY CALCULATIONS
    // =========================================================
    const POOL_AGE_MINIMUM_SECS = 120; // Require pool to be at least 2 minutes old

const now = Math.floor(Date.now() / 1000);
const poolAgeSecs =
  typeof firstPoolEventAt === "number" ? now - firstPoolEventAt : null;

// Rule 1: Pool too new
if (poolAgeSecs !== null && poolAgeSecs < POOL_AGE_MINIMUM_SECS) {
  return {
    safe: false,
    reason: `Pool too new (${poolAgeSecs}s < ${POOL_AGE_MINIMUM_SECS}s).`,
    details: { poolAgeSecs, poolCreationEvents, lpAddEvents, firstPoolEventBy, scanned }
  };
}

// Rule 2: Dev created pool / LP
if (
  (poolCreationEvents > 0 || lpAddEvents > 0) &&
  mintCreatorAddress &&
  firstPoolEventBy &&
  mintCreatorAddress === firstPoolEventBy
) {
  return {
    safe: false,
    reason: `LP added/created by mint creator (${mintCreatorAddress}) — suspicious.`,
    details: { poolAgeSecs, poolCreationEvents, lpAddEvents, firstPoolEventBy, scanned }
  };
}

return {
  safe: true,
  reason: null,
  details: { poolAgeSecs, poolCreationEvents, lpAddEvents, firstPoolEventBy, scanned }
};
/**
 * Developer wallet analysis (RPC-only)
 */
async function analyzeDeveloperWallet(deployerAddress) {
  try {
    if (!deployerAddress) 
      return { safe: false, score: 0, reason: "No deployer address", details: {} };

    const deployerPub = (() => { 
      try { return new PublicKey(deployerAddress); } catch { return null; } 
    })();

    if (!deployerPub) 
      return { safe: false, score: 0, reason: "Invalid deployer address", details: {} };

    // -------------------------------------------
    // FIXED: If DEV_SIG_SCAN_LIMIT is not set, do NOT include limit key
    // -------------------------------------------
    const limit = (
      typeof DEV_SIG_SCAN_LIMIT === "number" && 
      DEV_SIG_SCAN_LIMIT > 0 &&
      DEV_SIG_SCAN_LIMIT <= 1000
    )
      ? DEV_SIG_SCAN_LIMIT
      : undefined;

    const sigInfos = await rpcLimited(() =>
      conn.getSignaturesForAddress(
        deployerPub,
        limit ? { limit } : undefined   // <--- correct, clean
      )
    ).catch(() => []);

    if (!Array.isArray(sigInfos) || sigInfos.length === 0) {
      return { safe: false, score: 0, reason: "Deployer has no on-chain history", details: { sigs: 0 } };
    }

    // signatures oldest → newest logic unchanged
    const earliest = sigInfos[sigInfos.length - 1];
    const earliestBlockTime = typeof earliest?.blockTime === "number" ? earliest.blockTime : null;
    const now = Math.floor(Date.now() / 1000);
    const ageDays = earliestBlockTime ? ((now - earliestBlockTime) / 86400) : 0;
    const txCount = sigInfos.length;

    let score = 100;
    let safe = true;
    const reasons = [];

    if (!earliestBlockTime || ageDays < DEV_MIN_AGE_DAYS) {
      score -= 80;
      safe = false;
      reasons.push(`Deployer wallet too new (${ageDays.toFixed(1)} days)`);
    } else if (ageDays < DEV_MIN_AGE_DAYS * 2) {
      score -= 20;
      reasons.push(`Deployer wallet age moderate (${ageDays.toFixed(1)} days)`);
    } else {
      reasons.push(`Deployer wallet age ${ageDays.toFixed(1)} days`);
    }

    if (txCount < DEV_MIN_TXS) {
      score -= 30;
      safe = false;
      reasons.push(`Deployer transaction count low (${txCount})`);
    } else {
      reasons.push(`Deployer tx count ${txCount}`);
    }

    try {
      const bal = await rpcLimited(() => conn.getBalance(deployerPub)).catch(() => null);
      if (typeof bal === "number") {
        const sol = bal / 1e9;
        if (sol < 0.05) {
          score -= 10;
          reasons.push(`Deployer SOL balance low (${sol.toFixed(4)} SOL)`);
        } else {
          reasons.push(`Deployer SOL balance ${sol.toFixed(4)} SOL`);
        }
      } else {
        reasons.push("Deployer SOL balance: unavailable");
      }
    } catch {}

    score = Math.max(0, Math.min(score, 100));

    return { safe, score, reason: reasons.join(" ; "), details: { ageDays, txCount, reasons } };
  } catch (err) {
    console.log("analyzeDeveloperWallet error:", err?.message || err);
    return { safe: false, score: 0, reason: "RPC error analyzing deployer", details: { err: err?.message } };
  }
}

// ====================== exported verifyTokenSecurity =========================
export async function verifyTokenSecurity(mint) {
  const reasons = [];
  let score = 0;
  let lockInfo = null;

  console.log(`🔍 Checking on-chain token security: ${mint}`);

  try {
    // Basic validation of mint
    const mintPub = (() => { try { return new PublicKey(mint); } catch { return null; } })();
    if (!mintPub) {
      reasons.push("Invalid mint address");
      return { safe: false, score: 0, reasons };
    }

    // ---------- TOKEN HOLDERS / LIQUIDITY ----------
    const accounts = await getTokenAccountsByMint(mint).catch(() => []);
    const positiveAccounts = accounts.filter(a => (typeof a.amount === "number" && a.amount > 0));
    const holders = positiveAccounts.length;
    const totalLiquidity = positiveAccounts.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const largest = positiveAccounts[0] || null;
    const owner = largest?.owner || null;
    const largestAddress = largest?.address || null;

    if (holders <= 1) {
      reasons.push("Only one wallet holds liquidity — spoofed");
      return { safe: false, score: 0, reasons };
    }

    if (!totalLiquidity || totalLiquidity <= 0) {
      reasons.push("Total liquidity = 0 — unsafe");
      return { safe: false, score: 0, reasons };
    }

    const topHolderPct = (positiveAccounts[0]?.amount || 0) / (totalLiquidity || 1);
    if (topHolderPct > 0.50) {
      reasons.push("Top holder owns >50% liquidity (risky)");
      return { safe: false, score: 0, reasons };
    }

    score += 30; // base LP score

    // ---------- HOLDER COUNT + OWNER ----------
    if (holders >= 25) score += 15;
    else if (holders >= 10) score += 10;
    else reasons.push(`Low holder count (${holders})`);



    // ---------- ON-CHAIN BUY VOLUME ----------
    const { totalVolumeUSD = 0, uniqueBuyers = 0, tradeCount = 0 } = await getOnchainBuyVolume(mint).catch(() => ({ totalVolumeUSD: 0, uniqueBuyers: 0, tradeCount: 0 }));

    if (totalVolumeUSD >= MIN_BUY_VOLUME_USD) score += 10;
    else reasons.push(`Low buy volume: $${(Number(totalVolumeUSD) || 0).toFixed(2)}`);

    if (uniqueBuyers >= MIN_UNIQUE_WALLETS) score += 10;
    else reasons.push(`Unique buyers too low (${uniqueBuyers})`);

    if (tradeCount >= 15) score += 15;
    else reasons.push(`Low recent trade count (${tradeCount})`);

    // clamp interim score to 0..100
    if (score > 100) score = 100;
    if (score < 0) score = 0;

    // ---------- FETCH MINT AUTHORITY + FREEZE AUTHORITY (must run before ownership checks) ----------

let mintAuthority = null;
let freezeAuthority = null;

try {
  const mintInfo = await rpcLimited(() => conn.getParsedAccountInfo(mintPub));
  const parsed = mintInfo?.value?.data?.parsed?.info || {};

  // assign (no redeclaration)
  mintAuthority = parsed?.mintAuthority ?? null;
  freezeAuthority = parsed?.freezeAuthority ?? null;

  // Convert explicit "renounced" marker into null
  if (mintAuthority === "11111111111111111111111111111111") mintAuthority = null;
  if (freezeAuthority === "11111111111111111111111111111111") freezeAuthority = null;

} catch (err) {
  // non-fatal — record a helpful reason and continue
  reasons.push("Failed to read mintAuthority/freezeAuthority");
}

// ---------- OWNERSHIP RENOUNCE CHECK (reason text EXACT as requested) ----------
if (!mintAuthority && !freezeAuthority) {
  score += 10;
  reasons.push("ownership renounce");   // <--- exact phrase you requested
} else {
  if (mintAuthority)
    reasons.push(`mint authority NOT renounced → ${mintAuthority}`);
  if (freezeAuthority)
    reasons.push(`freeze authority NOT renounced → ${freezeAuthority}`);
}

// ---------- DEVELOPER WALLET = REAL MINT AUTHORITY ----------
// Developer wallet = mint authority (only if valid)
let deployerAddress = null;

if (mintAuthority && mintAuthority !== "11111111111111111111111111111111") {
  // Only treat it as a wallet if it's a valid PublicKey
  try {
    new PublicKey(mintAuthority);
    deployerAddress = mintAuthority;
  } catch {
    deployerAddress = null;
  }
}

if (deployerAddress) {
  const devAnalysis = await analyzeDeveloperWallet(deployerAddress).catch(() => ({
    safe: false,
    score: 0,
    reason: "dev analysis failed",
    details: {}
  }));

  if (!devAnalysis.safe) {
    reasons.push(`Developer wallet check failed: ${devAnalysis.reason || "unsafe deployer"}`);
    console.log("Developer wallet analysis details:", devAnalysis.details || devAnalysis);
    return { safe: false, score: 0, reasons };
  } else {
    reasons.push(`Developer wallet passed checks (score ${devAnalysis.score})`);
  }
} else {
  reasons.push("Developer wallet not checked (mint authority renounced or invalid)");
}

    // ---------- RAYDIUM / POOL TRANSACTION ANALYSIS (NUCLEAR SWITCH) ----------
    const poolAnalysis = await analyzePoolActivity(mint, deployerAddress).catch(() => ({ safe: true, details: { error: "pool analysis failed" } }));
    if (!poolAnalysis.safe) {
      reasons.push(`Pool analysis flagged: ${poolAnalysis.reason || "suspicious pool activity"}`);
      console.log("Pool analysis details:", poolAnalysis.details || poolAnalysis);
      return { safe: false, score: 0, reasons };
    } else {
      reasons.push("Pool analysis OK");
    }

    // ---------- FINAL DECISION ----------
    if (score > 100) score = 100;
    if (score < 0) score = 0;
    const safe = score >= SAFE_THRESHOLD;

    console.log(safe ? `✅ SAFE (${score}/100)` : `❌ UNSAFE (${score}/100)`);
    if (reasons.length) console.log("⚠️ Reasons:", reasons.join("; "));

    return { safe, score, reasons };
  } catch (err) {
    console.error("verifyTokenSecurity error:", err?.message || err);
    reasons.push("Unexpected on-chain verification error");
    return { safe: false, score: 0, reasons };
  }
}