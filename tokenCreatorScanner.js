Recheck what you wrote and check syntax and error

// tokenCreatorScanner.js — PURE RPC VERSION (Hardened + Per-file Rate Limiter)
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
const RPC_URL = process.env.RPC_URL_4;
if (!RPC_URL) throw new Error("RPC_URL is not defined in .env");

const MIN_CREATOR_SCORE = Number(process.env.MIN_CREATOR_SCORE || 65);
const AUTO_BLACKLIST_THRESHOLD = Number(process.env.AUTO_BLACKLIST_THRESHOLD || 30);

// ----------------- PER-FILE RATE LIMITER -----------------
const RPC_RATE_LIMIT = Number(process.env.RPC_RATE_LIMIT || 4); // RPC per second
const HTTP_RATE_LIMIT = Number(process.env.HTTP_RATE_LIMIT || 3); // fetch per second

// Improved limiter: queue with a per-second token bucket
function createLimiter(maxPerSec) {
const queue = [];
let tokens = maxPerSec;
const refillInterval = 1000;

// refill tokens every second
setInterval(() => {
tokens = maxPerSec;
processQueue();
}, refillInterval);

function processQueue() {
while (tokens > 0 && queue.length > 0) {
const job = queue.shift();
tokens--;
job();
}
}

return function limit(fn) {
return new Promise((resolve, reject) => {
queue.push(() => {
// run the job and resolve/reject
Promise.resolve()
.then(fn)
.then(resolve)
.catch(reject);
});
processQueue();
});
};
}

const limitRPC = createLimiter(RPC_RATE_LIMIT);
const limitHTTP = createLimiter(HTTP_RATE_LIMIT);

// ----------------- Solana RPC -----------------
const conn = new Connection(RPC_URL, "confirmed");

// Wrap all RPC methods safely
const rpc = {
getAccountInfo: (pub) => limitRPC(() => conn.getAccountInfo(pub)),
getParsedAccountInfo: (pub) => limitRPC(() => conn.getParsedAccountInfo(pub)),
getSignaturesForAddress: (pub, opts) =>
limitRPC(() => conn.getSignaturesForAddress(pub, opts)),
getParsedTransaction: (sig, opts) =>
limitRPC(() =>
conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })
),
getTokenLargestAccounts: (pub) =>
limitRPC(() => conn.getTokenLargestAccounts(pub)),
getAccountInfoRaw: (pub) =>
limitRPC(() => conn.getAccountInfo(pub)), // alias if needed
};

// Wrap fetch with AbortController and limit
async function safeFetch(url, opts = {}, timeoutMs = 8000) {
return limitHTTP(async () => {
const controller = new AbortController();
const signal = controller.signal;
const timer = setTimeout(() => controller.abort(), timeoutMs);

try {  
  const merged = { ...opts, signal };  
  const res = await fetch(url, merged);  
  return res;  
} finally {  
  clearTimeout(timer);  
}

});
}

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

// ----------------- Known DEX program IDs -----------------
const KNOWN_LP_PROGRAM_IDS = new Set([
"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
"CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
"5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
"9WwRZjZJY9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5",
"whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
]);

const DEFAULT_KNOWN_LOCKERS = [];
const KNOWN_LOCKER_PROGRAM_IDS = new Set(
(process.env.KNOWN_LOCKERS ? process.env.KNOWN_LOCKERS.split(",") : DEFAULT_KNOWN_LOCKERS)
.map(s => s.trim())
.filter(Boolean)
);

// ----------------- Configurable thresholds -----------------
const HOLDER_DECAY_SAMPLE_LIMIT = Number(process.env.HOLDER_DECAY_SAMPLE_LIMIT || 120);
const HOLDER_DECAY_MIN_SAMPLES = Number(process.env.HOLDER_DECAY_MIN_SAMPLES || 3);
const HOLDER_DECAY_SUSPICIOUS_PCT = Number(process.env.HOLDER_DECAY_SUSPICIOUS_PCT || 20);
const LIQUIDITY_LOCK_MIN_SAFE_DAYS = Number(process.env.LIQUIDITY_LOCK_MIN_SAFE_DAYS || 90);
const LIQUIDITY_LOCK_WARNING_DAYS = Number(process.env.LIQUIDITY_LOCK_WARNING_DAYS || 30);

