#!/usr/bin/env bash
# One-off: move the three databases from one Neon project to another (Ohio, us-east-2, to
# Singapore, ap-southeast-1) and switch the server to it (docs/aws-setup.md, section 8,
# "Moving the databases to Neon in Singapore").
#
#   ./move-neon-region.sh --dry-run              checks everything and prints the plan, changes nothing
#   ./move-neon-region.sh                        the move
#   ./move-neon-region.sh --rollback [--dry-run] back to the old project (the OLD_* addresses)
#
# Before: compose.env has the addresses in use (BACKEND_DATABASE_URL, VM_MANAGER_DATABASE_URL,
# LITELLM_DATABASE_URL) and the new project's direct addresses for the same three databases as
# NEW_BACKEND_DATABASE_URL, NEW_VM_MANAGER_DATABASE_URL and NEW_LITELLM_DATABASE_URL.
#
# Steps: check the three NEW_* addresses (set, not the old host, the direct host, the same database
# name), that both sides answer and run the same Postgres major version, that every extension in
# use exists on the new side and that each new database is empty (a missing one is created) →
# stop api, worker, vm-manager and LiteLLM → pg_dump each old database → pg_restore it into the new
# one in one transaction → compare every table's row count → only then rewrite compose.env: the
# three addresses take the new values, the old ones are kept as OLD_*, the NEW_* lines go (a copy
# of the file as it was is kept next to it) → deploy.sh --no-pull starts everything and runs the
# health check. Nothing is stopped before every check has passed. If a step fails before the
# switch, compose.env is untouched and the services are started again on the old project (it was
# only read). --rollback swaps the addresses back (the new ones are kept as NEW_*) and deploys.
#
# The Postgres tools run from the `postgres:<major>` image, the major version both projects run
# (18 on 16 Oct 2026). The dumps and counts are kept in backups/neon-region-move-<time>/.
#
# Test hooks (laptop only): PG_TOOLS_DIR runs pg_dump/pg_restore/psql from that folder instead of
# Docker; SKIP_SERVICES=1 leaves Docker Compose alone (no stop, no start, no deploy).
set -Eeuo pipefail

VARS=(BACKEND_DATABASE_URL VM_MANAGER_DATABASE_URL LITELLM_DATABASE_URL)

