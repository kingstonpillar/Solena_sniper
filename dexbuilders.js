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

// ----------------------------------------------------------
// Create ATA if not existing
// ----------------------------------------------------------
export async function ensureATA(connection, wallet, mint) {
  connection = connection || getRpcConnection();

  const ata = await getAssociatedTokenAddress(mint, wallet, false);
  const info = await connection.getAccountInfo(ata);

  const ixList = [];

  if (!info) {
    ixList.push(
      createAssociatedTokenAccountInstruction(
        wallet,   // payer
        ata,      // ata
        wallet,   // owner
        mint
      )
    );
  }

  return { ata, ixList };
}

// ----------------------------------------------------------
// Scan on-chain pools and return only the ones matching the pair
// ----------------------------------------------------------
export async function findPoolsForPair(connection, mintIn, mintOut) {
  connection = connection || getRpcConnection();

  const A = String(mintIn);
  const B = String(mintOut);
  const found = [];

  const dexList = [
    { dex: "raydium", program: UPR_PROGRAMS.RAYDIUM_AMM },
    { dex: "orca", program: UPR_PROGRAMS.ORCA_WHIRLPOOL },
    { dex: "meteora", program: UPR_PROGRAMS.METEORA_CLMM },
  ];

  for (const d of dexList) {
    try {
      const pools = await scanPools(d.program);

      for (const p of pools) {
        const mA = String(p.mintA);
        const mB = String(p.mintB);

        const match =
          (mA === A && mB === B) ||
          (mA === B && mB === A);

        if (match) {
          found.push({
            dex: d.dex,
            programId: d.program.toBase58(),
            poolPubkey: p.pool,
            mintA: p.mintA,
            mintB: p.mintB,
            vaultA: p.vaultA,
            vaultB: p.vaultB,
            amountA: BigInt(p.amountA),
            amountB: BigInt(p.amountB)
          });
        }
      }
    } catch (_) {
      // swallow isolated dex scan errors
    }
  }

  if (found.length === 0)
    return { dex: null, pools: [] };

  const ranked = found.sort(
    (x, y) =>
      (y.amountA + y.amountB) - (x.amountA + x.amountB)
  );

  return {
    dex: ranked[0].dex,
    pools: ranked
  };
}

// ----------------------------------------------------------
// Select best dex based on on-chain pool existence
// ----------------------------------------------------------
export async function selectDexForMint(connection, mint) {
  connection = connection || getRpcConnection();

  const m = String(mint);

  const dexList = [
    { dex: "raydium", program: UPR_PROGRAMS.RAYDIUM_AMM },
    { dex: "orca", program: UPR_PROGRAMS.ORCA_WHIRLPOOL },
    { dex: "meteora", program: UPR_PROGRAMS.METEORA_CLMM },
  ];

  for (const d of dexList) {
    try {
      const pools = await scanPools(d.program);
      for (const p of pools) {
        if (String(p.mintA) === m || String(p.mintB) === m)
          return d.dex;
      }
    } catch (_) {}
  }

  return "raydium";
}

// ----------------------------------------------------------
// Raydium V4 swap
// ----------------------------------------------------------
export async function buildRaydiumSwapTx(connection, wallet, mintIn, mintOut, amountIn) {
  connection = connection || getRpcConnection();

  const best = await findPoolsForPair(connection, mintIn, mintOut);
  if (!best.dex || best.dex !== "raydium")
    throw new Error("No Raydium pool available");

  const pool = best.pools[0];

  const poolPubkey = new PublicKey(pool.poolPubkey);
  const vaultA     = new PublicKey(pool.vaultA);
  const vaultB     = new PublicKey(pool.vaultB);
  const programId  = new PublicKey(pool.programId);

  const { ata: inATA,  ixList: ixA } = await ensureATA(connection, wallet, new PublicKey(mintIn));
  const { ata: outATA, ixList: ixB } = await ensureATA(connection, wallet, new PublicKey(mintOut));

  const userIxs = [...ixA, ...ixB];

  // Raydium AMM v4 instruction 9
  const data = Buffer.alloc(1 + 1 + 8 + 8);

  data.writeUInt8(9, 0);  // swap
  data.writeUInt8(0, 1);  // direction: 0 = A→B

  data.writeBigUInt64LE(BigInt(amountIn), 2);      // amount in
  data.writeBigUInt64LE(BigInt(1), 10);            // min out

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultA,     isSigner: false, isWritable: true },
      { pubkey: vaultB,     isSigner: false, isWritable: true },
      { pubkey: inATA,      isSigner: false, isWritable: true },
      { pubkey: outATA,     isSigner: false, isWritable: true },
      { pubkey: wallet,     isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data
  });

  return { instructions: [...userIxs, ix] };
}

