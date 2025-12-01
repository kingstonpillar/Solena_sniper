// tokenCreatorScanner.js — PURE RPC VERSION (Hardened for runtime safety)
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
  console.log("[tokenCreatorScanner] Error reading blacklist.json:", err?.message || err);
}

function saveBlacklist() {
  try {
    fs.writeFileSync(
      blacklistPath,
      JSON.stringify({ wallets: [...BLACKLIST] }, null, 2)
    );
  } catch (e) {
    console.error("[tokenCreatorScanner] Failed to save blacklist:", e?.message || e);
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
const DEFAULT_KNOWN_LOCKERS = [];
const KNOWN_LOCKER_PROGRAM_IDS = new Set(
  (process.env.KNOWN_LOCKERS ? process.env.KNOWN_LOCKERS.split(",") : DEFAULT_KNOWN_LOCKERS)
  .map(s => s.trim()).filter(Boolean)
);

// ----------------- Configurable thresholds -----------------
const HOLDER_DECAY_SAMPLE_LIMIT = Number(process.env.HOLDER_DECAY_SAMPLE_LIMIT || 120);
const HOLDER_DECAY_MIN_SAMPLES = Number(process.env.HOLDER_DECAY_MIN_SAMPLES || 3);
const HOLDER_DECAY_SUSPICIOUS_PCT = Number(process.env.HOLDER_DECAY_SUSPICIOUS_PCT || 20);
const LIQUIDITY_LOCK_MIN_SAFE_DAYS = Number(process.env.LIQUIDITY_LOCK_MIN_SAFE_DAYS || 90);
const LIQUIDITY_LOCK_WARNING_DAYS = Number(process.env.LIQUIDITY_LOCK_WARNING_DAYS || 30);

// ----------------- Small helpers -----------------
function safeNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
function safeIntFromStringOrBig(value) {
  // value may be string of integer (e.g. token amount)
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.floor(value));
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    // fallback
    return BigInt(Math.floor(Number(value) || 0));
  } catch (e) {
    return BigInt(0);
  }
}
function clampPercent(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

// ----------------------------- METADATA PARSING -----------------------------
async function getCreatorsFromMetadata(mintPub) {
  try {
    const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mintPub.toBuffer()],
      METADATA_PROGRAM
    );

    const acct = await conn.getAccountInfo(metadataPDA);
    if (!acct?.data) return null;

    const data = acct.data;
    let idx = 0;

    // defensive bounds helper
    const need = (len) => {
      if (idx + len > data.length) throw new Error("metadata parse OOB");
    };

    // key (1)
    need(1);
    idx += 1;

    // updateAuthority (32)
    need(32);
    const updateAuthorityBytes = data.slice(idx, idx + 32);
    const updateAuthority = new PublicKey(updateAuthorityBytes).toBase58();
    idx += 32;

    // mint (32)
    need(32);
    idx += 32;

    // name (1 + nameLen)
    need(1);
    const nameLen = data[idx];
    need(1 + nameLen);
    idx += 1 + nameLen;

    // symbol
    need(1);
    const symbolLen = data[idx];
    need(1 + symbolLen);
    idx += 1 + symbolLen;

    // uri
    need(1);
    const uriLen = data[idx];
    need(uriLen);
    const uriBuf = data.slice(idx + 1, idx + 1 + uriLen);
    // NOTE: previous code moved idx before reading; make robust:
    idx += 1;
    const uri = uriBuf.toString("utf8").replace(/\0+$/g, "");
    idx += uriLen;

    // seller fee basis points (2)
    need(2);
    idx += 2;

    // has creators
    need(1);
    const hasCreators = data[idx];
    idx += 1;
    if (!hasCreators) return { creators: null, updateAuthority, uri };

    // creators vector length (u32 little-endian)
    need(4);
    const creatorsLen = data.readUInt32LE(idx);
    idx += 4;

    const creators = [];
    for (let i = 0; i < creatorsLen; i++) {
      // 32 addr + 1 verified + 1 share
      if (idx + 34 > data.length) break;
      const addrBytes = data.slice(idx, idx + 32);
      const addr = new PublicKey(addrBytes).toBase58();
      idx += 32;
      const verified = data[idx];
      const share = data[idx + 1];
      idx += 2;
      creators.push({ address: addr, verified: Number(verified), share: Number(share) });
    }

    return creators.length ? { creators, updateAuthority, uri: uri || null } : { creators: null, updateAuthority, uri: uri || null };
  } catch (err) {
    // Parsing failed (compressed metadata etc) — return null to allow fallback.
    return null;
  }
}

