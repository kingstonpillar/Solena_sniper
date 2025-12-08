// priceScanner.js
// AMM-only on-chain price scanner (Raydium + Orca)
// Optimized for fewer RPC calls, correct price direction, and a strict 6 req/sec limiter.

import { PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

/* ---------------- Rate Limit Queue ---------------- */
const rpcQueue = new PQueue({
  interval: 1000,       // 1 second window
  intervalCap: 6,       // EXACTLY 6 RPC calls per second
  concurrency: 6        // max 6 running at same time
});
async function q(fn) { return rpcQueue.add(fn); }

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/* ---------------------- CONFIG --------------------- */
export const DEX_PROGRAMS = {
  Raydium_AMM_v4: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  Orca_AMM:       new PublicKey("9WwRZjZJ9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5")
};

/* ------------------- small helpers ------------------ */
function bufToHex(b) {
  if (!b) return "";
  return Buffer.isBuffer(b) ? b.toString("hex") : Buffer.from(b).toString("hex");
}

function parsePossibleAccountData(acc) {
  // Handle shapes returned by getProgramAccounts or getAccountInfo: support acc.account?.data, acc.data
  const d = acc?.account?.data ?? acc?.data ?? null;
  if (!d) return null;

  // cases: [base64, encoding], Buffer, Uint8Array
  if (Array.isArray(d) && typeof d[0] === "string") {
    try { return Buffer.from(d[0], "base64"); } catch { return null; }
  }
  if (Buffer.isBuffer(d)) return d;
  if (d instanceof Uint8Array) return Buffer.from(d);
  return null;
}

/* ---------- Candidate pubkeys extraction (less aggressive) ---------- */
function extractCandidatePubkeysFromDataSlice(buf, limit = 8) {
  // We scan with stride 8 (not 4) to reduce false positives while still catching misaligned layouts.
  const set = new Set();
  if (!buf || buf.length < 32) return [];
  for (let offset = 0; offset + 32 <= buf.length; offset += 8) {
    const slice = buf.slice(offset, offset + 32);
    if (slice.equals(Buffer.alloc(32))) continue;
    set.add(slice.toString("hex"));
    if (set.size >= limit) break;
  }
  return Array.from(set).map(h => (new PublicKey(Buffer.from(h, "hex"))).toBase58());
}

/* ------------------- probe token account ------------------- */
async function probeTokenAccount(connection, pubkeyBase58) {
  try {
    const pub = new PublicKey(pubkeyBase58);
    const info = await q(() => connection.getParsedAccountInfo(pub, "confirmed"));
    const val = info?.value;
    if (!val) return null;

    // validate owner is SPL Token program
    const owner = val.owner ? (typeof val.owner.toString === "function" ? val.owner.toString() : String(val.owner)) : null;
    if (!owner || !owner.includes("Tokenkeg")) return null;

    const parsed = val.data?.parsed?.info ?? null;
    if (!parsed) return null;

    const mint = parsed.mint;
    const tokenAmount = parsed.tokenAmount ?? parsed.tokenAmount; // defensive
    const uiAmount = tokenAmount?.uiAmount ?? null;
    const decimals = tokenAmount?.decimals ?? null;
    const amountRaw = tokenAmount?.amount ? BigInt(tokenAmount.amount) : null;

    return { pubkey: pubkeyBase58, mint, uiAmount, amountRaw, decimals };
  } catch (_) {
    return null;
  }
}

/* ------------------- read vault amount robustly ------------------- */
async function readVaultAmount(connection, vaultPub) {
  // Try parsed first
  try {
    const parsed = await q(() => connection.getParsedAccountInfo(new PublicKey(vaultPub), "confirmed"));
    const v = parsed?.value;
    if (v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.tokenAmount) {
      const t = v.data.parsed.info.tokenAmount;
      const amountRaw = t.amount ? BigInt(t.amount) : (typeof t.uiAmount === "number" && typeof t.decimals === "number"
        ? BigInt(Math.floor(t.uiAmount * Math.pow(10, t.decimals)))
        : null);
      return { amountRaw, uiAmount: t.uiAmount ?? null, decimals: t.decimals ?? null };
    }
  } catch (_) { /* continue to fallback */ }

  // Fallback raw account layout (u64 at offset 64 LE)
  try {
    const raw = await q(() => connection.getAccountInfo(new PublicKey(vaultPub), "confirmed"));
    const data = raw?.data;
    if (!data) return null;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length >= 72) {
      const amountRaw = buf.readBigUInt64LE(64);
      return { amountRaw, uiAmount: null, decimals: null };
    }
  } catch (_) { /* ignore */ }

  return null;
}

