# Personal Agent: backend (api + worker)

Messaging-first personal AI agent platform. Users talk to their own agent on WhatsApp / Telegram / iMessage / web; each user's agent (Hermes) runs in its own sandboxed container managed by the separate Go `vm-manager`.

This repo holds the **backend**: one TypeScript codebase run as **two processes**, `api` and `worker`, plus the infra config and docs.

## Read before doing anything

1. **`docs/mvp-hld.md`** is the design and the build plan. Section 0 explains how things work; section 9 lists the build phases.
2. **`openapi/openapi.yaml`** is the REST + webhook contract. It is the source of truth.
3. **`../vm-manager/proto/vm/v1/vm.proto`** is the gRPC contract with the vm-manager. We only consume it (generated client in `proto-gen/`).
4. `docs/deployment.md` covers hosting only; it's not needed for writing code.

## How we work

- **One phase at a time** (HLD section 9). Build only what the current phase asks for. Don't start the next phase until every "done when…" check passes.
- **Plan first:** for any non-trivial change, write a short plan (files, steps, tests) and wait for approval before coding.
- **Contracts first:** a new or changed endpoint means editing `openapi/openapi.yaml` first, then regenerating types, then writing code. Never change the gRPC proto from this repo.
- **Tests with every change.** Write the "done when…" checks as automated tests. Run lint, type-check and tests before saying a task is done, and report real results (paste failures; never claim a pass you didn't see).
- **Small commits** after each working step, with clear messages.
- **Ask when the HLD is unclear or seems wrong.** Don't silently invent behaviour. If you disagree with the design, say so and propose a change to the HLD.

## Stack (don't swap without asking)

Node 22 · TypeScript (strict) · Hono (api) · BullMQ + Redis (jobs) · Postgres + Drizzle (migrations in `migrations/`) · Zod · Clerk (auth) · MCP TypeScript SDK (Platform MCP at `/mcp`) · gRPC client generated with buf · Composio SDK · Jev SDK · LiteLLM (via HTTP) · Dodo Payments · Docker Compose for local dev (`infra/`).

## Architecture rules (never break these)

- **Modular monolith.** Modules: `auth, channels, events, orchestrator, platform-mcp, integrations, billing, automations, admin`. Each module owns its tables. Modules call each other through exported functions, never by touching another module's tables.
- **Webhooks never do work:** verify signature → save the event (unique key) → add a BullMQ job → return 200.
- **api only adds jobs; the worker runs them.** Four queues: `inbound, outbound, scheduled, system`.
- **Every job is safe to re-run** (check "already done?"), with a per-user Redis lock for inbound work.
- **Never talk to Docker or user containers directly.** Always go through the vm-manager's gRPC (`WakeSandbox`, `Deliver`, …).
- **Platform MCP forces the user id from the container token.** Never trust a user id sent by an agent.
- **Composio, provider and database keys never go into a container.**
- **Credits:** grants + an append-only ledger. Never store or edit a single "balance" number. Charges use idempotency keys. Follow HLD section 7 exactly, especially the coupon rules in 7.7.
- **Security:** secrets encrypted in the DB; tokens and codes stored as hashes; no secrets in logs; every user query filtered by user id.

## Conventions

- Folders: `src/modules/<module>/`, `src/api/` (Hono app + routes), `src/worker/` (queue processors), `src/shared/`.
- Errors: always the `Error` shape from `openapi.yaml` (`{ error: { code, message, details? } }`).
- IDs: string ids. Timestamps: UTC ISO. Money in cents; credits as integers.
- Config comes from env vars, validated with Zod at startup. Keep `.env.example` up to date; never commit `.env`.

## Commands

Fill these in during Phase 0 and keep them current:

- Install: `pnpm install`
- Dev (infra + api + worker): `docker compose -f infra/docker-compose.yml up -d && pnpm dev`
- Lint / types / tests: `pnpm lint && pnpm typecheck && pnpm test`
- OpenAPI lint: `pnpm openapi:lint` · Regenerate API types: `pnpm openapi:gen`
- Regenerate gRPC client: `pnpm proto:gen`
- Migrations: `pnpm db:generate && pnpm db:migrate`
- Sync the spec to the frontend: `pnpm openapi:sync` (copies to `../user-frontend/ignore/`)

## Paths

The repo lives in a path with spaces (`b2b ai saas`). Always quote paths in shell commands.
