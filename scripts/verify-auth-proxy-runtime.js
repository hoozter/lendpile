// Local-only Pages compilation and workerd integration; uses existing worker devDependencies.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../worker/package.json', import.meta.url));
const { Miniflare } = require('miniflare');
const stage = mkdtempSync(join(root, 'dist', '.auth-check-'));
let mf;
try {
  execFileSync(join(root, 'worker/node_modules/.bin/wrangler'), [
    'pages', 'functions', 'build', 'functions', '--outdir', join(stage, 'modules'),
    '--output-routes-path', join(stage, 'routes.json'), '--compatibility-date', '2026-09-14',
  ], { cwd: root, stdio: 'pipe' });
  const routes = JSON.parse(readFileSync(join(stage, 'routes.json'), 'utf8'));
  assert.deepEqual(routes.include, ['/auth/*']);
  assert.deepEqual(routes.exclude, []);
  const upstream = 'https://ep-test.neonauth.c-2.eu-central-1.aws.neon.tech';
  let upstreamCalls = 0;
  const outboundService = async request => {
    upstreamCalls++;
    const url = new URL(request.url);
    assert.equal(url.origin, upstream);
    assert.equal(request.headers.get('authorization'), null);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (url.pathname.endsWith('/sign-in/email')) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('origin'), 'https://lendpile.com');
      headers.append('Set-Cookie', '__Secure-neon-auth.session_token=fixture; Domain=neon.tech; Path=/; SameSite=None');
      headers.append('Set-Cookie', '__Secure-neon-auth.dont_remember=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      headers.append('Set-Cookie', 'analytics=drop');
    } else if (url.pathname.endsWith('/sign-out')) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('origin'), 'https://lendpile.com');
      assert.equal(request.headers.get('cookie'), '__Secure-neon-auth.session_token=fixture');
      headers.append('Set-Cookie', '__Secure-neon-auth.session_token=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    } else {
      assert.equal(url.pathname, '/neondb/auth/get-session');
      if (!request.headers.get('cookie')) return new Response('null', { headers });
      assert.equal(request.headers.get('cookie'), '__Secure-neon-auth.session_token=fixture');
      headers.set('set-auth-jwt', 'jwt-fixture');
    }
    return new Response('{"user":{"id":"fixture"}}', { headers });
  };
  mf = new Miniflare({
    modules: true, scriptPath: join(stage, 'modules/index.js'), compatibilityDate: '2026-09-14',
    bindings: { NEON_AUTH_URL: upstream + '/neondb/auth' }, outboundService,
    serviceBindings: { ASSETS: () => new Response('static fixture') },
  });
  const post = { method: 'POST', headers: { Origin: 'https://lendpile.com', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}' };
  const login = await mf.dispatchFetch('https://lendpile.com/auth/sign-in/email', post);
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie();
  assert.equal(cookies.length, 2, JSON.stringify(cookies));
  for (const cookie of cookies) {
    assert.match(cookie, /Secure; HttpOnly; SameSite=Lax; Path=\/auth/);
    assert.doesNotMatch(cookie, /Domain=|SameSite=None/);
  }
  assert.match(cookies[1], /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  const cookie = cookies[0].split(';')[0];
  const session = await mf.dispatchFetch('https://lendpile.com/auth/get-session', { headers: { Cookie: cookie + '; private_app_cookie=drop' } });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get('set-auth-jwt'), 'jwt-fixture');
  assert.equal(session.headers.get('cache-control'), 'no-store');
  const logout = await mf.dispatchFetch('https://lendpile.com/auth/sign-out', { ...post, headers: { ...post.headers, Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/);
  const after = await mf.dispatchFetch('https://lendpile.com/auth/get-session');
  assert.equal(await after.json(), null);
  for (const path of ['/auth/token', '/auth/get-session?url=https://evil.test']) {
    assert.equal((await mf.dispatchFetch('https://lendpile.com' + path)).status, 404);
  }
  assert.equal((await mf.dispatchFetch('https://lendpile.com/auth/sign-out', { ...post, headers: { ...post.headers, Origin: 'https://evil.test' } })).status, 403);
  assert.equal(await (await mf.dispatchFetch('https://lendpile.com/app.html')).text(), 'static fixture');
  assert.equal(upstreamCalls, 4);
  console.log('PASS: Pages /auth/* compilation, workerd cookie/session lifecycle, origin rejection, static fallback; no upstream network');
} finally {
  await mf?.dispose();
  rmSync(stage, { recursive: true, force: true });
}
