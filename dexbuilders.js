// dexBuilders.js
// AMM-only builder (Raydium v4 + Orca Whirlpool) with cached pool scan
// - Removes Meteora
// - Reduces RPC by caching scanPools results
// - Attaches extra pool accounts returned by scanPools (required for real swaps)
// - Dynamic on-chain slippage calculation

import {
  scanPools,
  PROGRAMS as UPR_PROGRAMS
} from "./unified_pool_registry.js";

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram
} from "@solana/web3.js";

import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction
} from "@solana/spl-token";

import { getRpcConnection } from "./rpc_Fallback.js";
import { decodeWhirlpool } from "./orcaWhirlpoolUtils.js"; // Helper to decode Orca Whirlpool account

const DEFAULT_SCAN_TTL_MS = Number(process.env.POOL_SCAN_TTL_MS || 60_000);
let poolCache = { ts: 0, payload: {} };

// ----------------------------------------------------------
// Cached scanPools
// ----------------------------------------------------------
async function scanPoolsCached(programPubkey) {
  const now = Date.now();
  if (poolCache.ts && (now - poolCache.ts) < DEFAULT_SCAN_TTL_MS &&
      poolCache.payload && poolCache.payload[programPubkey.toString()]) {
    return poolCache.payload[programPubkey.toString()];
  }

  try {
    const pools = await scanPools(programPubkey);
    poolCache.ts = now;
    poolCache.payload = poolCache.payload || {};
    poolCache.payload[programPubkey.toString()] = pools || [];
    return poolCache.payload[programPubkey.toString()];
  } catch {
    return poolCache.payload[programPubkey.toString()] || [];
  }
}

// ----------------------------------------------------------
// Ensure ATA exists
// ----------------------------------------------------------
export async function ensureATA(connection, walletPubkey, mint) {
  connection = connection || getRpcConnection();

  const ata = await getAssociatedTokenAddress(mint, walletPubkey, false);
  const info = await connection.getAccountInfo(ata);

  const ixList = [];
  if (!info) {
    ixList.push(
      createAssociatedTokenAccountInstruction(
        walletPubkey,
        ata,
        walletPubkey,
        mint
      )
    );
  }

  return { ata, ixList };
}

// ----------------------------------------------------------
// Scan pools for a token pair
// ----------------------------------------------------------
export async function findPoolsForPair(connection, mintIn, mintOut) {
  connection = connection || getRpcConnection();

  const A = String(mintIn);
  const B = String(mintOut);
  const found = [];

  const dexList = [
    { dex: "raydium", program: UPR_PROGRAMS.RAYDIUM_AMM },
    { dex: "orca", program: UPR_PROGRAMS.ORCA_WHIRLPOOL }
  ];

  for (const d of dexList) {
    try {
      const pools = await scanPoolsCached(d.program);
      if (!Array.isArray(pools) || pools.length === 0) continue;

      for (const p of pools) {
        const mA = String(p.mintA);
        const mB = String(p.mintB);
        if ((mA === A && mB === B) || (mA === B && mB === A)) {
          found.push({
            dex: d.dex,
            programId: d.program.toBase58(),
            poolPubkey: p.pool,
            mintA: p.mintA,
            mintB: p.mintB,
            vaultA: p.vaultA,
            vaultB: p.vaultB,
            amountA: BigInt(p.amountA || 0),
            amountB: BigInt(p.amountB || 0),
            extraAccounts: p.extraAccounts || p.accounts || [],
            meta: p.meta || null
          });
        }
      }
    } catch (err) {
      console.warn("findPoolsForPair scan error:", err?.message || err);
    }
  }

  if (found.length === 0)
    return { dex: null, pools: [] };

  const ranked = found.sort((x, y) => Number(y.amountA + y.amountB) - Number(x.amountA + x.amountB));
  return { dex: ranked[0].dex, pools: ranked };
}

// ----------------------------------------------------------
// Select DEX for a given mint
// ----------------------------------------------------------
export async function selectDexForMint(connection, mint) {
  connection = connection || getRpcConnection();
  const m = String(mint);

  const dexList = [
    { dex: "raydium", program: UPR_PROGRAMS.RAYDIUM_AMM },
    { dex: "orca", program: UPR_PROGRAMS.ORCA_WHIRLPOOL }
  ];

  for (const d of dexList) {
    try {
      const pools = await scanPoolsCached(d.program);
      if (!Array.isArray(pools)) continue;
      for (const p of pools) {
        if (String(p.mintA) === m || String(p.mintB) === m) return d.dex;
      }
    } catch (_) {}
  }

  return "raydium";
}