main() {
  local dry=0 rollback=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry=1 ;;
      --rollback) rollback=1 ;;
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
      --profile app "$@"
  }
  # A Postgres tool (pg_dump, pg_restore, psql), from postgres:$pg_major. Host network; the host's
  # CA certificates are lent for `sslrootcert=system`.
  pg_major=18 # global: set from the servers' version during the checks
  pgtool() {
    local tool=$1; shift
    if [ -n "${PG_TOOLS_DIR:-}" ]; then
      "$PG_TOOLS_DIR/$tool" "$@"
    else
      "${sudo[@]}" docker run --rm -i --network host \
        -v /etc/ssl/certs:/etc/ssl/certs:ro "postgres:$pg_major" "$tool" "$@"
    fi
  }
  sql() { pgtool psql "$1" -v ON_ERROR_STOP=1 -AtX -c "$2"; }

  # --- reading compose.env (no value is ever printed) --------------------------------------------
  raw_value() { sed -n "s/^$1=//p" "$env_file" | tail -n1 | tr -d '\r'; }
  env_value() { raw_value "$1" | sed -e "s/^['\"]//" -e "s/['\"]\$//"; }
  url_host() { echo "$1" | sed -E 's#^[a-z]+://##; s#^[^@/]*@##; s#[:/?].*$##'; }
  db_name() { local base=${1%%\?*}; echo "${base##*/}"; }
  # The same address with another database name (to create a missing one from `postgres`).
  with_db() { local url=$1 db=$2 base query=''; base=${url%%\?*}; [ "$base" != "$url" ] && query="?${url#*\?}"; echo "${base%/*}/$db$query"; }
  # Where an address points, without its endpoint id: "Neon us-east-2", or the host.
  where() {
    local h; h=$(url_host "$1")
    case "$h" in *.aws.neon.tech) h=${h%.aws.neon.tech}; echo "Neon ${h##*.}" ;; *) echo "$h" ;; esac
  }
  # The backend's addresses say sslmode=verify-full; libpq then needs a root certificate named.
  tool_url() {
    case "$1" in
      *sslmode=verify-*sslrootcert=*|*sslrootcert=*sslmode=verify-*) echo "$1" ;;
      *sslmode=verify-*) echo "$1&sslrootcert=system" ;;
      *) echo "$1" ;;
    esac
  }
  # Rewrite compose.env: NAME=VALUE sets (in place, else appended), -NAME removes. The file as it
  # was is copied first; the new one replaces it in one step (mode 600).
  rewrite_env() {
    local tmp line name kv
    local -A set=() del=() seen=()
    for kv in "$@"; do
      case "$kv" in -*) del[${kv#-}]=1 ;; *) set[${kv%%=*}]=${kv#*=} ;; esac
    done
    tmp=$(mktemp "$env_file.XXXXXX")
    while IFS= read -r line || [ -n "$line" ]; do
      name=${line%%=*}
      # Only NAME=... lines are candidates; comments and anything else are kept as they are.
      if ! [[ "$line" == *=* && "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        printf '%s\n' "$line"
      elif [ -n "${set[$name]+x}" ]; then
        [ -n "${seen[$name]:-}" ] || printf '%s=%s\n' "$name" "${set[$name]}"
        seen[$name]=1
      elif [ -z "${del[$name]+x}" ]; then
        printf '%s\n' "$line"
      fi
    done <"$env_file" >"$tmp"
    for kv in "$@"; do
      case "$kv" in -*) continue ;; esac
      name=${kv%%=*}
      [ -n "${seen[$name]:-}" ] || printf '%s=%s\n' "$name" "${set[$name]}" >>"$tmp"
    done
    chmod 600 "$tmp"
    mv "$tmp" "$env_file"
  }

  local stamp
  stamp=$(date -u +%Y%m%dT%H%M%SZ)

  if [ "$rollback" = 1 ]; then
    do_rollback
    return
  fi

  # --- the addresses ------------------------------------------------------------------------------
  local var db
  local -A old new old_raw new_raw
  for var in "${VARS[@]}"; do
    old[$var]=$(env_value "$var"); old_raw[$var]=$(raw_value "$var")
    new[$var]=$(env_value "NEW_$var"); new_raw[$var]=$(raw_value "NEW_$var")
    if [ -z "${old[$var]}" ]; then
      echo "compose.env has no $var (the database in use now)" >&2; exit 1
    fi
  done
  for var in "${VARS[@]}"; do
    db=$(db_name "${old[$var]}")
    if [ -z "${new[$var]}" ]; then
      echo "compose.env has no NEW_$var (the new project's address for the '$db' database)" >&2; exit 1
    fi
    local h other
    h=$(url_host "${new[$var]}")
    for other in "${VARS[@]}"; do
      if [ "$h" = "$(url_host "${old[$other]}")" ]; then
        echo "NEW_$var points at the old host ($(where "${new[$var]}")); it must be the new Neon project" >&2; exit 1
      fi
    done
    case "$h" in
      *-pooler.*) echo "NEW_$var is a pooled address (-pooler); use the direct one (the same host without -pooler)" >&2; exit 1 ;;
    esac
    if [ "$(db_name "${new[$var]}")" != "$db" ]; then
      echo "NEW_$var names the database '$(db_name "${new[$var]}")'; it must be '$db', as $var does" >&2; exit 1
    fi
  done

  echo "== plan (nothing has been changed yet)"
  for var in "${VARS[@]}"; do
    printf '   %-10s %s -> %s\n' "$(db_name "${old[$var]}")" "$(where "${old[$var]}")" "$(where "${new[$var]}")"
  done
  cat <<EOF
   1. check both sides: they answer, the same Postgres version, extensions, the new databases empty
   2. stop api, worker, vm-manager and litellm (the bot does not answer from here)
   3. pg_dump each old database, pg_restore it into the new one (dumps in backups/neon-region-move-$stamp/)
   4. compare every table's row count on both sides
   5. switch the three addresses in compose.env; the old ones stay as OLD_* (copy: compose.env.bak-$stamp)
   6. deploy.sh --no-pull: start everything on the new project, health check
EOF

  # --- checks (nothing is changed here) -----------------------------------------------------------
  echo "== checks"
  local o n vo vn mo mn exts avail e exists
  local -A create
  for var in "${VARS[@]}"; do
    o=$(tool_url "${old[$var]}"); n=$(tool_url "${new[$var]}"); db=$(db_name "$o")
    echo "-- $db"
    # The TLS setting should stay as it is (the backend's says verify-full; Neon's console gives
    # require). Not a refusal: both encrypt, the Node driver treats require as verify-full.
    local so sn
    so=$(echo "${old[$var]}" | sed -n 's/.*[?&]sslmode=\([^&]*\).*/\1/p')
    sn=$(echo "${new[$var]}" | sed -n 's/.*[?&]sslmode=\([^&]*\).*/\1/p')
    if [ "$so" != "$sn" ]; then
      echo "   note: NEW_$var says sslmode=${sn:-(none)}, $var says sslmode=${so:-(none)}; better the same"
    fi
    vo=$(sql "$o" "show server_version_num"); mo=$((vo / 10000))
    vn=$(sql "$(with_db "$n" postgres)" "show server_version_num"); mn=$((vn / 10000))
    echo "   Postgres: old $mo, new $mn"
    if [ "$mo" != "$mn" ]; then
      echo "REFUSED: the new project runs Postgres $mn, the old one $mo. Create it with Postgres $mo. Nothing was changed." >&2
      exit 1
    fi
    pg_major=$mo
    echo "   old: $(sql "$o" "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')") tables"
    exts=$(sql "$o" "select coalesce(string_agg(extname, ' ' order by extname), '') from pg_extension where extname <> 'plpgsql'")
    if [ -n "$exts" ]; then
      avail=" $(sql "$(with_db "$n" postgres)" "select string_agg(name, ' ') from pg_available_extensions") "
      for e in $exts; do
        case "$avail" in *" $e "*) ;; *) echo "REFUSED: the extension $e is used by '$db' and not available on the new project. Nothing was changed." >&2; exit 1 ;; esac
      done
      echo "   extensions: $exts (available on the new project)"
    fi
    exists=$(sql "$(with_db "$n" postgres)" "select count(*) from pg_database where datname = '$db'")
    if [ "$exists" = 0 ]; then
      create[$var]=1
      echo "   new: missing, will be created"
    else
      local count
      count=$(sql "$n" "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")
      echo "   new: exists, $count tables"
      if [ "$count" != 0 ]; then
        echo "REFUSED: the new database '$db' is not empty. Nothing was changed." >&2
        echo "Delete it and create it again in the Neon console, then run this again." >&2
        exit 1
      fi
    fi
  done
  if [ "$dry" = 1 ]; then
    echo "dry run: all checks passed, nothing was changed"
    return 0
  fi

  # --- the move -----------------------------------------------------------------------------------
  # One row per table: "schema.table count", sorted. Read in one query.
  row_counts() {
    local url=$1 q
    q=$(sql "$url" "select coalesce(string_agg(format('select %L as t, count(*) as n from %I.%I', schemaname || '.' || tablename, schemaname, tablename), ' union all '), 'select null, null where false')
      from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")
    pgtool psql "$url" -v ON_ERROR_STOP=1 -AtX -F ' ' -c "$q" | sort
  }
  local dir="$root/backups/neon-region-move-$stamp"
  mkdir -p "$dir"
  chmod 700 "$dir"
  if [ "${SKIP_SERVICES:-0}" != 1 ]; then
    echo "== stopping api, worker, vm-manager, litellm"
    compose stop api worker vm-manager litellm
  fi
  trap 'before_switch_failed' ERR
  before_switch_failed() {
    trap - ERR
    echo >&2
    echo "MOVE FAILED before the switch. compose.env is unchanged; the old project was only read." >&2
    if [ "${SKIP_SERVICES:-0}" != 1 ]; then
      echo "Starting the services again on the old project." >&2
      compose start api worker vm-manager litellm >&2 || true
    fi
    echo "The new databases may hold a part of the copy: delete and create them again before a new try." >&2
  }

  for var in "${VARS[@]}"; do
    o=$(tool_url "${old[$var]}"); n=$(tool_url "${new[$var]}"); db=$(db_name "$o")
    echo "== $db"
    if [ "${create[$var]:-0}" = 1 ]; then
      sql "$(with_db "$n" postgres)" "create database \"$db\"" >/dev/null
    fi
    local dump=(--format=custom --no-owner --no-privileges)
    if [ "$pg_major" -ge 18 ]; then dump+=(--no-statistics); fi
    pgtool pg_dump "${dump[@]}" "$o" >"$dir/$db.dump"
    echo "   dumped: $(du -h "$dir/$db.dump" | cut -f1)"
    pgtool pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname "$n" <"$dir/$db.dump"
    row_counts "$o" >"$dir/$db.counts.old"
    row_counts "$n" >"$dir/$db.counts.new"
    if ! diff -u "$dir/$db.counts.old" "$dir/$db.counts.new" >&2; then
      echo "row counts differ for $db (above: - old, + new)" >&2
      false
    fi
    # Fresh planner statistics (the dump leaves them out); a refusal here is not a failure.
    sql "$n" "analyze" >/dev/null 2>&1 || echo "   (analyze skipped; autovacuum will do it)"
    echo "   restored: $(wc -l <"$dir/$db.counts.new") tables, $(awk '{s += $2} END {print s + 0}' "$dir/$db.counts.new") rows, counts match"
  done

  echo "== switching compose.env (copy of the old file: compose.env.bak-$stamp)"
  cp -p "$env_file" "$env_file.bak-$stamp"
  chmod 600 "$env_file.bak-$stamp"
  local changes=()
  for var in "${VARS[@]}"; do
    changes+=("$var=${new_raw[$var]}" "OLD_$var=${old_raw[$var]}" "-NEW_$var")
  done
  rewrite_env "${changes[@]}"
  trap - ERR
  trap 'echo; echo "FAILED after the switch: compose.env names the new project. To go back: $be/infra/deploy/move-neon-region.sh --rollback" >&2' ERR

  if [ "${SKIP_SERVICES:-0}" != 1 ]; then
    echo "== starting everything on the new project"
    "$be/infra/deploy/deploy.sh" --no-pull
  fi
  trap - ERR
  echo "move done; dumps and counts in $dir"
  echo "To go back: $be/infra/deploy/move-neon-region.sh --rollback (anything written since the move stays on the new project)"
}

