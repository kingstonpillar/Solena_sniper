// solPriceFetcher.js
import { Connection, PublicKey } from "@solana/web3.js";

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL_1 || "https://api.mainnet-beta.solana.com";
const SOL_PYTH_PRICE_ACCOUNT = new PublicKey("J83w4HKfqxwc1ySTtwE4u2QZpM3X4PzZsZ2F1F8oVQ6F"); // Official SOL/USD mainnet price feed
const CACHE_MS = 10_000; // cache 10 seconds

// ---------------- STATE ----------------
let cachedPrice = null;
let lastFetch = 0;
const conn = new Connection(RPC_URL, "confirmed");

// ---------------- UTIL ----------------
function decodePythPrice(data) {
  // Pyth price struct: https://docs.pyth.network/documentation/consumers/reading-prices
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const price = view.getBigInt64(208, true); // offset of price
  const expo = view.getInt32(212, true);     // offset of expo
  return Number(price) * 10 ** expo;
}

// ---------------- FETCH FUNCTION ----------------
export async function fetchSolPriceUSD() {
  const now = Date.now();
  if (cachedPrice && now - lastFetch < CACHE_MS) return cachedPrice;

  try {
    const accountInfo = await conn.getAccountInfo(SOL_PYTH_PRICE_ACCOUNT);
    if (!accountInfo || !accountInfo.data) {
      console.warn("SOL Pyth account missing data");
      return null;
    }

    const price = decodePythPrice(accountInfo.data);
    if (!Number.isFinite(price) || price <= 0) return null;

    cachedPrice = price;
    lastFetch = now;
    return price;
  } catch (err) {
    console.error("fetchSolPriceUSD error:", err?.message || err);
    return null;
  }
}