// ----------------------------------------------------------
// Compute dynamic on-chain slippage (Raydium & Orca)
// ----------------------------------------------------------
/**
 * Compute expected minimum output for a swap with slippage
 * Supports Raydium AMM and Orca Whirlpool
 * 
 * @param {Connection} connection - Solana RPC connection
 * @param {object} pool - Pool info object (must include dex, vaults, mints, poolPubkey)
 * @param {string|number|BigInt} amountIn - Amount of input token
 * @param {PublicKey|string} mintIn - Input token mint
 * @param {number} slippageBps - Allowed slippage in basis points (default 50)
 * @returns {BigInt} - Minimum output amount
 */
export async function computeMinOut(connection, pool, amountIn, mintIn, slippageBps = 50) {
  if (!connection || !pool || !amountIn || !mintIn) return 0n;

  const amountInBig = BigInt(amountIn);

  // ---------------------------
  // Raydium AMM
  // ---------------------------
  if (pool.dex === "raydium") {
    const vaultA = new PublicKey(pool.vaultA);
    const vaultB = new PublicKey(pool.vaultB);

    const infoA = await connection.getTokenAccountBalance(vaultA).catch(() => ({ value: { amount: "0" } }));
    const infoB = await connection.getTokenAccountBalance(vaultB).catch(() => ({ value: { amount: "0" } }));

    const balanceA = BigInt(infoA.value.amount || 0);
    const balanceB = BigInt(infoB.value.amount || 0);

    if (balanceA === 0n || balanceB === 0n) return 0n;

    const expectedOut = (balanceB * amountInBig) / (balanceA + amountInBig);
    return (expectedOut * BigInt(10000 - slippageBps)) / 10000n;
  }

  // ---------------------------
  // Orca Whirlpool
  // ---------------------------
  if (pool.dex === "orca") {
    const poolInfo = await connection.getAccountInfo(new PublicKey(pool.poolPubkey));
    if (!poolInfo?.data) return 0n;

    const whirlpool = decodeWhirlpool(poolInfo.data);

    const swapAtoB = pool.mintA === String(mintIn);
    let amountOut = 0n;

    if (swapAtoB) {
      if (BigInt(whirlpool.tokenAReserve) === 0n) return 0n;
      amountOut = (BigInt(whirlpool.tokenBReserve) * amountInBig) /
                  (BigInt(whirlpool.tokenAReserve) + amountInBig);
    } else {
      if (BigInt(whirlpool.tokenBReserve) === 0n) return 0n;
      amountOut = (BigInt(whirlpool.tokenAReserve) * amountInBig) /
                  (BigInt(whirlpool.tokenBReserve) + amountInBig);
    }

    return (amountOut * BigInt(10000 - slippageBps)) / 10000n;
  }

  // ---------------------------
  // Unknown DEX
  // ---------------------------
  return 0n;
}
// ----------------------------------------------------------
// Raydium swap builder
// ----------------------------------------------------------
export async function buildRaydiumSwapTx(
  connection,
  walletPubkey,
  mintIn,
  mintOut,
  amountIn,
  options = { slippageBps: 50 }
) {
  connection = connection || getRpcConnection();
  const best = await findPoolsForPair(connection, mintIn, mintOut);
  if (!best.dex || best.dex !== "raydium") throw new Error("No Raydium pool available");

  const pool = best.pools[0];
  const poolPubkey = new PublicKey(pool.poolPubkey);
  const vaultA = new PublicKey(pool.vaultA);
  const vaultB = new PublicKey(pool.vaultB);
  const programId = new PublicKey(pool.programId);

  const { ata: inATA, ixList: ixA } = await ensureATA(connection, walletPubkey, new PublicKey(mintIn));
  const { ata: outATA, ixList: ixB } = await ensureATA(connection, walletPubkey, new PublicKey(mintOut));
  const userIxs = [...ixA, ...ixB];

  const minOut = await computeMinOut(connection, pool, amountIn, options.slippageBps);
  const direction = pool.mintA === mintIn ? 0 : 1;

  const data = Buffer.alloc(1 + 1 + 8 + 8);
  data.writeUInt8(9, 0);
  data.writeUInt8(direction, 1);
  data.writeBigUInt64LE(BigInt(amountIn), 2);
  data.writeBigUInt64LE(minOut, 10);

  const keys = [
    { pubkey: poolPubkey, isSigner: false, isWritable: true },
    { pubkey: vaultA, isSigner: false, isWritable: true },
    { pubkey: vaultB, isSigner: false, isWritable: true },
    { pubkey: inATA, isSigner: false, isWritable: true },
    { pubkey: outATA, isSigner: false, isWritable: true },
    { pubkey: walletPubkey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...(pool.extraAccounts || []).map(acc => ({ pubkey: new PublicKey(acc), isSigner: false, isWritable: true }))
  ];

  const ix = new TransactionInstruction({ keys, programId, data });
  return { instructions: [...userIxs, ix] };
}

// ----------------------------------------------------------
// Orca swap builder
// ----------------------------------------------------------
export async function buildOrcaSwapTx(
  connection,
  walletPubkey,
  mintIn,
  mintOut,
  amountIn,
  options = { slippageBps: 50 }
) {
  connection = connection || getRpcConnection();

  // Find the best Orca pool for this token pair
  const best = await findPoolsForPair(connection, mintIn, mintOut);
  if (!best.dex || best.dex !== "orca") throw new Error("No Orca pool available");

  const pool = best.pools[0];

  // Ensure user's ATAs exist for input and output tokens
  const { ata: inATA, ixList: ixA } = await ensureATA(connection, walletPubkey, new PublicKey(mintIn));
  const { ata: outATA, ixList: ixB } = await ensureATA(connection, walletPubkey, new PublicKey(mintOut));

  // Compute minimum output amount using updated computeMinOut
  const minOut = await computeMinOut(connection, pool, amountIn, mintIn, options.slippageBps);

  // Build transaction keys
  const keys = [
    { pubkey: new PublicKey(pool.poolPubkey), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.vaultA), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.vaultB), isSigner: false, isWritable: true },
    { pubkey: inATA, isSigner: false, isWritable: true },
    { pubkey: outATA, isSigner: false, isWritable: true },
    { pubkey: walletPubkey, isSigner: true, isWritable: true },
    ...(pool.extraAccounts || []).map(acc => ({ pubkey: new PublicKey(acc), isSigner: false, isWritable: true }))
  ];

  // Encode swap instruction
  const data = Buffer.alloc(1 + 8 + 8);
  data.writeUInt8(1, 0); // Orca swap opcode (placeholder)
  data.writeBigUInt64LE(BigInt(amountIn), 1);
  data.writeBigUInt64LE(minOut, 9);

  const ix = new TransactionInstruction({
    keys,
    programId: new PublicKey(pool.programId),
    data
  });

  return { instructions: [...ixA, ...ixB, ix] };
}

