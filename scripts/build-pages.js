import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "dist");

const files = [
  "404.html",
  "_redirects",
  "admin.html",
  "app.html",
  "app.js",
  "calculations.js",
  "faq.html",
  "index.html",
  "privacy.html",
  "styles.css",
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.copyFileSync(src, dest);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  copyRecursive(path.join(root, file), path.join(outDir, file));
}
copyRecursive(path.join(root, "assets"), path.join(outDir, "assets"));

const apiUrl = process.env.LENDPILE_API_URL || process.env.ADMIN_API_URL || "";
const neonAuthUrl = process.env.NEON_AUTH_URL || "";
const adminApiUrl = process.env.ADMIN_API_URL || "";
const extra = adminApiUrl ? `window.ADMIN_API_URL = ${JSON.stringify(adminApiUrl)};\n` : "";
const config = `/**
 * Generated at build time from environment variables. Do not commit.
 */
window.LENDPILE_API_URL = ${JSON.stringify(apiUrl)};
window.NEON_AUTH_URL = ${JSON.stringify(neonAuthUrl)};
${extra}`;

fs.writeFileSync(path.join(outDir, "config.js"), config, "utf8");
console.log("Built Cloudflare Pages output in dist/");
