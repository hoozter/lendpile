import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/README.md", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return app.slice(from, to);
}

function exportedConst(name, end) {
  return sourceBetween(`const ${name}`, end).replace(`const ${name}`, `globalThis.${name}`);
}

function storage() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}

test("account cache is account-isolated and malformed browser values are ignored", () => {
  const localStorage = storage();
  const context = { localStorage, console: { warn() {} }, Date };
  vm.runInNewContext(exportedConst("AccountCacheService", "function withRequestTimeout"), context);
  context.AccountCacheService.save("alice", [{ id: "a" }]);
  context.AccountCacheService.save("bob", [{ id: "b" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.AccountCacheService.load("alice").data)), [{ id: "a" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.AccountCacheService.load("bob").data)), [{ id: "b" }]);
  localStorage.setItem("lendpile_account_loans:alice", "bad json");
  assert.equal(context.AccountCacheService.load("alice"), null);
  assert.equal(context.AccountCacheService.clear("bob"), true);
  assert.equal(context.AccountCacheService.load("bob"), null);
});

test("a newly begun account is read-only until its authoritative GET verifies it", () => {
  const context = { currentSessionFromToken: () => ({ user: { id: "alice" } }) };
  vm.runInNewContext(exportedConst("AccountLoadState", "const AccountCacheService"), context);
  const load = context.AccountLoadState.begin("alice");
  assert.equal(context.AccountLoadState.isCurrent(load), true);
  assert.equal(context.AccountLoadState.requireVerified(), false);
  context.AccountLoadState.markVerified(load);
  assert.equal(context.AccountLoadState.requireVerified(), true);
  context.currentSessionFromToken = () => ({ user: { id: "bob" } });
  assert.equal(context.AccountLoadState.isCurrent(load), false);
  assert.equal(context.AccountLoadState.requireVerified(), false, "a changed token may not write the prior account's global view");
});

test("cached startup starts GET first, renders cached loans read-only, and saves only GET data", async () => {
  const events = [];
  let resolveGet;
  let verified = false;
  const context = {
    AccountLoadState: {
      begin: id => ({ generation: 1, userId: id }), isCurrent: () => true,
      isVerified: () => verified, markStale: () => events.push("stale"),
      markVerified: () => { verified = true; events.push("verified"); },
    },
    AccountCacheService: { load: () => ({ data: [{ id: "cached" }] }), save: (_id, data) => events.push(`cache:${data[0].id}`) },
    StorageService: { saveAuthoritative: (_k, data) => events.push(`storage:${data[0].id}`), clearAccountLoans: () => events.push("clear") },
    UIHandler: {
      showCachedLoans: data => events.push(`cached:${data[0].id}`), showLoansLoading: () => events.push("loading"),
      showLoanLoadError: () => events.push("error"), showCachedLoanLoadError: () => events.push("cached-error"),
      sharesReceived: [], currentShare: null, currentDetailLoanIndex: null, renderLoans: () => events.push("render"), init: () => events.push("init"),
    },
    apiFetch: () => { events.push("get"); return new Promise(resolve => { resolveGet = resolve; }); },
    ShareService: { listSharesReceived: async () => ({ shares: [{ id: "share" }] }) },
    withRequestTimeout: promise => promise,
    console,
  };
  vm.runInNewContext(sourceBetween("async function refreshSharesForAccount", "async function onLoginSuccess"), context);
  const pending = context.startAccountLoanLoad({ id: "alice" });
  await Promise.resolve();
  assert.deepEqual(events.slice(0, 4), ["get", "clear", "stale", "cached:cached"]);
  assert.equal(events.includes("storage:cached"), false);
  assert.equal(events.includes("render"), false, "shares must not redraw while the GET is pending");
  resolveGet({ data: [{ id: "authoritative" }] });
  await pending;
  assert.deepEqual(events, ["get", "clear", "stale", "cached:cached", "storage:authoritative", "cache:authoritative", "verified", "render"]);
});

test("failed cached refresh remains visible and never overwrites the cache", async () => {
  const events = [];
  const context = {
    AccountLoadState: { begin: id => ({ generation: 1, userId: id }), isCurrent: () => true, isVerified: () => false, markStale: () => events.push("stale"), markVerified: () => events.push("verified") },
    AccountCacheService: { load: () => ({ data: [{ id: "cached" }] }), save: () => events.push("cache") },
    StorageService: { saveAuthoritative: () => events.push("storage"), clearAccountLoans: () => events.push("clear") },
    UIHandler: { showCachedLoans: () => events.push("cached"), showLoansLoading: () => {}, showLoanLoadError: () => events.push("error"), showCachedLoanLoadError: () => events.push("cached-error"), sharesReceived: [], currentShare: null, currentDetailLoanIndex: null, renderLoans: () => events.push("render"), init: () => {} },
    apiFetch: async () => { throw new Error("offline"); }, ShareService: { listSharesReceived: async () => ({ shares: [] }) }, withRequestTimeout: p => p, console,
  };
  vm.runInNewContext(sourceBetween("async function refreshSharesForAccount", "async function onLoginSuccess"), context);
  await context.startAccountLoanLoad({ id: "alice" });
  assert.deepEqual(events, ["clear", "stale", "cached", "cached-error"]);
});

test("guest saves survive an account view replacing the shared working data", () => {
  const localStorage = storage();
  const context = { localStorage, console, currentSessionFromToken: () => null,
    AccountLoadState: { requireVerified: () => true, isCurrent: () => true },
    LendpileCalculations: { normalizeLoan: loan => loan } };
  vm.runInNewContext(exportedConst("StorageService", "async function updateUserHeader"), context);
  context.StorageService.save("loanData", [{ id: "guest" }]);
  context.currentSessionFromToken = () => ({ user: { id: "alice" } });
  context.StorageService.clearAccountLoans();
  context.StorageService.saveAuthoritative("loanData", [{ id: "account" }]);
  assert.equal(JSON.parse(localStorage.getItem("lendpile_guest_loans"))[0].id, "guest");
});

test("login offers only isolated guest loans after verifying an empty account", async () => {
  const guest = [{ id: "guest" }];
  let offered;
  let saved;
  const context = {
    sessionStorage: { removeItem() {} },
    AuthService: { getUser: async () => ({ id: "alice" }) },
    AccountLoadState: { generation: 1, userId: "alice", isVerified: () => true },
    StorageService: { load: key => key === "lendpile_guest_loans" ? guest : [], save: (_key, loans) => { saved = loans; return true; } },
    startAccountLoanLoad: async () => [],
    UIHandler: { restoreBodyScroll() {}, showConfirmModal: options => { offered = options; }, cancelGenericConfirm() {}, renderLoans() {} },
    LanguageService: { translate: key => key },
    document: { getElementById: () => ({ style: {} }) },
    localStorage: storage(),
    SyncService: { syncData: async () => {} },
    updateUserHeader() {}, updateOfflineBanner() {}, tryRedeemPendingShare() {},
  };
  vm.runInNewContext(sourceBetween("async function onLoginSuccess", 'document.getElementById("login-form")'), context);
  await context.onLoginSuccess();
  assert.ok(offered, "verified empty account must offer guest import");
  assert.equal(saved, undefined, "no automatic adoption");
  await offered.onConfirm();
  assert.equal(saved, guest);
});

test("legacy data claiming is retired and documentation records completed migration", () => {
  assert.doesNotMatch(worker, /claimLegacyDataForUser|mergeLoanArrays/);
  assert.match(docs, /legacy user-ID migration is completed/i);
  assert.doesNotMatch(docs, /will be claimed by email on first login/i);
});
