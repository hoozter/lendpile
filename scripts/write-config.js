/**
 * Build script for Cloudflare Pages (or any CI).
 * Reads SUPABASE_URL and SUPABASE_ANON_KEY from environment variables
 * and writes config.js so the app can connect to Supabase.
 * In Cloudflare Pages: set these as Environment variables, and use build command: node scripts/write-config.js
 */
const fs = require("fs");
const path = require("path");

const url = process.env.SUPABASE_URL || "";
const key = process.env.SUPABASE_ANON_KEY || "";
const deleteAccountUrl = process.env.DELETE_ACCOUNT_URL || "";
const adminApiUrl = process.env.ADMIN_API_URL || "";

const out = path.join(__dirname, "..", "config.js");
const extra = [
  deleteAccountUrl ? `window.DELETE_ACCOUNT_URL = ${JSON.stringify(deleteAccountUrl)};` : "",
  adminApiUrl ? `window.ADMIN_API_URL = ${JSON.stringify(adminApiUrl)};` : "",
].filter(Boolean).join("\n");
const content = `/**
 * Generated at build time from environment variables. Do not commit.
 */
window.SUPABASE_URL = ${JSON.stringify(url)};
window.SUPABASE_ANON_KEY = ${JSON.stringify(key)};
${extra ? extra + "\n" : ""}`;

fs.writeFileSync(out, content, "utf8");
console.log("Wrote config.js from SUPABASE_URL and SUPABASE_ANON_KEY");
