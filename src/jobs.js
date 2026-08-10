import crypto from "node:crypto";
import { pool, withTransaction } from "./database.js";
import { TreasuryClient } from "./treasury-client.js";
import { parseEncryptionKeys, decryptToken, hashFingerprint, redact } from "./security.js";
import { ingestDelivery } from "./finance-repository.js";
import { enqueueExpiryWarnings, enqueueNotification } from "./notifications.js";
import { parseCents } from "./money.js";

function payoutKey(rentalId, shareholderId) {
  return `rr-payout-${rentalId}-${shareholderId}-${crypto.createHash("sha256").update(`PAYOUT:${rentalId}:${shareholderId}`).digest("hex").slice(0, 16)}`;
}

export async function prepareDuePayouts() {
  return withTransaction(async (db) => {
    const rental = (await db.query(
      `SELECT * FROM rentals WHERE release_status='HELD' AND sweep_status='SETTLED' AND hold_until<=now()
       ORDER BY hold_until FOR UPDATE SKIP LOCKED LIMIT 1`
    )).rows[0];
    if (!rental) return false;
    const finance = (await db.query("SELECT bool_or(finance_mode='live') any_live,bool_or(emergency_disabled) emergency FROM guild_config")).rows[0];
    const operationStatus = process.env.FINANCE_MODE === "live" && finance?.any_live && !finance.emergency ? "PENDING" : "SHADOW";
    await db.query("UPDATE rentals SET release_status='CLAIMED' WHERE id=$1", [rental.id]);
    const allocations = (await db.query(
      `SELECT ra.*,s.owner_uuid FROM rental_allocations ra JOIN shareholders s ON s.id=ra.shareholder_id WHERE rental_id=$1 ORDER BY shareholder_id FOR UPDATE OF ra`, [rental.id]
    )).rows;
    let payableTotal = 0n;
    let debtRecoveredTotal = 0n;
    for (const allocation of allocations) {
      const entitlement = BigInt(allocation.gross_entitlement_cents);
      const refund = BigInt(allocation.refund_liability_cents);
      let available = entitlement > refund ? entitlement - refund : 0n;
      const debts = (await db.query("SELECT * FROM shareholder_debts WHERE shareholder_id=$1 AND status IN ('OPEN','PARTIAL') ORDER BY created_at,id FOR UPDATE", [allocation.shareholder_id])).rows;
      for (const debt of debts) {
        if (available === 0n) break;
        const recovered = available < BigInt(debt.outstanding_cents) ? available : BigInt(debt.outstanding_cents);
        available -= recovered;
        const outstanding = BigInt(debt.outstanding_cents) - recovered;
        await db.query("UPDATE shareholder_debts SET outstanding_cents=$2,status=$3 WHERE id=$1", [debt.id, outstanding.toString(), outstanding === 0n ? "RECOVERED" : "PARTIAL"]);
        await db.query(
          `INSERT INTO debt_recoveries(debt_id,rental_id,shareholder_id,amount_cents) VALUES($1,$2,$3,$4)
           ON CONFLICT(debt_id,rental_id) DO UPDATE SET amount_cents=debt_recoveries.amount_cents+excluded.amount_cents`,
          [debt.id, rental.id, allocation.shareholder_id, recovered.toString()]
        );
        debtRecoveredTotal += recovered;
      }
      if (available > 0n) {
        payableTotal += available;
        const memo = `RR:PAYOUT:${rental.id}:${allocation.shareholder_id}`;
        const key = payoutKey(rental.id, allocation.shareholder_id);
        await db.query(
          `INSERT INTO monetary_operations(operation_type,workflow_type,workflow_id,leg_key,source_account_id,destination_uuid,amount_cents,memo,idempotency_key,request_fingerprint,status)
           VALUES('PAYOUT','RENTAL',$1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workflow_type,workflow_id,leg_key) DO NOTHING`,
          [rental.id, `shareholder-${allocation.shareholder_id}`, rental.business_account_id, allocation.owner_uuid, available.toString(), memo, key,
            hashFingerprint(JSON.stringify({ from: rental.business_account_id, to: allocation.owner_uuid, amount: available.toString(), memo })),
            operationStatus]
        );
      }
      const recoveredForAllocation = BigInt((await db.query(
        "SELECT COALESCE(sum(amount_cents),0) amount FROM debt_recoveries WHERE rental_id=$1 AND shareholder_id=$2",
        [rental.id, allocation.shareholder_id]
      )).rows[0].amount);
      await db.query("UPDATE rental_allocations SET status=$3,debt_recovered_cents=$4 WHERE rental_id=$1 AND shareholder_id=$2", [rental.id, allocation.shareholder_id, available > 0n ? "CLAIMED" : "NETTED", recoveredForAllocation.toString()]);
    }
    const company = BigInt(rental.company_retained_cents);
    const releaseTotal = company + payableTotal + debtRecoveredTotal;
    if (releaseTotal > 0n) {
      const ledger = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('HOLD_RELEASED','RENTAL',$1,'Seven-day hold released') RETURNING id", [rental.id])).rows[0];
      await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'HELD_FUNDS',$2)", [ledger.id, releaseTotal.toString()]);
      if (company > 0n) await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'COMPANY_RETAINED',$2)", [ledger.id, company.toString()]);
      if (payableTotal > 0n) await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'SHAREHOLDER_PAYABLE',$2)", [ledger.id, payableTotal.toString()]);
      if (debtRecoveredTotal > 0n) await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'SHAREHOLDER_DEBT',$2)", [ledger.id, debtRecoveredTotal.toString()]);
      if (company > 0n) {
        const reserve = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('COMPANY_FEE_RESERVED','RENTAL',$1,'Retained company fee allocated to refund reserve') RETURNING id", [rental.id])).rows[0];
        await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'COMPANY_RETAINED',$2)", [reserve.id, company.toString()]);
        await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'REFUND_RESERVE',$2)", [reserve.id, company.toString()]);
      }
    }
    const operationCount = Number((await db.query("SELECT count(*) n FROM monetary_operations WHERE workflow_type='RENTAL' AND workflow_id=$1 AND operation_type='PAYOUT'", [rental.id])).rows[0].n);
    if (operationCount === 0) await db.query("UPDATE rentals SET release_status='PAID' WHERE id=$1", [rental.id]);
    return true;
  }, "SERIALIZABLE");
}

