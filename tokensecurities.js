import fetch from "node-fetch";
import PQueue from "p-queue";

// --- CONFIG (UPDATED) ---
const BASE_LIQUIDITY_USD = 15000;    
const SAFE_LIQUIDITY_USD = 20000;     

const MIN_UNIQUE_WALLETS = 3;
const MIN_BUY_VOLUME_USD = 200;

// --- RATE LIMITER FOR BIRDEYE (1 request/sec) ---
const birdeyeQueue = new PQueue({ interval: 1000, intervalCap: 1 });

// Wrap all Birdeye fetches
async function fetchBirdeye(url) {
  return birdeyeQueue.add(async () => {
    const res = await fetch(url, { headers: { "x-chain": "solana" } });
    return res.json();
  });
}

export async function verifyTokenSecurity(mint) {
  const reasons = [];
  let score = 0;

  console.log(`🔍 Checking token security for: ${mint}`);

  try {
    // =====================================================
    // 1️⃣ TOKEN BASE INFO (LIQUIDITY, HOLDERS, OWNER)
    // =====================================================
    const data = await fetchBirdeye(`https://public-api.birdeye.so/public/token/${mint}`);
    if (!data?.data) {
      reasons.push("Token data unavailable");
      return { safe: false, score: 0, reasons };
    }

    const token = data.data;
    const liquidity = token.liquidity ?? 0;
    const holders = token.holder ?? token.holders ?? 0;
    const owner = token.owner ?? null;

    // -----------------------------
    // SCORING BLOCK 1 (Max 25 pts)
    // -----------------------------
    if (liquidity >= SAFE_LIQUIDITY_USD) score += 10;
    else if (liquidity >= BASE_LIQUIDITY_USD) score += 6;
    else reasons.push(`Low liquidity ($${liquidity.toFixed(0)})`);

    if (holders >= 50) score += 7;
    else if (holders >= 10) score += 4;
    else reasons.push(`Too few holders (${holders})`);

    if (owner === "11111111111111111111111111111111") score += 8;
    else reasons.push("Ownership not renounced");

    // =====================================================
    // 2️⃣ BUYER MOMENTUM + FAKE VOLUME DETECTION
    // =====================================================
    const tradeData = await fetchBirdeye(
      `https://public-api.birdeye.so/public/defi/token_activity?address=${mint}&type=buy&offset=0&limit=50`
    );

    const buys = tradeData?.data ?? [];
    const uniqueWallets = new Set(buys.map(b => b.trader)).size;
    const totalVolume = buys.reduce((sum, tx) => sum + (tx.amount_usd ?? 0), 0);

    const walletCount = {};
    for (const b of buys) walletCount[b.trader] = (walletCount[b.trader] || 0) + 1;

    const topWalletBuys = Math.max(...Object.values(walletCount), 0);
    if (topWalletBuys > buys.length * 0.5) {
      reasons.push("Fake volume: 1 wallet doing >50% of buys");
      return { safe: false, score: 0, reasons };
    }

    if (uniqueWallets <= 2) {
      reasons.push("Fake volume: Very few unique buyers");
      return { safe: false, score: 0, reasons };
    }

    const avgBuy = totalVolume / (buys.length || 1);
    if (avgBuy > 5000) {
      reasons.push("Fake volume: Unrealistic average buy size");
      return { safe: false, score: 0, reasons };
    }

    const washTrade = Object.values(walletCount).some(c => c >= 5);
    if (washTrade) {
      reasons.push("Fake volume: Wash trading detected");
      return { safe: false, score: 0, reasons };
    }

    if (uniqueWallets >= MIN_UNIQUE_WALLETS + 2) score += 10;
    else if (uniqueWallets >= MIN_UNIQUE_WALLETS) score += 6;
    else reasons.push("Low buyer diversity");

    if (totalVolume >= MIN_BUY_VOLUME_USD * 3) score += 15;
    else if (totalVolume >= MIN_BUY_VOLUME_USD) score += 10;
    else reasons.push(`Low buy volume ($${totalVolume.toFixed(0)})`);

    // =====================================================
    // 3️⃣ FAKE / SPOOFED LIQUIDITY DETECTION
    // =====================================================
    let lpInfo;
    try {
      lpInfo = await fetchBirdeye(
        `https://public-api.birdeye.so/public/mint/holders?address=${mint}&offset=0&limit=20`
      );
    } catch {
      reasons.push("Unable to fetch LP holder data");
    }

    const lpHolders = lpInfo?.data?.items ?? [];
    const lpOwned = lpHolders.reduce((sum, h) => sum + (h.amount ?? 0), 0);

    const lpBurned = lpHolders.find(h => h.owner === "11111111111111111111111111111111");
    if (!lpBurned) {
      reasons.push("LP not burned — liquidity removable");
      return { safe: false, score: 0, reasons };
    }

    if (lpHolders.length <= 1) {
      reasons.push("Only 1 wallet holds LP — spoofed liquidity");
      return { safe: false, score: 0, reasons };
    }

    const topLp = lpHolders[0]?.amount ?? 0;
    if (topLp > lpOwned * 0.7) {
      reasons.push("Single wallet owns majority LP");
      return { safe: false, score: 0, reasons };
    }

    if (liquidity >= SAFE_LIQUIDITY_USD && liquidity <= SAFE_LIQUIDITY_USD * 1.1 && holders < 5) {
      reasons.push("Possible FLASH liquidity — no organic buyers");
      return { safe: false, score: 0, reasons };
    }

    if (liquidity > 20000 && totalVolume < 100) {
      reasons.push("Spoofed liquidity: high liquidity but no trading");
      return { safe: false, score: 0, reasons };
    }

    score += 20;

    // =====================================================
    // 4️⃣ HONEYPOT CHECK (JUPITER)
    // =====================================================
    try {
      const honeyRes = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`);
      const honeyData = await honeyRes.json();

      if (honeyRes.ok && honeyData?.[mint]?.price) score += 10;
      else reasons.push("Failed Jupiter price check (possible honeypot)");
    } catch {
      reasons.push("Jupiter price API fetch failed");
    }

  } catch (err) {
    console.error("❌ Security check failed:", err.message);
    reasons.push("Unexpected verification error");
  }

  const safe = score >= 85;
  console.log(safe ? `✅ Token SAFE (${score}/100)` : `🚫 Token UNSAFE (${score}/100)`);
  if (reasons.length) console.log("⚠️ Reasons:", reasons.join("; "));

  return { safe, score, reasons };
}