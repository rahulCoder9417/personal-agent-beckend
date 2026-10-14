#!/usr/bin/env bash
# Deploy the latest `main` of the repos on the server (docs/aws-setup.md, section 8).
#
# Layout (ROOT, default /opt/textcrew):
#   beckend/      git clone of personal-agent-beckend   (its .env holds the api/worker secrets)
#   vm-manager/   git clone of personal-agent-vm-manager
#   user-frontend-web/   optional: git clone of personal-agent-web-frontend (the `web` service);
#                        needs web.env, clerk_secret and WEB_DOMAIN (the web app's README, "Running on the server")
#   compose.env   compose variables (the three database URLs on Neon, LiteLLM master key,
#                 VM_INTERNAL_SECRET, domain…)
#   backups/      BACKUP_HOST_DIR
#
# Steps: pull the repos (hard reset to origin/main) → check the database URLs are set → build images
# (cached layers are reused) → migrations → up → recreate services whose bind-mounted config
# changed → health check.
# The databases are on Neon since 14 Oct 2026: the server's own `postgres` service is not started
# (it is behind the `localdb` profile). move-to-neon.sh did the one-off copy.
# The whole body is in main() so bash has parsed it before `git reset` rewrites this file; after
# the pull the script re-runs itself from the new copy with --no-pull.
set -euo pipefail

main() {
  local root="${ROOT:-/opt/textcrew}"
  local branch="${DEPLOY_BRANCH:-main}"
  local be="$root/beckend" vmm="$root/vm-manager" web="$root/user-frontend-web"
  # The web app is optional: it is pulled, built and run only where its repo is checked out.
  local repos=("$be" "$vmm") profiles=(--profile app)
  if [ -d "$web/.git" ]; then
    repos+=("$web")
    profiles+=(--profile web)
  fi
  # sudo only when this user can't reach Docker; AGENT_IMAGE_VERSION is passed explicitly
  # because sudo drops the environment.
  local sudo=()
  docker info >/dev/null 2>&1 || sudo=(sudo)
  local docker=("${sudo[@]}" docker)
  compose() {
    "${sudo[@]}" env AGENT_IMAGE_VERSION="${AGENT_IMAGE_VERSION:-dev}" \
      GIT_COMMIT="$(git -C "$be" rev-parse --short HEAD 2>/dev/null)" docker compose \
      --env-file "$root/compose.env" -f "$be/infra/docker-compose.yml" "${profiles[@]}" "$@"
  }

  if [ "${1:-}" != "--no-pull" ]; then
    local old_be new_be
    old_be=$(git -C "$be" rev-parse HEAD)
    for repo in "${repos[@]}"; do
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

  # Without these the services would look for the local `postgres`, which no longer runs here.
  local var missing=()
  for var in BACKEND_DATABASE_URL VM_MANAGER_DATABASE_URL LITELLM_DATABASE_URL; do
    grep -q "^$var=." "$root/compose.env" || missing+=("$var")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "DEPLOY STOPPED: compose.env has no ${missing[*]}." >&2
    echo "The databases live on Neon now: add the URLs, then run infra/deploy/move-to-neon.sh" >&2
    echo "once (it copies the data and deploys)." >&2
    exit 1
  fi

  echo "== build"
  compose build --quiet
  # User containers are re-created from a new agent image on their next wake (vm-manager rollout).
  AGENT_IMAGE_VERSION=$("${docker[@]}" image inspect personal-agent/agent:dev --format '{{.Id}}')
  export AGENT_IMAGE_VERSION

  echo "== migrations (on Neon)"
  compose up -d --wait redis
  compose run --rm --no-deps api pnpm --silent db:migrate

  echo "== up"
  compose up -d --remove-orphans
  local svc=()
  case "${RECREATE:-}" in *infra/caddy*) svc+=(caddy) ;; esac
  case "${RECREATE:-}" in *infra/litellm*) svc+=(litellm) ;; esac
  case "${RECREATE:-}" in *squid.conf*) svc+=(egress-proxy vm-manager) ;; esac
  if [ ${#svc[@]} -gt 0 ]; then
    echo "config changed, recreating: ${svc[*]}"
    compose up -d --force-recreate --no-deps "${svc[@]}"
  fi

  echo "== health"
  local domain url ok=0
  domain=$(sed -n 's/^API_DOMAIN=//p' "$root/compose.env")
  url="https://${domain:-localhost}/healthz"
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 "$url" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  compose ps -a --format 'table {{.Service}}\t{{.Status}}'
  local down
  # `postgres` is left out: since the move to Neon it is a stopped container kept only for its volume.
  down=$(compose ps -a --format '{{.Service}} {{.State}}' |
    awk '$1 != "agent-image" && $1 != "postgres" && $2 != "running" {print $1}')
  if [ "$ok" != 1 ] || [ -n "$down" ]; then
    echo "DEPLOY FAILED: health=$ok not running: ${down:-none}" >&2
    exit 1
  fi
  echo "deploy ok: $url"
}

main "$@"
