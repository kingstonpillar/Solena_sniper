// unified_pool_registry_AMM_only.js
// AMM-only on-chain pool scanner for Raydium (AMM), Orca (AMM), Meteora (AMM).
// Exports: PROGRAMS, scanPools(programId, opts), scanAllPools()
// NOTE: best-effort heuristics — validate offsets against each DEX's IDL for production.

import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import PQueue from "p-queue";

const RPC_URL = process.env.RPC_URL_8 || "https://solana-mainnet.lava.build";
const conn = new Connection(RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false
});

conn._rpcWebSocket?.on("close", () => {
  console.log("Lava WS closed – reconnecting...");
});

// try to load JSON fallback (optional). Keep silent if not present.
let JSON_FALLBACK = null;
try {
  const p = path.resolve(process.cwd(), "unified_pool_registry_backup.json");
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8");
    JSON_FALLBACK = JSON.parse(raw);
  }
} catch (e) {
  JSON_FALLBACK = null;
}

// === Program IDs: AMM-only ===
export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  ORCA_AMM: new PublicKey("9WwRZjZJ9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5"),
  METEORA_AMM: new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"),
};

// ---- Rate Limit (PQueue) ----
// EXACTLY 6 requests per second. Do not change logic.
const rpcQueue = new PQueue({
  interval: 1000,       // 1 second window
  intervalCap: 6,       // ONLY 6 requests per second
  concurrency: 6        // max 6 RPC requests running at once
});

// ----------------- small helpers -----------------
function safeReadU64(buf, offset) {
  try {
    if (!buf || buf.length < offset + 8) return 0;
    if (typeof buf.readBigUInt64LE === "function") {
      const v = buf.readBigUInt64LE(offset);
      // clamp to Number (safe up to ~1e15). If value bigger, return as Number approximation.
      return Number(v <= BigInt(Number.MAX_SAFE_INTEGER) ? v : v % BigInt(Number.MAX_SAFE_INTEGER));
    } else {
      // fallback manual
      let n = 0n;
      for (let i = 0; i < 8; i++) {
        n |= BigInt(buf[offset + i] & 0xff) << BigInt(8 * i);
      }
      return Number(n <= BigInt(Number.MAX_SAFE_INTEGER) ? n : n % BigInt(Number.MAX_SAFE_INTEGER));
    }
  } catch {
    return 0;
  }
}

async function getTokenAmountFromAccount(pubkey) {
  try {
    const info = await rpcQueue.add(() =>
  conn.getParsedAccountInfo(new PublicKey(pubkey)).catch(() => null)
);
    if (!info || !info.value) return 0;
    const parsed = info.value.data?.parsed;
    if (parsed && parsed.type === "account") {
      const ui = parsed.info?.tokenAmount?.ui;
      if (typeof ui === "number") return ui;
      const amtRaw = parsed.info?.tokenAmount?.amount;
      if (amtRaw) return Number(amtRaw);
    }
    // fallback: raw
    const raw = info.value.data;
    if (raw && raw.length >= 72) return safeReadU64(raw, 64);
    return 0;
  } catch {
    return 0;
  }
}

// Helper to produce the canonical output object shape, preserving keys
function makePoolOutput(base) {
  return {
    pool: base.pool || null,
    ammId: base.ammId || null,
    ammAuthority: base.ammAuthority || null,
    openOrders: base.openOrders || null,
    targetOrders: base.targetOrders || null,
    marketProgram: base.marketProgram || null,
    marketId: base.marketId || null,
    marketBids: base.marketBids || null,
    marketAsks: base.marketAsks || null,
    marketEventQueue: base.marketEventQueue || null,
    marketBaseVault: base.marketBaseVault || null,
    marketQuoteVault: base.marketQuoteVault || null,
    vaultA: base.vaultA || null,
    vaultB: base.vaultB || null,
    mintA: base.mintA || null,
    mintB: base.mintB || null,
    lpMint: base.lpMint || null,
    feeNumerator: base.feeNumerator ?? null,
    feeDenominator: base.feeDenominator ?? null,
    ampFactor: base.ampFactor ?? null,
    stable: base.stable ?? null,
    volatile: base.volatile ?? null,
    amountA: base.amountA ?? 0,
    amountB: base.amountB ?? 0,

    // ⬇️ you forgot these two
    serumFallback: base.serumFallback || null,
    usesSerum: base.usesSerum || false,
  };
}

