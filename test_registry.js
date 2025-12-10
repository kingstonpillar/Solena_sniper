import { scanAllPools } from "./unified_pool_registry.js";

async function testAllPools() {
  const pools = await scanAllPools({
    raydium: ["H8Jd92NnmXMAk9j7DEaPMEwaSKWu5ctFPb3nB4E6SoLH"],
    orca: ["8D7R7y7bE2eA4xWPNw3wPpQvH8C7Kk6fw8HkP5VL6ZsY"]
  });

  console.log("RAYDIUM Pools:", pools.raydium);
  console.log("ORCA Pools:", pools.orca);
}

testAllPools();