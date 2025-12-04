import dotenv from "dotenv";
dotenv.config();

import { verifyTokenSecurity } from "./tokensecurities.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";
import { executeSwap, StartWatcher } from "./swapexecutor.js";
import { executeAutoSell } from "./autosell.js";
import { computeTradeAmount, startLoop } from "./walletbalance.js";
import { allSellsComplete } from "./sellmonitor.js";

// 🔥 ADD JUPITER ONCHAIN — NOTHING ELSE CHANGES
import { 
  initJupiter,
  getOnchainPrice,
  getBestRoute,
  simulateSwap,
  buildSwapTransaction,
  executeswapJupiter
} from "./jupiterOnchain.js";

// Bot modules (side-effect imports)
import "./liquiditywatcher.js";
import "./liquidityGuard.js";
import "./crash-protection.js";

async function main() {
  console.log("🚀 Bot starting...");

  try {

    // 🔥 Initialize Jupiter at startup
    await initJupiter(process.env.RPC_URL_8 || process.env.RPC_URL);
    console.log("🌐 Jupiter Onchain API initialized.");

    // 1️⃣ Compute trade amount once on startup
    await computeTradeAmount();

    // 2️⃣ Start the wallet balance heartbeat (every 30 min)
    startLoop();

    // 3️⃣ Start liquidity watcher
    await StartWatcher();

    // 4️⃣ Optional: pre-check tokens before trade
    const testMints = process.env.TOKEN_LIST ? process.env.TOKEN_LIST.split(",") : [];
    for (const mint of testMints) {
      console.log(`🔎 Security check for token: ${mint}`);

      const creatorCheck = await verifyCreatorSafety(mint);
      const tokenCheck = await verifyTokenSecurity(mint);

      if (!creatorCheck.safe || !tokenCheck.safe) {
        console.log(`⚠️ Token ${mint} failed security checks, skipping.`);
        continue;
      }

      console.log(`✅ Token ${mint} passed security checks.`);

      // 🔥 OPTIONALLY ask Jupiter for price (safe debug)
      try {
        const price = await getOnchainPrice(
          process.env.BASE_MINT,
          mint,
          1000000 // 1 token or adjustable
        );
        console.log(`💹 Jupiter price for ${mint}:`, price?.price);
      } catch (e) {
        console.log(`⚠️ Jupiter price failed for ${mint}:`, e.message);
      }
    }

    // 5️⃣ Launch auto-sell monitor (continuous)
    setInterval(async () => {
      const sellsDone = await allSellsComplete();
      if (sellsDone) {
        console.log("✅ All previous sells complete, bot ready for next buys.");
      }
    }, 5000);

    console.log("🟢 Bot fully launched and running.");

  } catch (err) {
    console.error("❌ Fatal error during startup:", err);
    process.exit(1);
  }
}

// ================= START BOT =================
main();

// Optional: handle uncaught exceptions to avoid crashes
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Promise Rejection:", reason);
});