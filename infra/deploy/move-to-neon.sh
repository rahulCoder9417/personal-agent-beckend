#!/usr/bin/env bash
# One-off: move the server's three databases from its own `postgres` container to Neon
# (docs/aws-setup.md, section 8, "Moving the databases to Neon").
#
#   ./move-to-neon.sh --dry-run   checks everything, changes nothing
#   ./move-to-neon.sh             the move
#   ./move-to-neon.sh --force     the move, even into a Neon database that already has tables
#                                 (they are dropped and replaced by the copy)
#
# Before: compose.env has BACKEND_DATABASE_URL, VM_MANAGER_DATABASE_URL and LITELLM_DATABASE_URL
# (the Neon addresses, direct host) and the backend repo is on the commit that has this script.
#
# Steps: check the three Neon URLs, that the local copy answers and that each Neon database is
# empty (or missing: it is created) → stop api, worker, vm-manager and LiteLLM → pg_dump each
# local database → pg_restore it into Neon in one transaction → compare every table's row count →
# stop the local `postgres` (its volume is kept) → deploy.sh --no-pull starts everything on Neon.
# Nothing is stopped before every check has passed. If a step after the stop fails, the services
# stay stopped and the script says how to go back.
#
# The Postgres 18 tools run from the `postgres:18` image (Neon is 18; the server's container is
# 16). The dumps are kept in backups/neon-move-<time>/.
#
# Test hooks (laptop only): PG_TOOLS_DIR runs pg_dump/pg_restore/psql from that folder instead of
# Docker; SOURCE_URL_BASE replaces the local container's address; SKIP_SERVICES=1 leaves Docker
# Compose alone (no stop, no start, no deploy).
set -Eeuo pipefail

