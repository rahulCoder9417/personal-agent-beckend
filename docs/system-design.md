# Personal Agent — System Design

What was planned, what was built and how, the tech used and where, how gRPC and every other connection works, how the vm-manager opens and closes containers, and what is left to test.

- **Diagrams:** GoDraw canvas **"Personal Agent — System Design (planned vs built)"** — page 1 original design · page 2 system now · page 3 one message end to end · page 4 container open/close.
- **Reference (every table, endpoint, env var):** `docs/build-report.md`. **Original design:** `docs/mvp-hld.md`.
- **Code:** `beckend/` (api + worker, TypeScript) and `vm-manager/` (Go + the agent image), branch `main`.
- **Date:** 2026-09-30.

## Contents

- **Part A — The original design** (what was planned first)
- **Part B — What is built now, and how**
- **Part C — Tech stack: what each tool does and where**
- **Part D — How the parts talk (REST, webhooks, jobs, gRPC, Bridge, MCP)**
- **Part E — How the vm-manager opens and closes containers**
- **Part F — What is left to test**
- **Glossary**

---

# Part A — The original design

## A.1 The product

A personal AI assistant people message on **WhatsApp, Telegram, iMessage or the web app**. Every user gets **their own sandboxed container** running an AI agent (Hermes). The agent does real work in about **25 apps** (Gmail, Calendar, Notion, Slack…) through Composio, plus the user's own MCP servers, **asks before risky actions**, **remembers** the user, runs **reminders and automations**, and is billed in **credits**.

## A.2 The planned architecture

```
 Users ──▶ WhatsApp / Telegram / iMessage / Web
                     │ signed webhooks, REST
                     ▼
                  Caddy (HTTPS)
                     ▼
   ┌─────────────── backend (one TypeScript codebase) ───────────────┐
   │  api:    webhooks · REST + SSE · Platform MCP (/mcp) · admin     │
   │  worker: runs every job (BullMQ)                                 │
   └──────────────┬──────────────────────────────┬────────────────────┘
          Postgres + Redis                       │ gRPC
                                                 ▼
                              vm-manager (Go) — only service with Docker
                                                 │ Docker API + HTTP
                                                 ▼
                         per-user container: Hermes + Bridge (gVisor)
                                                 │ only way out
                                                 ▼
                         egress proxy ──▶ LiteLLM ──▶ model providers
                                     └──▶ api /mcp (agent tools)
```

| Unit | Why it exists |
|---|---|
| **api + worker** | One codebase, two processes. The api only **adds** jobs; the worker only **runs** them. Splitting further would add network calls with no benefit at MVP scale. |
| **vm-manager** | A separate **Go** service because it holds the Docker socket (effectively root). Keeping it small and separate limits damage if the backend has a bug. |
| **Agent container** | One per user, untrusted: the agent (Hermes) plus our Bridge adapter. |
| **Postgres, Redis, LiteLLM, egress proxy, Caddy** | Off-the-shelf, configured not coded. |

## A.3 The planned rules

1. **Webhooks never do work:** verify signature → save the event (unique key) → add a job → answer 200.
2. **Four queues** so slow work never blocks fast work: `inbound`, `outbound`, `scheduled`, `system`.
3. **Every job is safe to re-run**; a **per-user lock** so one user's messages never run in parallel.
4. **The agent can't impersonate:** the Platform MCP takes the user id from the container's token, never from the agent.
5. **No platform keys in containers.** Containers reach only the egress proxy.
6. **Credits = grants + an append-only ledger.** Never a stored balance. Idempotent charges.
7. **Containers stop after 3 idle minutes**, never mid-turn, with an awake cap on the server.
8. **Contracts first:** `openapi.yaml` for REST, `vm.proto` for gRPC.

## A.4 The planned modules (backend)

auth · channels · events · orchestrator · platform-mcp · integrations · billing · automations · admin — each owns its own tables and exposes functions to the others.

## A.5 The planned build phases

| Phase | Build |
|---|---|
| 0 | Repo, docker-compose, config, lint/test/CI |
| 1 | api skeleton, OpenAPI wiring, DB, Clerk, webhook intake, queues + lock |
| 2 | vm-manager (Go) + agent image (Hermes + Bridge) |
| 3 | Telegram end to end, Platform MCP (send_message, get_profile) |
| 4 | Composio apps, approvals, user MCP servers, audit log |
| 5 | Credits, plans, coupons, Dodo payments, LiteLLM keys, BYOK |
| 6 | WhatsApp, media + voice, Jev routing |
| 7 | Automations and reminders |
| 8 | Backups, rate limits, logs/metrics/alerts, admin views, iMessage, load test |

