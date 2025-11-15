// pumpCleaner.js
// - Removes stale tokens (<70% after 72h)
// - Tracks tokens >=90% in potential_migrators.json
// - Alerts on first-time >=90% and at 100%
// - Removes from potential_migrators.json 48h after 100%
// - Checks creator safety BEFORE entering migrators
// - Runs every 30 seconds

import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

import { verifyCreatorSafety } from "./tokenCreatorScanner.js";

// ======================== FILES =========================
const MINT_FILE = "./pumpfun_mints.json";
const MIGRATORS_FILE = "./potential_migrators.json";

// ===================== CONFIG PARAMS =====================
const CHECK_INTERVAL = 30 * 1000;
const REMOVE_BELOW_70_AFTER_MS = 72 * 60 * 60 * 1000;
const REMOVE_100_AFTER_MS = 48 * 60 * 60 * 1000;
const MIGRATION_READY_PCT = 90;

// =========================================================
// Telegram helper
// =========================================================
async function sendTelegram(message) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("❌ Telegram failed:", err.message);
  }
}

// =========================================================
// JSON helpers
// =========================================================
function loadJSON(file, defaultVal) {
  if (!fs.existsSync(file)) return defaultVal;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`⚠️ Failed to parse ${file}, using default.`, e.message);
    return defaultVal;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// =========================================================
// Main logic
// =========================================================
async function pumpCleaner() {
  const allMints = loadJSON(MINT_FILE, []);
  if (!Array.isArray(allMints) || allMints.length === 0) return;

  const migrators = loadJSON(MIGRATORS_FILE, {});
  const keptMints = [];

  for (const mintAddress of allMints) {
    try {
      // ⭐ Correct Pump.fun mint endpoint
      const res = await fetch(`https://frontend-api.pump.fun/mint/${mintAddress}`);
      const data = await res.json();

      // ⭐ Correct progress field
      const progress = Number(data?.progress || 0);

      // Timestamp is already in milliseconds
      const createdTs = Number(data?.created_timestamp || 0);
      const now = Date.now();
      const ageMs = createdTs ? now - createdTs : 0;

      // -------------------------------------------------------
      // REMOVE <70% AFTER 72 HOURS
      // -------------------------------------------------------
      if (progress < 70) {
        if (createdTs && ageMs >= REMOVE_BELOW_70_AFTER_MS) {
          console.log(`🗑️ Removing stale token ${mintAddress} (<70% & >72h)`);

          await sendTelegram(
            `🗑️ Removed stale token:\n\`${mintAddress}\`\nProgress: ${progress}%\nAge: ${(ageMs / 36e5).toFixed(1)}h`
          );

          if (migrators[mintAddress]) delete migrators[mintAddress];

          continue;
        } else {
          keptMints.push(mintAddress);
          continue;
        }
      }

      keptMints.push(mintAddress);

      // -------------------------------------------------------
      // ADD TO MIGRATORS IF >= 90% (FIRST TIME)
      // -------------------------------------------------------
      if (progress >= MIGRATION_READY_PCT) {
        if (!migrators[mintAddress]) {
          // ⭐ SECURITY CHECK BEFORE ADDING
          const isSafe = await verifyCreatorSafety(mintAddress);

          if (!isSafe) {
            console.log(`❌ UNSAFE CREATOR — BLOCKED: ${mintAddress}`);

            await sendTelegram(
              `⚠️ *UNSAFE TOKEN BLOCKED*\n⛔ Mint: \`${mintAddress}\`\nCreator failed security check.`
            );

            continue;
          }

          migrators[mintAddress] = {
            addedAt: now,
            lastSeen100: null,
          };

          console.log(`📥 SAFE token added to migrators: ${mintAddress}`);

          await sendTelegram(
            `🚨 *SAFE TOKEN ≥ 90%*\nMint: \`${mintAddress}\`\nProgress: *${progress}%*`
          );
        }
      }

      // -------------------------------------------------------
      // FIRST TIME REACHING 100%
      // -------------------------------------------------------
      if (progress === 100) {
        if (!migrators[mintAddress]?.lastSeen100) {
          migrators[mintAddress] = {
            ...(migrators[mintAddress] || { addedAt: now }),
            lastSeen100: now,
          };

          await sendTelegram(
            `🔥 *TOKEN MIGRATED — 100%*\nMint: \`${mintAddress}\``
          );

          console.log(`🚀 Sent 100% alert for: ${mintAddress}`);
        }
      }

      // -------------------------------------------------------
      // REMOVE FROM MIGRATORS 48 HOURS AFTER 100%
      // -------------------------------------------------------
      if (migrators[mintAddress]?.lastSeen100) {
        const since100 = now - migrators[mintAddress].lastSeen100;

        if (since100 >= REMOVE_100_AFTER_MS) {
          console.log(`🧹 Removing ${mintAddress} (48h past 100%)`);
          delete migrators[mintAddress];
        }
      }

    } catch (err) {
      console.warn(`⚠️ Error fetching mint ${mintAddress}:`, err.message);
      keptMints.push(mintAddress);
    }
  }

  saveJSON(MINT_FILE, keptMints);
  saveJSON(MIGRATORS_FILE, migrators);

  console.log(
    `✅ pumpCleaner: ${keptMints.length} active mints, ${Object.keys(migrators).length} migrators`
  );
}

setInterval(pumpCleaner, CHECK_INTERVAL);

console.log("✅ pumpCleaner.js running (30s interval)");