// tokenCreatorScanner.js — PURE RPC VERSION (Creators-only metadata, verified scoring, Token-2022 protection)
// =======================================================

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import fetch from "node-fetch";
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
const AUTO_BLACKLIST_THRESHOLD = Number(process.env.AUTO_BLACKLIST_THRESHOLD || 30);

// ----------------- Solana RPC -----------------
const conn = new Connection(RPC_URL, "confirmed");

// ----------------- Load blacklist -----------------
let BLACKLIST = new Set();
const blacklistPath = path.resolve(__dirname, "blacklist.json");

try {
  if (fs.existsSync(blacklistPath)) {
    const data = JSON.parse(fs.readFileSync(blacklistPath, "utf8"));
    BLACKLIST = new Set(Array.isArray(data.wallets) ? data.wallets : []);
  } else {
    console.log("[tokenCreatorScanner] No blacklist.json found — starting fresh");
  }
} catch (err) {
  console.log("[tokenCreatorScanner] Error reading blacklist.json:", err.message);
}

function saveBlacklist() {
  try {
    fs.writeFileSync(
      blacklistPath,
      JSON.stringify({ wallets: [...BLACKLIST] }, null, 2)
    );
  } catch (e) {
    console.error("[tokenCreatorScanner] Failed to save blacklist:", e.message);
  }
}

// ----------------- Known DEX program IDs (treat as LP owners) -----------------
const KNOWN_LP_PROGRAM_IDS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h", // Raydium stable
  "9WwRZjZJY9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5", // Orca AMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
  // Add others as needed
]);

// -----------------------------------------------------
// Helper: read creators[] from Metaplex metadata PDA (creators-only parsing)
// - returns { creators, updateAuthority, uri } or null
// - lightweight, robust; not perfect for every exotic metadata format
// -----------------------------------------------------
async function getCreatorsFromMetadata(mintPub) {
  try {
    const METADATA_PROGRAM = new PublicKey(
      "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
    );

    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM.toBuffer(),
        mintPub.toBuffer(),
      ],
      METADATA_PROGRAM
    );

    const acct = await conn.getAccountInfo(metadataPDA);
    if (!acct?.data) return null;

    const data = acct.data;
    let idx = 0;

    // key (1)
    idx += 1;
    // updateAuthority (32)
    if (idx + 32 > data.length) return null;
    const updateAuthorityBytes = data.slice(idx, idx + 32);
    const updateAuthority = new PublicKey(updateAuthorityBytes).toBase58();
    idx += 32;
    // mint (32)
    idx += 32;
    if (idx >= data.length) return { creators: null, updateAuthority, uri: null };

    // name (1 + nameLen)
    const nameLen = data[idx];
    idx += 1 + nameLen;
    if (idx >= data.length) return { creators: null, updateAuthority, uri: null };

    // symbol
    const symbolLen = data[idx];
    idx += 1 + symbolLen;
    if (idx >= data.length) return { creators: null, updateAuthority, uri: null };

    // uri
    const uriLen = data[idx];
    idx += 1;
    if (idx + uriLen > data.length) return { creators: null, updateAuthority, uri: null };
    const uriBuf = data.slice(idx, idx + uriLen);
    const uri = uriBuf.toString("utf8").replace(/\0+$/g, ""); // strip trailing nulls
    idx += uriLen;
    if (idx >= data.length) return { creators: null, updateAuthority, uri };

    // seller fee (2)
    idx += 2;
    if (idx >= data.length) return { creators: null, updateAuthority, uri };

    // hasCreators (1)
    const hasCreators = data[idx];
    idx += 1;
    if (!hasCreators) return { creators: null, updateAuthority, uri };

    // creators vector length: u32 little-endian
    if (idx + 4 > data.length) return { creators: null, updateAuthority, uri };
    const creatorsLen = data.readUInt32LE(idx);
    idx += 4;

    const creators = [];
    for (let i = 0; i < creatorsLen; i++) {
      if (idx + 34 > data.length) break; // need 32 addr + 1 verified + 1 share
      const addrBytes = data.slice(idx, idx + 32);
      const addr = new PublicKey(addrBytes).toBase58();
      idx += 32;
      const verified = data[idx]; // 0 or 1
      const share = data[idx + 1];
      idx += 2;
      creators.push({ address: addr, verified: Number(verified), share: Number(share) });
    }

    return creators.length
      ? { creators, updateAuthority, uri: uri || null }
      : { creators: null, updateAuthority, uri: uri || null };
  } catch (err) {
    // Parsing may fail on compressed metadata; return null so caller can apply fallback
    return null;
  }
}

