// jupiterOnchain.js
import { Jupiter } from "@jup-ag/api";         // or @jup-ag/jupiter depending on your sdk
import { Connection, PublicKey } from "@solana/web3.js";

let jupiter = null;
let connection = null;

/**
 * initJupiter(rpcOrOpts)
 * - rpcOrOpts may be a string (rpc url) or { rpc, cluster }
 */
export async function initJupiter(rpcOrOpts = {}) {
  const rpc = typeof rpcOrOpts === "string" ? rpcOrOpts : (rpcOrOpts.rpc || process.env.RPC_URL);
  if (!rpc) throw new Error("RPC URL required for initJupiter");

  connection = new Connection(rpc, { commitment: "confirmed" });

  // IMPORTANT: user = null -> SDK will NOT add a signer
  jupiter = await Jupiter.load({
    connection,
    cluster: (rpcOrOpts.cluster || "mainnet-beta"),
    user: null, // NO WALLET / NO SIGNER
    wrapUnwrapSOL: true,
  });

  return jupiter;
}

function sanitizeAmount(amount) {
  if (typeof amount === "bigint") {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return Number(Number.MAX_SAFE_INTEGER);
    return Number(amount);
  }
  if (typeof amount === "string") {
    try { return Number(BigInt(amount)); } catch { return Number(amount); }
  }
  return Number(amount);
}

export async function getOnchainPrice(inputMint, outputMint, rawAmount, opts = {}) {
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

  const bestRoute = quote.routes?.[0] ?? null;
  const inAmount = Number(quote.inAmount ?? bestRoute?.inAmount ?? amount);
  const outAmount = Number(quote.outAmount ?? bestRoute?.outAmount ?? 0);

  return {
    inAmount,
    outAmount,
    price: inAmount && outAmount ? outAmount / inAmount : null,
    routes: quote.routes || [],
    bestRoute,
  };
}

export async function getBestRoute(inputMint, outputMint, rawAmount, opts = {}) {
  const q = await getOnchainPrice(inputMint, outputMint, rawAmount, opts);
  return q?.bestRoute ?? null;
}

export async function simulateSwap(route) {
  if (!jupiter) throw new Error("Jupiter not initialized.");
  if (!route) throw new Error("No route provided");
  const sim = await jupiter.v6.swapInstructionsPost({ quoteResponse: route });
  return sim?.simulationResult ?? sim;
}

/**
 * buildSwapTransaction(route, userPublicKey)
 * returns Buffer (unsigned transaction bytes)
 */
export async function buildSwapTransaction(route, userPublicKey, opts = {}) {
  if (!jupiter) throw new Error("Jupiter not initialized.");
  if (!route) throw new Error("No route provided");
  

  // SDK's swapPost / exchange builder (v6) — build tx but DO NOT expect it signed
  const swapResponse = await jupiter.v6.swapPost({
    quoteResponse: route,
    // optional flags from opts can go here
  });

  const txB64 = swapResponse?.swapTransaction;
  if (!txB64) throw new Error("No swapTransaction returned from jupiter.v6.swapPost.");

  return Buffer.from(txB64, "base64"); // unsigned tx buffer
}

/**
 * executeSwap(route, userPublicKey, opts)
 * convenience: same as buildSwapTransaction but returns an object expected by callers.
 * IMPORTANT: does NOT sign or send.
 */
export async function executeSwap(route, userPublicKey, opts = {}) {
  const unsignedBuf = await buildSwapTransaction(route, userPublicKey, opts);
  return {
    unsignedTx: unsignedBuf,
    skipPreflight: opts.skipPreflight ?? false,
  };
}

export default {
  initJupiter,
  getOnchainPrice,
  getBestRoute,
  simulateSwap,
  buildSwapTransaction,
  executeSwap,
};