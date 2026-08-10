import crypto from "node:crypto";
import { withTransaction, pool } from "./database.js";
import { allocateRental, allocateLiability, incrementalDebtForRefund, parseCents } from "./money.js";
import { classifyPosting } from "./classifier.js";
import { hashFingerprint } from "./security.js";
import { enqueueNotification } from "./notifications.js";

function stableKey(type, workflowId, leg) {
  return `rr-${type.toLowerCase()}-${workflowId}-${leg}-${crypto.createHash("sha256").update(`${type}:${workflowId}:${leg}`).digest("hex").slice(0, 16)}`;
}

export async function subscriptionForTreasuryId(id) {
  return (await pool.query("SELECT * FROM treasury_subscriptions WHERE treasury_webhook_id=$1 AND active", [id])).rows[0] || null;
}

async function configForSubscription(db, subscription, accountId) {
  if (subscription?.guild_id) {
    return (await db.query("SELECT * FROM guild_config WHERE guild_id=$1", [subscription.guild_id])).rows[0];
  }
  return (await db.query(
    `SELECT * FROM guild_config
     ORDER BY (business_account_id=$1) DESC NULLS LAST,updated_at DESC LIMIT 1`,
    [accountId]
  )).rows[0];
}

async function validateInternalPosting(db, posting, classification) {
  const operation = (await db.query(
    `SELECT mo.*,destination.account_id destination_personal_account_id
     FROM monetary_operations mo
     LEFT JOIN shareholders destination ON destination.owner_uuid=mo.destination_uuid
     WHERE mo.memo=$1 ORDER BY mo.id DESC LIMIT 1`,
    [posting.memo || posting.message]
  )).rows[0];
  if (!operation) return { type: "UNCLASSIFIED", reason: "UNKNOWN_INTERNAL_MEMO" };
  const amount = BigInt(posting.amount_cents);
  const expected = BigInt(operation.amount_cents);
  const sourceDebit = String(posting.account_id) === String(operation.source_account_id) && amount === -expected;
  const accountCredit = operation.destination_account_id
    && String(posting.account_id) === String(operation.destination_account_id) && amount === expected;
  const playerCredit = operation.destination_personal_account_id
    && String(posting.account_id) === String(operation.destination_personal_account_id) && amount === expected;
  const transactionMatches = !operation.treasury_txn_id || String(operation.treasury_txn_id) === String(posting.txn_id);
  if ((!sourceDebit && !accountCredit && !playerCredit) || !transactionMatches) {
    return { type: "UNCLASSIFIED", reason: "INTERNAL_POSTING_MISMATCH" };
  }
  return {
    ...classification,
    operation,
    settlementProof: sourceDebit || (Boolean(operation.treasury_txn_id) && (accountCredit || playerCredit)),
  };
}

