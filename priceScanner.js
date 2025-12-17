import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";
import fetch from "node-fetch";

// ----------------------------- CONFIG -----------------------------
const POOL_FILE = path.resolve("./potential_migrators.json");

const RPC_URLS = [process.env.RPC_URL_7, process.env.RPC_URL_8].filter(Boolean);
if (!RPC_URLS.length) throw new Error("RPC_URL_7 or RPC_URL_8 required in .env");

const MAX_REQUESTS_PER_SEC = 6;
const rpcQueue = new PQueue({ interval: 1000, intervalCap: MAX_REQUESTS_PER_SEC });

let rpcIndex = 0;

// Round-robin RPC selector
function getConnection() {
  const url = RPC_URLS[rpcIndex % RPC_URLS.length];
  rpcIndex++;
  return new Connection(url, "confirmed");
}

// ----------------------------- UTIL -----------------------------
function readPools() {
  if (!fs.existsSync(POOL_FILE)) return [];
  return JSON.parse(fs.readFileSync(POOL_FILE, "utf8") || "[]");
}

function writePools(pools) {
  fs.writeFileSync(POOL_FILE, JSON.stringify(pools, null, 2));
}

// ----------------------------- ONCHAIN ORACLES -----------------------------
const PYTH_FEEDS = {
  "So11111111111111111111111111111111111111112": "J83GJ5u7oFz6A9qvMxxjQ7M7sxYgk7dQbUkgXH1xVSuM"
  // Add other token feeds here
};

const SWITCHBOARD_FEEDS = {
  "So11111111111111111111111111111111111111112": "SWITCHBOARD_PUBKEY_HERE"
  // Add other token feeds here
};

async function fetchOraclePrice(mint) {
  for (let i = 0; i < RPC_URLS.length; i++) {
    const conn = getConnection();
    try {
      // Pyth feed
      if (PYTH_FEEDS[mint]) {
        const info = await conn.getAccountInfo(new PublicKey(PYTH_FEEDS[mint]));
        if (info?.data) {
          const priceRaw = info.data.readBigInt64LE(208);
          const expo = info.data.readInt32LE(212);
          const price = Number(priceRaw) * 10 ** expo;
          if (price > 0) return price;
        }
      }

      // Switchboard feed (example: raw aggregator value)
      if (SWITCHBOARD_FEEDS[mint]) {
        const info = await conn.getAccountInfo(new PublicKey(SWITCHBOARD_FEEDS[mint]));
        if (info?.data) {
          // Parse switchboard aggregator data accordingly
          const price = Number(info.data.readBigInt64LE(64)); // example offset
          if (price > 0) return price;
        }
      }
    } catch (err) {
      console.warn(`RPC ${i + 1} failed for ${mint}:`, err.message);
    }
  }
  return null;
}

// ----------------------------- DEXSCREENER FALLBACK -----------------------------
async function fetchDexScreenerPrice(mint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: controller.signal }
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
  } finally {
    clearTimeout(timer);
  }
}
// ----------------------------- EXPORT -----------------------------
export async function scanMintFast(mintAddress, boughtAt = null) {
  let priceSOL = null;
  let priceUSD = null;

  // 1. Try on-chain oracles first (Pyth + Switchboard)
  priceUSD = await rpcQueue.add(() => fetchOraclePrice(mintAddress));

  if (priceUSD) {
    const solUSD = await rpcQueue.add(() =>
      fetchOraclePrice("So11111111111111111111111111111111111111112")
    );

    priceSOL = solUSD ? priceUSD / solUSD : null;

    // Overwrite price in JSON pool if exists
    const pools = readPools();
    const pool = pools.find(
      p => p.mintAddress === mintAddress || p.mintB === mintAddress
    );

    if (pool) {
      pool.priceSOL = priceSOL;
      pool.priceUSD = priceUSD;
      writePools(pools);
    }
  }

  // 2. DexScreener fallback ONLY if token already bought within 1–6 minutes
  const now = Date.now();
  if ((!priceSOL || !priceUSD) && boughtAt && now - boughtAt <= 6 * 60_000) {
    const dexPrice = await fetchDexScreenerPrice(mintAddress);
    if (dexPrice) {
      priceUSD = dexPrice;
      const solUSD = await fetchDexScreenerPrice(
        "So11111111111111111111111111111111111111112"
      );
      priceSOL = solUSD ? dexPrice / solUSD : null;
    }
  }

  return { priceSOL, priceUSD };
}