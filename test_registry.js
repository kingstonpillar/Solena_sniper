           test_registry.js
import { scanAllPools } from "./unified_pool_registry.js";

async function main() {
  console.log("🔍 Fetching pools on-chain...\n");

  try {
    const { pools, solUsd } = await scanAllPools();

    console.log("======================================");
    console.log("         RAYDIUM V4 POOL SCAN         ");
    console.log("======================================\n");

    if (!solUsd) {
      console.log("⚠️  Could not compute SOL/USD price!");
    } else {
      console.log(`🌕 SOL/USD Price: ${solUsd.toFixed(4)} USD\n`);
    }

    for (const p of pools) {
      console.log("Pool:", p.pool);
      console.log("MintA:", p.mintA);
      console.log("MintB:", p.mintB);
      console.log("VaultA:", p.vaultA);
      console.log("VaultB:", p.vaultB);
      console.log("AmountA:", p.amountA);
      console.log("AmountB:", p.amountB);
      console.log("Price in USD:", p.priceInUSD ?? "null");
      console.log("Price in SOL:", p.priceInSOL ?? "null");
      console.log("--------------------------------------\n");
    }

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
}

main();
