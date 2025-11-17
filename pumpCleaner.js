// pumpCleaner.js
// ---------------------------------------------------------
// - Removes stale tokens (<70% after 72h)
// - Tracks tokens >= 90% in potential_migrators.json
// - Alerts on first-time >= 90% and at 100%
// - Removes tokens 48h after 100%
// - Checks creator safety BEFORE entering migrators
// - Runs every 30 seconds
// ---------------------------------------------------------

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
const REMOVE_BELOW_70_AFTER_MS = 72 * 60 * 60 * 1000; // 72h
const REMOVE_100_AFTER_MS = 48 * 60 * 60 * 1000; // 48h
const MIGRATION_READY_PCT = 90;

// ---------------------------------------------------------
// Telegram sender
// ---------------------------------------------------------
async function sendTelegram(message) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  try {
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );
  } catch (err) {
    console.error("❌ Telegram error:", err.message);
  }
}

// ---------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------
function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`⚠️ Failed to parse ${file}, loading fallback.`, err.message);
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------
// Main logic
// ---------------------------------------------------------
async function pumpCleaner() {
  const allMints = loadJSON(MINT_FILE, []);
  if (!Array.isArray(allMints) || allMints.length === 0) return;

  const migrators = loadJSON(MIGRATORS_FILE, {});
  const keptMints = [];
  const now = Date.now();

  for (const mintAddress of allMints) {
    try {
      // Proper PumpFun API
      const res = await fetch(`https://frontend-api.pump.fun/mint/${mintAddress}`);
      const data = await res.json();

      const progress = Number(data?.progress || 0);
      const createdTs = Number(data?.created_timestamp || 0);
      const ageMs = createdTs ? now - createdTs : 0;

      // -----------------------------------------------------
      // REMOVE TOKENS <70% PROGRESS AFTER 72 HOURS
      // -----------------------------------------------------
      if (progress < 70) {
        if (createdTs && ageMs >= REMOVE_BELOW_70_AFTER_MS) {
          console.log(`🗑️ Removing stale token ${mintAddress}`);

          await sendTelegram(
            `🗑️ *Removed stale token*\n` +
            `Mint: \`${mintAddress}\`\n` +
            `Progress: *${progress}%*\n` +
            `Age: ${(ageMs / 36e5).toFixed(1)}h`
          );

          if (migrators[mintAddress]) delete migrators[mintAddress];
          continue;
        }

        keptMints.push(mintAddress);
        continue;
      }

      // Keep tokens >=70%
      keptMints.push(mintAddress);

      // -----------------------------------------------------
      // FIRST TIME TOKEN HITS >=90% → ADD TO MIGRATORS
      // -----------------------------------------------------
      if (progress >= MIGRATION_READY_PCT) {
        if (!migrators[mintAddress]) {
          
          // RUN CREATOR SAFETY CHECK
          const result = await verifyCreatorSafety(mintAddress);

          if (!result.safe) {
            console.log(`❌ UNSAFE CREATOR — BLOCKED ${mintAddress}`);

            await sendTelegram(
              `⚠️ *UNSAFE TOKEN BLOCKED*\n` +
              `⛔ Mint: \`${mintAddress}\`\n` +
              `Score: *${result.score}*\n` +
              `Reasons:\n${result.reasons.map(r => "• " + r).join("\n")}`
            );

            continue;
          }

          // SAFE → ADD TOKEN
          migrators[mintAddress] = {
            addedAt: now,
            lastSeen100: null,
          };

          console.log(`📥 Added safe token to migrators: ${mintAddress}`);

          await sendTelegram(
            `🚨 *SAFE TOKEN ≥ 90%*\n` +
            `Mint: \`${mintAddress}\`\n` +
            `Progress: *${progress}%*`
          );
        }
      }

      // -----------------------------------------------------
      // WHEN TOKEN REACHES 100% FIRST TIME
      // -----------------------------------------------------
      if (progress === 100) {
        if (!migrators[mintAddress]?.lastSeen100) {
          migrators[mintAddress] = {
            ...(migrators[mintAddress] || { addedAt: now }),
            lastSeen100: now,
          };

          console.log(`🚀 Token reached 100%: ${mintAddress}`);

          await sendTelegram(
            `🔥 *TOKEN MIGRATED — 100%*\n` +
            `Mint: \`${mintAddress}\``
          );
        }
      }

      // -----------------------------------------------------
      // REMOVE TOKEN 48 HOURS AFTER 100%
      // -----------------------------------------------------
      if (migrators[mintAddress]?.lastSeen100) {
        const since100 = now - migrators[mintAddress].lastSeen100;

        if (since100 >= REMOVE_100_AFTER_MS) {
          console.log(`🧹 Removing token (48h past 100%): ${mintAddress}`);
          delete migrators[mintAddress];
        }
      }

    } catch (err) {
      console.warn(`⚠️ Error processing ${mintAddress}:`, err.message);
      keptMints.push(mintAddress);
    }
  }

  saveJSON(MINT_FILE, keptMints);
  saveJSON(MIGRATORS_FILE, migrators);

  console.log(
    `✅ pumpCleaner: ${keptMints.length} active mints, ${Object.keys(migrators).length} migrators`
  );
}

// Run every 30 seconds
setInterval(pumpCleaner, CHECK_INTERVAL);
console.log("✅ pumpCleaner.js running (30s interval)");