// ----------------------------------------------------------
// Helper: prepare swap
// ----------------------------------------------------------
async function prepareSwap(connection, walletPubkey, pool, mintIn, mintOut, amountIn, slippageBps = 50) {
  connection = connection || getRpcConnection();

  // Ensure user's ATAs exist
  const { ata: inATA, ixList: ixA } = await ensureATA(connection, walletPubkey, new PublicKey(mintIn));
  const { ata: outATA, ixList: ixB } = await ensureATA(connection, walletPubkey, new PublicKey(mintOut));

  // Compute minimum output amount
  const minOut = await computeMinOut(connection, pool, amountIn, mintIn, slippageBps);

  return { inATA, outATA, ixA, ixB, minOut };
}

// ----------------------------------------------------------
// Unified swap builder
// ----------------------------------------------------------
export async function buildSwapTx(connection, walletPubkey, mintIn, mintOut, amountIn, options = { slippageBps: 50 }) {
  connection = connection || getRpcConnection();

  // Find best pool for token pair
  const best = await findPoolsForPair(connection, mintIn, mintOut);
  if (!best.dex) throw new Error("No on-chain pool available for this pair");

  const pool = best.pools[0];

  // Prepare swap (ATA creation + minOut)
  const { inATA, outATA, ixA, ixB, minOut } = await prepareSwap(
    connection, walletPubkey, pool, mintIn, mintOut, amountIn, options.slippageBps
  );

  // Build transaction instruction depending on DEX
  let keys = [
    { pubkey: new PublicKey(pool.poolPubkey), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.vaultA), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.vaultB), isSigner: false, isWritable: true },
    { pubkey: inATA, isSigner: false, isWritable: true },
    { pubkey: outATA, isSigner: false, isWritable: true },
    { pubkey: walletPubkey, isSigner: true, isWritable: true },
    ...(pool.extraAccounts || []).map(acc => ({ pubkey: new PublicKey(acc), isSigner: false, isWritable: true }))
  ];

  let data;
  if (best.dex === "raydium") {
    // Add SystemProgram for Raydium
    keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });

    const direction = pool.mintA === String(mintIn) ? 0 : 1;
    data = Buffer.alloc(1 + 1 + 8 + 8);
    data.writeUInt8(9, 0); // Raydium swap opcode
    data.writeUInt8(direction, 1);
    data.writeBigUInt64LE(BigInt(amountIn), 2);
    data.writeBigUInt64LE(minOut, 10);
  } else if (best.dex === "orca") {
    data = Buffer.alloc(1 + 8 + 8);
    data.writeUInt8(1, 0); // Orca swap opcode
    data.writeBigUInt64LE(BigInt(amountIn), 1);
    data.writeBigUInt64LE(minOut, 9);
  } else {
    throw new Error("Unsupported DEX type: " + best.dex);
  }

  const ix = new TransactionInstruction({
    keys,
    programId: new PublicKey(pool.programId),
    data
  });

  return { instructions: [...ixA, ...ixB, ix] };
}