import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/auth/[[path]].js';

const env = { NEON_AUTH_URL: 'https://ep-test.neonauth.c-2.eu-central-1.aws.neon.tech/neondb/auth' };
const origin = 'https://lendpile.com';
const requestBodyLimit = 64 * 1024;
const responseBodyLimit = 256 * 1024;
const paths = ['/get-session', '/sign-in/email', '/sign-up/email', '/sign-out', '/email-otp/send-verification-otp', '/email-otp/verify-email'];
function request(path, method = 'GET', headers = {}) {
  return new Request(origin + '/auth' + path, { method, headers: { ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers }, ...(method === 'POST' ? { body: '{}' } : {}) });
}

function streamedRequest(bytes, headers = {}, onCancel = () => {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes[index++]);
      else controller.close();
    },
    cancel: onCancel,
  }, { highWaterMark: 0 });
  return new Request(origin + '/auth/sign-in/email', {
    method: 'POST', duplex: 'half', body,
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
  });
}

function streamedResponse(bytes, headers = {}, onCancel = () => {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes[index++]);
      else controller.close();
    },
    cancel: onCancel,
  }, { highWaterMark: 0 }), { headers });
}

test('forwards exactly the six caller endpoints to the fixed binding and preserves Origin', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ user: null });
  });
  for (const path of paths) {
    const method = path === '/get-session' ? 'GET' : 'POST';
    assert.equal((await onRequest({ request: request(path, method), env })).status, 200);
    const call = calls.at(-1);
    assert.equal(call.url, env.NEON_AUTH_URL + path);
    assert.equal(call.init.method, method);
    assert.equal(call.init.headers.get('origin'), method === 'POST' ? origin : null);
    assert.equal(call.init.redirect, 'manual');
  }
});

test('rejects unused paths, query strings and methods without contacting upstream', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  for (const path of ['/token', '/.well-known/jwks.json', '/get-session/', '/get-session?url=https://evil.test', '//get-session', '/%67et-session']) {
    assert.equal((await onRequest({ request: request(path), env })).status, 404, path);
  }
  for (const [path, method] of [['/get-session', 'POST'], ['/sign-out', 'GET'], ['/get-session', 'OPTIONS'], ['/get-session', 'HEAD']]) {
    assert.equal((await onRequest({ request: request(path, method), env })).status, 405);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('rejects missing/foreign Origin on mutations and cross-site fetches on all endpoints', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  for (const value of ['', 'null', 'https://evil.test', 'https://lendpile.com.evil.test', 'http://lendpile.com']) {
    assert.equal((await onRequest({ request: request('/sign-out', 'POST', { Origin: value }), env })).status, 403);
  }
  const missingOrigin = request('/sign-out', 'POST');
  missingOrigin.headers.delete('Origin');
  assert.equal((await onRequest({ request: missingOrigin, env })).status, 403);
  assert.equal((await onRequest({ request: request('/sign-out', 'POST', { 'Sec-Fetch-Site': 'cross-site' }), env })).status, 403);
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await onRequest({ request: request('/get-session', 'GET', { 'Sec-Fetch-Site': site }), env })).status, 403);
  }
  assert.equal((await onRequest({ request: request('/get-session', 'GET', { Origin: 'https://evil.test' }), env })).status, 403);
  assert.equal((await onRequest({ request: request('/sign-out', 'POST', { 'Content-Type': 'text/plain' }), env })).status, 415);
  assert.equal(fetch.mock.callCount(), 0);
});

