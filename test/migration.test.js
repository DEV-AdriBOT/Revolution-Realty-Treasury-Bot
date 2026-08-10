import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migrations = ["001_finance.sql", "002_invariants.sql", "003_notification_outbox.sql", "004_finance_hardening.sql"];
const sql = migrations.map((name) => fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")).join("\n");
test("migration contains durable replay and concurrency invariants", () => {
  assert.match(sql, /UNIQUE\(subscription_id, delivery_id\)/);
  assert.match(sql, /UNIQUE\(account_id, posting_id\)/);
  assert.match(sql, /idempotency_key text NOT NULL UNIQUE/);
  assert.match(sql, /audit_events are immutable/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /Ownership snapshots are immutable/);
  assert.match(sql, /Invalid monetary operation transition/);
  assert.match(sql, /company_retained_cents/);
  assert.match(sql, /automatic_retry/);
  assert.match(sql, /account_reconciliation/);
  assert.match(sql, /RESERVE_DEPOSIT/);
  for (const file of migrations) assert.match(sql, new RegExp(`'${file.replace(".sql", "")}'`));
});
