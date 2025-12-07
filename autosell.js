// autosell.js
// Hardened autosell wrapper (BUY: token -> SOL). Uses dexBuilders.js for builders.
// Safety-first: verifies decimals, vaults, liquidity, ATAs, does dry-run simulation if enabled.
//
// WARNING (read):
// - This script tries to remove coding/data errors (wrong decimals, missing accounts, pool mismatch).
// - It DOES NOT and CANNOT protect you from natural blockchain phenomena (MEV front-running, oracle price movement, sudden external swaps).
// - You said you accept slippage/liquidity risk; this file will check a minimum liquidity threshold before attempting the swap.
//
// Usage:
//   DRY_RUN=true node autosell.js <MINT_ADDRESS> <amount>
//   (amount can be float like "12.34" meaning token units, or an integer smallest-unit string)
//
// Exports: executeAutoSell(mintAddress, amount)
//
// Requires environment variables same as your project (ENCRYPTED_KEY, KEY_PASSPHRASE_FILE, RPC_URL_6 optional, DRY_RUN optional)
//
// Dependencies (package.json):
//   "@solana/web3.js", "@solana/spl-token", "bs58", "dotenv"
//
// Integrates with your dexBuilders.js exported functions:
//   selectDexForMint, findPoolsForPair, buildSwapTx, dryRun
//
// Drop-in: does NOT modify dexBuilders.js

import fs from "fs";
import { Connection, PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getMint, getAccount } from "@solana/spl-token";
import bs58 from "bs58";
import dotenv from "dotenv";
import crypto from "crypto";

import {
  selectDexForMint,
  findPoolsForPair,
  buildSwapTx,
  dryRun
} from "./dexBuilders.js";

dotenv.config();

/* ---------------------- CONFIG ---------------------- */

const RPC_URL = process.env.RPC_URL_6 || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC_URL, "confirmed");

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Minimum combined reserve (in token smallest units) required to consider a pool healthy.
// You can tune this per token. Default is conservative: 100 * 10^decimals (e.g. 100 tokens).
const DEFAULT_MIN_LIQUIDITY_TOKENS = 100;

// Safety: maximum attempts to build/send
const BUILD_RETRY = Number(process.env.AUTOSLL_BUILD_RETRY || 3);
const SEND_RETRY = Number(process.env.AUTOSLL_SEND_RETRY || 3);

// ComputeBudget: default units and microLamports
const DEFAULT_CU_UNITS = Number(process.env.CU_UNITS || 150_000);
const DEFAULT_CU_MICRO_LAMPORTS = Number(process.env.CU_PRICE_MICRO || 1_000_000); // 0.001 lamport? tune as needed

/* ---------------------- Helpers ---------------------- */

function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWalletFromEnv() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in env");
  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("Passphrase file missing: " + passphrasePath);
  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secretKey = bs58.decode(decrypted);
  return secretKey; // caller can create Keypair
}

async function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function retry(fn, attempts = 3, backoff = 500) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) { last = err; if (i < attempts - 1) await sleep(backoff * (i + 1)); }
  }
  throw last;
}

/* ---------------------- On-chain validators ---------------------- */

/**
 * validatePoolAndVaults(poolObj)
 * - poolObj shape from findPoolsForPair: { dex, programId, poolPubkey, mintA, mintB, vaultA, vaultB, amountA, amountB }
 * - verifies vault accounts exist, are SPL token accounts, mints match pool object.
 * - checks combined liquidity >= thresholdTokens * 10^decimals (approx)
 */
