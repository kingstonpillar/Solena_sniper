import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { scanMintFast } from "./priceScanner.js";

const MIGRATOR_FILE = path.resolve("./potential_migrators.json");
const OUTPUT_FILE = path.resolve("./buildSwapTx.json");

// Raydium V4 AMM program
const RAYDIUM_AMM_V4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

// Token Program
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// ------------------ UTIL ------------------
function readMigrators() {
  try {
    if (!fs.existsSync(MIGRATOR_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(MIGRATOR_FILE, "utf8")) || [];
    return raw.map(p => ({
      ...p,
      programId: p.programId || RAYDIUM_AMM_V4.toBase58(),
    }));
  } catch {
    return [];
  }
}

function saveBuildTx(list) {
  try {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(list, null, 2), "utf8");
    console.log(`✅ BuildSwapTx saved: ${list.length} entries`);
  } catch (e) {
    console.log("saveBuildTx error:", e?.message || e);
  }
}

// ------------------ AMM CALC ------------------
function getAmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
  const amountInWithFee = amountIn * 997; // 0.3% fee
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000 + amountInWithFee;
  return Math.floor(numerator / denominator);
}

// ------------------ BUILD UNSIGNED TX JSON ------------------
function buildUnsignedSwapInstruction(pool, amountIn = null) {
  if (!amountIn) amountIn = Math.floor(pool.reserveA * 0.01); // 1% of reserveA
  const amountOut = getAmountOut(amountIn, pool.reserveA, pool.reserveB);

  const keys = [
    { pubkey: pool.vaultA, isSigner: false, isWritable: true },
    { pubkey: pool.vaultB, isSigner: false, isWritable: true },
    { pubkey: pool.mintAddress, isSigner: false, isWritable: false },
    { pubkey: pool.mintB, isSigner: false, isWritable: false },
    { pubkey: "SysvarRent111111111111111111111111111111111", isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
  ];

  // Data buffer as array
  const data = Buffer.alloc(17);
  data.writeUInt8(9, 0); // Raydium swap enum
  data.writeBigUInt64LE(BigInt(amountIn), 1);
  data.writeBigUInt64LE(BigInt(amountOut), 9);

  return {
    keys,
    programId: RAYDIUM_AMM_V4.toBase58(),
    data: Array.from(data), // store as array of bytes for JSON
    amountIn,
    amountOut
  };
}

// ------------------ MAIN ------------------
async function main() {
  const migrators = readMigrators();
  const buildList = [];

  for (const pool of migrators) {
    if (!pool.programId || pool.programId !== RAYDIUM_AMM_V4.toBase58()) continue;

    const priceInfo = await scanMintFast(pool.mintAddress);
    const priceSOL = priceInfo?.priceSOL ?? pool.priceSOL;
    const priceUSD = priceInfo?.priceUSD ?? pool.priceUSD;

    const unsignedInstruction = buildUnsignedSwapInstruction(pool);

    buildList.push({
      poolId: pool.poolId,
      programId: pool.programId,
      mintAddress: pool.mintAddress,
      mintB: pool.mintB,
      vaultA: pool.vaultA,
      vaultB: pool.vaultB,
      reserveA: pool.reserveA,
      reserveB: pool.reserveB,
      priceSOL,
      priceUSD,
      unsignedInstruction
    });
  }

  saveBuildTx(buildList);
}

main().catch(e => console.log("Fatal error:", e));