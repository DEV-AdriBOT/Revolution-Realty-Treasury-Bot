# Deployment and migration record

## 2026-08-09 production host staging

- Source baseline: audited commit `0a1efec`.
- Finance mode: `disabled`; no Treasury transfer worker is permitted to execute.
- Host deployment: Docker Compose on the private server, with the app bound to
  `127.0.0.1:3020` behind the existing HTTPS virtual host.
- Public routes verified: `/realty/healthz` and `/realty/readyz` return healthy.
- PostgreSQL: three explicit migrations applied; 22 seeded properties, of which
  C193 and C194 remain `REVIEW_REQUIRED` and all others remain disabled pending
  client activation.

## 2026-08-10 hardening deployment

- A fresh pre-deployment application, legacy-volume and PostgreSQL backup was
  stored under
  `/home/neon/backups/revolution-realty/pre-hardening-20260810T195356Z` with
  owner-only permissions. Its database archive restored into a separate test
  database with 3 pre-change migrations, 22 properties and one legacy state;
  that recovery database was removed afterward.
- Migration `004_finance_hardening` applied successfully. The production
  database now reports 4 migrations, 22 properties, one legacy state and zero
  monetary operations. Finance remains `disabled` and the emergency latch is
  clear.
- Post-migration archive `/backups/postgres-20260810T195752Z.sql.gz` is 19,803
  bytes with SHA-256
  `78fdd7b9ca0e5ad6fda75c4393394ef01d26c9d673f59d4fe6aff97be7ecccdc`.
  It restored with the pinned PostgreSQL 16 tools into an empty recovery
  database and produced `4|22|1|0` for migrations, properties, legacy state and
  operations. The recovery database was removed. An earlier PG18-generated
  archive that failed compatibility validation was quarantined with an
  `.INVALID-PG18` suffix and warning file; it is not listed as recoverable.
- The application rebuilt on Node 22, restarted gracefully, returned healthy on
  internal and public `/healthz` and `/readyz`, reconnected to Discord, and
  retained all database counts. PostgreSQL was not exposed publicly.
- Discord REST confirmed 17 top-level commands and all 18 current finance
  subcommands. `finance-audit` now permits only Manager, the bot and Discord
  administrators; Realtor's explicit overwrite was removed.
- A final isolated PostgreSQL 16 run applied all 4 migrations, passed
  `migrate:check` and passed the real database integration suite. Its temporary
  container was removed.

## Legacy preservation

- Railway service inventory was read only. `sincere-growth` was not modified.
- Railway `/data/data.json`: 47,251 bytes; SHA-256
  `295e47d59c2c604302456b45dbbf3ce580207e327238f8ffc7a9a26445b0ead5`.
- Exact copy retained at
  `/home/neon/backups/revolution-realty/railway-data-20260809T2302Z.json`
  with mode `0600`.
- Imported legacy counts: 1 guild, 52 tickets, 19 contracts, 48 verification
  records and 1 listing. The source JSON and generated timestamped importer copy
  remain recoverable.

## PostgreSQL backup and recovery proof

- Backup: `/home/neon/backups/revolution-realty/postgres-20260809T2335Z.sql.gz`
- SHA-256: `61d234142d147133ebf5a0877d5368559f84ac1a3c72b451942541d7dce09cb1`
- The archive passed `gzip -t`, restored into a fresh temporary database, and
  produced 22 properties and all 3 migration records. The temporary recovery
  database was then removed.
- Application restart recovery preserved the 22 properties and returned healthy.

## Discord smoke test

- The temporary bot joined the test guild and remained online after restart.
- Automatic setup created the client desk and private contract, moderation,
  payment and finance-audit channels.
- Guild slash commands registered successfully.
- Discord REST inventory confirmed all 17 expected top-level commands, including
  `property`, `finance` and `leasehold`.
- A real `/finance status` invocation returned privately with mode `disabled`,
  no configured business account and no monetary operations.
- A synthetic non-financial outbox smoke event was claimed once, marked `SENT`
  with one attempt and appeared in the private finance-audit channel. No transfer
  operation was created.

## Verification boundary

The software deployment is healthy but intentionally not described as live
finance or Treasury end-to-end complete.
Real shadow reconciliation, webhook signature evidence, low-value transfers and
the full seven-day rental payout require the client Treasury BUSINESS key,
Servalot and summerock PERSONAL connections, and confirmation of the exact Realty
`pluginSystem` from real postings. The temporary Discord bot is present in the
test guild, but its exposed token must be rotated before live use.