// ----------------------------------------------------------
// Orca Whirlpool simplified swap
// ----------------------------------------------------------
export async function buildOrcaSwapTx(connection, wallet, mintIn, mintOut, amountIn) {
  connection = connection || getRpcConnection();

  const best = await findPoolsForPair(connection, mintIn, mintOut);
  if (best.dex !== "orca")
    throw new Error("No Orca pool");

  const pool = best.pools[0];

  const { ata: inATA,  ixList: ixA } = await ensureATA(connection, wallet, new PublicKey(mintIn));
  const { ata: outATA, ixList: ixB } = await ensureATA(connection, wallet, new PublicKey(mintOut));

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: new PublicKey(pool.poolPubkey), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.vaultA),     isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.vaultB),     isSigner: false, isWritable: true },
      { pubkey: inATA,                          isSigner: false, isWritable: true },
      { pubkey: outATA,                         isSigner: false, isWritable: true },
      { pubkey: wallet,                         isSigner: true,  isWritable: true }
    ],
    programId: new PublicKey(pool.programId),
    data: Buffer.from([1])   // placeholder
  });

  return { instructions: [...ixA, ...ixB, ix] };
}

// ----------------------------------------------------------
// Meteora swap (placeholder)
// ----------------------------------------------------------
export async function buildMeteoraSwapTx(connection, wallet, mintIn, mintOut, amountIn) {
  connection = connection || getRpcConnection();

  const best = await findPoolsForPair(connection, mintIn, mintOut);
  if (best.dex !== "meteora")
    throw new Error("No Meteora pool");

  const pool = best.pools[0];

  const { ata: inATA,  ixList: ixA } = await ensureATA(connection, wallet, new PublicKey(mintIn));
  const { ata: outATA, ixList: ixB } = await ensureATA(connection, wallet, new PublicKey(mintOut));

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: new PublicKey(pool.poolPubkey), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.vaultA),     isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.vaultB),     isSigner: false, isWritable: true },
      { pubkey: inATA,                          isSigner: false, isWritable: true },
      { pubkey: outATA,                         isSigner: false, isWritable: true },
      { pubkey: wallet,                         isSigner: true,  isWritable: true }
    ],
    programId: new PublicKey(pool.programId),
    data: Buffer.from([1])
  });

  return { instructions: [...ixA, ...ixB, ix] };
}

// ----------------------------------------------------------
// Unified swap entry point (for swapExecutor.js + autoSell.js)
// ----------------------------------------------------------
export async function buildSwapTx(connection, wallet, mintIn, mintOut, amountIn) {
  connection = connection || getRpcConnection();

  const best = await findPoolsForPair(connection, mintIn, mintOut);
  
  if (!best.dex)
    throw new Error("No on-chain pool for this pair");

  if (best.dex === "raydium")
    return buildRaydiumSwapTx(connection, wallet, mintIn, mintOut, amountIn);

  if (best.dex === "orca")
    return buildOrcaSwapTx(connection, wallet, mintIn, mintOut, amountIn);

  if (best.dex === "meteora")
    return buildMeteoraSwapTx(connection, wallet, mintIn, mintOut, amountIn);

  throw new Error("Unsupported DEX type: " + best.dex);
}