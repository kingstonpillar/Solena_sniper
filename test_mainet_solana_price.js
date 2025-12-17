import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { scanMintFast } from "./priceScanner.js";

// ---------------- CONFIG ----------------

// Prefer explicit mainnet RPCs
const RPC =
  process.env.RPC_URL_7 ||
  process.env.RPC_URL_8 ||
  "https://api.mainnet-beta.solana.com";

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Pyth SOL/USD mainnet price account
// (this is the canonical mainnet feed)
const PYTH_SOL_USD = new PublicKey(
  "J83GJ5u7oFz6A9qvMxxjQ7M7sxYgk7dQbUkgXH1xVSuM"
);

// ---------------- TEST ----------------
(async () => {
  console.log("🔌 Connecting to MAINNET Solana RPC...");
  const conn = new Connection(RPC, {
    commitment: "confirmed",
    disableRetryOnRateLimit: false,
  });

  // 1️⃣ RPC health check
  const slot = await conn.getSlot();
  console.log("✅ RPC OK | Current slot:", slot);

  // 2️⃣ Hard Pyth SOL/USD proof (raw account read)
  console.log("🔍 Fetching Pyth SOL/USD price account...");
  const info = await conn.getAccountInfo(PYTH_SOL_USD);

  if (!info?.data) {
    throw new Error("Failed to fetch Pyth SOL/USD account (mainnet)");
  }

  /**
   * Pyth price layout (simplified):
   * price @ offset 208 (i64)
   * exponent @ offset 212 (i32)
   */
  const priceRaw = info.data.readBigInt64LE(208);
  const expo = info.data.readInt32LE(212);
  const solUsd = Number(priceRaw) * 10 ** expo;

  console.log(`✅ Pyth SOL/USD price (raw): $${solUsd}`);

  // 3️⃣ scanMintFast end-to-end test (real pools, real RPC)
  console.log("🚀 Running scanMintFast(SOL) on MAINNET...");
  const start = Date.now();

  const result = await scanMintFast(SOL_MINT, start);

  const latency = Date.now() - start;

  console.log("📊 scanMintFast result:");
  console.dir(result, { depth: null });

  console.log(`⏱️ scanMintFast latency: ${latency} ms`);

  if (!result?.priceUSD) {
    throw new Error("scanMintFast FAILED to return real SOL price");
  }

  console.log("✅ MAINNET PRICE TEST PASSED");
  process.exit(0);
})().catch(err => {
  console.error("❌ MAINNET TEST FAILED:");
  console.error(err.message || err);
  process.exit(1);
});