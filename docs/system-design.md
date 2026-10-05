# Personal Agent — System Design

What was planned, what was built and how, the tech used and where, how gRPC and every other connection works, how the vm-manager opens and closes containers, and what is left to test.

- **Diagrams:** GoDraw canvas **"Personal Agent — System Design (planned vs built)"** — page 1 original design · page 2 system now · page 3 one message end to end · page 4 container open/close.
- **Reference (every table, endpoint, env var):** `docs/build-report.md`. **Original design:** `docs/mvp-hld.md`.
- **Code:** `beckend/` (api + worker, TypeScript) and `vm-manager/` (Go + the agent image), branch `main`.
- **Date:** 2026-09-30. **Updated:** 2026-10-03 with the launch basics (`docs/launch-plan.md`, package W1a), and 2026-10-04 with the crew package (W2b-1: the crew, pull-request review, Scout's web tools): Parts B, C, D, F and G. Then the search and browser decisions of 2026-10-04 (web search is Scout's, Max only and 1 credit; the browser will allow logins): Parts B and F. Then Scout's browser, first version, platform side (the browser is inside the user's container; the switch by plan; `read_page` by engine; the dev script's `send`): Parts B, D, E, F and G.

## Contents

- **Part A — The original design** (what was planned first)
- **Part B — What is built now, and how**
- **Part C — Tech stack: what each tool does and where**
- **Part D — How the parts talk (REST, webhooks, jobs, gRPC, Bridge, MCP)**
- **Part E — How the vm-manager opens and closes containers**
- **Part F — What is left to test**
- **Part G — Folder structure: what every file does, and how a request moves through them**
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
| 5 | Credits, plans, coupons, Polar payments, LiteLLM keys, BYOK |
| 6 | WhatsApp, media + voice, Jev routing |
| 7 | Automations and reminders |
| 8 | Backups, rate limits, logs/metrics/alerts, admin views, iMessage, load test |

## A.6 The original pricing

Free $0 (100 sign-up credits, 3 automations, cheap model) · Pro $12 (1,500 credits/month, 20 automations) · Max $29 (4,500/month, 50 automations, own MCP servers). Monthly credits expired at renewal, top-ups after 12 months, coupons after 30 days.

---

# Part B — What is built now, and how

## B.1 Summary

All 8 phases are built, plus the later changes in B.2. Everything is tested with real Postgres and Redis and fakes for outside services. A test deployment ran on AWS on 2026-09-30 and 2026-10-01 (`docs/aws-setup.md`); the crew ran there again on 2026-10-04, which is where the `read_page` finding of B.2 comes from. **The browser switch, browser charging and the new `read_page` rule have not run on it** (see Part F).

| Area | Built | Status |
|---|---|---|
| Backend (api + worker) | 9 modules, 29 tables, 63 REST operations, 23 job types, 14 agent tools | ✅ 436 tests in 39 files |
| vm-manager | 16 gRPC calls (`SetBrowser` added 2026-10-04), 5 background loops | ✅ Go tests, `-race` clean (as reported by its own package; not re-run for this doc) |
| Agent image | Hermes + Claude Code + our Python Bridge, with the crew (Byte, Patch, Scout) defined in the Bridge | ✅ 87 Bridge tests (fakes), as reported by the agent-image package on 2026-10-04; not re-run for this doc |
| Infra | docker-compose (3 networks), Caddy, Squid, LiteLLM config | ⚠️ ran on the AWS test server; the Caddy rule of 2026-10-03 is untested live |

## B.2 What changed from the original design

| Change | Planned | Now | Why |
|---|---|---|---|
| **Second agent runtime** | Hermes only | Hermes **or Claude Code** | Users can bring their own Claude plan (Anthropic allows the unmodified Claude Code in hosted sandboxes) |
| **AI source rule** | Platform credits | Claude plan → Claude Code · own API key → Hermes · else credits (or "connect your AI" with `AI_ACCESS_MODE=own_only`) | MVP is "bring your own AI" |
| **Pricing** | Max $29, 3/20/50 automations, mixed expiry | Max **$30**, **1/5/50**, **every credit 90 days**, monthly credits carry over | Matches the landing page |
| **Waitlist** | — | Public join API with IP/abuse data + 50% off first month | Launch marketing |
| **Platform network** | "no internet" | Outbound allowed, nothing exposed | The worker must call Telegram, Composio… |
| **Spec** | — | 400/503 responses documented where the code returns them | Contract accuracy |
| **Payments provider** | Hosted checkout + signed webhooks | **Polar** (merchant of record), same flow; webhook `/webhooks/polar` | The user's decision (2026-09-30) |
| **Launch channels** (2026-10-03) | WhatsApp, Telegram, iMessage, web | **Telegram and web on; WhatsApp and iMessage switched off** by `ENABLED_CHANNELS` (the code stays) | WhatsApp's terms forbid a general AI assistant outside the EEA; the unofficial iMessage route can be cut off |
| **AI, three ways** (2026-10-03) | Platform credits | Own API key (default, recommended) · Claude plan (beta, "runs Claude Code") · **Textcrew AI** (a rented model behind LiteLLM, on credits) | Launch plan D4 |
| **App-action charge** (2026-10-03) | App actions free | **1 credit per successful app action that changes something**; reading and searching are free | Launch plan D6 |
| **Connection check** (2026-10-03) | Webhook or app list finishes a connection | Also a `check-connection` job that asks Composio itself | Connections stayed "pending" on the test server |
| **No purchase links on Telegram** (2026-10-03) | "Out of credits" linked to billing everywhere | On Telegram it names the web app, with no link; the Telegram sender removes purchase links from any text | Telegram requires Stars for sales inside the app |
| **`/mcp` and `/git` closed** (2026-10-03) | Reachable through Caddy (token needed) | Caddy answers 404 for both | Only containers need them, and they don't go through Caddy |
| **Browser use** (2026-10-03, decided 2026-10-04) | Later | **Scout's browser runs inside the user's own container,** on the Max plan, at 2 credits per minute. The agent image and the vm-manager provide it; the platform switches it on for Max users and off for everyone else, charges the browser seconds and tells the apps. An earlier proposal (a hosted browser at a provider, driven by six platform tools) is cancelled. **Signing in to sites is the next step** and is not built (`mvp-hld.md` section 11) | The founder's decision: no supplier, and no third party sees the pages |
| **The container's network** (2026-10-04) | Locked for every container | **Locked, except a container with the browser on,** which can reach any public website. Internal addresses stay refused. `mvp-hld.md` section 10.3 says what that leaves open | A browser must reach any site |
| **The crew** (2026-10-04) | One agent | **Tex leads; Byte, Patch and Scout are specialists** defined in the agent image. The platform has the crew list (`GET /v1/crew`) and passes progress lines to web chat (`agent.progress`), never to Telegram | Launch plan D7 |
| **Pull-request review** (2026-10-04) | — | Turned on per GitHub repo: an event automation with a preset. One review per head commit. Turning it on is the standing permission for four named GitHub comment actions on that repo | Launch plan D8, the first use case |
| **Web research on the platform** (2026-10-04) | The container's own network | `web_search` (Max plan) and `read_page` (every plan) run in the api. `read_page` reaches public addresses only. On Hermes it opens only an address already seen for the user; **on Claude Code any public address** (decided 2026-10-04) | These two tools need no way out of the container. On the server, Scout searched with Claude Code's built-in search and `read_page` refused every result, since those addresses never pass through the platform. On Claude Code only Scout can call it, and Scout has no files, shell or app tools; Hermes can't narrow tools per agent, so it keeps the strict rule |
| **Paid tools** (2026-10-04) | In the usage sync | Charged when they run, at a configured cost × 2.5, as ledger rows; fractions of a credit carry over. Web search is the first, and its cost is set so that a search is exactly 1 credit | Exact balance checks, one line per call in the credit history |
| **Who searches the web** (2026-10-04) | Any agent, with the platform's tool | Only Scout. An engine with its own web search (Claude Code on the user's Claude plan; Codex later) uses that, free on every plan. Otherwise the platform's `web_search`: Max plan only, 1 credit per search | The founder's decision. The user's own plan already pays for its search; Brave costs us money per search |
| **GitHub comments need approval** (2026-10-04) | Ran without asking | A GitHub action that writes a comment or review needs approval, except where pull-request review is on | Other people read them |
| **Choosing Textcrew AI** (2026-10-04) | First match: Claude plan, own key, credits | A user with a key or a Claude plan can choose Textcrew AI (`aiPreference: platform`) and switch back | A gap the web app found |
| **Usage in five parts** (2026-10-04) | Browser time inside `toolCredits` | `browserCredits` is its own number; `toolCredits` is paid tools | So screens can label them |
| **Shared memory** (2026-10-04) | Each engine's own memory in `/data` | **One memory on the platform for every engine** (`remember`, `recall`, `forget`), put at the top of every delivered turn; a recap of the chat when the engine changes; the user sees and deletes it in the web app. The engines' own memory is left as it is | Launch plan D11: switching engines lost what the agent knew |