## A.6 The original pricing

Free $0 (100 sign-up credits, 3 automations, cheap model) · Pro $12 (1,500 credits/month, 20 automations) · Max $29 (4,500/month, 50 automations, own MCP servers). Monthly credits expired at renewal, top-ups after 12 months, coupons after 30 days.

---

# Part B — What is built now, and how

## B.1 Summary

All 8 phases are built, plus four later changes. Everything is tested with real Postgres and Redis and fakes for outside services. **Nothing has run in Docker or against real outside services yet** (see Part F).

| Area | Built | Status |
|---|---|---|
| Backend (api + worker) | 9 modules, 26 tables, 56 REST operations, 21 job types | ✅ 204 tests |
| vm-manager | 15 gRPC calls, 5 background loops | ✅ Go tests, `-race` clean |
| Agent image | Hermes + Claude Code + our Python Bridge | ✅ 54 Bridge tests (fakes) |
| Infra | docker-compose (3 networks), Caddy, Squid, LiteLLM config | ⚠️ never started |

## B.2 What changed from the original design

| Change | Planned | Now | Why |
|---|---|---|---|
| **Second agent runtime** | Hermes only | Hermes **or Claude Code** | Users can bring their own Claude plan (Anthropic allows the unmodified Claude Code in hosted sandboxes) |
| **AI source rule** | Platform credits | Claude plan → Claude Code · own API key → Hermes · else credits (or "connect your AI" with `AI_ACCESS_MODE=own_only`) | MVP is "bring your own AI" |
| **Pricing** | Max $29, 3/20/50 automations, mixed expiry | Max **$30**, **1/5/50**, **every credit 90 days**, monthly credits carry over | Matches the landing page |
| **Waitlist** | — | Public join API with IP/abuse data + 50% off first month | Launch marketing |
| **Platform network** | "no internet" | Outbound allowed, nothing exposed | The worker must call Telegram, Composio… |
| **Spec** | — | 400/503 responses documented where the code returns them | Contract accuracy |

## B.3 Backend modules — what each does

| Module | Owns | Does |
|---|---|---|
| **auth** | users, link_codes, channel_links, waitlist | Clerk sign-in, account lifecycle, linking chat apps with one-time codes, waitlist |
| **events** | events | Webhook intake (event + job, deduplicated), the 4 queues, recovery after Redis loss, cleanup |
| **channels** | messages, attachments | Telegram/WhatsApp/Sendblue/web adapters, sending (24-hour rule, buttons, long-text split), media + voice→text, SSE live updates |
| **orchestrator** | sandbox_tokens, approvals, agent_settings | The turn flow, per-user lock, Jev routing, approvals, container tokens, which agent runs, Claude sign-in, the gRPC client |
| **platform-mcp** | — | The `/mcp` server: 9 tools the agent calls |
| **integrations** | connections, user_mcp_servers, byok_keys, composio_triggers | Composio (catalog, connect, actions, triggers), user MCP servers, own API keys |
| **billing** | subscriptions, payments, credit_grants, credit_ledger, usage_periods, coupons, coupon_codes, coupon_redemptions, litellm_keys | Plans, credits, charging, LiteLLM keys and budgets, Dodo, coupons |
| **automations** | automations | Reminders and automations, timers, triggers, auto-pause |
| **admin** | audit_log | Audit log, alerts, metrics, health check, backups |

`src/wiring.ts` connects modules through small hooks (e.g. billing tells automations "balance hit zero"), so no module reaches into another's tables.

## B.4 How the main things work (short)

**Sign-up.** Clerk sends `user.created` (signed) → event + job → the worker creates the user, grants 100 credits (90 days), creates their LiteLLM key, then calls gRPC **CreateSandbox** (container created, left stopped) and stores the hash of the container's token.

**Linking a chat.** The web app gets a code like `LINK-7KQ2-M9XP` (stored as a hash, 10 minutes). The user sends it to our bot; the worker links that chat id to the user.

**A message** (canvas page 3). Webhook → event + job → worker takes the user's lock → special cases (link code, approval answer, coupon code, media) → credits and AI-source check → Jev routing (simple questions answered by a cheap model without waking anything) → **WakeSandbox** → **Deliver** (gRPC stream) → the agent calls our tools on `/mcp` → `send_message` → outbound job → the channel. After the turn: charge usage, push `credits.updated`, release the lock.

**Tools the agent has** (Platform MCP): `send_message`, `get_profile`, `list_app_actions`, `run_app_action`, `request_approval`, `schedule_reminder`, `create_automation`, `list_automations`, `cancel_automation`. The user id always comes from the container's token.