async function personalToken(shareholder) {
  return decryptToken({ version: shareholder.token_key_version, nonce: shareholder.token_nonce, tag: shareholder.token_tag, ciphertext: shareholder.token_ciphertext }, parseEncryptionKeys());
}

let reconciliationPromise = null;

async function reconcileAccountsOnce() {
  const accounts = (await pool.query(
    `SELECT s.account_id,'PERSONAL' kind,s.id shareholder_id,s.token_key_version,s.token_nonce,s.token_tag,s.token_ciphertext,
            ts.id subscription_id,ts.guild_id,ts.treasury_webhook_id
     FROM shareholders s
     LEFT JOIN LATERAL (SELECT * FROM treasury_subscriptions WHERE shareholder_id=s.id AND active ORDER BY created_at DESC LIMIT 1) ts ON true
     WHERE s.token_ciphertext IS NOT NULL
     UNION ALL
     SELECT gc.business_account_id,'BUSINESS',NULL,NULL,NULL,NULL,NULL,ts.id,gc.guild_id,ts.treasury_webhook_id
     FROM guild_config gc
     LEFT JOIN LATERAL (SELECT * FROM treasury_subscriptions WHERE scope='BUSINESS' AND active AND (guild_id=gc.guild_id OR guild_id IS NULL) ORDER BY created_at DESC LIMIT 1) ts ON true
     WHERE gc.business_account_id IS NOT NULL
     UNION ALL
     SELECT old.account_id,'BUSINESS',NULL,NULL,NULL,NULL,NULL,ts.id,gc.guild_id,ts.treasury_webhook_id
     FROM (
       SELECT DISTINCT account_id FROM (
         SELECT destination_account_id account_id FROM monetary_operations WHERE operation_type='SWEEP' AND status NOT IN ('SETTLED','CANCELLED')
         UNION ALL
         SELECT source_account_id account_id FROM monetary_operations WHERE operation_type<>'SWEEP' AND status NOT IN ('SETTLED','CANCELLED')
       ) pending WHERE account_id IS NOT NULL
     ) old
     CROSS JOIN LATERAL (SELECT * FROM guild_config ORDER BY updated_at DESC LIMIT 1) gc
     LEFT JOIN LATERAL (SELECT * FROM treasury_subscriptions WHERE scope='BUSINESS' AND active AND (guild_id=gc.guild_id OR guild_id IS NULL) ORDER BY created_at DESC LIMIT 1) ts ON true
     WHERE old.account_id<>gc.business_account_id`
  )).rows;
  let imported = 0;
  for (const account of accounts) {
    try {
      const token = account.kind === "BUSINESS" ? process.env.TREASURY_BUSINESS_TOKEN : await personalToken(account);
      if (!token) continue;
      const client = new TreasuryClient(token);
      let cursor = String((await pool.query("SELECT cursor FROM reconciliation_cursors WHERE account_id=$1", [account.account_id])).rows[0]?.cursor || "0");
      for (let page = 0; ; page++) {
        if (page >= 10000) throw new Error("Transaction feed exceeded the reconciliation page safety limit");
        const feed = await client.feed(account.account_id, cursor, 100);
        for (const transaction of feed.items || []) {
          const result = await ingestDelivery({ subscription: { id: account.subscription_id || 0, guild_id: account.guild_id }, headers: {}, payload: { accountId: account.account_id, transaction }, source: "feed" });
          if (!result.duplicatePosting) imported++;
        }
        const nextCursor = String(feed.nextCursor ?? cursor);
        if (feed.hasMore && nextCursor === cursor) throw new Error("Transaction feed cursor did not advance");
        cursor = nextCursor;
        await pool.query(
          `INSERT INTO reconciliation_cursors(account_id,cursor,last_success_at,last_error) VALUES($1,$2,now(),NULL)
           ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor,last_success_at=now(),last_error=NULL`, [account.account_id, cursor]
        );
        if (!feed.hasMore) break;
      }
      const balance = parseCents(String((await client.balance(account.account_id)).balance));
      const postingTotal = BigInt((await pool.query("SELECT COALESCE(sum(amount_cents),0) total FROM treasury_postings WHERE account_id=$1", [account.account_id])).rows[0].total);
      const existing = (await pool.query("SELECT baseline_cents FROM account_reconciliation WHERE account_id=$1", [account.account_id])).rows[0];
      const baseline = existing ? BigInt(existing.baseline_cents) : balance - postingTotal;
      const mismatch = balance - (baseline + postingTotal);
      await pool.query(
        `INSERT INTO account_reconciliation(account_id,guild_id,baseline_cents,posting_total_cents,treasury_balance_cents,mismatch_cents)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id) DO UPDATE SET guild_id=excluded.guild_id,
         posting_total_cents=excluded.posting_total_cents,treasury_balance_cents=excluded.treasury_balance_cents,
         mismatch_cents=excluded.mismatch_cents,last_checked_at=now()`,
        [account.account_id, account.guild_id || null, baseline.toString(), postingTotal.toString(), balance.toString(), mismatch.toString()]
      );
      const day = new Date().toISOString().slice(0, 10);
      if (mismatch !== 0n) await enqueueNotification(pool, {
        guildId: account.guild_id || null,
        dedupeKey: `RECONCILIATION_MISMATCH:${account.account_id}:${day}`,
        eventType: "RECONCILIATION_MISMATCH",
        message: `Reconciliation mismatch for Treasury account ${account.account_id}: ${mismatch} cents. Transfers remain governed by the finance kill switch.`,
      });
      if (account.treasury_webhook_id) {
        const webhooks = (await client.listWebhooks()).webhooks || [];
        const webhook = webhooks.find((item) => String(item.id) === String(account.treasury_webhook_id));
        if (!webhook?.active || Number(webhook.consecutiveFailures || 0) > 0) await enqueueNotification(pool, {
          guildId: account.guild_id || null,
          dedupeKey: `WEBHOOK_FAILURE:${account.treasury_webhook_id}:${day}`,
          eventType: "WEBHOOK_FAILURE",
          message: `Treasury webhook ${account.treasury_webhook_id} is inactive or reporting delivery failures. Feed reconciliation is still running.`,
        });
      }
    } catch (error) {
      await pool.query(
        `INSERT INTO reconciliation_cursors(account_id,cursor,last_error) VALUES($1,0,$2)
         ON CONFLICT(account_id) DO UPDATE SET last_error=excluded.last_error`, [account.account_id, redact(error)]
      );
    }
  }
  return imported;
}

