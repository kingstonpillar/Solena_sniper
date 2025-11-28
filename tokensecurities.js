import { Connection, PublicKey } from "@solana/web3.js";

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com");

// --- Scoring parameters ---
const MIN_UNIQUE_WALLETS = 3;
const MIN_BUY_VOLUME_USD = 200;
const BUY_TOKEN_USD_PRICE = 1;    // assume 1$ per token if no oracle used
const SAFE_THRESHOLD = 75;

// --- Read token holders from on-chain accounts ---
async function getTokenAccountsByMint(mint) {
  try {
    const accounts = await conn.getTokenLargestAccounts(new PublicKey(mint));
    const result = [];

    for (const a of accounts.value) {
      const info = await conn.getParsedAccountInfo(a.address);

      const amount = info.value?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      const owner = info.value?.data?.parsed?.info?.owner;

      result.push({ owner, amount });
    }

    return result.sort((a, b) => b.amount - a.amount);
  } catch (err) {
    console.log("getTokenAccountsByMint error:", err);
    return [];
  }
}

/**
 * ✔ ON-CHAIN BUY VOLUME (NO JUPITER)
 * ----------------------------------
 * We scan recent confirmed transactions involving the mint.
 * We detect BUY events by:
 *  - Token account increase for a wallet (token delta > 0)
 *  - Unique buyer = distinct wallet receiving
 */
async function getOnchainBuyVolume(mint, limit = 2000) {
  try {
    const signatures = await conn.getSignaturesForAddress(
      new PublicKey(mint),
      { limit }
    );

    let totalBuyTokens = 0;
    const buyers = new Set();
    let tradeCount = 0;

    for (const sig of signatures) {
      const tx = await conn.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0
      });

      if (!tx?.meta) continue;

      for (const ix of tx.meta.postTokenBalances) {
        if (ix.mint === mint) {
          const pre = tx.meta.preTokenBalances.find(p => p.accountIndex === ix.accountIndex);
          const delta =
            ix.uiTokenAmount.uiAmount - (pre?.uiTokenAmount?.uiAmount || 0);

          if (delta > 0) {
            totalBuyTokens += delta;
            buyers.add(ix.owner);
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
    console.log("getOnchainBuyVolume error:", err);
    return { totalVolumeUSD: 0, uniqueBuyers: 0, tradeCount: 0 };
  }
}

export async function verifyTokenSecurity(mint) {
  const reasons = [];
  let score = 0;

  console.log(`🔍 Checking on-chain token security: ${mint}`);

  try {
    // -----------------------------
    // 1️⃣ TOKEN HOLDERS / LIQUIDITY
    // -----------------------------
    const accounts = await getTokenAccountsByMint(mint);

    const holders = accounts.filter(a => a.amount > 0).length;
    const totalLiquidity = accounts.reduce((s, a) => s + a.amount, 0);
    const owner = accounts[0]?.owner;

    if (holders <= 1) {
      reasons.push("Only one wallet holds liquidity — spoofed");
      return { safe: false, score: 0, reasons };
    }

    const topHolderPct = accounts[0].amount / totalLiquidity;
    if (topHolderPct > 0.70) {
      reasons.push("Top holder owns >70% liquidity (risky)");
      return { safe: false, score: 0, reasons };
    }

    score += 30; // base LP score

    // -----------------------------
    // 2️⃣ HOLDER COUNT + OWNER
    // -----------------------------
    if (holders >= 25) score += 15;
    else if (holders >= 10) score += 10;
    else reasons.push(`Low holder count (${holders})`);

    if (owner === "11111111111111111111111111111111") score += 10;
    else reasons.push("Ownership not renounced");

    // -----------------------------
    // 3️⃣ ON-CHAIN BUY VOLUME
    // -----------------------------
    const { totalVolumeUSD, uniqueBuyers, tradeCount } =
      await getOnchainBuyVolume(mint);

    if (totalVolumeUSD >= MIN_BUY_VOLUME_USD) score += 10;
    else reasons.push(`Low buy volume: $${totalVolumeUSD.toFixed(2)}`);

    if (uniqueBuyers >= MIN_UNIQUE_WALLETS) score += 10;
    else reasons.push(`Unique buyers too low (${uniqueBuyers})`);

    if (tradeCount >= 15) score += 15;
    else reasons.push(`Low recent trade count (${tradeCount})`);

  } catch (err) {
    reasons.push("Unexpected on-chain verification error");
  }

  const safe = score >= SAFE_THRESHOLD;

  console.log(safe ? `✅ SAFE (${score}/100)` : `❌ UNSAFE (${score}/100)`);
  if (reasons.length) console.log("⚠️ Reasons:", reasons.join("; "));

  return { safe, score, reasons };
}