// Merge missing fields from JSON_FALLBACK (if present) into decoded object.
// This preserves existing on-chain values and only fills null/undefined ones.
function applyJsonFallback(poolPubkey, decoded) {
  if (!JSON_FALLBACK) return { merged: decoded, serumFallback: null, usesSerum: false };

  // JSON_FALLBACK is expected to be an object keyed by pool pubkey OR array of pool objects.
  // Try keyed lookup first:
  let candidate = null;
  if (JSON_FALLBACK[poolPubkey]) candidate = JSON_FALLBACK[poolPubkey];

  // If not keyed, try to find by mint pair (loose match)
  if (!candidate && Array.isArray(JSON_FALLBACK)) {
    const dMintA = decoded.mintA;
    const dMintB = decoded.mintB;
    candidate = JSON_FALLBACK.find(p => {
      if (!p) return false;
      // match exact pool or mint pair (order-agnostic)
      if (p.pool === poolPubkey) return true;
      if (!dMintA || !dMintB || !p.mintA || !p.mintB) return false;
      return (p.mintA === dMintA && p.mintB === dMintB) || (p.mintA === dMintB && p.mintB === dMintA);
    }) || null;
  }

  if (!candidate) return { merged: decoded, serumFallback: null, usesSerum: false };

  // Only fill fields that are null/undefined in decoded
  const merged = Object.assign({}, decoded);
  const serumFields = [
    "ammId","ammAuthority","openOrders","targetOrders","marketProgram","marketId",
    "marketBids","marketAsks","marketEventQueue","marketBaseVault","marketQuoteVault",
    "lpMint","feeNumerator","feeDenominator","ampFactor","stable","volatile"
  ];
  for (const k of serumFields) {
    if ((merged[k] === null || merged[k] === undefined) && candidate[k] !== undefined) {
      merged[k] = candidate[k];
    }
  }

  // Some JSON may include marketBids/Asks etc — treat presence as usesSerum = true
  const usesSerum = !!(merged.marketId || merged.marketBids || merged.marketAsks || merged.openOrders);

  return { merged, serumFallback: candidate, usesSerum };
}


// ---------------- Protocol-specific AMM decoders (best-effort) ----------------

function decodeRaydiumAMM(buf) {
  // Raydium AMM (AmmInfoV4-ish) — use verified offsets for mint/vault fields and best-effort extraction
  if (!buf || buf.length < 400) return null;
  try {
    const maybeMarket = buf.slice(48, 80);
    const maybeMarketProgram = buf.slice(80, 112);
    const maybeAmmAuthority = buf.slice(112, 144);

    const maybeMintA = buf.slice(144, 176);
    const maybeMintB = buf.slice(176, 208);
    const maybeVaultA = buf.slice(208, 240);
    const maybeVaultB = buf.slice(240, 272);

    const maybeOpenOrders = buf.slice(272, 304);
    const maybeTargetOrders = buf.slice(304, 336);

    const maybeLpMint = buf.slice(368, 400);

    // Fees (best-effort): many AmmInfo variants keep fee fields later in struct
    // Use safeReadU64 where applicable (best-effort, may be 0)
    const feeNumerator = safeReadU64(buf, 440);
    const feeDenominator = safeReadU64(buf, 448);

    // Amp/flags: not always present in same spot. Try to read a candidate field (best-effort)
    const ampFactor = safeReadU64(buf, 360);

    let marketId = null, marketProgram = null, ammAuthority = null;
    try { marketId = new PublicKey(maybeMarket).toBase58(); } catch (_) { marketId = null; }
    try { marketProgram = new PublicKey(maybeMarketProgram).toBase58(); } catch (_) { marketProgram = null; }
    try { ammAuthority = new PublicKey(maybeAmmAuthority).toBase58(); } catch (_) { ammAuthority = null; }

    let mintA = null, mintB = null, vaultA = null, vaultB = null, lpMint = null, openOrders = null, targetOrders = null;
    try { mintA = new PublicKey(maybeMintA).toBase58(); } catch (_) { mintA = null; }
    try { mintB = new PublicKey(maybeMintB).toBase58(); } catch (_) { mintB = null; }
    try { vaultA = new PublicKey(maybeVaultA).toBase58(); } catch (_) { vaultA = null; }
    try { vaultB = new PublicKey(maybeVaultB).toBase58(); } catch (_) { vaultB = null; }
    try { lpMint = new PublicKey(maybeLpMint).toBase58(); } catch (_) { lpMint = null; }
    try { openOrders = new PublicKey(maybeOpenOrders).toBase58(); } catch (_) { openOrders = null; }
    try { targetOrders = new PublicKey(maybeTargetOrders).toBase58(); } catch (_) { targetOrders = null; }

    // Fields that require reading the Serum market account (marketBids/Asks/EventQ/BaseVault/QuoteVault)
    // We do not fetch market account here for speed. Provide null defaults; dexbuilders.js can fetch if required.
    const marketBids = null;
    const marketAsks = null;
    const marketEventQueue = null;
    const marketBaseVault = null;
    const marketQuoteVault = null;

    // stable / volatile flags: Raydium uses curve types — not always present at fixed offset.
    const stable = null;
    const volatile = null;

    if (mintA && mintB && vaultA && vaultB && mintA !== mintB) {
      return {
        // partial record — scanPools will set `pool`/`ammId` to account pubkey
        ammId: null,
        ammAuthority,
        openOrders,
        targetOrders,
        marketProgram,
        marketId,
        marketBids,
        marketAsks,
        marketEventQueue,
        marketBaseVault,
        marketQuoteVault,
        vaultA,
        vaultB,
        mintA,
        mintB,
        lpMint,
        feeNumerator: feeNumerator || null,
        feeDenominator: feeDenominator || null,
        ampFactor: ampFactor || null,
        stable,
        volatile,
      };
    }
  } catch (_) {}
  return null;
}

