// testprice.js
import dotenv from "dotenv";
dotenv.config();

import { scanMintFast } from "./priceScanner.js";

// Example: USDC-SOL pool (replace with your real pool info)
const EXAMPLE_POOLS = [
  {
    dex: "Raydium",
    pool: "ExamplePoolAddress",
    mintA: "So11111111111111111111111111111111111111112", // WSOL
    mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gT1k2KD7", // USDC canonical
    vaultA: "YourVaultAAddressHere",
    vaultB: "YourVaultBAddressHere"
  }
];

const TEST_MINT = "So11111111111111111111111111111111111111112"; // WSOL

async function main() {
  try {
    console.log(`🔎 Scanning token: ${TEST_MINT}`);

    // Example: provide pools and optional SOL price
    const solUsd = 25; // you can put real SOL price here
    const result = await scanMintFast(TEST_MINT, EXAMPLE_POOLS, solUsd);

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