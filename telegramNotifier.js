// telegramNotifier.js
import fetch from "node-fetch";
import PQueue from "p-queue";
import { scanPools } from "./unified_pool_registry.js";
import dotenv from "dotenv";
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6, concurrency: 3 });

// send message via Telegram
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  return rpcQueue.add(async () => {
    try {
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: msg,
            parse_mode: "Markdown",
          }),
        }
      );
    } catch (err) {
      console.error("Telegram send error:", err.message || err);
    }
  });
}

// main polling loop
export async function watchPools(intervalMs = 30000) {
  let lastSnapshot = new Set();

  while (true) {
    try {
      const data = await scanPools();
      const newPools = data.pools
        .filter(p => !lastSnapshot.has(p.address))
        .map(p => p.address);

      if (newPools.length) {
        for (const addr of newPools) {
          const pool = data.pools.find(p => p.address === addr);
          const msg = `🟢 New Pool Detected\n` +
                      `Pool: ${pool.address}\n` +
                      `MintA: ${pool.mintA}\nMintB: ${pool.mintB}\n` +
                      `Reserves: ${pool.reserveA} / ${pool.reserveB}\n` +
                      `PriceSOL: ${pool.priceSOL ?? "N/A"}\nPriceUSD: ${pool.priceUSD ?? "N/A"}`;
          await sendTelegram(msg);
        }
        newPools.forEach(addr => lastSnapshot.add(addr));
      }
    } catch (err) {
      console.error("Pool watch error:", err.stack || err.message || err);
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
}

// To run standalone
if (require.main === module) {
  watchPools(30000); // polls every 30s
}