## B.3 Backend modules — what each does

| Module | Owns | Does |
|---|---|---|
| **auth** | users, link_codes, channel_links, waitlist | Clerk sign-in, account lifecycle, linking chat apps with one-time codes, waitlist |
| **events** | events | Webhook intake (event + job, deduplicated), the 4 queues, recovery after Redis loss, cleanup |
| **channels** | messages, attachments | Telegram/WhatsApp/Sendblue/web adapters, sending (24-hour rule, buttons, long-text split, no purchase links on Telegram, nothing to a switched-off channel), media + voice→text, SSE live updates |
| **orchestrator** | sandbox_tokens, approvals, agent_settings, memories, chat_engines | The turn flow (and which engine the turn in progress runs on), per-user lock, Jev routing, approvals, container tokens, which agent runs and which AI pays, Claude sign-in, the gRPC client, the crew list and progress lines, Scout's browser switch, shared memory (saving, finding, the secret check), the memory block and the recap put into each delivered turn |
| **platform-mcp** | — (seen web addresses live in Redis) | The `/mcp` server: 14 tools the agent calls (the memory tools among them), and which web addresses `read_page` may open |
| **integrations** | connections, user_mcp_servers, byok_keys, composio_triggers | Composio (catalog, connect + the connection check, actions and whether they change something, triggers), user MCP servers, own API keys, the git gateway, the web page reader, the web search provider |
| **billing** | subscriptions, payments, credit_grants, credit_ledger, usage_periods, coupons, coupon_codes, coupon_redemptions, litellm_keys | Plans, credits, charging (usage, app actions and paid tools), LiteLLM keys and budgets, Polar, coupons |
| **automations** | automations, pr_reviews | Reminders and automations, timers, triggers, auto-pause, pull-request review per repo |
| **admin** | audit_log | Audit log, alerts, metrics, health check, backups |

`src/wiring.ts` connects modules through small hooks (e.g. billing tells automations "balance hit zero"), so no module reaches into another's tables.

## B.4 How the main things work (short)

**Sign-up.** Clerk sends `user.created` (signed) → event + job → the worker creates the user, grants 100 credits (90 days), creates their LiteLLM key, then calls gRPC **CreateSandbox** (container created, left stopped) and stores the hash of the container's token.

**Linking a chat.** The web app gets a code like `LINK-7KQ2-M9XP` (stored as a hash, 10 minutes). The user sends it to our bot; the worker links that chat id to the user. Only a channel that is switched on can be linked.

**The channels switch.** `ENABLED_CHANNELS` (default `telegram,web`) says which channels are on. A channel that is off gets no link code (`403 channel_disabled`), its webhook answers 200 and saves nothing, and the worker neither reads from it nor sends to it. `GET /v1/channels` tells the web app which channels are on (`available`).

**A message** (canvas page 3). Webhook (if its channel is on) → event + job → worker takes the user's lock → special cases (link code, approval answer, coupon code, media) → credits and AI-source check → Jev routing (simple questions answered by a cheap model without waking anything) → **WakeSandbox** → **Deliver** (gRPC stream) → the agent calls our tools on `/mcp` → `send_message` → outbound job → the channel. After the turn: charge usage, push `credits.updated`, release the lock.

**Tools the agent has** (Platform MCP): `send_message`, `get_profile`, `list_app_actions`, `run_app_action`, `request_approval`, `schedule_reminder`, `create_automation`, `list_automations`, `cancel_automation`, `web_search`, `read_page`, `remember`, `recall`, `forget`. The user id always comes from the container's token.

**Approvals.** The agent calls `request_approval` → the user gets ✅/❌ buttons → the agent ends its turn. The answer comes back later as a new delivery; risky actions (send, delete, pay…) only run with an approved, single-use approval for the **exact** same action and arguments.

**App connections.** A connect link saves the connection as `pending`. It becomes `active` through Composio's webhook, the web app's app list, or the `check-connection` job, which asks Composio 15 s after the link is made and then after 30 s, 1, 2, 4 and 8 minutes, until the connection is no longer pending.

**Credits.** Grants (each with its own 90-day expiry) + an append-only ledger (a database trigger blocks edits). Spent oldest-expiry first. Every 5 minutes and after each turn, `sync-usage` reads AI spend (LiteLLM) and awake time (vm-manager **GetUsage**) and writes **one** charge per user per period with a unique key, so re-runs never double-charge. At zero: automations pause and the LiteLLM budget closes.

**App actions.** `run_app_action` charges **1 credit** when an action that changes something succeeds (send, create, update, delete), as its own ledger row with a unique key (the approval id, or an id for that run). Reading is free, a failed action costs nothing, and at zero credits a changing action is refused. The action's name decides which kind it is; a name that says nothing is charged unless Composio tags the tool `readOnlyHint`. Any grant may pay it. A turn reversed as our fault gives these credits back too. Users see it in the credit history, the activity log and usage.

**The crew.** Tex is the lead, the agent the user texts. Byte (coding), Patch (code review) and Scout (research) are specialists defined in the agent image. The platform knows two things about them. `GET /v1/crew` gives the apps the four members, whether each is available (`CREW_AVAILABLE`), and Scout's browser: the plan it needs (Max), whether this deployment has it (`BROWSER_AVAILABLE`) and whether it is on for this user. And when the Bridge reports progress during a turn (`Scout: reading 4 pages`), the worker sends it to the web app's live stream as `agent.progress`; lines that name a crew member are also saved to the activity log. Telegram gets nothing for a progress line. On Hermes a specialist's tool list is only an instruction (the pinned Hermes has no per-task tool list); on Claude Code it is enforced.

**Pull-request review.** The user turns it on for a GitHub repo (`PUT /v1/pr-reviews/{owner}/{repo}`). That saves an event automation with the preset `pr_review` and a Composio trigger on the repo's pull requests. When a pull request is opened or gets new commits, the worker asks GitHub for the current head commit, claims it in `pr_reviews` (unique per user, repo, number and commit, so a repeated event does nothing), and delivers an instruction that names the repo, the number and the commit and tells the lead to have Patch review it. Patch posts one review and the lead sends a short verdict to the user's chat. Turning review on is the standing permission for four named GitHub comment actions on that repo's pull requests, with `event: COMMENT` only. Merging, approving, replying and anything on another repo still need approval. The instruction carries no text from the pull request.

