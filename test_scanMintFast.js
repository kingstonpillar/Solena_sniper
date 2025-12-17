import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { scanMintFast } from "./priceScanner.js"; // adjust name if needed

// ---------------- CONFIG ----------------
const RPC = process.env.RPC_URL_7 || process.env.RPC_URL_8;
if (!RPC) {
  console.error("❌ RPC_URL_7 or RPC_URL_8 missing");
  process.exit(1);
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

// ---------------- TEST ----------------
(async () => {
  console.log("🔌 Connecting to Solana RPC...");
  const conn = new Connection(RPC, "confirmed");

  // 1️⃣ Basic RPC health check
  const slot = await conn.getSlot();
  console.log("✅ RPC OK | Current slot:", slot);

  // 2️⃣ Raw Pyth account check (hard proof)
  const PYTH_SOL_FEED = new PublicKey(
    "J83GJ5u7oFz6A9qvMxxjQ7M7sxYgk7dQbUkgXH1xVSuM"
  );

  const info = await conn.getAccountInfo(PYTH_SOL_FEED);
  if (!info?.data) {
    console.error("❌ Failed to fetch Pyth SOL account");
    process.exit(1);
  }

  const priceRaw = info.data.readBigInt64LE(208);
  const expo = info.data.readInt32LE(212);
  const solPrice = Number(priceRaw) * 10 ** expo;

  console.log("✅ Pyth SOL/USD price:", solPrice);

  // 3️⃣ scanMintFast end-to-end test
  console.log("🚀 Running scanMintFast()...");
  const result = await scanMintFast(SOL_MINT, Date.now());

  console.log("📊 scanMintFast result:");
  console.log(result);

  if (!result?.priceUSD) {
    console.error("❌ scanMintFast FAILED to return price");
    process.exit(1);
  }

  console.log("✅ scanMintFast WORKING CORRECTLY");
  process.exit(0);
})().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});