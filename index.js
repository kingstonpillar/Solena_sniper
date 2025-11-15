// index.js — Main bot launcher
import dotenv from "dotenv";
dotenv.config();

import { verifyTokenSecurity } from "./tokensecurities.js";
import { verifyCreatorSecurity } from "./tokenCreatorScanner.js";
import { executeSwap, StartWatcher } from "./swapexecutor.js";
import { executeAutoSell } from "./autosell.js";
import { computeTradeAmount } from "./walletbalance.js";
import { allSellsComplete } from "./sellmonitor.js";

// Bot modules
import "./newtoken-pump.js";
import "./pumpCleaner.js";
import "./liquiditywatcher.js";
import "./liquidityGuard.js";
import "./crash-protection.js";

import fs from "fs";
import path from "path";

async function main() {
  console.log("🚀 Bot starting...");

  try {
    // 1️⃣ Compute trade amount based on wallet and fees
    await computeTradeAmount();

    // 2️⃣ Start liquidity watcher first
    await StartWatcher();

    // 3️⃣ Optional: pre-check tokens if you want security scanning before trade
    // Example usage for testing one token (replace with real mint addresses in a list)
    const testMints = process.env.TOKEN_LIST ? process.env.TOKEN_LIST.split(",") : [];
    for (const mint of testMints) {
      console.log(`🔎 Security check for token: ${mint}`);

      const creatorCheck = await verifyCreatorSecurity(mint);
      const tokenCheck = await verifyTokenSecurity(mint);

      if (!creatorCheck.safe || !tokenCheck.safe) {
        console.log(`⚠️ Token ${mint} failed security checks, skipping.`);
        continue;
      }

      console.log(`✅ Token ${mint} passed security checks.`);
    }

    // 4️⃣ Launch auto-sell monitor (continuous)
    setInterval(async () => {
      const sellsDone = await allSellsComplete();
      if (sellsDone) {
        // You can optionally trigger auto-sell logic here
        console.log("✅ All previous sells complete, bot ready for next buys.");
      }
    }, 5000);

    // 5️⃣ You can also add periodic wallet balance recalculation
    setInterval(async () => {
      await computeTradeAmount();
    }, 30_000); // every 30 sec

    console.log("🟢 Bot fully launched and running.");
  } catch (err) {
    console.error("❌ Fatal error during startup:", err);
    process.exit(1); // crash-protection
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