// -----------------------------------------------------
// Helper: fetch off-chain metadata JSON (URI fallback) and extract creators[] if present
// -----------------------------------------------------
async function fetchMetadataUriCreators(uri) {
  try {
    if (!uri) return null;
    // some URIs contain metadata like ipfs://..., support common patterns:
    if (uri.startsWith("ipfs://")) {
      // convert to public gateway
      uri = uri.replace("ipfs://", "https://ipfs.io/ipfs/");
    }
    const res = await fetch(uri, { timeout: 8000 });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j) return null;

    // canonical Metaplex JSON often has properties.creators or creators
    const props = j.properties || j;
    const creators = props.creators || j.creators || null;
    if (!Array.isArray(creators)) return null;

    // creators entries may be {address, share} or strings
    const parsed = creators.map(c => {
      if (typeof c === "string") return { address: c, verified: 0, share: 0 };
      return { address: c.address || c.wallet || c.creator || null, verified: c.verified ? 1 : 0, share: c.share || 0 };
    }).filter(x => x.address);

    return parsed.length ? parsed : null;
  } catch (err) {
    return null;
  }
}

// -----------------------------------------------------
// Token-2022 detection heuristics
// - uses parsed mint fields (some RPCs surface `extensions`), raw account size fallback,
// - inspects parsed token account keys for transferFeeConfig etc when available
// -----------------------------------------------------
async function detectToken2022AndExtensions(mintPub) {
  try {
    // get parsed mint (if RPC provides extensions)
    const parsedMintInfo = await conn.getParsedAccountInfo(mintPub);
    const parsed = parsedMintInfo?.value?.data?.parsed?.info || null;

    const raw = await conn.getAccountInfo(mintPub);
    const rawLen = raw?.data?.length || 0;

    const result = {
      isToken2022: false,
      extensions: [], // names of detected extensions
      rawLen
    };

    // 1) RPC-parsed "extensions" (many modern RPCs expose this)
    const extList = parsed?.extensions || null;
    if (Array.isArray(extList) && extList.length > 0) {
      result.isToken2022 = true;
      result.extensions = extList.slice();
    }

    // 2) Heuristic: raw mint account size > typical SPL mint size (~82 bytes) -> possible token-2022
    // Note: size thresholds vary by vendor; use 200 as safe indicator for extensions presence
    if (!result.isToken2022 && rawLen > 200) {
      result.isToken2022 = true;
      // unknown extensions; leave empty
    }

    // 3) Additional parsed fields detection (some RPCs include transferFeeConfigAuthority etc)
    if (parsed) {
      // common extension keys
      const knownKeys = [
        "transferFeeConfigAuthority",
        "transferFeeConfig",
        "transferHookProgram",
        "confidentialTransferMint",
        "nonTransferable",
        "interestBearingConfig",
        "defaultAccountState"
      ];
      for (const k of knownKeys) {
        if (Object.prototype.hasOwnProperty.call(parsed, k)) {
          result.isToken2022 = true;
          result.extensions.push(k);
        }
      }
      // if parsed.extensions was not present but parsed shows 'transferFeeConfigAuthority'
      if (parsed.transferFeeConfigAuthority || parsed.transferHookProgram || parsed.confidentialTransferMint) {
        result.isToken2022 = true;
      }
    }

    // Normalize extension strings (lowercase)
    result.extensions = Array.from(new Set(result.extensions.map(x => String(x).toLowerCase())));

    return result;
  } catch (err) {
    return { isToken2022: false, extensions: [], rawLen: 0 };
  }
}