**Approvals.** The agent calls `request_approval` → the user gets ✅/❌ buttons → the agent ends its turn. The answer comes back later as a new delivery; risky actions (send, delete, pay…) only run with an approved, single-use approval for the **exact** same action and arguments.

**Credits.** Grants (each with its own 90-day expiry) + an append-only ledger (a database trigger blocks edits). Spent oldest-expiry first. Every 5 minutes and after each turn, `sync-usage` reads AI spend (LiteLLM) and awake time (vm-manager **GetUsage**) and writes **one** charge per user per period with a unique key, so re-runs never double-charge. At zero: automations pause and the LiteLLM budget closes.

**Payments.** Dodo checkout (waitlist members get 50% off the first month automatically). Plans change only when Dodo's signed webhook arrives.

**Automations.** Once (delayed job), repeating (BullMQ job scheduler with cron + timezone), or app event (Composio trigger → webhook). Postgres is the source of truth; timers are re-registered on every worker start.

**Bring your own AI.**
| User has | Agent | Pays for AI |
|---|---|---|
| Connected Claude plan (chose Claude Code) | Claude Code | Their Claude plan |
| Own API key | Hermes | Their key |
| Nothing | Hermes on credits — or "connect your AI" with `own_only` | Platform credits / — |

Connecting a Claude plan: gRPC **StartClaudeLogin** runs the official `claude auth login` inside the user's container → the user signs in on Anthropic's page → pastes the code → **CompleteClaudeLogin** types it into the waiting CLI → Claude Code saves its own login in `/data`. We never see or store the login.

---

# Part C — Tech stack: what each tool does and where

## C.1 Backend (`beckend/`)

| Tech | What it is | Where / how we use it |
|---|---|---|
| **Node.js 22 + TypeScript (strict)** | Runtime + typed JavaScript | Both processes; run with **tsx** (no build step) |
| **pnpm** | Package manager | Installs, scripts, CI (`packageManager: pnpm@10.33.0`) |
| **Hono** | Small, fast web framework | The api: routes, middleware, SSE (`streamSSE`) |
| **OpenAPI 3.1** (`openapi/openapi.yaml`) | The REST contract | **Source of truth.** `src/api/router.ts` registers routes by `operationId`; method, path, auth and validation are read from the spec |
| **Ajv** + ajv-formats | JSON-schema validator | Validates every request against the spec; tests validate every response |
| **openapi-typescript** | Code generator | Types for request/response bodies (`src/api/openapi/schema.d.ts`) |
| **Redocly CLI** | Spec linter | `pnpm openapi:lint` in CI |
| **Zod** | Runtime validation | Env config at startup; MCP tool inputs |
| **Postgres 16 + Drizzle ORM** | Database + typed query builder | All platform data; SQL migrations in `migrations/` via drizzle-kit |
| **Redis 7 + BullMQ** | Queue library on Redis | 4 queues, retries, delayed jobs, cron schedulers, priorities; Redis also holds locks, rate-limit counters and SSE pub/sub |
| **Bull Board** | Queue dashboard | `/admin/queues`, admins only |
| **Clerk** (`@clerk/backend`, svix) | Auth provider | Verifies web session JWTs; Clerk webhooks create/delete users |
| **MCP TypeScript SDK** | Model Context Protocol server | The Platform MCP at `/mcp` (stateless streamable HTTP) |
| **Connect-ES + buf** | gRPC client + code generator | `pnpm proto:gen` generates `proto-gen/` from `vm.proto`; `src/modules/orchestrator/vm.ts` is the client |
| **Composio SDK** (`@composio/core`) | App integrations | Connect links, run actions, triggers, webhook verification |
| **TypeSafe Jev SDK** | Message router | simple / task / spam decision (falls back to "task") |
| **Dodo Payments** + standardwebhooks | Payments | Checkout, subscriptions, top-ups, refunds, webhooks |
| **LiteLLM** (HTTP) | AI gateway | Per-user virtual keys with budgets, spend tracking, model alias `agent-default`, speech-to-text |
| **cron-parser** | Cron maths | Next run times, the 15-minute minimum |
| **pino** | JSON logger | Structured logs with secrets redacted |
| **Node crypto** | AES-256-GCM, sha256, HMAC | Encrypted columns, hashed tokens/codes, signed file URLs |
| **Vitest + embedded-postgres + redis-server + jose** | Tests | Real Postgres/Redis per test file; test JWTs |
| **ESLint + Prettier + GitHub Actions** | Quality | `pnpm lint && pnpm typecheck && pnpm test` in CI |

## C.2 vm-manager (`vm-manager/`)

