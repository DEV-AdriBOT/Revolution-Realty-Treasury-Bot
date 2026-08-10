import test from "node:test";
import assert from "node:assert/strict";
import { TreasuryClient, retryAfterMs, validatePersonalToken } from "../src/treasury-client.js";
import { parseTreasuryJson } from "../src/treasury-json.js";

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("timeout retry reuses the same idempotency key", async () => {
  const seen = [];
  const fakeFetch = async (_url, options) => {
    seen.push(options.headers["Idempotency-Key"]);
    if (seen.length === 1) throw new Error("socket timeout after accept");
    return response(200, { txnId: 99, fromAccountId: 120294, toAccountId: 7, amount: "0.01", memo: "RR:PAYOUT:1:1", settledAt: "2026-01-01T00:00:00Z" });
  };
  const client = new TreasuryClient("secret", { fetchImpl: fakeFetch });
  const result = await client.transferToPlayer({ fromAccountId: 120294, toPlayerUuid: "00000000-0000-0000-0000-000000000001", amountCents: 1n, memo: "RR:PAYOUT:1:1", idempotencyKey: "stable-key" });
  assert.equal(result.txnId, "99");
  assert.deepEqual(seen, ["stable-key", "stable-key"]);
});

test("429 retry preserves request and key", async () => {
  let calls = 0;
  const client = new TreasuryClient("secret", { fetchImpl: async () => ++calls === 1 ? response(429, {}, { "retry-after": "0" }) : response(200, { txnId: 5 }) });
  await client.transferToAccount({ fromAccountId: 1, toAccountId: 2, amountCents: 10n, memo: "RR:SWEEP:1:X", idempotencyKey: "same" });
  assert.equal(calls, 2);
});

test("Retry-After supports seconds and HTTP dates with a bounded delay", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("999"), 30000);
  assert.equal(retryAfterMs("Thu, 01 Jan 2026 00:00:04 GMT", Date.parse("2026-01-01T00:00:00Z")), 4000);
  assert.equal(retryAfterMs("invalid"), null);
});

test("Treasury int64 IDs and cursors retain exact decimal digits", () => {
  const parsed = parseTreasuryJson('{"accountId":120294,"postingId":9223372036854775806,"nextCursor":9223372036854775807,"amount":"1.00"}');
  assert.equal(parsed.accountId, "120294");
  assert.equal(parsed.postingId, "9223372036854775806");
  assert.equal(parsed.nextCursor, "9223372036854775807");
  assert.equal(parsed.amount, "1.00");
});

test("personal token validation rejects expired, wrong-type, and wrong-owner keys", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => response(401, { error: "TOKEN_EXPIRED" });
    await assert.rejects(validatePersonalToken("expired", "00000000-0000-4000-8000-000000000001"), /TOKEN_EXPIRED/);
    globalThis.fetch = async () => response(200, { keyType: "BUSINESS", ownerUuid: "00000000-0000-4000-8000-000000000001", accountId: 1 });
    await assert.rejects(validatePersonalToken("business", "00000000-0000-4000-8000-000000000001"), /must be PERSONAL/);
    globalThis.fetch = async () => response(200, { keyType: "PERSONAL", ownerUuid: "00000000-0000-4000-8000-000000000002", accountId: 1 });
    await assert.rejects(validatePersonalToken("wrong-owner", "00000000-0000-4000-8000-000000000001"), /does not match/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
