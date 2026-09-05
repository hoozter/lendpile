import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || "";
}

test("editable part cards expose a three-dot open/edit action and a part-specific current-rate label", () => {
  assert.match(app, /loan-part-menu-btn/);
  assert.match(app, /data-action="edit-part"/);
  assert.match(app, /partSpecificCurrentRate/);
  assert.match(app, /PartEditorHandler\.open/);
  assert.match(app, /canEditParts\s*&&\s*!\(part\.refinancedBy\s*\|\|\s*\[\]\)\.length/);
  assert.match(css, /\.loan-part-menu-wrap/);
});

test("loan-part actions stay hidden in the three-dot menu until it is opened", () => {
  assert.match(cssBlock(".loan-part-menu"), /position:\s*absolute/);
  assert.match(cssBlock(".loan-part-menu"), /display:\s*none/);
  assert.match(cssBlock(".loan-part-menu.open"), /display:\s*block/);
  assert.match(cssBlock(".loan-part-menu button"), /background:\s*none/);
  assert.match(cssBlock(".loan-part-menu button"), /width:\s*100%/);
});

test("loan-part titles retain their flex space beside the shared three-dot control", () => {
  assert.match(app, /class="loan-part-card-heading"/);
  assert.match(cssBlock(".loan-part-card-heading"), /flex:\s*1/);
  assert.match(cssBlock(".loan-part-card-heading"), /min-width:\s*0/);
});

test("part editor supports all canonical fields, rate-history rows, cancellation, and validation feedback", () => {
  assert.match(html, /id="loan-part-modal"/);
  for (const id of ["loan-part-title", "loan-part-principal", "loan-part-start-date", "loan-part-interest-rate", "loan-part-compound", "loan-part-note", "loan-part-rate-changes", "loan-part-feedback", "cancel-loan-part-btn"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /updateLoanPart/);
  assert.match(app, /PartEditorHandler\.addRateChange/);
  assert.match(app, /PartEditorHandler\.removeRateChange/);
});

test("refinancing is available from main and obligation actions with exact payoff review", () => {
  assert.match(html, /data-main-action="refinance"/);
  assert.match(html, /id="refinance-modal"/);
  assert.match(html, /id="refinance-options"/);
  assert.match(html, /id="refinance-effective-date"/);
  assert.match(html, /id="refinance-payoff-review"/);
  assert.match(app, /debtAtEffectiveDate/);
  assert.match(app, /createRefinancing/);
  assert.match(app, /RefinanceHandler\.open/);
});

test("financial mutations only report success after authenticated sync succeeds", () => {
  const syncService = app.match(/const SyncService\s*=\s*\{([\s\S]*?)\n\};/)?.[1] || "";
  assert.doesNotMatch(syncService, /catch\s*\([^)]*\)\s*\{[\s\S]*?console\.error\([^)]*\);\s*\}/);

  const partSave = app.match(/const PartEditorHandler\s*=\s*\{([\s\S]*?)\n\};/)?.[1] || "";
  const refinanceSave = app.match(/const RefinanceHandler\s*=\s*\{([\s\S]*?)\n\};/)?.[1] || "";
  assert.match(partSave, /await SyncService\.syncData\(\)[\s\S]*?partSaved/);
  assert.match(refinanceSave, /await SyncService\.syncData\(\)[\s\S]*?refinancingCreated/);
  assert.match(partSave, /catch\s*\(error\)[\s\S]*?changesNotSaved/);
  assert.match(refinanceSave, /catch\s*\(error\)[\s\S]*?changesNotSaved/);
});

test("English and Swedish provide the new part and refinancing copy", () => {
  for (const key of ["editLoanPart", "partSpecificCurrentRate", "refinanceLoans", "exactPayoff", "refinanceConfirm"]) {
    assert.match(app, new RegExp(`${key}:\\s*'[^']+'`, "g"));
    assert.equal((app.match(new RegExp(`${key}:\\s*'[^']+'`, "g")) || []).length, 2);
  }
});
