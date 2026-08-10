import test from "node:test";
import assert from "node:assert/strict";
import { transferResponseMatches } from "../src/worker.js";

const operation = {
  source_account_id: "120294",
  destination_account_id: "120295",
  destination_uuid: null,
  amount_cents: "150001",
  memo: "RR:SWEEP:1:S084",
};

const confirmed = {
  txnId: "9223372036854775807",
  fromAccountId: "120294",
  toAccountId: "120295",
  amount: "1500.01",
  memo: operation.memo,
  settledAt: "2026-01-01T00:00:00Z",
};

test("a transfer settles only from an exact Treasury confirmation", () => {
  assert.equal(transferResponseMatches(operation, confirmed), true);
  assert.equal(transferResponseMatches(operation, { ...confirmed, amount: "1500.02" }), false);
  assert.equal(transferResponseMatches(operation, { ...confirmed, memo: "wrong" }), false);
  assert.equal(transferResponseMatches(operation, { ...confirmed, settledAt: null }), false);
  assert.equal(transferResponseMatches(operation, { ...confirmed, toAccountId: "9" }), false);
});
