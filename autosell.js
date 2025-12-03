import fs from "fs";
import {
  Connection,
  Keypair,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

import bs58 from "bs58";
import dotenv from "dotenv";
import crypto from "crypto";

import {
  initJupiter,
  getBestRoute,
  buildSwapTransaction,   // ← NEW
} from "./jupiterOnchain.js";

dotenv.config();

// --------------------------------------------------
// CONFIG
// --------------------------------------------------
const RPC_URL = process.env.RPC_URL_6 || "https://api.mainnet-beta.solana.com";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const conn = new Connection(RPC_URL, "confirmed");

const SOL_MINT = "So11111111111111111111111111111111111111112";


// --------------------------------------------------
// RETRY WRAPPER
// --------------------------------------------------
async function retry(fn, attempts = 3, delay = 500) {
  let error;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      error = err;

      if (i === attempts - 1) throw error;

      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw error;
}


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
// TELEGRAM ALERT
// --------------------------------------------------
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await retry(
      () =>
        fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: msg,
            parse_mode: "Markdown",
          }),
        }),
      3,
      700
    );
  } catch (err) {
    console.warn("⚠️ Telegram failed:", err.message);
  }
}


// --------------------------------------------------
// AUTO SELL (ON-CHAIN ONLY)
// --------------------------------------------------
export async function executeAutoSell(mintAddress, amount) {
  await initJupiter();   // IMPORTANT

  const wallet = getWallet();
  const userPubkey = wallet.publicKey.toBase58();

  console.log(`💰 Auto-sell triggered: ${mintAddress} | amount: ${amount}`);


  // --------------------------------------------------
  // 1. On-chain Best Route
  // --------------------------------------------------
  const route = await retry(
    () => getBestRoute(mintAddress, SOL_MINT, amount, { slippageBps: 100 }),
    3,
    700
  );

  if (!route) {
    console.log(`⚠️ No route found for ${mintAddress}`);
    return;
  }

  const sellPrice =
    route.outAmount && route.inAmount
      ? Number(route.outAmount) / Number(route.inAmount)
      : 0;


  // --------------------------------------------------
  // 2. Build Swap Transaction (ON-CHAIN)
  // --------------------------------------------------
  const txBuf = await retry(
    () => buildSwapTransaction(route),
    3,
    700
  );

  let tx = VersionedTransaction.deserialize(txBuf);


  // --------------------------------------------------
  // 3. Add your 0.001 SOL CU Priority Fee
  // --------------------------------------------------
  const computeUnitPriceSol = 0.001;
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
  // 4. SIGN & SEND
  // --------------------------------------------------
  tx.sign([wallet]);

  const sig = await retry(
    () => conn.sendTransaction(tx, { skipPreflight: true }),
    3,
    700
  );

  await retry(
    () => conn.confirmTransaction(sig, "confirmed"),
    3,
    700
  );

  console.log(`✅ AUTO SELL TX: https://solscan.io/tx/${sig}`);


  // --------------------------------------------------
  // 5. Telegram Alert
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