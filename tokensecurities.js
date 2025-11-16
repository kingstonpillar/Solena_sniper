// tokensecurities.js
// Performs token safety checks and computes a safety score (0–100)
// NO TIME WINDOW, NO MOMENTUM BASED ON SECONDS — only fundamentals + demand strength

import fetch from "node-fetch";
import { Connection } from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL;
const conn = new Connection(RPC_URL);

// --- CONFIG ---
const BASE_LIQUIDITY_USD = 5000;     // Minimum acceptable liquidity
const SAFE_LIQUIDITY_USD = 10000;    // Strong token liquidity

const MIN_UNIQUE_WALLETS = 3;        // How many different wallets must buy
const MIN_BUY_VOLUME_USD = 200;      // Minimum total buy volume

export async function verifyTokenSecurity(mint) {
  const reasons = [];
  let score = 0;

  console.log(`🔍 Checking token security for: ${mint}`);

  try {
    // =====================================================
    // 1️⃣ Fetch token info (liquidity / holders / owner)
    // =====================================================
    const res = await fetch(`https://public-api.birdeye.so/public/token/${mint}`, {
      headers: { "x-chain": "solana" },
    });
    const data = await res.json();

    if (!data?.data) {
      reasons.push("Token data unavailable");
      return { safe: false, score: 0, reasons };
    }

    const token = data.data;

    const liquidity = token.liquidity ?? 0;
    const holders = token.holder ?? token.holders ?? 0;
    const owner = token.owner ?? null;

    // ✅ Liquidity scoring
    if (liquidity >= SAFE_LIQUIDITY_USD) score += 25;
    else if (liquidity >= BASE_LIQUIDITY_USD) score += 15;
    else reasons.push(`Low liquidity ($${liquidity.toFixed(0)})`);

    // ✅ Holder count scoring
    if (holders >= 50) score += 20;
    else if (holders >= 10) score += 10;
    else reasons.push(`Too few holders (${holders})`);

    // ✅ Ownership renounced scoring
    if (owner && owner === "11111111111111111111111111111111") {
      score += 25;
    } else {
      reasons.push("Ownership not renounced");
    }

    // =====================================================
    // 2️⃣ BUYER MOMENTUM (NO TIME WINDOW)
    // =====================================================
    const tradeRes = await fetch(
      `https://public-api.birdeye.so/public/defi/token_activity?address=${mint}&type=buy&offset=0&limit=50`,
      { headers: { "x-chain": "solana" } }
    );
    const tradeData = await tradeRes.json();

    const buys = tradeData?.data ?? [];
    const uniqueWallets = new Set(buys.map(b => b.trader)).size;
    const totalVolume = buys.reduce((sum, tx) => sum + (tx.amount_usd ?? 0), 0);

    // ✅ WALLET DIVERSITY SCORE
    if (uniqueWallets >= MIN_UNIQUE_WALLETS + 2) score += 15;
    else if (uniqueWallets >= MIN_UNIQUE_WALLETS) score += 10;
    else reasons.push("Low buyer diversity (likely whale push)");

    // ✅ BUY VOLUME SCORE
    if (totalVolume >= MIN_BUY_VOLUME_USD * 3) score += 15;
    else if (totalVolume >= MIN_BUY_VOLUME_USD) score += 10;
    else reasons.push(`Low buy volume ($${totalVolume.toFixed(0)})`);

    // =====================================================
    // 3️⃣ Honeypot check via Jupiter swap routing
    // =====================================================
    try {
      const honeyRes = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`);
      const honeyData = await honeyRes.json();
      if (honeyRes.ok && honeyData?.[mint]?.price) {
        score += 10;
      } else {
        reasons.push("Failed swap route check or invalid price (possible honeypot)");
      }
    } catch {
      reasons.push("Jupiter API fetch failed (possible honeypot)");
    }

  } catch (err) {
    console.error("❌ Security check failed:", err.message);
    reasons.push("Error during verification");
  }

  const safe = score >= 70;

  console.log(
    safe ? `✅ Token SAFE (${score}/100)` : `🚫 Token UNSAFE (${score}/100)`
  );

  if (reasons.length > 0) console.log("⚠️ Reasons:", reasons.join("; "));

  return { safe, score, reasons };
}