# Back to the old project: the OLD_* addresses become the ones in use, the current ones are kept as
# NEW_*. Runs inside main (uses its helpers and variables).
do_rollback() {
  local var
  local -A cur_raw old_raw
  for var in "${VARS[@]}"; do
    cur_raw[$var]=$(raw_value "$var"); old_raw[$var]=$(raw_value "OLD_$var")
    if [ -z "${old_raw[$var]}" ]; then
      echo "compose.env has no OLD_$var: there is nothing to roll back to" >&2; exit 1
    fi
  done
  echo "== plan (nothing has been changed yet)"
  for var in "${VARS[@]}"; do
    printf '   %-10s %s -> back to %s\n' "$(db_name "$(env_value "$var")")" \
      "$(where "$(env_value "$var")")" "$(where "$(env_value "OLD_$var")")"
  done
  cat <<EOF
   1. stop api, worker, vm-manager and litellm
   2. compose.env: the OLD_* addresses back in use, the current ones kept as NEW_* (copy: compose.env.bak-$stamp)
   3. deploy.sh --no-pull: start everything on the old project, health check
   Anything written on the current project since the move is not copied back.
EOF
  if [ "$dry" = 1 ]; then
    echo "dry run: nothing was changed"
    return 0
  fi
  if [ "${SKIP_SERVICES:-0}" != 1 ]; then
    echo "== stopping api, worker, vm-manager, litellm"
    compose stop api worker vm-manager litellm
  fi
  cp -p "$env_file" "$env_file.bak-$stamp"
  chmod 600 "$env_file.bak-$stamp"
  local changes=()
  for var in "${VARS[@]}"; do
    changes+=("$var=${old_raw[$var]}" "NEW_$var=${cur_raw[$var]}" "-OLD_$var")
  done
  rewrite_env "${changes[@]}"
  echo "== compose.env switched back"
  if [ "${SKIP_SERVICES:-0}" != 1 ]; then
    "$be/infra/deploy/deploy.sh" --no-pull
  fi
  echo "rollback done"
}

main "$@"
