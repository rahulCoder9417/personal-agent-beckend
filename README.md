# personal-agent-backend

The backend of the Personal Agent MVP: one TypeScript codebase, run as two processes.

- **api** (`src/api/main.ts`): Hono. Webhooks, REST + SSE for the web app, Platform MCP at `/mcp`, Bull Board at `/admin/queues`.
- **worker** (`src/worker/main.ts`): BullMQ. Runs every job (4 queues: `inbound`, `outbound`, `scheduled`, `system`).

Design: `docs/mvp-hld.md`. **System design (planned vs built, gRPC, container lifecycle): `docs/system-design.md`.** **System guide (requirements, architecture, tech stack, what was built, how it works): `docs/build-report.md`.** REST contract: `openapi/openapi.yaml`. gRPC contract: `../vm-manager/proto/vm/v1/vm.proto`.

## Run locally

```bash
pnpm install
cp .env.example .env            # fill in ENCRYPTION_KEY at least
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm dev                        # api on :8080 + worker
```

## Commands

| | |
|---|---|
| Lint / types / tests | `pnpm lint && pnpm typecheck && pnpm test` |
| OpenAPI lint / regenerate types | `pnpm openapi:lint` / `pnpm openapi:gen` |
| Regenerate the gRPC client | `pnpm proto:gen` |
| Migrations | `pnpm db:generate && pnpm db:migrate` |
| Copy the spec to the web app | `pnpm openapi:sync` |
| Restore test (on the server) | `scripts/restore-test.sh` |
| Load test at the awake cap | `LOAD_USERS=40 AWAKE_CAP=15 pnpm tsx scripts/load-test.ts` |

Tests run against a real Postgres (embedded binaries, downloaded by `embedded-postgres`) and a local `redis-server`, one database and queue prefix per test file. External services (vm-manager, Telegram, WhatsApp, Composio, LiteLLM, Polar, Jev) are faked in tests via `set…Api()` / `setVmClient()`.

## Layout

```
src/
  api/          Hono app, spec-driven router (routes declared by operationId), routes, /mcp
  worker/       runner (per-user lock, retries), job registry, schedules
  modules/      auth, channels, events, orchestrator, platform-mcp, integrations, billing, automations, admin
  shared/       config (zod), db, redis, crypto, errors, ids, rate limits
  wiring.ts     composition root: connects modules through their exported hooks
migrations/     drizzle-kit SQL migrations
proto-gen/      generated vm-manager client (buf)
infra/          docker compose, Caddy, LiteLLM, Squid egress proxy, egress test
test/           done-when tests per phase
```

## Not verified on the dev machine

Docker isn't installed on it, so `docker compose up`, the egress test (`infra/tests/egress-test.sh`), real containers, the restore test and the load test have not been run. See `docs/security-checklist.md`.
