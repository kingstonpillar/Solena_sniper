cat << 'EOF' > test_registry.js
#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config();

import { scanAllPools } from "./unified_pool_registry_AMM_only.js";

const RPC_URL = process.env.RPC_URL_9 || "https://solana-mainnet.lava.build";
console.log("🔗 Connecting to RPC:", RPC_URL);

// Example Raydium & Orca pool PubKeys (replace with real pool PubKeys if needed)
const raydiumPools = [
  "9wFFm6w2eXhQhEPyT7zqfEec54Jr2W8guF2RkS1s1zQv",
  "8HoQnePLqPj4M7P8k1rx2zQ9FGnYf6pX7M7KzzN9v3p1"
];

const orcaPools = [
  "5nM4y8qz7A6HcN2R4bX7xJ5uQ2KkP3y7oL8wE7xK9zL1",
  "4jGhT9u3Fq1M2kB5wL8yP7rZ6Xc8vR1dF5hV3jN6sK2L"
];

(async () => {
  try {
    const res = await scanAllPools({
      raydium: raydiumPools,
      orca: orcaPools,
      meteora: [] // empty if no Meteora pools to test
    });

    console.log("✅ Raydium pools found:", res.raydium.length);
    res.raydium.forEach((p, i) => {
      console.log(i + 1, "Pool:", p.pool, "MintA:", p.mintA, "MintB:", p.mintB);
    });

    console.log("✅ Orca pools found:", res.orca.length);
    res.orca.forEach((p, i) => {
      console.log(i + 1, "Pool:", p.pool, "MintA:", p.mintA, "MintB:", p.mintB);
    });

  } catch (err) {
    console.error("❌ scanAllPools failed:", err.message || err);
  }
})();
EOF