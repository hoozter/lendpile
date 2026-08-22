import assert from "node:assert/strict";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  saveOwnerLoanData,
  updateSharedLoanAtomically,
} from "../worker/src/sharing.mjs";

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE loan_data (
      user_id text PRIMARY KEY,
      data jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE loan_shares (
      id uuid PRIMARY KEY,
      token text NOT NULL UNIQUE,
      owner_id text NOT NULL,
      loan_id text NOT NULL,
      loan_snapshot jsonb NOT NULL,
      permission text NOT NULL CHECK (permission IN ('view', 'edit')),
      recipient_view text NOT NULL CHECK (recipient_view IN ('borrowing', 'lending')),
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      recipient_id text
    );
  `);
  const sql = async (strings, ...values) => {
    const text = strings.reduce(
      (query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ""),
      "",
    );
    return (await db.query(text, values)).rows;
  };
  return { db, sql };
}

async function seedOwnerAndShares(db) {
  const loans = [
    { id: "keep", name: "Old", interestChanges: [{ rate: 3 }] },
    { id: "remove", name: "Removed", interestChanges: [{ rate: 9 }] },
  ];
  await db.query("INSERT INTO loan_data (user_id, data) VALUES ($1, $2::jsonb)", ["owner", JSON.stringify(loans)]);
  for (const share of [
    { id: "00000000-0000-0000-0000-000000000001", token: "edit-token", loan: loans[0], permission: "edit", recipient: "editor", expires: "2999-01-01" },
    { id: "00000000-0000-0000-0000-000000000002", token: "viewer-token", loan: loans[0], permission: "view", recipient: "viewer", expires: "2999-01-01" },
    { id: "00000000-0000-0000-0000-000000000003", token: "expired-token", loan: loans[0], permission: "edit", recipient: "expired", expires: "2000-01-01" },
    { id: "00000000-0000-0000-0000-000000000004", token: "removed-token", loan: loans[1], permission: "view", recipient: "viewer", expires: "2999-01-01" },
  ]) {
    await db.query(
      `INSERT INTO loan_shares
        (id, token, owner_id, loan_id, loan_snapshot, permission, recipient_view, expires_at, used_at, recipient_id)
       VALUES ($1, $2, 'owner', $3, $4::jsonb, $5, 'borrowing', $6, now(), $7)`,
      [share.id, share.token, share.loan.id, JSON.stringify(share.loan), share.permission, share.expires, share.recipient],
    );
  }
}

test("PostgreSQL owner save refreshes retained snapshots and revokes deleted loans", async (t) => {
  const { db, sql } = await createDatabase();
  t.after(() => db.close());
  await seedOwnerAndShares(db);

  const retained = { id: "keep", name: "Updated", interestChanges: [] };
  await saveOwnerLoanData(sql, "owner", [retained]);

  const owner = (await db.query("SELECT data FROM loan_data WHERE user_id = 'owner'")).rows[0];
  const shares = (await db.query("SELECT token, loan_snapshot FROM loan_shares ORDER BY token")).rows;
  assert.deepEqual(owner.data, [retained]);
  assert.equal(shares.some(({ token }) => token === "removed-token"), false);
  assert.equal(shares.length, 3);
  for (const share of shares) assert.deepEqual(share.loan_snapshot, retained);
});

test("PostgreSQL shared edits require the redeemed editable recipient and refresh every snapshot", async (t) => {
  const { db, sql } = await createDatabase();
  t.after(() => db.close());
  await seedOwnerAndShares(db);

  const before = (await db.query("SELECT data FROM loan_data WHERE user_id = 'owner'")).rows[0].data;
  assert.equal(await updateSharedLoanAtomically(sql, "viewer-token", "viewer", { id: "keep", name: "Forbidden" }), false);
  assert.equal(await updateSharedLoanAtomically(sql, "expired-token", "expired", { id: "keep", name: "Expired" }), false);
  assert.equal(await updateSharedLoanAtomically(sql, "edit-token", "someone-else", { id: "keep", name: "Wrong recipient" }), false);
  assert.deepEqual((await db.query("SELECT data FROM loan_data WHERE user_id = 'owner'")).rows[0].data, before);

  const edited = { id: "attacker-controlled-id", name: "Recipient edit", interestChanges: [] };
  assert.equal(await updateSharedLoanAtomically(sql, "edit-token", "editor", edited), true);

  const owner = (await db.query("SELECT data FROM loan_data WHERE user_id = 'owner'")).rows[0].data;
  const snapshots = (await db.query("SELECT loan_snapshot FROM loan_shares WHERE loan_id = 'keep'")).rows;
  assert.equal(owner[0].id, "keep", "recipient cannot change the authoritative loan id");
  assert.equal(owner[0].name, "Recipient edit");
  for (const share of snapshots) assert.deepEqual(share.loan_snapshot, owner[0]);
});

test("competing owner deletion and recipient edit cannot leave a live orphaned share", async (t) => {
  const { db, sql } = await createDatabase();
  t.after(() => db.close());
  await seedOwnerAndShares(db);

  await Promise.all([
    saveOwnerLoanData(sql, "owner", [{ id: "remove", name: "Owner retained other loan" }]),
    updateSharedLoanAtomically(sql, "edit-token", "editor", { id: "keep", name: "Concurrent recipient edit" }),
  ]);

  const owner = (await db.query("SELECT data FROM loan_data WHERE user_id = 'owner'")).rows[0].data;
  const keepShares = (await db.query("SELECT count(*)::int AS count FROM loan_shares WHERE loan_id = 'keep'")).rows[0].count;
  assert.equal(owner.some((loan) => loan.id === "keep"), false);
  assert.equal(keepShares, 0);
});
