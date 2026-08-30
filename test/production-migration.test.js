import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { buildMigrationPlan, buildGuardedMigrationSql, buildMigrationReadbackSql } from "../scripts/verify-loan-parts-migration.js";

const sourceRows = ["user-a", "user-b"].map((userId, index) => ({
  user_id: userId,
  data: [{
    id: `loan-${index}`,
    name: `Facility ${index}`,
    startDate: "2025-01-01",
    initialAmount: 1000 + index,
    interestRate: 4,
    interestChanges: [{ date: "2025-02-01", rate: 5 }],
    loanChanges: [{ date: "2025-03-01", amount: 250, title: "Draw", note: "Audit" }],
    payments: []
  }]
}));

async function database() {
  const db = new PGlite();
  await db.exec("CREATE TABLE loan_data (user_id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
  for (const row of sourceRows) {
    await db.query("INSERT INTO loan_data (user_id, data) VALUES ($1, $2::jsonb)", [row.user_id, JSON.stringify(row.data)]);
  }
  return db;
}

test("guarded production migration rolls back dry runs and atomically applies the exact two-row plan", async (t) => {
  const plan = buildMigrationPlan(sourceRows, { expectedRows: 2 });
  const db = await database();
  t.after(() => db.close());

  await db.exec(buildGuardedMigrationSql(plan, { apply: false }));
  assert.equal((await db.query(buildMigrationReadbackSql(plan, { applied: false }))).rows[0].status, "PASS");
  let rows = (await db.query("SELECT data FROM loan_data ORDER BY user_id")).rows;
  assert.deepEqual(rows.map(row => row.data), sourceRows.map(row => row.data));

  await db.exec(buildGuardedMigrationSql(plan, { apply: true }));
  assert.equal((await db.query(buildMigrationReadbackSql(plan, { applied: true }))).rows[0].status, "PASS");
  rows = (await db.query("SELECT data FROM loan_data ORDER BY user_id")).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.data[0].schemaVersion, 2);
    assert.equal(row.data[0].loanParts.length, 2);
    assert.equal("initialAmount" in row.data[0], false);
    assert.equal("loanChanges" in row.data[0], false);
    assert.equal("interestRate" in row.data[0], false);
  }
});

test("guarded production migration rejects drift and leaves every row unchanged", async (t) => {
  const plan = buildMigrationPlan(sourceRows, { expectedRows: 2 });
  const db = await database();
  t.after(() => db.close());
  await db.query("UPDATE loan_data SET data = $1::jsonb WHERE user_id = 'user-b'", [JSON.stringify([{ id: "drift" }])]);
  const before = (await db.query("SELECT data FROM loan_data ORDER BY user_id")).rows.map(row => row.data);

  await assert.rejects(db.exec(buildGuardedMigrationSql(plan, { apply: true })), /source data drifted/);
  await db.exec("ROLLBACK");
  const after = (await db.query("SELECT data FROM loan_data ORDER BY user_id")).rows.map(row => row.data);
  assert.deepEqual(after, before);
});
