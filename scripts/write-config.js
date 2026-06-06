/**
 * Build script for Cloudflare Pages (or any CI).
 * Reads LENDPILE_API_URL and NEON_AUTH_URL from environment variables
 * and writes config.js. Do not expose NEON_DATABASE_URL here.
 * In Cloudflare Pages: run npm install/npm ci, then node scripts/write-config.js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiUrl = process.env.LENDPILE_API_URL || process.env.ADMIN_API_URL || "";
const neonAuthUrl = process.env.NEON_AUTH_URL || "";
const adminApiUrl = process.env.ADMIN_API_URL || "";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, "..", "config.js");
const extra = [
  adminApiUrl ? `window.ADMIN_API_URL = ${JSON.stringify(adminApiUrl)};` : "",
].filter(Boolean).join("\n");
const content = `/**
 * Generated at build time from environment variables. Do not commit.
 */
window.LENDPILE_API_URL = ${JSON.stringify(apiUrl)};
window.NEON_AUTH_URL = ${JSON.stringify(neonAuthUrl)};
${extra ? extra + "\n" : ""}`;

fs.writeFileSync(out, content, "utf8");
console.log("Wrote config.js from LENDPILE_API_URL and NEON_AUTH_URL");
