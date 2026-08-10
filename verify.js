import crypto from "node:crypto";
import { parseCents } from "./src/money.js";
import { TreasuryClient } from "./src/treasury-client.js";

const TOKEN = () => process.env.DC_API_TOKEN || null;
const VERIFY_ACCOUNT_ID = () => process.env.VERIFY_ACCOUNT_ID || null;

export function verifyEnabled() {
  return Boolean(TOKEN() && VERIFY_ACCOUNT_ID());
}

export function newMemoCode() {
  return crypto.randomBytes(24).toString("base64url").slice(0, 32);
}

async function ignForUuid(client, uuid) {
  if (!uuid) return null;
  const account = await client.request(`/api/v1/accounts/by-player?uuid=${encodeURIComponent(uuid)}`);
  return account.playerName ?? null;
}

// Verification accepts only an exact memo/message on a positive incoming
// posting. The feed is paged by its opaque int64 cursor instead of scanning a
// fixed-size recent-transactions window.
export async function findVerificationPayment(code, minAmount = "0.01") {
  const token = TOKEN();
  const accountId = VERIFY_ACCOUNT_ID();
  if (!token) return { ok: false, error: "NO_TOKEN" };
  if (!accountId) return { ok: false, error: "NO_ACCOUNT" };

  const minimumCents = parseCents(String(minAmount));
  const client = new TreasuryClient(token);
  let cursor = "0";
  try {
    for (let page = 0; page < 10000; page++) {
      const feed = await client.feed(accountId, cursor, 100);
      for (const posting of feed.items || []) {
        const amountCents = parseCents(String(posting.amount));
        const exactReference = posting.memo === code || posting.message === code;
        if (!exactReference || amountCents < minimumCents || !posting.initiatorUuid) continue;
        return {
          ok: true,
          found: true,
          ign: await ignForUuid(client, posting.initiatorUuid),
          uuid: posting.initiatorUuid,
          txnId: posting.txnId,
          amount: posting.amount,
        };
      }
      const nextCursor = String(feed.nextCursor ?? cursor);
      if (!feed.hasMore) return { ok: true, found: false };
      if (nextCursor === cursor) return { ok: false, error: "CURSOR_STALLED" };
      cursor = nextCursor;
    }
    return { ok: false, error: "PAGE_LIMIT" };
  } catch (error) {
    return { ok: false, error: error.code || "NETWORK", message: error.message };
  }
}
