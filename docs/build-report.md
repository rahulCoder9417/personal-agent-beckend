# Build report: design vs what we built

**Date:** 2026-09-28 · **Branch:** `mvp-build` in both repos (`beckend`, `vm-manager`) · **Design:** `docs/mvp-hld.md`

## In short

- All 8 build phases from HLD section 9 are **coded, committed and unit/integration tested** (backend 175 tests, vm-manager Go + Python suites).
- **Nothing has run for real yet.** Docker isn't installed on the dev machine, so no container, no real Hermes, no real Telegram/WhatsApp/Composio/LiteLLM/Dodo call. All of those were replaced by fakes in tests.
- The MVP is **code-complete, not end-to-end verified**. Section 6 lists what must be run on a Docker machine.

Status words used below:

| Word | Meaning |
|---|---|
| ✅ Built + tested | Code exists and automated tests cover it (with fakes for outside services) |
| ⚠️ Built, not run for real | Code exists, but it needs Docker or a real service to prove it works |
| 🔁 Changed | Built differently from the HLD, on purpose (reason given) |
| ❌ Not built | Not done |

---

## 1. Initial design vs what we built

### 1.1 Architecture

| Design (HLD) | What we built | Status |
|---|---|---|
| Modular monolith: one TypeScript codebase, two processes (`api`, `worker`) | `src/api/main.ts` (Hono) and `src/worker/main.ts` (BullMQ), sharing `src/modules/*` | ✅ |
| 9 modules, each owns its tables | `auth, channels, events, orchestrator, platform-mcp, integrations, billing, automations, admin`. Modules talk through exported functions; `src/wiring.ts` connects them with hooks | ✅ |
| Separate Go `vm-manager`, the only thing touching Docker | `vm-manager/` repo, gRPC on :9090 | ✅ code / ⚠️ Docker parts |
| Contracts first: OpenAPI, gRPC proto, MCP tool list | `openapi/openapi.yaml` drives routes, auth and validation; `vm.proto` written first; MCP tools defined once in `platform-mcp` | ✅ |
| 3 Docker networks: edge, platform, sandbox | `infra/docker-compose.yml` | ⚠️ (🔁 see 5.1) |

### 1.2 Backend (api + worker)

| Area | Design (HLD) | What we built | Status |
|---|---|---|---|
| Auth | Clerk token on every `/v1` call; `user.created` / `user.deleted` webhooks | Clerk JWT check; svix-verified webhook → event → job; user also created on first sign-in if the webhook is late | ✅ |
| Linking chats | One-time code, 10 min, single use, hashed | `LINK-XXXX-XXXX` codes, sha256 stored, rate limited; unknown senders only get "please link" | ✅ |
| Webhooks | Verify → save event (unique key) → job → 200 | Same for Clerk, Telegram, WhatsApp, Sendblue, Composio, Dodo | ✅ |
| Queues | 4 queues, retries 5 s / 30 s / 2 min…, 5 tries, per-user lock, Bull Board | Exactly that; lock pushes a busy user's job back 2 s; Bull Board at `/admin/queues` (admin only) | ✅ |
| Redis lost | Re-add jobs for events not done; re-register automations | Both run on worker start | ✅ |
| Telegram | Webhook + send, inline buttons | Done, incl. blocked-bot handling and long-text split | ✅ / ⚠️ real bot |
| WhatsApp | 24 h rule, templates, 3 buttons, status updates, media | Done; outside 24 h uses templates; receipts only move status forward | ✅ / ⚠️ real Meta |
| iMessage (Sendblue) | "If budget allows", yes/no instead of buttons | Done | ✅ / ⚠️ real Sendblue |
| Media + voice | Download media, voice → text | Download per channel, speech-to-text through LiteLLM | ✅ / ⚠️ real STT |
| Jev routing | Simple → cheap model, task → container, spam; fallback if down | Uses the real Jev SDK; unsure or error → task | ✅ / ⚠️ real Jev |
| Turn flow | Lock → credit check → Jev → wake → deliver → turn done | `orchestrator/turn.ts` | ✅ |
| Platform MCP | 9 tools, user id forced from container token, audit + Touch on every call | All 9 tools; token → sha256 → user; every call audit-logged + Touch | ✅ |
| Composio | Connect links, run actions with the caller's id, triggers | Uses the Composio SDK; 25-app catalog (10 on Free) | ✅ / ⚠️ real Composio |
| Approvals | Never block; ✅/❌ comes back as a new message | Buttons, yes/no text, web decision; single use; must match the exact action + arguments | ✅ |
| User MCP servers | Max plan; domain on the egress allowlist; secret encrypted | https + public hosts only; pushed to the vm-manager | ✅ |
| Credits | Grants + append-only ledger, spending order, idempotent charges | As designed; the database also blocks UPDATE on the ledger | ✅ |
| Charging | sync-usage every 5 min + after each turn; failed turns caused by us not charged | As designed; reversal reads LiteLLM spend for the turn window | ✅ / ⚠️ real LiteLLM |
| Enforcement | Before turn, LiteLLM budget during turn, 0 → pause automations | All three wired | ✅ |
| Dodo | Checkout, subscribe / renew / cancel / top-up / refund / chargeback, exactly once | Done | ✅ / ⚠️ real Dodo |
| Coupons | Every rule in 7.7 | Done, incl. 50-parallel-redemption test on real Postgres | ✅ (🔁 code length, see 5.2) |
| BYOK | Encrypted, tested before saving | Done | ✅ (🔁 see 5.2) |
| Automations | Once / repeat (cron + timezone) / app event; 15-min minimum; plan limits; auto-pause | Done; survive worker restart + Redis wipe (tested) | ✅ |
| Web app API | Every endpoint in `openapi.yaml` + SSE | All operations implemented (a test checks this); SSE via Redis pub/sub | ✅ |
| Hardening | Backups + restore test, rate limits, logs, metrics, alerts, admin views, load test | Backup job, health check, `/metrics`, JSON logs, per-IP limit, alerts; restore + load test as scripts | ✅ job logic / ⚠️ scripts never run |

