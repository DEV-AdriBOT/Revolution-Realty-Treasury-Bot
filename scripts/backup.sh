#!/bin/sh
set -eu
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${BACKUP_DIR:-/backups}/postgres-${stamp}.sql.gz"
temporary="${target}.partial"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip -9 > "$temporary"
gzip -t "$temporary"
mv "$temporary" "$target"
gzip -t "$target"
if [ -f "${DATA_DIR:-/data}/data.json" ]; then
  gzip -c "${DATA_DIR:-/data}/data.json" > "${BACKUP_DIR:-/backups}/legacy-data-${stamp}.json.gz"
fi
echo "Created verified PostgreSQL backup: $target"
