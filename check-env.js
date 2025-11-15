import fs from "fs";

if (!fs.existsSync(".env")) {
  console.error("❌ ERROR: .env file missing! Please create it with all required keys.");
  process.exit(1);
}

console.log("✅ .env file found. Proceeding with installation...");