| Tech | Where / how |
|---|---|
| **Go 1.26** | The service (`cmd/vm-manager`, `internal/*`) |
| **grpc-go + protobuf + buf** | Serves `vm.v1.VmManager` on :9090; code in `gen/vm/v1` |
| **Docker Engine Go SDK** | Create/start/stop/remove containers and volumes, copy files, archives, signals — behind an interface with a fake for tests |
| **gVisor (`runsc`)** | The container runtime: a user-space kernel between the container and the host |
| **pgx** | Its own Postgres database: `sandboxes`, `awake_periods` |
| **slog** | JSON logs; `alert=true` lines for alerting |

## C.3 Agent image (`vm-manager/agent-image/`)

| Part | What |
|---|---|
| **Python 3.14 slim** base | Non-root uid 10001; read-only root friendly |
| **Hermes Agent** (Nous Research, pinned commit) | The default agent: loop, memory, skills, sessions, terminal, files |
| **Claude Code CLI** (pinned 2.1.283, signature-checked, unmodified) | The second agent, on the user's Claude plan |
| **Bridge** (our Python, standard library) | HTTP server on :8765 the vm-manager talks to; runs Hermes or Claude Code per delivery; sends the final answer through `send_message` |

## C.4 Infrastructure (`beckend/infra/`)

| Component | Role |
|---|---|
| **Caddy** | HTTPS in front of the api (only public service) |
| **Squid** | Egress proxy — the only way out of containers |
| **LiteLLM** | AI gateway (`cheap`, `claude`, `gpt`, `whisper` models + fallbacks) |
| **Postgres, Redis** | Databases `agent`, `vm_manager`, `litellm`; Redis with append-only persistence |
| **docker-compose** | 3 networks: `edge` (Caddy + api), `platform` (services), `sandbox` (internal: containers + proxy + vm-manager) |

---

# Part D — How the parts talk

## D.1 Map

| From → To | How | Auth |
|---|---|---|
| Web app → api | REST (JSON) + SSE | Clerk session JWT (`Authorization: Bearer`, or `?token=` for SSE) |
| Telegram/WhatsApp/Sendblue/Clerk/Dodo/Composio → api | HTTPS webhooks | Each provider's signature/secret, checked on the raw body |
| api → worker | BullMQ jobs in Redis | Same process group; job id = event id |
| worker / api → vm-manager | **gRPC** | Metadata `x-internal-secret`, platform network only |
| vm-manager → container | Docker API + HTTP to the Bridge | Per-container Bridge secret (`X-Bridge-Secret`) |
| Container → api | MCP (streamable HTTP) at `/mcp`, through Squid | Per-container token (`Authorization: Bearer`) |
| Container → AI | Hermes → LiteLLM; Claude Code → Anthropic; through Squid | User's LiteLLM key / user's own Claude login |

## D.2 REST (web app ↔ api)

- 56 operations in `openapi.yaml` (profile, channels, chat + attachments + SSE, approvals, apps, MCP servers, own keys, automations, agent status + settings + Claude sign-in, billing, credits, usage, coupons, activity, waitlist, admin, webhooks). List: `build-report.md` §8.1.
- Errors always `{ "error": { "code", "message", "details?" } }`.
- Lists use `cursor` + `limit` → `nextCursor`.
- Live updates over `GET /v1/stream` (SSE): `message.created`, `message.status`, `approval.created`, `approval.resolved`, `agent.status`, `credits.updated`, `automation.updated`.

## D.3 Jobs (api → worker)

| Queue | Jobs |
|---|---|
| inbound | process-message, web-message, process-approval, automation-turn, composio-trigger |
| outbound | send-message, send-raw, message-status |
| scheduled | run-automation |
| system | clerk-event, onboard-user, delete-user, sync-allowlist, composio-event, dodo-event, sync-usage (5 min), expire-credits (hourly), expire-approvals (hourly), cleanup (daily), backup (nightly), health-check (5 min) |

Retries 5 s → 30 s → 2 min → 10 min (5 tries). Inbound jobs take the user's Redis lock (`lock:user:<id>`); a busy user's job is pushed back 2 s. Max-plan jobs get higher priority.

## D.4 gRPC (backend → vm-manager) in detail

**What gRPC is here:** a typed remote-function-call protocol over HTTP/2. The contract `vm-manager/proto/vm/v1/vm.proto` defines the service and messages. `buf` generates Go server code for the vm-manager and TypeScript client code (`proto-gen/`) for the backend, so both sides always agree on names and types.

