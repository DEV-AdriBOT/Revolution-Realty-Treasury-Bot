import { setTimeout as delay } from "node:timers/promises";
import { formatCents } from "./money.js";
import { redact } from "./security.js";
import { parseTreasuryJson } from "./treasury-json.js";

const BASE_URL = process.env.TREASURY_BASE_URL || "https://api.democracycraft.net/economy";

function jsonInteger(value, name) {
  const integer = BigInt(value);
  if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} is outside JavaScript's safe JSON integer range`);
  return Number(integer);
}

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), 30000) : null;
}

export class TreasuryError extends Error {
  constructor(message, { status, code, transient = false, unknownOutcome = false } = {}) {
    super(redact(message));
    this.name = "TreasuryError";
    this.status = status;
    this.code = code;
    this.transient = transient;
    this.unknownOutcome = unknownOutcome;
  }
}

export class TreasuryClient {
  constructor(token, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
    if (!token) throw new Error("Treasury token is required");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = "GET", body, idempotencyKey, retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(`${BASE_URL}${path}`, {
          method,
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        if (attempt < retries) {
          await delay(Math.min(500 * (2 ** attempt), 4000));
          continue;
        }
        throw new TreasuryError(error.message, { code: "NETWORK", transient: true, unknownOutcome: method !== "GET" });
      }
      let payload = {};
      try { payload = parseTreasuryJson(await response.text()); } catch { payload = {}; }
      if (response.ok) return payload;
      const transient = response.status === 429 || response.status >= 500;
      if (transient && attempt < retries) {
        const retryAfter = retryAfterMs(response.headers.get("retry-after"));
        await delay(retryAfter ?? Math.min(500 * (2 ** attempt), 4000));
        continue;
      }
      throw new TreasuryError(payload.message || payload.error || `HTTP ${response.status}`, {
        status: response.status,
        code: payload.error || `HTTP_${response.status}`,
        transient,
        unknownOutcome: transient && method !== "GET",
      });
    }
  }

  me() { return this.request("/api/v1/auth/me"); }
  firmAccounts() { return this.request("/api/v1/firms/me/accounts"); }
  feed(accountId, since = "0", limit = 100) {
    return this.request(`/api/v1/accounts/${encodeURIComponent(String(accountId))}/transactions/feed?since=${encodeURIComponent(String(since))}&limit=${limit}`);
  }
  balance(accountId) { return this.request(`/api/v1/accounts/${encodeURIComponent(String(accountId))}/balance`); }
  listWebhooks() { return this.request("/api/v1/webhooks"); }
  createWebhook(url) { return this.request("/api/v1/webhooks", { method: "POST", body: { url } }); }
  deleteWebhook(id) { return this.request(`/api/v1/webhooks/${id}`, { method: "DELETE" }); }
  transferToAccount({ fromAccountId, toAccountId, amountCents, memo, idempotencyKey }) {
    return this.request("/api/v1/transfers", {
      method: "POST", idempotencyKey,
      body: { fromAccountId: jsonInteger(fromAccountId, "fromAccountId"), toAccountId: jsonInteger(toAccountId, "toAccountId"), amount: formatCents(amountCents), memo },
    });
  }
  transferToPlayer({ fromAccountId, toPlayerUuid, amountCents, memo, idempotencyKey }) {
    return this.request("/api/v1/transfers/to-player", {
      method: "POST", idempotencyKey,
      body: { fromAccountId: jsonInteger(fromAccountId, "fromAccountId"), toPlayerUuid, amount: formatCents(amountCents), memo },
    });
  }
}

export async function validateBusinessAccount(token, accountId) {
  const client = new TreasuryClient(token);
  const me = await client.me();
  if (me.keyType !== "BUSINESS") throw new Error("Treasury key must be BUSINESS");
  const accounts = await client.firmAccounts();
  const account = accounts.find((item) => String(item.accountId) === String(accountId));
  if (!account || account.archived) throw new Error("Business account is not active or is not owned by this firm");
  return { me, account };
}

export async function validatePersonalToken(token, expectedUuid) {
  const client = new TreasuryClient(token);
  const me = await client.me();
  if (me.keyType !== "PERSONAL") throw new Error("Treasury key must be PERSONAL");
  if (String(me.ownerUuid).toLowerCase() !== String(expectedUuid).toLowerCase()) throw new Error("Treasury key owner does not match the verified Minecraft UUID");
  if (!me.accountId) throw new Error("Personal Treasury account is unavailable");
  return { client, me };
}