**Scout's web tools.** Only Scout searches the web. When the user's engine has its own web search (Claude Code on their Claude plan today), Scout uses that and the platform is not involved: no credits, any plan. Otherwise it uses `web_search`, which asks the search provider (Brave) from the api and returns titles, links and snippets. `web_search` is **part of the Max plan** and costs **1 credit per search**. On Free and Pro it answers with a tool error that says so and tells the agent to use its engine's own search if it has one; nothing is searched or charged, the turn goes on, and the activity log shows the refusal (`web_search_refused`). The agent image decides which search Scout is given; the platform doesn't check the engine. `read_page` is free on every plan. It fetches one public web page from the api and returns its text and links. It refuses private, loopback, link-local, metadata and internal addresses, by the URL and by what the host resolves to, at every redirect, and connects only to the address it checked. **Which addresses it opens depends on the engine.** On Hermes, only an address already seen for the user: one in their own messages, a search result, or a link on a page already read. So an injected instruction can't make an agent fetch a made-up address with the user's data in it. On Claude Code, any public address: there the agent image lets only Scout call it, and Scout holds no files, shell or app tools. The worker records the engine a turn really runs on while it lasts (`turn-engine:<user>` in Redis), and `read_page` reads that; with no turn on record the strict rule applies.

**Scout's browser.** It runs inside the user's own container (the agent image and the vm-manager provide it), on the Max plan, at 2 credits per minute. The platform's part is the switch: `browserWanted(plan)` is true when the plan includes the browser and `BROWSER_AVAILABLE` says the deployed image has it. That state goes to the vm-manager in **CreateSandbox**, through a `sync-browser` job that calls **SetBrowser** whenever a plan changes, and again after a wake if the sandbox's record differs. It takes effect on the container's next wake. A container with the browser on can reach any public website; every other container stays locked. Browser seconds come back in **GetUsage** and the usage sync charges 1 credit per 30 seconds, once. Signing in to sites is not built.

**Shared memory.** One memory per user on the platform (`memories`), the same whichever engine runs. The agent saves a short fact with `remember` (one line, at most 300 characters, 200 per user), finds facts with `recall` (Postgres text search, best match first) and removes or corrects one with `forget`. A save that looks like a secret (a key, a token, a password, a card number) is refused. Before every delivery the worker puts what is known about the user at the top of the turn's text: standing instructions first, then the most recently confirmed or used, within 2,000 characters and 30 memories. The block is marked as data, each memory is one line, and text inside a memory can't write the block's own lines. The user lists and deletes memories from the web app (`GET` and `DELETE /v1/memories`). The audit log never holds a memory's text. The engines' own memory in `/data` is left as it is.

**Switching engines.** An engine keeps one session per chat, so `chat_engines` records which engine last finished a turn in each chat. When a turn runs on another engine than the chat's previous one, its text also carries a recap: the stored messages that engine hasn't had, the newest 12 within 3,000 characters. The same engine gets no recap.

**Paid tools.** A paid tool is charged when it runs, at its configured cost × 2.5, as its own ledger row with a unique key; fractions of a credit carry over. **A web search is exactly 1 credit:** its configured cost (`WEB_SEARCH_COST_USD`) is $0.004, and × 2.5 that is one credit with nothing to carry. The setting is what the price is worked out from, not Brave's bill ($0.005 a search). Only normal grants pay, only success is charged, and at zero credits the tool is refused. Usage shows it as `toolCredits`, apart from `browserCredits`.

**No purchase links on Telegram.** The "out of credits" reply names the web app on Telegram and links to billing on other channels. The Telegram sender also replaces any purchase link (Polar, or a buying page of the web app) in any text it sends.

