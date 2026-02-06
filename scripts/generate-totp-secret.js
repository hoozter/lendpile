#!/usr/bin/env node
/**
 * Generate a base32 TOTP secret for ADMIN_TOTP_SECRET.
 * Run: node scripts/generate-totp-secret.js
 * Add the output to your authenticator app and to the Worker secret ADMIN_TOTP_SECRET.
 */
const crypto = require("crypto");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const bytes = crypto.randomBytes(20);
let bits = 0;
let value = 0;
let out = "";
for (let i = 0; i < bytes.length; i++) {
  value = (value << 8) | bytes[i];
  bits += 8;
  while (bits >= 5) {
    bits -= 5;
    out += ALPHABET[(value >>> bits) & 31];
  }
}
if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
console.log(out);