export async function ingestDelivery({ subscription, headers, payload, source = "webhook" }) {
  return withTransaction(async (db) => {
    if (source === "webhook") {
      const delivery = await db.query(
        `INSERT INTO webhook_deliveries(subscription_id,delivery_id,event_name,body_event_name,body_delivery_id,payload)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(subscription_id,delivery_id) DO NOTHING RETURNING id`,
        [subscription.id, String(headers.delivery), headers.event, payload.event, String(payload.deliveryId), payload]
      );
      if (!delivery.rowCount) return { duplicate: true };
    }
    const t = payload.transaction;
    const amountCents = parseCents(t.amount);
    const posting = await db.query(
      `INSERT INTO treasury_postings(account_id,posting_id,txn_id,amount_cents,memo,message,settled_at,initiator_uuid,plugin_system,source,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(account_id,posting_id) DO NOTHING RETURNING *`,
      [payload.accountId, t.postingId, t.txnId, amountCents.toString(), t.memo, t.message, t.settledAt, t.initiatorUuid || null, t.pluginSystem, source, payload]
    );
    if (!posting.rowCount) {
      if (source === "webhook") await db.query("UPDATE webhook_deliveries SET processed_at=now() WHERE subscription_id=$1 AND delivery_id=$2", [subscription.id, String(headers.delivery)]);
      return { duplicatePosting: true };
    }
    const config = await configForSubscription(db, subscription, payload.accountId);
    const refs = new Map((await db.query(
      "SELECT id,payment_reference FROM leaseholds WHERE status<>'CLOSED' AND (guild_id IS NULL OR guild_id=$1)",
      [config?.guild_id || null]
    )).rows.map((row) => [row.payment_reference, row.id]));
    let result = classifyPosting({ ...posting.rows[0], amountCents, pluginSystem: posting.rows[0].plugin_system }, config?.plugin_system, refs);
    if (result.internal) {
      result = await validateInternalPosting(db, posting.rows[0], result);
    }
    await db.query("UPDATE treasury_postings SET classification=$2 WHERE id=$1", [posting.rows[0].id, result.type]);
    if (result.operation && result.settlementProof && !["SETTLED", "CANCELLED"].includes(result.operation.status)) {
      const settled = (await db.query(
        `UPDATE monetary_operations SET status='SETTLED',treasury_txn_id=$2,automatic_retry=false,claimed_at=NULL,last_error=NULL,updated_at=now()
         WHERE id=$1 AND status<>'CANCELLED' RETURNING *`, [result.operation.id, posting.rows[0].txn_id]
      )).rows[0];
      if (settled) await applySettledOperation(db, settled);
    }
    if (result.type === "RENT") await createRental(db, posting.rows[0], amountCents, result.region, config);
    else if (result.type === "REFUND") await createRefund(db, posting.rows[0], -amountCents, result.region, config);
    else if (result.type === "LEASEHOLD") await settleLeasehold(db, posting.rows[0], amountCents, result.leaseholdId, config);
    else if (result.type === "UNCLASSIFIED") await db.query("INSERT INTO unclassified_transactions(posting_id,reason) VALUES($1,$2)", [posting.rows[0].id, result.reason]);
    if (source === "webhook") {
      await db.query("UPDATE webhook_deliveries SET processed_at=now() WHERE subscription_id=$1 AND delivery_id=$2", [subscription.id, String(headers.delivery)]);
    }
    return { postingId: posting.rows[0].id, classification: result.type };
  }, "SERIALIZABLE");
}

