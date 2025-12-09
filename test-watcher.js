
// test-watcher.js
import "dotenv/config";
import { startBackrunWatcher, watcher } from "./backrunwatcher.js";

console.log("🧠 Starting watcher test...");

// Listen for emitted opportunities from your watcher
watcher.on("arbOpportunity", (data) => {
  console.log("\n🚨 Arbitrage Opportunity Found 🚨");
  console.log("Live DEX:", data.live.dex);
  console.log("Catch DEX:", data.catch.dex);
  console.log("Δ Price %:", data.catch.diffPct.toFixed(3));
  console.log("Liquidity:", data.live.liquidityUSD.toFixed(2), "USD");
  console.log("TxHash:", data.txHash);
  console.log("--------------------------------------");
});

// Start the watcher
startBackrunWatcher()
  .then(() => console.log("👂 Watcher running (pending mempool mode)..."))
  .catch((err) => console.error("❌ Watcher failed:", err));
 