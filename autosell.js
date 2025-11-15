import fs from "fs";
import { Connection, Keypair, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import bs58 from "bs58";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

// --- CONFIG ---
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const conn = new Connection(RPC_URL, "confirmed");

// --- AES decrypt private key ---
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

// --- Send Telegram Alerts ---
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
    console.warn("❌ Telegram alert failed:", err.message);
  }
}

// --- Auto Sell Core Function ---
export async function executeAutoSell(mintAddress, amount) {
  const wallet = getWallet();
  const userPubkey = wallet.publicKey.toBase58();
  const SOL_MINT = "So11111111111111111111111111111111111111112";

  console.log(`💰 Auto-sell triggered for ${mintAddress} — amount: ${amount}`);

  // Fetch swap quote
  const quoteRes = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=100`
  );
  const quote = await quoteRes.json();
  if (!quote?.routePlan) {
    console.log(`⚠️ No swap route found for ${mintAddress}`);
    return;
  }

  const sellPrice = quote.outAmount / quote.inAmount;

  // Get Swap Transaction
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
  if (!swapTransaction) {
    console.log(`❌ Jupiter returned no transaction for ${mintAddress}.`);
    return;
  }

  // --- DESERIALIZE TRANSACTION ---
  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);

  // --- ADD COMPUTE UNIT INSTRUCTIONS (~0.001 SOL) ---
  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 150000 });
  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 7 }); // ~0.001 SOL

  tx.message.compiledInstructions.unshift(
    cuLimitIx.compileToV0Message(tx.message.staticAccountKeys),
    cuPriceIx.compileToV0Message(tx.message.staticAccountKeys)
  );

  // --- SIGN & SEND ---
  tx.sign([wallet]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");

  console.log(`✅ Sell TX: https://solscan.io/tx/${sig}`);

  // --- TELEGRAM ---
  const message = `
💸 *Auto-Sell Executed Successfully!*

🔹 Token: \`${mintAddress}\`
💰 Sell Price: ${sellPrice.toFixed(8)} SOL
📦 Amount Sold: ${amount}
👛 Wallet: \`${userPubkey}\`
🕒 Time: ${new Date().toLocaleString()}
🔗 https://solscan.io/tx/${sig}
`;
  await sendTelegram(message.trim());

  console.log(`📩 Sell complete for ${mintAddress}`);
  return sig;
}