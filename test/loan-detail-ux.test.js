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
  assert.match(js, /function toggleDropdownMenu\(menu, trigger\)[\s\S]*?positionDropdownInViewport\(menu, trigger\)/);
  assert.match(block('.main-actions-menu'), /max-width:\s*calc\(100vw\s*-\s*16px\)/);
  assert.match(block('.main-actions-menu'), /width:\s*min\(210px,\s*calc\(100vw\s*-\s*16px\)\)/);
});

test('loan cards make the user-entered name primary and open without a redundant View button', () => {
  const start = js.indexOf('createLoanCardCompact(loan, index)');
  const end = js.indexOf('/** Card click', start);
  const card = js.slice(start, end);
  assert.match(card, /<h3[^>]*>\$\{escapeHtml\(loan\.name\)\}<\/h3>[\s\S]*?<span class="loan-card-type-badge"/);
  assert.doesNotMatch(card, /btn-open/);
  assert.doesNotMatch(card, /openLoan/);
  assert.match(card, /<button[^>]*class="loan-card-compact-open"[^>]*data-action="open"/);
  assert.doesNotMatch(card, /class="loan-card-compact"[^>]*role="button"/);
  assert.doesNotMatch(card, /data-loan-type="\$\{loan\.loanType/);
  assert.doesNotMatch(card, /data-type="\$\{loan\.loanType/);
  assert.doesNotMatch(card, /uncombine/);
  assert.match(block('.loan-card-compact-open'), /height:\s*auto/);
  assert.match(block('.loan-card-compact-open'), /margin:\s*0/);
});

test('uncombine is offered only inside the selected loan detail menu', () => {
  const start = js.indexOf('showLoanDetail(index)');
  const end = js.indexOf('getCurrentLoan()', start);
  assert.match(js.slice(start, end), /data-action="uncombine"/);
});

test('custom dropdown menus only scroll when the viewport actually constrains them', () => {
  const dropdownOverflow = css.match(/\.dropdown-menu,\s*\.loan-detail-menu,\s*\.main-actions-menu,\s*\.profile-dropdown\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(dropdownOverflow, /overflow-y:\s*auto/);
  assert.doesNotMatch(dropdownOverflow, /overflow-y:\s*scroll/);
  assert.match(css, /select\s*\{[\s\S]*?scrollbar-width:\s*auto/);
  assert.match(js, /menu\.style\.overflowY\s*=\s*"auto"/);
});

test('re-entering the application does not register duplicate menu listeners', () => {
  assert.match(js, /listenersInitialized:\s*false/);
  assert.match(js, /initializeEventListeners\(\)\s*\{\s*if \(this\.listenersInitialized\) return;\s*this\.listenersInitialized = true;/);
});

test('menu triggers toggle closed and outside clicks are consumed before other actions', () => {
  assert.match(js, /function toggleDropdownMenu\(menu, trigger\)/);
  assert.match(js, /const wasOpen = menu\.classList\.contains\("open"\);[\s\S]*?closeOpenMenus\(\);[\s\S]*?if \(wasOpen\) return false;/);
  assert.match(js, /document\.addEventListener\("click", dismissOpenMenusOnOutsideClick, true\)/);
  assert.match(js, /function dismissOpenMenusOnOutsideClick\(event\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);/);
  assert.ok((js.match(/toggleDropdownMenu\(/g) || []).length >= 8);
});

test('all three-dot triggers share one compact borderless visual treatment', () => {
  const controls = css.match(/\.main-actions-menu-btn,\s*\.overview-detail-menu-btn,\s*\.loan-detail-menu-btn,\s*\.loan-part-menu-btn,\s*\.payment-plan-menu-btn,\s*\.account-email-menu-btn\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(controls, /width:\s*34px/);
  assert.match(controls, /height:\s*34px/);
  assert.match(controls, /min-width:\s*0/);
  assert.match(controls, /margin:\s*0/);
  assert.match(controls, /border:\s*0/);
  assert.match(controls, /background:\s*transparent/);
});