**How the backend calls it:** `vm()` in `src/modules/orchestrator/vm.ts` creates a Connect-ES client with the gRPC transport, pointing at `VM_MANAGER_URL` (`http://vm-manager:9090`). An interceptor adds `x-internal-secret: <VM_INTERNAL_SECRET>` to every call. The vm-manager rejects calls without it (`UNAUTHENTICATED`). The port is only on the private platform network.

**Unary vs streaming:** most calls are request → response. **Deliver** is **server-streaming**: the backend sends one request and reads a stream of events until the turn ends.

| RPC | Called by (backend) | What the vm-manager does | Returns |
|---|---|---|---|
| **CreateSandbox** | `onboard-user` job → `ensureSandbox` | Creates volume + container (stopped), random MCP token + Bridge secret, writes `/data/.platform/platform.json` | `Sandbox`, `mcp_token_hash` (backend stores it to map token → user) |
| **WakeSandbox** | Every turn (`turn.ts`) | Capacity guard, start container, wait for Bridge health, write egress file | `Sandbox`, `was_stopped` |
| **Deliver** (stream) | Every turn, right after Wake | Marks in flight, `POST /deliver` to the Bridge, relays events | Stream: `ACCEPTED` → `WORKING`… → `TURN_DONE` or `ERROR(platform_fault)` |
| **Touch** | Every `/mcp` tool call | Refreshes last-active (so the reaper waits) | — |
| **StopSandbox** | Not called by the backend today (for ops/tools) | Polite or forced stop | `Sandbox` |
| **DeleteSandbox** | `delete-user` job | Removes container, volume, egress file | — |
| **GetSandbox** | `GET /v1/agent/status`, Claude status checks | Reads the row + live memory | `Sandbox` (state, last active, memory, runtime, claude_connected) |
| **ListSandboxes** | Backup job, health check, load-test script | Lists rows | `Sandbox[]` |
| **GetUsage** | `sync-usage` (billing) | Sums awake seconds per user in a window from `awake_periods` | per-user awake/browser seconds |
| **SetEgressAllowlist** | `sync-allowlist` job (user MCP servers changed) | Rewrites the user's Squid file + MCP config | — |
| **SnapshotVolume** | Nightly `backup` job | Streams `/data` to a `tar.gz` | path, size |
| **SetAgentRuntime** | Agent settings change, after wake if out of sync | Writes `runtime` to platform.json + table, updates egress | `Sandbox` |
| **StartClaudeLogin** | `POST /v1/agent/claude/login` | Wakes, starts `claude auth login` in the container | `login_id`, Anthropic `authorize_url`, expiry |
| **CompleteClaudeLogin** | `POST /v1/agent/claude/login/{id}/complete` | Types the user's code into the waiting CLI (never logged) | `connected`, safe message |
| **ClaudeLogout** | `DELETE /v1/agent/claude` | `claude auth logout` | — |

**Error codes and what the backend does:**
| gRPC code | Meaning | Backend reaction |
|---|---|---|
| `NOT_FOUND` | No sandbox for this user | Create it / "none" status |
| `RESOURCE_EXHAUSTED` | Awake cap reached, nothing evictable | Job retries with backoff ("server full: wait") |
| `UNAVAILABLE` / `DEADLINE_EXCEEDED` | vm-manager or container down | Job retries; web endpoints return 503 |
| `FAILED_PRECONDITION` | Polite stop during a turn; expired/unknown Claude sign-in | 400/409 to the user |
| `INVALID_ARGUMENT` | Bad input | 400 |
| `UNAUTHENTICATED` | Missing/wrong internal secret | Misconfiguration — alert |

## D.5 vm-manager ↔ Bridge (HTTP inside the sandbox network)

| Call | Behaviour |
|---|---|
| `GET /healthz` | `200 {ok, busy, runtime, claude_connected, claude_login_pending}` when the agent answers |
| `POST /deliver` | Runs one turn; response is **NDJSON** (one JSON event per line): `accepted`, `working`, `turn_done` or `error` |
| `POST /shutdown` | Stop taking work, let the agent save to `/data`, answer within 20 s |
| `POST /claude/login/start`, `/complete`, `/claude/logout` | Claude Code sign-in helpers |

Every call except `/healthz` needs `X-Bridge-Secret`. The Bridge deduplicates by `delivery_id` (saved in `/data/.platform/deliveries.json`), so a retried delivery never runs twice.

## D.6 Container → Platform MCP

The agent (Hermes or Claude Code) is configured with our MCP server URL `http://api:8080/mcp` and `Authorization: Bearer <container token>`. The api hashes the token, finds the user in `sandbox_tokens`, and every tool runs for that user only. Each call is audit-logged and Touches the container. Files for the agent are served at `/mcp/files/<id>?exp&sig` (signed, 1 hour) because `/mcp` is the only api path the proxy allows.