test('isolates Neon cookies and preserves renewal, chunks, and expiry/deletion as separate headers', async t => {
  const inputCookies = '__Secure-neon-auth.session_token=signed; __Secure-neon-auth.session_data.0=chunk; analytics=private; admin_session=private; __Secure-neon-auth.evil=no';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.get('cookie'), '__Secure-neon-auth.session_token=signed; __Secure-neon-auth.session_data.0=chunk');
    assert.equal(init.headers.get('authorization'), null);
    assert.equal(init.headers.get('x-forwarded-host'), null);
    assert.equal(init.cache, 'no-store');
    const headers = new Headers({ 'set-auth-jwt': 'jwt-fixture', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*', Location: 'https://evil.test' });
    headers.append('Set-Cookie', '__Secure-neon-auth.session_token=renewed; Domain=.neon.tech; Path=/neondb/auth; Max-Age=3600; SameSite=None');
    headers.append('Set-Cookie', '__Secure-neon-auth.session_data.0=chunk; Path=/; HttpOnly');
    headers.append('Set-Cookie', '__Secure-neon-auth.dont_remember=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/');
    headers.append('Set-Cookie', 'unrelated=secret; Path=/');
    return Response.json({ user: { id: 'fixture' } }, { headers });
  });
  const response = await onRequest({ request: request('/get-session', 'GET', { Cookie: inputCookies, Authorization: 'Bearer private', 'X-Forwarded-Host': 'evil.test' }), env });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 3);
  for (const cookie of cookies) {
    assert.match(cookie, /; Secure; HttpOnly; SameSite=Lax; Path=\/auth(?:;|$)/);
    assert.doesNotMatch(cookie, /Domain=|SameSite=None|neondb/);
  }
  assert.match(cookies[0], /Max-Age=3600/);
  assert.match(cookies[2], /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.match(cookies[2], /Max-Age=0/);
  assert.equal(response.headers.get('set-auth-jwt'), 'jwt-fixture');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('location'), null);
});

test('invalid binding, redirects and upstream failures fail closed without leaking details', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.redirect('https://evil.test', 302));
  for (const value of [undefined, 'http://localhost/auth', 'https://evil.test/auth', 'https://token@ep-test.neonauth.c-2.eu-central-1.aws.neon.tech/neondb/auth', env.NEON_AUTH_URL + '?target=evil', env.NEON_AUTH_URL + '#fragment']) {
    assert.equal((await onRequest({ request: request('/get-session'), env: { NEON_AUTH_URL: value } })).status, 503);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await onRequest({ request: request('/get-session'), env })).status, 502);
  fetch.mock.mockImplementation(async () => { throw new Error('secret session content'); });
  const response = await onRequest({ request: request('/get-session'), env });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret session/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('upstream origin rejection and verification errors retain status and body', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.get('origin'), origin);
    return Response.json({ code: 'INVALID_ORIGIN' }, { status: 403 });
  });
  const response = await onRequest({ request: request('/email-otp/verify-email', 'POST'), env });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'INVALID_ORIGIN');
});

test('request body limit accepts just below and rejects known, unknown, and misleading oversized bodies', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    assert.equal((await new Response(init.body).arrayBuffer()).byteLength, requestBodyLimit - 1);
    return Response.json({ accepted: true });
  });
  const below = new Uint8Array(requestBodyLimit - 1);
  assert.equal((await onRequest({ request: streamedRequest([below], { 'Content-Length': String(below.byteLength) }), env })).status, 200);
  assert.equal(calls, 1);

  let knownCancelled = false;
  const known = streamedRequest([new Uint8Array(1)], { 'Content-Length': String(requestBodyLimit + 1) }, () => { knownCancelled = true; });
  assert.equal((await onRequest({ request: known, env })).status, 413);
  assert.equal(knownCancelled, true);
  assert.equal(calls, 1);

  for (const headers of [{}, { 'Content-Length': '1' }]) {
    let cancelled = false;
    const above = new Uint8Array(requestBodyLimit + 1);
    const response = await onRequest({ request: streamedRequest([above.subarray(0, requestBodyLimit), above.subarray(requestBodyLimit)], headers, () => { cancelled = true; }), env });
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
  }
});