/* ------------------- decode helpers (AMM only) ------------------- */
/*
  We'll implement a minimal set of offset attempts for Raydium v4 and Orca whirlpool.
  These offsets are best-effort and chosen to catch typical layouts.
*/

function tryDecodeRaydium(fullBuf) {
  if (!fullBuf || fullBuf.length < 200) return null;
  const patterns = [
    { mintA: [72,104], mintB: [104,136], vaultA: [136,168], vaultB: [168,200] },
    { mintA: [64,96],  mintB: [96,128],  vaultA: [128,160], vaultB: [160,192] }
  ];
  for (const p of patterns) {
    if (fullBuf.length >= p.vaultB[1]) {
      try {
        const mintA = new PublicKey(fullBuf.slice(p.mintA[0], p.mintA[1])).toBase58();
        const mintB = new PublicKey(fullBuf.slice(p.mintB[0], p.mintB[1])).toBase58();
        const vaultA = new PublicKey(fullBuf.slice(p.vaultA[0], p.vaultA[1])).toBase58();
        const vaultB = new PublicKey(fullBuf.slice(p.vaultB[0], p.vaultB[1])).toBase58();
        return { mintA, mintB, vaultA, vaultB };
      } catch (_) {}
    }
  }
  return null;
}

function tryDecodeOrca(fullBuf) {
  if (!fullBuf || fullBuf.length < 232) return null;
  const patterns = [
    { mintA: [72,104], mintB: [104,136], vaultA: [168,200], vaultB: [200,232] },
    { mintA: [64,96],  mintB: [96,128],  vaultA: [160,192], vaultB: [192,224] }
  ];
  for (const p of patterns) {
    if (fullBuf.length >= p.vaultB[1]) {
      try {
        const mintA = new PublicKey(fullBuf.slice(p.mintA[0], p.mintA[1])).toBase58();
        const mintB = new PublicKey(fullBuf.slice(p.mintB[0], p.mintB[1])).toBase58();
        const vaultA = new PublicKey(fullBuf.slice(p.vaultA[0], p.vaultA[1])).toBase58();
        const vaultB = new PublicKey(fullBuf.slice(p.vaultB[0], p.vaultB[1])).toBase58();
        return { mintA, mintB, vaultA, vaultB };
      } catch (_) {}
    }
  }
  return null;
}