// ------------------ small helpers ------------------
function safeNumber(x, fallback = 0) {
const n = Number(x);
return Number.isFinite(n) ? n : fallback;
}
function safeIntFromStringOrBig(value) {
try {
if (typeof value === "bigint") return value;
if (typeof value === "number") return BigInt(Math.floor(value));
if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
return BigInt(Math.floor(Number(value) || 0));
} catch (e) {
return 0n;
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

const acct = await rpc.getAccountInfo(metadataPDA);  
if (!acct?.data) return null;  

// ensure Buffer  
const data = Buffer.from(acct.data);  

let idx = 0;  
const need = (len) => {  
  if (idx + len > data.length) throw new Error("metadata parse OOB");  
};  

// key + updateAuthority + mint  
need(1); idx += 1;  
need(32);  
const updateAuthority = new PublicKey(data.slice(idx, idx + 32)).toBase58();  
idx += 32;  

need(32); idx += 32;  

// name  
need(1);  
const nameLen = data[idx];  
need(nameLen + 1);  
idx += 1 + nameLen;  

// symbol  
need(1);  
const symbolLen = data[idx];  
need(symbolLen + 1);  
idx += 1 + symbolLen;  

// uri (corrected handling)  
need(1);  
const uriLen = data[idx];  
idx += 1;  
need(uriLen);  
const uri = data.slice(idx, idx + uriLen).toString("utf8").replace(/\0+$/g, "");  
idx += uriLen;  

// seller fee basis points (2 bytes)  
need(2); idx += 2;  

// has creators  
need(1);  
const hasCreators = data[idx];  
idx += 1;  
if (!hasCreators) return { creators: null, updateAuthority, uri };  

// creators length (u32 little endian)  
need(4);  
// ensure we can safely call readUInt32LE  
const creatorsLen = data.readUInt32LE(idx);  
idx += 4;  

const creators = [];  
for (let i = 0; i < creatorsLen; i++) {  
  if (idx + 34 > data.length) break; // need 32 + 1 + 1  
  const addr = new PublicKey(data.slice(idx, idx + 32)).toBase58();  
  idx += 32;  
  const verified = data[idx];  
  const share = data[idx + 1];  
  idx += 2;  
  creators.push({ address: addr, verified: Number(verified), share: Number(share) });  
}  

return creators.length ? { creators, updateAuthority, uri } : { creators: null, updateAuthority, uri };

} catch (e) {
// safe fallback
return null;
}
}

async function fetchMetadataUriCreators(uri) {
try {
if (!uri) return null;
if (uri.startsWith("ipfs://"))
uri = uri.replace("ipfs://", "https://ipfs.io/ipfs/");

const res = await safeFetch(uri, {}, 8000).catch(() => null);  
if (!res || !res.ok) return null;  

const j = await res.json().catch(() => null);  
if (!j) return null;  

const props = j.properties || j;  
const creators = props.creators || j.creators || null;  
if (!Array.isArray(creators)) return null;  

const parsed = creators  
  .map(c =>  
    typeof c === "string"  
      ? { address: c, verified: 0, share: 0 }  
      : { address: c.address || c.wallet || null, verified: c.verified ? 1 : 0, share: c.share || 0 }  
  )  
  .filter(x => x.address);  

return parsed.length ? parsed : null;

} catch {
return null;
}
}

