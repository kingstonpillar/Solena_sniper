import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { PythHttpClient } from "@pythnetwork/client";
import { scanMintFast } from "./priceScanner.js";

// ---------------- CONFIG ----------------
const RPC =
  process.env.RPC_URL_7 ||
  process.env.RPC_URL_8 ||
  "https://api.mainnet-beta.solana.com";

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Official Pyth program (mainnet)
const PYTH_PROGRAM_ID = new PublicKey(
  "FsJ3A3u2vn5J6A3xWgZ9D8S4pYHnZKpX8X9y8uYJ1Z6"
);

// ---------------- TEST ----------------
(async () => {
  console.log("🔌 Connecting to MAINNET Solana RPC...");
  const connection = new Connection(RPC, "confirmed");

  const slot = await connection.getSlot();
  console.log("✅ RPC OK | Current slot:", slot);

  // ---------------- PYTH PRICE ----------------
  console.log("🔍 Fetching SOL/USD from Pyth Price Service...");

  const pythClient = new PythHttpClient(connection, PYTH_PROGRAM_ID);
  const data = await pythClient.getData();

  const solProduct = Object.values(data.productPrice).find(
    p => p.product.symbol === "SOL/USD"
  );

  if (!solProduct?.price?.price) {
    throw new Error("Failed to fetch SOL/USD from Pyth");
  }

  const solUsd = solProduct.price.price;
  const confidence = solProduct.price.confidence;

  console.log(`✅ Pyth SOL/USD: $${solUsd} ±${confidence}`);

  // ---------------- scanMintFast ----------------
  console.log("🚀 Running scanMintFast(SOL)...");
  const start = Date.now();

  const result = await scanMintFast(SOL_MINT, start);

  console.log("📊 scanMintFast result:");
  console.dir(result, { depth: null });

  console.log(`⏱️ Latency: ${Date.now() - start} ms`);

  if (!result?.priceUSD) {
    throw new Error("scanMintFast FAILED to return price");
  }

  console.log("✅ MAINNET PRICE TEST PASSED");
  process.exit(0);
})().catch(err => {
  console.error("❌ MAINNET TEST FAILED:");
  console.error(err.message || err);
  process.exit(1);
});