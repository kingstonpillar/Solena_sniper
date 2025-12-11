// test_registry.js
// Simple runner to test unified_pool_registry.js

import { scanAllPools } from "./unified_pool_registry.js";

async function main() {
  try {
    console.log("Fetching pools on-chain...\n");

    const { pools, solUsd } = await scanAllPools();

    console.log("SOL/USD Price =>", solUsd ?? "null");
    console.log("--------------------------------------------------");

    console.log("Pools =>");
    for (const p of pools) {
      console.log({
        pool: p.pool,
        mintA: p.mintA,
        mintB: p.mintB,
        amountA: p.amountA,
        amountB: p.amountB,
        priceInUSD: p.priceInUSD
      });
    }

    console.log("--------------------------------------------------");
    console.log("Done.");
  } catch (err) {
    console.error("ERROR:", err);
  }
}

main();