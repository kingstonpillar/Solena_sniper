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

// ----------------- Known locker program IDs (extendable via env) -----------------
// Add known locker program IDs that actually hold LP tokens (teamfinance, etc).
// You can provide extra comma-separated IDs in env: KNOWN_LOCKERS="id1,id2"
const DEFAULT_KNOWN_LOCKERS = [
  // Example placeholders — extend with real locker program IDs you trust
  // "SomeLockerProgram11111111111111111111111111111111"
];
const KNOWN_LOCKER_PROGRAM_IDS = new Set(
  (process.env.KNOWN_LOCKERS ? process.env.KNOWN_LOCKERS.split(",") : DEFAULT_KNOWN_LOCKERS)
  .map(s => s.trim()).filter(Boolean)
);

// ----------------- Configurable thresholds -----------------
const HOLDER_DECAY_SAMPLE_LIMIT = Number(process.env.HOLDER_DECAY_SAMPLE_LIMIT || 120); // number of signatures to sample
const HOLDER_DECAY_MIN_SAMPLES = Number(process.env.HOLDER_DECAY_MIN_SAMPLES || 3); // require at least this many snapshots
const HOLDER_DECAY_SUSPICIOUS_PCT = Number(process.env.HOLDER_DECAY_SUSPICIOUS_PCT || 20); // percent drop considered suspicious
const LIQUIDITY_LOCK_MIN_SAFE_DAYS = Number(process.env.LIQUIDITY_LOCK_MIN_SAFE_DAYS || 90); // default 90 days (3 months)
const LIQUIDITY_LOCK_WARNING_DAYS = Number(process.env.LIQUIDITY_LOCK_WARNING_DAYS || 30); // <30 days => warning

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

// ----------------------------- NEW: Holder Concentration Decay -----------------------------
// Sample several historical snapshots (from recent transaction signatures) and track
// top-holder percentage over time. Returns a timeline and decay metrics.
//
// Returns:
// {
//   timeline: [{ ts, topPct }...], // ts = blockTime (seconds), topPct = 0..100
//   initialTopPct, latestTopPct, decayPct, decayed: boolean
// }
//
async function analyzeHolderConcentrationDecay(mintPub, sampleLimit = HOLDER_DECAY_SAMPLE_LIMIT) {
  try {
    // get signatures for the mint (recent)
    const sigInfos = await conn.getSignaturesForAddress(mintPub, { limit: Math.min(sampleLimit, 500) });
    if (!Array.isArray(sigInfos) || sigInfos.length === 0) {
      return { timeline: [], initialTopPct: null, latestTopPct: null, decayPct: 0, decayed: false, samples: 0 };
    }

    // Select up to 4 snapshots: earliest, 1/3, 2/3, latest (but keep actual available)
    const indices = [];
    const n = sigInfos.length;
    const want = Math.min(4, n);
    for (let i = 0; i < want; i++) {
      const idx = Math.floor((i * (n - 1)) / (want - 1 || 1));
      indices.push(idx);
    }

    const timeline = [];
    for (const idx of indices) {
      const sig = sigInfos[idx].signature;
      const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);

      // compute snapshot top holder using postTokenBalances (best-effort)
      const post = tx.meta.postTokenBalances || [];
      // if there are parsed balances for this mint, compute totals
      const balances = post.filter(b => b.mint === mintPub.toBase58());
      let total = 0;
      const ownerMap = {};
      for (const b of balances) {
        const ui = Number(b.uiTokenAmount?.ui || 0);
        const owner = b.owner || (tx.transaction.message.accountKeys[b.accountIndex]?.pubkey?.toString?.()) || null;
        if (!owner) continue;
        total += ui;
        ownerMap[owner] = (ownerMap[owner] || 0) + ui;
      }

      // Fallback: if on-snapshot detection failed, try global largest accounts (approx current state)
      if (total === 0) {
        const largest = await conn.getTokenLargestAccounts(mintPub);
        const acct = largest?.value?.[0];
        if (acct) {
          // attempt small snapshot: treat current largest as proxy (not ideal, but better than nothing)
          const info = await conn.getParsedAccountInfo(new PublicKey(acct.address));
          const amt = Number(info?.value?.data?.parsed?.info?.tokenAmount?.ui || 0);
          const owner = info?.value?.data?.parsed?.info?.owner || null;
          if (owner) {
            total = amt;
            ownerMap[owner] = amt;
          }
        }
      }

      const topOwnerAmt = Object.values(ownerMap).sort((a, b) => b - a)[0] || 0;
      const topPct = total > 0 ? (topOwnerAmt / total) * 100 : 0;

      timeline.push({ ts: blockTime, topPct: Number(topPct.toFixed(4)) });
    }

    if (timeline.length < HOLDER_DECAY_MIN_SAMPLES) {
      return { timeline, initialTopPct: null, latestTopPct: null, decayPct: 0, decayed: false, samples: timeline.length };
    }

    // sort timeline by time asc
    timeline.sort((a, b) => a.ts - b.ts);
    const initialTopPct = timeline[0].topPct;
    const latestTopPct = timeline[timeline.length - 1].topPct;
    const decayPct = initialTopPct - latestTopPct;
    const decayed = decayPct >= HOLDER_DECAY_SUSPICIOUS_PCT;

    return { timeline, initialTopPct, latestTopPct, decayPct: Number(decayPct.toFixed(2)), decayed, samples: timeline.length };

  } catch (err) {
    console.log("analyzeHolderConcentrationDecay error:", err?.message || err);
    return { timeline: [], initialTopPct: null, latestTopPct: null, decayPct: 0, decayed: false, samples: 0, error: err?.message };
  }
}

