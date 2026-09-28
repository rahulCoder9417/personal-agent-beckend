#!/usr/bin/env bash
# Restore test (HLD Phase 8 / deployment.md: monthly): restores the latest nightly backup into a
# scratch database, checks the key tables, verifies every volume archive, then cleans up.
# Needs pg_restore/psql and the PG* env vars (PGHOST, PGUSER, PGPASSWORD) of the server.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/personal-agent}"
LATEST="$(ls -d "$BACKUP_DIR"/????-??-?? 2>/dev/null | sort | tail -1 || true)"
[ -n "$LATEST" ] || { echo "no backups in $BACKUP_DIR"; exit 1; }
DB="restore_test_$(date +%s)"

echo "restoring $LATEST/postgres.dump into $DB"
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
pg_restore --no-owner --exit-on-error --dbname "$DB" "$LATEST/postgres.dump"

for t in users channel_links events messages approvals automations credit_grants credit_ledger coupons; do
  n="$(psql -tAc "select count(*) from $t" "$DB" 2>/dev/null || echo missing)"
  echo "  $t: $n"
  [ "$n" != "missing" ] || { echo "FAIL: table $t missing"; exit 1; }
done
[ "$(psql -tAc 'select count(*) from users' "$DB")" -gt 0 ] || { echo "FAIL: no users restored"; exit 1; }

VOLS="${BACKUP_VOLUMES_DIR:-$BACKUP_DIR/volumes}/$(basename "$LATEST")"
if [ -d "$VOLS" ]; then
  for f in "$VOLS"/*.tar.gz; do
    [ -e "$f" ] || continue
    tar -tzf "$f" > /dev/null || { echo "FAIL: corrupt archive $f"; exit 1; }
  done
  echo "  volume archives OK: $(ls "$VOLS"/*.tar.gz 2>/dev/null | wc -l)"
fi
echo "restore test passed"
