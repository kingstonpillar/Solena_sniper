// testTokenSecurities.js
import { verifyTokenSecurity } from "./tokensecurities.js";

(async () => {
  console.log("Starting Token Securities Test...");

  try {
    // Replace with any mint you want to test
    const testMint = "So11111111111111111111111111111111111111112"; // Wrapped SOL

    const result = await verifyTokenSecurity(testMint);

    console.log("Token Security Result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Test Error:", err?.message || err);
  }
})();