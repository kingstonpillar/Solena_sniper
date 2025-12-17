import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

/* ================= CONFIG ================= */

const RPC_URL = "https://solana-api.projectserum.com";
const connection = new Connection(RPC_URL);

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8n3gxYGpDaXJ8";
const SOL_MINT  = "So11111111111111111111111111111111111111112";

const POLL_INTERVAL = 10_000; // 10 seconds
const V4_AMM_PROGRAM_ID = "RVKd61ztZW9LhZ8k5DdENkdu2z1gQUh5k1ayk2vA1tQ";

const OUTPUT_FILE = path.resolve("./potential_migrators.json");
const seenTokens = new Set();

/* ================= HELPERS ================= */

async function isV4AMMPool(poolId) {
  try {
    const info = await connection.getAccountInfo(new PublicKey(poolId));
    if (!info) return false;
    return info.owner.toBase58() === V4_AMM_PROGRAM_ID;
  } catch {
    return false;
  }
}

async function getVaultsForQuote(tokenMint, quoteMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs?.length) return null;

    const pool = data.pairs.find(p =>
      p.chainId === "solana" &&
      (p.baseToken.address === tokenMint && p.quoteToken.address === quoteMint)
    );

    if (!pool) return null;

    return {
      mintAddress: pool.baseToken.address,
      mintB: pool.quoteToken.address,
      poolId: pool.pairAddress,
      vaultA: pool.pairAddressBaseToken,
      vaultB: pool.pairAddressQuoteToken,
      programID: V4_AMM_PROGRAM_ID
    };
  } catch {
    return null;
  }
}

async function getTokenPrice(vaultA, vaultB) {
  try {
    const aBalance = await connection.getTokenAccountBalance(new PublicKey(vaultA));
    const bBalance = await connection.getTokenAccountBalance(new PublicKey(vaultB));
    return parseFloat(bBalance.value.amount) / parseFloat(aBalance.value.amount);
  } catch {
    return null;
  }
}

async function getPriceUSD(tokenVault, quoteMint, quoteVault) {
  if (quoteMint === USDC_MINT) {
    return getTokenPrice(tokenVault, quoteVault);
  } else if (quoteMint === SOL_MINT) {
    const solUSDCVaults = await getVaultsForQuote(SOL_MINT, USDC_MINT);
    if (!solUSDCVaults) return null;

    const solPriceUSD = await getTokenPrice(solUSDCVaults.vaultA, solUSDCVaults.vaultB);
    const tokenPriceSOL = await getTokenPrice(tokenVault, quoteVault);
    if (tokenPriceSOL !== null && solPriceUSD !== null) return tokenPriceSOL * solPriceUSD;
  }
  return null;
}

function appendToFile(pool) {
  let data = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8")) || [];
    } catch {
      data = [];
    }
  }

  // Avoid duplicates by poolId + vaultA + vaultB
  if (data.some(p => p.poolId === pool.poolId && p.vaultA === pool.vaultA && p.vaultB === pool.vaultB)) return;

  data.push(pool);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), "utf8");
}

/* ================= MAIN LOOP ================= */

async function scanLoop() {
  console.log("[*] Polling Dexscreener for new Solana tokens...");

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/`);
    const data = await res.json();
    const solTokens = data.tokens?.filter(t => t.chain === "solana") || [];
    const newTokens = solTokens.filter(t => !seenTokens.has(t.address));

    for (const token of newTokens) {
      seenTokens.add(token.address);

      // Get both SOL and USDC vaults
      const solVaults = await getVaultsForQuote(token.address, SOL_MINT);
      const usdcVaults = await getVaultsForQuote(token.address, USDC_MINT);

      // Only process V4 AMM pools
      const results = [];
      if (solVaults && await isV4AMMPool(solVaults.poolId)) results.push(solVaults);
      if (usdcVaults && await isV4AMMPool(usdcVaults.poolId)) results.push(usdcVaults);

      for (const vaults of results) {
        const priceSOL = await getTokenPrice(vaults.vaultA, vaults.vaultB);
        const priceUSD = await getPriceUSD(vaults.vaultA, vaults.mintB, vaults.vaultB);

        const pool = {
          mintAddress: vaults.mintAddress,
          mintB: vaults.mintB,
          vaultA: vaults.vaultA,
          vaultB: vaults.vaultB,
          priceSOL,
          priceUSD,
          programID: vaults.programID,
          poolId: vaults.poolId
        };

        console.log(pool);       // Log to console
        appendToFile(pool);      // Append to file
      }
    }
  } catch (err) {
    console.error("Error scanning:", err);
  }

  setTimeout(scanLoop, POLL_INTERVAL);
}

/* ================= START ================= */
scanLoop();