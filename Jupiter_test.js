// Jupiter_test.js
import dotenv from "dotenv";
dotenv.config();

import {
  initJupiter,
  getOnchainPrice,
  getBestRoute,
  buildSwapTransaction,
  simulateSwap
} from "./jupiterOnchain.js";

import { PublicKey } from "@solana/web3.js";

const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Choose any token to test (USDC recommended)
const USDC_MINT = "Es9vMFrzaCER9PpRkNvJdVQVw1Gc7YDxUM3sZqiXXhYo";

async function runTests() {
  console.log("🔵 INITIALIZING JUPITER...");
  await initJupiter();
  console.log("✅ Jupiter init OK\n");

  console.log("🔵 TEST 1: On-chain price (USDC → SOL)");
  const quote = await getOnchainPrice(USDC_MINT, SOL_MINT, 1_000_000); // 1 USDC
  console.log("Quote:", quote);
  console.log("✅ Price OK\n");

  console.log("🔵 TEST 2: Best route (USDC → SOL)");
  const route = await getBestRoute(USDC_MINT, SOL_MINT, 1_000_000);
  console.log("Best Route:", route);
  if (!route) {
    console.log("❌ No route found. Cannot continue.");
    return;
  }
  console.log("✅ Route OK\n");

  console.log("🔵 TEST 3: Simulate swap");
  const simResult = await simulateSwap(route);
  console.log("Simulation:", simResult);
  console.log("✅ Simulation OK\n");

  console.log("🔵 TEST 4: Build swap transaction");
  const txBuf = await buildSwapTransaction(route, WALLET_ADDRESS);
  console.log("Tx Buffer Length:", txBuf.length);
  console.log("First Bytes:", txBuf.slice(0, 20).toString("hex"));
  console.log("✅ BuildSwapTransaction OK\n");

  console.log("🎉 ALL TESTS COMPLETED SUCCESSFULLY");
}

runTests().catch((err) => {
  console.error("\n❌ TEST FAILED:", err);
});