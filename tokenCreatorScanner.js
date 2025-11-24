// tokenCreatorScanner.js — PURE RPC VERSION
// =======================================================

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";

// ----------------- Resolve __dirname -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------- Load .env -----------------
dotenv.config({ path: path.resolve(__dirname, ".env") });

// ----------------- ENV -----------------
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("RPC_URL is not defined in .env");

const MIN_CREATOR_SCORE = Number(process.env.MIN_CREATOR_SCORE || 65);
const AUTO_BLACKLIST_THRESHOLD = 30;

// ----------------- Solana RPC -----------------
const conn = new Connection(RPC_URL, "confirmed");

// ----------------- Load blacklist -----------------
let BLACKLIST = new Set();
const blacklistPath = path.resolve(__dirname, "blacklist.json");

try {
  if (fs.existsSync(blacklistPath)) {
    const data = JSON.parse(fs.readFileSync(blacklistPath, "utf8"));
    BLACKLIST = new Set(data.wallets);
  } else {
    console.log("[tokenCreatorScanner] No blacklist.json found — starting fresh");
  }
} catch (err) {
  console.log("[tokenCreatorScanner] Error reading blacklist.json:", err.message);
}

function saveBlacklist() {
  fs.writeFileSync(
    blacklistPath,
    JSON.stringify({ wallets: [...BLACKLIST] }, null, 2)
  );
}

// =======================================================
// VERIFY CREATOR SAFETY — PURE RPC
// =======================================================
export async function verifyCreatorSafety(mintAddress) {
  let reasons = [];
  let score = 100;
  let creator = null;

  try {
    const mintPub = new PublicKey(mintAddress);

    // ----------------- Mint account checks -----------------
    const mintAcct = await conn.getParsedAccountInfo(mintPub);
    const parsed = mintAcct?.value?.data?.parsed?.info;

    if (!parsed) {
      return { safe: false, score: 0, reasons: ["Mint account not found"], creator };
    }

    const mintAuthority = parsed.mintAuthority;
    const freezeAuthority = parsed.freezeAuthority;
    const totalSupply = BigInt(parsed.supply || 0);

    if (mintAuthority) {
      score -= 35;
      reasons.push("mintAuthority still active ❌");
    } else {
      reasons.push("Mint authority revoked ✅");
    }

    if (freezeAuthority) {
      score -= 25;
      reasons.push("freezeAuthority still active ❌");
    } else {
      reasons.push("Freeze authority revoked ✅");
    }

    // ----------------- Creator supply concentration -----------------
    const largest = await conn.getTokenLargestAccounts(mintPub);
    if (largest.value.length > 0) {
      const acct = largest.value[0];
      const ownerInfo = await conn.getParsedAccountInfo(new PublicKey(acct.address));
      creator = ownerInfo.value?.data?.parsed?.info?.owner || null;

      if (creator) {
        const amount = BigInt(acct.amount);
        const percent = totalSupply > 0n ? Number((amount * 100n) / totalSupply) : 0;

        if (percent >= 40) {
          score -= 30;
          reasons.push(`Creator holds ${percent}% supply ❌`);
        } else if (percent >= 20) {
          score -= 15;
          reasons.push(`Creator holds ${percent}% ⚠️`);
        } else {
          reasons.push(`Creator supply: ${percent}% ✅`);
        }
      }
    } else {
      reasons.push("No token holders found ❌");
    }

    // ----------------- Blacklist -----------------
    if (creator && BLACKLIST.has(creator)) {
      return { safe: false, score: 0, reasons: ["Creator is BLACKLISTED ❌"], creator };
    }

    // ----------------- Auto-blacklist -----------------
    if (creator && score < AUTO_BLACKLIST_THRESHOLD) {
      BLACKLIST.add(creator);
      saveBlacklist();
      reasons.push("Auto-blacklisted — unsafe creator ❌");
    }

    return { safe: score >= MIN_CREATOR_SCORE, score, reasons, creator };
  } catch (err) {
    return { safe: false, score: 0, reasons: ["RPC error or invalid mint"], creator: null };
  }
}