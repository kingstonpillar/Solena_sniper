// crash-protection.js — final version with hourly memory ping + Telegram alerts
import fs from "fs";
import path from "path";
import process from "process";
import fetch from "node-fetch"; // for Telegram messages

// === TELEGRAM CONFIG ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === LOG SETUP ===
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const LOG_FILE = path.join(LOG_DIR, "crash.log");
const COUNT_FILE = path.join(LOG_DIR, "restart-count.txt");

// === RESTART COUNT ===
let restartCount = 0;
if (fs.existsSync(COUNT_FILE)) {
  try {
    restartCount = parseInt(fs.readFileSync(COUNT_FILE, "utf8"), 10) || 0;
  } catch {
    restartCount = 0;
  }
}
restartCount++;
fs.writeFileSync(COUNT_FILE, String(restartCount), "utf8");

const startTime = Date.now();

// === HELPERS ===
function formatDuration(ms) {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / (1000 * 60)) % 60;
  const hr = Math.floor(ms / (1000 * 60 * 60));
  return `${hr}h ${min}m ${sec}s`;
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );
  } catch (err) {
    console.error("Failed to send Telegram message:", err);
  }
}

function logError(type, error) {
  const uptime = formatDuration(Date.now() - startTime);
  const entry = `[${new Date().toISOString()}] [${type}] [Uptime: ${uptime}] ${
    error?.stack || error
  }\n`;
  fs.appendFileSync(LOG_FILE, entry);
  console.error(entry);

  sendTelegram(
    `⚠️ [${type}] Bot error\n⏱️ Uptime before crash: ${uptime}\n\n${
      error?.message || error
    }`
  );
}

// === CRASH WATCHERS ===
process.on("uncaughtException", (err) => logError("UncaughtException", err));
process.on("unhandledRejection", (reason) => logError("UnhandledRejection", reason));

// === HOURLY MEMORY PING ALERT ===
setInterval(() => {
  const uptime = formatDuration(Date.now() - startTime);
  const usedMB = process.memoryUsage().rss / 1024 / 1024;

  // Telegram hourly ping
  sendTelegram(
    `⏱ Hourly ping: Bot alive\nUptime: ${uptime}\nMemory usage: ${usedMB.toFixed(
      2
    )} MB`
  );

  // Clean memory log if usage exceeds 1000MB
  if (usedMB > 1000) {
    try {
      fs.writeFileSync(LOG_FILE, ""); // clear crash log
      console.log(`🧹 Memory cleanup: cleared crash log at ${usedMB.toFixed(2)} MB`);
    } catch (err) {
      console.error("Failed to clear crash log:", err);
    }
  }
}, 60 * 60 * 1000); // hourly

// === EXPORT PROTECTION ===
export function protect() {
  console.log("✅ Crash protection with hourly memory ping enabled");
  const ts = new Date().toISOString();
  sendTelegram(
    `🚀 Polygon Arbitrage Bot started\n🕒 ${ts}\n🔄 Restart count: ${restartCount}`
  );
}