async function fetchMetadataUriCreators(uri) {
  try {
    if (!uri) return null;
    if (uri.startsWith("ipfs://")) uri = uri.replace("ipfs://", "https://ipfs.io/ipfs/");
    const res = await fetch(uri, { timeout: 8000 }).catch(() => null);
    if (!res || !res.ok) return null;
    const j = await res.json().catch(() => null);
    if (!j) return null;
    const props = j.properties || j;
    const creators = props.creators || j.creators || null;
    if (!Array.isArray(creators)) return null;
    const parsed = creators.map(c => {
      if (typeof c === "string") return { address: c, verified: 0, share: 0 };
      return { address: c.address || c.wallet || c.creator || null, verified: c.verified ? 1 : 0, share: c.share || 0 };
    }).filter(x => x.address);
    return parsed.length ? parsed : null;
  } catch (err) {
    return null;
  }
}

// ----------------------------- TOKEN-2022 DETECTION -----------------------------
async function detectToken2022AndExtensions(mintPub) {
  try {
    const parsedMintInfo = await conn.getParsedAccountInfo(mintPub).catch(() => null);
    const parsed = parsedMintInfo?.value?.data?.parsed?.info || null;

    const raw = await conn.getAccountInfo(mintPub).catch(() => null);
    const rawLen = raw?.data?.length || 0;

    const result = { isToken2022: false, extensions: [], rawLen };

    const extList = parsed?.extensions || null;
    if (Array.isArray(extList) && extList.length > 0) {
      result.isToken2022 = true;
      result.extensions = extList.slice();
    }

    if (!result.isToken2022 && rawLen > 200) {
      result.isToken2022 = true;
    }

    if (parsed) {
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
      if (parsed.transferFeeConfigAuthority || parsed.transferHookProgram || parsed.confidentialTransferMint) {
        result.isToken2022 = true;
      }
    }

    result.extensions = Array.from(new Set((result.extensions || []).map(x => String(x).toLowerCase())));
    return result;
  } catch (err) {
    return { isToken2022: false, extensions: [], rawLen: 0 };
  }
}

