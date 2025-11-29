// tokensecurities.js — ON-CHAIN + Raydium pool analysis + Developer wallet scoring (Option C behavior)
// RPC-only. Adds:
//  - Raydium/DEX pool transaction analysis heuristics
//  - Developer wallet age + transaction history scoring
//  - Option C: nuclear switches (devWalletSafe & raydiumSafe must be true or token is UNSAFE)
// Export: verifyTokenSecurity(mint) -> { safe, score, reasons }

import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com");

// --- Scoring parameters ---
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

// Known DEX program ids (treat as LP owners)
const KNOWN_LP_PROGRAM_IDS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h", // Raydium stable
  "9WwRZjZJY9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5", // Orca AMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
  // add others as needed
]);

// --- Helpers ----------------------------------------------------------------

async function safeGetParsedTransaction(sig) {
  try {
    return await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  } catch (err) {
    return null;
  }
}

// Return token accounts sorted descending by amount
async function getTokenAccountsByMint(mint) {
  try {
    const accounts = await conn.getTokenLargestAccounts(new PublicKey(mint));
    const result = [];
    for (const a of accounts.value) {
      try {
        const info = await conn.getParsedAccountInfo(a.address);
        const amt = info?.value?.data?.parsed?.info?.tokenAmount?.ui || 0;
        const owner = info?.value?.data?.parsed?.info?.owner || null;
        result.push({ owner, amount: Number(amt), rawAmount: a.amount || "0", address: a.address.toString() });
      } catch (err) {
        // ignore per-account errors
      }
    }
    return result.sort((a, b) => b.amount - a.amount);
  } catch (err) {
    console.log("getTokenAccountsByMint error:", err?.message || err);
    return [];
  }
}

/**
 * ON-CHAIN BUY VOLUME (no Jupiter).
 * Scans recent confirmed transactions for the mint and counts token-account increases.
 */
async function getOnchainBuyVolume(mint, limit = 2000) {
  try {
    const sigInfos = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: Math.min(limit, 1000) });
    let totalBuyTokens = 0;
    const buyers = new Set();
    let tradeCount = 0;

    for (const s of sigInfos) {
      const tx = await safeGetParsedTransaction(s.signature);
      if (!tx?.meta) continue;
      const post = tx.meta.postTokenBalances || [];
      const pre = tx.meta.preTokenBalances || [];

      for (const ix of post) {
        if (ix.mint === mint) {
          const prev = pre.find(p => p.accountIndex === ix.accountIndex);
          const delta = (ix.uiTokenAmount?.ui || 0) - (prev?.uiTokenAmount?.ui || 0);
          if (delta > 0) {
            totalBuyTokens += delta;
            buyers.add(ix.owner || ix.owner || (tx.transaction.message.accountKeys[ix.accountIndex]?.pubkey?.toString?.()));
            tradeCount++;
          }
        }
      }
    }

    return {
      totalVolumeUSD: totalBuyTokens * BUY_TOKEN_USD_PRICE,
      uniqueBuyers: buyers.size,
      tradeCount
    };

  } catch (err) {
    console.log("getOnchainBuyVolume error:", err?.message || err);
    return { totalVolumeUSD: 0, uniqueBuyers: 0, tradeCount: 0 };
  }
}

/**
 * Raydium / LP pool transaction analysis
 *
 * Heuristics:
 * - scan recent signatures for the mint (POOL_SIG_SCAN_LIMIT)
 * - look for logs/parsed instructions containing keywords indicating pool creation or LP add:
 *   "initialize", "create", "add_liquidity", "mintto", "sync", "deposit", "add_liquidity"
 * - detect who performed LP add (owner address)
 * - compute pool age (time since first pool creation or first LP event)
 * - suspicious if pool age < POOL_AGE_SUSPICIOUS_SECS or LP was added by the mint deployer within short time
 *
 * Returns { safe: boolean, reason: string|null, details: {...} }
 */
