import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMigrationPlan } from "../scripts/verify-loan-parts-migration.js";

const root = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(root, "scripts", "verify-loan-parts-migration.js");

test("migration verifier validates canonical conversion without emitting customer data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lendpile-migration-"));
  const backup = path.join(directory, "backup.jsonl");
  const row = {
    user_id: "private-user-id",
    data: JSON.stringify([{
      id: "private-loan-id",
      name: "Private facility name",
      startDate: "2025-01-01",
      initialAmount: 1000,
      interestRate: 4,
      interestChanges: [{ date: "2025-02-01", rate: 5 }],
      loanChanges: [{ date: "2025-03-01", amount: 250, title: "Private title", note: "Private note", kind: "contract-drawdown" }],
      payments: [{ type: "oneTime", date: "2025-04-01", amount: 100 }]
    }])
  };
  fs.writeFileSync(backup, `${JSON.stringify(row)}\n`);
  try {
    const output = execFileSync(process.execPath, ["scripts/verify-loan-parts-migration.js", backup], {
      cwd: root,
      encoding: "utf8"
    });
    const summary = JSON.parse(output);
    assert.deepEqual(
      { status: summary.status, rows: summary.rows, loans: summary.loans, loanParts: summary.loanParts, principalAdjustments: summary.principalAdjustments },
      { status: "PASS", rows: 1, loans: 1, loanParts: 2, principalAdjustments: 0 }
    );
    assert.match(summary.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(summary.convertedSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(output, /private-user-id|private-loan-id|Private facility name|Private title|Private note/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration plan preserves zero-value loan changes as canonical audit adjustments", () => {
  const marker = {
    id: "zero-audit-id",
    date: "2025-05-01",
    amount: 0,
    kind: "audit-marker",
    approvedBy: "reviewer",
    audit: { externalReference: "AUDIT-0" }
  };
  const plan = buildMigrationPlan([{
    user_id: "user-a",
    data: [{
      id: "loan-a",
      startDate: "2025-01-01",
      initialAmount: 1000,
      interestRate: 4,
      loanChanges: [marker],
      payments: []
    }]
  }]);

  assert.deepEqual(plan.entries[0].converted[0].principalAdjustments, [{
    id: marker.id,
    date: marker.date,
    amount: marker.amount,
    kind: marker.kind,
    approvedBy: marker.approvedBy,
    audit: marker.audit,
    allocationPolicy: "proRata"
  }]);
});

test("database URL parse failures never disclose credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lendpile-migration-url-"));
  const fixturePath = path.join(directory, "fixture.jsonl");
  const loan = {
    startDate: "2025-01-01",
    initialAmount: 1000,
    interestRate: 4,
    loanChanges: [],
    payments: []
  };
  fs.writeFileSync(fixturePath, [
    JSON.stringify({ user_id: "user-a", data: [{ ...loan, id: "loan-a" }] }),
    JSON.stringify({ user_id: "user-b", data: [{ ...loan, id: "loan-b" }] })
  ].join("\n") + "\n");
  const secret = "do-not-print-this-password";

  try {
    const result = spawnSync(process.execPath, [scriptPath, fixturePath, "--database-env=TEST_DATABASE_URL"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TEST_DATABASE_URL: `postgres://user:${secret}@ bad-host/database` }
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(output, new RegExp(secret));
    assert.match(output, /invalid database URL/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
