
/**
 * testUnifiedPool.js
 * Test script for unified_pool_registry.js
 */

import { scanPools } from "./unified_pool_registry.js";

async function main() {
  try {
    console.log("Scanning Raydium v4 pools on-chain...\n");

    const data = await scanPools();

    if (!data.pools.length) {
      console.log("No valid pools found or vaults empty.");
      process.exit(0);
    }

    console.log(`✅ SOL/USD price resolved: ${data.solUsd ?? "N/A"}\n`);

    // pretty-print pools
    console.log("=== Sample Pools ===");
    data.pools.slice(0, 10).forEach((p, i) => {
      console.log(`${i + 1}. Pool: ${p.address}`);
      console.log(`   mintA: ${p.mintA}, mintB: ${p.mintB}`);
      console.log(`   reserveA: ${p.reserveA}, reserveB: ${p.reserveB}`);
      console.log(`   priceSOL: ${p.priceSOL}, priceUSD: ${p.priceUSD}\n`);
    });

    // machine-readable JSON output
    console.log("=== JSON OUTPUT ===");
    console.log(JSON.stringify(data, null, 2));

    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err.stack || err.message || err);
    process.exit(1);
  }
}

main();