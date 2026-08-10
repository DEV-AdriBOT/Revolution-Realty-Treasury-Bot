import test from "node:test";
import assert from "node:assert/strict";
import { classifyPosting } from "../src/classifier.js";

const base = { amountCents: 100n, memo: "Rental Payment: S084", message: null, pluginSystem: "Realty" };
test("only exact Realty rent and refund shapes classify", () => {
  assert.deepEqual(classifyPosting(base, "Realty"), { type: "RENT", region: "S084" });
  assert.deepEqual(classifyPosting({ ...base, amountCents: -50n, memo: "Early Lease Termination Refund: S084" }, "Realty"), { type: "REFUND", region: "S084" });
  assert.equal(classifyPosting({ ...base, memo: "x Rental Payment: S084" }, "Realty").type, "UNCLASSIFIED");
  assert.equal(classifyPosting({ ...base, message: "different text" }, "Realty").reason, "AMBIGUOUS_MEMO_AND_MESSAGE");
  assert.equal(classifyPosting({ ...base, pluginSystem: "ChestShop" }, "Realty").type, "UNCLASSIFIED");
  assert.equal(classifyPosting(base, null).reason, "REALTY_PLUGIN_SYSTEM_NOT_VERIFIED");
});

test("wrong directions never classify as Realty events", () => {
  assert.equal(classifyPosting({ ...base, amountCents: -1n }, "Realty").type, "UNCLASSIFIED");
  assert.equal(classifyPosting({ ...base, memo: "Early Lease Termination Refund: S084" }, "Realty").type, "UNCLASSIFIED");
});

test("internal sweep is not recursively rented", () => {
  const internal = classifyPosting({ ...base, memo: "RR:SWEEP:42:S084", pluginSystem: null }, "Realty");
  assert.equal(internal.type, "SWEEP");
  assert.equal(internal.internal, true);
  assert.equal(classifyPosting({ ...base, amountCents: -50n, memo: "Early Lease Termination Refund: S084" }, "Realty").internal, undefined);
});