async function createRental(db, posting, grossCents, region, config) {
  const property = (await db.query(
    `SELECT p.*,ov.id ownership_version_id FROM properties p
     JOIN LATERAL (SELECT id FROM ownership_versions WHERE property_id=p.id AND effective_at <= $2 ORDER BY effective_at DESC,version DESC LIMIT 1) ov ON true
     WHERE p.region=$1 AND p.status='ACTIVE' FOR UPDATE OF p`, [region, posting.settled_at]
  )).rows[0];
  if (!property || !config?.business_account_id) {
    await db.query("INSERT INTO unclassified_transactions(posting_id,reason) VALUES($1,$2)", [posting.id, !property ? "PROPERTY_NOT_ACTIVE" : "BUSINESS_ACCOUNT_NOT_CONFIGURED"]);
    await db.query("UPDATE treasury_postings SET classification='UNCLASSIFIED' WHERE id=$1", [posting.id]);
    return;
  }
  const landlord = (await db.query("SELECT account_id FROM shareholders WHERE id=$1", [property.landlord_shareholder_id])).rows[0];
  if (!landlord?.account_id || String(landlord.account_id) !== String(posting.account_id)) {
    await db.query("INSERT INTO unclassified_transactions(posting_id,reason) VALUES($1,'LANDLORD_ACCOUNT_MISMATCH')", [posting.id]);
    await db.query("UPDATE treasury_postings SET classification='UNCLASSIFIED' WHERE id=$1", [posting.id]);
    return;
  }
  const allocations = (await db.query("SELECT shareholder_id,basis_points FROM ownership_allocations WHERE ownership_version_id=$1 ORDER BY shareholder_id", [property.ownership_version_id])).rows.map((row) => ({ shareholderId: row.shareholder_id, basisPoints: row.basis_points }));
  const split = allocateRental(grossCents, allocations);
  const rental = (await db.query(
    `INSERT INTO rentals(property_id,ownership_version_id,landlord_shareholder_id,original_account_id,business_account_id,posting_id,txn_id,gross_cents,company_retained_cents,settled_at,hold_until,sweep_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10::timestamptz + interval '168 hours',$11) RETURNING *`,
    [property.id, property.ownership_version_id, property.landlord_shareholder_id, posting.account_id, config.business_account_id, posting.id, posting.txn_id, grossCents.toString(), split.companyCents.toString(), posting.settled_at, config.finance_mode === "live" && !config.emergency_disabled ? "PENDING" : "SHADOW"]
  )).rows[0];
  for (const share of split.shares) {
    await db.query("INSERT INTO rental_allocations(rental_id,shareholder_id,basis_points,gross_entitlement_cents) VALUES($1,$2,$3,$4)", [rental.id, share.shareholderId, share.basisPoints, share.cents.toString()]);
  }
  const memo = `RR:SWEEP:${rental.id}:${region}`;
  const key = stableKey("SWEEP", rental.id, "gross");
  const fingerprint = hashFingerprint(JSON.stringify({ from: posting.account_id, to: config.business_account_id, amount: grossCents.toString(), memo }));
  await db.query(
    `INSERT INTO monetary_operations(operation_type,workflow_type,workflow_id,leg_key,source_account_id,destination_account_id,amount_cents,memo,idempotency_key,request_fingerprint,status)
     VALUES('SWEEP','RENTAL',$1,'gross',$2,$3,$4,$5,$6,$7,$8)`,
    [rental.id, posting.account_id, config.business_account_id, grossCents.toString(), memo, key, fingerprint, config.finance_mode === "live" ? "PENDING" : "SHADOW"]
  );
  const ledger = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('RENT_DETECTED','RENTAL',$1,$2) RETURNING id", [rental.id, `Rental ${region}`])).rows[0];
  await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'TREASURY_CASH',$2)", [ledger.id, grossCents.toString()]);
  await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'HELD_FUNDS',$2)", [ledger.id, grossCents.toString()]);
  await enqueueNotification(db, { dedupeKey: `RENT:${rental.id}`, eventType: "RENT_DETECTED", message: `Rent detected: ${region}, gross ${grossCents} cents. Sweep ${rental.sweep_status}; hold ends ${new Date(rental.hold_until).toISOString()}.` });
}

