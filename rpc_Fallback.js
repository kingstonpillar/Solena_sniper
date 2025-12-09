// rpc_fallback.js
import { Connection } from "@solana/web3.js";

// ----------------------------------------------------------
// CONFIG: ADD YOUR RPCs HERE
// (ORDER = PRIORITY)
// ----------------------------------------------------------
const RPCS = [
  process.env.RPC_URL_5,
  process.env.RPC_URL_6,
  process.env.RPC_URL_7
].filter(Boolean);

if (RPCS.length === 0) {
  throw new Error("❌ No RPC URLs set in environment (RPC_URL_5, RPC_URL_6, RPC_URL_7)");
}

// ----------------------------------------------------------
// RATE LIMIT CONFIG
// ----------------------------------------------------------
const RATE_LIMIT_MS = Number(process.env.RPC_RATE_LIMIT_MS || 100); // 100ms per call
let lastCallTime = Array(RPCS.length).fill(0);

// ----------------------------------------------------------
// STATE
// ----------------------------------------------------------
let currentIndex = 0;
let connections = RPCS.map(
  (rpc) => new Connection(rpc, { commitment: "confirmed" })
);

// ----------------------------------------------------------
// HEALTH CHECK — ensure RPC is alive
// ----------------------------------------------------------
async function isHealthy(conn) {
  try {
    const slot = await conn.getSlot({ commitment: "processed" });
    return Number.isInteger(slot);
  } catch (_) {
    return false;
  }
}

// ----------------------------------------------------------
// ROTATE RPC IF FAILURE (improved)
// ----------------------------------------------------------
async function rotateRPC() {
  currentIndex = (currentIndex + 1) % RPCS.length;
  lastCallTime[currentIndex] = 0; // reset timer for new RPC
  console.log(`⚠️  Switching RPC → ${RPCS[currentIndex]}`);

  const conn = connections[currentIndex];
  const ok = await isHealthy(conn);

  if (!ok) {
    console.log("❌ RPC dead. Trying next one...");
    return rotateRPC();
  }

  return conn;
}

// ----------------------------------------------------------
// RATE LIMIT HELPER
// ----------------------------------------------------------
async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastCallTime[currentIndex];

  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((res) => setTimeout(res, RATE_LIMIT_MS - elapsed));
  }

  lastCallTime[currentIndex] = Date.now();
}

// ----------------------------------------------------------
// PUBLIC FUNCTION: Safe RPC call with fallback, retry & rate limit
// ----------------------------------------------------------
export async function rpcCall(fn, ...args) {
  let attempts = 0;

  while (attempts < RPCS.length) {
    const conn = connections[currentIndex];

    try {
      await rateLimit(); // enforce rate limit per RPC
      return await fn(conn, ...args);
    } catch (err) {
      console.log(`RPC ERROR (${RPCS[currentIndex]}):`, err.message);

      attempts++;
      await rotateRPC();
    }
  }

  throw new Error("❌ All RPC endpoints failed.");
}

// ----------------------------------------------------------
// EXPORT CURRENT CONNECTION (safe)
// ----------------------------------------------------------
export function getConnection() {
  return connections[currentIndex];
}