// index.js
import dotenv from "dotenv";
dotenv.config();

import { verifyTokenSecurity } from "./tokensecurities.js";
import { verifyCreatorSafety } from "./tokenCreatorScanner.js";
import { executeSwap, StartWatcher } from "./swapexecutor.js";
import { executeAutoSell } from "./autosell.js";
import { currentTradeAmount, computeUnitPerTrade } from "./walletbalance.js";
import { allSellsComplete } from "./sellmonitor.js";
import { scanMintFast } from "./priceScanner.js";

// Side-effect modules
import "./liquiditywatcher.js";
import "./liquidityGuard.js";
import "./crash-protection.js";

async function main() {
  console.log("🚀 Bot starting...");

  try {
    // ✅ Ensure trade amount is computed
    if (!currentTradeAmount || !computeUnitPerTrade) {
      console.log("💰 Trade amount not ready yet.");
    } else {
      console.log("💰 Trade amount ready:", currentTradeAmount);
    }

    // ✅ Start liquidity watcher
    await StartWatcher();

    // ✅ Optional pre-flight token checks
    const testMints = process.env.TOKEN_LIST
      ? process.env.TOKEN_LIST.split(",")
      : [];

    for (const mint of testMints) {
      console.log(`🔎 Checking token: ${mint}`);

      const creatorCheck = await verifyCreatorSafety(mint);
      const tokenCheck = await verifyTokenSecurity(mint);

      if (!creatorCheck.safe || !tokenCheck.safe) {
        console.log(`⚠️ Token ${mint} failed checks.`);
        continue;
      }

      console.log(`✅ Token ${mint} passed checks.`);

      // ✅ On-chain AMM price scan (NO Jupiter)
      try {
        const p = await scanMintFast(null, mint, { dataSliceLen: 220 });

        if (p?.priceInSOL) {
          console.log(`💹 Price (${p.dex}):`, p.priceInSOL);
        } else {
          console.log(`ℹ️ No AMM price found`);
        }
      } catch (e) {
        console.log("⚠️ Price scan failed:", e.message);
      }
    }

    // ✅ Monitor sell completion only
    setInterval(async () => {
      const done = await allSellsComplete();
      if (done) {
        console.log("✅ All sells completed.");
      }
    }, 5000);

    console.log("🟢 Bot running.");
  } catch (err) {
    console.error("❌ Fatal startup error:", err);
    process.exit(1);
  }
}

// ───────── START ─────────
main();

// Safety nets
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});