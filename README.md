# Revolution Realty Bot

Production Discord and DemocracyCraft Treasury system for Revolution Realty.
It preserves tickets, automatic guild setup, roles/channels, listings,
contracts with signed PDFs, contractor workflows, IGN verification and
notifications while replacing the former JSON escrow with a PostgreSQL-backed,
idempotent finance engine.

The deployed instance stays in `FINANCE_MODE=disabled` until the real Treasury
credentials, exact Realty `pluginSystem`, shadow reconciliation and low-value
transfer checks are complete. Disabled and shadow modes receive and persist
events but never execute transfers.

## Financial policy

- Treasury decimal strings are converted to integer cents; financial code never
  uses floating point.
- Exact confirmed `Rental Payment: <REGION>` postings from the verified Realty
  plugin are snapshotted against an immutable ownership version.
- The landlord's connected PERSONAL account sweeps gross rent to the configured
  BUSINESS account with a stable, persisted idempotency key.
- The hold runs for 168 hours from Realty settlement and cannot release before
  Treasury confirms the sweep.
- Shareholders receive 95% by basis points. Cent floors and all remainder go to
  the company; the retained 5% funds the refund reserve.
- Refunds use the original rental snapshot. Ambiguous matches require an
  explicit manager selection and never create a guessed transfer.
- Pre-payout refunds net against held allocations. Post-payout exposure becomes
  shareholder debt and is recovered oldest-first from future distributions.
- Refund reimbursements are FIFO. Reserve shortages remain unpaid, alert once
  per day and retry with the same operation identity.
- Signed webhooks, transaction-feed cursors, posting uniqueness, row locks and
  immutable operation requests prevent replay and duplicate payouts.

Internal `RR:*` postings are accepted only when they exactly match a stored
operation, direction, account, amount and—when known—Treasury transaction ID.
Unknown external activity is imported as an unclassified reconciliation item.

## Discord interface

Managers use:

- `/property list|view|add|landlord|ownership|enable|disable`
- `/finance status|account|connections|holds|payouts|refunds|debts|ledger`
- `/finance reconcile|retry|match-refund|reserve-deposit|fund-landlord`
- `/finance emergency-disable|clear-emergency`
- `/leasehold create|view|update|close|payments`

Shareholders use `/finance connect`, `/finance disconnect`, `/finance
connections`, `/finance statement` and `/finance debts`. PERSONAL keys are
submitted only through an ephemeral, single-use HTTPS link, validated against
the verified Minecraft UUID and encrypted with AES-256-GCM.

The old `/pay` and `/complete-deal` command names are retained as safe guidance
responses for existing Discord users. They cannot read payments or move funds.
Contract creation, signing, PDFs and archive lookup remain active.

## Permanent leaseholds

`PERMANENT_LEASEHOLD` billing binds an exact payer UUID, exact amount, interval
and unique payment reference. The scheduler creates charges, reminders and
arrears states. Only an exact positive business-account posting from that payer
settles the oldest charge, and 100% is company revenue; no shareholder payout is
created. Resale and transfer-of-rights automation are intentionally out of
scope.

## Local validation

Requirements: Node.js 18+ and PostgreSQL 16 for integration tests.

```sh
npm ci
npm run lint
npm test
npm audit --audit-level=high
DATABASE_URL=postgresql://... PGSSLMODE=disable npm run migrate
TEST_DATABASE_URL=postgresql://... npm run test:integration
```

GitHub Actions runs lint, unit tests, all SQL migrations, migration checks,
PostgreSQL integration tests and the dependency audit. The integration suite
exercises real database constraints, ownership snapshots, duplicate/out-of-order
deliveries, ambiguous refunds and manager matching, leaseholds, int64 recovery,
concurrent work claims, restart recovery and balanced-ledger enforcement.

## Deployment

Start with [HOSTING.md](HOSTING.md). Day-to-day procedures and the emergency
latch are in [OPERATIONS.md](OPERATIONS.md); recovery is in
[ROLLBACK.md](ROLLBACK.md). Current evidence and external credential gates are
recorded in [DELIVERABLES.md](DELIVERABLES.md) and
[DEPLOYMENT_RECORD.md](DEPLOYMENT_RECORD.md).
Security and private vulnerability reporting guidance is in
[SECURITY.md](SECURITY.md).

Quick start:

```sh
cp .env.example .env
chmod 600 .env
docker compose up -d --build
curl --fail http://127.0.0.1:3020/healthz
curl --fail http://127.0.0.1:3020/readyz
docker compose run --rm app npm run migrate:check
```

The app binds only to `127.0.0.1:3020`; publish it through an HTTPS reverse
proxy. Keep one live finance worker. Never place Discord or Treasury keys in
commands, logs, GitHub, public messages or tracked files.

## External activation requirements

The source, migrations, tests and disabled deployment are complete. Enabling
real money movement requires the following client-controlled external state:

1. rotate the exposed temporary Discord token;
2. install and validate the Revolution Realty BUSINESS key;
3. connect Servalot and summerock PERSONAL keys through HTTPS;
4. identify the exact Realty `pluginSystem` from genuine postings;
5. reconcile in shadow and perform signed low-value rent/sweep/payout/refund
   tests;
6. observe the first live rental through its full seven-day hold.

DCManager, share trading, analytics dashboards and leasehold resale automation
are not integrated.
