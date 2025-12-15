import fs from "fs";
import path from "path";
import { Transaction, ComputeBudgetProgram, Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import crypto from "crypto";
import dotenv from "dotenv";
import PQueue from "p-queue";

dotenv.config();

import { markSellStart, markSellComplete, allSellsComplete } from "./sellmonitor.js";

const BUILD_TX_FILE = path.resolve("./buildSwapTx.json");
const DEFAULT_CU_UNITS = Number(process.env.CU_UNITS || 150_000);
const DEFAULT_CU_MICRO_LAMPORTS = Number(process.env.CU_PRICE_MICRO || 1_000_000);

// -------------------- RPCs --------------------
const RPC_URLS = Object.keys(process.env)
  .filter(k => k.startsWith("RPC_URL_"))
  .map(k => process.env[k])
  .filter(Boolean);

if (!RPC_URLS.length) {
  throw new Error("❌ No RPC_URL_* defined in .env");
}

// 6 requests per second max
const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 6
});

// -------------------- WALLET --------------------
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
  if (!fs.existsSync(passphrasePath)) {
    throw new Error("Passphrase file missing: " + passphrasePath);
  }

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  return bs58.decode(decrypted);
}

// -------------------- FILE HELPERS --------------------
function readBuildTx() {
  if (!fs.existsSync(BUILD_TX_FILE)) return [];
  return JSON.parse(fs.readFileSync(BUILD_TX_FILE, "utf8") || "[]");
}

function writeBuildTx(list) {
  fs.writeFileSync(BUILD_TX_FILE, JSON.stringify(list, null, 2), "utf8");
}

// -------------------- RPC RETRY (RATE-LIMITED) --------------------
async function sendWithRpcRetry(tx, wallet) {
  let lastError;

  for (let i = 0; i < RPC_URLS.length; i++) {
    const rpcUrl = RPC_URLS[i % RPC_URLS.length];
    const conn = new Connection(rpcUrl, "confirmed");

    try {
      return await rpcQueue.add(async () => {
        const latest = await conn.getLatestBlockhash("finalized");
        tx.recentBlockhash = latest.blockhash;
        tx.feePayer = wallet.publicKey;

        tx.sign(wallet);

        const raw = tx.serialize();
        const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
        await conn.confirmTransaction(sig, "confirmed");

        return sig;
      });
    } catch (err) {
      console.warn(`⚠️ RPC failed (${rpcUrl}): ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(`❌ All RPCs failed: ${lastError?.message}`);
}

// -------------------- MAIN AUTOSELL --------------------
export async function executeAutoSell(mintAddress, amount) {
  if (!mintAddress) throw new Error("mintAddress required");

  const secretKey = getWalletFromEnv();
  const wallet = Keypair.fromSecretKey(secretKey);

  const buildList = readBuildTx();
  if (!buildList.length) return null;

  const txIndex = buildList.findIndex(e => e.mintA === mintAddress);
  if (txIndex === -1) return null;

  const txEntry = buildList[txIndex];

  // 🔔 mark sell start
  await markSellStart(mintAddress);

  const tx = Transaction.from(Buffer.from(txEntry.unsignedTx, "base64"));

  // Compute budget (preserved)
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_CU_MICRO_LAMPORTS })
  );

  // 🚀 Send (rate-limited + retry)
  const sig = await sendWithRpcRetry(tx, wallet);

  console.log(`✅ AUTOSELL executed for ${mintAddress} → ${sig}`);

  // 🔔 mark sell complete
  await markSellComplete(mintAddress);

  // 🧹 remove ONLY this tx (as you specified)
  buildList.splice(txIndex, 1);
  writeBuildTx(buildList);

  // 🔁 compounding / cleanup
  if (await allSellsComplete()) {
    console.log("🔁 All sells complete — compounding logic continues");
  }

  return sig;
}