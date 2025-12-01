// compute_test.js
const computeUnitPerTrade = 0.01;
const solPriceUSD = 200;

const microLamports = Math.floor(computeUnitPerTrade * 1_000_000_000);
const finalFeeInSOL = microLamports / 1_000_000_000;
const feeInUSD = finalFeeInSOL * solPriceUSD;

console.log("----- COMPUTE UNIT FEE TEST -----");
console.log("Input Priority Fee (SOL):", computeUnitPerTrade);
console.log("Converted to microLamports:", microLamports);
console.log("Final Fee Charged (SOL):", finalFeeInSOL.toFixed(6));
console.log("Final Fee Charged (USD):", "$" + feeInUSD.toFixed(2));
console.log("--------------------------------");