test('response body limit accepts just below and safely rejects known, unknown, and misleading oversized bodies', async t => {
  let responseFactory;
  t.mock.method(globalThis, 'fetch', async () => responseFactory());
  const below = new Uint8Array(responseBodyLimit - 1);
  responseFactory = () => streamedResponse([below], { 'Content-Length': String(below.byteLength) });
  const accepted = await onRequest({ request: request('/get-session'), env });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.arrayBuffer()).byteLength, below.byteLength);

  for (const scenario of [
    { chunks: [new TextEncoder().encode('UPSTREAM_SECRET')], headers: { 'Content-Length': String(responseBodyLimit + 1) } },
    { chunks: [new Uint8Array(responseBodyLimit), new Uint8Array(1)], headers: {} },
    { chunks: [new Uint8Array(responseBodyLimit), new Uint8Array(1)], headers: { 'Content-Length': '1' } },
  ]) {
    let cancelled = false;
    responseFactory = () => streamedResponse(scenario.chunks, scenario.headers, () => { cancelled = true; });
    const rejected = await onRequest({ request: request('/get-session'), env });
    assert.equal(rejected.status, 502);
    assert.equal(cancelled, true);
    assert.equal(await rejected.text(), JSON.stringify({ message: 'Auth service unavailable. Please try again.' }));
  }
});

test('timeout covers request body consumption and cancels it before upstream fetch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const body = new ReadableStream({ start() {}, cancel() { cancelled = true; } });
  const pending = onRequest({
    request: new Request(origin + '/auth/sign-in/email', {
      method: 'POST', duplex: 'half', body,
      headers: { Origin: origin, 'Content-Type': 'application/json' },
    }),
    env,
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_001);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal(cancelled, true);
  assert.equal(fetch.mock.callCount(), 0);
});

test('timeout covers response body consumption, aborts upstream, and returns no session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let upstreamSignal;
  let upstreamCancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    upstreamSignal = init.signal;
    return new Response(new ReadableStream({ start() {}, cancel() { upstreamCancelled = true; } }));
  });
  const pending = onRequest({ request: request('/get-session'), env });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_001);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(upstreamCancelled, true);
  assert.equal(response.headers.get('set-auth-jwt'), null);
});

test('login, fresh-page session reload, renewal, sign-out and later reload preserve cookie lifecycle', async t => {
  let validToken = null;
  let generation = 0;
  const jar = new Map();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/sign-in/email')) validToken = 'session-0';
    else if (path.endsWith('/sign-out')) {
      assert.equal(init.headers.get('cookie'), `__Secure-neon-auth.session_token=${validToken}`);
      validToken = null;
      return Response.json({ success: true }, { headers: { 'Set-Cookie': '__Secure-neon-auth.session_token=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' } });
    } else {
      if (!validToken || init.headers.get('cookie') !== `__Secure-neon-auth.session_token=${validToken}`) return Response.json(null);
      validToken = `session-${++generation}`;
    }
    return Response.json({ user: { id: 'fixture' } }, { headers: { 'set-auth-jwt': 'fixture-jwt', 'Set-Cookie': `__Secure-neon-auth.session_token=${validToken}; Max-Age=3600; Domain=neon.tech; Path=/` } });
  });
  async function browser(path, method = 'GET') {
    const response = await onRequest({ request: request(path, method, { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }), env });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = pair.split('=');
      if (cookie.includes('Max-Age=0')) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  }
  await browser('/sign-in/email', 'POST');
  assert.equal(jar.size, 1);
  // A fresh page has no in-memory auth state; the first-party cookie alone restores it.
  const reloaded = await browser('/get-session');
  assert.equal((await reloaded.json()).user.id, 'fixture');
  assert.equal(reloaded.headers.get('set-auth-jwt'), 'fixture-jwt');
  assert.equal((await (await browser('/get-session')).json()).user.id, 'fixture');
  assert.equal(generation, 2);
  await browser('/sign-out', 'POST');
  assert.equal(jar.size, 0);
  const loggedOut = await browser('/get-session');
  assert.equal(await loggedOut.json(), null);
  assert.equal(loggedOut.headers.get('set-auth-jwt'), null);
});
