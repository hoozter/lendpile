import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function block(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
}

test('main overflow actions are hidden until explicitly opened', () => {
  assert.match(block('.main-actions-menu'), /position:\s*absolute/);
  assert.match(block('.main-actions-menu'), /display:\s*none/);
  assert.match(block('.main-actions-menu.open'), /display:\s*block/);
});

test('mobile profile and detail menus are anchored inside the viewport', () => {
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.profile-dropdown\s*\{[^}]*left:\s*0[^}]*right:\s*auto/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.overview-detail-menu-wrap\s*\{[^}]*margin-left:\s*auto/);
  assert.match(css, /max-width:\s*calc\(100vw\s*-\s*24px\)/);
});

test('notes have a dedicated editor instead of living in loan settings', () => {
  const loanForm = html.match(/<form id="loan-form-modal">([\s\S]*?)<\/form>/)?.[1] || '';
  assert.doesNotMatch(loanForm, /id="loanNotes"/);
  assert.match(html, /id="loan-note-modal"/);
  assert.match(html, /id="loan-note-form"/);
  assert.match(html, /id="loan-note-text"/);
  assert.match(js, /const LoanNoteHandler\s*=\s*\{/);
  assert.match(js, /data-action="edit-note"/);
});

test('loan parts are first-class readable cards in the overview', () => {
  assert.match(js, /class="loan-parts-grid"/);
  assert.match(js, /class="loan-part-card"/);
  assert.match(js, /loan-part-card-title/);
  assert.match(js, /loan-part-card-balance/);
  assert.match(js, /loan-part-card-details/);
  assert.match(js, /class="loan-parts-summary"/);
  assert.match(js, /facilityTotals\.currentDebt/);
  assert.match(css, /\.loan-parts-grid\s*\{/);
  assert.match(css, /\.loan-part-card\s*\{/);
});

test('every detail overflow menu uses the viewport positioning guard', () => {
  assert.match(js, /positionDropdownInViewport\(menu, changeItemMenuBtn\)/);
  assert.match(js, /positionDropdownInViewport\(menu, paymentPlanBtn\)/);
  assert.match(block('.main-actions-menu'), /max-width:\s*calc\(100vw\s*-\s*16px\)/);
  assert.match(block('.main-actions-menu'), /width:\s*min\(210px,\s*calc\(100vw\s*-\s*16px\)\)/);
});