async function createRefund(db, posting, amountCents, region, config) {
  const property = (await db.query("SELECT * FROM properties WHERE region=$1 FOR UPDATE", [region])).rows[0];
  if (!property) {
    await db.query("INSERT INTO unclassified_transactions(posting_id,reason) VALUES($1,'UNKNOWN_REFUND_PROPERTY')", [posting.id]);
    await db.query("UPDATE treasury_postings SET classification='UNCLASSIFIED' WHERE id=$1", [posting.id]);
    return;
  }
  const detectedLandlord = (await db.query("SELECT * FROM shareholders WHERE account_id=$1 FOR UPDATE", [posting.account_id])).rows[0];
  if (!detectedLandlord) {
    await db.query("INSERT INTO unclassified_transactions(posting_id,reason) VALUES($1,'REFUND_ACCOUNT_NOT_CONNECTED_LANDLORD')", [posting.id]);
    await db.query("UPDATE treasury_postings SET classification='UNCLASSIFIED' WHERE id=$1", [posting.id]);
    return;
  }
  const candidates = (await db.query(
    `SELECT * FROM rentals WHERE property_id=$1 AND landlord_shareholder_id=$4 AND settled_at <= $2 AND gross_cents-total_refunded_cents >= $3
     ORDER BY settled_at DESC,id DESC LIMIT 2 FOR UPDATE`, [property.id, posting.settled_at, amountCents.toString(), detectedLandlord.id]
  )).rows;
  const ambiguous = candidates.length !== 1;
  const rental = ambiguous ? null : candidates[0];
  const refund = (await db.query(
    `INSERT INTO refunds(property_id,rental_id,landlord_shareholder_id,posting_id,amount_cents,matched_status,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [property.id, rental?.id || null, detectedLandlord.id, posting.id, amountCents.toString(), rental ? "MATCHED" : "REVIEW_REQUIRED", rental ? null : `Expected exactly one compatible rental; found ${candidates.length}`]
  )).rows[0];
  if (!rental) {
    await enqueueNotification(db, { dedupeKey: `REFUND_REVIEW:${refund.id}`, eventType: "REFUND_REVIEW", message: `Refund ${refund.id} for ${region} requires manager review; no transfer was invented.` });
    return;
  }
  const operationStatus = config?.finance_mode === "live" && !config.emergency_disabled && process.env.FINANCE_MODE === "live" ? "PENDING" : "SHADOW";
  await applyMatchedRefund(db, { refund, rental, amountCents, region, landlord: detectedLandlord, operationStatus });
}

async function applyMatchedRefund(db, { refund, rental, amountCents, region, landlord, operationStatus }) {
  await db.query("UPDATE rentals SET total_refunded_cents=total_refunded_cents+$2 WHERE id=$1", [rental.id, amountCents.toString()]);
  const snapshot = (await db.query("SELECT shareholder_id,basis_points FROM rental_allocations WHERE rental_id=$1 ORDER BY shareholder_id", [rental.id])).rows.map((row) => ({ shareholderId: row.shareholder_id, basisPoints: row.basis_points }));
  let createdDebtCents = 0n;
  for (const liability of allocateLiability(amountCents, snapshot)) {
    const allocation = (await db.query("SELECT * FROM rental_allocations WHERE rental_id=$1 AND shareholder_id=$2 FOR UPDATE", [rental.id, liability.shareholderId])).rows[0];
    const entitlement = BigInt(allocation.gross_entitlement_cents);
    const committedPayout = BigInt((await db.query(
      `SELECT COALESCE(sum(amount_cents),0) amount FROM monetary_operations
       WHERE workflow_type='RENTAL' AND workflow_id=$1 AND leg_key=$2 AND status<>'CANCELLED'`,
      [rental.id, `shareholder-${liability.shareholderId}`]
    )).rows[0].amount);
    const paid = BigInt(allocation.paid_cents);
    const debtRecovered = BigInt(allocation.debt_recovered_cents);
    const committed = (committedPayout > paid ? committedPayout : paid) + debtRecovered;
    const previousLiability = BigInt(allocation.refund_liability_cents);
    const newLiability = previousLiability + liability.cents;
    const incrementalDebt = incrementalDebtForRefund({ entitlementCents: entitlement, paidCents: committed, existingLiabilityCents: previousLiability, addedLiabilityCents: liability.cents });
    await db.query("UPDATE rental_allocations SET refund_liability_cents=$3,status=CASE WHEN paid_cents>0 THEN 'PAID' ELSE 'NETTED' END WHERE rental_id=$1 AND shareholder_id=$2", [rental.id, liability.shareholderId, newLiability.toString()]);
    if (incrementalDebt > 0n) {
      createdDebtCents += incrementalDebt;
      await db.query("INSERT INTO shareholder_debts(shareholder_id,source_refund_id,original_cents,outstanding_cents) VALUES($1,$2,$3,$3)", [liability.shareholderId, refund.id, incrementalDebt.toString()]);
    }
  }
  const memo = `RR:REFUND:${refund.id}:${region}`;
  const key = stableKey("REFUND", refund.id, "landlord");
  await db.query(
    `INSERT INTO monetary_operations(operation_type,workflow_type,workflow_id,leg_key,source_account_id,destination_uuid,amount_cents,memo,idempotency_key,request_fingerprint,status)
     VALUES('REFUND_REIMBURSEMENT','REFUND',$1,'landlord',$2,$3,$4,$5,$6,$7,$8)`,
    [refund.id, rental.business_account_id, landlord.owner_uuid, amountCents.toString(), memo, key,
      hashFingerprint(JSON.stringify({ from: rental.business_account_id, to: landlord.owner_uuid, amount: amountCents.toString(), memo })),
      operationStatus]
  );
  const ledger = (await db.query(
    "INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('REFUND_DETECTED','REFUND',$1,$2) RETURNING id",
    [refund.id, `Refund ${region}`]
  )).rows[0];
  // The reserve bridges the landlord reimbursement and is replenished by the
  // responsible ownership snapshot, from held allocations or durable debt.
  await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'REFUND_RESERVE',$2)", [ledger.id, amountCents.toString()]);
  await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'QUEUED_REIMBURSEMENT',$2)", [ledger.id, amountCents.toString()]);
  const coveredByHold = amountCents - createdDebtCents;
  if (coveredByHold > 0n) {
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'HELD_FUNDS',$2)", [ledger.id, coveredByHold.toString()]);
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'REFUND_RESERVE',$2)", [ledger.id, coveredByHold.toString()]);
  }
  if (createdDebtCents > 0n) {
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'SHAREHOLDER_DEBT',$2)", [ledger.id, createdDebtCents.toString()]);
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'REFUND_RESERVE',$2)", [ledger.id, createdDebtCents.toString()]);
  }
  await enqueueNotification(db, { dedupeKey: `REFUND:${refund.id}`, eventType: "REFUND_DETECTED", message: `Refund detected: ${region}, ${amountCents} cents. Matched to rental ${rental.id}; landlord reimbursement queued.` });
}

export async function matchRefundByManager(db, refundId, rentalId) {
  const refund = (await db.query(
    `SELECT f.*,tp.account_id,tp.settled_at posting_settled_at,p.region
     FROM refunds f JOIN treasury_postings tp ON tp.id=f.posting_id JOIN properties p ON p.id=f.property_id
     WHERE f.id=$1 FOR UPDATE OF f`, [refundId]
  )).rows[0];
  if (!refund || refund.matched_status !== "REVIEW_REQUIRED" || refund.rental_id) throw new Error("Refund is not awaiting a manager match");
  const rental = (await db.query(
    `SELECT * FROM rentals WHERE id=$1 AND property_id=$2 AND landlord_shareholder_id=$3 FOR UPDATE`,
    [rentalId, refund.property_id, refund.landlord_shareholder_id]
  )).rows[0];
  if (!rental) throw new Error("Rental is not compatible with this refund's property and landlord snapshot");
  if (new Date(rental.settled_at) > new Date(refund.posting_settled_at)) throw new Error("Refund cannot precede its rental");
  if (BigInt(rental.gross_cents) - BigInt(rental.total_refunded_cents) < BigInt(refund.amount_cents)) throw new Error("Refund exceeds the rental's remaining refundable amount");
  const landlord = (await db.query("SELECT * FROM shareholders WHERE id=$1", [refund.landlord_shareholder_id])).rows[0];
  const finance = (await db.query("SELECT bool_or(finance_mode='live') any_live,bool_or(emergency_disabled) emergency FROM guild_config")).rows[0];
  const operationStatus = process.env.FINANCE_MODE === "live" && finance?.any_live && !finance.emergency ? "PENDING" : "SHADOW";
  await db.query("UPDATE refunds SET rental_id=$2,matched_status='MATCHED',reason='Manager selected an explicit compatible rental' WHERE id=$1", [refundId, rentalId]);
  await applyMatchedRefund(db, { refund: { ...refund, rental_id: rentalId }, rental, amountCents: BigInt(refund.amount_cents), region: refund.region, landlord, operationStatus });
  return { refund, rental };
}

async function settleLeasehold(db, posting, amountCents, leaseholdId, config) {
  const charge = (await db.query("SELECT * FROM leasehold_charges WHERE leasehold_id=$1 AND status IN ('DUE','ARREARS') ORDER BY due_at LIMIT 1 FOR UPDATE", [leaseholdId])).rows[0];
  const leasehold = (await db.query("SELECT * FROM leaseholds WHERE id=$1", [leaseholdId])).rows[0];
  const correctBusinessAccount = config?.business_account_id
    && String(posting.account_id) === String(config.business_account_id);
  if (!charge || !correctBusinessAccount || amountCents !== BigInt(charge.amount_cents)
      || String(posting.initiator_uuid || "").toLowerCase() !== String(leasehold?.payer_uuid || "").toLowerCase()) {
    await db.query("INSERT INTO unclassified_transactions(posting_id,reason) VALUES($1,'LEASEHOLD_PAYER_OR_AMOUNT_MISMATCH')", [posting.id]);
    await db.query("UPDATE treasury_postings SET classification='UNCLASSIFIED' WHERE id=$1", [posting.id]);
    return;
  }
  await db.query("UPDATE leasehold_charges SET status='PAID',posting_id=$2,paid_at=now() WHERE id=$1", [charge.id, posting.id]);
  await db.query("UPDATE leaseholds SET next_due_at=next_due_at + (interval '1 day' * interval_days) WHERE id=$1", [leaseholdId]);
  await db.query(
    `UPDATE leaseholds l SET status=CASE WHEN EXISTS(
       SELECT 1 FROM leasehold_charges c WHERE c.leasehold_id=l.id AND c.status='ARREARS'
     ) THEN 'ARREARS' ELSE 'ACTIVE' END WHERE l.id=$1`, [leaseholdId]
  );
  const ledger = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('LEASEHOLD_PAID','LEASEHOLD',$1,'Permanent leasehold management fee') RETURNING id", [leaseholdId])).rows[0];
  await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'TREASURY_CASH',$2)", [ledger.id, amountCents.toString()]);
  await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'COMPANY_RETAINED',$2)", [ledger.id, amountCents.toString()]);
  await enqueueNotification(db, { dedupeKey: `LEASEHOLD_PAID:${charge.id}`, eventType: "LEASEHOLD_PAID", message: `Permanent leasehold payment ${charge.id} settled for ${amountCents} cents and was classified entirely as company revenue.` });
}

export async function claimOperation() {
  return withTransaction(async (db) => {
    const row = (await db.query(
      `SELECT candidate.* FROM monetary_operations candidate
       WHERE (candidate.status='PENDING' OR (candidate.status IN ('FAILED','UNKNOWN') AND candidate.automatic_retry
         AND (candidate.attempt_count<10 OR candidate.last_error LIKE 'TreasuryError: Source account has insufficient available balance%')))
       AND candidate.next_attempt_at<=now()
       AND (candidate.operation_type<>'REFUND_REIMBURSEMENT' OR NOT EXISTS (
         SELECT 1 FROM monetary_operations older
         WHERE older.operation_type='REFUND_REIMBURSEMENT' AND older.status NOT IN ('SETTLED','CANCELLED')
           AND (older.created_at,older.id)<(candidate.created_at,candidate.id)
       ))
       ORDER BY CASE WHEN operation_type='REFUND_REIMBURSEMENT' THEN 0 ELSE 1 END,created_at FOR UPDATE SKIP LOCKED LIMIT 1`
    )).rows[0];
    if (!row) return null;
    await db.query("UPDATE monetary_operations SET status='CLAIMED',claimed_at=now(),attempt_count=attempt_count+1,updated_at=now() WHERE id=$1", [row.id]);
    return row;
  });
}

export async function recoverStaleOperations() {
  const result = await pool.query(
    `UPDATE monetary_operations SET status='UNKNOWN',automatic_retry=true,last_error='Recovered stale claim after restart',
     next_attempt_at=now(),updated_at=now() WHERE status='CLAIMED' AND claimed_at<now()-interval '2 minutes' RETURNING id`
  );
  return result.rowCount;
}

async function applySettledOperation(db, op) {
  if (op.operation_type === "SWEEP") await db.query("UPDATE rentals SET sweep_status='SETTLED' WHERE id=$1", [op.workflow_id]);
  if (op.operation_type === "REFUND_REIMBURSEMENT") {
    await db.query("UPDATE refunds SET reimbursement_status='PAID',reimbursed_at=now() WHERE id=$1", [op.workflow_id]);
    const ledger = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('REFUND_REIMBURSED','REFUND',$1,'Landlord reimbursement settled') RETURNING id", [op.workflow_id])).rows[0];
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'QUEUED_REIMBURSEMENT',$2)", [ledger.id, op.amount_cents]);
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'TREASURY_CASH',$2)", [ledger.id, op.amount_cents]);
  }
  if (op.operation_type === "PAYOUT") {
    const shareholderId = /^shareholder-(\d+)$/.exec(op.leg_key)?.[1];
    if (!shareholderId) throw new Error("Payout operation has an invalid leg key");
    await db.query("UPDATE rental_allocations SET paid_cents=paid_cents+$3,status='PAID' WHERE rental_id=$1 AND shareholder_id=$2", [op.workflow_id, shareholderId, op.amount_cents]);
    const ledger = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('PAYOUT_SETTLED','RENTAL',$1,$2) RETURNING id", [op.workflow_id, `Shareholder payout ${shareholderId}`])).rows[0];
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,shareholder_id,debit_cents) VALUES($1,'SHAREHOLDER_PAYABLE',$2,$3)", [ledger.id, shareholderId, op.amount_cents]);
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'TREASURY_CASH',$2)", [ledger.id, op.amount_cents]);
    const pending = Number((await db.query("SELECT count(*) n FROM monetary_operations WHERE workflow_type='RENTAL' AND workflow_id=$1 AND operation_type='PAYOUT' AND status<>'SETTLED'", [op.workflow_id])).rows[0].n);
    if (pending === 0) await db.query("UPDATE rentals SET release_status='PAID' WHERE id=$1", [op.workflow_id]);
  }
  if (op.operation_type === "FUND_LANDLORD") {
    const ledger = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('LANDLORD_FUNDED','MANUAL',$1,'Landlord pre-refund funding settled') RETURNING id", [op.workflow_id])).rows[0];
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'REFUND_RESERVE',$2)", [ledger.id, op.amount_cents]);
    await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'TREASURY_CASH',$2)", [ledger.id, op.amount_cents]);
  }
  await enqueueNotification(db, { dedupeKey: `OP_SETTLED:${op.id}`, eventType: `${op.operation_type}_SETTLED`, message: `Financial operation ${op.id} (${op.operation_type}) settled and was confirmed by Treasury.` });
}

export async function finishOperation(id, { status, txnId, error, automaticRetry = false }) {
  await withTransaction(async (db) => {
    const op = (await db.query(
      `UPDATE monetary_operations SET status=$2,treasury_txn_id=COALESCE($3,treasury_txn_id),last_error=$4,
       automatic_retry=$5,claimed_at=NULL,
       next_attempt_at=CASE WHEN $2 IN ('FAILED','UNKNOWN') THEN now() + LEAST(interval '30 minutes',interval '15 seconds' * power(2,LEAST(attempt_count,7))) ELSE next_attempt_at END,updated_at=now()
       WHERE id=$1 AND status IN ('CLAIMED','SUBMITTED') RETURNING *`, [id, status, txnId || null, error || null, automaticRetry]
    )).rows[0];
    if (!op) return;
    if (status !== "SETTLED") {
      if (op.operation_type === "SWEEP") await db.query("UPDATE rentals SET sweep_status=$2 WHERE id=$1", [op.workflow_id, status]);
      if (op.operation_type === "REFUND_REIMBURSEMENT") await db.query("UPDATE refunds SET reimbursement_status=$2 WHERE id=$1", [op.workflow_id, status]);
      if (op.operation_type === "PAYOUT") {
        const shareholderId = /^shareholder-(\d+)$/.exec(op.leg_key)?.[1];
        if (shareholderId) await db.query("UPDATE rental_allocations SET status='FAILED' WHERE rental_id=$1 AND shareholder_id=$2", [op.workflow_id, shareholderId]);
      }
      return;
    }
    await applySettledOperation(db, op);
  });
}