/* ------------------- inspectPoolAccount (reduced RPC) ------------------- */
async function inspectPoolAccount(connection, matched, targetMint) {
  // matched: { pubkey, dataSlice, fullAccount (optional) }
  const result = {
    poolAccount: matched.pubkey.toString(),
    matchedDataSnippet: bufToHex(matched.dataSlice).slice(0, 400),
    vaults: [],
    reserves: {},
    priceInSOL: null,
    decimals: null,
    dex: null
  };

  // first, attempt to decode from full account if available (faster and more deterministic)
  let fullBuf = null;
  if (matched.fullAccount) {
    fullBuf = parsePossibleAccountData(matched.fullAccount);
  }
  // if full not present, we'll request only once below (queued)
  if (!fullBuf) {
    try {
      const acc = await q(() => connection.getAccountInfo(matched.pubkey, "confirmed"));
      fullBuf = parsePossibleAccountData({ data: acc?.data });
    } catch (_) { fullBuf = null; }
  }

  // Attempt AMM-specific decodes
  let decoded = null;
  if (fullBuf) {
    decoded = tryDecodeRaydium(fullBuf) || tryDecodeOrca(fullBuf) || null;
  }

  // If decoders found vaults explicitly, read vault amounts directly (two RPC calls)
  if (decoded && decoded.vaultA && decoded.vaultB) {
    const [aInfo, bInfo] = await Promise.all([
      readVaultAmount(connection, decoded.vaultA).catch(() => null),
      readVaultAmount(connection, decoded.vaultB).catch(() => null)
    ]);
    const vA = { pubkey: decoded.vaultA, mint: decoded.mintA, ...aInfo };
    const vB = { pubkey: decoded.vaultB, mint: decoded.mintB, ...bInfo };
    result.vaults = [vA, vB];
    result.reserves[vA.mint] = { amountRaw: vA.amountRaw, uiAmount: vA.uiAmount, decimals: vA.decimals };
    result.reserves[vB.mint] = { amountRaw: vB.amountRaw, uiAmount: vB.uiAmount, decimals: vB.decimals };

    // compute priceInSOL in canonical way: tokenPriceInSOL = reserveSOL / reserveToken
    // determine which vault is WSOL
    const aIsSOL = vA.mint === WSOL_MINT;
    const bIsSOL = vB.mint === WSOL_MINT;

    try {
      const aAmt = vA.amountRaw !== null ? Number(vA.amountRaw) : (vA.uiAmount || 0);
      const bAmt = vB.amountRaw !== null ? Number(vB.amountRaw) : (vB.uiAmount || 0);

      if (aIsSOL && !bIsSOL && bAmt > 0) {
        result.priceInSOL = aAmt / bAmt;           // SOL / token  => token price in SOL
      } else if (bIsSOL && !aIsSOL && aAmt > 0) {
        result.priceInSOL = bAmt / aAmt;
      } else {
        // fallback: assume mint order a->b corresponds to token->quote and return b/a
        if (aAmt > 0 && bAmt > 0) result.priceInSOL = bAmt / aAmt;
      }
    } catch (_) { /* leave priceInSOL null */ }

    // attach decimals (prefer token decimals)
    result.decimals = (vA.decimals ?? vB.decimals) || null;
    return result;
  }

  // If decoder didn't find vaults, fall back to candidate scanning but limit probes (cheap)
  // Extract candidate pubkeys from data slice (this is a light pass)
  const candidates = extractCandidatePubkeysFromData(matched.dataSlice, 12);
  if (!candidates || candidates.length === 0) return result;

  // Probe candidates concurrently but limited by rpcQueue underlying concurrency
  const probePromises = candidates.map(c => probeTokenAccount(connection, c));
  const probes = await Promise.all(probePromises);
  const valid = (probes.filter(Boolean)).slice(0, 6); // keep a few valid candidates

  // Find targetMint + counterpart
  const target = valid.filter(v => v.mint === targetMint);
  const others = valid.filter(v => v.mint !== targetMint);

  let chosen = [];
  if (target.length >= 1 && others.length >= 1) {
    chosen = [target[0], others[0]];
  } else if (valid.length >= 2) {
    chosen = [valid[0], valid[1]];
  } else if (valid.length === 1) {
    chosen = [valid[0]];
  } else {
    return result;
  }

  // read vault amounts for chosen set
  const reads = chosen.map(c => readVaultAmount(connection, c.pubkey).catch(() => null));
  const amounts = await Promise.all(reads);

  const vaults = [];
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    const a = amounts[i];
    const amountRaw = a?.amountRaw ?? c.amountRaw ?? null;
    const uiAmount = a?.uiAmount ?? c.uiAmount ?? null;
    const decimals = a?.decimals ?? c.decimals ?? null;
    vaults.push({ pubkey: c.pubkey, mint: c.mint, amountRaw, uiAmount, decimals });
    result.reserves[c.mint] = { amountRaw, uiAmount, decimals };
    if (!result.decimals && typeof decimals === "number") result.decimals = decimals;
  }

  // compute price like above if both available
  if (vaults.length >= 2) {
    try {
      const v0 = vaults[0], v1 = vaults[1];
      const aAmt = v0.amountRaw !== null ? Number(v0.amountRaw) : (v0.uiAmount || 0);
      const bAmt = v1.amountRaw !== null ? Number(v1.amountRaw) : (v1.uiAmount || 0);
      const aIsSOL = v0.mint === WSOL_MINT;
      const bIsSOL = v1.mint === WSOL_MINT;
      if (aIsSOL && !bIsSOL && bAmt > 0) result.priceInSOL = aAmt / bAmt;
      else if (bIsSOL && !aIsSOL && aAmt > 0) result.priceInSOL = bAmt / aAmt;
      else if (aAmt > 0 && bAmt > 0) result.priceInSOL = bAmt / aAmt;
    } catch (_) { /* ignore */ }
  }

  result.vaults = vaults;
  return result;
}

