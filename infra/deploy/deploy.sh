#!/usr/bin/env bash
# Deploy the latest `main` of both repos on the server (docs/deployment.md, "Deploying").
#
# Layout (ROOT, default /opt/textcrew):
#   beckend/      git clone of personal-agent-beckend   (its .env holds the api/worker secrets)
#   vm-manager/   git clone of personal-agent-vm-manager
#   compose.env   compose variables (Postgres password, LiteLLM master key, VM_INTERNAL_SECRET, domain…)
#   backups/      BACKUP_HOST_DIR
#
# Steps: pull both repos (hard reset to origin/main) → build images (cached layers are reused) →
# migrations → up → recreate services whose bind-mounted config changed → health check.
# The whole body is in main() so bash has parsed it before `git reset` rewrites this file; after
# the pull the script re-runs itself from the new copy with --no-pull.
set -euo pipefail

main() {
  local root="${ROOT:-/opt/textcrew}"
  local branch="${DEPLOY_BRANCH:-main}"
  local be="$root/beckend" vmm="$root/vm-manager"
  local compose=(docker compose --env-file "$root/compose.env" -f "$be/infra/docker-compose.yml" --profile app)
  [ "$(id -u)" = 0 ] || compose=(sudo "${compose[@]}")
  local docker=(docker)
  [ "$(id -u)" = 0 ] || docker=(sudo docker)

  if [ "${1:-}" != "--no-pull" ]; then
    local old_be new_be
    old_be=$(git -C "$be" rev-parse HEAD)
    for repo in "$be" "$vmm"; do
      git -C "$repo" fetch --quiet origin "$branch"
      git -C "$repo" reset --quiet --hard "origin/$branch"
      echo "$(basename "$repo"): $(git -C "$repo" log --oneline -1)"
    done
    new_be=$(git -C "$be" rev-parse HEAD)
    # Bind-mounted config files are replaced (new inode) by git: those services must be recreated.
    local changed
    changed=$(git -C "$be" diff --name-only "$old_be" "$new_be" -- infra/caddy infra/litellm infra/egress-proxy/squid.conf)
    RECREATE="$changed" exec "$be/infra/deploy/deploy.sh" --no-pull
  fi

  echo "== build"
  "${compose[@]}" build --quiet
  # User containers are re-created from a new agent image on their next wake (vm-manager rollout).
  AGENT_IMAGE_VERSION=$("${docker[@]}" image inspect personal-agent/agent:dev --format '{{.Id}}')
  export AGENT_IMAGE_VERSION

  echo "== migrations"
  "${compose[@]}" up -d --wait postgres redis
  "${compose[@]}" run --rm --no-deps api pnpm --silent db:migrate

  echo "== up"
  "${compose[@]}" up -d --remove-orphans
  local svc=()
  case "${RECREATE:-}" in *infra/caddy*) svc+=(caddy) ;; esac
  case "${RECREATE:-}" in *infra/litellm*) svc+=(litellm) ;; esac
  case "${RECREATE:-}" in *squid.conf*) svc+=(egress-proxy vm-manager) ;; esac
  if [ ${#svc[@]} -gt 0 ]; then
    echo "config changed, recreating: ${svc[*]}"
    "${compose[@]}" up -d --force-recreate --no-deps "${svc[@]}"
  fi

  echo "== health"
  local domain url ok=0
  domain=$(sed -n 's/^API_DOMAIN=//p' "$root/compose.env")
  url="https://${domain:-localhost}/healthz"
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 "$url" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  "${compose[@]}" ps -a --format 'table {{.Service}}\t{{.Status}}'
  local down
  down=$("${compose[@]}" ps -a --format '{{.Service}} {{.State}}' | awk '$1 != "agent-image" && $2 != "running" {print $1}')
  if [ "$ok" != 1 ] || [ -n "$down" ]; then
    echo "DEPLOY FAILED: health=$ok not running: ${down:-none}" >&2
    exit 1
  fi
  echo "deploy ok: $url"
}

main "$@"
