// testNewRaydiumLP.js
import { testNewRaydiumLPDetection } from "./newRaydiumToken.js";

(async () => {
  console.log("🟢 Starting test for new Raydium LP detection...");
  
  const newLPs = await testNewRaydiumLPDetection(10000); // run WS for 10 seconds

  console.log("🟢 Test complete.");
  console.log("Detected new LPs:", newLPs);
})();