// ----------------------------- HOLDER DECAY ANALYSIS -----------------------------
async function analyzeHolderConcentrationDecay(mintPub, sampleLimit = HOLDER_DECAY_SAMPLE_LIMIT) {
  try {
    const sigInfos = await conn.getSignaturesForAddress(mintPub, { limit: Math.min(sampleLimit, 500) }).catch(() => []);
    if (!Array.isArray(sigInfos) || sigInfos.length === 0) {
      return { timeline: [], initialTopPct: null, latestTopPct: null, decayPct: 0, decayed: false, samples: 0 };
    }

    const n = sigInfos.length;
    const want = Math.min(4, n);
    const indices = [];
    for (let i = 0; i < want; i++) {
      const idx = Math.floor((i * (n - 1)) / (want - 1 || 1));
      indices.push(idx);
    }

    const timeline = [];
    for (const idx of indices) {
      const sig = sigInfos[idx].signature;
      if (!sig) continue;
      const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!tx?.meta) continue;
      const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);
      const post = tx.meta.postTokenBalances || [];
      const mintStr = mintPub.toBase58();

      const balances = post.filter(b => b.mint === mintStr);
      let total = 0;
      const ownerMap = {};
      for (const b of balances) {
        // **FIX:** use uiAmount rather than .ui (no such field)
        const ui = safeNumber(b.uiTokenAmount?.uiAmount, 0);
        // owner may be present in parsed or accountKeys mapping
        const owner = b.owner || (typeof b.accountIndex === "number" ? (tx.transaction?.message?.accountKeys?.[b.accountIndex]?.pubkey?.toString?.() || null) : null);
        if (!owner) continue;
        total += ui;
        ownerMap[owner] = (ownerMap[owner] || 0) + ui;
      }

      // fallback: if no snapshot, use largest accounts (current state) as proxy
      if (total === 0) {
        const largest = await conn.getTokenLargestAccounts(mintPub).catch(() => null);
        const acct = largest?.value?.[0];
        if (acct) {
          const info = await conn.getParsedAccountInfo(new PublicKey(acct.address)).catch(() => null);
          const amt = safeNumber(info?.value?.data?.parsed?.info?.tokenAmount?.uiAmount, 0);
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

// ----------------------------- LIQUIDITY LOCK DETECTION -----------------------------
async function detectLiquidityLocking(mintPub, sigScanLimit = 200) {
  try {
    const largestAccounts = await conn.getTokenLargestAccounts(mintPub).catch(() => null);
    if (!largestAccounts?.value || largestAccounts.value.length === 0) {
      return { locked: false, reason: "no_token_accounts", details: {} };
    }

    const top = largestAccounts.value[0];
    const topInfo = await conn.getParsedAccountInfo(new PublicKey(top.address)).catch(() => null);
    const owner = topInfo?.value?.data?.parsed?.info?.owner || null;

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

    if (KNOWN_LOCKER_PROGRAM_IDS.has(owner)) {
      out.locked = true;
      out.lockerIsKnownProgram = true;
      out.details.note = "Owner is known locker program";
    }

    // Detect if owner is program account, but don't treat ANY program as auto-locker.
    try {
      const ownerPub = new PublicKey(owner);
      const ownerAcct = await conn.getAccountInfo(ownerPub).catch(() => null);
      if (ownerAcct) {
        if (ownerAcct.executable) out.lockerIsProgramAccount = true;
        out.details.ownerDataLen = ownerAcct.data?.length || 0;
      }
    } catch (e) { /* ignore */ }

    // scan recent signatures for locker keywords (best-effort)
    const keywords = ["lock", "locked", "unlock", "unlock_date", "release", "vesting", "cliff", "lockup", "locker", "locked_until", "unlock_ts"];
    const sigInfos = await conn.getSignaturesForAddress(mintPub, { limit: Math.min(sigScanLimit, 500) }).catch(() => []);
    let foundLockEvent = null;
    let foundUnlockEvent = null;
    let latestUnlockTs = null;

    for (const s of sigInfos) {
      if (!s?.signature) continue;
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!tx?.meta) continue;
      const logs = (tx.meta.logMessages || []).join(" ").toLowerCase();
      const blockTime = tx.blockTime || null;

      for (const kw of keywords) {
        if (!logs.includes(kw)) continue;

        // parse numeric timestamp patterns
        const matchTs = logs.match(/(unlock|unlock_date|locked_until|unlock_ts)[^0-9]{0,12}([0-9]{9,14})/);
        if (matchTs && matchTs[2]) {
          const tsNum = Number(matchTs[2]);
          if (!isNaN(tsNum) && tsNum > 1e8) {
            const maybeSec = tsNum > 1e12 ? Math.floor(tsNum / 1000) : tsNum;
            if (!foundUnlockEvent || maybeSec > latestUnlockTs) {
              foundUnlockEvent = { tx: s.signature, ts: maybeSec, logsSnippet: logs.substring(0, 400) };
              latestUnlockTs = maybeSec;
            }
          }
        }

        if (!foundLockEvent) {
          foundLockEvent = { tx: s.signature, ts: blockTime, logsSnippet: logs.substring(0, 400) };
        }
      }

      if (foundLockEvent && foundUnlockEvent) break;
    }

    if (foundLockEvent) out.lockStart = foundLockEvent.ts;
    if (foundUnlockEvent) out.lockEnd = foundUnlockEvent.ts;

    if (out.lockStart && out.lockEnd && Number.isFinite(out.lockStart) && Number.isFinite(out.lockEnd)) {
      const durDays = (out.lockEnd - out.lockStart) / 86400;
      out.lockDurationDays = Number(durDays.toFixed(2));
      // locked if unlock is in future
      out.locked = out.locked || (out.lockEnd > Math.floor(Date.now() / 1000));
    } else if (out.lockerIsKnownProgram) {
      // only assume locked if locker is a known locker program
      out.locked = true;
      out.details.assumedLocked = true;
    } else if (out.lockerIsProgramAccount) {
      // program account owner — mark suspicious but do NOT auto-lock
      out.details.assumedLocked = false;
      out.details.note = "Owner is executable program account — needs manual review (not auto-locked)";
    }

    if (out.lockDurationDays !== null) {
      if (out.lockDurationDays < LIQUIDITY_LOCK_WARNING_DAYS) out.details.risk = "high";
      else if (out.lockDurationDays < LIQUIDITY_LOCK_MIN_SAFE_DAYS) out.details.risk = "medium";
      else out.details.risk = "low";
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
// VERIFY CREATOR SAFETY — PURE RPC + Token-2022 (Hardened)
// =======================================================
export async function verifyCreatorSafety(mintAddress) {
  let reasons = [];
  let score = 100;
  let creator = null;
  let creatorsParsed = false;
  let lockInfo = null;

  try {
    const mintPub = new PublicKey(mintAddress);

    // ----------------- Mint account -----------------
    const mintAcct = await conn.getParsedAccountInfo(mintPub).catch(() => null);
    const parsed = mintAcct?.value?.data?.parsed?.info || null;
    if (!parsed) return { safe: false, score: 0, reasons: ["Mint account not found"], creator: null };

    const mintAuthority = parsed.mintAuthority ?? null;
    const freezeAuthority = parsed.freezeAuthority ?? null;
    // parsed.supply may be string or number
    const totalSupplyStr = parsed.supply ?? parsed.supply?.toString?.() ?? "0";
    const totalSupplyNum = Number(totalSupplyStr || 0);
    const totalSupplyBig = safeIntFromStringOrBig(totalSupplyStr);

    if (mintAuthority !== null && typeof mintAuthority !== "undefined") {
      score -= 35;
      reasons.push("mintAuthority still active ❌");
    } else {
      reasons.push("Mint authority revoked ✅");
    }

    if (freezeAuthority !== null && typeof freezeAuthority !== "undefined") {
      score -= 15;
      reasons.push("freezeAuthority still active ❌");
    } else {
      reasons.push("Freeze authority revoked ✅");
    }

    // ----------------- Creators extraction -----------------
    const metaResult = await getCreatorsFromMetadata(mintPub).catch(() => null);
    let creators = metaResult?.creators || null;
    let updateAuthority = metaResult?.updateAuthority || null;
    let uri = metaResult?.uri || null;

    if ((!creators || creators.length === 0) && uri) {
      const fetched = await fetchMetadataUriCreators(uri);
      if (fetched) {
        creators = fetched;
        creatorsParsed = true;
        reasons.push("Fetched creators from off-chain metadata URI ✅");
      }
    }

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
      score -= 8;
      reasons.push("No metadata creators found (parser fallback) — mild penalty applied ❌");
    }

    // metadata updateAuthority: **only penalize if metadata mutable AND creators not verified**
    if (updateAuthority && updateAuthority !== "11111111111111111111111111111111") {
      if (!creators || creators.length === 0) {
        reasons.push(`updateAuthority: ${updateAuthority} (metadata mutable) ⚠️`);
        score -= 10;
      } else {
        // if creators exist and some verified, do not penalize strongly; just add note
        reasons.push(`updateAuthority: ${updateAuthority} (metadata mutable) — noted`);
      }
    } else if (updateAuthority === "11111111111111111111111111111111") {
      reasons.push("updateAuthority: system (immutable) ✅");
    }

    // ----------------- Token-2022 detection -----------------
    const t2022 = await detectToken2022AndExtensions(mintPub);
    if (t2022.isToken2022) {
      reasons.push(`Token-2022 detected (rawLen=${t2022.rawLen}) — extensions: ${t2022.extensions.join(", ") || "unknown"}`);
      const extSet = new Set(t2022.extensions.map(e => String(e).toLowerCase()));
      const dangerous = [
        "transferhook", "transfer_hook",
        "permanentdelegate", "permanent_delegate",
        "nontransferable", "non_transferable",
        "confidentialtransfer", "confidential_transfer",
        "interestbearing", "interest_bearing",
        "defaultaccountstate"
      ];
      const foundDanger = dangerous.some(d => extSet.has(d));
      if (foundDanger) {
        reasons.push("Dangerous Token-2022 extension found — auto-fail ❌");
        return { safe: false, score: 0, reasons, creator };
      }

      const feeKeys = ["transferfee", "transfer_fee", "transferfeeconfig", "transfer_fee_config"];
      const hasFee = t2022.extensions.some(e => feeKeys.some(k => String(e).toLowerCase().includes(k)));
      if (hasFee) {
        reasons.push("Transfer-fee extension present — auto-fail ❌");
        return { safe: false, score: 0, reasons, creator };
      }

      score -= 30;
      reasons.push("Token-2022 with extensions — heavy penalty ⚠️");
    }

    // ----------------- Holder concentration decay -----------------
    const holderDecay = await analyzeHolderConcentrationDecay(mintPub);
    if (holderDecay && holderDecay.samples && holderDecay.samples >= HOLDER_DECAY_MIN_SAMPLES) {
      reasons.push(`Holder decay: initialTop=${holderDecay.initialTopPct}% latestTop=${holderDecay.latestTopPct}% decay=${holderDecay.decayPct}%`);
      if (holderDecay.decayed) {
        score -= 25;
        reasons.push("Holder concentration decayed rapidly — suspicious redistribution detected ❌");
      } else if (holderDecay.decayPct >= 5) {
        score += 5;
        reasons.push("Top holder decreased slightly — decentralizing ✅");
      }
    } else {
      reasons.push("Holder decay: insufficient samples or no recent activity");
    }

    // ----------------- Largest holder concentration -----------------
    const largest = await conn.getTokenLargestAccounts(mintPub).catch(() => null);
    if (largest?.value?.length > 0) {
      const acct = largest.value[0];
      const acctInfo = await conn.getParsedAccountInfo(new PublicKey(acct.address)).catch(() => null);
      const owner = acctInfo?.value?.data?.parsed?.info?.owner || null;

      if (owner && KNOWN_LP_PROGRAM_IDS.has(owner)) {
        reasons.push("Largest holder appears to be a liquidity pool / DEX account — ignoring concentration penalty ✅");
      } else {
        // compute percent safely
        const amountStr = acct?.amount ?? "0";
        const amountBig = safeIntFromStringOrBig(amountStr);
        let percent = 0;

        // prefer using numeric ratio when we have numeric totalSupply
        try {
          if (totalSupplyBig > 0n) {
            // Convert to Number for percent calculation carefully (may lose precision for huge totals)
            const amountNum = Number(amountBig.toString());
            const totalNum = Number(totalSupplyBig.toString());
            if (Number.isFinite(amountNum) && Number.isFinite(totalNum) && totalNum > 0) {
              percent = (amountNum / totalNum) * 100;
            } else {
              // safe fallback: use BigInt division but return approximate
              percent = Number((amountBig * 100n) / (totalSupplyBig || 1n));
            }
          } else if (totalSupplyNum > 0) {
            percent = (Number(amountStr) / totalSupplyNum) * 100;
          } else {
            percent = 0;
          }
        } catch (e) {
          percent = 0;
        }
        percent = clampPercent(percent);

        if (percent >= 40) {
          score -= 30;
          reasons.push(`Largest holder has ${percent.toFixed(4)}% supply ❌`);
        } else if (percent >= 20) {
          score -= 15;
          reasons.push(`Largest holder has ${percent.toFixed(4)}% ⚠️`);
        } else {
          reasons.push(`Largest holder supply: ${percent.toFixed(4)}% ✅`);
        }
      }
    } else {
      reasons.push("No token holders found ❌");
    }

    // ----------------- Blacklist & auto-blacklist -----------------
    if (creator && BLACKLIST.has(creator)) {
      return { safe: false, score: 0, reasons: ["Creator is BLACKLISTED ❌"], creator };
    }

    if (creator && creatorsParsed && score < AUTO_BLACKLIST_THRESHOLD) {
      BLACKLIST.add(creator);
      saveBlacklist();
      reasons.push("Auto-blacklisted — unsafe creator ❌");
    }

    // ----------------- Liquidity lock detection -----------------
    lockInfo = await detectLiquidityLocking(mintPub);
    if (lockInfo && lockInfo.locked) {
      if (lockInfo.lockDurationDays !== null) {
        reasons.push(`LP lock detected: ${lockInfo.lockDurationDays} days (locker=${lockInfo.locker})`);
        if (lockInfo.lockDurationDays < LIQUIDITY_LOCK_WARNING_DAYS) {
          reasons.push("LP lock duration too short — auto-fail ❌");
          return { safe: false, score: 0, reasons, creator, lockInfo };
        } else if (lockInfo.lockDurationDays < LIQUIDITY_LOCK_MIN_SAFE_DAYS) {
          score -= 25;
          reasons.push("LP lock duration below safe threshold (medium risk) ⚠️");
        } else {
          score += 10;
          reasons.push("LP locked for a healthy duration ✅");
        }
      } else {
        reasons.push("LP appears locked but duration unknown — conservative penalty applied ⚠️");
        score -= 20;
      }

      if (!lockInfo.lockerIsKnownProgram && lockInfo.lockerIsProgramAccount) {
        reasons.push("Locker is executable program (unknown) — needs manual review");
        score -= 15;
      }
    } else {
      reasons.push("No clear LP lock detected (or locker unknown) — treat with caution");
    }

    // ----------------- finalize -----------------
    if (score > 100) score = 100;
    if (score < 0) score = 0;
    const safe = score >= MIN_CREATOR_SCORE;

    return { safe, score, reasons, creator, lockInfo };
  } catch (err) {
    console.error("[tokenCreatorScanner] verifyCreatorSafety error:", err?.message || err);
    return { safe: false, score: 0, reasons: ["RPC error or invalid mint"], creator: null };
  }
}

// ------------------------- TEST RUNNER -------------------------
(async () => {
  console.log("Starting Creator Scanner Test...");

  try {
    // Replace this with any mint you want to test
    const testMint = "So11111111111111111111111111111111111111112"; // Example: Wrapped SOL mint

    const result = await verifyCreatorSafety(testMint);
    console.log("Scan Result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Test Runner Error:", err?.message || err);
  }
})();

// ------------------------- EXPORTS -------------------------
module.exports = {
  verifyCreatorSafety
};