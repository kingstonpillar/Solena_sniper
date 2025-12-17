// swapexecutor.js
import fs from "fs";
import path from "path";
import { Connection, Keypair, Transaction, PublicKey, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import crypto from "crypto";
import dotenv from "dotenv";
import fetch from "node-fetch";
import PQueue from "p-queue";

import { allSellsComplete } from "./sellmonitor.js";
import { currentTradeAmount, computeUnitPerTrade } from "./walletbalance.js";

dotenv.config();

// -------------------- CONFIG --------------------
const BUILD_TX_FILE = path.resolve("./buildSwapTx.json");
const ACTIVE_POSITIONS_FILE = path.resolve("./active_positions.json");
const MAX_ACTIVE_POSITIONS = Number(process.env.MAX_ACTIVE_POSITIONS || 20);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -------------------- WATCHER --------------------
let watcherActive = true;
export async function startWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 Liquidity Watcher Started");
}
export async function stopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 Liquidity Watcher Stopped");
}

// -------------------- RPCs + RETRY --------------------
const RPC_URLS = Object.keys(process.env)
  .filter(k => k.startsWith("RPC_URL_"))
  .map(k => process.env[k])
  .filter(Boolean);

const maxRetries = RPC_URLS.length || 1;
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });

async function sendWithRpcRetry(sendFn) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    const rpcUrl = RPC_URLS[i % RPC_URLS.length] || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    const conn = new Connection(rpcUrl, "confirmed");
    try {
      return await rpcQueue.add(() => sendFn(conn));
    } catch (err) {
      console.warn(`⚠️ RPC ${rpcUrl} failed: ${err.message}, trying next RPC...`);
      lastError = err;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`All RPCs failed: ${lastError.message}`);
}

// -------------------- WALLET --------------------
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWalletFromEnvEncrypted() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in .env");
  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("Passphrase file missing.");
  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

// -------------------- TELEGRAM --------------------
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" })
    });
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

// -------------------- FILE HELPERS --------------------
function safeReadJSON(pathStr) {
  try {
    if (!fs.existsSync(pathStr)) return [];
    return JSON.parse(fs.readFileSync(pathStr, "utf8") || "[]");
  } catch {
    return [];
  }
}
function safeWriteJSON(pathStr, obj) {
  const tmp = `${pathStr}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, pathStr);
}

// -------------------- SWAP EXECUTION --------------------
export async function executeUnsignedSwaps(mintAddress) {
  if (!watcherActive) return;

  const wallet = getWalletFromEnvEncrypted();
  const unsignedTxs = safeReadJSON(BUILD_TX_FILE);
  if (!unsignedTxs.length) return;

  let activePositions = safeReadJSON(ACTIVE_POSITIONS_FILE);

  const filteredTxs = mintAddress
    ? unsignedTxs.filter(tx => tx.mintAddress === mintAddress)
    : unsignedTxs;

  for (const txData of filteredTxs) {
    if (activePositions.filter(p => p.active === 1).length >= MAX_ACTIVE_POSITIONS) {
      console.log("⚠️ Max active positions reached. Stopping watcher.");
      await stopWatcher();
      break;
    }

    try {
      // Reconstruct TransactionInstruction from JSON
      const ixJson = txData.unsignedInstruction;
      const keys = ixJson.keys.map(k => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable
      }));
      const data = Buffer.from(ixJson.data);

      // Adjust instruction amount dynamically using computeUnitPerTrade
      const tradeAmount = currentTradeAmount || computeUnitPerTrade(txData.reserveA);
      if (data.length >= 8) data.writeBigUInt64LE(BigInt(tradeAmount), 1);

      const instruction = new TransactionInstruction({
        keys,
        programId: new PublicKey(ixJson.programId),
        data
      });

      const tx = new Transaction().add(instruction);

      const signature = await sendWithRpcRetry(async (conn) => {
        const latest = await conn.getLatestBlockhash("finalized");
        tx.recentBlockhash = latest.blockhash;
        tx.feePayer = wallet.publicKey;

        const vtx = new VersionedTransaction(tx.compileMessage());
        vtx.sign([wallet]);

        const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
        await conn.confirmTransaction(sig, "confirmed");
        return sig;
      });

      console.log(`✅ Swap executed: ${signature}`);

      // Update active positions
      activePositions.push({
        mintAddress: txData.mintAddress,
        priceSOL: txData.priceSOL || null,
        signature,
        timestamp: Date.now(),
        active: 1
      });
      safeWriteJSON(ACTIVE_POSITIONS_FILE, activePositions);

      // Restart watcher if all sells complete
      const ready = await allSellsComplete();
      if (ready && !watcherActive) await startWatcher();

      await sendTelegram(`🚀 Swap executed\nMint: ${txData.mintAddress}\nSig: https://solscan.io/tx/${signature}`);
    } catch (err) {
      console.error("Swap execution error:", err.message);
    }
  }
}