/* ----------------------------- Main scanMintFast ------------------------- */
/**
 * scanMintFast(connection, mint, opts)
 * - connection: solana Connection
 * - mint: mint address (string | PublicKey)
 * - opts: { dataSliceLen, maxProgramAccountsToCheck, solPriceUsd }
 *
 * Returns:
 *   { dex, programId, found, poolAccount, inspection, priceInSOL, priceInUSD, vaults, reserves, decimals, extra }
 */
export async function scanMintFast(connection, mint, opts = {}) {
  const mintKey = new PublicKey(mint);
  const dataSliceLen = opts.dataSliceLen ?? 200;
  const maxProgramAccountsToCheck = opts.maxProgramAccountsToCheck ?? 200;
  const solPriceUsd = typeof opts.solPriceUsd === "number" ? opts.solPriceUsd : null;

  const scans = [
    { id: "raydium", program: DEX_PROGRAMS.Raydium_AMM_v4 },
    { id: "orca",    program: DEX_PROGRAMS.Orca_AMM }
  ];

  // iterate scans sequentially to stop early when we find a good pool
  for (const s of scans) {
    try {
      // 1) getProgramAccounts with a small dataSlice to reduce payloads
      const optsGetProg = {
        dataSlice: { offset: 0, length: dataSliceLen },
        commitment: "confirmed",
        encoding: "base64"
      };

      const rawAccounts = await q(() => connection.getProgramAccounts(s.program, optsGetProg)).catch(() => []);
      if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) continue;

      // 2) filter matching accounts by presence of mint bytes in the slice
      const targetBuf = Buffer.from(mintKey.toBuffer());
      const matches = [];
      for (const acc of rawAccounts) {
        const slice = parsePossibleAccountData(acc);
        if (!slice) continue;
        if (slice.indexOf(targetBuf) !== -1) {
          matches.push({ pubkey: acc.pubkey, dataSlice: slice, fullAccount: acc.account ?? null });
          if (matches.length >= Math.min(40, maxProgramAccountsToCheck)) break;
        }
      }
      if (matches.length === 0) continue;

      // 3) inspect matches one-by-one (lightweight inspect first, heavier read only when necessary)
      for (const m of matches) {
        try {
          const inspection = await inspectPoolAccount(connection, m, mintKey.toBase58());
          // if inspection contains vaults & positive reserves return immediately
          const vaults = inspection.vaults || [];
          const hasReserve = vaults.some(v => (v.amountRaw && v.amountRaw > 0n) || (v.uiAmount && v.uiAmount > 0));
          if (hasReserve) {
            const priceInSOL = inspection.priceInSOL ?? null;
            const priceInUSD = (priceInSOL !== null && solPriceUsd !== null) ? (priceInSOL * solPriceUsd) : null;
            return {
              dex: s.id,
              programId: s.program.toBase58(),
              found: true,
              poolAccount: m.pubkey.toBase58(),
              matchedAccountDataSnippet: bufToHex(m.dataSlice).slice(0, 400),
              vaults: inspection.vaults,
              reserves: inspection.reserves,
              decimals: inspection.decimals,
              priceInSOL,
              priceInUSD,
              extra: { inspection }
            };
          }
        } catch (e) {
          // Continue to next match on errors
          continue;
        }
      }
    } catch (_) {
      // isolated scan error -> continue to next DEX
      continue;
    }
  }

  return { dex: null, found: false, reason: "no_pool_found" };
}