function decodeOrcaAMM(buf) {
  // Orca classic AMM — stable offsets for classic pools
  if (!buf || buf.length < 200) return null;
  try {
    // offsets based on SwapInfo classic layout
    const maybeMintA = buf.slice(40, 72);
    const maybeMintB = buf.slice(72, 104);
    const maybeVaultA = buf.slice(104, 136);
    const maybeVaultB = buf.slice(136, 168);

    // Fee field at [4..8] (u32) in many classic Orca SwapInfo structs
    const fee32 = buf.length >= 8 ? buf.readUInt32LE(4) : 0;

    const mintA = new PublicKey(maybeMintA).toBase58();
    const mintB = new PublicKey(maybeMintB).toBase58();
    const vaultA = new PublicKey(maybeVaultA).toBase58();
    const vaultB = new PublicKey(maybeVaultB).toBase58();

    // Orca authority and pool mint can be inferred from owner/other offsets — best-effort
    const authority = buf.length >= 40 ? (() => {
      try { return new PublicKey(buf.slice(8, 40)).toBase58(); } catch (_) { return null; }
    })() : null;

    // Orca has no Serum integration fields here
    if (mintA && mintB && vaultA && vaultB && mintA !== mintB) {
      return {
        ammId: null,
        ammAuthority: authority,
        openOrders: null,
        targetOrders: null,
        marketProgram: null,
        marketId: null,
        marketBids: null,
        marketAsks: null,
        marketEventQueue: null,
        marketBaseVault: null,
        marketQuoteVault: null,
        vaultA,
        vaultB,
        mintA,
        mintB,
        lpMint: null,
        feeNumerator: fee32 || null,
        feeDenominator: null,
        ampFactor: null,
        stable: null,
        volatile: null,
      };
    }
  } catch (_) {}
  return null;
}

function decodeMeteoraAMM(buf) {
  // Meteora AMM (PoolState V2) — updated offsets (2024+)
  if (!buf || buf.length < 232) return null;
  try {
    // offsets based on PoolState: mintA @72..104, mintB @104..136, vaultA @136..168, vaultB @168..200
    const maybeMintA = buf.slice(72, 104);
    const maybeMintB = buf.slice(104, 136);
    const maybeVaultA = buf.slice(136, 168);
    const maybeVaultB = buf.slice(168, 200);

    // bump/version/fees near start
    const version = buf[0];
    const bump = buf[1];
    const fee32 = buf.length >= 8 ? buf.readUInt32LE(4) : 0;
    const ampFactor = safeReadU64(buf, 232); // best-effort read

    const mintA = new PublicKey(maybeMintA).toBase58();
    const mintB = new PublicKey(maybeMintB).toBase58();
    const vaultA = new PublicKey(maybeVaultA).toBase58();
    const vaultB = new PublicKey(maybeVaultB).toBase58();

    if (mintA && mintB && vaultA && vaultB && mintA !== mintB) {
      return {
        ammId: null,
        ammAuthority: null,
        openOrders: null,
        targetOrders: null,
        marketProgram: null,
        marketId: null,
        marketBids: null,
        marketAsks: null,
        marketEventQueue: null,
        marketBaseVault: null,
        marketQuoteVault: null,
        vaultA,
        vaultB,
        mintA,
        mintB,
        lpMint: null, // lpMint may be available later in struct; could be added if needed
        feeNumerator: fee32 || null,
        feeDenominator: null,
        ampFactor: ampFactor || null,
        stable: version === 2 ? null : null,
        volatile: null,
      };
    }
  } catch (_) {}
  return null;
}