### 1.3 vm-manager (Go) + agent image

| Area | Design (HLD) | What we built | Status |
|---|---|---|---|
| gRPC | 11 RPCs, shared secret, platform network only | All 11; `x-internal-secret` on unary + streaming calls | ✅ |
| `sandboxes` table | Owned only by the vm-manager | `sandboxes` + `awake_periods` (pgx, own database) | ✅ |
| Container spec | gVisor, ~600 MB, 1 CPU, pids + disk limits, read-only, sandbox network, own secrets only | All except the disk quota (needs a volume driver) | ⚠️ (🔁 5.3) |
| Secrets | Token + Bridge secret made at creation, only hashes stored | Hashes in DB; plaintext only in the user's `/data/.platform/platform.json` | ✅ |
| Loops | Idle reaper, capacity guard, health checker, reconciler, image rollout | All five, with fake-clock tests | ✅ / ⚠️ real Docker |
| Stop rule | Not in a turn **and** quiet 3 min; polite stop ~20 s | As designed; polite stop during a turn is refused | ✅ |
| Stuck turn | 15 min → force stop, user told | Force stop + error event with `platform_fault` (so it isn't charged) | ✅ |
| Awake periods | Recorded for credits | Opened on wake, closed on every stop; `GetUsage` sums them | ✅ |
| Egress allowlist | Written per user | One Squid file per **awake** user, proxy reloaded with SIGHUP | ✅ / ⚠️ real Squid |
| Agent image | Hermes + Bridge (HTTP, secret-checked, reports turn done) | Dockerfile (Hermes pinned) + stdlib Python Bridge + 27 tests | ✅ Bridge / ⚠️ Hermes never run |
| Measured RAM in README | Required | Not measured (no Docker) | ❌ |

---

## 2. How a message flows (as built)

```
Telegram / WhatsApp / iMessage / web
  → api webhook: verify signature → save `events` row (unique) → BullMQ job (id = event id) → 200
  → worker `inbound/process-message`, holding the user's Redis lock:
      not linked?          → "please link" reply, stop
      link code?           → link the chat, reply ✅
      ✅/❌ or yes/no?      → decide the approval, queue `process-approval`
      coupon code?         → redeem it, reply, stop
      media?               → download, voice → text
      save message → credit check (0 → "out of credits", stop)
      Jev: spam → drop · simple → cheap-model reply · task ↓
      ensure sandbox → WakeSandbox → Deliver (stream: accepted → working → turn_done | error)
  → inside the container: Bridge → Hermes → tools on /mcp (token → user id) → send_message
  → `outbound/send-message` → channel adapter (24 h rule, buttons, split) → user
  → after the turn: sync usage (charge), push `credits.updated` over SSE
```

---

## 3. Backend in detail

### 3.1 Modules

| Module | What it does | Main files |
|---|---|---|
| **auth** | Clerk sessions, users, link codes, channel links | `session.ts`, `users.ts`, `provision.ts`, `links.ts`, `jobs.ts` |
| **events** | `events` table, webhook intake, 4 queues, recovery, cleanup | `intake.ts`, `queues.ts`, `cleanup.ts` |
| **channels** | Adapters (Telegram, WhatsApp, Sendblue, web), messages, outbound queue, SSE, media, attachments | `adapters/*`, `outbound.ts`, `messages.ts`, `stream.ts`, `media.ts`, `files.ts` |
| **orchestrator** | Per-user lock, turn flow, Jev routing, sandbox tokens, approvals, onboarding/deletion, gRPC client | `turn.ts`, `process-message.ts`, `routing.ts`, `sandbox.ts`, `approvals.ts`, `lifecycle.ts`, `vm.ts`, `lock.ts` |
| **platform-mcp** | The `/mcp` server the agents call | `server.ts`, `registry.ts`, `tools/*` |
| **integrations** | Composio (catalog, connections, actions, triggers), user MCP servers, BYOK | `catalog.ts`, `composio.ts`, `apps.ts`, `mcp-servers.ts`, `byok.ts` |
| **billing** | Plans, grants, ledger, charging, LiteLLM keys, Dodo, coupons | `credits.ts`, `usage.ts`, `litellm.ts`, `dodo.ts`, `coupons.ts`, `plans.ts`, `jobs.ts` |
| **automations** | Automations table, timers, triggers, auto-pause | `automations.ts`, `jobs.ts` |
| **admin** | Audit log, alerts, metrics, health check, backups | `audit.ts`, `alerts.ts`, `metrics.ts`, `health.ts`, `backup.ts` |

The spec-driven router (`src/api/router.ts`) declares each route by `operationId`. Method, path, auth (`security`), admin role (tag `admin`) and request validation all come from `openapi.yaml`, so the api can't drift from the contract.

### 3.2 Database (23 tables, 5 migrations)

| Migration | Tables |
|---|---|
| `0000_phase1_core` | users, link_codes, channel_links, events, messages, audit_log |
| `0001_phase3_chat` | attachments, sandbox_tokens |
| `0002_phase4_apps_approvals` | approvals, connections, user_mcp_servers, composio_triggers |
| `0003_phase7_automations` | automations |
| `0004_phase5_billing` | subscriptions, credit_grants, credit_ledger (append-only trigger), usage_periods, coupons, coupon_codes, coupon_redemptions, payments, litellm_keys, byok_keys |

(Migrations are numbered in merge order, which is why billing is `0004`.)

### 3.3 Jobs

| Queue | Jobs |
|---|---|
| inbound | process-message, web-message, process-approval, automation-turn, composio-trigger |
| outbound | send-message, send-raw (link replies to unlinked chats), message-status |
| scheduled | run-automation (delayed jobs + job schedulers per automation) |
| system | clerk-event, onboard-user, delete-user, sync-allowlist, composio-event, dodo-event, sync-usage (5 min), expire-credits (hourly), expire-approvals (hourly), cleanup (daily), backup (nightly), health-check (5 min) |

### 3.4 Platform MCP tools

`send_message`, `get_profile`, `list_app_actions`, `run_app_action`, `request_approval`, `schedule_reminder`, `create_automation`, `list_automations`, `cancel_automation`. The user id always comes from the container token. Risky app actions (send, delete, pay, share…) need an approved, unused approval for the exact same action and arguments.

### 3.5 Security (HLD 10.2)

See `docs/security-checklist.md` for each item and its status. In short: secrets are AES-256-GCM encrypted, tokens and codes are stored as sha256, no secrets are logged, every user query filters by user id, and there are per-user, per-chat and per-IP rate limits.

### 3.6 Tests

- 22 test files, 175 tests, one per phase's "done when" checks plus cross-module tests.
- They use a **real Postgres** (embedded binaries) and a **real Redis**, one database and queue prefix per test file.
- Outside services are fakes: `setVmClient`, `setTelegramApi`, `setWhatsappApi`, `setSendblueApi`, `setComposioApi`, `setLiteLLMClient`, `setDodoClient`, `setJevClient`, `setTranscriber`, `setCommandRunner`.
- Every response is checked against `openapi.yaml`, and a test fails if any spec operation isn't implemented.

---

## 4. vm-manager in detail

Full reference: `vm-manager/README.md` and `vm-manager/docs/build-report.md`.

- **States:** `stopped → waking → awake ⇄ busy`, plus `broken`.
- **Create:** volume `pa-data-<user>` + container `pa-sbx-<user>` + secrets file. Idempotent.
- **Wake:** capacity guard → re-create if the image changed → start → wait for the Bridge's `/healthz` → write the egress file → open an awake period.
- **Deliver:** `POST /deliver` to the Bridge, relay NDJSON events as the gRPC stream. The Bridge dedupes by `delivery_id` (saved in `/data`).
- **Stop:** polite `POST /shutdown` (Hermes saves, up to 20 s) then stop; removes the egress file and closes the awake period.
- **Bridge:** renders the Hermes config at each boot, runs `hermes gateway run` on localhost only, one Hermes session per chat, and sends the final answer itself through the Platform MCP `send_message`.

---

## 5. Where we changed or filled in the design

### 5.1 Infra
- **The platform network allows outbound internet.** The HLD says "no internet", but the worker must call Telegram, Composio, Dodo, etc. and LiteLLM must reach the model providers. Nothing on it is reachable from outside; only the `sandbox` network is fully internal.
- **Container file links** use `INTERNAL_API_URL` (`http://api:8080/mcp/files/…`), because the egress proxy only lets containers reach `/mcp`.

### 5.2 Backend
- **OpenAPI:** added the `400` response to list/body endpoints that validate input but didn't document it.
- **Coupon codes are `AGT-XXXX-XXXX-XXXX-XXXX`** (16 random characters). The HLD's `AGT-XXXX-XXXX-XXXX` only holds 12, but it also asks for 16+.
- **Coupon campaigns and codes are two tables** (`coupons`, `coupon_codes`), so one campaign can have many single-use codes.
- **A `payments` table was added** (not in HLD 8), so refunds and chargebacks can be traced to what they bought.
- **Overruns** (small negative balance) sit on one hidden grant per user and are paid by the next grant.
- **BYOK:** if a user has any own key, none of their AI is charged (we can't tell which calls used it). Routing their calls through their own key in LiteLLM is **not wired yet**.
- **Chargebacks** take back purchased credits and flag the user; the plan isn't changed.
- **Monthly grants on renewal** happen inside `dodo-event`; there is no separate `grant-monthly-credits` job.
- **Approvals** are single use, expire after 24 h, and must match the exact action and arguments the user saw.
- **Risky actions** are detected by name (SEND, DELETE, PAY, SHARE…) in `integrations/catalog.ts`.
- **Clerk `user.updated`** is also handled (email verification changes), not only created/deleted.
- **Containers ask LiteLLM for model `agent-default`**; each user's key maps it to `cheap` (Free) or `claude` (Pro/Max).
- **Max plan priority** is a BullMQ job priority on the inbound queue.
- **WhatsApp error 131047** means the 24 h window closed (not a block), so it resends as a template.

### 5.3 vm-manager
- **Secrets live in a file on `/data`**, not in env, so a container re-created for a new image keeps the same token.
- **The egress file is removed on every stop**, not only on delete (a stopped container's IP can go to another user).
- **SetEgressAllowlist replaces both lists**; the backend sends the MCP domains itself.
- **No disk quota on `/data`** with Docker's default volume driver; set `SANDBOX_VOLUME_DRIVER/OPTS` on the server.
- **`browser_seconds` is always 0** (nothing records browser time yet).
- **Hermes's own approval prompts are denied**; risky actions go through the platform's `request_approval`.

---

## 6. Not verified yet, and how to verify

| # | What | How |
|---|---|---|
| 1 | The whole stack starts | `docker compose -f infra/docker-compose.yml up -d` on a machine with Docker + gVisor |
| 2 | Containers reach only the egress proxy | `docker compose -f infra/docker-compose.yml --profile egress-test run --rm egress-test` |
| 3 | Create → wake → deliver → idle stop → wake with memory | `cd vm-manager && go test -tags=integration ./internal/integration/` |
| 4 | Hermes really works inside the read-only container | Build `agent-image`, send a real message |
| 5 | RAM per container → awake cap | `docker stats --no-stream pa-sbx-<user>`; write it in `vm-manager/README.md` |
| 6 | Real outside services | Test accounts for Telegram, Meta, Sendblue, Composio, LiteLLM + OpenRouter, Dodo test mode, Jev, Clerk |
| 7 | Backups restore | `scripts/restore-test.sh` on the server |
| 8 | Load at the awake cap | `scripts/load-test.ts` |

Known risk areas when this first runs for real: the Hermes config keys and run API, `docker cp` into a read-only container's volume, Dodo payload field names, and LiteLLM's key `aliases` and `/spend/logs` filter.

---

## 7. How the work was done

- One phase at a time, commit after each working step, lint + types + tests green before each commit.
- Parallel agents on their own branches/worktrees: **vm-manager** (Phase 2), **billing** (Phase 5), **channels** (Phase 6). Phases 0, 1, 3, 4, 7, 8, merging and wiring were done on `mvp-build`.
- Merges: `phase6-channels` and `phase5-billing` into `mvp-build`, conflicts resolved, then everything connected in `src/wiring.ts`.
- One bug found while writing this report: the nightly backup and the 5-minute health check were never scheduled (an edit got lost). Fixed in `f17e141`, with a test.
