// orcaWhirlpoolUtils.js
// Minimal helper to decode Orca Whirlpool account

import * as borsh from "borsh";
import bs58 from "bs58";

// -------------------- Whirlpool Class --------------------
export class Whirlpool {
  constructor(fields = {}) {
    this.tokenMintA = fields.tokenMintA || null;
    this.tokenMintB = fields.tokenMintB || null;
    this.tokenAReserve = fields.tokenAReserve || 0n;
    this.tokenBReserve = fields.tokenBReserve || 0n;
    this.liquidity = fields.liquidity || 0n;
    this.feeRate = fields.feeRate || 0;
    this.tickSpacing = fields.tickSpacing || 0;
    this.sqrtPriceX64 = fields.sqrtPriceX64 || 0n;
    this.tickCurrentIndex = fields.tickCurrentIndex || 0;
    this.protocolFee = fields.protocolFee || 0;
  }
}

// -------------------- Borsh Schema --------------------
const WhirlpoolSchema = new Map([
  [Whirlpool, {
    kind: "struct",
    fields: [
      ["tokenMintA", [32]],
      ["tokenMintB", [32]],
      ["tokenAReserve", "u64"],
      ["tokenBReserve", "u64"],
      ["liquidity", "u128"],
      ["feeRate", "u16"],
      ["tickSpacing", "u16"],
      ["sqrtPriceX64", "u128"],
      ["tickCurrentIndex", "i32"],
      ["protocolFee", "u16"]
    ]
  }]
]);

// -------------------- Decode Whirlpool --------------------
export function decodeWhirlpool(data) {
  try {
    if (!data || data.length < 122) return null;

    const decoded = borsh.deserialize(WhirlpoolSchema, Whirlpool, data);

    // Convert mints to base58 strings
    decoded.tokenMintA = bufferToPubkey(decoded.tokenMintA);
    decoded.tokenMintB = bufferToPubkey(decoded.tokenMintB);

    // Coerce numeric fields to BigInt
    decoded.tokenAReserve = BigInt(decoded.tokenAReserve);
    decoded.tokenBReserve = BigInt(decoded.tokenBReserve);
    decoded.liquidity = BigInt(decoded.liquidity);
    decoded.sqrtPriceX64 = BigInt(decoded.sqrtPriceX64);

    // ✅ Add these two lines here
    decoded.tickCurrentIndex = BigInt(decoded.tickCurrentIndex);
    decoded.protocolFee = BigInt(decoded.protocolFee);

    return decoded;
  } catch (err) {
    console.error("Failed to decode Whirlpool:", err.message || err);
    return null;
  }
}