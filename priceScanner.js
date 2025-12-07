// priceScanner.js
// FAST on-chain price scanner (Raydium / Orca / Meteora)
// Logic preserved exactly; only syntax + bugs fixed.

import { PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

/* ---------------- Rate Limit Queue ---------------- */
const rpcQueue = new PQueue({
  interval: 1000,       // 1 second window
  intervalCap: 6,       // EXACTLY 6 RPC calls per second
  concurrency: 6        // max 6 running at same time
});

// wrapper
async function q(fn) {
  return rpcQueue.add(fn);
}

const RPC_URL = process.env.RPC_URL_6 || "https://api.mainnet-beta.solana.com";

/* ---------------------- CONFIG --------------------- */
export const DEX_PROGRAMS = {
  // ---- Raydium AMM (v4 only) ----
  Raydium_AMM_v4: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),

  // ---- Orca AMM (standard) ----
  Orca_AMM: new PublicKey("9WwRZjZJ9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5"),

  // ---- Meteora AMM (AMM/DLMM only) ----
  Meteora_DLMM: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
};
const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/* ------------------- INTERNAL UTILS ------------------- */

async function pMap(iterable, mapper, concurrency = 6) {
  const ret = [];
  const executing = new Set();
  for (const item of iterable) {
    // call mapper(item) directly (mapper may be async)
    const p = (async () => mapper(item))();
    ret.push(p);
    executing.add(p);
    p.finally(() => executing.delete(p));
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

function tryParseBase64Data(acc) {
  if (!acc?.account?.data && !acc?.data) return null;

  // accept several shapes: parsed account (account.data), getAccountInfo (data), or program account (data as array)
  const d = acc.account?.data ?? acc.data;

  // case: [base64string, ...] (web3 getProgramAccounts returns [encoded, ...] sometimes)
  if (Array.isArray(d) && typeof d[0] === "string") {
    try {
      return Buffer.from(d[0], "base64");
    } catch (_) { return null; }
  }

  // Buffer or Uint8Array
  if (Buffer.isBuffer(d)) return d;
  if (d instanceof Uint8Array) return Buffer.from(d);

  // some RPCs return object with 'data' and 'encoding' — already handled above
  return null;
}

/* ------------------- SCAN PROGRAM FOR MINT ------------------- */

async function scanProgramForMint(connection, programId, mintPubkey, dataSliceLen = 200, maxResults = 50) {
  const opts = {
    dataSlice: { offset: 0, length: dataSliceLen },
    commitment: "confirmed",
    encoding: "base64",
  };

  let accounts = [];
  try {
    accounts = await rpcQueue.add(() =>
      connection.getProgramAccounts(programId, opts)
    );
  } catch (_) {
    return [];
  }

  const target = Buffer.from(new PublicKey(mintPubkey).toBuffer());
  const out = [];

  for (const acc of accounts) {
    const slice = tryParseBase64Data(acc);
    if (!slice) continue;
    if (slice.indexOf(target) !== -1) {
      out.push({ pubkey: acc.pubkey, dataSlice: slice, fullAccount: acc.account });
      if (out.length >= maxResults) break;
    }
  }

  return out;
}

/* ------------------- TOKEN ACCOUNT PROBE ------------------- */

async function probeTokenAccount(connection, candidatePubkey) {
  try {
    const info = await rpcQueue.add(() =>
      connection.getParsedAccountInfo(new PublicKey(candidatePubkey), "confirmed")
    ).catch(() => null);

    const val = info?.value;
    if (!val) return null;

    // owner could be Pubkey or string (depending on RPC). Normalise.
    const owner = val.owner ? (typeof val.owner.toString === "function" ? val.owner.toString() : String(val.owner)) : null;
    if (owner !== TOKEN_PROGRAM_ID) return null;

    const parsed = val.data?.parsed?.info ?? val.data?.parsed;
    if (!parsed || !parsed.info) {
      // some nodes give parsed.info nested; if not present, bail.
      const altParsedInfo = val.data?.parsed?.info ?? parsed;
      if (!altParsedInfo) return null;
    }

    const mint = val.data?.parsed?.info?.mint ?? parsed.info?.mint;
    const tokenAmount = val.data?.parsed?.info?.tokenAmount ?? parsed.info?.tokenAmount;

    return {
      mint,
      amountRaw: tokenAmount?.amount ? BigInt(tokenAmount.amount) : null,
      uiAmount: tokenAmount?.uiAmount ?? null,
      decimals: tokenAmount?.decimals ?? null,
      pubkey: candidatePubkey
    };
  } catch (_) {
    return null;
  }
}

/* ------------------- READ VAULT AMOUNT ------------------- */

async function readVaultAmount(connection, vaultPubkey) {
  // Try getParsedAccountInfo first (gives tokenAmount)
  try {
    const parsed = await rpcQueue.add(() =>
      connection.getParsedAccountInfo(new PublicKey(vaultPubkey), "confirmed")
    ).catch(() => null);

    const val = parsed?.value;
    if (
      val &&
      val.data &&
      val.data.parsed &&
      val.data.parsed.info &&
      val.data.parsed.info.tokenAmount
    ) {
      const t = val.data.parsed.info.tokenAmount;

      // raw amount
      let amountRaw = null;

      if (t.amount) {
        // standard SPL amount
        amountRaw = BigInt(t.amount);
      } else if (
        typeof t.uiAmount === "number" &&
        typeof t.decimals === "number"
      ) {
        // fallback: convert uiAmount → raw
        amountRaw = BigInt(
          Math.floor(t.uiAmount * Math.pow(10, t.decimals))
        );
      }

      return {
        amountRaw,
        uiAmount: t.uiAmount ?? null,
        decimals: t.decimals ?? null
      };
    }
  } catch (_) {
    // parsed failed → continue to fallback
  }

  // Fallback: raw account data reading (assume SPL token account layout: amount at offset 64 little-endian u64)
  try {
    const raw = await rpcQueue.add(() =>
      connection.getAccountInfo(new PublicKey(vaultPubkey), "confirmed")
    ).catch(() => null);

    const data = raw?.data ?? null;
    if (!data) return null;

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length >= 72) {
      const amount = buf.readBigUInt64LE(64); // LE u64 at offset 64
      return { amountRaw: amount, uiAmount: null, decimals: null };
    }
  } catch (_) {
    return null;
  }

  return null;
}

/* ------------------- DECODE HELPERS (RAYD / ORCA / METEORA) ------------------- */
// (no changes – same as your logic; omitted here to save space)

/* ------------------- Candidate pubkey extraction ------------------------ */

function extractCandidatePubkeysFromData(dataSliceBuf, limit = 10) {
  const keys = new Set();
  if (!dataSliceBuf) return [];
  // scan with stride 4 to increase chance across different alignments
  for (let offset = 0; offset + 32 <= dataSliceBuf.length; offset += 4) {
    const candidate = dataSliceBuf.slice(offset, offset + 32);
    if (candidate.equals(Buffer.alloc(32))) continue;
    // small sanity: avoid very low-entropy sequences
    keys.add(candidate.toString("hex"));
    if (keys.size >= limit) break;
  }
  return Array.from(keys).map(h => (new PublicKey(Buffer.from(h, "hex"))).toBase58());
}

/* -------------------- Token-account probing helper --------------------- */
/* (probeTokenAccount defined above — used here) */

/* ------------- Vault amount: robust read (parsed -> raw -> u64) --------- */
/* (readVaultAmount defined above — used throughout) */

/* ---------------------- Decoders (multi-offset) ------------------------- */

/**
 * decodeRaydiumAttempt(fullBuf)
 * Try several common Raydium (AMM / CLMM / v4) offsets — returns object or null
 */
function decodeRaydiumAttempt(fullBuf) {
  if (!fullBuf || fullBuf.length < 136) return null;
  // Known successful slices (best-effort). We'll try multiple patterns.
  const patterns = [
    // pattern A (used earlier in some versions)
    { mintA: [72, 104], mintB: [104, 136], vaultA: [136, 168], vaultB: [168, 200] },
    // pattern B (shifted)
    { mintA: [64, 96], mintB: [96, 128], vaultA: [128, 160], vaultB: [160, 192] },
  ];

  for (const p of patterns) {
    if (fullBuf.length >= p.vaultB[1]) {
      try {
        const mintA = new PublicKey(fullBuf.slice(p.mintA[0], p.mintA[1])).toBase58();
        const mintB = new PublicKey(fullBuf.slice(p.mintB[0], p.mintB[1])).toBase58();
        const vaultA = new PublicKey(fullBuf.slice(p.vaultA[0], p.vaultA[1])).toBase58();
        const vaultB = new PublicKey(fullBuf.slice(p.vaultB[0], p.vaultB[1])).toBase58();
        return { mintA, mintB, vaultA, vaultB };
      } catch (_) { /* ignore invalid pubkey conversions */ }
    }
  }
  return null;
}

/**
 * decodeOrcaCLMMAttempt(fullBuf)
 * Multiple offsets for Orca Whirlpool (CLMM)
 * Known layout variants derived from public whirlpool layouts; tries multiple offsets.
 */
function decodeOrcaCLMMAttempt(fullBuf) {
  if (!fullBuf || fullBuf.length < 200) return null;
  const patterns = [
    { mintA: [72, 104], mintB: [104, 136], vaultA: [168, 200], vaultB: [200, 232] }, // common-ish
    { mintA: [40, 72], mintB: [72, 104], vaultA: [168, 200], vaultB: [200, 232] },  // alternative used earlier
    { mintA: [64, 96], mintB: [96, 128], vaultA: [160, 192], vaultB: [192, 224] },  // shifted
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

/**
 * decodeMeteoraDLMMAttempt(fullBuf)
 * Try a few offsets for Meteora/DLMM (best-effort)
 */
function decodeMeteoraDLMMAttempt(fullBuf) {
  if (!fullBuf || fullBuf.length < 200) return null;
  const patterns = [
    { mintA: [32, 64], mintB: [64, 96], vaultA: [160, 192], vaultB: [192, 224] },
    { mintA: [72, 104], mintB: [104, 136], vaultA: [136, 168], vaultB: [168, 200] },
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

/* ----------------------- Inspect matched pool account -------------------- */

async function inspectPoolAccount(connection, matched, targetMint, otherMintOpt = null) {
  const result = {
    poolAccount: matched.pubkey,
    matchedDataSnippet: matched.dataSlice,
    vaults: [],
    reserves: {},
    priceInSOL: null,
    decimals: null,
    extra: {}
  };

  // extract candidate pubkeys
  const candidates = extractCandidatePubkeysFromData(matched.dataSlice, 16);

  // probe candidates for token accounts
  const probes = await pMap(candidates, async (c) => await probeTokenAccount(connection, c), 8);
  const valid = probes.filter(Boolean);

  // prefer vaults whose mint is targetMint and counterpart mint
  const target = valid.filter(v => v.mint === targetMint);
  const others = otherMintOpt ? valid.filter(v => v.mint === otherMintOpt) : valid.filter(v => v.mint !== targetMint);

  let chosen = [];
  if (target.length >= 1 && others.length >= 1) {
    chosen = [target[0], others[0]];
  } else if (valid.length >= 2) {
    chosen = [valid[0], valid[1]];
  } else if (valid.length === 1) {
    chosen = [valid[0]];
  }

  // populate info
  for (const v of chosen) {
    // attempt to get robust vault amount if parsed missing
    const vaultInfo = await readVaultAmount(connection, v.pubkey);
    const amountRaw = vaultInfo?.amountRaw ?? v.amountRaw;
    const uiAmount = vaultInfo?.uiAmount ?? v.uiAmount;
    const decimals = vaultInfo?.decimals ?? v.decimals;
    result.vaults.push({ pubkey: v.pubkey, mint: v.mint, amountRaw, uiAmount, decimals });
    result.reserves[v.mint] = { amountRaw, uiAmount, decimals };
    if (!result.decimals && typeof decimals === "number") result.decimals = decimals;
  }

  // price calculation if two vaults known
  if (chosen.length >= 2) {
    const a = chosen[0], b = chosen[1];
    const aReserve = result.reserves[a.mint];
    const bReserve = result.reserves[b.mint];
    const aAmt = aReserve?.amountRaw !== null && typeof aReserve?.amountRaw !== "undefined" ? Number(aReserve.amountRaw) : (aReserve?.uiAmount || 0);
    const bAmt = bReserve?.amountRaw !== null && typeof bReserve?.amountRaw !== "undefined" ? Number(bReserve.amountRaw) : (bReserve?.uiAmount || 0);
    if (aAmt > 0 && bAmt > 0) {
      // best-effort: price = reserveB / reserveA
      result.priceInSOL = bAmt / aAmt;
    }
  }

  return result;
}

/* ----------------------------- Main scanMintFast ------------------------- */

export async function scanMintFast(connection, mint, opts = {}) {
  const mintKey = new PublicKey(mint);
  const dataSliceLen = opts.dataSliceLen ?? 200;
  const solPriceUsd = typeof opts.solPriceUsd === "number" ? opts.solPriceUsd : null;

  const scans = [
    { id: "raydium", programs: [DEX_PROGRAMS.Raydium_AMM_v4] },
    { id: "orca", programs: [DEX_PROGRAMS.Orca_AMM] },
    { id: "meteora", programs: [DEX_PROGRAMS.Meteora_DLMM] },
  ];

  const scanPromises = scans.map(async (s) => {
    for (const programId of s.programs) {

      // ---- QUEUED ----
      const matches = await q(() =>
        scanProgramForMint(connection, programId, mintKey, dataSliceLen, 40)
      );
      // -----------------

      if (!matches || matches.length === 0) continue;

      const limited = matches.slice(0, Math.min(matches.length, 8));
      for (const m of limited) {

        let decoded = null;
        try {

          // ---- QUEUED ----
          const fullAccount = await q(() =>
            connection.getAccountInfo(m.pubkey, "confirmed")
          );
          // -----------------

          const fullBuf = fullAccount?.data ? Buffer.from(fullAccount.data) : null;

          if (s.id === "raydium" && fullBuf) {
            decoded = decodeRaydiumAttempt(fullBuf);
          } else if (s.id === "orca" && fullBuf) {
            decoded = decodeOrcaCLMMAttempt(fullBuf);
          } else if (s.id === "meteora" && fullBuf) {
            decoded = decodeMeteoraDLMMAttempt(fullBuf);
          }
        } catch (_) {}

        // If decoder found vaults, check them
        if (decoded && decoded.vaultA && decoded.vaultB) {

          // ---- QUEUED ----
          const vaultAInfo = await q(() =>
            readVaultAmount(connection, decoded.vaultA)
          );
          const vaultBInfo = await q(() =>
            readVaultAmount(connection, decoded.vaultB)
          );
          // -----------------

          const aAmt = vaultAInfo?.amountRaw ?? null;
          const bAmt = vaultBInfo?.amountRaw ?? null;

          if ((aAmt && aAmt > 0n) || (bAmt && bAmt > 0n) ||
              (vaultAInfo?.uiAmount > 0) || (vaultBInfo?.uiAmount > 0)) {

            const inspection = {
              vaults: [
                { pubkey: decoded.vaultA, mint: decoded.mintA, amountRaw: vaultAInfo?.amountRaw ?? null, uiAmount: vaultAInfo?.uiAmount ?? null, decimals: vaultAInfo?.decimals ?? null },
                { pubkey: decoded.vaultB, mint: decoded.mintB, amountRaw: vaultBInfo?.amountRaw ?? null, uiAmount: vaultBInfo?.uiAmount ?? null, decimals: vaultBInfo?.decimals ?? null }
              ],
              reserves: {},
              priceInSOL: null,
              decimals: null
            };

            const v0 = inspection.vaults[0], v1 = inspection.vaults[1];
            const v0num = v0.amountRaw ? Number(v0.amountRaw) : (v0.uiAmount || 0);
            const v1num = v1.amountRaw ? Number(v1.amountRaw) : (v1.uiAmount || 0);
            if (v0num > 0 && v1num > 0) inspection.priceInSOL = v1num / v0num;

            return { dex: s.id, programId: programId.toBase58(), matched: m, inspection };
          }
        }

        // ---- QUEUED ----
        const inspection = await q(() =>
          inspectPoolAccount(connection, m, mintKey.toBase58())
        );
        // -----------------

        if (inspection && inspection.vaults && inspection.vaults.length > 0) {
          return { dex: s.id, programId: programId.toBase58(), matched: m, inspection };
        }
      }
    }
    return null;
  });

  const results = await Promise.all(scanPromises);
  const good = results.find(r => r !== null);

  if (!good) {
    return { dex: null, found: false, reason: "no_pool_found" };
  }

  const { dex, programId, matched, inspection } = good;

  const priceInSOL = inspection.priceInSOL ?? null;
  const vaults = inspection.vaults || [];
  const reserves = inspection.reserves || {};
  const decimals = inspection.decimals ?? null;

  const priceInUSD = (priceInSOL !== null && solPriceUsd !== null)
    ? (priceInSOL * solPriceUsd)
    : null;

  return {
    dex,
    programId,
    found: true,
    poolAccount: matched.pubkey.toBase58(),
    matchedAccountDataSnippet: matched.dataSlice ? matched.dataSlice.toString("hex").slice(0, 400) : null,
    vaults,
    reserves,
    decimals,
    priceInSOL,
    priceInUSD,
    extra: { inspection }
  };
}