// tokenCreatorScanner.js — FIXED + CLEAN VERSION
// =======================================================
// Uses ONLY the supported UMI bundle + mpl-token-metadata
// =======================================================

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { publicKey } from "@metaplex-foundation/umi";

// ----------------- ENV -----------------
const RPC_URL = process.env.RPC_URL;
const MIN_CREATOR_SCORE = Number(process.env.MIN_CREATOR_SCORE || 65);
const AUTO_BLACKLIST_THRESHOLD = 30;

// ----------------- Solana RPC -----------------
const conn = new Connection(RPC_URL, "confirmed");

// ----------------- UMI -----------------
const umi = createUmi(RPC_URL).use(mplTokenMetadata());

// ----------------- Load blacklist -----------------
let BLACKLIST = new Set();
try {
  const data = JSON.parse(fs.readFileSync("./blacklist.json", "utf8"));
  BLACKLIST = new Set(data.wallets);
} catch {
  console.log("[tokenCreatorScanner] No blacklist.json found — starting fresh");
}

function saveBlacklist() {
  fs.writeFileSync(
    "./blacklist.json",
    JSON.stringify({ wallets: [...BLACKLIST] }, null, 2)
  );
}

// =======================================================
// VERIFY CREATOR SAFETY
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
      return {
        safe: false,
        score: 0,
        reasons: ["Mint account not found"],
      };
    }

    const mintAuthority = parsed.mintAuthority;
    const freezeAuthority = parsed.freezeAuthority;
    const totalSupply = BigInt(parsed.supply || 0);

    // mintAuthority
    if (mintAuthority) {
      score -= 35;
      reasons.push("mintAuthority still active ❌");
    } else {
      reasons.push("Mint authority revoked ✅");
    }

    // freezeAuthority
    if (freezeAuthority) {
      score -= 25;
      reasons.push("freezeAuthority still active ❌");
    } else {
      reasons.push("Freeze authority revoked ✅");
    }

    // ----------------- Metadata (UMI) -----------------
    try {
      const metadata = await umi.rpc.getMetadata(publicKey(mintAddress));
      const creators = metadata.creators ?? [];

      if (creators.length === 0) {
        score -= 15;
        reasons.push("No creators in metadata ❌");
      } else {
        creator = creators[0].address.toString();

        const verifiedCount = creators.filter(c => c.verified).length;

        if (verifiedCount === 0) {
          score -= 10;
          reasons.push("Creator NOT verified ❌");
        } else {
          reasons.push("Creator verified in metadata ✅");
        }
      }
    } catch {
      score -= 10;
      reasons.push("Metadata unreadable ❌");
    }

    // ----------------- Supply concentration -----------------
    if (creator) {
      const largest = await conn.getTokenLargestAccounts(mintPub);

      if (largest.value.length > 0) {
        const acct = largest.value[0];

        const ownerInfo = await conn.getParsedAccountInfo(
          new PublicKey(acct.address)
        );

        const owner = ownerInfo.value?.data?.parsed?.info?.owner;

        if (owner === creator) {
          const amount = BigInt(acct.amount);
          const percent =
            totalSupply > 0n ? Number((amount * 100n) / totalSupply) : 0;

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
      }
    }

    // ----------------- Blacklist -----------------
    if (creator && BLACKLIST.has(creator)) {
      return {
        safe: false,
        score: 0,
        reasons: ["Creator is BLACKLISTED ❌"],
        creator,
      };
    }

    // ----------------- Auto–blacklist -----------------
    if (creator && score < AUTO_BLACKLIST_THRESHOLD) {
      BLACKLIST.add(creator);
      saveBlacklist();
      reasons.push("Auto-blacklisted — unsafe creator ❌");
    }

    return {
      safe: score >= MIN_CREATOR_SCORE,
      score,
      reasons,
      creator,
    };
  } catch (err) {
    return {
      safe: false,
      score: 0,
      reasons: ["Error scanning creator: " + err.message],
      creator,
    };
  }
}