---

# Part E — How the vm-manager opens and closes containers

## E.1 What a "VM" is here

- It is **not** a separate cloud VM. It's a **Docker container** running under **gVisor** on the **same server** as the backend.
- gVisor gives each container its own user-space kernel, so code inside can't easily reach the host kernel. That's the "VM-like" isolation.
- On AWS this means **one EC2 instance** runs everything: the vm-manager creates, starts and stops containers there. No AWS API is involved.

## E.2 What each user has

| Thing | Name | Lives |
|---|---|---|
| Container | `pa-sbx-<user_id>` | Created once; started/stopped many times |
| Volume | `pa-data-<user_id>` mounted at `/data` | Forever (until account deletion) |
| Row | `sandboxes` table (vm-manager DB) | State, priority, last active, token/secret hashes, runtime |
| Awake periods | `awake_periods` table | One row per start→stop (billing) |
| Egress file | `<user_id>.conf` in the Squid allowlist dir | Only while awake |

**Inside `/data`:** `.platform/platform.json` (the container's secrets and config, mode 0600) · `.platform/deliveries.json` (dedupe) · `.platform/claude-sessions.json` · `hermes/` (memory, skills, sessions) · `claude/` (Claude Code's own login + sessions) · `workspace/`, `home/`, `tmp/`.

## E.3 The container spec

| Setting | Value | Why |
|---|---|---|
| Runtime | `runsc` (gVisor) | Isolation |
| Memory | 600 MB, no swap | Fits many per server |
| CPU | 1 | Fairness |
| Processes | max 256 | No fork bombs |
| Root filesystem | read-only | Only `/data` can change |
| Capabilities | all dropped, `no-new-privileges` | Least privilege |
| User | uid 10001 (not root) | Least privilege |
| Network | `sandbox` only (internal), proxy env vars set | Only way out is Squid |
| Ports | none published | Nothing can connect in except the vm-manager |
| Restart policy | none | The vm-manager decides |
| Env | user id, URLs, proxy — **no secrets** | Secrets are only in the user's own `/data` file |

## E.4 The states (canvas page 4)

```
 (none) ──CreateSandbox──▶ STOPPED ──Wake/Deliver──▶ WAKING ──Bridge healthy──▶ AWAKE ◀──turn_done── BUSY
                              ▲                          │                       │  └──accepted──▶ BUSY
                              │                          └─ start fails twice ──▶ BROKEN
                              ├──── idle ≥ 3 min / capacity eviction (polite) ───┘
                              └──── turn > 15 min (force) ◀── BUSY
 STOPPED ──DeleteSandbox──▶ (deleted)
```

## E.5 Create (once, at sign-up)

1. Validate input (user id format, LiteLLM key present, allowlist domains, MCP servers, runtime).
2. Take the user's lock. If a row exists → return it (idempotent).
3. Make two random 32-byte secrets: the **MCP token** and the **Bridge secret**.
4. Create volume `pa-data-<user>`; remove any half-created container from a crashed attempt; create container `pa-sbx-<user>` (stopped).
5. Write `platform.json` into the volume (user id, token, Bridge secret, LiteLLM key, timezone, MCP servers, runtime).
6. Insert the row with **only the sha256 hashes** of the secrets. State = STOPPED.
7. Return `mcp_token_hash` to the backend.

## E.6 Open — WakeSandbox (every turn)

1. **Lock** the user (one operation per user at a time).
2. Update the stored **priority** if the plan changed (Free 1, Pro 2, Max 3).
3. If the row says AWAKE/BUSY and Docker confirms it's running → **done** (fast path). If Docker says it's not running (crash) → mark STOPPED and continue.
4. **Capacity guard** (under a global lock):
   - Count WAKING + AWAKE + BUSY containers of other users.
   - Below `AWAKE_CAP` → reserve a slot (state = WAKING).
   - At the cap → pick a **victim**: AWAKE (not busy), nothing in flight, no Claude sign-in pending; lowest priority first, then longest idle. Reserve our slot, then politely stop the victim.
   - No victim → `RESOURCE_EXHAUSTED`; the backend retries the job later.
5. **Ensure the container:** if the image version changed (rollout) or the container is missing → re-create it from the current image, keeping `/data`, and check the secrets file is still valid.
6. **Start:** `docker start` (one retry). Open an **awake period**. Read the container's IP on the sandbox network.
7. **Wait for health:** poll the Bridge `GET /healthz` (5 s per try) for up to **90 s**.
8. If start or health fails → stop it, close the awake period, **re-create from the image and try once more**. Still failing → state BROKEN + alert, `UNAVAILABLE` to the backend.
9. Note Claude sign-in status from the health answer.
10. **Egress:** write the user's Squid file (`src` = container IP, `dst` = their own MCP domains, plus Anthropic's hosts when Claude Code is on) and SIGHUP the proxy.
11. State **AWAKE**, last-active = now.