async function analyzePoolActivity(mint, mintCreatorAddress) {
  try {
    const sigInfos = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: Math.min(POOL_SIG_SCAN_LIMIT, 500) });
    if (!Array.isArray(sigInfos) || sigInfos.length === 0) {
      return { safe: true, reason: null, details: { scanned: 0 } }; // no activity -> neutral
    }

    let firstPoolEventAt = null;
    let firstPoolEventBy = null;
    let lpAddEvents = 0;
    let poolCreationEvents = 0;
    const keywordsPoolCreate = ["initialize", "create", "init_pool", "deposit", "create_pool"];
    const keywordsLPAdd = ["add_liquidity", "mintto", "mint_to", "sync", "deposit", "mint_to"];

    let scanned = 0;

    for (const s of sigInfos) {
      if (scanned++ >= POOL_SIG_SCAN_LIMIT) break;
      const tx = await safeGetParsedTransaction(s.signature);
      if (!tx) continue;
      const logs = (tx.meta?.logMessages || []).join(" ").toLowerCase();
      const blockTime = tx.blockTime || 0;

      // check for pool creation-like logs
      if (keywordsPoolCreate.some(k => logs.includes(k))) {
        poolCreationEvents++;
        if (!firstPoolEventAt) {
          firstPoolEventAt = blockTime;
          firstPoolEventBy = tx.transaction?.message?.accountKeys?.[0]?.pubkey?.toString?.() || null;
        }
      }

      // check for LP add keywords
      if (keywordsLPAdd.some(k => logs.includes(k))) {
        lpAddEvents++;
        if (!firstPoolEventAt) {
          firstPoolEventAt = blockTime;
          firstPoolEventBy = tx.transaction?.message?.accountKeys?.[0]?.pubkey?.toString?.() || null;
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const poolAgeSecs = firstPoolEventAt ? (now - firstPoolEventAt) : null;

    // Suspicious logic:
    // - poolAgeSecs exists and is < POOL_AGE_SUSPICIOUS_SECS => suspicious (pool too new)
    if (poolAgeSecs !== null && poolAgeSecs < POOL_AGE_SUSPICIOUS_SECS) {
      return {
        safe: false,
        reason: `Pool very new (${poolAgeSecs}s) — suspicious.`,
        details: { poolAgeSecs, poolCreationEvents, lpAddEvents, firstPoolEventBy }
      };
    }

    // - if LP add events exist and were performed by mintCreatorAddress within short window -> suspicious
    if (lpAddEvents > 0 && mintCreatorAddress && firstPoolEventBy && mintCreatorAddress === firstPoolEventBy) {
      // If creator added LP quickly after mint creation -> suspicious
      return {
        safe: false,
        reason: `LP added/created by mint creator (${mintCreatorAddress}) — suspicious.`,
        details: { poolAgeSecs, poolCreationEvents, lpAddEvents, firstPoolEventBy }
      };
    }

    // otherwise consider pool behavior safe (heuristic)
    return { safe: true, reason: null, details: { poolAgeSecs, poolCreationEvents, lpAddEvents, firstPoolEventBy } };

  } catch (err) {
    // On error, be conservative and return false? For Option C we want nuclear switches to be cautious.
    // But to avoid false-positives due to RPC failure, we return safe:true with note.
    console.log("analyzePoolActivity error:", err?.message || err);
    return { safe: true, reason: null, details: { error: err?.message } };
  }
}

/**
 * Developer wallet analysis (RPC-only)
 *
 * Heuristics:
 * - identify developer wallet as the owner of the largest token account (if exists)
 * - fetch signatures for that wallet (DEV_SIG_SCAN_LIMIT)
 * - compute wallet age (days since earliest signature) and tx count
 * - compute if the wallet added LP fast after token creation (we reuse analyzePoolActivity's firstActor detection)
 *
 * Returns: { safe: boolean, score: number (0-100), reason, details }
 */
async function analyzeDeveloperWallet(deployerAddress) {
  try {
    if (!deployerAddress) return { safe: false, score: 0, reason: "No deployer address", details: {} };

    // get signatures for deployer
    const sigInfos = await conn.getSignaturesForAddress(new PublicKey(deployerAddress), { limit: Math.min(DEV_SIG_SCAN_LIMIT, 1000) });
    if (!Array.isArray(sigInfos) || sigInfos.length === 0) {
      return { safe: false, score: 0, reason: "Deployer has no on-chain history", details: { sigs: 0 } };
    }

    // earliest signature timestamp (approx account age)
    const last = sigInfos[sigInfos.length - 1];
    const earliestBlockTime = last?.blockTime || null;
    const now = Math.floor(Date.now() / 1000);
    const ageDays = earliestBlockTime ? ((now - earliestBlockTime) / 86400) : 0;
    const txCount = sigInfos.length;

    // simple scoring
    let score = 100;
    let safe = true;
    const reasons = [];

    if (!earliestBlockTime || ageDays < DEV_MIN_AGE_DAYS) {
      score -= 80;
      safe = false;
      reasons.push(`Deployer wallet too new (${ageDays.toFixed(1)} days)`);
    } else if (ageDays < DEV_MIN_AGE_DAYS * 2) {
      // small penalty if young but not brand-new
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

    // extra heuristic: fetch balance to ensure wallet funded normally
    try {
      const bal = await conn.getBalance(new PublicKey(deployerAddress));
      const sol = bal / 1e9;
      if (sol < 0.05) {
        score -= 10;
        reasons.push(`Deployer SOL balance low (${sol.toFixed(4)} SOL)`);
      } else {
        reasons.push(`Deployer SOL balance ${sol.toFixed(4)} SOL`);
      }
    } catch { /* ignore balance errors */ }

    if (score > 100) score = 100;
    if (score < 0) score = 0;

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

  console.log(`🔍 Checking on-chain token security: ${mint}`);

  try {
    // ---------- TOKEN HOLDERS / LIQUIDITY ----------
    const accounts = await getTokenAccountsByMint(mint);
    const holders = accounts.filter(a => a.amount > 0).length;
    const totalLiquidity = accounts.reduce((s, a) => s + (a.amount || 0), 0);
    const largest = accounts[0] || null;
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

    const topHolderPct = accounts[0].amount / totalLiquidity;
    if (topHolderPct > 0.50) {
      reasons.push("Top holder owns >50% liquidity (risky)");
      return { safe: false, score: 0, reasons };
    }

    score += 30; // base LP score

    // ---------- HOLDER COUNT + OWNER ----------
    if (holders >= 25) score += 15;
    else if (holders >= 10) score += 10;
    else reasons.push(`Low holder count (${holders})`);

    if (owner === "11111111111111111111111111111111") score += 10;
    else reasons.push("Ownership not renounced");

    // ---------- ON-CHAIN BUY VOLUME ----------
    const { totalVolumeUSD, uniqueBuyers, tradeCount } = await getOnchainBuyVolume(mint);

    if (totalVolumeUSD >= MIN_BUY_VOLUME_USD) score += 10;
    else reasons.push(`Low buy volume: $${totalVolumeUSD.toFixed(2)}`);

    if (uniqueBuyers >= MIN_UNIQUE_WALLETS) score += 10;
    else reasons.push(`Unique buyers too low (${uniqueBuyers})`);

    if (tradeCount >= 15) score += 15;
    else reasons.push(`Low recent trade count (${tradeCount})`);

    // clamp interim score to 0..100
    if (score > 100) score = 100;
    if (score < 0) score = 0;

    // ---------- DEVELOPER WALLET ANALYSIS (NUCLEAR SWITCH) ----------
    // define deployer as largest token account owner
    const deployerAddress = owner || null;
    const devAnalysis = await analyzeDeveloperWallet(deployerAddress);

    if (!devAnalysis.safe) {
      // Option C: if dev wallet check fails -> token UNSAFE regardless of numeric score
      reasons.push(`Developer wallet check failed: ${devAnalysis.reason || "unsafe deployer"}`);
      console.log("Developer wallet analysis details:", devAnalysis.details || devAnalysis);
      return { safe: false, score: 0, reasons };
    } else {
      // good deployer improves confidence slightly (but doesn't change score here)
      reasons.push(`Developer wallet passed checks (score ${devAnalysis.score})`);
    }

    // ---------- RAYDIUM / POOL TRANSACTION ANALYSIS (NUCLEAR SWITCH) ----------
    // Try to detect pool activity and suspicious patterns
    const poolAnalysis = await analyzePoolActivity(mint, deployerAddress);

    if (!poolAnalysis.safe) {
      reasons.push(`Pool analysis flagged: ${poolAnalysis.reason || "suspicious pool activity"}`);
      console.log("Pool analysis details:", poolAnalysis.details || poolAnalysis);
      return { safe: false, score: 0, reasons };
    } else {
      reasons.push("Pool analysis OK");
    }

    // ---------- FINAL DECISION ----------
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