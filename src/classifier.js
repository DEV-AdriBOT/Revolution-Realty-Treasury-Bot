const RENT = /^Rental Payment: ([A-Z][A-Z0-9]{2,15})$/;
const REFUND = /^Early Lease Termination Refund: ([A-Z][A-Z0-9]{2,15})$/;
const INTERNAL = /^RR:(SWEEP|PAYOUT|REFUND|FUND):[A-Z0-9:-]+$/i;

export function classifyPosting(posting, expectedPluginSystem, leaseholdReferences = new Map()) {
  const amount = BigInt(posting.amountCents);
  const texts = [...new Set([posting.memo, posting.message].filter((value) => typeof value === "string" && value.length > 0))];
  if (texts.length > 1) return { type: "UNCLASSIFIED", reason: "AMBIGUOUS_MEMO_AND_MESSAGE" };
  const text = texts[0] || "";
  if (INTERNAL.test(text)) {
    const operation = text.split(":")[1].toUpperCase();
    return { type: operation === "FUND" ? "FUND_LANDLORD" : operation, internal: true };
  }
  if (leaseholdReferences.has(text)) {
    if (amount <= 0n) return { type: "UNCLASSIFIED", reason: "LEASEHOLD_WRONG_DIRECTION" };
    return { type: "LEASEHOLD", leaseholdId: leaseholdReferences.get(text) };
  }
  if (!expectedPluginSystem) return { type: "UNCLASSIFIED", reason: "REALTY_PLUGIN_SYSTEM_NOT_VERIFIED" };
  if (posting.pluginSystem !== expectedPluginSystem) return { type: "UNCLASSIFIED", reason: "PLUGIN_SYSTEM_MISMATCH" };
  const rent = RENT.exec(text);
  if (rent && amount > 0n) return { type: "RENT", region: rent[1] };
  const refund = REFUND.exec(text);
  if (refund && amount < 0n) return { type: "REFUND", region: refund[1] };
  if (rent || refund) return { type: "UNCLASSIFIED", reason: "REALTY_DIRECTION_MISMATCH" };
  return { type: "UNCLASSIFIED", reason: "NO_EXACT_CLASSIFIER" };
}
