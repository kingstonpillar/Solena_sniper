// newtoken-pump.js
// Watches Pump.fun & PumpSwap for newly created tokens

import fs from "fs";
import fetch from "node-fetch";

const PUMP_FUN_API = "https://frontend-api.pump.fun/coins/latest";
const PUMPSWAP_API = "https://pumpswap.xyz/api/tokens";
const SAVE_FILE = "./pumpfun_mints.json";

let pumpFunMints = new Set();

// Load previous mints if file exists
if (fs.existsSync(SAVE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    pumpFunMints = new Set(loaded);
  } catch (e) {
    console.error("⚠️ Failed to load local mint list");
  }
}

function saveMints() {
  fs.writeFileSync(SAVE_FILE, JSON.stringify([...pumpFunMints], null, 2));
  console.log(`💾 Saved ${pumpFunMints.size} mints to ${SAVE_FILE}`);
}

async function fetchPumpFun() {
  try {
    const res = await fetch(PUMP_FUN_API);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error("Pump.fun fetch error: Invalid JSON", err.message);
      return; // prevent crash
    }

    let added = false;

    for (const token of data.coins || []) {
      if (!pumpFunMints.has(token.mint)) {
        pumpFunMints.add(token.mint);
        console.log(`🆕 Pump.fun: ${token.name} (${token.symbol})`);
        added = true;
      }
    }

    if (added) saveMints();

  } catch (err) {
    console.error("Pump.fun fetch error:", err.message);
  }
}

async function fetchPumpSwap() {
  try {
    const res = await fetch(PUMPSWAP_API);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error("PumpSwap fetch error: Invalid JSON", err.message);
      return; // prevent crash
    }

    let added = false;

    for (const token of data.tokens || []) {
      if (!pumpFunMints.has(token.mint)) {
        pumpFunMints.add(token.mint);
        console.log(`🆕 PumpSwap: ${token.name}`);
        added = true;
      }
    }

    if (added) saveMints();

  } catch (err) {
    console.error("PumpSwap fetch error:", err.message);
  }
}

async function startWatcher() {
  console.log("🔍 Starting Pump.fun + PumpSwap watcher...");

  await fetchPumpFun();
  await fetchPumpSwap();

  setInterval(fetchPumpFun, 10000);   // every 10s
  setInterval(fetchPumpSwap, 20000);  // every 20s
}

startWatcher();