// ----------------------- Fallback heuristic pool decoder ----------------------

async function heuristicPoolDecoder(accPubkey, buf) {
  try {
    if (!buf || buf.length < 64) return null;
    const candidates = new Set();
    const maxScan = Math.min(buf.length, 2048);

    // scan 32-byte aligned slices for valid pubkeys
    for (let i = 0; i + 32 <= maxScan; i += 1) {
      try {
        const slice = buf.slice(i, i + 32);
        const pk = new PublicKey(slice).toBase58();
        if (pk === accPubkey) continue;
        candidates.add(pk);
      } catch (_) {}
      if (candidates.size > 400) break;
    }

    const candArray = Array.from(candidates).slice(0, 400);
    if (candArray.length === 0) return null;

    // batch queries to avoid RPC overload
    const batchSize = 40;
    const tokenCandidates = [];

    for (let i = 0; i < candArray.length; i += batchSize) {
      const batch = candArray.slice(i, i + batchSize);
      const infos = await Promise.all(batch.map(pk =>
  rpcQueue.add(() =>
    conn.getParsedAccountInfo(new PublicKey(pk)).catch(() => null)
  )
));
      for (let j = 0; j < batch.length; j++) {
        const pk = batch[j];
        const info = infos[j];
        if (!info || !info.value) continue;
        const owner = info.value.owner?.toString?.();
        // SPL Token account typically owned by Token Program
        if (owner && owner.startsWith("Tokenkeg")) {
          const parsed = info.value.data?.parsed;
          let mint = parsed?.info?.mint || null;
          let amount = 0;
          if (parsed && parsed.info && parsed.info.tokenAmount) {
            amount = parsed.info.tokenAmount.ui || Number(parsed.info.tokenAmount.amount || 0);
          } else {
            // fallback raw read
            const raw = info.value.data;
            amount = raw && raw.length >= 72 ? safeReadU64(raw, 64) : 0;
          }
          tokenCandidates.push({ pubkey: pk, mint, amount });
        }
      }
    }

    if (tokenCandidates.length < 2) return null;

    tokenCandidates.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    const A = tokenCandidates[0];
    const B = tokenCandidates.find(x => x.mint && x.mint !== A.mint) || tokenCandidates[1];

    if (!B || !A.mint || !B.mint) return null;

    // Map into canonical shape (many fields unknown)
    return {
      mintA: A.mint,
      mintB: B.mint,
      vaultA: A.pubkey,
      vaultB: B.pubkey,
      amountA: A.amount || 0,
      amountB: B.amount || 0,
      // other keys left null so dexbuilders.js sees consistent keys
      ammId: null,
      ammAuthority: null,
      openOrders: null,
      targetOrders: null,
      marketProgram: null,
      marketId: null,
      marketBids: null,
      marketAsks: null,
      marketEventQueue: null,
      marketBaseVault: null,
      marketQuoteVault: null,
      lpMint: null,
      feeNumerator: null,
      feeDenominator: null,
      ampFactor: null,
      stable: null,
      volatile: null,
    };
  } catch {
    return null;
  }
}

// ------------------------ Main scanning function ------------------------

/**
 * scanPools(programId, opts)
 * - programId: PublicKey or string
 * - opts: { limitAccounts: number, minVaultBalance: number }
 * Returns: array of pool objects:
 *  {
 *    pool,
 *    ammId,
 *    ammAuthority,
 *    openOrders,
 *    targetOrders,
 *    marketProgram,
 *    marketId,
 *    marketBids,
 *    marketAsks,
 *    marketEventQueue,
 *    marketBaseVault,
 *    marketQuoteVault,
 *    vaultA,
 *    vaultB,
 *    mintA,
 *    mintB,
 *    lpMint,
 *    feeNumerator,
 *    feeDenominator,
 *    ampFactor,
 *    stable,
 *    volatile,
 *    amountA,
 *    amountB
 *  }
 */
