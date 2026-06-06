/**
 * Lendpile API Worker – Neon Auth + Neon Postgres.
 *
 * Required secrets:
 *   NEON_DATABASE_URL
 *   NEON_AUTH_URL
 *   NEON_AUTH_JWKS_URL
 * Optional:
 *   LENDPILE_ADMIN_EMAILS, ADMIN_SECRET, ADMIN_TOTP_SECRET
 */

import { neon } from "@neondatabase/serverless";

const AUTH_COOKIE_NAME = "__Secure-neon-auth.session_token";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const jwksCache = { keys: null, expiresAt: 0 };
let sql;

function corsHeaders(origin) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key, X-Admin-TOTP",
    "Cache-Control": "no-store, no-cache",
  };
}

function json(body, status = 200, origin = null, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), ...extraHeaders } });
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

function base64urlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(value)));
}

async function getJwks(env) {
  if (jwksCache.keys && Date.now() < jwksCache.expiresAt) return jwksCache.keys;
  const jwksUrl = env.NEON_AUTH_JWKS_URL || `${env.NEON_AUTH_URL.replace(/\/$/, "")}/.well-known/jwks.json`;
  const response = await fetch(jwksUrl);
  if (!response.ok) throw new Error("Failed to load Neon Auth JWKS");
  const body = await response.json();
  jwksCache.keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.expiresAt = Date.now() + 10 * 60 * 1000;
  return jwksCache.keys;
}

async function verifyNeonJwt(token, env) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (!payload.sub || (payload.exp && Math.floor(Date.now() / 1000) > payload.exp)) return null;
  const jwk = (await getJwks(env)).find(key => key.kid === header.kid);
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    base64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  return valid ? payload : null;
}

function getBearerToken(req) {
  const auth = req.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

async function getUser(req, env) {
  const payload = await verifyNeonJwt(getBearerToken(req), env);
  if (!payload) return null;
  return { id: payload.sub, email: payload.email || null, name: payload.name || null };
}

function base32Decode(str) {
  const s = String(str).replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of s) {
    const idx = BASE32_ALPHABET.indexOf(char);
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

async function totpGenerate(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, counter, false);
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(buf)));
  const offset = sig[19] & 0x0f;
  const code = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
  return code % 1000000;
}

async function verifyTotp(secretBase32, codeStr) {
  const code = parseInt(String(codeStr).replace(/\D/g, "").slice(0, 6), 10);
  if (Number.isNaN(code)) return false;
  const secretBytes = base32Decode(secretBase32);
  if (secretBytes.length < 10) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let delta = -1; delta <= 1; delta++) {
    if (await totpGenerate(secretBytes, step + delta) === code) return true;
  }
  return false;
}

async function adminAuthBySecret(req, env) {
  if (!env.ADMIN_SECRET) return false;
  const key = req.headers.get("X-Admin-Key") || "";
  if (key !== env.ADMIN_SECRET) return false;
  if (!env.ADMIN_TOTP_SECRET) return true;
  return verifyTotp(env.ADMIN_TOTP_SECRET, req.headers.get("X-Admin-TOTP") || "");
}