**Payments.** Polar checkout (our user id is Polar's external customer id; waitlist members get 50% off the first month automatically through a Polar discount). Plans and credits change only when Polar's signed webhook arrives: `subscription.active` or a paid `order.paid` grants the period's credits once, `subscription.canceled` keeps the plan to the end of the period and `subscription.revoked` moves the user to Free, a top-up `order.paid` adds 800 credits, and a succeeded refund takes back its share (all of it, plus a flag, when Polar refunded to prevent a chargeback).

**Automations.** Once (delayed job), repeating (BullMQ job scheduler with cron + timezone), or app event (Composio trigger → webhook). Postgres is the source of truth; timers are re-registered on every worker start.

**AI, three ways.** Own API key (the default, recommended), Claude plan (beta) or Textcrew AI (a rented model, on credits). Awake time, app actions and paid tools cost credits in all three. The web search built into the user's own Claude plan is part of their AI and costs no credits. The agent settings say whether Textcrew AI is on offer (`platformAvailable`).
| User has | Agent | Pays for AI |
|---|---|---|
| Connected Claude plan (chose Claude Code) | Claude Code | Their Claude plan |
| Own API key | Hermes | Their key |
| Nothing | Textcrew AI: Hermes on credits — or "connect your AI" with `own_only` | Platform credits / — |
| Anything, and chose Textcrew AI (`aiPreference: platform`, only while it is on offer) | Hermes | Platform credits; the key and the Claude connection are kept |

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
| **Polar** (plain HTTP, `Polar-Version: 2026-10`) + standardwebhooks | Payments (merchant of record) | Checkout, subscriptions, top-ups, refunds, webhooks |
| **LiteLLM** (HTTP) | AI gateway | Per-user virtual keys with budgets, spend tracking, model alias `agent-default`, speech-to-text |
| **Brave Search API** (plain HTTP) | Web search | Scout's `web_search`, behind a small provider interface (`integrations/web-search.ts`) |
| **Node `http`/`https`/`dns`/`net`** | Fetching web pages safely | Scout's `read_page`: address checks with `net.BlockList`, a connection pinned to the checked address (`integrations/web-page.ts`) |
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
| **Caddy** | HTTPS in front of the api (only public service). Answers 404 for `/mcp*` and `/git/*` |
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
| Telegram/WhatsApp/Sendblue/Clerk/Polar/Composio → api | HTTPS webhooks | Each provider's signature/secret, checked on the raw body |
| api → worker | BullMQ jobs in Redis | Same process group; job id = event id |
| worker / api → vm-manager | **gRPC** | Metadata `x-internal-secret`, platform network only |
| vm-manager → container | Docker API + HTTP to the Bridge | Per-container Bridge secret (`X-Bridge-Secret`) |
| Container → api | MCP (streamable HTTP) at `/mcp` and git smart HTTP at `/git`, through Squid straight to the api, never through Caddy (which answers 404 for both) | Per-container token (`Authorization: Bearer`) |
| Container → AI | Hermes → LiteLLM; Claude Code → Anthropic; through Squid | User's LiteLLM key / user's own Claude login |

## D.2 REST (web app ↔ api)

- 63 operations in `openapi.yaml` (profile, channels, chat + attachments + SSE, approvals, apps, MCP servers, own keys, automations, pull-request review, agent status + settings + Claude sign-in, the crew, memory, billing, credits, usage, coupons, activity, waitlist, admin, webhooks). List: `build-report.md` §8.1.
- Errors always `{ "error": { "code", "message", "details?" } }`.
- Added on 2026-10-03, with no new operation: `available` on `GET /v1/channels`, `403 channel_disabled` on link codes and web chat, `appActionCredits` in `GET /v1/usage`.
- Added on 2026-10-04: four operations (`GET /v1/crew`, `GET /v1/pr-reviews`, `PUT` and `DELETE /v1/pr-reviews/{owner}/{repo}`), and new fields: `aiPreference` and `platformAvailable` in the agent settings, `browserCredits` and `browserSeconds` in usage, `limits.browser` on plans, `preset` on automations, `crew` on activity entries.
- Added on 2026-10-04 with shared memory: three operations (`GET /v1/memories`, `DELETE /v1/memories`, `DELETE /v1/memories/{memoryId}`) and `memoryId` on activity entries.
- Added on 2026-10-04 with Scout's browser, with no new operation: `enabled` on Scout's `browser` in `GET /v1/crew` (`available` now follows `BROWSER_AVAILABLE`), and the activity actions `browser_enabled` and `browser_disabled`.
- Lists use `cursor` + `limit` → `nextCursor`.
- Live updates over `GET /v1/stream` (SSE): `message.created`, `message.status`, `approval.created`, `approval.resolved`, `agent.status`, `agent.progress`, `credits.updated`, `automation.updated`.

## D.3 Jobs (api → worker)

| Queue | Jobs |
|---|---|
| inbound | process-message, web-message, process-approval, automation-turn, composio-trigger |
| outbound | send-message, send-raw, message-status |
| scheduled | run-automation |
| system | clerk-event, onboard-user, delete-user, sync-allowlist, sync-browser (a plan changed: Scout's browser on or off), composio-event, check-connection (delayed, after a connect link), polar-event, sync-usage (5 min), expire-credits (hourly), expire-approvals (hourly), cleanup (daily), backup (nightly), health-check (5 min) |

Retries 5 s → 30 s → 2 min → 10 min (5 tries). Inbound jobs take the user's Redis lock (`lock:user:<id>`); a busy user's job is pushed back 2 s. Max-plan jobs get higher priority.

## D.4 gRPC (backend → vm-manager) in detail

**What gRPC is here:** a typed remote-function-call protocol over HTTP/2. The contract `vm-manager/proto/vm/v1/vm.proto` defines the service and messages. `buf` generates Go server code for the vm-manager and TypeScript client code (`proto-gen/`) for the backend, so both sides always agree on names and types.

**How the backend calls it:** `vm()` in `src/modules/orchestrator/vm.ts` creates a Connect-ES client with the gRPC transport, pointing at `VM_MANAGER_URL` (`http://vm-manager:9090`). An interceptor adds `x-internal-secret: <VM_INTERNAL_SECRET>` to every call. The vm-manager rejects calls without it (`UNAUTHENTICATED`). The port is only on the private platform network.

**Unary vs streaming:** most calls are request → response. **Deliver** is **server-streaming**: the backend sends one request and reads a stream of events until the turn ends.

**What `Deliver.text` holds** (2026-10-04): the memory block, then a recap of the chat if the engine changed, then the turn's own text. With no memories and no engine change it is the turn's text alone. The proto did not change: this is the `text` field it always had.

| RPC | Called by (backend) | What the vm-manager does | Returns |
|---|---|---|---|
| **CreateSandbox** | `onboard-user` job → `ensureSandbox`. Carries `browser_enabled`: true for a Max user while `BROWSER_AVAILABLE` is on | Creates volume + container (stopped), random MCP token + Bridge secret, writes `/data/.platform/platform.json` | `Sandbox`, `mcp_token_hash` (backend stores it to map token → user) |
| **WakeSandbox** | Every turn (`turn.ts`) | Capacity guard, start container, wait for Bridge health, write egress file | `Sandbox` (with `runtime` and `browser_enabled`, which the backend checks against the settings and the plan), `was_stopped` |
| **Deliver** (stream) | Every turn, right after Wake | Marks in flight, `POST /deliver` to the Bridge, relays events | Stream: `ACCEPTED` → `WORKING`… → `TURN_DONE` or `ERROR(platform_fault)` |
| **Touch** | Every `/mcp` tool call | Refreshes last-active (so the reaper waits) | — |
| **StopSandbox** | Not called by the backend today (for ops/tools) | Polite or forced stop | `Sandbox` |
| **DeleteSandbox** | `delete-user` job | Removes container, volume, egress file | — |
| **GetSandbox** | `GET /v1/agent/status`, Claude status checks, the `sync-browser` job | Reads the row + live memory | `Sandbox` (state, last active, memory, runtime, claude_connected, browser_enabled) |
| **ListSandboxes** | Backup job, health check, load-test script | Lists rows | `Sandbox[]` |
| **GetUsage** | `sync-usage` (billing) | Sums awake seconds per user in a window from `awake_periods`, and the browser seconds the container reported (each report counted once) | per-user awake/browser seconds |
| **SetEgressAllowlist** | `sync-allowlist` job (user MCP servers changed) | Rewrites the user's Squid file + MCP config | — |
| **SnapshotVolume** | Nightly `backup` job | Streams `/data` to a `tar.gz` | path, size |
| **SetAgentRuntime** | Agent settings change, after wake if out of sync | Writes `runtime` to platform.json + table, updates egress | `Sandbox` |
| **StartClaudeLogin** | `POST /v1/agent/claude/login` | Wakes, starts `claude auth login` in the container | `login_id`, Anthropic `authorize_url`, expiry |
| **CompleteClaudeLogin** | `POST /v1/agent/claude/login/{id}/complete` | Types the user's code into the waiting CLI (never logged) | `connected`, safe message |
| **ClaudeLogout** | `DELETE /v1/agent/claude` | `claude auth logout` | — |
| **SetBrowser** (2026-10-04) | The `sync-browser` job (a plan changed), after a wake when the record differs, and the dev script | Stores whether Scout's browser is on for the user. It takes effect on the next wake: the container is re-created then if its limits must change, and `/data` is kept | `Sandbox` |

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

The agent (Hermes or Claude Code) is configured with our MCP server URL `http://api:8080/mcp` and `Authorization: Bearer <container token>`. The api hashes the token, finds the user in `sandbox_tokens`, and every tool runs for that user only. Each call is audit-logged and Touches the container. Files for the agent are served at `/mcp/files/<id>?exp&sig` (signed, 1 hour) because `/mcp` was the only api path the proxy allowed (the git gateway's three paths under `/git/` were added later). Their URLs are built from the api's internal address, so `/mcp` and `/git` need not be public: Caddy answers 404 for both.

The web is reached through `/mcp` too: `web_search` and `read_page` run in the api, so the container needs no way out to the internet for research.

Shared memory is reached through `/mcp` as well: `remember`, `recall` and `forget` read and write the user's `memories` rows in the api. Nothing about memory is stored in the container, which is why it survives an engine switch.

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

## E.14 Scout's browser in the container (2026-10-04)

The browser is built in the `vm-manager` repo (the agent image and the vm-manager), at the same time as this doc was updated. What the contract (`vm.proto`) says, which is all the backend relies on:

- **`browser_enabled` per sandbox.** The backend sets it in **CreateSandbox** and changes it with **SetBrowser**. Every `Sandbox` the vm-manager returns carries it.
- **A change takes effect on the user's next wake.** The container is re-created then if its limits must change (a browser needs more memory), the way an image rollout already works. `/data` is kept.
- **A container with the browser on can reach any public website.** Internal names and addresses stay refused. Every other container keeps the short list of E.6 step 10.
- **Browser seconds:** the seconds the browser was open, reported by the container at the end of a turn. Each report is counted once, in the window that holds the moment the vm-manager recorded it, so back-to-back **GetUsage** windows never count a second twice.

How the browser runs in the image, its limits and the proxy rule are described in the `vm-manager` repo's own docs. This doc does not repeat them.

---

# Part F — What is left to test

This table was written before the AWS test deployment of 2026-09-30 and 2026-10-01, which ran several of these for real; `docs/aws-setup.md` records what was proven and what is still open. Docker isn't on the dev machine. The launch basics of 2026-10-03 add rows 13 to 15, the crew package of 2026-10-04 rows 16 to 20, shared memory rows 21 and 22, and Scout's browser (platform side) rows 23 to 26.

| # | Test | How | Pass when |
|---|---|---|---|
| 1 | Stack starts | `docker compose -f infra/docker-compose.yml --profile app up -d` + `pnpm db:migrate` | All services healthy |
| 2 | Egress isolation | `docker compose … --profile egress-test run --rm egress-test` | Direct internet blocked, LiteLLM via proxy OK, other domains 403 |
| 3 | Container lifecycle | `cd vm-manager && go test -tags=integration -v ./internal/integration/` | Create → wake → deliver "hello" → `turn_done`; idle stop; wake with memory; cap respected |
| 4 | Hermes in the real image | Build `agent-image`, send a message | Config keys right, reply arrives |
| 5 | RAM per container | `docker stats --no-stream pa-sbx-<user>` | Number written in `vm-manager/README.md`; set `AWAKE_CAP` |
| 6 | Real channels | Telegram bot (then WhatsApp test number) | Link, chat, buttons, voice |
| 7 | Apps + approvals | Composio free tier, Gmail | Asks before sending, sends after ✅ |
| 8 | Billing | Polar sandbox, LiteLLM + OpenRouter key | Credits go down correctly; purchase adds once; waitlist discount applied |
| 9 | Claude plan | A real Pro/Max account through Squid | Sign-in screen parsed, turns work, errors clear, 4 hosts enough |
| 10 | Automations | A 2-minute reminder, restart the worker | Fires once, on time |
| 11 | Backup + restore | `scripts/restore-test.sh` | Restore works |
| 12 | Load at the cap | `pnpm tsx scripts/load-test.ts` | Awake count never exceeds the cap |
| 13 | `/mcp` and `/git` closed | After a deploy: `curl -i https://<domain>/mcp` and `/git/x/y/info/refs` | 404 from outside; `/healthz` 200; a turn still works |
| 14 | Connection check | `scripts/dev-user.ts connect-app` with no web app and no webhook | The connection turns `active` within a minute of approving |
| 15 | App-action charge with real Composio | Ask the agent to read, then to send | The read is free, the send costs 1 credit; check the `readOnlyHint` tag on real tools |
| 16 | Pull-request review, live | Turn review on for a test repo; open a pull request, push to it, reopen it | Composio creates the trigger; one review is posted per head commit with no approval asked; the verdict arrives on Telegram; a reopen gives none |
| 17 | The four GitHub action names | List Composio's GitHub tools | The names in `integrations/catalog.ts` exist. If one doesn't, the review asks for approval instead |
| 18 | Web search with a real key | Set `BRAVE_SEARCH_API_KEY`; as a Max user on Hermes, ask the agent to search; then the same as a Free or Pro user | Max: results arrive; exactly 1 credit charged; `Web search` in the credit history. Free or Pro: the agent says web search needs Max; nothing charged; the refusal is in the activity log |
| 19 | `read_page` on the real internet | Ask the agent to read a link you sent, then a made-up address | The page's text comes back (https, a compressed page, an `http` to `https` redirect); the made-up address is refused and shows in the activity log |
| 20 | Crew progress from the real Bridge | Start a job that uses a specialist, with the web app open | `agent.progress` lines appear in web chat; Telegram gets only the answer |
| 21 | Shared memory on a real engine | On Hermes and on Claude Code: tell the agent a fact, then ask about it in a later turn. On 2026-10-05, on Claude Code, the lead kept "remember this" in Claude Code's own memory files and used the platform's `remember` only when asked for it by name | The fact is in `GET /v1/memories` without naming the tool; the agent uses it; a save that holds a password is refused |
| 22 | The recap on a real engine switch | Chat on Hermes, connect a Claude plan, send a follow-up that needs the earlier messages; switch back | The new engine carries on; the same engine's next turn has no recap |
| 23 | `read_page` after the built-in search | On a Claude plan, ask for something Scout must search and read; then ask it to read `http://169.254.169.254/`. On Hermes, ask it to read an address nobody named | Claude Code: the results are read (`read_page` in the activity log), the internal address is refused. Hermes: the unseen address is refused |
| 24 | The browser switch for a user who is not on Max | The Max half passed on 2026-10-05. The same user on Pro: `dev-user.ts browser --user <id>`, then a message after the container has stopped | `switched off`, and after the next wake the container can't reach a public site |
| 26 | The dev script's `approve` and `pr-review` | `send`, `status`, `browser`, `messages`, `activity` and `memories` passed on 2026-10-05. Left: `approve` on a waiting approval; `pr-review --repo <owner>/<name> --state on` | The approval is decided and the turn goes on; review is on for the repo |

**Open decisions and known gaps**
- Confirm with Anthropic: Commercial Terms, our UI offering only the Claude-plan sign-in, relaying the pasted code, telemetry off.
- Own API keys are saved and exempt from AI charges, but calls still go through our LiteLLM key (routing through the user's key isn't wired).
- `AI_ACCESS_MODE` defaults to `platform`; set `own_only` for "bring your own AI only".
- Set up Polar: the Pro, Max and $10 top-up products, the waitlist discount (50% off, duration once → `POLAR_WAITLIST_DISCOUNT_ID`), and the webhook endpoint `/webhooks/polar` on API version 2026-10.
- Polar has no dispute webhook: a dispute Polar does not refund itself is handled by hand (admin credit adjustment + flag).
- WhatsApp templates must be approved (one body variable; approval buttons in Approve, Reject order).
- `composio_triggers` table exists but isn't used.
- Scout's browser: the platform side is built (the switch by plan, the charge, what the apps are told). The browser itself is the agent image's and the vm-manager's (`vm-manager` repo). `BROWSER_AVAILABLE` must be set to `true` on the server once the image with the browser is deployed; until then nothing is switched on.
- A Max user's container with the browser on can reach any public website, and so can everything in it. `mvp-hld.md` section 10.3 says what limits the damage and what doesn't. The landing page's line that the sandbox reaches only approved services is no longer true for those users.
- Signing in to sites with the browser is decided and not built. It needs a way for the user to see the browser (`mvp-hld.md` section 11.6); how long a sign-in is kept, which sites, and what Scout may do there are open.
- Web search needs a Brave Search API key on the server (`BRAVE_SEARCH_API_KEY`). Without it `web_search` says it isn't set up. If the server's settings still say `WEB_SEARCH_COST_USD=0.005`, a search costs 1.25 credits, not 1: remove the line or set 0.004.
- Which search Scout is given on each engine is set in the agent image (`vm-manager`). The backend refuses `web_search` on Free and Pro whatever the image does.
- On Claude Code `read_page` opens any public address (decided 2026-10-04). The platform trusts the agent image that only Scout can call it. An agent with a shell can read the container's token and call `/mcp` itself, so the rule can be gone around there: one GET at a time, 30 a minute, each in the activity log. Closing it is the agent image's side and is not built (`mvp-hld.md` section 10.3).
- On Hermes `read_page` refuses a redirect to an address that wasn't seen, on the same site too. It can be loosened to "same site" if too many pages fail.
- An automation that reads a fixed page works only while the link is in the user's recent messages.
- On Hermes, a specialist's tool list is an instruction, not a limit the engine enforces.
- Textcrew AI needs a model provider key on the server, and the models to offer are not chosen yet.
- Shared memory: the platform can't check that the user really said a fact, so an agent that follows an injected instruction can save a false one; it stays until the user deletes it. Refusing saves in turns the user didn't start (app events, automations, pull-request reviews) would close the most likely path and is not built: the founder decides.
- The activity log is kept after an account is deleted. It holds no memory text, but it does hold other summaries (approval texts, search queries). Whether to delete it with the account is open.
- Replies the simple-chat path gives between two turns of the same engine never reach that engine. The recap could carry them; it isn't built.

---

# Part G — Folder structure and how the code works

## G.1 How to read the docs

1. **This file (`system-design.md`)** — start here: the big picture, how things talk, how containers open and close, folder structure.
2. **GoDraw canvas** — the same ideas as pictures (4 pages).
3. **`build-report.md`** — the reference: every table, endpoint, env var, rule and decision. Look things up there when you need exact detail.
4. **`mvp-hld.md`** — the original design, for "why was it planned this way".

## G.2 The top level

```
1_personal_agent/
├── beckend/          the backend: api + worker (TypeScript), infra, docs      ← git repo
├── vm-manager/       the container manager (Go) + the agent image (Python)    ← git repo
└── user-frontend/    the web app (Next.js) — not covered here
```

## G.3 `beckend/` — the backend

```
beckend/
├── openapi/openapi.yaml     THE REST CONTRACT. Change this first, then run `pnpm openapi:gen`.
├── proto-gen/vm/v1/vm_pb.ts gRPC client code, GENERATED from ../vm-manager/proto (`pnpm proto:gen`). Don't edit.
├── migrations/              SQL migrations 0000…0011 (generated by `pnpm db:generate` from the schema files).
├── src/
│   ├── api/                 the api process (HTTP)
│   ├── worker/              the worker process (jobs)
│   ├── modules/             the business logic, one folder per module (shared by api and worker)
│   ├── shared/              small helpers every module uses
│   └── wiring.ts            connects modules to each other at startup
├── test/                    automated tests (one file per phase / feature) + fakes for outside services
├── scripts/                 migrate, copy spec to frontend, restore test, load test, dev-user (ops script)
├── infra/                   docker-compose and configs for Caddy, Postgres, LiteLLM, Squid
└── docs/                    mvp-hld.md, build-report.md, system-design.md, security-checklist.md, deployment.md
```

### `src/api/` — the HTTP server

| File | What it does |
|---|---|
| `main.ts` | Starts the api: loads config, builds the app, listens on `PORT`, shuts down cleanly |
| `app.ts` | Builds the Hono app: middleware, all routes (`allRoutes`), `/mcp`, `/metrics`, Bull Board, error handler |
| `router.ts` | **The heart of the api.** `route('operationId', handler)` + `mountRoutes`: reads method/path/auth/admin from `openapi.yaml`, validates path/query/body, verifies the Clerk session (`requireUser`) |
| `openapi/spec.ts` | Loads `openapi.yaml`, compiles Ajv validators for requests and responses |
| `openapi/schema.d.ts` | TypeScript types generated from the spec (don't edit) |
| `middleware.ts` | Request id, access log + metrics, client IP, per-IP rate limit |
| `client-ip.ts` | Reads the real client IP (the proxy-added `X-Forwarded-For` entry) |
| `mcp.ts` | Mounts the Platform MCP at `/mcp` (token → user) and signed file downloads at `/mcp/files/:id` |
| `admin-board.ts` | Bull Board at `/admin/queues` (admins only) |
| `presenters.ts`, `billing-presenters.ts` | Turn database rows into the JSON shapes the spec defines |
| `types.ts` | Shared types (the Hono context, spec helpers) |
| `routes/*.ts` | One file per area; each is a list of `route('operationId', …)` handlers that call module functions: `me`, `channels`, `chat` (messages, attachments, SSE), `approvals`, `apps` (+ MCP servers), `byok`, `automations` (+ pull-request review), `agent` (status, activity, the crew list), `agent-settings` (runtime, AI preference, Claude sign-in), `memories` (list and delete the shared memory), `billing`, `credits`, `coupons`, `admin`, `waitlist`, `system` (healthz), `webhooks` (Clerk, Telegram, Composio), `webhooks-channels` (WhatsApp, Sendblue), `webhooks-polar` |

**Rule:** route files are thin. They validate (done by the router), call a module function, and shape the answer. All real logic is in `src/modules/`.

### `src/worker/` — the job runner

| File | What it does |
|---|---|
| `main.ts` | Starts the worker: wiring, workers for the 4 queues, re-queues unfinished events, re-registers automations, registers repeating jobs |
| `runner.ts` | Creates one BullMQ worker per queue; takes the **per-user lock** for inbound jobs; retries with backoff; marks events done/failed; raises an alert on final failure |
| `processors.ts` | **The job list:** maps each queue + job name to its handler function in a module |
| `schedules.ts` | Repeating system jobs (expire approvals, cleanup, backup, health check) + the cleanup job |
| `ignored.ts` | A marker a handler returns to say "nothing to do" (event marked ignored) |

### `src/modules/` — the business logic

Each module folder has a `schema.ts` (its tables, Drizzle) and plain files of functions. Other modules call these functions; nobody touches another module's tables.

| Module | Files and what they do |
|---|---|
| **auth** | `session.ts` verify Clerk JWT · `users.ts` user rows · `provision.ts` create user on sign-up / first sign-in · `jobs.ts` Clerk webhook job · `webhooks.ts` svix check · `links.ts` link codes + chat links · `waitlist.ts` waitlist + discount offer |
| **events** | `intake.ts` **ingestEvent** (save event + add job, deduplicated) · `queues.ts` the 4 queues + retry settings · `cleanup.ts` old events |
| **channels** | `adapters/telegram.ts`, `whatsapp.ts`, `sendblue.ts`, `web.ts` parse incoming + send outgoing per provider · `adapters/index.ts` adapter registry · `inbound.ts` payload → one normalized message · `outbound.ts` **queueOutbound** + the send job · `messages.ts` message rows · `media.ts` download media, voice → text · `files.ts` attachments + signed URLs · `purchase-links.ts` no purchase links on Telegram · `stream.ts` SSE via Redis pub/sub · `status.ts` delivery receipts · `text-buttons.ts` yes/no replies · `register.ts` registers WhatsApp/Sendblue · `types.ts` shared types |
| **orchestrator** | `process-message.ts` **the inbound job** (link, approvals, coupons, media, then a turn) · `turn.ts` **runTurn** (credit check → routing → wake → deliver) · `routing.ts` Jev simple/task/spam · `vm.ts` **the gRPC client** · `sandbox.ts` ensureSandbox, token → user, agent status, Touch · `lifecycle.ts` onboard/delete jobs · `approvals.ts` approvals · `agent-settings.ts` Hermes vs Claude Code, AI access, choosing Textcrew AI · `claude-login.ts` Claude sign-in calls · `crew.ts` the crew list, reading a progress line · `browser.ts` Scout's browser switch: who has it, the `sync-browser` job, the check after a wake · `memory.ts` **shared memory**: save, find, correct, delete, and the block for a turn · `memory-secrets.ts` the check that refuses secrets · `turn-context.ts` what goes at the top of a delivered turn (the memory block, the recap) and which engine last ran each chat · `lock.ts` per-user Redis lock |
| **platform-mcp** | `server.ts` builds the MCP server per request, audits + Touches every call · `registry.ts` how tools are defined · `tools/core.ts` send_message, get_profile · `tools/apps.ts` list/run app actions, request_approval · `tools/automations.ts` reminder/automation tools · `tools/web.ts` web_search, read_page · `tools/memory.ts` remember, recall, forget · `seen-urls.ts` which web addresses were seen for a user |
| **integrations** | `catalog.ts` the 25 apps + risky-action detection + whether an action changes something + which GitHub comment the review permission covers · `git-gateway.ts` git for the user's GitHub, and a pull request's head commit · `web-page.ts` the page reader (address checks, pinned connection, text extraction) · `web-search.ts` the search provider interface + Brave · `composio.ts` Composio SDK wrapper · `apps.ts` connections + scheduling the connection check · `mcp-servers.ts` user MCP servers · `byok.ts` own API keys · `jobs.ts` allowlist sync + Composio connection events + the check-connection job · `tables.ts`, `schema.ts` tables |
| **billing** | `plans.ts` plans, prices, limits, credit maths, 90-day expiry · `credits.ts` **grants + ledger**, spending order, charges, expiry, reversals · `usage.ts` **sync-usage** (charging) · `app-actions.ts` the 1-credit app-action charge, its refund and its usage numbers · `paid-tools.ts` the paid-tool charge (cost × 2.5, fractions carried over) · `item-charges.ts` what those two share · `litellm.ts` per-user keys + budgets · `enforce.ts` after credits change (budget, hooks) · `hooks.ts` "depleted"/"added"/"plan changed" listeners · `polar.ts` checkout, cancel + webhook check · `polar-events.ts` order/subscription/refund events · `subscriptions.ts` subscription rows · `coupons.ts` coupons · `chat.ts` coupon codes sent in chat · `free-credits.ts` monthly free-credit cap + abuse stats · `onboard.ts` sign-up grant + key · `admin.ts` admin adjustments · `models.ts` model checks · `balance.ts` balance summary · `jobs.ts` billing jobs + schedules · `index.ts` what other modules may import |
| **automations** | `automations.ts` create/list/pause/delete, timers, limits · `jobs.ts` fire an automation as a turn, app-event triggers, auto-pause · `pr-review.ts` pull-request review: on/off per repo, one review per head commit, the standing permission |
| **admin** | `audit.ts` audit log · `alerts.ts` alert logs + webhook · `metrics.ts` Prometheus text · `health.ts` health-check job · `backup.ts` nightly backup |

### `src/shared/` — helpers

| File | What it does |
|---|---|
| `config.ts` | Reads + validates every env var with Zod (startup fails loudly if wrong); `isChannelEnabled` for the channels switch; the crew, browser and web search settings |
| `db/client.ts`, `db/schema.ts`, `db/migrate.ts` | Postgres connection, all tables re-exported for Drizzle, run migrations |
| `redis.ts` | Redis connections |
| `errors.ts` | `AppError` → the spec's `{ error: { code, message } }` shape |
| `crypto.ts` | AES-GCM encrypt/decrypt, sha256, random codes, safe compare |
| `ids.ts` | Time-sortable ids like `usr_…`, `msg_…` |
| `logger.ts` | pino JSON logger with secret redaction |
| `rate-limit.ts` | Redis counters for rate limits |

### `src/wiring.ts` — connecting the modules

Runs once at startup in both processes. It plugs modules into each other's **hooks**, e.g.: billing's `hasCredits` into the turn · billing's app-action charge into `run_app_action` · billing's paid-tool charge into `web_search` · Jev routing into the turn · approval replies and coupon codes into the inbound path · billing "balance depleted" → pause automations · sandbox config (LiteLLM key, MCP servers) into container creation · onboarding/deletion steps. This is why modules don't import each other in circles.

## G.4 Follow one Telegram message through the files

```
POST /webhooks/telegram
 └ api/middleware.ts            request id, log, IP, rate limit
 └ api/router.ts                operation webhookTelegram (public, raw body)
 └ api/routes/webhooks.ts       Telegram switched on? → verifyTelegramSecret() → findLink() → ingestEvent() → 200
    └ modules/events/intake.ts  INSERT events (unique) → queue('inbound').add('process-message', {jobId: eventId})

worker
 └ worker/runner.ts             takes lock:user:<id>, calls the handler
 └ worker/processors.ts         'process-message' → handleProcessMessage
 └ orchestrator/process-message.ts
      channels/inbound.ts       parseInbound() → normalized message
      auth/links.ts             linked? link code?
      orchestrator/approvals.ts ✅/❌ or yes/no?     (hook from wiring.ts)
      billing/chat.ts           coupon code?          (hook from wiring.ts)
      channels/media.ts         download media, voice → text
      channels/messages.ts      saveInbound()
 └ orchestrator/turn.ts         runTurn():
      billing (hasCredits)      credit check          (hook)
      orchestrator/routing.ts   Jev simple/task/spam  (hook)
      orchestrator/sandbox.ts   ensureSandbox()
      orchestrator/vm.ts        vm().wakeSandbox()                    ── gRPC ──▶ vm-manager
      orchestrator/agent-settings.ts  syncRuntimeAfterWake() → the engine of this turn
      orchestrator/turn-context.ts    turnText(): memory block + recap (if the engine changed) + the text
      orchestrator/vm.ts        vm().deliver()                        ── gRPC ──▶ vm-manager
 … inside the container the agent calls /mcp:
 └ api/mcp.ts → platform-mcp/server.ts → tools/core.ts send_message
      channels/outbound.ts      queueOutbound() → message row + 'send-message' job
 └ worker: channels/outbound.ts handleSendMessage → adapters/telegram.ts send()   (purchase links taken out)
 └ after turn_done: orchestrator/turn-context.ts recordEngineTurn() · billing/usage.ts syncUsageForUser() → channels/stream.ts publish('credits.updated')
```

## G.5 `vm-manager/` — the container manager

```
vm-manager/
├── proto/vm/v1/vm.proto     THE gRPC CONTRACT (both sides are generated from it)
├── gen/vm/v1/               generated Go code (buf) — don't edit
├── cmd/vm-manager/main.go   starts everything
├── internal/                the Go packages
├── migrations/              0001_sandboxes.sql, 0002_agent_runtime.sql (embedded, run at startup)
├── agent-image/             the user container image: Dockerfile + the Bridge (Python)
├── Dockerfile               the vm-manager's own image
└── docs/build-report.md, README.md
```

| Package / file | What it does |
|---|---|
| `cmd/vm-manager/main.go` | Load config → connect Postgres + run migrations → Docker client → build the Manager → reconcile once → start loops → serve gRPC on :9090 → graceful stop |
| `internal/config` | Env vars (cap, timeouts, limits, image, network…) with validation |
| `internal/grpcserver/server.go` | **The gRPC service.** Each RPC checks input, calls the Manager, maps errors to gRPC codes. Interceptors check `x-internal-secret` and redact the Claude code in logs |
| `internal/sandbox/manager.go` | **The Manager:** per-user locks, in-flight counters, the container spec (limits, gVisor, read-only, network) |
| `internal/sandbox/lifecycle.go` | **Create, Wake (capacity guard, re-create, start, health wait), Stop (polite/force), Delete** |
| `internal/sandbox/deliver.go` | **Deliver:** relays the Bridge's NDJSON as gRPC events, busy/awake states, 15-min timeout → force stop |
| `internal/sandbox/loops.go` | **Background loops:** idle reaper, health checker, reconciler |
| `internal/sandbox/ops.go` | Touch, Get/List (with memory), Usage (awake seconds), SetEgressAllowlist, Snapshot |
| `internal/sandbox/claude.go` | Runtime switch + Claude sign-in/out (pending sign-in counts as busy) |
| `internal/docker` | `docker.go` the Engine interface · `client.go` the real Docker SDK calls · `fake.go` a fake Docker for tests |
| `internal/bridge/client.go` | HTTP client to the Bridge: health, deliver (NDJSON), shutdown, Claude sign-in |
| `internal/egress/egress.go` | Writes/removes each user's Squid file, validates domains, sends SIGHUP to the proxy |
| `internal/platformfile` | Reads/writes `/data/.platform/platform.json` (the only place plaintext secrets live) |
| `internal/store` | `store.go` interface · `postgres.go` the `sandboxes` + `awake_periods` tables · `memory.go` in-memory for tests |
| `internal/ids` | User id checks, container/volume names, random secrets + hashes |
| `internal/clock` | A clock that tests can fake (to test "idle for 3 minutes" instantly) |
| `internal/integration` | Real-Docker tests (`-tags=integration`), not run yet |

**How one gRPC call moves through it (WakeSandbox):**
`grpcserver/server.go` (secret check, input) → `sandbox/lifecycle.go` Wake (lock → capacity guard → ensure container → start) → `docker/client.go` (start, inspect IP) → `store/postgres.go` (state, awake period) → `bridge/client.go` Health (poll ≤ 90 s) → `egress/egress.go` (write file, SIGHUP) → back to the backend.

## G.6 `vm-manager/agent-image/` — inside the user container

| File | What it does |
|---|---|
| `Dockerfile` | Python base + Hermes (pinned) + Claude Code CLI (pinned, signature-checked) + the Bridge; non-root; everything writable lives in `/data` |
| `bridge/__main__.py` | Container entrypoint (`python -m bridge`): starts Hermes and the HTTP server |
| `bridge/server.py` | The HTTP server for the vm-manager: `/healthz`, `/deliver` (NDJSON), `/shutdown`, `/claude/login/*`, `/claude/logout`; checks `X-Bridge-Secret` |
| `bridge/runtime.py` | Reads `runtime` from platform.json on every delivery → Hermes or Claude Code |
| `bridge/core.py` | Dedupe by `delivery_id`, run one turn, stream events, send the final answer |
| `bridge/hermes.py` | Runs `hermes gateway run` (local API only) and drives one Hermes run per delivery, one session per chat |
| `bridge/claude.py` | Runs the official `claude` CLI: `claude -p` turns with our MCP config, per-chat sessions, sign-in/out in a pseudo-terminal |
| `bridge/platform.py` | Turns `platform.json` into Hermes's config (model via LiteLLM, Platform MCP + the user's MCP servers) at every boot |
| `bridge/mcp_client.py` | Tiny MCP client the Bridge uses to call `send_message` with the final answer |
| `tests/` | 87 tests with a fake Hermes and a fake `claude` executable (the number reported by the agent-image package on 2026-10-04) |

**Inside a turn:** vm-manager `POST /deliver` → `server.py` (secret) → `core.py` (dedupe, `accepted`) → `runtime.py` (which agent) → `hermes.py` or `claude.py` (run the turn; the agent calls our tools on `/mcp`) → `mcp_client.py` `send_message(final answer)` → `turn_done` back to the vm-manager.

## G.7 `beckend/infra/` and `scripts/`

| File | What it does |
|---|---|
| `infra/docker-compose.yml` | The whole stack on one server: networks `edge`/`platform`/`sandbox`, Caddy, Postgres, Redis, LiteLLM, Squid, vm-manager, agent-image build, api + worker (`--profile app`), egress test (`--profile egress-test`) |
| `infra/caddy/Caddyfile` | HTTPS reverse proxy to the api (SSE-friendly); 404 for `/mcp*` and `/git/*` |
| `infra/postgres/init.sql` | Creates the extra databases `litellm` and `vm_manager` |
| `infra/litellm/config.yaml` | Model names (`cheap`, `claude`, `gpt`, `whisper`) and fallbacks |
| `infra/egress-proxy/squid.conf` | Base proxy rules + `include allowlists/*.conf` (per-user files from the vm-manager) |
| `infra/tests/egress-test.sh` | Proves a container can reach only the proxy |
| `infra/Dockerfile` | Image for the api/worker |
| `scripts/migrate.ts` | Apply migrations (`pnpm db:migrate`) |
| `scripts/openapi-sync.mjs` | Copy the spec to the frontend (`pnpm openapi:sync`) |
| `scripts/restore-test.sh` | Restore the latest backup into a scratch DB and check it |
| `scripts/load-test.ts` | Many chats at once; checks the awake cap holds |
| `scripts/dev-user.ts` | Ops script for a live test without the web app or Telegram: create a user, link code, Claude sign-in, connect an app, status (which asks Composio about pending connections, and shows Scout's browser switch). Since 2026-10-04 also a whole turn: `send` (a web chat message through the route's own function; prints progress lines and the reply), `messages`, `activity`, `approve`, `pr-review`, `memories`, `browser`. What it prints goes through `hideSecrets` (`build-report.md` §6.24) |

## G.8 `beckend/test/`

| File(s) | Tests |
|---|---|
| `global-setup.ts`, `setup.ts`, `helpers.ts` | Start one real Postgres + Redis; a fresh database per test file; helpers like `createUser`, `call`, `expectContract` (checks responses against the spec) |
| `fakes.ts`, `fakes-channels.ts`, `billing-fakes.ts`, `polar-fakes.ts`, `billing-helpers.ts` | Fake vm-manager (its "agent" really calls `/mcp`), fake Telegram/WhatsApp/Sendblue/Composio/LiteLLM/Polar/Jev |
| `phase1-*` | Skeleton: contract, auth, webhooks dedupe, per-user lock, retries |
| `phase3-*` | Telegram end to end, web chat, SSE, cross-user isolation |
| `phase4-*` | Apps, approvals, crafted cross-user requests, MCP servers |
| `phase5-*` | Credits, usage charging, coupons (50 in parallel), Polar, LiteLLM keys, jobs, billing API |
| `phase6-*` | WhatsApp, Sendblue, media + voice, Jev routing, real HTTP clients vs a stand-in |
| `phase7-*` | Automations across restart + Redis wipe |
| `phase8-*` | Backups, metrics, rate limits, health check, schedules |
| `integration-billing`, `waitlist`, `waitlist-offer`, `claude-plan`, `git-gateway`, `dev-user-script` | Cross-module billing, waitlist, discount, Claude plan, git gateway, the ops script |
| `channels-switch`, `app-action-charge`, `app-connections`, `telegram-no-purchase-links`, `infra-caddy` | The launch basics of 2026-10-03: the channels switch, the app-action charge, the connection check job, the Telegram rule, the Caddy rule |
| `crew`, `textcrew-ai-choice`, `pr-review`, `scout-tools` | The crew package of 2026-10-04: the crew list and progress lines; choosing Textcrew AI; pull-request review (on/off, one review per head commit, the narrow standing permission); `read_page` (every address refusal, redirects, the pinned connection, the seen-address rule) and `web_search` (the Max-plan check and its refusal, the Brave client, the 1-credit charge, limits) |
| `browser` (and parts of `phase5-usage`, `scout-tools`, `crew`, `dev-user-script`) | Scout's browser, platform side, of 2026-10-04: who has it (plan and `BROWSER_AVAILABLE`), the state in CreateSandbox, plan changes through Polar's events and the `sync-browser` job (upgrade, downgrade, a cancellation taking effect, revoked), the job repeated and retried, the check after a wake, no wake at zero credits; browser time at 2 credits per minute charged once; `read_page` on Claude Code and on Hermes; the crew list's `browser`; the script's new commands |
| `memory`, `memory-turns` | Shared memory of 2026-10-04: the three tools, the limits, the secret check, one user's token against another user's memories, the endpoints, account deletion; and what is delivered: the block on every kind of turn, its order and budget, text in a memory or a message that tries to write the platform's lines, the recap on an engine change (per chat, after a failed turn, within its budget) |

Run everything: `pnpm lint && pnpm typecheck && pnpm test` (backend) · `go vet ./... && go test ./...` (vm-manager) · `python3 -m unittest discover -s tests -t .` (in `agent-image/`).

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
| **App action** | One call to a connected app through Composio. One that changes something costs 1 credit; one that only reads is free |
| **Channels switch** | `ENABLED_CHANNELS`: which of Telegram, web, WhatsApp and iMessage are on |
| **Textcrew AI** | The platform's own AI offer: a rented model behind LiteLLM, paid in credits |
| **Crew** | Tex (the lead, the agent the user texts) and the specialists Byte (coding), Patch (code review) and Scout (research) |
| **Progress line** | A short line the Bridge sends during a turn, like `Scout: reading 4 pages`; shown live in web chat |
| **Paid tool** | A tool that calls a pay-per-use service (web search); charged at its configured cost × 2.5. For web search that is set to exactly 1 credit a search |
| **Standing permission** | What turning pull-request review on gives: comments on that repo's pull requests run without a per-comment approval |
| **Seen address** | A web address `read_page` may open for a user: from their own messages, a search result, or a link on a page already read |
| **Shared memory** | Short facts about the user kept on the platform (`memories`), the same for every engine. Saved with `remember`, found with `recall`, removed or corrected with `forget` |
| **Memory block** | What is known about the user, put at the top of every delivered turn's text and marked as data |
| **Recap** | The recent messages of a chat, added to a turn when its engine is not the one that handled the chat before |
| **Engine** | What answers inside the container: Hermes or Claude Code (the runtime) |
