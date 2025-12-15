import { testNewRaydiumLP } from "./newRaydiumToken.js";

(async () => {
  const pools = await testNewRaydiumLP(10000); // listen for 10 seconds
  console.log("Detected LPs:", pools);
})();