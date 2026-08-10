#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then echo "usage: restore-check.sh backup.sql.gz" >&2; exit 2; fi
gzip -t "$1"
if [ -z "${RECOVERY_DATABASE_URL:-}" ]; then
  echo "Backup archive is readable. For a full test, set RECOVERY_DATABASE_URL to a separately created empty database."
  exit 0
fi
if [ "$RECOVERY_DATABASE_URL" = "${DATABASE_URL:-}" ]; then
  echo "Refusing to restore into the source database." >&2
  exit 2
fi
gunzip -c "$1" | psql -v ON_ERROR_STOP=1 "$RECOVERY_DATABASE_URL"
psql -v ON_ERROR_STOP=1 "$RECOVERY_DATABASE_URL" -c "SELECT version,applied_at FROM schema_migrations ORDER BY version"
echo "Backup restored successfully into the explicit recovery database. Compare entity and ledger counts before discarding it."
