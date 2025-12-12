import { computePrice, scanPools } from "./unified_pool_registry.js";

async function test() {
  console.log("Scanning pools...");
  const pools = await scanPools();

  console.log("\n=== Sample Pools ===");
  pools.slice(0, 5).forEach((p, i) => {
    console.log(`Pool #${i + 1}`);
    console.log("AMM ID:", p.ammID);
    console.log("Mint A:", p.mintA);
    console.log("Mint B:", p.mintB);
    console.log("Vault A:", p.vaultA, "Reserve:", p.reserveA);
    console.log("Vault B:", p.vaultB, "Reserve:", p.reserveB);
    console.log("Instr Keys:", p.instructionKeys);
    console.log("------------------------------------");
  });

  console.log("\nTesting price computation on WSOL...");
  const out = await computePrice("So11111111111111111111111111111111111111112");

  console.log("\n=== Price Output ===");
  console.log("SOL/USD:", out.solUsd);
  console.log("Blockhash:", out.blockhash);

  out.pools.forEach((p, i) => {
    console.log(`\nPool #${i + 1}`);
    console.log("AMM:", p.ammID);
    console.log("Price SOL:", p.priceSOL);
    console.log("Price USD:", p.priceUSD);
  });
}

test();