// tokenCreatorScanner.js — Creator Wallet Security Scanner
// ========================================================
// ✅ Runs BEFORE token enters potential_migrators.json
// ✅ Only safe tokens are allowed to pass to liquiditywatcher.js
// ✅ Auto-blacklist bad creator wallets (score < 30)
// ========================================================

import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import pkg from "@metaplex-foundation/mpl-token-metadata";

const { Metadata } = pkg;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const MIN_CREATOR_SCORE = parseInt(process.env.MIN_CREATOR_SCORE || "65", 10); // threshold for SAFE
const AUTO_BLACKLIST_THRESHOLD = 30; // score below → auto blacklist

const conn = new Connection(RPC_URL, "confirmed");

// Load blacklist.json if exists, otherwise create new Set
let BLACKLIST = new Set();
try {
  const data = JSON.parse(fs.readFileSync("./blacklist.json", "utf8"));
  BLACKLIST = new Set(data.wallets);
} catch {
  console.log("[tokenCreatorScanner] No blacklist file found — starting clean");
}

// Save blacklist to file
function saveBlacklist() {
  fs.writeFileSync(
    "./blacklist.json",
    JSON.stringify({ wallets: [...BLACKLIST] }, null, 2)
  );
}

export async function verifyCreatorSecurity(mintAddress) {
  const reasons = [];
  let score = 100;
  let creator = null;

  try {
    const mintPub = new PublicKey(mintAddress);

    // ------------------------------------------------------------
    // 1) Fetch Mint Account (authorities)
    // ------------------------------------------------------------
    const mintAcct = await conn.getParsedAccountInfo(mintPub);
    const parsed = mintAcct?.value?.data?.parsed?.info;

    if (!parsed) {
      return { safe: false, score: 0, reasons: ["Mint account not found"] };
    }

    const mintAuthority = parsed.mintAuthority;
    const freezeAuthority = parsed.freezeAuthority;
    const totalSupply = BigInt(parsed.supply || 0);

    if (mintAuthority) {
      score -= 35;
      reasons.push("mintAuthority still active ❌");
    } else reasons.push("Mint authority revoked ✅");

    if (freezeAuthority) {
      score -= 25;
      reasons.push("freezeAuthority still active ❌");
    } else reasons.push("Freeze authority revoked ✅");

    // ------------------------------------------------------------
    // 2) Read Metaplex Metadata
    // ------------------------------------------------------------
    try {
      const metadataPDA = await Metadata.getPDA(mintPub);
      const metadata = await Metadata.fromAccountAddress(conn, metadataPDA);

      const creators = metadata.data.data.creators || [];

      if (creators.length > 0) {
        creator = creators[0].address;

        const verifiedCount = creators.filter(c => c.verified).length;
        if (verifiedCount === 0) {
          score -= 10;
          reasons.push("Metadata creator NOT verified ❌");
        } else {
          reasons.push("Metadata creator verified ✅");
        }
      } else {
        score -= 15;
        reasons.push("No creators in metadata ❌");
      }
    } catch {
      score -= 10;
      reasons.push("Metadata missing/unreadable ❌");
    }

    // ------------------------------------------------------------
    // 3) Check creator token holding % (rug supply control check)
    // ------------------------------------------------------------
    if (creator) {
      const largest = await conn.getTokenLargestAccounts(mintPub);
      if (largest.value.length > 0) {
        const acct = largest.value[0];
        const ownerInfo = await conn.getParsedAccountInfo(new PublicKey(acct.address));
        const owner = ownerInfo.value?.data?.parsed?.info?.owner;

        if (owner === creator) {
          const amount = BigInt(acct.amount);
          const percent = totalSupply > 0n ? Number((amount * 100n) / totalSupply) : 0;

          if (percent >= 40) {
            score -= 30;
            reasons.push(`Creator holds ${percent}% supply ❌`);
          } else if (percent >= 20) {
            score -= 15;
            reasons.push(`Creator holds ${percent}% supply ⚠️`);
          } else {
            reasons.push(`Creator supply control: ${percent}% ✅`);
          }
        }
      }
    }

    // ------------------------------------------------------------
    // 4) Blacklist Check (instant reject)
    // ------------------------------------------------------------
    if (creator && BLACKLIST.has(creator)) {
      return { safe: false, score: 0, reasons: ["Creator is BLACKLISTED ❌"], creator };
    }

    // ------------------------------------------------------------
    // 5) Auto-add to blacklist if score is very bad
    // ------------------------------------------------------------
    if (creator && score < AUTO_BLACKLIST_THRESHOLD) {
      BLACKLIST.add(creator);
      saveBlacklist();
      reasons.push("Auto blacklisted — extremely unsafe creator ❌");
    }

    const safe = score >= MIN_CREATOR_SCORE;
    return { safe, score, reasons, creator };

  } catch (err) {
    return {
      safe: false,
      score: 0,
      reasons: ["Error scanning creator wallet: " + err.message],
      creator
    };
  }
}