main() {
  local dry=0 force=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry=1 ;;
      --force) force=1 ;;
      *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
  done

  local root="${ROOT:-/opt/textcrew}"
  local env_file="$root/compose.env" be="$root/beckend"
  [ -f "$env_file" ] || { echo "no $env_file" >&2; exit 1; }

  local sudo=()
  if [ "${SKIP_SERVICES:-0}" != 1 ] && ! docker info >/dev/null 2>&1; then sudo=(sudo); fi
  compose() {
    "${sudo[@]}" docker compose --env-file "$env_file" -f "$be/infra/docker-compose.yml" \
      --profile localdb --profile app "$@"
  }
  # A Postgres 18 tool (pg_dump, pg_restore, psql). Host network: the local container is
  # published on 127.0.0.1:5432 only. The local password goes in through a file (sudo drops the
  # environment, and an argument would show in `ps`); the host's CA certificates are lent for
  # `sslrootcert=system`.
  pgenv=$(mktemp) # global: the EXIT trap runs after main has returned
  trap 'rm -f "$pgenv"' EXIT
  pg18() {
    local tool=$1; shift
    if [ -n "${PG_TOOLS_DIR:-}" ]; then
      "$PG_TOOLS_DIR/$tool" "$@"
    else
      "${sudo[@]}" docker run --rm -i --network host --env-file "$pgenv" \
        -v /etc/ssl/certs:/etc/ssl/certs:ro postgres:18 "$tool" "$@"
    fi
  }

  # --- the addresses ------------------------------------------------------------------------------
  env_value() { sed -n "s/^$1=//p" "$env_file" | tail -n1 | sed -e "s/^['\"]//" -e "s/['\"]\$//"; }
  local -A target
  local local_db
  for local_db in agent vm_manager litellm; do
    local var
    case "$local_db" in
      agent) var=BACKEND_DATABASE_URL ;;
      vm_manager) var=VM_MANAGER_DATABASE_URL ;;
      litellm) var=LITELLM_DATABASE_URL ;;
    esac
    target[$local_db]=$(env_value "$var")
    if [ -z "${target[$local_db]}" ]; then
      echo "compose.env has no $var (the Neon address for the '$local_db' database)" >&2
      exit 1
    fi
    # The backend's URL says sslmode=verify-full; libpq then needs a root certificate named.
    case "${target[$local_db]}" in
      *sslmode=verify-*sslrootcert=*|*sslrootcert=*sslmode=verify-*) ;;
      *sslmode=verify-*) target[$local_db]="${target[$local_db]}&sslrootcert=system" ;;
    esac
    case "${target[$local_db]}" in
      *@postgres:*|*@localhost:*|*@127.0.0.1:*)
        if [ -z "${PG_TOOLS_DIR:-}" ]; then echo "$var still points at the local database" >&2; exit 1; fi ;;
    esac
  done
  local pg_user pg_db
  pg_user=$(env_value POSTGRES_USER); pg_user=${pg_user:-agent}
  pg_db=$(env_value POSTGRES_DB); pg_db=${pg_db:-agent}
  PGPASSWORD=$(env_value POSTGRES_PASSWORD); PGPASSWORD=${PGPASSWORD:-agent}
  export PGPASSWORD
  printf 'PGPASSWORD=%s\n' "$PGPASSWORD" >"$pgenv"
  local source_base="${SOURCE_URL_BASE:-postgresql://$pg_user@127.0.0.1:5432}"
  # The local name of the backend's database is POSTGRES_DB (agent).
  source_url() { if [ "$1" = agent ]; then echo "$source_base/$pg_db"; else echo "$source_base/$1"; fi; }
  # The same Neon address with another database name (to create a missing one from `postgres`).
  with_db() { local url=$1 db=$2 base query=''; base=${url%%\?*}; [ "$base" != "$url" ] && query="?${url#*\?}"; echo "${base%/*}/$db$query"; }
  db_name() { local base=${1%%\?*}; echo "${base##*/}"; }
  # One line per table: "schema.table count", sorted. Read in one query.
  row_counts() {
    local url=$1 q
    q=$(pg18 psql "$url" -v ON_ERROR_STOP=1 -AtX -c "
      select coalesce(string_agg(format('select %L as t, count(*) as n from %I.%I', schemaname || '.' || tablename, schemaname, tablename), ' union all '), 'select null, null where false')
      from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")
    pg18 psql "$url" -v ON_ERROR_STOP=1 -AtX -F ' ' -c "$q" | sort
  }
  table_count() {
    pg18 psql "$1" -v ON_ERROR_STOP=1 -AtX -c \
      "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')"
  }

  # --- checks (nothing is changed here) -----------------------------------------------------------
  echo "== checks"
  if [ "${SKIP_SERVICES:-0}" != 1 ]; then
    compose up -d --wait postgres >/dev/null
  fi
  local name exists
  local -A create
  for local_db in agent vm_manager litellm; do
    name=$(db_name "${target[$local_db]}")
    echo "-- $local_db -> Neon database '$name'"
    echo "   local: $(table_count "$(source_url "$local_db")") tables"
    exists=$(pg18 psql "$(with_db "${target[$local_db]}" postgres)" -v ON_ERROR_STOP=1 -AtX \
      -c "select count(*) from pg_database where datname = '$name'")
    if [ "$exists" = 0 ]; then
      create[$local_db]=1
      echo "   Neon: missing, will be created"
    else
      local n
      n=$(table_count "${target[$local_db]}")
      echo "   Neon: exists, $n tables"
      if [ "$n" != 0 ] && [ "$force" != 1 ]; then
        echo "REFUSED: Neon database '$name' is not empty. Nothing was changed." >&2
        echo "Run with --force to replace what is there with the server's copy." >&2
        exit 1
      fi
    fi
  done
  if [ "$dry" = 1 ]; then
    echo "dry run: all checks passed, nothing was changed"
    return 0
  fi

  # --- the move -----------------------------------------------------------------------------------
  local dir
  dir="$root/backups/neon-move-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dir"
  if [ "${SKIP_SERVICES:-0}" != 1 ]; then
    echo "== stopping api, worker, vm-manager, litellm"
    compose stop api worker vm-manager litellm
  fi
  trap 'echo; echo "MOVE FAILED. The services are stopped. To go back to the local database: remove the three *_DATABASE_URL lines from compose.env, then: ./dc --profile localdb --profile app up -d" >&2' ERR

  for local_db in agent vm_manager litellm; do
    name=$(db_name "${target[$local_db]}")
    echo "== $local_db -> $name"
    if [ "${create[$local_db]:-0}" = 1 ]; then
      pg18 psql "$(with_db "${target[$local_db]}" postgres)" -v ON_ERROR_STOP=1 -qAtX \
        -c "create database \"$name\""
    fi
    pg18 pg_dump --format=custom --no-owner --no-privileges "$(source_url "$local_db")" >"$dir/$local_db.dump"
    echo "   dumped: $(du -h "$dir/$local_db.dump" | cut -f1)"
    local restore=(--no-owner --no-privileges --exit-on-error --single-transaction)
    if [ "$force" = 1 ]; then restore+=(--clean --if-exists); fi
    pg18 pg_restore "${restore[@]}" --dbname "${target[$local_db]}" <"$dir/$local_db.dump"
    row_counts "$(source_url "$local_db")" >"$dir/$local_db.counts.local"
    row_counts "${target[$local_db]}" >"$dir/$local_db.counts.neon"
    if ! diff -u "$dir/$local_db.counts.local" "$dir/$local_db.counts.neon" >&2; then
      echo "row counts differ for $local_db (above: - local, + Neon)" >&2
      false
    fi
    echo "   restored: $(wc -l <"$dir/$local_db.counts.neon") tables, $(awk '{s += $2} END {print s + 0}' "$dir/$local_db.counts.neon") rows, counts match"
  done
  trap - ERR

  if [ "${SKIP_SERVICES:-0}" != 1 ]; then
    echo "== stopping the local postgres (its volume personal-agent_pgdata is kept)"
    compose stop postgres
    echo "== starting everything on Neon"
    "$be/infra/deploy/deploy.sh" --no-pull
  fi
  echo "move done; dumps and counts in $dir"
}

main "$@"
