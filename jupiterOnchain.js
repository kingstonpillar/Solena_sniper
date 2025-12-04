// jupiterOnchain.js
// Clean, keyless Jupiter on-chain helper (v6-compatible shapes)
// Exports: initJupiter, getBestRoute, simulateSwap, buildSwapTransaction, executeSwapJupiter

import { Jupiter } from "@jup-ag/jupiter";
import { Connection, PublicKey } from "@solana/web3.js";

let jupiter = null;
let connection = null;

/**
 * initJupiter({ rpc, cluster })
 * - Does NOT require wallet
 * - Only builds routes + unsigned txs
 */
export async function initJupiter(options = {}) {
  let rpcUrl = options.rpc
    || process.env.RPC_URL_6   // ← autosell uses RPC_URL_6
    || process.env.RPC_URL
    || process.env.RPC_URL_5
    || process.env.RPC_URL_2;

  if (!rpcUrl)
    throw new Error("RPC URL required for initJupiter");

  const cluster = options.cluster || "mainnet-beta";

  connection = new Connection(rpcUrl, "confirmed");

  jupiter = await Jupiter.load({
    connection,
    cluster,
    user: null,
    wrapUnwrapSOL: true,
  });

  return jupiter;
}

function sanitizeAmount(a) {
  // ensure a number is returned; caller might pass bigint/string
  if (typeof a === "bigint") {
    if (a > BigInt(Number.MAX_SAFE_INTEGER)) return Number(Number.MAX_SAFE_INTEGER);
    return Number(a);
  }
  if (typeof a === "string") {
    try { return Number(BigInt(a)); } catch { return Number(a); }
  }
  return Number(a || 0);
}

/**
 * On-chain quote (v6)
 * Returns the best route object or null
 */
export async function getBestRoute(inputMint, outputMint, rawAmount, opts = {}) {
  if (!jupiter) throw new Error("Jupiter not initialized. Call initJupiter()");
  const amount = sanitizeAmount(rawAmount);
  const slippageBps = opts.slippageBps ?? 50;

  const quote = await jupiter.v6.quoteGet({
    inputMint: new PublicKey(inputMint),
    outputMint: new PublicKey(outputMint),
    amount,
    slippageBps,
  });

  if (!quote) return null;
  return quote.routes?.[0] ?? null;
}

/**
 * simulateSwap(route)
 * returns simulation result (if available) or simulation object
 */
export async function simulateSwap(route) {
  if (!jupiter) throw new Error("Jupiter not initialized.");
  if (!route) throw new Error("No route provided");
  const sim = await jupiter.v6.swapInstructionsPost({ quoteResponse: route });
  return sim?.simulationResult ?? sim;
}

/**
 * buildSwapTransaction(route)
 * Ask Jupiter to build the unsigned transaction, returns Buffer (unsigned tx)
 */
export async function buildSwapTransaction(route) {
  if (!jupiter) throw new Error("Jupiter not initialized.");
  if (!route) throw new Error("No route provided");

  const resp = await jupiter.v6.swapPost({
    quoteResponse: route,
  });

  const b64 = resp?.swapTransaction;
  if (!b64) throw new Error("No swapTransaction returned from Jupiter.swapPost");
  // return Buffer (some SDKs may return Uint8Array later; caller should handle)
  return Buffer.from(b64, "base64");
}

/**
 * executeSwapJupiter(route, opts)
 * Convenience wrapper that returns an object the caller expects:
 * { unsignedTx: Buffer, skipPreflight: boolean }
 *
 * NOTE: does NOT sign or send — caller must sign locally and send.
 */
export async function executeSwapJupiter(route, opts = {}) {
  const unsignedTx = await buildSwapTransaction(route);
  return {
    unsignedTx,
    skipPreflight: opts.skipPreflight ?? false,
  };
}

export default {
  initJupiter,
  getBestRoute,
  simulateSwap,
  buildSwapTransaction,
  executeSwapJupiter,
};