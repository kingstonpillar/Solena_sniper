// testprice.js
import dotenv from "dotenv";
dotenv.config();

import { scanMintFast } from "./priceScanner.js";

const TEST_MINT = "So11111111111111111111111111111111111111112"; // WSOL
const SOL_USD = 25; // optional: current SOL price in USD

async function main() {
  console.log(`🔎 Scanning token: ${TEST_MINT}`);

  try {
    const result = await scanMintFast(TEST_MINT, SOL_USD);

    if (result.found) {
      console.log("✅ Price found:");
      console.log(`DEX: ${result.dex}`);
      console.log(`Pool: ${result.pool}`);
      console.log(`Base mint: ${result.baseMint}`);
      console.log(`Quote mint: ${result.quoteMint}`);
      console.log(`Price: ${result.price}`);
      console.log(`Price USD: ${result.priceUSD}`);
      console.log("Reserves:", result.reserves);
    } else {
      console.log("❌ Price not found:", result.reason);
    }
  } catch (err) {
    console.error("Error scanning price:", err.message || err);
  }
}

main();