export async function scanPools(programId, opts = {}) {
  const out = [];
  if (!programId) return out;
  const pid = programId instanceof PublicKey ? programId : new PublicKey(programId);

  const limitAccounts = opts.limitAccounts || 400;
  const minVaultBalance = opts.minVaultBalance || 1;

  let programAccounts;
  try {
    programAccounts = await rpcQueue.add(() =>
  conn.getProgramAccounts(pid, { limit: limitAccounts })
);
  } catch (e) {
    console.warn("scanPools.getProgramAccounts failed:", e?.message || e);
    return out;
  }

  // iterate sequentially (keeps memory predictable). For speed, tune concurrency by batching.
  const batch = 20; // number of accounts processed concurrently
  for (let i = 0; i < programAccounts.length; i += batch) {
    const slice = programAccounts.slice(i, i + batch);
    const results = await Promise.all(slice.map(async (acc) => {
      try {
        const full = await rpcQueue.add(() =>
  conn.getAccountInfo(acc.pubkey).catch(() => null)
);
        if (!full || !full.data) return null;

        const buf = full.data;
        const accPub = acc.pubkey.toBase58();

        // protocol-specific decoders (AMM-only)
        let decoded = null;
        try {
          if (pid.equals(PROGRAMS.RAYDIUM_AMM)) decoded = decodeRaydiumAMM(buf);
          else if (pid.equals(PROGRAMS.ORCA_AMM)) decoded = decodeOrcaAMM(buf);
          else if (pid.equals(PROGRAMS.METEORA_AMM)) decoded = decodeMeteoraAMM(buf);
        } catch (_) { decoded = null; }

 if (decoded) {
  // get amounts (best-effort)
  const amountA = await getTokenAmountFromAccount(decoded.vaultA).catch(() => 0);
  const amountB = await getTokenAmountFromAccount(decoded.vaultB).catch(() => 0);
  if ((amountA + amountB) < minVaultBalance) return null;

  // Build canonical full object (ensure every key exists)
  // First set pool and ammId
  const initial = Object.assign({}, decoded, {
    pool: accPub,
    ammId: accPub, // on-chain AMM state id = account pubkey
    amountA,
    amountB,
  });

  // Apply JSON fallback if needed (Raydium often needs Serum fields)
  const { merged, serumFallback, usesSerum } = applyJsonFallback(accPub, initial);

  // Expose serumFallback for debugging/tracking; makePoolOutput adds consistent keys
  const base = Object.assign({}, merged, {
    serumFallback: serumFallback || null,
    usesSerum: usesSerum || false,
  });

  out.push(makePoolOutput(base));
  return null; // already appended
}

        // Fallback heuristic decoder
        const heur = await heuristicPoolDecoder(accPub, buf);
        if (!heur) return null;
        const total = (heur.amountA || 0) + (heur.amountB || 0);
        if (total < minVaultBalance) return null;

        // Map heuristic into canonical shape
        const base = Object.assign({}, heur, {
          pool: accPub,
          ammId: accPub,
        });
        out.push(makePoolOutput(base));
        return null;
      } catch {
        return null;
      }
    }));

    // results processed above (we pushed into out directly), continue loop
  }

  return out;
}

/**
 * scanAllPools(opts)
 * - Scans Raydium, Orca (AMM), Meteora (AMM) and returns object { raydium:[], orca:[], meteora:[] }
 */
export async function scanAllPools(opts = {}) {
  const res = {};
  try {
    res.raydium = await scanPools(PROGRAMS.RAYDIUM_AMM, opts);
  } catch (e) { res.raydium = []; console.warn("scanAllPools.raydium error", e?.message || e); }
  try {
    res.orca = await scanPools(PROGRAMS.ORCA_AMM, opts);
  } catch (e) { res.orca = []; console.warn("scanAllPools.orca error", e?.message || e); }
  try {
    res.meteora = await scanPools(PROGRAMS.METEORA_AMM, opts);
  } catch (e) { res.meteora = []; console.warn("scanAllPools.meteora error", e?.message || e); }
  return res;
}

// default export
export default {
  PROGRAMS,
  scanPools,
  scanAllPools,
};