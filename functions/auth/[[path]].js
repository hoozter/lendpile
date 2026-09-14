// Only endpoints used by app.js and admin.html belong at this boundary.
const endpoints = new Map([
  ['/auth/get-session', 'GET'],
  ['/auth/sign-in/email', 'POST'],
  ['/auth/sign-up/email', 'POST'],
  ['/auth/sign-out', 'POST'],
  ['/auth/email-otp/send-verification-otp', 'POST'],
  ['/auth/email-otp/verify-email', 'POST'],
]);
const REQUEST_BODY_LIMIT = 64 * 1024;
const RESPONSE_BODY_LIMIT = 256 * 1024;

class BodyTooLarge extends Error {}

function failure(status, message) {
  return Response.json({ message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function declaredBodyTooLarge(headers, limit) {
  const value = headers.get('Content-Length');
  return value !== null && /^\d+$/.test(value) && BigInt(value) > BigInt(limit);
}

function cancelBody(body) {
  try { if (body) void body.cancel().catch(() => {}); } catch {}
}

async function readBody(body, limit, signal) {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const method = endpoints.get(url.pathname);
  if (!method || url.search) return failure(404, 'Unknown auth endpoint');
  if (request.method !== method) return failure(405, 'Method not allowed');
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if ((site && site !== 'same-origin' && site !== 'none') ||
      (origin !== null && origin !== url.origin) ||
      (method === 'POST' && origin !== url.origin)) {
    return failure(403, 'Auth request origin rejected');
  }
  if (method === 'POST' && request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return failure(415, 'Auth requests require JSON');
  }
  let upstream;
  try {
    upstream = new URL(env.NEON_AUTH_URL);
    if (upstream.protocol !== 'https:' || upstream.username || upstream.password ||
        upstream.port || upstream.search || upstream.hash ||
        !/^[a-z0-9-]+\.neonauth\.[a-z0-9.-]+\.neon\.tech$/.test(upstream.hostname) ||
        !/^\/[a-zA-Z0-9_-]+\/auth\/?$/.test(upstream.pathname)) {
      return failure(503, 'Auth service is not configured');
    }
  } catch {
    return failure(503, 'Auth service is not configured');
  }
  const headers = new Headers({ Accept: 'application/json' });
  // Forward the actual origin. Never substitute the upstream origin or a trusted one.
  if (origin !== null) headers.set('Origin', origin);
  if (method === 'POST') headers.set('Content-Type', 'application/json');
  const cookies = (request.headers.get('Cookie') || '').split(';')
    .map(cookie => cookie.trim()).filter(cookie => authCookieName(cookie.split('=')[0]));
  if (cookies.length) headers.set('Cookie', cookies.join('; '));
  headers.set('Cache-Control', 'no-store');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Auth timeout'));
    }, 10_000);
  });
  try {
    // Keep the deadline active through body consumption, not just response headers.
    return await Promise.race([deadline, (async () => {
      if (method === 'POST' && declaredBodyTooLarge(request.headers, REQUEST_BODY_LIMIT)) {
        cancelBody(request.body);
        return failure(413, 'Auth request body is too large');
      }
      let requestBody;
      try {
        requestBody = method === 'POST' ? await readBody(request.body, REQUEST_BODY_LIMIT, controller.signal) : undefined;
      } catch (error) {
        if (error instanceof BodyTooLarge) return failure(413, 'Auth request body is too large');
        throw error;
      }
      const response = await fetch(upstream.href.replace(/\/$/, '') + url.pathname.slice('/auth'.length), {
        method, headers, body: requestBody,
        redirect: 'manual', cache: 'no-store', signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return failure(502, 'Unexpected auth redirect');
      }
      if (declaredBodyTooLarge(response.headers, RESPONSE_BODY_LIMIT)) {
        cancelBody(response.body);
        return failure(502, 'Auth service unavailable. Please try again.');
      }
      let body;
      try {
        body = await readBody(response.body, RESPONSE_BODY_LIMIT, controller.signal);
      } catch (error) {
        if (error instanceof BodyTooLarge) return failure(502, 'Auth service unavailable. Please try again.');
        throw error;
      }
      const resultHeaders = new Headers({
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      for (const name of ['Content-Type', 'set-auth-jwt', 'Retry-After']) {
        const value = response.headers.get(name);
        if (value !== null) resultHeaders.set(name, value);
      }
      // Never split a combined Set-Cookie on commas: Expires contains a comma.
      for (const cookie of response.headers.getSetCookie()) {
        const [pair, ...attributes] = cookie.split(';').map(part => part.trim());
        if (!authCookieName(pair.split('=')[0])) continue;
        const lifetime = attributes.filter(attribute => /^(?:Expires|Max-Age)=/i.test(attribute));
        resultHeaders.append('Set-Cookie', [pair, 'Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/auth', ...lifetime].join('; '));
      }
      return new Response([204, 205].includes(response.status) ? null : body, {
        status: response.status, headers: resultHeaders,
      });
    })()]);
  } catch {
    return failure(controller.signal.aborted ? 504 : 502, 'Auth service unavailable. Please try again.');
  } finally {
    clearTimeout(timer);
  }
}

// Password/OTP flows only; no OAuth challenge or SDK-local cache cookies.
function authCookieName(name) {
  return /^__Secure-neon-auth\.(?:session_token|dont_remember|session_data(?:\.\d+)?)$/.test(name);
}