// ----------------------------- TOKEN-2022 DETECTION -----------------------------
async function detectToken2022AndExtensions(mintPub) {
try {
const parsedMintInfo = await rpc.getParsedAccountInfo(mintPub).catch(() => null);
const parsed = parsedMintInfo?.value?.data?.parsed?.info || null;

const raw = await rpc.getAccountInfo(mintPub).catch(() => null);  
const rawLen = raw?.data?.length || 0;  

const res = { isToken2022: false, extensions: [], rawLen };  

const extList = parsed?.extensions || null;  
if (Array.isArray(extList) && extList.length > 0) {  
  res.isToken2022 = true;  
  res.extensions = extList.slice();  
}  

if (!res.isToken2022 && rawLen > 200) {  
  res.isToken2022 = true;  
}  

if (parsed) {  
  const known = [  
    "transferFeeConfigAuthority","transferFeeConfig","transferHookProgram",  
    "confidentialTransferMint","nonTransferable","interestBearingConfig","defaultAccountState"  
  ];  
  for (const k of known) {  
    if (k in parsed) {  
      res.isToken2022 = true;  
      res.extensions.push(k);  
    }  
  }  
}  

res.extensions = [...new Set(res.extensions.map(x => String(x).toLowerCase()))];  
return res;

} catch {
return { isToken2022: false, extensions: [], rawLen: 0 };
}
}

// ----------------------------- HOLDER DECAY -----------------------------
async function analyzeHolderConcentrationDecay(mintPub) {
try {
const sigInfos = await rpc.getSignaturesForAddress(mintPub, {
limit: Math.min(HOLDER_DECAY_SAMPLE_LIMIT, 500)
}).catch(() => []);

if (!sigInfos?.length)  
  return { timeline: [], initialTopPct: null, latestTopPct: null, decayPct: 0, decayed: false, samples: 0 };  

const n = sigInfos.length;  
const want = Math.min(4, n);  

const indices = [];  
for (let i = 0; i < want; i++)  
  indices.push(Math.floor((i * (n - 1)) / (want - 1 || 1)));  

const timeline = [];  

for (const idx of indices) {  
  const sig = sigInfos[idx].signature;  
  const tx = await rpc.getParsedTransaction(sig).catch(() => null);  
  if (!tx?.meta) continue;  

  const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);  
  const balances = tx.meta.postTokenBalances?.filter(b => b.mint === mintPub.toBase58()) || [];  

  let total = 0;  
  const ownerMap = {};  

  for (const b of balances) {  
    const ui = safeNumber(b.uiTokenAmount?.uiAmount, 0);  
    const owner =  
      b.owner ||  
      ((typeof b.accountIndex === "number") &&  
        tx.transaction?.message?.accountKeys?.[b.accountIndex]?.pubkey?.toString?.()) ||  
      null;  

    if (!owner) continue;  
    total += ui;  
    ownerMap[owner] = (ownerMap[owner] || 0) + ui;  
  }  

  if (total === 0) {  
    const largest = await rpc.getTokenLargestAccounts(mintPub).catch(() => null);  
    const acct = largest?.value?.[0];  
    if (acct) {  
      const info = await rpc.getParsedAccountInfo(new PublicKey(acct.address)).catch(() => null);  
      const amt = safeNumber(info?.value?.data?.parsed?.info?.tokenAmount?.uiAmount, 0);  
      const owner = info?.value?.data?.parsed?.info?.owner || null;  
      if (owner) {  
        total = amt;  
        ownerMap[owner] = amt;  
      }  
    }  
  }  

  const topAmt = Object.values(ownerMap).sort((a, b) => b - a)[0] || 0;  
  const topPct = total > 0 ? (topAmt / total) * 100 : 0;  

  timeline.push({ ts: blockTime, topPct: Number(topPct.toFixed(4)) });  
}  

if (timeline.length < HOLDER_DECAY_MIN_SAMPLES)  
  return { timeline, initialTopPct: null, latestTopPct: null, decayPct: 0, decayed: false, samples: timeline.length };  

timeline.sort((a, b) => a.ts - b.ts);  

const initial = timeline[0].topPct;  
const latest = timeline[timeline.length - 1].topPct;  
const decay = initial - latest;  
const decayed = decay >= HOLDER_DECAY_SUSPICIOUS_PCT;  

return {  
  timeline,  
  initialTopPct: initial,  
  latestTopPct: latest,  
  decayPct: Number(decay.toFixed(2)),  
  decayed,  
  samples: timeline.length  
};

} catch (err) {
return { timeline: [], initialTopPct: null, latestTopPct: null, decayPct: 0, decayed: false, samples: 0 };
}
}

