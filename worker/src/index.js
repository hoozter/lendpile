/**
 * Lendpile API Worker
 * - POST /delete-my-account: user deletes own account (Bearer user JWT)
 * - GET /admin/users, DELETE /admin/users/:id: admin only.
 *   Admin auth: (1) X-Admin-Key (+ optional X-Admin-TOTP when ADMIN_TOTP_SECRET set), or (2) Bearer <user JWT> with app_metadata.role === 'admin'
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-admin-key, x-admin-totp",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(str) {
  const s = String(str).replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(s[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Generate TOTP code for counter (RFC 6238). */
async function totpGenerate(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(4, counter, false);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const msg = new Uint8Array(buf);
  const sig = await crypto.subtle.sign("HMAC", key, msg);
  const arr = new Uint8Array(sig);
  const offset = arr[19] & 0x0f;
  const code = ((arr[offset] & 0x7f) << 24) | (arr[offset + 1] << 16) | (arr[offset + 2] << 8) | arr[offset + 3];
  return code % 1000000;
}

/** Verify 6-digit TOTP code; allow ±1 time step for clock skew. */
async function verifyTotp(secretBase32, codeStr) {
  const code = parseInt(String(codeStr).replace(/\D/g, "").slice(0, 6), 10);
  if (isNaN(code) || code < 0 || code > 999999) return false;
  let secretBytes;
  try {
    secretBytes = base32Decode(secretBase32);
  } catch {
    return false;
  }
  if (secretBytes.length < 10) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    const expected = await totpGenerate(secretBytes, step + d);
    if (expected === code) return true;
  }
  return false;
}

/** Check API key auth. If ADMIN_TOTP_SECRET is set, also require valid X-Admin-TOTP. */
async function adminAuthBySecret(req, env) {
  const secret = env.ADMIN_SECRET;
  if (!secret) return false;
  const key = req.headers.get("X-Admin-Key") || (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (key !== secret) return false;
  const totpSecret = env.ADMIN_TOTP_SECRET;
  if (!totpSecret) return true;
  const totpCode = req.headers.get("X-Admin-TOTP") || "";
  return await verifyTotp(totpSecret, totpCode);
}

/** Check if user from JWT is admin (app_metadata.role === 'admin'). */
async function adminAuthByUser(req, env) {
  const auth = req.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return false;
  const user = await getUserFromToken(token, env);
  if (!user) return false;
  const role = user.app_metadata?.role;
  return role === "admin";
}

/** Admin auth: secret key (+ TOTP if required) OR logged-in user with role admin. */
async function isAdmin(req, env) {
  if (await adminAuthBySecret(req, env)) return true;
  return await adminAuthByUser(req, env);
}

async function getUserFromToken(token, env) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? user : null;
}

async function deleteUserById(userId, env) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  return res;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (path === "/delete-my-account" && req.method === "POST") {
      const auth = req.headers.get("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token) {
        return json({ error: "Missing or invalid Authorization header" }, 401);
      }
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return json({ error: "Server configuration error" }, 500);
      }
      const user = await getUserFromToken(token, env);
      if (!user) {
        return json({ error: "Invalid or expired session" }, 401);
      }
      const delRes = await deleteUserById(user.id, env);
      if (!delRes.ok) {
        const err = await delRes.text();
        return json({ error: err || "Failed to delete account" }, delRes.status >= 500 ? 502 : 400);
      }
      return json({ ok: true }, 200);
    }

    if (path.startsWith("/admin/users")) {
      if (!(await isAdmin(req, env))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return json({ error: "Server configuration error" }, 500);
      }

      if (req.method === "GET") {
        const page = url.searchParams.get("page") || "1";
        const perPage = url.searchParams.get("per_page") || "50";
        const res = await fetch(
          `${env.SUPABASE_URL}/auth/v1/admin/users?page=${encodeURIComponent(page)}&per_page=${encodeURIComponent(perPage)}`,
          {
            headers: {
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            },
          }
        );
        if (!res.ok) {
          const err = await res.text();
          return json({ error: err || "Failed to list users" }, res.status >= 500 ? 502 : 400);
        }
        const data = await res.json();
        return json(data, 200);
      }

      if (req.method === "DELETE") {
        const match = path.match(/^\/admin\/users\/([^/]+)$/);
        const userId = match ? match[1] : null;
        if (!userId) {
          return json({ error: "Missing user id" }, 400);
        }
        const delRes = await deleteUserById(userId, env);
        if (!delRes.ok) {
          const err = await delRes.text();
          return json({ error: err || "Failed to delete user" }, delRes.status >= 500 ? 502 : 400);
        }
        return json({ ok: true }, 200);
      }

      return json({ error: "Method not allowed" }, 405);
    }

    return json({ error: "Not found" }, 404);
  },
};
