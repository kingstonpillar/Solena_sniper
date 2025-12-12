import { scanPools, PROGRAMS as UPR_PROGRAMS } from "./unified_pool_registry.js";
import { Connection, PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { rpcCall } from "./rpc_Fallback.js";

const DEFAULT_SCAN_TTL_MS = Number(process.env.POOL_SCAN_TTL_MS || 60_000);
let poolCache = { ts: 0, payload: {} };

// -------------------------
// Cached pool scan
// -------------------------
async function scanPoolsCached(programPubkey) {
  const now = Date.now();
  if (poolCache.ts && now - poolCache.ts < DEFAULT_SCAN_TTL_MS && poolCache.payload?.[programPubkey.toString()]) {
    return poolCache.payload[programPubkey.toString()];
  }

  try {
    const pools = await scanPools();
    poolCache.ts = now;
    poolCache.payload = poolCache.payload || {};
    poolCache.payload[programPubkey.toString()] = pools || [];
    return pools;
  } catch (err) {
    console.warn(`scanPoolsCached error:`, err?.message || err);
    return poolCache.payload?.[programPubkey.toString()] || [];
  }
}

// -------------------------
// Ensure ATA exists
// -------------------------
export async function ensureATA(walletPubkey, mint) {
  const ata = await getAssociatedTokenAddress(mint, walletPubkey, false);
  const info = await rpcCall(async (conn) => conn.getAccountInfo(ata));
  const ixList = [];
  if (!info) ixList.push(createAssociatedTokenAccountInstruction(walletPubkey, ata, walletPubkey, mint));
  return { ata, ixList };
}

// -------------------------
// Find pools for a token pair (enforce mintIn → mintA)
// -------------------------
export async function findPoolsForPair(connection, mintIn, mintOut) {
  const A = String(mintIn), B = String(mintOut);
  const found = [];
  const dexList = [{ dex: "raydium", program: UPR_PROGRAMS.RAYDIUM_AMM }];

  for (const d of dexList) {
    try {
      const pools = await scanPoolsCached(d.program);
      for (const p of pools) {
        const mA = String(p.mintA), mB = String(p.mintB);

        // === ENFORCE DIRECTION: mintIn must match mintA
        if (mA !== A) continue;
        if (mB === B) {
          found.push({ ...p, dex: d.dex, programId: d.program.toBase58(), poolPubkey: p.ammID });
        }
      }
    } catch {}
  }

  if (!found.length) return { dex: null, pools: [] };
  const ranked = found.sort((x, y) => Number(y.amountA + y.amountB) - Number(x.amountA + x.amountB));
  return { dex: ranked[0].dex, pools: ranked };
}

// -------------------------
// Build swap transaction (supports poolHint)
// -------------------------
export async function buildSwapTx(
  connection,
  walletPubkey,
  mintIn,
  mintOut,
  amountIn,
  options = {}
) {
  // Backward compatibility for old signature
  let slippageBps = 50;
  let poolHint = null;

  if (typeof options === "number") {
    slippageBps = options;
  } else if (typeof options === "object" && options !== null) {
    slippageBps = options.slippageBps ?? 50;
    poolHint = options.poolHint ?? null;
  }

  // -------------------------
  // 1) Choose pool
  // -------------------------
  let pool = null;

  if (poolHint) {
    // Validate direction
    if (String(poolHint.mintA) !== String(mintIn) || String(poolHint.mintB) !== String(mintOut)) {
      throw new Error("Pool hint has wrong direction: mintA does not match mintIn or mintB != mintOut");
    }
    pool = poolHint;
  } else {
    const best = await findPoolsForPair(connection, mintIn, mintOut);
    if (!best.dex) throw new Error("No on-chain pool available for this direction");
    pool = best.pools[0];
  }

  // -------------------------
  // 2) Ensure ATAs
  // -------------------------
  const { ata: inATA, ixList: ixA } = await ensureATA(walletPubkey, new PublicKey(mintIn));
  const { ata: outATA, ixList: ixB } = await ensureATA(walletPubkey, new PublicKey(mintOut));

  // -------------------------
  // 3) Compute output amount
  // -------------------------
  const balanceA = BigInt(pool.amountA || 0);
  const balanceB = BigInt(pool.amountB || 0);
  const amountInBig = BigInt(amountIn);
  const expectedOut = (balanceB * amountInBig) / (balanceA + amountInBig);
  const minOut = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;

  const direction = 0; // always mintIn -> mintOut (enforced by findPoolsForPair)

  const data = Buffer.alloc(1 + 1 + 8 + 8);
  data.writeUInt8(9, 0);
  data.writeUInt8(direction, 1);
  data.writeBigUInt64LE(amountInBig, 2);
  data.writeBigUInt64LE(minOut, 10);

  // -------------------------
  // 4) Keys / IX assembly
  // -------------------------
  const keys = [
    { pubkey: new PublicKey(pool.poolPubkey), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.vaultA), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.vaultB), isSigner: false, isWritable: true },
    { pubkey: inATA, isSigner: false, isWritable: true },
    { pubkey: outATA, isSigner: false, isWritable: true },
    { pubkey: walletPubkey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...(pool.extraAccounts || []).map(acc => ({
      pubkey: new PublicKey(acc),
      isSigner: false,
      isWritable: true
    }))
  ];

  const ix = new TransactionInstruction({
    keys,
    programId: new PublicKey(pool.programId),
    data
  });

  return {
    instructions: [...ixA, ...ixB, ix],
    poolUsed: pool
  };
}

export default {
  findPoolsForPair,
  buildSwapTx
};