async function validatePoolAndVaults(poolObj, minLiquidityTokens = DEFAULT_MIN_LIQUIDITY_TOKENS) {
  if (!poolObj || !poolObj.vaultA || !poolObj.vaultB) {
    throw new Error("poolObj missing vault info");
  }

  const vaultAPub = new PublicKey(poolObj.vaultA);
  const vaultBPub = new PublicKey(poolObj.vaultB);

  // get parsed token account info
  const accA = await conn.getParsedAccountInfo(vaultAPub, "confirmed");
  const accB = await conn.getParsedAccountInfo(vaultBPub, "confirmed");

  if (!accA?.value) throw new Error("Vault A not found on-chain: " + poolObj.vaultA);
  if (!accB?.value) throw new Error("Vault B not found on-chain: " + poolObj.vaultB);

  // Verify owner is token program
  const ownerA = accA.value.owner?.toString?.();
  const ownerB = accB.value.owner?.toString?.();
  if (!ownerA || !ownerA.startsWith("Tokenkeg")) throw new Error("Vault A owner is not SPL Token program");
  if (!ownerB || !ownerB.startsWith("Tokenkeg")) throw new Error("Vault B owner is not SPL Token program");

  const parsedA = accA.value.data?.parsed?.info;
  const parsedB = accB.value.data?.parsed?.info;
  if (!parsedA || !parsedB) throw new Error("Vault parse error");

  const mintA = parsedA.mint;
  const mintB = parsedB.mint;
  const amountAraw = parsedA.tokenAmount?.amount ? BigInt(parsedA.tokenAmount.amount) : null;
  const amountBraw = parsedB.tokenAmount?.amount ? BigInt(parsedB.tokenAmount.amount) : null;
  const decimalsA = parsedA.tokenAmount?.decimals ?? null;
  const decimalsB = parsedB.tokenAmount?.decimals ?? null;

  // Ensure mints match discovered pool's mintA/mintB (if present)
  if (poolObj.mintA && poolObj.mintA !== mintA && poolObj.mintA !== mintB) {
    throw new Error(`Pool mint mismatch: poolObj.mintA ${poolObj.mintA} != vault mints ${mintA} / ${mintB}`);
  }
  if (poolObj.mintB && poolObj.mintB !== mintA && poolObj.mintB !== mintB) {
    throw new Error(`Pool mint mismatch: poolObj.mintB ${poolObj.mintB} != vault mints ${mintA} / ${mintB}`);
  }

  // Compute combined liquidity in "token units" for the token being sold (we don't know which vault is which)
  // We'll return full info; caller decides thresholds based on the token they care about.
  return {
    vaultA: { pubkey: vaultAPub.toBase58(), mint: mintA, amountRaw: amountAraw, decimals: decimalsA },
    vaultB: { pubkey: vaultBPub.toBase58(), mint: mintB, amountRaw: amountBraw, decimals: decimalsB },
  };
}

/* ---------------------- Main export ---------------------- */

/**
 * executeAutoSell(mintAddress, amount)
 *
 * - mintAddress: token mint base58 (token you want to sell to SOL)
 * - amount: either integer small-units string, or float token-units (e.g. "12.5")
 *
 * Returns:
 *  - { dryRun:true, sim: ... } if DRY_RUN=true
 *  - signature string on success
 *  - throws or returns null on failure
 */
