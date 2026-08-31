import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(dirname, '..', 'app.js'), 'utf8');

test('loan-part balances distinguish original totals from remaining principal', () => {
  assert.match(app, /originalTotal:\s*'Original total'/);
  assert.match(app, /originalPrincipal:\s*'Original principal'/);
  assert.match(app, /currentPrincipal:\s*'Principal remaining'/);
  assert.match(app, /LanguageService\.translate\("originalTotal"\)/);
  assert.match(app, /LanguageService\.translate\("originalPrincipal"\)/);
  assert.match(app, /LanguageService\.translate\("currentPrincipal"\)/);
});

test('loan parts replace the redundant combined overview card', () => {
  assert.doesNotMatch(app, /const combinedOverviewCard/);
  assert.doesNotMatch(app, /\$\{combinedOverviewCard\}/);
});

test('viewport-positioned menus suppress accidental horizontal scrolling', () => {
  assert.match(app, /menu\.style\.overflowX\s*=\s*"hidden"/);
  assert.match(app, /menu\.style\.overflowY\s*=\s*"auto"/);
});