Typical time: container start + agent boot ≈ a few seconds (to be measured).

## E.7 Run a turn — Deliver

1. Validate (delivery id, kind, metadata JSON).
2. Wake (as above) and count this delivery **in flight** (the reaper and eviction skip in-flight containers).
3. Touch last-active.
4. `POST /deliver` to the Bridge with the Bridge secret. The turn runs on its **own timer**, independent of the gRPC caller — if the backend disconnects, the turn is still tracked to the end.
5. Relay each NDJSON line as a gRPC event:
   - `accepted` → state BUSY
   - `working` → passed through
   - `turn_done` → state AWAKE, last-active = now, stream ends
   - `error` → same, with `platform_fault` from the Bridge
6. **Timeout** (15 min default, or `timeout_seconds`): force-stop the container and send `ERROR` with `platform_fault = true` (the backend reverses the charge and tells the user).
7. Lost connection / stream ended early → `ERROR` with `platform_fault = true`; the backend job retries and the Bridge dedupes by `delivery_id`.

## E.8 Close — stopping

**When it happens**
| Trigger | Kind |
|---|---|
| Idle reaper (every 1 min): AWAKE, idle ≥ 3 min, nothing in flight, no Claude sign-in pending, and the Bridge confirms no running turn | Polite |
| Capacity guard needs a slot | Polite |
| Turn longer than 15 min | **Force** |
| Health checker gives up | Stop + BROKEN |
| `StopSandbox` RPC | Polite (refused while BUSY) or force |

**Polite stop, step by step**
1. `POST /shutdown` to the Bridge (the agent saves memory/sessions to `/data`), waiting up to **20 s**.
2. `docker stop` with a 10 s grace (force stop: 0 s = kill).
3. Remove the user's egress file (a stopped container's IP could be reused by someone else).
4. Close the **awake period** (billing gets the exact awake seconds).
5. State STOPPED. RAM is freed; the container and `/data` stay, so the next wake has full memory.

## E.9 Keeping it healthy

- **Health checker (every 30 s):** for AWAKE containers, `GET /healthz`. 2 failures in a row → restart. More than 3 restarts without one good check → stop, BROKEN, `alert=true` log.
- **Reconciler (at startup and every 5 min):** makes Docker's real state match the table:
  - row says running, container isn't → mark STOPPED, close the awake period
  - container runs, row says stopped/broken → stop it politely
  - WAKING/BUSY left over from a vm-manager restart → settle to AWAKE or STOPPED
  - awake containers → awake period open, egress file current (IPs can change)
  - managed containers with no row, or duplicates → removed (**volumes are never deleted here**)
  - egress files of users that aren't awake → removed
- **Image rollout:** set a new `AGENT_IMAGE_VERSION`; each stopped container is re-created from the new image on its next wake, keeping `/data` and its secrets.

## E.10 Delete (account deletion only)

Stop and remove the container, remove the volume (all user data), remove the egress file, close any awake period, delete the row. Awake periods stay for billing history. Idle stops **never** delete anything.

## E.11 Concurrency (why it doesn't trip over itself)

- **Per-user mutex:** create/wake/stop/delete of one user never overlap.
- **Capacity lock:** only one wake at a time decides who gets a slot, so the cap can't be overshot.
- **In-flight counter:** deliveries in progress protect a container from the reaper and eviction.
- **Backend side:** the per-user Redis lock means one turn per user at a time anyway.

## E.12 A day in one user's container (example)

| Time | What happens | State |
|---|---|---|
| 09:00:00 | "What's on my calendar?" → WakeSandbox | STOPPED → WAKING |
| 09:00:0x | Container starts, Bridge healthy, egress file written | AWAKE |
| 09:00:0x | Deliver → accepted | BUSY |
| 09:00:2x | Agent calls Google Calendar via Composio, replies with `send_message` → `turn_done` | AWAKE |
| 09:01 | Another message → already awake → fast path | BUSY → AWAKE |
| 09:04+ | Reaper: idle ≥ 3 min → `/shutdown`, stop, egress removed, awake period closed | STOPPED |
| 09:05 | `sync-usage` charges ≈ 5 minutes awake + the AI cost | — |

## E.13 Settings (vm-manager env)

