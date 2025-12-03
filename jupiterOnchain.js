// jupiterOnchain.js
import {
  Jupiter,
} from "@jup-ag/jupiter";
import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

let jupiter = null;
let connection = null;

// -----------------------------------------------------------
// 1. Initialize Jupiter (RPC FROM .env ONLY)
// -----------------------------------------------------------
export async function initJupiter() {
  const rpcUrl = process.env.RPC_URL_8;
  if (!rpcUrl) throw new Error("RPC_URL missing from .env");

  connection = new Connection(rpcUrl, "confirmed");

  jupiter = await Jupiter.load({
    connection,
    cluster: "mainnet-beta",
    user: null,   // NO WALLET, NO SIGNER, NO PRIVATE KEY
  });

  return jupiter;
}

// -----------------------------------------------------------
// 2. Fetch On-chain Price
// -----------------------------------------------------------
export async function getOnchainPrice(inputMint, outputMint, amount) {
  if (!jupiter) throw new Error("Jupiter not initialized.");

  const route = await jupiter.quote({
    inputMint: new PublicKey(inputMint),
    outputMint: new PublicKey(outputMint),
    amount,
    slippageBps: 50,
  });

  return route ? route.outAmount : null;
}

// -----------------------------------------------------------
// 3. Get Best Route
// -----------------------------------------------------------
export async function getBestRoute(inputMint, outputMint, amount, slippageBps) {
  if (!jupiter) throw new Error("Jupiter not initialized.");

  return await jupiter.quote({
    inputMint: new PublicKey(inputMint),
    outputMint: new PublicKey(outputMint),
    amount,
    slippageBps,
  });
}

// -----------------------------------------------------------
// 4. Simulate Swap
// -----------------------------------------------------------
export async function simulateSwap(route) {
  if (!jupiter) throw new Error("Jupiter not initialized.");

  return await jupiter.simulateTransaction({ routeInfo: route });
}

// -----------------------------------------------------------
// 5. Build Swap Transaction (UNSIGNED)
// -----------------------------------------------------------
export async function buildSwapTransaction(route) {
  if (!jupiter) throw new Error("Jupiter not initialized.");

  const { swapTransaction } = await jupiter.exchange({
    routeInfo: route,
    userPublicKey: new PublicKey(route.userPublicKey),
    wrapAndUnwrapSol: true,
  });

  return Buffer.from(swapTransaction, "base64");
}

// -----------------------------------------------------------
// 6. Execute Swap (UNSIGNED)
// -----------------------------------------------------------
export async function executeSwap(route, options = {}) {
  if (!jupiter) throw new Error("Jupiter not initialized.");

  const { swapTransaction } = await jupiter.exchange({
    routeInfo: route,
    userPublicKey: new PublicKey(route.userPublicKey),
    wrapAndUnwrapSol: true,
  });

  return {
    unsignedTx: Buffer.from(swapTransaction, "base64"),
    skipPreflight: options.skipPreflight ?? false,
  };
}