// =======================================================
// VERIFY CREATOR SAFETY — PURE RPC + Token-2022 (Strict mode)
// =======================================================
export async function verifyCreatorSafety(mintAddress) {
  let reasons = [];
  let score = 100;
  let creator = null;
  let creatorsParsed = false;

  try {
    const mintPub = new PublicKey(mintAddress);

    // ----------------- Mint account checks -----------------
    const mintAcct = await conn.getParsedAccountInfo(mintPub);
    const parsed = mintAcct?.value?.data?.parsed?.info;

    if (!parsed) {
      return { safe: false, score: 0, reasons: ["Mint account not found"], creator };
    }

    const mintAuthority = parsed.mintAuthority ?? null;
    const freezeAuthority = parsed.freezeAuthority ?? null;
    const totalSupply = BigInt(parsed.supply || 0);

    // mintAuthority: penalize if present (can mint more tokens)
    if (mintAuthority !== null && typeof mintAuthority !== "undefined") {
      score -= 35;
      reasons.push("mintAuthority still active ❌");
    } else {
      reasons.push("Mint authority revoked ✅");
    }

    // freezeAuthority: penalize if present and non-null
    if (freezeAuthority !== null && typeof freezeAuthority !== "undefined") {
      score -= 15; // smaller penalty than mintAuthority
      reasons.push("freezeAuthority still active ❌");
    } else {
      reasons.push("Freeze authority revoked ✅");
    }

    // ----------------- Creator extraction via metadata creators[] -----------------
    let metaResult = await getCreatorsFromMetadata(mintPub);
    let creators = metaResult?.creators || null;
    let updateAuthority = metaResult?.updateAuthority || null;
    let uri = metaResult?.uri || null;

    // If no on-chain creators parsed, try URI fallback (metadata JSON)
    if ((!creators || creators.length === 0) && uri) {
      const fetched = await fetchMetadataUriCreators(uri);
      if (fetched) {
        creators = fetched;
        creatorsParsed = true;
        reasons.push("Fetched creators from off-chain metadata URI ✅");
      }
    }

    // If still no creators and no uri, try to fetch metadata via alternate PDA parsing fallback:
    // (we already attempted PDA parse; bail to avoid heavy heuristics)
    if (creators && creators.length > 0) {
      creatorsParsed = creatorsParsed || true;
      creator = creators[0].address;
      const anyVerified = creators.some(c => Number(c.verified) === 1);
      const verifiedCount = creators.filter(c => Number(c.verified) === 1).length;

      if (anyVerified) {
        score += 15;
        reasons.push(`Creator from metadata: ${creator} (verified creators: ${verifiedCount}) ✅`);
      } else {
        score -= 12;
        reasons.push(`Creators present but none verified ❌ (primary: ${creator})`);
      }
    } else {
      // mild penalty if creators not found (avoid false positives)
      score -= 8;
      reasons.push("No metadata creators found (parser fallback) — mild penalty applied ❌");
    }

    // If metadata updateAuthority present and mutable, small penalty
    if (updateAuthority && updateAuthority !== "11111111111111111111111111111111") {
      reasons.push(`updateAuthority: ${updateAuthority} (metadata mutable) ⚠️`);
      score -= 10;
    } else if (updateAuthority === "11111111111111111111111111111111") {
      reasons.push("updateAuthority: system (immutable) ✅");
    }

    // ----------------- Token-2022 detection & extension checks (STRICT MODE) -----------------
    const t2022 = await detectToken2022AndExtensions(mintPub);
    if (t2022.isToken2022) {
      reasons.push(`Token-2022 detected (rawLen=${t2022.rawLen}) — extensions: ${t2022.extensions.join(", ") || "unknown"}`);

      // STRICT MODE (Mode 1): any dangerous extension => immediate unsafe
      // Dangerous extensions list (strict): transferhook, permanentdelegate, nontransferable, confidentialtransfer, defaultaccountstate (non-zero), interestbearing, metadata pointer to external auth
      const extSet = new Set(t2022.extensions.map(e => String(e).toLowerCase()));

      const dangerous = [
        "transferhook",
        "transfer_hook",
        "permanentdelegate",
        "permanent_delegate",
        "nontransferable",
        "non_transferable",
        "confidentialtransfer",
        "confidential_transfer",
        "interestbearing",
        "interest_bearing",
        "defaultaccountstate"
      ];

      const foundDanger = dangerous.some(d => extSet.has(d));
      // Also check rawLen heuristic: very large rawLen often means extensions present; treat as suspicious
      if (foundDanger) {
        reasons.push("Dangerous Token-2022 extension found — strict-mode: auto-fail ❌");
        return { safe: false, score: 0, reasons, creator };
      }

      // Transfer fee config: if present and high (>= 50%) treat as auto-fail
      const feeKeys = ["transferfee", "transfer_fee", "transferfeeconfig", "transfer_fee_config"];
      const hasFee = t2022.extensions.some(e => feeKeys.some(k => String(e).toLowerCase().includes(k)));
      if (hasFee) {
        // In strict mode, consider any transfer fee extension as a strong risk.
        reasons.push("Transfer-fee extension present — strict-mode: auto-fail ❌");
        return { safe: false, score: 0, reasons, creator };
      }

      // If Token-2022 detected but no clear dangerous extension discovered, apply moderate penalty (but not auto-fail)
      score -= 30;
      reasons.push("Token-2022 detected with unknown/benign extensions — heavy penalty applied ⚠️");
    }

    // ----------------- Creator supply concentration (largest holder) -----------------
    const largest = await conn.getTokenLargestAccounts(mintPub);

    if (largest?.value?.length > 0) {
      const acct = largest.value[0];
      const acctInfo = await conn.getParsedAccountInfo(new PublicKey(acct.address));
      const owner = acctInfo?.value?.data?.parsed?.info?.owner || null;

      if (owner && KNOWN_LP_PROGRAM_IDS.has(owner)) {
        reasons.push("Largest holder appears to be a liquidity pool / DEX account — ignoring concentration penalty ✅");
      } else {
        let amount = 0n;
        try { amount = BigInt(acct.amount); } catch { amount = 0n; }
        const percent = totalSupply > 0n ? Number((amount * 100n) / totalSupply) : 0;

        if (percent >= 40) {
          score -= 30;
          reasons.push(`Largest holder has ${percent}% supply ❌`);
        } else if (percent >= 20) {
          score -= 15;
          reasons.push(`Largest holder has ${percent}% ⚠️`);
        } else {
          reasons.push(`Largest holder supply: ${percent}% ✅`);
        }
      }
    } else {
      reasons.push("No token holders found ❌");
    }

    // ----------------- Blacklist -----------------
    if (creator && BLACKLIST.has(creator)) {
      return { safe: false, score: 0, reasons: ["Creator is BLACKLISTED ❌"], creator };
    }

    // ----------------- Auto-blacklist (only when creators parsed reliably) -----------------
    if (creator && creatorsParsed && score < AUTO_BLACKLIST_THRESHOLD) {
      BLACKLIST.add(creator);
      saveBlacklist();
      reasons.push("Auto-blacklisted — unsafe creator ❌");
    }

    // ----------------- Finalize score: clamp to 0..100
    if (score > 100) score = 100;
    if (score < 0) score = 0;

    const safe = score >= MIN_CREATOR_SCORE;

    return { safe, score, reasons, creator };

  } catch (err) {
    console.error("[tokenCreatorScanner] verifyCreatorSafety error:", err?.message || err);
    return { safe: false, score: 0, reasons: ["RPC error or invalid mint"], creator: null };
  }
}