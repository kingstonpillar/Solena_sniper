import { verifyCreatorSafety } from "./tokenCreatorScanner.js";

(async () => {
  const mint = "So11111111111111111111111111111111111111112";
  const result = await verifyCreatorSafety(mint);
  console.log(JSON.stringify(result, null, 2));
})();