function configuredAdminEmails(env) {
  return String(env.LENDPILE_ADMIN_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

async function isAdmin(user, env) {
  if (!user) return false;
  if (user.email && configuredAdminEmails(env).includes(user.email.toLowerCase())) {
    await sql`INSERT INTO admin_users (user_id) VALUES (${user.id}) ON CONFLICT (user_id) DO NOTHING`;
    return true;
  }
  const activeAdmins = await sql`
    SELECT au.user_id
    FROM admin_users au
    JOIN neon_auth."user" u ON u.id::text = au.user_id
    LIMIT 1
  `;
  if (activeAdmins.length === 0) {
    const firstUsers = await sql`SELECT id::text AS id FROM neon_auth."user" ORDER BY "createdAt" ASC, id ASC LIMIT 1`;
    if (firstUsers[0]?.id === user.id) {
      await sql`INSERT INTO admin_users (user_id) VALUES (${user.id}) ON CONFLICT (user_id) DO NOTHING`;
      return true;
    }
  }
  const rows = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
  return rows.length > 0;
}

function mergeLoanArrays(currentData, legacyData) {
  const merged = [];
  const seen = new Set();
  for (const loan of [...(Array.isArray(currentData) ? currentData : []), ...(Array.isArray(legacyData) ? legacyData : [])]) {
    const id = loan && loan.id ? String(loan.id) : "";
    const key = id || JSON.stringify(loan);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(loan);
  }
  return merged;
}

async function claimLegacyDataForUser(user) {
  if (!user?.id || !user?.email) return;
  const maps = await sql`
    SELECT old_user_id, email
    FROM legacy_user_map
    WHERE lower(email) = lower(${user.email})
      AND (claimed_user_id IS NULL OR claimed_user_id = ${user.id})
  `;
  for (const map of maps) {
    const oldUserId = map.old_user_id;
    if (!oldUserId || oldUserId === user.id) {
      await sql`
        UPDATE legacy_user_map
        SET claimed_user_id = ${user.id}, claimed_at = COALESCE(claimed_at, NOW())
        WHERE old_user_id = ${oldUserId}
      `;
      continue;
    }

    const legacyRows = await sql`SELECT data FROM loan_data WHERE user_id = ${oldUserId}`;
    const legacyData = legacyRows[0]?.data || [];
    const currentRows = await sql`SELECT data FROM loan_data WHERE user_id = ${user.id}`;
    const currentData = currentRows[0]?.data || [];
    const mergedData = mergeLoanArrays(currentData, legacyData);

    await sql`
      INSERT INTO loan_data (user_id, data, updated_at)
      VALUES (${user.id}, ${JSON.stringify(mergedData)}::jsonb, NOW())
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `;
    await sql`DELETE FROM loan_data WHERE user_id = ${oldUserId}`;
    await sql`UPDATE loan_shares SET owner_id = ${user.id} WHERE owner_id = ${oldUserId}`;
    await sql`UPDATE loan_shares SET recipient_id = ${user.id} WHERE recipient_id = ${oldUserId}`;
    await sql`UPDATE loan_shares SET edit_requested_by = ${user.id} WHERE edit_requested_by = ${oldUserId}`;
    await sql`
      INSERT INTO admin_users (user_id)
      SELECT ${user.id}
      WHERE EXISTS (SELECT 1 FROM admin_users WHERE user_id = ${oldUserId})
      ON CONFLICT (user_id) DO NOTHING
    `;
    await sql`DELETE FROM admin_users WHERE user_id = ${oldUserId}`;
    await sql`
      INSERT INTO profiles (user_id, email, updated_at)
      VALUES (${user.id}, ${user.email}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at
    `;
    await sql`DELETE FROM profiles WHERE user_id = ${oldUserId}`;
    await sql`
      UPDATE legacy_user_map
      SET claimed_user_id = ${user.id}, claimed_at = NOW()
      WHERE old_user_id = ${oldUserId}
    `;
  }
}

async function requireAdmin(req, env) {
  if (await adminAuthBySecret(req, env)) return { admin: true, user: null };
  const user = await getUser(req, env);
  if (await isAdmin(user, env)) return { admin: true, user };
  return { admin: false, user };
}

function publicShare(row) {
  if (!row) return null;
  return {
    id: row.id,
    token: row.token,
    owner_id: row.owner_id,
    loan_id: row.loan_id,
    loan_snapshot: row.loan_snapshot,
    permission: row.permission,
    recipient_view: row.recipient_view,
    owner_display_name: row.owner_display_name,
    expires_at: row.expires_at,
    used_at: row.used_at,
    recipient_id: row.recipient_id,
    recipient_email: row.recipient_email,
    recipient_display_name: row.recipient_display_name,
    transfer_requested_at: row.transfer_requested_at,
    edit_requested_at: row.edit_requested_at,
    edit_requested_by: row.edit_requested_by,
    edit_request_resolved_at: row.edit_request_resolved_at,
    edit_request_outcome: row.edit_request_outcome,
    recipient_seen_resolution_at: row.recipient_seen_resolution_at,
    created_at: row.created_at,
  };
}

async function validShareByToken(token, userId = null) {
  const rows = await sql`SELECT * FROM loan_shares WHERE token = ${token} AND expires_at > NOW()`;
  const row = rows[0];
  if (!row) return null;
  if (row.used_at && row.recipient_id !== userId) return null;
  return row;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "*";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    try {
      if (!sql) sql = neon(env.NEON_DATABASE_URL);
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/$/, "") || "/";

      if (path === "/" || path === "/health") {
        return json({ ok: true, service: "lendpile-api", provider: "neon", auth: "neon-auth" }, 200, origin);
      }
      if (path === "/debug-env") {
        return json({
          provider: "neon",
          auth: "neon-auth",
          hasDatabaseUrl: !!env.NEON_DATABASE_URL,
          hasAuthUrl: !!env.NEON_AUTH_URL,
          hasAuthJwksUrl: !!env.NEON_AUTH_JWKS_URL,
        }, 200, origin);
      }

      const previewMatch = path.match(/^\/shares\/preview\/([^/]+)$/);
      if (previewMatch && req.method === "GET") {
        const token = decodeURIComponent(previewMatch[1]);
        const rows = await sql`
          SELECT owner_display_name, loan_snapshot
          FROM loan_shares
          WHERE token = ${token} AND expires_at > NOW()
        `;
        const row = rows[0];
        return json({ preview: row ? { owner_display_name: row.owner_display_name, loan_name: row.loan_snapshot?.name || null } : null }, 200, origin);
      }

      const user = await getUser(req, env);
      const adminRoute = path === "/admin/me" || path.startsWith("/admin/users");
      if (!user && !adminRoute) return json({ error: "Unauthorized" }, 401, origin);
      if (user) await claimLegacyDataForUser(user);

      if (path === "/admin/me" && req.method === "GET") {
        return json({ admin: await isAdmin(user, env) }, 200, origin);
      }

      if (path === "/profile") {
        if (req.method === "GET") {
          const rows = await sql`SELECT display_name, recovery_email, updated_at FROM profiles WHERE user_id = ${user.id}`;
          return json({ profile: rows[0] || null }, 200, origin);
        }
        if (req.method === "PUT") {
          const body = await readJson(req) || {};
          const rows = await sql`
            INSERT INTO profiles (user_id, email, display_name, recovery_email, updated_at)
            VALUES (${user.id}, ${user.email}, ${body.display_name || null}, ${body.recovery_email || null}, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              email = EXCLUDED.email,
              display_name = EXCLUDED.display_name,
              recovery_email = EXCLUDED.recovery_email,
              updated_at = EXCLUDED.updated_at
            RETURNING display_name, recovery_email, updated_at
          `;
          return json({ profile: rows[0] || null }, 200, origin);
        }
      }

      if (path === "/loan-data") {
        if (req.method === "GET") {
          const rows = await sql`SELECT data, updated_at FROM loan_data WHERE user_id = ${user.id}`;
          return json({ data: rows[0]?.data || [], updated_at: rows[0]?.updated_at || null }, 200, origin);
        }
        if (req.method === "PUT") {
          const body = await readJson(req) || {};
          const rows = await sql`
            INSERT INTO loan_data (user_id, data, updated_at)
            VALUES (${user.id}, ${JSON.stringify(body.data ?? [])}::jsonb, NOW())
            ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
            RETURNING data, updated_at
          `;
          return json(rows[0], 200, origin);
        }
      }

      if (path === "/shares" && req.method === "POST") {
        const body = await readJson(req) || {};
        const loan = body.loan;
        const options = body.options || {};
        if (!loan?.id) return json({ error: "Missing loan" }, 400, origin);
        const token = crypto.randomUUID();
        const profile = await sql`SELECT display_name FROM profiles WHERE user_id = ${user.id}`;
        const ownerName = profile[0]?.display_name || user.name || user.email || "";
        const days = Math.max(1, parseInt(options.expiresInDays, 10) || 7);
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        const rows = await sql`
          INSERT INTO loan_shares (
            token, owner_id, loan_id, loan_snapshot, permission, recipient_view,
            owner_display_name, owner_email, expires_at
          ) VALUES (
            ${token}, ${user.id}, ${loan.id}, ${JSON.stringify(loan)}::jsonb,
            ${options.permission || "view"}, ${options.recipientView || "borrowing"},
            ${ownerName}, ${user.email}, ${expiresAt}
          )
          RETURNING *
        `;
        return json({ token, share: publicShare(rows[0]) }, 201, origin);
      }

      const redeemMatch = path.match(/^\/shares\/redeem\/([^/]+)$/);
      if (redeemMatch && req.method === "POST") {
        const token = decodeURIComponent(redeemMatch[1]);
        const share = await validShareByToken(token, user.id);
        if (!share) return json({ share: null }, 200, origin);
        if (!share.used_at) {
          const profile = await sql`SELECT display_name FROM profiles WHERE user_id = ${user.id}`;
          await sql`
            UPDATE loan_shares
            SET used_at = NOW(), recipient_id = ${user.id}, recipient_email = ${user.email},
                recipient_display_name = ${profile[0]?.display_name || user.name || user.email}
            WHERE id = ${share.id}
          `;
        }
        const rows = await sql`SELECT * FROM loan_shares WHERE token = ${token}`;
        return json({ share: publicShare(rows[0]) }, 200, origin);
      }

      const updateSharedLoanMatch = path.match(/^\/shares\/([^/]+)\/loan$/);
      if (updateSharedLoanMatch && req.method === "PUT") {
        const token = decodeURIComponent(updateSharedLoanMatch[1]);
        const body = await readJson(req) || {};
        const rows = await sql`
          SELECT * FROM loan_shares
          WHERE token = ${token} AND permission = 'edit' AND recipient_id = ${user.id}
            AND used_at IS NOT NULL AND expires_at > NOW()
        `;
        const share = rows[0];
        if (!share) return json({ ok: false }, 200, origin);
        const ownerDataRows = await sql`SELECT data FROM loan_data WHERE user_id = ${share.owner_id}`;
        const ownerData = Array.isArray(ownerDataRows[0]?.data) ? ownerDataRows[0].data : [];
        const nextData = ownerData.map(loan => String(loan?.id) === String(share.loan_id) ? body.loan : loan);
        await sql`UPDATE loan_data SET data = ${JSON.stringify(nextData)}::jsonb, updated_at = NOW() WHERE user_id = ${share.owner_id}`;
        await sql`UPDATE loan_shares SET loan_snapshot = ${JSON.stringify(body.loan)}::jsonb WHERE id = ${share.id}`;
        return json({ ok: true }, 200, origin);
      }

      if (path === "/shares/mine" && req.method === "GET") {
        const rows = await sql`SELECT * FROM loan_shares WHERE owner_id = ${user.id} ORDER BY created_at DESC`;
        return json({ shares: rows.map(publicShare) }, 200, origin);
      }
      if (path === "/shares/received" && req.method === "GET") {
        const rows = await sql`
          SELECT * FROM loan_shares
          WHERE recipient_id = ${user.id} AND expires_at > NOW()
          ORDER BY used_at DESC NULLS LAST
        `;
        return json({ shares: rows.map(publicShare) }, 200, origin);
      }
      if (path === "/shares/transfer-offers" && req.method === "GET") {
        const rows = await sql`
          SELECT id, loan_snapshot, owner_display_name, transfer_requested_at
          FROM loan_shares
          WHERE recipient_id = ${user.id} AND transfer_requested_at IS NOT NULL
        `;
        return json({ offers: rows }, 200, origin);
      }

      const shareIdMatch = path.match(/^\/shares\/id\/([^/]+)$/);
      if (shareIdMatch) {
        const shareId = decodeURIComponent(shareIdMatch[1]);
        if (req.method === "DELETE") {
          await sql`DELETE FROM loan_shares WHERE id = ${shareId} AND (owner_id = ${user.id} OR recipient_id = ${user.id})`;
          return json({ ok: true }, 200, origin);
        }
        if (req.method === "PUT") {
          const body = await readJson(req) || {};
          const payload = {
            permission: body.permission || null,
            recipient_view: body.recipientView || null,
          };
          await sql`
            UPDATE loan_shares
            SET permission = COALESCE(${payload.permission}, permission),
                recipient_view = COALESCE(${payload.recipient_view}, recipient_view)
            WHERE id = ${shareId} AND owner_id = ${user.id}
          `;
          return json({ ok: true }, 200, origin);
        }
      }

      const shareTokenDeleteMatch = path.match(/^\/shares\/token\/([^/]+)$/);
      if (shareTokenDeleteMatch && req.method === "DELETE") {
        const token = decodeURIComponent(shareTokenDeleteMatch[1]);
        await sql`DELETE FROM loan_shares WHERE token = ${token} AND recipient_id = ${user.id}`;
        return json({ ok: true }, 200, origin);
      }

      const actionMatch = path.match(/^\/shares\/id\/([^/]+)\/([^/]+)$/);
      if (actionMatch && req.method === "POST") {
        const shareId = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2];
        let rows = [];
        if (action === "request-edit") rows = await sql`
          UPDATE loan_shares SET edit_requested_at = NOW(), edit_requested_by = ${user.id}
          WHERE id = ${shareId} AND recipient_id = ${user.id} AND permission = 'view'
            AND expires_at > NOW() AND used_at IS NOT NULL
            AND edit_requested_at IS NULL AND edit_request_resolved_at IS NULL
          RETURNING id`;
        if (action === "approve-edit") rows = await sql`
          UPDATE loan_shares SET permission = 'edit', edit_requested_at = NULL, edit_requested_by = NULL,
            edit_request_resolved_at = NOW(), edit_request_outcome = 'approved', recipient_seen_resolution_at = NULL
          WHERE id = ${shareId} AND owner_id = ${user.id} AND edit_requested_at IS NOT NULL
          RETURNING id`;
        if (action === "decline-edit") rows = await sql`
          UPDATE loan_shares SET edit_requested_at = NULL, edit_requested_by = NULL,
            edit_request_resolved_at = NOW(), edit_request_outcome = 'declined', recipient_seen_resolution_at = NULL
          WHERE id = ${shareId} AND owner_id = ${user.id} AND edit_requested_at IS NOT NULL
          RETURNING id`;
        if (action === "mark-edit-seen") rows = await sql`
          UPDATE loan_shares SET recipient_seen_resolution_at = NOW()
          WHERE id = ${shareId} AND recipient_id = ${user.id}
            AND edit_request_resolved_at IS NOT NULL AND recipient_seen_resolution_at IS NULL
          RETURNING id`;
        if (action === "request-transfer") rows = await sql`
          UPDATE loan_shares SET transfer_requested_at = NOW()
          WHERE id = ${shareId} AND owner_id = ${user.id} AND recipient_id IS NOT NULL
            AND used_at IS NOT NULL AND transfer_requested_at IS NULL
          RETURNING id`;
        if (action === "decline-transfer" || action === "cancel-transfer") rows = await sql`
          UPDATE loan_shares SET transfer_requested_at = NULL
          WHERE id = ${shareId} AND transfer_requested_at IS NOT NULL
            AND (${action === "decline-transfer"}::boolean AND recipient_id = ${user.id}
              OR ${action === "cancel-transfer"}::boolean AND owner_id = ${user.id})
          RETURNING id`;
        if (action === "accept-transfer") {
          const transferRows = await sql`SELECT * FROM loan_shares WHERE id = ${shareId} AND recipient_id = ${user.id} AND transfer_requested_at IS NOT NULL`;
          const share = transferRows[0];
          if (share) {
            const ownerRows = await sql`SELECT data FROM loan_data WHERE user_id = ${share.owner_id}`;
            const ownerData = Array.isArray(ownerRows[0]?.data) ? ownerRows[0].data : [];
            const loan = ownerData.find(item => String(item?.id) === String(share.loan_id));
            if (loan) {
              const nextOwnerData = ownerData.filter(item => String(item?.id) !== String(share.loan_id));
              await sql`UPDATE loan_data SET data = ${JSON.stringify(nextOwnerData)}::jsonb, updated_at = NOW() WHERE user_id = ${share.owner_id}`;
              await sql`
                INSERT INTO loan_data (user_id, data, updated_at)
                VALUES (${user.id}, ${JSON.stringify([loan])}::jsonb, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                  data = loan_data.data || ${JSON.stringify([loan])}::jsonb,
                  updated_at = NOW()
              `;
              await sql`DELETE FROM loan_shares WHERE id = ${shareId}`;
              rows = [{ id: shareId }];
            }
          }
        }
        return json({ ok: rows.length > 0 }, 200, origin);
      }

      if ((path === "/delete-my-account" && req.method === "POST") || (path === "/users/me" && req.method === "DELETE")) {
        if (!user) return json({ error: "Unauthorized" }, 401, origin);
        await sql`DELETE FROM loan_shares WHERE owner_id = ${user.id} OR recipient_id = ${user.id}`;
        await sql`DELETE FROM loan_data WHERE user_id = ${user.id}`;
        await sql`DELETE FROM profiles WHERE user_id = ${user.id}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${user.id}`;
        await sql`DELETE FROM neon_auth."user" WHERE id::text = ${user.id}`;
        return json({ ok: true }, 200, origin, { "Set-Cookie": `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0` });
      }

      if (path === "/admin/users") {
        const admin = await requireAdmin(req, env);
        if (!admin.admin) return json({ error: "Unauthorized" }, 401, origin);
        if (req.method === "GET") {
          const users = await sql`
            SELECT id::text AS id, email, name, "createdAt" AS created_at
            FROM neon_auth."user"
            ORDER BY "createdAt" DESC
          `;
          return json({ users }, 200, origin);
        }
      }
      const adminDeleteMatch = path.match(/^\/admin\/users\/([^/]+)$/);
      if (adminDeleteMatch && req.method === "DELETE") {
        const admin = await requireAdmin(req, env);
        if (!admin.admin) return json({ error: "Unauthorized" }, 401, origin);
        const targetId = decodeURIComponent(adminDeleteMatch[1]);
        await sql`DELETE FROM loan_shares WHERE owner_id = ${targetId} OR recipient_id = ${targetId}`;
        await sql`DELETE FROM loan_data WHERE user_id = ${targetId}`;
        await sql`DELETE FROM profiles WHERE user_id = ${targetId}`;
        await sql`DELETE FROM admin_users WHERE user_id = ${targetId}`;
        await sql`DELETE FROM neon_auth."user" WHERE id::text = ${targetId}`;
        return json({ ok: true }, 200, origin);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (error) {
      console.error("Unhandled Worker error:", error);
      return json({ error: "Internal server error", detail: error?.message || String(error) }, 500, origin);
    }
  },
};