| Variable | Default | Meaning |
|---|---|---|
| `AWAKE_CAP` | 20 (compose sets 15) | Max awake containers on the server |
| `IDLE_TIMEOUT` / `REAPER_INTERVAL` | 3m / 1m | Idle stop rule |
| `WAKE_TIMEOUT` | 90s | Max wait for the Bridge to be healthy |
| `SHUTDOWN_GRACE` | 20s | Polite shutdown time |
| `DELIVER_TIMEOUT` | 15m | Stuck-turn limit |
| `HEALTH_INTERVAL` / `HEALTH_FAILURES_BEFORE_RESTART` / `HEALTH_MAX_RESTARTS` | 30s / 2 / 3 | Health checker |
| `RECONCILE_INTERVAL` | 5m | Reconciler |
| `SANDBOX_MEMORY_MB` / `SANDBOX_CPUS` / `SANDBOX_PIDS_LIMIT` | 600 / 1 / 256 | Limits |
| `AGENT_IMAGE` / `AGENT_IMAGE_VERSION` | `personal-agent/agent:dev` / `dev` | Image + rollout trigger |
| `CLAUDE_EGRESS_DOMAINS` | api.anthropic.com, claude.ai, claude.com, platform.claude.com | Hosts opened for Claude Code |

---

# Part F — What is left to test

Nothing below has run yet because Docker isn't on the dev machine. Plan: one AWS `m7i-flex.large` (8 GB) for about a week (~$18 of credits running 24/7).

| # | Test | How | Pass when |
|---|---|---|---|
| 1 | Stack starts | `docker compose -f infra/docker-compose.yml --profile app up -d` + `pnpm db:migrate` | All services healthy |
| 2 | Egress isolation | `docker compose … --profile egress-test run --rm egress-test` | Direct internet blocked, LiteLLM via proxy OK, other domains 403 |
| 3 | Container lifecycle | `cd vm-manager && go test -tags=integration -v ./internal/integration/` | Create → wake → deliver "hello" → `turn_done`; idle stop; wake with memory; cap respected |
| 4 | Hermes in the real image | Build `agent-image`, send a message | Config keys right, reply arrives |
| 5 | RAM per container | `docker stats --no-stream pa-sbx-<user>` | Number written in `vm-manager/README.md`; set `AWAKE_CAP` |
| 6 | Real channels | Telegram bot (then WhatsApp test number) | Link, chat, buttons, voice |
| 7 | Apps + approvals | Composio free tier, Gmail | Asks before sending, sends after ✅ |
| 8 | Billing | Dodo test mode, LiteLLM + OpenRouter key | Credits go down correctly; purchase adds once; waitlist discount applied |
| 9 | Claude plan | A real Pro/Max account through Squid | Sign-in screen parsed, turns work, errors clear, 4 hosts enough |
| 10 | Automations | A 2-minute reminder, restart the worker | Fires once, on time |
| 11 | Backup + restore | `scripts/restore-test.sh` | Restore works |
| 12 | Load at the cap | `pnpm tsx scripts/load-test.ts` | Awake count never exceeds the cap |

**Open decisions and known gaps**
- Confirm with Anthropic: Commercial Terms, our UI offering only the Claude-plan sign-in, relaying the pasted code, telemetry off.
- Own API keys are saved and exempt from AI charges, but calls still go through our LiteLLM key (routing through the user's key isn't wired).
- `AI_ACCESS_MODE` defaults to `platform`; set `own_only` for "bring your own AI only".
- Create the Dodo discount code for the waitlist offer (`DODO_WAITLIST_DISCOUNT_CODE`).
- WhatsApp templates must be approved (one body variable; approval buttons in Approve, Reject order).
- `composio_triggers` table exists but isn't used.

---

# Glossary

| Word | Meaning |
|---|---|
| **Sandbox** | One user's container + volume + row in the vm-manager |
| **Bridge** | Our Python program inside the container that the vm-manager talks to; runs the agent |
| **Hermes** | Nous Research's open-source agent (default runtime) |
| **Claude Code** | Anthropic's official agent CLI (runtime when the user connects their Claude plan) |
| **Platform MCP** | Our tool server at `/mcp` the agent calls (send message, run app action…) |
| **Turn** | One delivered message and the agent's work on it, until `turn_done` |
| **Awake period** | One start→stop span of a container; billing charges awake time from these |
| **Egress / Squid** | The proxy that is the only way out of containers, with a per-user allowlist |
| **Event** | A saved incoming webhook/message (`events` table), unique per provider id |
| **Job** | A BullMQ task in Redis; its id is the event id |
| **Grant / ledger** | Credits come in grants with an expiry; every change is a ledger row |
| **gRPC** | Typed remote calls over HTTP/2 between the backend and the vm-manager, defined in `vm.proto` |
