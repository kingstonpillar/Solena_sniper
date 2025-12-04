// AutoSell_test.js
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import bs58 from "bs58";
import crypto from "crypto";

import {
  Connection,
  Keypair,
  VersionedTransaction,
  ComputeBudgetProgram
} from "@solana/web3.js";

import {
  initJupiter,
  getBestRoute,
  buildSwapTransaction
} from "./jupiterOnchain.js";

const RPC_URL = process.env.RPC_URL_6 || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC_URL, "confirmed");

const SOL_MINT = "So11111111111111111111111111111111111111112";


// -------------------------
// WALLET DECRYPTION
// -------------------------
function decryptPrivateKey(cipher, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(cipher, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWallet() {
  const enc = process.env.ENCRYPTED_KEY;
  const passPath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";

  const pass = fs.readFileSync(passPath, "utf8").trim();
  const decrypted = decryptPrivateKey(enc, pass);

  return Keypair.fromSecretKey(bs58.decode(decrypted));
}


// ------------------------------
// MAIN TEST FLOW
// ------------------------------
async function runTests() {
  console.log("🔵 Initializing Jupiter...");
  await initJupiter();
  console.log("✔ Jupiter OK\n");

  // 1. Wallet
  console.log("🔵 Loading Wallet...");
  const wallet = getWallet();
  console.log("✔ Wallet OK:", wallet.publicKey.toBase58(), "\n");

  // 2. Route discovery
  const TEST_MINT = "So11111111111111111111111111111111111111112"; // SOL → SOL test
  const TEST_AMOUNT = 50000;  

  console.log("🔵 Fetching Best Route...");
  const route = await getBestRoute(TEST_MINT, SOL_MINT, TEST_AMOUNT);
  console.log("Route:", route);
  console.log("✔ Route OK\n");

  // 3. Build unsigned TX
  console.log("🔵 Building Swap Transaction...");
  const txBuffer = await buildSwapTransaction(route);
  console.log("Unsigned TX bytes:", txBuffer.length);
  console.log("✔ Build OK\n");

  let tx = VersionedTransaction.deserialize(txBuffer);

  // 4. Add priority fee
  console.log("🔵 Adding Priority Fee...");
  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 150000 });

  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 1_000_000 // 0.001 SOL
  });

  tx.message.compiledInstructions.unshift(
    cuLimitIx.compileToV0Message(tx.message.staticAccountKeys),
    cuPriceIx.compileToV0Message(tx.message.staticAccountKeys)
  );

  console.log("✔ CU fee added\n");

  // 5. Sign – SAFE (not sending)
  console.log("🔵 Signing (SAFE TEST – no send)");
  tx.sign([wallet]);
  console.log("✔ Signed\n");

  // 6. Optional SEND
  if (process.env.ENABLE_SEND === "true") {
    console.log("⚠ REAL SEND ENABLED – broadcasting...");
    const sig = await conn.sendTransaction(tx, { skipPreflight: true });
    console.log("TX:", sig);
    console.log("https://solscan.io/tx/" + sig);
  } else {
    console.log("🛑 SEND DISABLED. Set ENABLE_SEND=true to broadcast.");
  }

  console.log("\n🎉 ALL TESTS COMPLETED");
}

runTests().catch(err => console.error("❌ Test Error:", err));