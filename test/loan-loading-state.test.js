import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../app.html", import.meta.url), "utf8");

function bodyOf(functionName) {
  const start = app.indexOf(`async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const next = app.indexOf("\nasync function ", start + 1);
  return app.slice(start, next === -1 ? app.length : next);
}

test("the shipped loan list starts in an honest loading state", () => {
  const loansList = html.match(/<div id="loans-list"[\s\S]*?<\/div>/)?.[0] || "";
  assert.match(loansList, /data-translate="loadingLoans"/);
  assert.doesNotMatch(loansList, /data-translate="noLoans"/);
  assert.match(app, /loadingLoans:\s*'[^']+'/);
  assert.match(app, /loanLoadFailed:\s*'[^']+'/);
});

test("failed account reads are not converted into an empty account", () => {
  const loadData = app.match(/async loadData\(\) \{[\s\S]*?\n  \}\n\};/)?.[0] || "";
  assert.match(loadData, /catch \(e\)[\s\S]*throw e;/);
  assert.doesNotMatch(loadData, /catch \(e\)[\s\S]*return \[\];/);
});

test("login shows loading before exposing the application", () => {
  const login = bodyOf("onLoginSuccess");
  const loadingAt = login.indexOf("UIHandler.showLoansLoading()");
  const closeAt = login.indexOf('document.getElementById("login-modal").style.display = "none"');
  assert.notEqual(loadingAt, -1);
  assert.notEqual(closeAt, -1);
  assert.ok(loadingAt < closeAt, "loading state must be installed before the login modal closes");
  assert.match(login, /catch \(error\)[\s\S]*UIHandler\.showLoanLoadError\(error\)/);
});

test("normal startup does not load account loans twice", () => {
  assert.doesNotMatch(app, /if \(aal\.nextLevel[\s\S]*?\} else \{\s*const syncedData = await SyncService\.loadData\(\);\s*StorageService\.save\("loanData", syncedData \?\? \[\]\);\s*\}/);
});
