/**
 * Delete-my-account Edge Function
 * Verifies the user's JWT and deletes that user via the Auth Admin API (service role).
 * Called from the app after password re-confirmation.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status: number, headers = corsHeaders) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  // Resolve user id from the user's JWT (GoTrue verifies the token)
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
  });
  if (!userRes.ok) {
    const err = await userRes.text();
    return jsonResponse({ error: "Invalid or expired session" }, 401);
  }
  let user: { id?: string };
  try {
    user = await userRes.json();
  } catch {
    return jsonResponse({ error: "Invalid session" }, 401);
  }
  const userId = user?.id;
  if (!userId) {
    return jsonResponse({ error: "User not found" }, 401);
  }

  // Delete the user with the service role (admin API)
  const deleteRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  });
  if (!deleteRes.ok) {
    const errText = await deleteRes.text();
    return jsonResponse({ error: errText || "Failed to delete account" }, deleteRes.status >= 500 ? 502 : 400);
  }

  return jsonResponse({ ok: true }, 200);
});
