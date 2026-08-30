import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deploymentVersion,
  publicFiles,
  renderDeploymentConfig,
  stampDeploymentVersion,
} from '../scripts/build-pages.js';

test('deploymentVersion prefers the Cloudflare Pages commit SHA', () => {
  assert.equal(
    deploymentVersion({ CF_PAGES_COMMIT_SHA: 'ABCDEF0123456789' }),
    'abcdef0123456789'
  );
});

test('deploymentVersion falls back to the source app version locally', () => {
  const html = '<meta name="app-version" content="0.2.2" />';
  assert.equal(deploymentVersion({}, html), '0.2.2');
});

test('stampDeploymentVersion updates the marker and cache-busts local assets', () => {
  const html = `
    <meta name="app-version" content="0.2.2" />
    <script src="config.js"></script>
    <script src="calculations.js"></script>
    <link rel="stylesheet" href="styles.css" />
    <script src="app.js"></script>
  `;
  const stamped = stampDeploymentVersion(html, 'abc123');

  assert.match(stamped, /name="app-version" content="abc123"/);
  assert.match(stamped, /src="config\.js\?v=abc123"/);
  assert.match(stamped, /src="calculations\.js\?v=abc123"/);
  assert.match(stamped, /href="styles\.css\?v=abc123"/);
  assert.match(stamped, /src="app\.js\?v=abc123"/);
});

test('stampDeploymentVersion replaces existing asset version parameters', () => {
  const html = '<script src="app.js?v=old"></script>';
  assert.equal(
    stampDeploymentVersion(html, 'new'),
    '<script src="app.js?v=new"></script>'
  );
});

test('renderDeploymentConfig requires the authentication endpoint', () => {
  assert.throws(
    () => renderDeploymentConfig({}),
    /NEON_AUTH_URL is required/
  );
});

test('renderDeploymentConfig cannot be redirected by a stale Pages API variable', () => {
  const config = renderDeploymentConfig({
    LENDPILE_API_URL: 'https://stale.example.test',
    NEON_AUTH_URL: 'https://auth.example.test/neondb/auth',
  });

  assert.match(config, /window\.LENDPILE_API_URL = "https:\/\/api\.lendpile\.com";/);
  assert.doesNotMatch(config, /stale\.example\.test/);
});

test('renderDeploymentConfig emits the canonical browser config names', () => {
  const config = renderDeploymentConfig({
    LENDPILE_API_URL: 'https://api.lendpile.com/',
    NEON_AUTH_URL: 'https://auth.example.test/neondb/auth/',
  });

  assert.match(config, /window\.LENDPILE_API_URL = "https:\/\/api\.lendpile\.com";/);
  assert.match(config, /window\.NEON_AUTH_URL = "https:\/\/auth\.example\.test\/neondb\/auth";/);
  assert.match(config, /window\.ADMIN_API_URL = "https:\/\/api\.lendpile\.com";/);
  assert.doesNotMatch(config, /window\.API_URL/);
});

test('Pages bundle retains routing and support documents', () => {
  assert.deepEqual(
    ['404.html', '_redirects', 'faq.html'].filter((file) => !publicFiles.includes(file)),
    []
  );
});

test('renderDeploymentConfig rejects credentials in public endpoints', () => {
  assert.throws(
    () => renderDeploymentConfig({
      LENDPILE_API_URL: 'https://api.example.test',
      NEON_AUTH_URL: 'https://token@auth.example.test/neondb/auth',
    }),
    /must not contain credentials/
  );
});
