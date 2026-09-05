import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { publicFiles } from '../scripts/build-pages.js';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('notices cover the production graph and deploy with Pages', () => {
  const notices = read('THIRD_PARTY_NOTICES.html');
  for (const text of ['ECharts 5.6.0', 'League Spartan', 'Roboto', 'Material Icons', 'Permission is hereby granted', 'SIL OPEN FONT LICENSE', 'Apache License', 'Neon Inc.', 'Copyright 2010-2016 Mike Bostock', 'ZRender 5.6.1', 'tslib 2.3.0']) assert.ok(notices.includes(text), text);
  const lock = read('worker/package-lock.json');
  assert.ok(notices.includes(createHash('sha256').update(lock).digest('hex')));
  for (const [path, pkg] of Object.entries(JSON.parse(lock).packages)) if (path && !pkg.dev) assert.ok(notices.includes(`${path} @ ${pkg.version}`), path);
  assert.ok(publicFiles.includes('THIRD_PARTY_NOTICES.html'));
  for (const page of ['index.html', 'app.html']) assert.ok(read(page).includes('href="THIRD_PARTY_NOTICES.html"'));
  assert.ok(read('app.html').includes('echarts@5.6.0/'));
});
