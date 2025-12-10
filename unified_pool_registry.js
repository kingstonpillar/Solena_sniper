// unified_pool_registry.js
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

export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  ORCA_AMM: new PublicKey("9WwRZjZJ9n7bhCrwW1EpnBH3CCuZMdAsMNSnS9nTYa5"),
  METEORA_AMM: new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"),
};

const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 6,
  concurrency: 6
});

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
    return 0;
  } catch {
    return 0;
  }
}

function makePoolOutput(base) {
  return {
    pool: base.pool || null,
    ammId: base.ammId || null,
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
    usesSerum: base.usesSerum || false
  };
}

function applyJsonFallback(poolPubkey, decoded) {
  if (!JSON_FALLBACK) return { merged: decoded, usesSerum: false };
  const candidate = JSON_FALLBACK[poolPubkey] || null;
  if (!candidate) return { merged: decoded, usesSerum: false };

  const merged = { ...decoded, ...candidate };
  const usesSerum = !!(merged.marketId || merged.marketBids || merged.marketAsks || merged.openOrders);
  return { merged, usesSerum };
}

// ------------------------ Main scanning function ------------------------
export async function scanPools(poolAccounts, opts = {}) {
  const out = [];
  if (!poolAccounts || !Array.isArray(poolAccounts)) return out;

  const minVaultBalance = opts.minVaultBalance || 1;

  for (const accPub of poolAccounts) {
    try {
      const poolInfo = JSON_FALLBACK?.[accPub] || { pool: accPub };
      const amountA = await getTokenAmountFromAccount(poolInfo.vaultA).catch(() => 0);
      const amountB = await getTokenAmountFromAccount(poolInfo.vaultB).catch(() => 0);
      if ((amountA + amountB) < minVaultBalance) continue;

      const { merged, usesSerum } = applyJsonFallback(accPub, { ...poolInfo, amountA, amountB });
      out.push(makePoolOutput({ ...merged, usesSerum }));
    } catch {}
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