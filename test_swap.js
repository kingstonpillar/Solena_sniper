import dotenv from "dotenv";
dotenv.config();

import { executeSwap } from "./swapexecutor.js";

const INPUT_MINT = "So11111111111111111111111111111111111111112"; // SOL
const OUTPUT_MINT = "KAKA"; // target token mint

async function main() {
  console.log("Starting swap test");

  try {
    const sig = await executeSwap(INPUT_MINT, OUTPUT_MINT);

    if (sig) {
      console.log("Swap executed successfully");
      console.log("Transaction signature:", sig);
    } else {
      console.log("Swap did not execute (returned null)");
    }

  } catch (err) {
    console.error("Swap test failed:", err?.message || err);
  }
}

main();