import assert from "node:assert/strict";
import test from "node:test";

import { isAdminUser } from "../worker/src/admin-authorization.mjs";

test("admin authorization fails closed for every user without an explicit database grant", async () => {
  const queries = [];
  const sql = async (strings, ...values) => {
    queries.push({ text: strings.join("?"), values });
    return [];
  };

  const user = { id: "oldest-account", email: "allowlisted@example.com" };
  assert.equal(await isAdminUser(sql, user), false);
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /^SELECT user_id FROM admin_users WHERE user_id =/);
  assert.deepEqual(queries[0].values, [user.id]);
});

test("admin authorization accepts only a matching explicit database grant", async () => {
  const sql = async () => [{ user_id: "admin-1" }];

  assert.equal(await isAdminUser(sql, { id: "admin-1", email: "admin@example.com" }), true);
  assert.equal(await isAdminUser(sql, null), false);
});