export function reconcileAccounts() {
  if (reconciliationPromise) return reconciliationPromise;
  reconciliationPromise = reconcileAccountsOnce().finally(() => { reconciliationPromise = null; });
  return reconciliationPromise;
}

export async function scheduleLeaseholdCharges() {
  await withTransaction(async (db) => {
    await db.query(
      `INSERT INTO leasehold_charges(leasehold_id,period_start,due_at,amount_cents)
       SELECT id,next_due_at-(interval '1 day'*interval_days),next_due_at,fee_cents FROM leaseholds l
       WHERE status<>'CLOSED' AND next_due_at<=now()+interval '7 days'
       ON CONFLICT(leasehold_id,period_start) DO NOTHING`
    );
    const due = (await db.query(
      `SELECT c.id,c.due_at,l.guild_id,p.region FROM leasehold_charges c
       JOIN leaseholds l ON l.id=c.leasehold_id JOIN properties p ON p.id=l.property_id
       WHERE c.status='DUE' AND c.due_at BETWEEN now() AND now()+interval '7 days'`
    )).rows;
    for (const charge of due) await enqueueNotification(db, {
      guildId: charge.guild_id,
      dedupeKey: `LEASEHOLD_DUE:${charge.id}`,
      eventType: "LEASEHOLD_DUE",
      message: `Permanent leasehold ${charge.region} payment is due at ${new Date(charge.due_at).toISOString()}.`,
    });
    const arrears = (await db.query(
      `UPDATE leasehold_charges c SET status='ARREARS' FROM leaseholds l,properties p
       WHERE c.leasehold_id=l.id AND l.property_id=p.id AND c.status='DUE' AND c.due_at<now()
       RETURNING c.id,l.guild_id,p.region,c.due_at`
    )).rows;
    for (const charge of arrears) await enqueueNotification(db, {
      guildId: charge.guild_id,
      dedupeKey: `LEASEHOLD_ARREARS:${charge.id}`,
      eventType: "LEASEHOLD_ARREARS",
      message: `Permanent leasehold ${charge.region} payment is in arrears since ${new Date(charge.due_at).toISOString()}.`,
    });
    await db.query("UPDATE leaseholds l SET status='ARREARS' WHERE status='ACTIVE' AND EXISTS(SELECT 1 FROM leasehold_charges c WHERE c.leasehold_id=l.id AND c.status='ARREARS')");
  });
}

export function startSchedulers() {
  let jobsPromise = null;
  let reconcilePromise = null;
  const tick = () => {
    if (jobsPromise) return jobsPromise;
    jobsPromise = (async () => {
      try {
        for (let claimed = 0; claimed < 100; claimed++) {
          if (!await prepareDuePayouts()) break;
        }
        await scheduleLeaseholdCharges();
        await enqueueExpiryWarnings();
      } catch (error) { console.error("scheduler", redact(error)); }
      finally { jobsPromise = null; }
    })();
    return jobsPromise;
  };
  const reconcileTick = () => {
    if (reconcilePromise) return reconcilePromise;
    reconcilePromise = reconcileAccounts()
      .catch((error) => console.error("reconcile", redact(error)))
      .finally(() => { reconcilePromise = null; });
    return reconcilePromise;
  };
  tick();
  reconcileTick();
  const jobs = setInterval(tick, 30000);
  const reconcile = setInterval(reconcileTick, 5 * 60 * 1000);
  jobs.unref(); reconcile.unref();
  return async () => {
    clearInterval(jobs);
    clearInterval(reconcile);
    await Promise.allSettled([jobsPromise, reconcilePromise].filter(Boolean));
  };
}
