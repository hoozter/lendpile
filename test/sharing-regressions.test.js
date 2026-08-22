import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  normalizeShareOptions,
  requireAppliedShareAction,
  saveOwnerLoanData,
  updateSharedLoanAtomically,
} from "../worker/src/sharing.mjs";

test("share creation preserves an explicitly selected recipient role", () => {
  assert.deepEqual(
    normalizeShareOptions({ permission: "view", recipientView: "lending", expiresInDays: 7 }),
    { permission: "view", recipientView: "lending", expiresInDays: 7 },
  );
  assert.deepEqual(
    normalizeShareOptions({ permission: "view", recipientView: "borrowing", expiresInDays: 7 }),
    { permission: "view", recipientView: "borrowing", expiresInDays: 7 },
  );
});

test("share creation rejects missing or invalid role and permission instead of changing their meaning", () => {
  assert.throws(() => normalizeShareOptions({ permission: "view" }), /recipient role/i);
  assert.throws(() => normalizeShareOptions({ permission: "write", recipientView: "lending" }), /permission/i);
});

test("a rejected edit request is an error, not a successful request", () => {
  assert.throws(() => requireAppliedShareAction("request-edit", []), /not applied/i);
  assert.deepEqual(requireAppliedShareAction("request-edit", [{ id: "share-1" }]), { id: "share-1" });
});

test("a read-only shared-loan write preserves the API contract without becoming a local false success", () => {
  const worker = readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

  assert.match(worker, /if \(!updated\) return json\(\{ ok: false, error: "Share is not editable" \}, 200, origin\)/);
  assert.match(app, /if \(result\.error \|\| !result\.ok\)/);
  assert.ok(
    app.indexOf("if (result.error || !result.ok)") < app.indexOf("UIHandler.currentShare.share.loan_snapshot = newLoan"),
    "permission must be checked before mutating the local shared snapshot",
  );
});

test("owner save atomically refreshes current shares and revokes shares for deleted loans", async () => {
  const queries = [];
  const sql = async (strings, ...values) => {
    queries.push({ text: strings.join("?"), values });
    return [{ data: [], updated_at: "now" }];
  };
  const loan = { id: "loan-1", interestChanges: [] };

  await saveOwnerLoanData(sql, "owner-1", [loan]);

  assert.equal(queries.length, 1, "owner data and shares must change in one PostgreSQL statement");
  assert.match(queries[0].text, /INSERT INTO loan_data/i);
  assert.match(queries[0].text, /DELETE FROM loan_shares/i);
  assert.match(queries[0].text, /NOT EXISTS/i);
  assert.match(queries[0].text, /UPDATE loan_shares/i);
  assert.match(queries[0].text, /SET loan_snapshot/i);
  assert.deepEqual(queries[0].values, ["owner-1", JSON.stringify([loan]), "owner-1", "owner-1"]);
});

test("recipient edit updates authoritative data and all snapshots in one guarded statement", async () => {
  const queries = [];
  const sql = async (strings, ...values) => {
    queries.push({ text: strings.join("?"), values });
    return [{ ok: true }];
  };
  const loan = { id: "loan-1", interestChanges: [] };

  assert.equal(await updateSharedLoanAtomically(sql, "token-1", "recipient-1", loan), true);
  assert.equal(queries.length, 1, "authorization, owner data, and snapshots must share one statement");
  assert.match(queries[0].text, /permission = 'edit'/i);
  assert.match(queries[0].text, /UPDATE loan_data/i);
  assert.match(queries[0].text, /UPDATE loan_shares/i);
  assert.deepEqual(queries[0].values, ["token-1", "recipient-1", JSON.stringify(loan)]);
});