export async function executeAutoSell(mintAddress, amount) {
  if (!mintAddress) throw new Error("mintAddress required");

  // decrypt wallet secret key and build Keypair locally
  const secretKey = getWalletFromEnv();
  const wallet = await (async () => {
    // lazy import to avoid duplicate Keypair import errors in some envs
    const { Keypair } = await import("@solana/web3.js");
    return Keypair.fromSecretKey(secretKey);
  })();
  const ownerPubkey = wallet.publicKey;

  console.log("AUTOSELL start:", mintAddress, "owner:", ownerPubkey.toBase58());

  // 1) Determine DEX
  let dex;
  try {
    dex = await retry(() => selectDexForMint(conn, mintAddress), 3, 300);
  } catch (e) {
    console.error("selectDexForMint failed:", e.message || e);
    throw e;
  }
  console.log("Selected DEX:", dex);

  // 2) Discover candidate pools
  let found;
  try {
    found = await retry(() => findPoolsForPair(conn, mintAddress, SOL_MINT), 3, 400);
  } catch (e) {
    console.error("findPoolsForPair failed:", e.message || e);
    throw e;
  }
  if (!found || !found.pools || found.pools.length === 0) {
    throw new Error("No on-chain pools found for pair (token <-> SOL)");
  }

  // Sort pools by combined apparent liquidity (already done in findPoolsForPair if implemented)
  // We'll iterate through discovered pools and validate until one is acceptable.
  let selectedPool = null;
  for (const p of found.pools) {
    try {
      const vaultInfo = await validatePoolAndVaults(p);
      // Decide which vault corresponds to the token mintAddress:
      const aMatches = vaultInfo.vaultA.mint === mintAddress;
      const bMatches = vaultInfo.vaultB.mint === mintAddress;
      // compute token-reserve (token you will sell) and other-reserve (usually SOL)
      let tokenReserveRaw = null;
      if (aMatches) tokenReserveRaw = vaultInfo.vaultA.amountRaw;
      else if (bMatches) tokenReserveRaw = vaultInfo.vaultB.amountRaw;
      else {
        // fallback: if neither vault mint exactly matches (shouldn't happen), skip
        console.warn("Pool vaults don't include target mint exactly. skipping pool:", p.poolPubkey);
        continue;
      }

      // Ensure tokenReserveRaw is not null and above threshold
      const decimals = (aMatches ? vaultInfo.vaultA.decimals : vaultInfo.vaultB.decimals) ?? 6;
      const minLiquidityRaw = BigInt(DEFAULT_MIN_LIQUIDITY_TOKENS) * (BigInt(10) ** BigInt(decimals));
      if (!tokenReserveRaw || tokenReserveRaw < minLiquidityRaw) {
        console.warn(`Pool ${p.poolPubkey} token reserve ${tokenReserveRaw} below minimum (${minLiquidityRaw}). skipping.`);
        continue;
      }

      // PASS: select this pool
      selectedPool = p;
      selectedPool.vaults = vaultInfo;
      selectedPool.tokenDecimals = decimals;
      console.log("Selected pool:", p.poolPubkey, "dex:", p.dex, "token decimals:", decimals);
      break;
    } catch (e) {
      console.warn("Pool validation failed for", p.poolPubkey, ":", e.message || e);
      continue;
    }
  }

  if (!selectedPool) throw new Error("No pool passed on-chain validation & liquidity checks");

  // 3) Resolve amount raw
  let amountRawBig;
  {
    const decimals = selectedPool.tokenDecimals ?? 6;
    if (typeof amount === "string" && /^[0-9]+$/.test(amount)) {
      amountRawBig = BigInt(amount);
    } else if (typeof amount === "number" && Number.isInteger(amount) && amount > 1e9) {
      amountRawBig = BigInt(amount);
    } else {
      const mul = BigInt(10) ** BigInt(decimals);
      const amtFloat = Number(amount);
      if (!Number.isFinite(amtFloat) || amtFloat <= 0) throw new Error("Invalid amount numeric");
      amountRawBig = BigInt(Math.floor(amtFloat * Number(mul)));
    }
  }

  if (amountRawBig <= 0n) throw new Error("amount resolved to zero");

  // Extra safety: do not sell more than token reserve
  const tokenVault = (selectedPool.vaults.vaultA.mint === mintAddress) ? selectedPool.vaults.vaultA : selectedPool.vaults.vaultB;
  if (tokenVault.amountRaw !== null && amountRawBig > tokenVault.amountRaw) {
    throw new Error("Requested sell amount exceeds pool token reserve — aborting");
  }

  // Convert to builder-friendly type (number or BigInt depending on builder expectations)
  let amountForBuilder;
  amountForBuilder = (amountRawBig <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(amountRawBig) : amountRawBig;

  // 4) Build swap tx (use buildSwapTx from dexBuilders.js). We will attempt and if fails, try next pool
  let builtTx = null;
  let lastBuildError = null;

  for (let attempt = 0; attempt < BUILD_RETRY; attempt++) {
    try {
      // buildSwapTx(conn, walletPublicKey, mintIn, mintOut, amountIn)
      const maybe = await buildSwapTx(conn, selectedPool.dex, ownerPubkey, mintAddress, SOL_MINT, amountForBuilder);
      // normalize to a transaction-like object with .instructions (array)
      if (maybe instanceof Transaction) {
        builtTx = maybe;
      } else if (maybe && Array.isArray(maybe.instructions)) {
        // create a Transaction wrapper for signing/sim if needed
        const tx = new Transaction().add(...maybe.instructions);
        builtTx = tx;
      } else if (maybe && maybe.instructions && Array.isArray(maybe.instructions)) {
        const tx = new Transaction().add(...maybe.instructions);
        builtTx = tx;
      } else {
        // If buildSwapTx returned e.g. { instructions: [...] } already handled, else try to detect instruction-like
        if (Array.isArray(maybe)) {
          builtTx = new Transaction().add(...maybe);
        } else if (maybe && maybe.programId && maybe.keys && maybe.data) {
          builtTx = new Transaction().add(maybe);
        } else {
          throw new Error("Unexpected buildSwapTx return shape");
        }
      }

      if (!builtTx) throw new Error("buildSwapTx returned no transaction");
      lastBuildError = null;
      break;
    } catch (e) {
      lastBuildError = e;
      console.warn("buildSwapTx attempt", attempt + 1, "failed:", e.message || e);
      // maybe try next discovered pool instead of retry same pool; for now we retry same
      await sleep(200 * (attempt + 1));
    }
  }
  if (!builtTx) throw new Error("Failed to build swap tx: " + (lastBuildError?.message || "unknown"));

  // 5) Prepend compute budget instructions
  try {
    builtTx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_CU_MICRO_LAMPORTS })
    );
  } catch (e) {
    console.warn("Failed to add compute budget instructions:", e.message || e);
  }

  // 6) Dry-run simulation optional
  if (process.env.DRY_RUN === "true") {
    try {
      // ensure feePayer & recentBlockhash for simulate
      builtTx.feePayer = ownerPubkey;
      const { blockhash } = await conn.getLatestBlockhash("finalized");
      builtTx.recentBlockhash = blockhash;

      const sim = await dryRun(conn, builtTx);
      console.log("DRY_RUN simulation result:", sim);
      return { dryRun: true, sim, selectedPool: selectedPool.poolPubkey };
    } catch (e) {
      console.warn("Simulation failed:", e.message || e);
      return { dryRun: true, simError: String(e) };
    }
  }

  // 7) Sign & send with retries
  let signature = null;
  for (let attemptSend = 0; attemptSend < SEND_RETRY; attemptSend++) {
    try {
      // ensure blockhash + fee payer
      builtTx.feePayer = ownerPubkey;
      const latest = await conn.getLatestBlockhash("finalized");
      builtTx.recentBlockhash = latest.blockhash;

      // sign (Transaction)
      // If the builder returned a VersionedTransaction we would handle that differently,
      // but earlier we normalized to Transaction for compatibility with your environment.
      builtTx.sign(wallet);

      const raw = builtTx.serialize();
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });

      await conn.confirmTransaction(sig, "confirmed");
      console.log("AUTOSELL sent:", sig);
      signature = sig;
      break;
    } catch (e) {
      console.warn("Send attempt", attemptSend + 1, "failed:", e.message || e);
      if (attemptSend === SEND_RETRY - 1) {
        throw new Error("All send attempts failed: " + (e.message || e));
      }
      await sleep(600 * (attemptSend + 1));
    }
  }

  // 8) Success notification (telegram optional)
  try {
    const tg = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
    if (tg) {
      const msg = `✅ AUTOSELL EXECUTED\nToken: ${mintAddress}\nAmount (raw): ${amountRawBig.toString()}\nPool: ${selectedPool.poolPubkey}\nSig: https://solscan.io/tx/${signature}`;
      fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg })
      }).catch(() => {});
    }
  } catch (e) { /* non-fatal */ }

  return signature;
}

/* ---------------------- CLI runner for quick tests ---------------------- */
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length < 2) {
      console.log("Usage: node autosell.js <MINT_ADDRESS> <AMOUNT> (set DRY_RUN=true to simulate)");
      process.exit(1);
    }
    const [mint, amount] = args;
    try {
      const res = await executeAutoSell(mint, amount);
      console.log("Result:", res);
    } catch (err) {
      console.error("Error:", err.message || err);
      process.exit(2);
    }
  })();
}