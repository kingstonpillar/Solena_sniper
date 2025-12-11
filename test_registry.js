// test_registry.js

import { scanAllPools } from "./unified_pool_registry.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

async function main() {
  const POOLS = {
    raydium: [
      // add 1–5 Raydium pool AMM IDs for testing
      "YourPoolAMMID1",
      "YourPoolAMMID2"
    ]
  };

  const out = await scanAllPools(POOLS);

  console.log("SOL/USD Price =>", out.solUSDPrice);
  console.log("Pools =>");

  for (const p of out.raydium) {
    console.log("-----------");
    console.log("Pool:", p.pool);
    console.log("mintA:", p.mintA);
    console.log("mintB:", p.mintB);
    console.log("amountA:", p.amountA);
    console.log("amountB:", p.amountB);
    console.log("priceInSOL:", p.priceInSOL);
    console.log("priceInUSD:", p.priceInUSD);

    // Example: if mintA is BONK
    if (p.mintA !== WSOL_MINT && p.mintA !== "USDC" && p.mintA !== "USDT") {
      console.log("Token Price =>", p.priceInUSD || p.priceInSOL);
    }
  }
}

main();