import { pool } from "./database.js";
import { claimOperation, finishOperation, recoverStaleOperations } from "./finance-repository.js";
import { TreasuryClient, TreasuryError } from "./treasury-client.js";
import { parseEncryptionKeys, decryptToken, redact } from "./security.js";
import { enqueueNotification } from "./notifications.js";
import { parseCents } from "./money.js";

let stopping = false;
let inFlight = null;

export function transferResponseMatches(operation, response) {
  try {
    return response.txnId != null
      && Boolean(response.settledAt) && Number.isFinite(Date.parse(response.settledAt))
      && String(response.fromAccountId) === String(operation.source_account_id)
      && parseCents(String(response.amount)) === BigInt(operation.amount_cents)
      && response.memo === operation.memo
      && (Boolean(operation.destination_uuid) || String(response.toAccountId) === String(operation.destination_account_id));
  } catch { return false; }
}

async function tokenForOperation(operation) {
  if (operation.operation_type !== "SWEEP") return process.env.TREASURY_BUSINESS_TOKEN;
  const row = (await pool.query(
    `SELECT s.token_key_version version,s.token_nonce nonce,s.token_tag tag,s.token_ciphertext ciphertext
     FROM rentals r JOIN shareholders s ON s.id=r.landlord_shareholder_id WHERE r.id=$1`, [operation.workflow_id]
  )).rows[0];
  if (!row?.ciphertext) throw new Error("Landlord Treasury connection is unavailable");
  return decryptToken(row, parseEncryptionKeys());
}

async function execute(operation) {
  try {
    const token = await tokenForOperation(operation);
    if (!token) throw new Error("Required Treasury key is unavailable");
    const client = new TreasuryClient(token);
    const balance = parseCents(String((await client.balance(operation.source_account_id)).balance));
    if (balance < BigInt(operation.amount_cents)) {
      throw new TreasuryError("Source account has insufficient available balance", { code: "INSUFFICIENT_RESERVE" });
    }
    const response = operation.destination_uuid
      ? await client.transferToPlayer({ fromAccountId: operation.source_account_id, toPlayerUuid: operation.destination_uuid, amountCents: operation.amount_cents, memo: operation.memo, idempotencyKey: operation.idempotency_key })
      : await client.transferToAccount({ fromAccountId: operation.source_account_id, toAccountId: operation.destination_account_id, amountCents: operation.amount_cents, memo: operation.memo, idempotencyKey: operation.idempotency_key });
    if (!transferResponseMatches(operation, response)) throw new TreasuryError("Treasury transfer response was missing settlement proof or did not match the stored request", { code: "TRANSFER_CONFIRMATION_MISMATCH", unknownOutcome: true, transient: true });
    await finishOperation(operation.id, { status: "SETTLED", txnId: response.txnId });
  } catch (error) {
    const unknown = error instanceof TreasuryError && error.unknownOutcome;
    const reserveShortage = error instanceof TreasuryError && error.code === "INSUFFICIENT_RESERVE";
    const automaticRetry = unknown || reserveShortage || (error instanceof TreasuryError && error.transient);
    await finishOperation(operation.id, { status: unknown ? "UNKNOWN" : "FAILED", error: redact(error), automaticRetry });
    const day = new Date().toISOString().slice(0, 10);
    await enqueueNotification(pool, {
      dedupeKey: reserveShortage ? `RESERVE_SHORTFALL:${operation.source_account_id}:${day}` : `OP_FAILURE:${operation.id}:${operation.attempt_count}`,
      eventType: reserveShortage ? "RESERVE_SHORTFALL" : "OPERATION_FAILED",
      message: reserveShortage
        ? `Refund reserve shortfall on Treasury account ${operation.source_account_id}. Oldest queued reimbursement remains unpaid and will be retried after funding.`
        : `Financial operation ${operation.id} (${operation.operation_type}) ${unknown ? "has an unknown Treasury outcome" : "failed"}. Its stable idempotency key is retained for safe retry.`,
    });
  }
}

export async function runWorkerTick() {
  if ((process.env.FINANCE_MODE || "disabled") !== "live") return false;
  await recoverStaleOperations();
  const enabled = (await pool.query("SELECT bool_or(finance_mode='live') any_live,bool_or(emergency_disabled) emergency FROM guild_config")).rows[0];
  if (!enabled?.any_live || enabled.emergency) return false;
  const operation = await claimOperation();
  if (!operation) return false;
  await execute(operation);
  return true;
}

export function startWorker() {
  stopping = false;
  const tick = () => {
    if (stopping || inFlight) return;
    inFlight = runWorkerTick()
      .catch((error) => console.error("finance worker", redact(error)))
      .finally(() => { inFlight = null; });
  };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await inFlight;
  };
}

export async function drainWorker() {
  stopping = true;
  await inFlight;
}
