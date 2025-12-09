// testprice.js
// Run: node testprice.js <mintAddress>

import { Connection, clusterApiUrl, PublicKey } from "@solana/web3.js";
import { scanMintFast } from "./priceScanner.js"; // ✅ FIXED: correct filename

async function main() {
  const mint = process.argv[2];

  if (!mint) {
    console.error("❌ Usage: node testprice.js <mint-address>");
    process.exit(1);
  }

  console.log("🔍 Testing price scanner for mint:", mint);

  const RPC = process.env.RPC || clusterApiUrl("mainnet-beta");
  const connection = new Connection(RPC, "confirmed");

  try {
    const result = await scanMintFast(connection, new PublicKey(mint), {
      includeCLMM: true,
      includeDLMM: true,
      includeCPMM: true,
      verbose: true
    });

    console.log("\n====== RESULT ======");
    console.log(JSON.stringify(result, null, 2));
    console.log("====================\n");

    if (result?.price) {
      console.log("✅ PRICE:", result.price);
    } else {
      console.log("⚠️ No price returned.");
    }
  } catch (err) {
    console.error("\n❌ ERROR in price scan:");
    console.error(err.message || err);
  }
}

main();