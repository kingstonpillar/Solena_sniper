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

dotenv.config();

// --------------------------------------------------
// CONFIG
// --------------------------------------------------
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const conn = new Connection(RPC_URL, "confirmed");

const SOL_MINT = "So11111111111111111111111111111111111111112";

// --------------------------------------------------
// WALLET DECRYPTION
// --------------------------------------------------
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWallet() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("❌ ENCRYPTED_KEY missing.");

  const passphrasePath =
    process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";

  if (!fs.existsSync(passphrasePath))
    throw new Error("❌ Passphrase file missing.");

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);

  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

// --------------------------------------------------
// TELEGRAM ALERTS
// --------------------------------------------------
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.warn("⚠️ Telegram failed:", err.message);
  }
}

// --------------------------------------------------
// AUTO SELL FUNCTION
// --------------------------------------------------
export async function executeAutoSell(mintAddress, amount) {
  const wallet = getWallet();
  const userPubkey = wallet.publicKey.toBase58();

  console.log(`💰 Auto-sell triggered: ${mintAddress} | amount: ${amount}`);

  // --------------------------------------------------
  // 1. Get Jupiter Quote
  // --------------------------------------------------
  const quoteRes = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=100`
  );

  const quote = await quoteRes.json();
  if (!quote?.routePlan) {
    console.log(`⚠️ No route found for ${mintAddress}`);
    return;
  }

  const sellPrice = quote.outAmount / quote.inAmount;

  // --------------------------------------------------
  // 2. Get Jupiter Swap Transaction
  // --------------------------------------------------
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
    console.log("❌ Jupiter returned no swap transaction.");
    return;
  }

  // --------------------------------------------------
  // 3. Deserialize transaction
  // --------------------------------------------------
  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);

  // --------------------------------------------------
  // 4. Add Compute Unit → **0.001 SOL**
  // --------------------------------------------------
  const computeUnitPriceSol = 0.001; // YOUR VALUE
  const microLamports = Math.floor(computeUnitPriceSol * 1_000_000_000_000);

  console.log(`⚡ Adding 0.001 SOL compute fee => ${microLamports} microLamports`);

  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 150000,
  });

  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports,
  });

  tx.message.compiledInstructions.unshift(
    cuLimitIx.compileToV0Message(tx.message.staticAccountKeys),
    cuPriceIx.compileToV0Message(tx.message.staticAccountKeys)
  );

  // --------------------------------------------------
  // 5. SIGN & SEND
  // --------------------------------------------------
  tx.sign([wallet]);

  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");

  console.log(`✅ AUTO SELL TX: https://solscan.io/tx/${sig}`);

  // --------------------------------------------------
  // 6. Telegram notification
  // --------------------------------------------------
  const tgMsg = `
💸 *AUTO-SELL EXECUTED*

🔹 Token: \`${mintAddress}\`
💰 Sell Price: ${sellPrice.toFixed(8)} SOL
📦 Amount Sold: ${amount}
⚡ CU Fee: 0.001 SOL
👛 Wallet: \`${userPubkey}\`
🕒 ${new Date().toLocaleString()}
🔗 https://solscan.io/tx/${sig}
`;

  await sendTelegram(tgMsg.trim());

  return sig;
}