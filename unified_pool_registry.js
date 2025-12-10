// unified_pool_registry_AMM_only.js

      unified_pool_registry.js
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import PQueue from "p-queue";

const RPC_URL = process.env.RPC_URL_9 || "https://solana-mainnet.lava.build";
const conn = new Connection(RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false
});

conn._rpcWebSocket?.on("close", () => {
  console.log("Lava WS closed – reconnecting...");
});

let JSON_FALLBACK = null;
try {
  const p = path.resolve(process.cwd(), "unified_pool_registry_backup.json");
  if (fs.existsSync(p)) {
    JSON_FALLBACK = JSON.parse(fs.readFileSync(p, "utf8"));
  }
} catch {}

// === Program IDs ===
export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  ORCA_AMM: new PublicKey("9WwRZjZJ9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5"),
  METEORA_AMM: new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"),
};

// ---- Rate Limit ----
const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 6,
  concurrency: 6
});

// --- Helpers ---
function safeReadU64(buf, offset) {
  if (!buf || buf.length < offset + 8) return 0;
  if (typeof buf.readBigUInt64LE === "function") {
    const v = buf.readBigUInt64LE(offset);
    return Number(v <= BigInt(Number.MAX_SAFE_INTEGER) ? v : v % BigInt(Number.MAX_SAFE_INTEGER));
  } else {
    let n = 0n;
    for (let i = 0; i < 8; i++) {
      n |= BigInt(buf[offset + i] & 0xff) << BigInt(8 * i);
    }
    return Number(n <= BigInt(Number.MAX_SAFE_INTEGER) ? n : n % BigInt(Number.MAX_SAFE_INTEGER));
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
      return typeof parsed.info.tokenAmount?.ui === "number"
        ? parsed.info.tokenAmount.ui
        : Number(parsed.info.tokenAmount?.amount || 0);
    }
    const raw = info.value.data;
    return raw && raw.length >= 72 ? safeReadU64(raw, 64) : 0;
  } catch {
    return 0;
  }
}

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
    serumFallback: base.serumFallback || null,
    usesSerum: base.usesSerum || false,
  };
}

function applyJsonFallback(poolPubkey, decoded) {
  if (!JSON_FALLBACK) return { merged: decoded, serumFallback: null, usesSerum: false };
  let candidate = JSON_FALLBACK[poolPubkey] || null;
  if (!candidate && Array.isArray(JSON_FALLBACK)) {
    const dMintA = decoded.mintA;
    const dMintB = decoded.mintB;
    candidate = JSON_FALLBACK.find(p => p && ((p.pool === poolPubkey) || (p.mintA && p.mintB && ((p.mintA === dMintA && p.mintB === dMintB) || (p.mintA === dMintB && p.mintB === dMintA))))) || null;
  }
  if (!candidate) return { merged: decoded, serumFallback: null, usesSerum: false };

  const merged = Object.assign({}, decoded);
  const serumFields = ["ammId","ammAuthority","openOrders","targetOrders","marketProgram","marketId","marketBids","marketAsks","marketEventQueue","marketBaseVault","marketQuoteVault","lpMint","feeNumerator","feeDenominator","ampFactor","stable","volatile"];
  for (const k of serumFields) {
    if ((merged[k] === null || merged[k] === undefined) && candidate[k] !== undefined) merged[k] = candidate[k];
  }

  const usesSerum = !!(merged.marketId || merged.marketBids || merged.marketAsks || merged.openOrders);
  return { merged, serumFallback: candidate, usesSerum };
}

// --- Protocol decoders ---
function decodeRaydiumAMM(buf) { /* same as before */ return null; }
function decodeOrcaAMM(buf) { /* same as before */ return null; }
function decodeMeteoraAMM(buf) { /* same as before */ return null; }

async function heuristicPoolDecoder(accPubkey, buf) { /* same as before */ return null; }

// ------------------------ Main scanning function ------------------------
export async function scanPools(poolAccounts, opts = {}) {
  // poolAccounts = array of known pool PubKeys (since no getProgramAccounts)
  const out = [];
  if (!poolAccounts || !Array.isArray(poolAccounts)) return out;

  const minVaultBalance = opts.minVaultBalance || 1;
  const batch = 20;

  for (let i = 0; i < poolAccounts.length; i += batch) {
    const slice = poolAccounts.slice(i, i + batch);
    const results = await Promise.all(slice.map(async accPub => {
      try {
        const full = await rpcQueue.add(() => conn.getAccountInfo(new PublicKey(accPub)).catch(() => null));
        if (!full || !full.data) return null;
        const buf = full.data;

        let decoded = decodeRaydiumAMM(buf) || decodeOrcaAMM(buf) || decodeMeteoraAMM(buf);
        if (decoded) {
          const amountA = await getTokenAmountFromAccount(decoded.vaultA).catch(() => 0);
          const amountB = await getTokenAmountFromAccount(decoded.vaultB).catch(() => 0);
          if ((amountA + amountB) < minVaultBalance) return null;
          const initial = Object.assign({}, decoded, { pool: accPub, ammId: accPub, amountA, amountB });
          const { merged, serumFallback, usesSerum } = applyJsonFallback(accPub, initial);
          const base = Object.assign({}, merged, { serumFallback, usesSerum });
          out.push(makePoolOutput(base));
          return null;
        }

        const heur = await heuristicPoolDecoder(accPub, buf);
        if (!heur) return null;
        if ((heur.amountA + heur.amountB) < minVaultBalance) return null;
        out.push(makePoolOutput(Object.assign({}, heur, { pool: accPub, ammId: accPub })));
        return null;

      } catch { return null; }
    }));
  }

  return out;
}

export async function scanAllPools(poolAccountsByProgram = {}, opts = {}) {
  return {
    raydium: await scanPools(poolAccountsByProgram.raydium || [], opts),
    orca: await scanPools(poolAccountsByProgram.orca || [], opts),
    meteora: await scanPools(poolAccountsByProgram.meteora || [], opts)
  };
}

export default {
  PROGRAMS,
  scanPools,
  scanAllPools
};
