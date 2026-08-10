# Migration and rollback record

## Preconditions

- Railway project/service IDs are recorded in the product specification.
- `sincere-growth` is out of scope and must not be modified.
- A Railway volume backup and legacy export are mandatory before production migration.
- If Railway access is unavailable, deploy only a new isolated database in `FINANCE_MODE=disabled`; never label legacy migration complete.

## Migration record template

Record timestamp, source deployment commit, source data hash/size, backup path, PostgreSQL migration versions, imported entity counts, operator and verification results. Do not record secret values.

## Rollback test

1. Validate the gzip archive.
2. Create a separate empty recovery database.
3. Restore the archive into recovery.
4. Run `npm run migrate:check` against recovery.
5. Compare table counts and representative guild/ticket/contract/verification/listing records.
6. Keep finance disabled until reconciliation cursors, postings, ledger balances and pending operations agree.

## Emergency application rollback

1. Latch `/finance emergency-disable confirm:DISABLE` or set
   `FINANCE_MODE=disabled` and restart if Discord is unavailable.
2. Run a fresh PostgreSQL and legacy backup and copy it off-host.
3. Preserve the current app image, logs, `.env` permissions and all volumes.
4. Deploy the previous known-good image only with finance disabled. Do not run
   reverse migrations or delete financial rows.
5. Restore into a new PostgreSQL database when database rollback is required;
   point a disabled app at it, run `migrate:check`, compare counts and reconcile.

Migration `004_finance_hardening` adds columns, constraints, indexes and
append-only triggers. It has no destructive down migration. Rollback is always
restore-forward into a separately created database.
