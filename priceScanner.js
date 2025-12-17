import PQueue from "p-queue";
import fetch from "node-fetch";
import { PriceServiceConnection } from "@pythnetwork/price-service-client";

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 8 });

// ---------------- PYTH HERMES ----------------
const PYTH_HERMES = new PriceServiceConnection(
  "https://hermes.pyth.network",
  { timeout: 3000 }
);

// Mainnet price feed IDs
const PYTH_FEEDS = {
  "So11111111111111111111111111111111111111112":
    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
  // add token feeds here
};

// ---------------- HERMES FETCH ----------------
async function fetchPythHermesPrice(mintAddress) {
  const feedId = PYTH_FEEDS[mintAddress];
  if (!feedId) return null;

  try {
    const feeds = await PYTH_HERMES.getLatestPriceFeeds([feedId]);
    if (!feeds?.length) return null;

    const p = feeds[0].getPriceUnchecked();
    if (!p?.price) return null;

    return Number(p.price) * 10 ** p.expo;
  } catch {
    return null;
  }
}

// ---------------- DEXSCREENER FALLBACK ----------------
async function fetchDexScreenerPrice(mint) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 5000 }
    );
    if (!res.ok) return null;

    const json = await res.json();
    if (!json?.pairs?.length) return null;

    const bestPair = json.pairs.reduce((a, b) =>
      (b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a
    );

    const price = Number(bestPair.priceUsd);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

// ---------------- EXPORT ----------------
export async function scanMintFast(mintAddress, boughtAt = null) {
  let priceUSD = null;
  let priceSOL = null;

  // 1️⃣ Hermes (primary)
  priceUSD = await rpcQueue.add(() =>
    fetchPythHermesPrice(mintAddress)
  );

  if (priceUSD) {
    const solUSD = await rpcQueue.add(() =>
      fetchPythHermesPrice("So11111111111111111111111111111111111111112")
    );
    priceSOL = solUSD ? priceUSD / solUSD : null;
  }

  // 2️⃣ DexScreener fallback (short window only)
  const now = Date.now();
  if ((!priceUSD || !priceSOL) && boughtAt && now - boughtAt < 6 * 60_000) {
    const dexPrice = await fetchDexScreenerPrice(mintAddress);
    if (dexPrice) {
      const solUSD = await fetchDexScreenerPrice(
        "So11111111111111111111111111111111111111112"
      );
      priceUSD = dexPrice;
      priceSOL = solUSD ? dexPrice / solUSD : null;
    }
  }

  return { priceSOL, priceUSD };
}