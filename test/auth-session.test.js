import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function authHarness(session, response = Response.json({ user: { emailVerified: true } })) {
  let refreshed = 0;
  const context = {
    NEON_AUTH_URL: '/auth', window: { location: { pathname: '/app.html' } },
    fetch: async () => response,
    beginAuthTransition() {}, clearExplicitSignOut() {}, setCachedProfile() {},
    loadNeonSession: async () => { if (session instanceof Error) throw session; return session; },
  };
  const start = source.indexOf('const AuthService =');
  const end = source.indexOf('  async signOut()', start);
  vm.runInNewContext(source.slice(start, end) + '\n}; globalThis.auth = AuthService;', context);
  context.auth.refreshProfile = async () => { refreshed++; };
  return { auth: context.auth, refreshed: () => refreshed };
}

test('OTP verification cannot report success when session retrieval fails or returns no session', async () => {
  for (const session of [{ error: new Error('No active auth session'), data: null }, { error: null, data: { session: null } }, new Error('Network failed')]) {
    const h = authHarness(session);
    const result = await h.auth.verifySignupOtp('fixture@example.test', '123456');
    assert.equal(result.success, false);
    assert.match(result.error, /session|sign in/i);
    assert.equal(h.refreshed(), 0);
  }
});

test('OTP verification succeeds only with a retrieved session; invalid OTP remains failure', async () => {
  const session = { access_token: 'fixture', user: { id: 'fixture' } };
  const h = authHarness({ error: null, data: { session } });
  assert.equal((await h.auth.verifySignupOtp('fixture@example.test', '123456')).success, true);
  assert.equal(h.refreshed(), 1);
  const invalid = authHarness(null, Response.json({ message: 'Invalid OTP' }, { status: 400 }));
  assert.equal((await invalid.auth.verifySignupOtp('fixture@example.test', 'bad')).error, 'Invalid OTP');
});

test('signup only classifies explicitly unverified accounts as awaiting verification', async () => {
  const missing = { error: new Error('No active auth session'), data: null };
  const pending = authHarness(missing, Response.json({ user: { emailVerified: false } }));
  const result = await pending.auth.signUp('fixture@example.test', 'fixture', 'Fixture');
  assert.equal(result.success, true);
  assert.equal(result.data.needsVerification, true);
  for (const user of [undefined, { emailVerified: true }]) {
    const h = authHarness(missing, Response.json({ user }));
    assert.equal((await h.auth.signUp('fixture@example.test', 'fixture', 'Fixture')).success, false);
  }
});
