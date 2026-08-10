import test from "node:test";
import assert from "node:assert/strict";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL finance workflow preserves snapshots, deduplicates, and locks work", { skip: !databaseUrl, timeout: 30000 }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PGSSLMODE = "disable";
  process.env.FINANCE_MODE = "shadow";

  const { pool, withTransaction, shutdownDatabase } = await import("../src/database.js");
  const { ingestDelivery, claimOperation, finishOperation, recoverStaleOperations, matchRefundByManager } = await import("../src/finance-repository.js");

  try {
    await pool.query(`TRUNCATE connection_tokens,notification_outbox,account_reconciliation,reconciliation_cursors,
      unclassified_transactions,debt_recoveries,ledger_entries,ledger_transactions,monetary_operations,
      shareholder_debts,refunds,rental_allocations,rentals,leasehold_charges,leaseholds,webhook_deliveries,
      treasury_postings,treasury_subscriptions,ownership_allocations,ownership_versions,properties,
      shareholders,guild_config,legacy_state,audit_events RESTART IDENTITY CASCADE`);

    await pool.query("INSERT INTO guild_config(guild_id,finance_mode,business_account_id,plugin_system) VALUES('guild','shadow',120294,'REALTY_TEST')");
    const shareholders = (await pool.query(
      `INSERT INTO shareholders(discord_id,owner_uuid,current_ign,account_id) VALUES
       ('1','00000000-0000-4000-8000-000000000001','Servalot',1001),
       ('2','00000000-0000-4000-8000-000000000002','summerock',1002) RETURNING id,discord_id`
    )).rows;
    const servalot = shareholders.find((row) => row.discord_id === "1").id;
    const summerock = shareholders.find((row) => row.discord_id === "2").id;
    const webhookSubscription = (await pool.query(
      `INSERT INTO treasury_subscriptions(scope,treasury_webhook_id,account_id,shareholder_id,guild_id,secret_key_version,secret_nonce,secret_tag,secret_ciphertext)
       VALUES('PERSONAL',5001,1001,$1,'guild','v1','\\x01','\\x02','\\x03') RETURNING id,guild_id`, [servalot]
    )).rows[0];
    const webhookPayload = {
      event: "transaction.posted", deliveryId: "delivery-1", accountId: 1001,
      transaction: { postingId: "900000000000000000", txnId: "800000000000000000", amount: "1.00", memo: "not-a-realty-event", message: null, settledAt: "2026-01-01T00:00:00Z", initiatorUuid: null, pluginSystem: "OTHER" },
    };
    await ingestDelivery({ subscription: webhookSubscription, source: "webhook", headers: { event: webhookPayload.event, delivery: webhookPayload.deliveryId }, payload: webhookPayload });
    assert.equal((await ingestDelivery({ subscription: webhookSubscription, source: "webhook", headers: { event: webhookPayload.event, delivery: webhookPayload.deliveryId }, payload: webhookPayload })).duplicate, true);
    const replay = { ...webhookPayload, deliveryId: "delivery-2" };
    assert.equal((await ingestDelivery({ subscription: webhookSubscription, source: "webhook", headers: { event: replay.event, delivery: replay.deliveryId }, payload: replay })).duplicatePosting, true);
    assert.deepEqual((await pool.query("SELECT processed_at IS NOT NULL processed FROM webhook_deliveries ORDER BY id")).rows.map((row) => row.processed), [true, true]);
    const propertyId = (await pool.query("INSERT INTO properties(region,landlord_shareholder_id,status) VALUES('T001',$1,'ACTIVE') RETURNING id", [servalot])).rows[0].id;

    await withTransaction(async (db) => {
      const version = (await db.query("INSERT INTO ownership_versions(property_id,version,effective_at,created_by,reason) VALUES($1,1,'2026-01-01','test','initial') RETURNING id", [propertyId])).rows[0].id;
      await db.query("INSERT INTO ownership_allocations(ownership_version_id,shareholder_id,basis_points) VALUES($1,$2,10000)", [version, servalot]);
    });

    const subscription = { id: 0, guild_id: "guild" };
    const feed = (postingId, txnId, amount, memo, settledAt, initiatorUuid = null, accountId = 1001) => ingestDelivery({
      subscription,
      source: "feed",
      headers: {},
      payload: { accountId, transaction: { postingId, txnId, amount, memo, message: null, settledAt, initiatorUuid, pluginSystem: "REALTY_TEST" } },
    });

    await feed("900000000000000001", "800000000000000001", "1500.00", "Rental Payment: T001", "2026-01-01T12:00:00Z");
    const duplicate = await feed("900000000000000001", "800000000000000001", "1500.00", "Rental Payment: T001", "2026-01-01T12:00:00Z");
    assert.equal(duplicate.duplicatePosting, true);

    await withTransaction(async (db) => {
      const version = (await db.query("INSERT INTO ownership_versions(property_id,version,effective_at,created_by,reason) VALUES($1,2,'2026-01-02','test','new split') RETURNING id", [propertyId])).rows[0].id;
      await db.query("INSERT INTO ownership_allocations(ownership_version_id,shareholder_id,basis_points) VALUES($1,$2,5000),($1,$3,5000)", [version, servalot, summerock]);
    });
    await feed("900000000000000002", "800000000000000002", "100.01", "Rental Payment: T001", "2026-01-03T12:00:00Z");

    const snapshots = (await pool.query(
      `SELECT r.id,ov.version,count(ra.*)::int allocation_count,sum(ra.gross_entitlement_cents)::bigint allocated,r.company_retained_cents
       FROM rentals r JOIN ownership_versions ov ON ov.id=r.ownership_version_id JOIN rental_allocations ra ON ra.rental_id=r.id
       GROUP BY r.id,ov.version ORDER BY r.id`
    )).rows;
    assert.deepEqual(snapshots.map((row) => [row.version, row.allocation_count]), [[1, 1], [2, 2]]);
    assert.equal(BigInt(snapshots[1].allocated) + BigInt(snapshots[1].company_retained_cents), 10001n);
    await pool.query("UPDATE guild_config SET business_account_id=120295 WHERE guild_id='guild'");
    assert.deepEqual((await pool.query("SELECT DISTINCT business_account_id FROM rentals ORDER BY business_account_id")).rows.map((row) => row.business_account_id), ["120294"]);
    await pool.query("UPDATE guild_config SET business_account_id=120294 WHERE guild_id='guild'");

    const firstSweep = (await pool.query("SELECT * FROM monetary_operations WHERE operation_type='SWEEP' ORDER BY id LIMIT 1")).rows[0];
    await pool.query("UPDATE monetary_operations SET status='PENDING' WHERE id=$1", [firstSweep.id]);
    await pool.query("UPDATE monetary_operations SET status='CLAIMED',claimed_at=now() WHERE id=$1", [firstSweep.id]);
    await pool.query("UPDATE monetary_operations SET status='UNKNOWN' WHERE id=$1", [firstSweep.id]);
    const recovered = await feed("900000000000000010", "800000000000000010", "-1500.00", firstSweep.memo, "2026-01-01T12:00:01Z");
    assert.equal(recovered.classification, "SWEEP");
    assert.equal((await pool.query("SELECT status FROM monetary_operations WHERE id=$1", [firstSweep.id])).rows[0].status, "SETTLED");
    assert.equal((await pool.query("SELECT sweep_status FROM rentals WHERE id=$1", [firstSweep.workflow_id])).rows[0].sweep_status, "SETTLED");

    await feed("900000000000000003", "800000000000000003", "-50.00", "Early Lease Termination Refund: T001", "2026-01-04T12:00:00Z");
    const review = (await pool.query("SELECT matched_status,rental_id FROM refunds")).rows[0];
    assert.deepEqual(review, { matched_status: "REVIEW_REQUIRED", rental_id: null });
    assert.equal((await pool.query("SELECT count(*)::int n FROM monetary_operations WHERE operation_type='REFUND_REIMBURSEMENT'")).rows[0].n, 0);
    const reviewedRefundId = (await pool.query("SELECT id FROM refunds")).rows[0].id;
    const selectedRentalId = (await pool.query("SELECT id FROM rentals ORDER BY settled_at DESC LIMIT 1")).rows[0].id;
    await withTransaction((db) => matchRefundByManager(db, reviewedRefundId, selectedRentalId), "SERIALIZABLE");
    assert.deepEqual(
      (await pool.query("SELECT matched_status,rental_id FROM refunds WHERE id=$1", [reviewedRefundId])).rows[0],
      { matched_status: "MATCHED", rental_id: selectedRentalId }
    );
    assert.equal((await pool.query("SELECT count(*)::int n FROM monetary_operations WHERE operation_type='REFUND_REIMBURSEMENT'")).rows[0].n, 1);

    const leaseProperty = (await pool.query("INSERT INTO properties(region,landlord_shareholder_id,status,property_type) VALUES('L001',$1,'ACTIVE','PERMANENT_LEASEHOLD') RETURNING id", [servalot])).rows[0].id;
    await withTransaction(async (db) => {
      const version = (await db.query("INSERT INTO ownership_versions(property_id,version,created_by,reason) VALUES($1,1,'test','lease') RETURNING id", [leaseProperty])).rows[0].id;
      await db.query("INSERT INTO ownership_allocations(ownership_version_id,shareholder_id,basis_points) VALUES($1,$2,10000)", [version, servalot]);
    });
    const leasehold = (await pool.query(
      `INSERT INTO leaseholds(property_id,payer_uuid,payer_ign,fee_cents,interval_days,payment_reference,next_due_at,guild_id)
       VALUES($1,'00000000-0000-4000-8000-000000000099','LeasePayer',5000,30,'RR-LH-L001-TEST',now(),'guild') RETURNING id`, [leaseProperty]
    )).rows[0];
    await pool.query("INSERT INTO leasehold_charges(leasehold_id,period_start,due_at,amount_cents) VALUES($1,now()-interval '30 days',now(),5000)", [leasehold.id]);
    const leaseResult = await feed("900000000000000004", "800000000000000004", "50.00", "RR-LH-L001-TEST", "2026-01-05T12:00:00Z", "00000000-0000-4000-8000-000000000099", 120294);
    assert.equal(leaseResult.classification, "LEASEHOLD");
    assert.equal((await pool.query("SELECT status FROM leasehold_charges WHERE leasehold_id=$1", [leasehold.id])).rows[0].status, "PAID");
    assert.equal((await pool.query("SELECT count(*)::int n FROM monetary_operations WHERE workflow_type='LEASEHOLD'")).rows[0].n, 0);

    const unknownInternal = await feed("900000000000000005", "800000000000000005", "1.00", "RR:PAYOUT:999:1", "2026-01-06T12:00:00Z", null, 120294);
    assert.equal(unknownInternal.classification, "UNCLASSIFIED");

    const operationId = (await pool.query(
      `INSERT INTO monetary_operations(operation_type,workflow_type,workflow_id,leg_key,source_account_id,destination_uuid,amount_cents,memo,idempotency_key,request_fingerprint,status)
       VALUES('FUND_LANDLORD','MANUAL',1,'integration',120294,'00000000-0000-4000-8000-000000000001',1,'RR:FUND:INTEGRATION','integration-key','fingerprint','PENDING') RETURNING id`
    )).rows[0].id;
    const claims = await Promise.all([claimOperation(), claimOperation()]);
    assert.equal(claims.filter(Boolean).length, 1);
    await pool.query("UPDATE monetary_operations SET claimed_at=now()-interval '3 minutes' WHERE id=$1", [operationId]);
    assert.equal(await recoverStaleOperations(), 1);
    await pool.query("UPDATE monetary_operations SET status='PENDING' WHERE id=$1", [operationId]);
    assert.equal((await claimOperation()).id, operationId);
    await Promise.all([
      finishOperation(operationId, { status: "SETTLED", txnId: "700000000000000001" }),
      finishOperation(operationId, { status: "SETTLED", txnId: "700000000000000001" }),
    ]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM ledger_transactions WHERE event_type='LANDLORD_FUNDED' AND workflow_id=$1", [1])).rows[0].n, 1);

    await assert.rejects(
      withTransaction(async (db) => {
        const ledger = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('BAD','TEST',1,'unbalanced') RETURNING id")).rows[0];
        await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'TREASURY_CASH',1)", [ledger.id]);
      }),
      /Unbalanced ledger transaction/
    );
    await assert.rejects(pool.query("UPDATE treasury_postings SET amount_cents=2 WHERE posting_id=900000000000000001"), /Treasury posting identity is immutable/);
  } finally {
    await shutdownDatabase();
  }
});
