import fs from "fs";
import { 
  Connection, 
  Keypair, 
  VersionedTransaction,
  ComputeBudgetProgram 
} from "@solana/web3.js";
import bs58 from "bs58";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

// ✅ Waits for sells to finish
import { allSellsComplete } from "./sellmonitor.js";

// ✅ Uses wallet balance auto-compute (trade amount + compute unit)
import { currentTradeAmount, computeUnitPerTrade } from "./walletbalance.js";

dotenv.config();

// --- CONFIG ---
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const ACTIVE_POSITIONS_FILE = "./active_positions.json";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_ACTIVE_POSITIONS = parseInt(process.env.MAX_ACTIVE_POSITIONS || "20");

// Solana connection
const conn = new Connection(RPC_URL);

// --- 🔐 AES decrypt private key ---
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// --- Load wallet securely ---
function getWallet() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("❌ ENCRYPTED_KEY missing in .env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/home/username/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("❌ Passphrase file missing.");
  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();

  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

// --- Telegram alerts ---
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("❌ Telegram send error:", err.message);
  }
}

// State control
let watcherActive = true;

export async function StartWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 *Liquidity Watcher Started*");
}

export async function StopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 *Liquidity Watcher Stopped — waiting for sells...*");
}

// -----------------------------------------------------
// 🚀 EXECUTE BUY (swapexecutor does not change trade amount)
// -----------------------------------------------------
export async function executeSwap(inputMint, outputMint) {
  const wallet = getWallet();
  const userPubkey = wallet.publicKey.toBase58();

  if (!currentTradeAmount || currentTradeAmount <= 0) {
    console.log("⚠️ currentTradeAmount not ready. Waiting for allSellComplete...");
    return;
  }

  let currentData = [];
  if (fs.existsSync(ACTIVE_POSITIONS_FILE)) {
    try { currentData = JSON.parse(fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8")); }
    catch { currentData = []; }
  }

  if (currentData.length >= MAX_ACTIVE_POSITIONS) {
    console.log(`🕒 Max active positions (${MAX_ACTIVE_POSITIONS}) reached.`);
    await StopWatcher();
    await allSellsComplete();
    console.log("✅ All previous sells complete. Restarting watcher...");
    await StartWatcher();
    currentData = [];
  }

  console.log(`🪙 Requesting Jupiter quote for: ${currentTradeAmount} SOL → ${outputMint}`);

  const quoteRes = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${currentTradeAmount}&slippageBps=100`
  );
  const quote = await quoteRes.json();
  if (!quote?.routePlan) throw new Error("❌ No Jupiter route returned.");

  const outputSymbol = quote.outputSymbol || "UNKNOWN";
  const buyPrice = quote.outAmount / quote.inAmount;

  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userPublicKey: userPubkey,
      wrapAndUnwrapSol: true,
      quoteResponse: quote,
    }),
  });
  const swapData = await swapRes.json();
  const { swapTransaction } = swapData;
  if (!swapTransaction) throw new Error("❌ Jupiter swap transaction missing.");

  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);

  // ------------------------------------------------------------
  // ✅ FULL CORRECT COMPUTE UNIT INJECTION (SOL → microLamports)
  // ------------------------------------------------------------
  if (computeUnitPerTrade && computeUnitPerTrade > 0) {
    console.log(`⚡ Applying Compute Unit: ${computeUnitPerTrade} SOL`);

    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 150_000, // fixed safe CU limit
    });

    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.floor(computeUnitPerTrade * 1_000_000_000), 
      // SOL → lamports → micro-lamports
    });

    // Insert CU instructions BEFORE Jupiter swap instructions
    tx.message.compiledInstructions.unshift(
      cuLimitIx.compileToV0Message(tx.message.staticAccountKeys),
      cuPriceIx.compileToV0Message(tx.message.staticAccountKeys)
    );
  }
  // ------------------------------------------------------------

  tx.sign([wallet]);

  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");

  console.log(`✅ SWAP EXECUTED: https://solscan.io/tx/${sig}`);

  const buyNumber = currentData.length + 1;
  const newEntry = {
    buyLabel: `Buy ${buyNumber}`,
    mintAddress: outputMint,
    symbol: outputSymbol,
    buyPrice,
    amount: currentTradeAmount,
    txSignature: sig,
    walletAddress: userPubkey,
    timestamp: new Date().toISOString(),
  };

  currentData.push(newEntry);
  fs.writeFileSync(ACTIVE_POSITIONS_FILE, JSON.stringify(currentData, null, 2));

  const message = `
🚀 *BUY EXECUTED*

🪙 Token: ${outputSymbol}
💰 Amount: ${currentTradeAmount} SOL
🏷 Entry: ${newEntry.buyLabel}
🔗 https://solscan.io/tx/${sig}
  `;
  await sendTelegram(message.trim());

  return sig;
}