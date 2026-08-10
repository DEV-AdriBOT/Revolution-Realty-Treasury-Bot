# Delivery manifest

## Included

- Existing Discord tickets, setup, roles/channels, listings, contracts/PDFs,
  IGN verification, reminders and notifications
- PostgreSQL migrations for configuration, shareholders, properties, immutable
  ownership, postings, rentals, refunds, debts, operations, ledgers, cursors,
  leaseholds, audit events and the notification outbox
- Signed raw-body Treasury webhook receiver and durable feed reconciliation
- Exact integer-cent 5%/95% allocation, refund netting and future debt recovery
- AES-256-GCM PERSONAL token connection, rotation and disconnection flow
- Property, finance and permanent-leasehold slash-command groups
- Docker deployment, health/readiness routes, backup/restore scripts and operator
  documentation

## Evidence

- `npm test`: 20 unit/security tests passed; the PostgreSQL integration test is
  intentionally skipped unless `TEST_DATABASE_URL` is supplied
- `npm run test:integration`: 1 end-to-end PostgreSQL workflow suite passed
- `npm run lint`: passed
- `npm audit --audit-level=high`: zero vulnerabilities
- All 4 SQL migrations and `migrate:check` passed against PostgreSQL 16;
  uniqueness, immutable identities, append-only records, balanced-ledger and
  operation-transition constraints were exercised
- Legacy Railway JSON hash and migration counts recorded in
  `DEPLOYMENT_RECORD.md`
- PostgreSQL backup restored successfully into a clean recovery database
- Docker restart preserved all 22 imported properties
- Post-hardening recovery counts were `4 migrations | 22 properties | 1 legacy
  state | 0 operations`
- Real Discord smoke test: bot online, setup channels created, all 17 top-level
  commands registered, `/finance status` returned `disabled` privately, and the
  durable outbox delivered exactly once to the finance-audit channel

## External completion gates

- Install and validate the Revolution Realty BUSINESS Treasury key
- Connect Servalot and summerock PERSONAL keys through `/finance connect`
- Confirm the exact Realty `pluginSystem` from genuine postings
- Complete shadow reconciliation and low-value rent/sweep/payout/refund evidence
- Observe the first live rental through its complete seven-day hold
- Rotate the temporary Discord bot token before live use

These gates require client credentials or real in-game events. Until they are
completed, the deployment remains deliberately transfer-disabled and must not be
represented as live financial production.