// ----------------------------- LP LOCK DETECTION -----------------------------
async function detectLiquidityLocking(mintPub) {
try {
const largest = await rpc.getTokenLargestAccounts(mintPub).catch(() => null);
if (!largest?.value?.length)
return { locked: false, reason: "no_token_accounts", details: {} };

const top = largest.value[0];  
const topInfo = await rpc.getParsedAccountInfo(new PublicKey(top.address)).catch(() => null);  
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

if (!owner) return out;  

if (KNOWN_LOCKER_PROGRAM_IDS.has(owner)) {  
  out.locked = true;  
  out.lockerIsKnownProgram = true;  
  out.details.note = "Owner is known locker program";  
}  

// Detect if owner is program  
try {  
  const ownerAcct = await rpc.getAccountInfo(new PublicKey(owner));  
  if (ownerAcct?.executable) out.lockerIsProgramAccount = true;  
} catch {}  

// Scan signature logs for lock events  
const keywords = ["lock", "locked", "unlock", "unlock_date", "release", "vesting", "cliff"];  
const sigs = await rpc.getSignaturesForAddress(mintPub, { limit: 200 }).catch(() => []);  

let foundLock = null;  
let foundUnlock = null;  
let lastUnlockTs = null;  

for (const s of sigs) {  
  const tx = await rpc.getParsedTransaction(s.signature).catch(() => null);  
  if (!tx?.meta) continue;  

  const logs = (tx.meta.logMessages || []).join(" ").toLowerCase();  
  const blockTime = tx.blockTime;  

  for (const kw of keywords) {  
    if (!logs.includes(kw)) continue;  

    const match = logs.match(/(unlock|unlock_date|locked_until)[^0-9]{0,8}([0-9]{9,14})/);  
    if (match?.[2]) {  
      let ts = Number(match[2]);  
      if (ts > 1e12) ts = Math.floor(ts / 1000);  
      if (!foundUnlock || ts > lastUnlockTs) {  
        foundUnlock = { tx: s.signature, ts };  
        lastUnlockTs = ts;  
      }  
    }  

    if (!foundLock)  
      foundLock = { tx: s.signature, ts: blockTime };  
  }  

  if (foundLock && foundUnlock) break;  
}  

if (foundLock) out.lockStart = foundLock.ts;  
if (foundUnlock) out.lockEnd = foundUnlock.ts;  

if (out.lockStart && out.lockEnd) {  
  const days = (out.lockEnd - out.lockStart) / 86400;  
  out.lockDurationDays = Number(days.toFixed(2));  
  out.locked = out.locked || (out.lockEnd > Math.floor(Date.now() / 1000));  
}  

return out;

} catch {
return { locked: false, error: "lock_detection_error" };
}
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

const mintAcct = await rpc.getParsedAccountInfo(mintPub).catch(() => null);  
const parsed = mintAcct?.value?.data?.parsed?.info || null;  

if (!parsed)  
  return { safe: false, score: 0, reasons: ["Mint account not found"], creator: null };  

const mintAuth = parsed.mintAuthority;  
const freezeAuth = parsed.freezeAuthority;  

if (mintAuth !== null && mintAuth !== undefined) {  
  score -= 35;  
  reasons.push("mintAuthority still active ❌");  
} else reasons.push("Mint authority revoked ✅");  

if (freezeAuth !== null && freezeAuth !== undefined) {  
  score -= 15;  
  reasons.push("freezeAuthority still active ❌");  
} else reasons.push("Freeze authority revoked ✅");  

// metadata  
const meta = await getCreatorsFromMetadata(mintPub);  
let creators = meta?.creators || null;  
let updateAuth = meta?.updateAuthority || null;  
let uri = meta?.uri || null;  

if ((!creators || !creators.length) && uri) {  
  const off = await fetchMetadataUriCreators(uri);  
  if (off) {  
    creators = off;  
    reasons.push("Creators fetched from off-chain metadata URI");  
  }  
}  

if (creators?.length) {  
  creator = creators[0].address;  
  const verified = creators.filter(c => Number(c.verified) === 1).length;  
  if (verified > 0) {  
    score += 15;  
    reasons.push(`Verified creators found (${verified})`);  
  } else {  
    score -= 12;  
    reasons.push("Creators present but none verified ❌");  
  }  
} else {  
  score -= 8;  
  reasons.push("No metadata creators found ❌");  
}  

if (updateAuth && updateAuth !== "11111111111111111111111111111111") {  
  if (!creators?.length) {  
    score -= 10;  
    reasons.push(`updateAuthority ${updateAuth} is mutable ❌`);  
  } else {  
    reasons.push(`updateAuthority ${updateAuth} is mutable`);  
  }  
} else {  
  reasons.push("updateAuthority immutable");  
}  

// token-2022  
const t22 = await detectToken2022AndExtensions(mintPub);  
if (t22.isToken2022) {  
  const extSet = new Set(t22.extensions);  

  if ([...extSet].some(e => e.includes("transferhook") || e.includes("confidential")))  
    return { safe: false, score: 0, reasons: ["Token-2022 dangerous extensions"], creator };  

  score -= 30;  
  reasons.push("Token-2022 detected (penalty)");  
}  

// holder decay  
const decay = await analyzeHolderConcentrationDecay(mintPub);  
if (decay?.samples >= HOLDER_DECAY_MIN_SAMPLES) {  
  if (decay.decayed) {  
    score -= 25;  
    reasons.push("Holder concentration decayed aggressively ❌");  
  }  
}  

// largest account  
const largest = await rpc.getTokenLargestAccounts(mintPub).catch(() => null);  
if (largest?.value?.length) {  
  const top = largest.value[0];  
  const ownerInfo = await rpc.getParsedAccountInfo(new PublicKey(top.address)).catch(() => null);  
  const owner = ownerInfo?.value?.data?.parsed?.info?.owner;  

  if (!KNOWN_LP_PROGRAM_IDS.has(owner)) {  
    const amount = safeIntFromStringOrBig(top.amount);  
    const total = safeIntFromStringOrBig(parsed.supply || "0");  
    let pct = total > 0n ? Number((amount * 100n) / total) : 0;  

    if (pct >= 40) {  
      score -= 30;  
      reasons.push(`Largest holder has ${pct}% ❌`);  
    } else if (pct >= 20) {  
      score -= 15;  
      reasons.push(`Largest holder has ${pct}% ⚠️`);  
    }  
  }  
}  

// blacklist  
if (creator && BLACKLIST.has(creator))  
  return { safe: false, score: 0, reasons: ["Creator BLACKLISTED"], creator };  

if (creator && score < AUTO_BLACKLIST_THRESHOLD) {  
  BLACKLIST.add(creator);  
  saveBlacklist();  
  reasons.push("Creator auto-blacklisted ❌");  
}  

// LP lock  
const lock = await detectLiquidityLocking(mintPub);  
if (lock.locked && lock.lockDurationDays !== null) {  
  if (lock.lockDurationDays < LIQUIDITY_LOCK_WARNING_DAYS)  
    return { safe: false, score: 0, reasons: ["LP lock too short ❌"], creator, lockInfo: lock };  

  if (lock.lockDurationDays < LIQUIDITY_LOCK_MIN_SAFE_DAYS) {  
    score -= 25;  
    reasons.push("LP lock medium duration ⚠️");  
  }  
}  

score = Math.max(0, Math.min(100, score));  
const safe = score >= MIN_CREATOR_SCORE;  

return { safe, score, reasons, creator };

} catch (err) {
console.error("[verifyCreatorSafety] error:", err?.message || err);
return { safe: false, score: 0, reasons: ["verify error"], creator: null };
}
}