// ----------------------------- NEW: Liquidity Freezing / Locker Detection -----------------------------
// Heuristics (best-effort, RPC-only):
// 1) If largest token account owner is a known locker program -> locked
// 2) If largest owner account is a program-owned account (executable owner) -> likely locker
// 3) Scan recent signatures for logs containing locker/lock/unlock/add_liquidity keywords
//    and capture blockTime for lock/unlock events to infer unlockDate.
// 4) If token largest holder is a vault/contract and we find an on-chain "unlock" timestamp in logs, return it.
// 5) Return structured info: { locked: boolean, locker: owner, lockStart, lockEnd, lockDurationDays, details }
//
// Note: This is heuristic — it's better to add real locker program IDs to KNOWN_LOCKER_PROGRAM_IDS env.
async function detectLiquidityLocking(mintPub, sigScanLimit = 200) {
  try {
    const mint = mintPub.toBase58();
    // 1) find largest token accounts
    const largestAccounts = await conn.getTokenLargestAccounts(mintPub);
    if (!largestAccounts?.value || largestAccounts.value.length === 0) {
      return { locked: false, reason: "no_token_accounts", details: {} };
    }

    const top = largestAccounts.value[0];
    const topInfo = await conn.getParsedAccountInfo(new PublicKey(top.address));
    const owner = topInfo?.value?.data?.parsed?.info?.owner || null;

    // prepare return structure
    const out = {
      locked: false,
      locker: owner || null,
      lockStart: null,
      lockEnd: null,
      lockDurationDays: null,
      lockerIsKnownProgram: false,
      lockerIsProgramAccount: false,
      details: {}
    };

    if (!owner) {
      out.details.note = "top owner missing";
      return out;
    }

    // 2) check if owner is in known lockers
    if (KNOWN_LOCKER_PROGRAM_IDS.has(owner)) {
      out.locked = true;
      out.lockerIsKnownProgram = true;
      out.details.note = "Owner is known locker program";
    }

    // 3) get owner accountInfo and detect if owner is a program account (executable) or program-derived data
    try {
      const ownerPub = new PublicKey(owner);
      const ownerAcct = await conn.getAccountInfo(ownerPub);
      if (ownerAcct) {
        // if owner account is executable, treat as program (likely dedicated locker)
        if (ownerAcct.executable) out.lockerIsProgramAccount = true;
        out.details.ownerDataLen = ownerAcct.data?.length || 0;
      }
    } catch (e) { /* ignore */ }

    // 4) scan recent signatures for the mint and for owner to see lock events and timestamps
    // we'll search keywords in logs that often appear for locker programs: 'lock', 'unlock', 'withdraw', 'release', 'vesting'
    const keywords = ["lock", "locked", "unlock", "unlock_date", "release", "vesting", "cliff", "lockup", "locker", "locked_until", "unlock_ts"];
    const sigInfos = await conn.getSignaturesForAddress(mintPub, { limit: Math.min(sigScanLimit, 500) });

    let foundLockEvent = null;
    let foundUnlockEvent = null;
    let earliestLockTs = null;
    let latestUnlockTs = null;

    for (const s of sigInfos) {
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      const logs = (tx.meta.logMessages || []).join(" ").toLowerCase();
      const blockTime = tx.blockTime || null;
      // find locker keywords
      for (const kw of keywords) {
        if (logs.includes(kw)) {
          // attempt to parse numeric timestamp following patterns (common heuristics)
          // search for "unlock" followed by numbers/iso timestamps in logs
          const matchTs = logs.match(/(unlock|unlock_date|locked_until|unlock_ts)[^0-9]{0,8}([0-9]{9,14})/);
          if (matchTs && matchTs[2]) {
            const tsNum = Number(matchTs[2]);
            if (!isNaN(tsNum) && tsNum > 1e8) {
              // if appears to be in seconds (10-digit) or ms (13-digit)
              const maybeSec = tsNum > 1e12 ? Math.floor(tsNum / 1000) : tsNum;
              if (!foundUnlockEvent || maybeSec > latestUnlockTs) {
                foundUnlockEvent = { tx: s.signature, ts: maybeSec, logsSnippet: logs.substring(0, 400) };
                latestUnlockTs = maybeSec;
              }
            }
          }
          // record lock start
          if (!foundLockEvent) {
            foundLockEvent = { tx: s.signature, ts: blockTime, logsSnippet: logs.substring(0, 400) };
            earliestLockTs = blockTime;
          }
        }
      }
      // short-circuit if both found
      if (foundLockEvent && foundUnlockEvent) break;
    }

    if (foundLockEvent) {
      out.lockStart = foundLockEvent.ts;
    }

    if (foundUnlockEvent) {
      out.lockEnd = foundUnlockEvent.ts;
    }

    // compute duration if both present
    if (out.lockStart && out.lockEnd) {
      const durDays = (out.lockEnd - out.lockStart) / 86400;
      out.lockDurationDays = Number(durDays.toFixed(2));
      // decide locked flag using lockEnd in future
      out.locked = out.locked || (out.lockEnd > Math.floor(Date.now() / 1000));
    } else if (out.lockerIsKnownProgram || out.lockerIsProgramAccount) {
      // if owner is a program and no unlock event found, assume locked for safety
      out.locked = out.locked || true;
      out.details.assumedLocked = true;
    }

    // add warnings when lock duration below thresholds
    if (out.lockDurationDays !== null) {
      if (out.lockDurationDays < (LIQUIDITY_LOCK_WARNING_DAYS)) {
        out.details.risk = "high";
      } else if (out.lockDurationDays < LIQUIDITY_LOCK_MIN_SAFE_DAYS) {
        out.details.risk = "medium";
      } else {
        out.details.risk = "low";
      }
    } else if (out.locked === true && !out.lockDurationDays) {
      out.details.risk = "unknown_locked";
    }

    out.details.foundLockEvent = foundLockEvent;
    out.details.foundUnlockEvent = foundUnlockEvent;

    return out;

  } catch (err) {
    console.log("detectLiquidityLocking error:", err?.message || err);
    return { locked: false, error: err?.message };
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
      if (foundDanger) {
        reasons.push("Dangerous Token-2022 extension found — strict-mode: auto-fail ❌");
        return { safe: false, score: 0, reasons, creator };
      }

      // Transfer fee config: if present and high (>= 50%) treat as auto-fail
      const feeKeys = ["transferfee", "transfer_fee", "transferfeeconfig", "transfer_fee_config"];
      const hasFee = t2022.extensions.some(e => feeKeys.some(k => String(e).toLowerCase().includes(k)));
      if (hasFee) {
        reasons.push("Transfer-fee extension present — strict-mode: auto-fail ❌");
        return { safe: false, score: 0, reasons, creator };
      }

      // If Token-2022 detected but no clear dangerous extension discovered, apply moderate penalty
      score -= 30;
      reasons.push("Token-2022 detected with unknown/benign extensions — heavy penalty applied ⚠️");
    }

    // ----------------- Creator supply concentration (largest holder) -----------------
    // NEW: first run holder concentration decay analysis to detect suspicious sudden dilution or redistribution
    const holderDecay = await analyzeHolderConcentrationDecay(mintPub);
    if (holderDecay && holderDecay.samples && holderDecay.samples >= HOLDER_DECAY_MIN_SAMPLES) {
      reasons.push(`Holder decay: initialTop=${holderDecay.initialTopPct}% latestTop=${holderDecay.latestTopPct}% decay=${holderDecay.decayPct}%`);
      if (holderDecay.decayed) {
        // significant decay of top holder may indicate migration/rebalance (suspicious) OR healthy distribution.
        // We penalize heavily if top holder drops by a large margin quickly (could mean rug-prep or migration).
        score -= 25;
        reasons.push("Holder concentration decayed rapidly — suspicious redistribution detected ❌");
      } else {
        // small positive if top holder reduced somewhat (more decentralization)
        if (holderDecay.decayPct >= 5) { score += 5; reasons.push("Top holder decreased slightly — decentralizing ✅"); }
      }
    } else {
      reasons.push("Holder decay: insufficient samples or no recent activity");
    }

    // Continue existing concentration check (largest holder percent in current snapshot)
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

    // ----------------- Liquidity Lock Detection (NEW) -----------------
    // We run liquidity locking detection and use it to adjust score or auto-fail
    const lockInfo = await detectLiquidityLocking(mintPub);
    if (lockInfo && lockInfo.locked) {
      // if lock duration known and too short -> flag
      if (lockInfo.lockDurationDays !== null) {
        reasons.push(`LP lock detected: ${lockInfo.lockDurationDays} days (locker=${lockInfo.locker})`);
        if (lockInfo.lockDurationDays < LIQUIDITY_LOCK_WARNING_DAYS) {
          // very short lock duration — treat as auto-fail
          reasons.push("LP lock duration too short — auto-fail ❌");
          return { safe: false, score: 0, reasons, creator, lockInfo };
        } else if (lockInfo.lockDurationDays < LIQUIDITY_LOCK_MIN_SAFE_DAYS) {
          // medium risk — penalize
          score -= 25;
          reasons.push("LP lock duration below safe threshold (medium risk) ⚠️");
        } else {
          // good lock duration
          score += 10;
          reasons.push("LP locked for a healthy duration ✅");
        }
      } else {
        // locked but unknown duration — be conservative
        reasons.push("LP appears locked but duration unknown — conservative penalty applied ⚠️");
        score -= 20;
      }

      // if locker is unknown program or has suspicious characteristics, stronger penalty
      if (!lockInfo.lockerIsKnownProgram && lockInfo.lockerIsProgramAccount) {
        reasons.push("Locker is a program-owned account but not known — suspicious (needs manual review)");
        score -= 15;
      }
    } else {
      reasons.push("No clear LP lock detected (or locker unknown) — treat with caution");
    }

    // ----------------- Finalize score: clamp to 0..100
    if (score > 100) score = 100;
    if (score < 0) score = 0;

    const safe = score >= MIN_CREATOR_SCORE;

    return { safe, score, reasons, creator, lockInfo };

  } catch (err) {
    console.error("[tokenCreatorScanner] verifyCreatorSafety error:", err?.message || err);
    return { safe: false, score: 0, reasons: ["RPC error or invalid mint"], creator: null };
  }
}