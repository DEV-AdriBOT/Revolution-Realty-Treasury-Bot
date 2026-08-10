export function parseCents(value) {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new TypeError("Money must be a decimal string with at most two decimals");
  }
  const negative = value.startsWith("-");
  const clean = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = clean.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function formatCents(cents) {
  if (typeof cents !== "bigint") cents = BigInt(cents);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

export function allocateRental(grossCents, allocations) {
  grossCents = BigInt(grossCents);
  validateAllocations(allocations);
  if (grossCents <= 0n) throw new RangeError("Gross rental must be positive");
  const shareholderPool = (grossCents * 9500n) / 10000n;
  const shares = allocations.map(({ shareholderId, basisPoints }) => ({
    shareholderId,
    basisPoints,
    cents: (shareholderPool * BigInt(basisPoints)) / 10000n,
  }));
  const distributed = shares.reduce((sum, item) => sum + item.cents, 0n);
  return {
    grossCents,
    shareholderPoolCents: shareholderPool,
    companyCents: grossCents - distributed,
    shares,
  };
}

export function allocateLiability(refundCents, allocations) {
  refundCents = BigInt(refundCents);
  validateAllocations(allocations);
  if (refundCents <= 0n) throw new RangeError("Refund must be positive");
  let remaining = refundCents;
  return allocations.map((allocation, index) => {
    const cents = index === allocations.length - 1
      ? remaining
      : (refundCents * BigInt(allocation.basisPoints)) / 10000n;
    remaining -= cents;
    return { ...allocation, cents };
  });
}

export function validateAllocations(allocations) {
  if (!Array.isArray(allocations) || allocations.length === 0) throw new TypeError("At least one allocation is required");
  const ids = new Set();
  let total = 0;
  for (const item of allocations) {
    if (!item.shareholderId || ids.has(item.shareholderId)) throw new TypeError("Shareholders must be unique");
    if (!Number.isInteger(item.basisPoints) || item.basisPoints < 0 || item.basisPoints > 10000) throw new RangeError("Invalid basis points");
    ids.add(item.shareholderId);
    total += item.basisPoints;
  }
  if (total !== 10000) throw new RangeError("Allocations must total exactly 10,000 basis points");
}

export function incrementalDebtForRefund({ entitlementCents, paidCents, existingLiabilityCents, addedLiabilityCents }) {
  const entitlement = BigInt(entitlementCents);
  const paid = BigInt(paidCents);
  const existing = BigInt(existingLiabilityCents);
  const added = BigInt(addedLiabilityCents);
  const unpaidCapacity = entitlement > paid ? entitlement - paid : 0n;
  const before = existing > unpaidCapacity ? existing - unpaidCapacity : 0n;
  const afterLiability = existing + added;
  const after = afterLiability > unpaidCapacity ? afterLiability - unpaidCapacity : 0n;
  return after - before;
}
