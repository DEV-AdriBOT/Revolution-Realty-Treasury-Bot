import test from "node:test";
import assert from "node:assert/strict";
import { parseCents, formatCents, allocateRental, allocateLiability, incrementalDebtForRefund } from "../src/money.js";

test("money boundary uses exact decimal strings", () => {
  assert.equal(parseCents("1500.00"), 150000n);
  assert.equal(parseCents("0.01"), 1n);
  assert.equal(formatCents(-123n), "-1.23");
  assert.throws(() => parseCents("1.001"));
  assert.throws(() => parseCents(1.01));
});

test("5/95 split and odd-cent remainder go to company", () => {
  const result = allocateRental(101n, [{ shareholderId: 1, basisPoints: 5000 }, { shareholderId: 2, basisPoints: 5000 }]);
  assert.equal(result.shareholderPoolCents, 95n);
  assert.deepEqual(result.shares.map((x) => x.cents), [47n, 47n]);
  assert.equal(result.companyCents, 7n);
});

test("supports 80/20, 100/0 and three shareholders", () => {
  assert.deepEqual(allocateRental(10000n, [{ shareholderId: 1, basisPoints: 8000 }, { shareholderId: 2, basisPoints: 2000 }]).shares.map((x) => x.cents), [7600n, 1900n]);
  assert.deepEqual(allocateRental(10000n, [{ shareholderId: 1, basisPoints: 10000 }, { shareholderId: 2, basisPoints: 0 }]).shares.map((x) => x.cents), [9500n, 0n]);
  assert.deepEqual(allocateRental(10001n, [{ shareholderId: 1, basisPoints: 3334 }, { shareholderId: 2, basisPoints: 3333 }, { shareholderId: 3, basisPoints: 3333 }]).shares.map((x) => x.cents), [3167n, 3166n, 3166n]);
});

test("full refund keeps company fee and shareholders absorb refund", () => {
  const rent = allocateRental(150000n, [{ shareholderId: 1, basisPoints: 5000 }, { shareholderId: 2, basisPoints: 5000 }]);
  const liabilities = allocateLiability(140000n, [{ shareholderId: 1, basisPoints: 5000 }, { shareholderId: 2, basisPoints: 5000 }]);
  assert.equal(rent.shareholderPoolCents, 142500n);
  assert.equal(rent.companyCents, 7500n);
  assert.equal(liabilities.reduce((sum, x) => sum + x.cents, 0n), 140000n);
});

test("allocation totals must be exact", () => {
  assert.throws(() => allocateRental(100n, [{ shareholderId: 1, basisPoints: 9999 }]));
});

test("refund before payout nets first and only excess becomes debt", () => {
  assert.equal(incrementalDebtForRefund({ entitlementCents: 71250n, paidCents: 0n, existingLiabilityCents: 0n, addedLiabilityCents: 70000n }), 0n);
  assert.equal(incrementalDebtForRefund({ entitlementCents: 71250n, paidCents: 0n, existingLiabilityCents: 70000n, addedLiabilityCents: 2500n }), 1250n);
});

test("refund after payout and partial payout create only unrecoverable incremental debt", () => {
  assert.equal(incrementalDebtForRefund({ entitlementCents: 71250n, paidCents: 71250n, existingLiabilityCents: 0n, addedLiabilityCents: 70000n }), 70000n);
  assert.equal(incrementalDebtForRefund({ entitlementCents: 71250n, paidCents: 50000n, existingLiabilityCents: 0n, addedLiabilityCents: 70000n }), 48750n);
});
