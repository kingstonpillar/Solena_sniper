// sellmonitor.js
// Tracks active positions + compounding + PM2 auto-stop when max rounds reached

import fs from "fs";
import dotenv from "dotenv";
import { exec } from "child_process";
import fetch from "node-fetch";

dotenv.config();

// ================================
// FILES
// ================================
const ACTIVE_FILE = "./active_positions.json";
const COUNTER_FILE = "./_compound_counter.json";

// ================================
// ENV CONFIG
// ================================
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || "20");
const MAX_COMPOUNDING_CYCLES = parseInt(process.env.MAX_COMPOUNDING_CYCLES || "3");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BOT_PROCESS_NAME = process.env.BOT_PROCESS_NAME || "auto-trader";

// ================================
// Compounding counter (persistent)
// ================================
function loadCounter() {
  if (fs.existsSync(COUNTER_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8")).count || 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function saveCounter(count) {
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ count }, null, 2));
}

let compoundingCount = loadCounter();

/**
 * =========================================
 * 📩 Telegram alert helper
 * =========================================
 */
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("⚠️ Telegram send failed:", err.message);
  }
}

/**
 * =========================================
 * 📈 Register new active position on BUY
 * =========================================
 */
export function markSellStart(mintAddress, buyPrice = 0) {
  let active = [];

  try {
    if (fs.existsSync(ACTIVE_FILE)) {
      active = JSON.parse(fs.readFileSync(ACTIVE_FILE, "utf8"));
    }
  } catch {
    active = [];
  }

  if (!active.find((t) => t.mintAddress === mintAddress)) {
    if (active.length >= MAX_ENTRIES) {
      console.warn(`⚠️ Max active limit (${MAX_ENTRIES}) reached → removing oldest entry.`);
      active.shift();
    }

    active.push({
      mintAddress,
      buyPrice,
      status: "active",
      timestamp: Date.now(),
    });

    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(active, null, 2));
    console.log(`📈 Added new active position: ${mintAddress}`);
  }
}

/**
 * =========================================
 * 💸 Mark token as SOLD
 * =========================================
 */
export function markSellComplete(mintAddress) {
  if (!fs.existsSync(ACTIVE_FILE)) return;

  let active;
  try {
    active = JSON.parse(fs.readFileSync(ACTIVE_FILE, "utf8"));
  } catch {
    return;
  }

  const index = active.findIndex((t) => t.mintAddress === mintAddress);
  if (index !== -1) {
    active[index].status = "sold";
    active[index].soldAt = Date.now();
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(active, null, 2));
    console.log(`💸 Marked SOLD: ${mintAddress}`);
  }
}

/**
 * =========================================
 * 🔁 Check if all sells are complete
 * Trigger compounding & PM2 auto-stop
 * =========================================
 */
export async function allSellsComplete() {
  if (!fs.existsSync(ACTIVE_FILE)) return true;

  let active;
  try {
    active = JSON.parse(fs.readFileSync(ACTIVE_FILE, "utf8"));
  } catch {
    return true;
  }

  if (active.length === 0) return true;

  const allSold = active.every((t) => t.status === "sold");
  if (!allSold) return false;

  // Clear positions
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify([], null, 2));

  // Increment compounding count
  compoundingCount++;
  saveCounter(compoundingCount);

  console.log(`✅ Compounding Round ${compoundingCount}/${MAX_COMPOUNDING_CYCLES}`);
  await sendTelegram(`✅ *Compounding Round ${compoundingCount}/${MAX_COMPOUNDING_CYCLES} Completed*`);

  // ================================
  // 🛑 Stop bot if max cycles reached
  // ================================
  if (compoundingCount >= MAX_COMPOUNDING_CYCLES) {
    console.log("🛑 Maximum compounding cycles reached. Stopping bot via PM2...");
    await sendTelegram("🛑 *All compounding cycles complete — bot stopping automatically!*");

    exec(`pm2 stop ${BOT_PROCESS_NAME}`, (err) => {
      if (err) {
        console.error("⚠️ PM2 stop failed:", err.message);
      } else {
        console.log(`✅ PM2 process '${BOT_PROCESS_NAME}' stopped successfully.`);
      }
    });
  }

  return true;
}