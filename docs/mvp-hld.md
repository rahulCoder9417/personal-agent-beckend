# Personal Agent MVP: HLD and build plan

**Who this is for:** a developer, or an AI coding agent, building the MVP phase by phase. Every phase in **section 9** says what to build, which sections to read, and how to know it's done.

**Diagram:** godraw canvas **"Backend + Sandbox Manager — HLD"**. It was drawn before the rename, so its "sandbox-manager" boxes are the **vm-manager** in this doc.
(page 1 components & connections · page 2 one message through the system · page 3 inside the vm-manager · page 4 queues & automations)

**What the product is:** a personal AI assistant users message on **Telegram or the web app**. WhatsApp and iMessage are built but **switched off at launch** (section 0.3). It does real work in about **25 apps + the user's own MCP servers**, asks before risky actions, remembers the user, runs reminders and automations, and bills in **credits**. **Every user gets their own sandboxed container** running the Hermes agent.

---

## Contents

0. How it works (read first)
1. Architecture decisions: services, microservices, gRPC
2. Folders and repos
3. Components and tools
4. Networks and communication
5. Backend: api + worker
6. vm-manager (Go)
7. Plans, credits and coupons
8. Data model
9. **Build phases** (hand these to the AI one at a time)
10. Failures and security

---

## 0. How it works (read first)

### 0.1 Auth: who is allowed to do what

| Caller | How it proves who it is | What we get from it |
|---|---|---|
| **Web user** | Signs in with **Clerk** → the web app sends Clerk's session token on every request → the api checks it with Clerk's SDK | The user id |
| **Chat user** (WhatsApp / Telegram / iMessage) | Their chat id must be **linked** to an account first (below) | The user id, looked up from `channel_links` |
| **External service webhooks** (Meta, Telegram, Sendblue, Clerk, Polar, Composio) | Each is **signed or carries our secret**; the api checks before reading anything | "This really came from Meta/Clerk/…" |
| **A user's container** (Hermes calling the Platform MCP) | A **per-container token**, made by the vm-manager at creation and stored only as a hash. The api turns it into the user id | The user id, which the container **can't choose or fake** |
| **Internal services** (backend → vm-manager over gRPC, vm-manager → Bridge) | A shared internal secret in gRPC metadata on the private network (mutual TLS later); a per-container Bridge secret | "This is our own service" |

- **Sign-up:** Clerk sign-up → signed `user.created` webhook → the api creates the user row, gives the **100 free sign-up credits**, and adds a *create-sandbox* job.
- **Linking a chat app:** the web app shows a **one-time code** (random, single use, expires in 10 minutes) → the user sends it to our bot or number → the webhook matches it → `channel_links` saves "this chat id = this user". Only a channel that is switched on can be linked (section 0.3).
- **Unknown senders:** they get only a "please link your account at …" reply. The message never reaches an agent.
- **Deleting an account:** `user.deleted` webhook → job → delete the container and data, revoke the LiteLLM key, remove the links.

### 0.2 BullMQ: how jobs flow

- **The roles:** Redis holds the queues. The **api only adds jobs**; the **worker only runs jobs**. The Postgres **`events`** table is the permanent record of everything that came in.
- **The idea:** webhooks never do work. They check, save, add a job, and answer 200 fast.

**Four queues**, so slow work never blocks fast work:

| Queue | Holds |
|---|---|
| **inbound** | Chat messages, approval answers, app-event triggers, fired automations |
| **outbound** | Replies and buttons to send |
| **scheduled** | Reminders (delayed jobs) and repeating automations |
| **system** | Create/delete sandbox, usage sync, monthly credit grants, cleanup, backups |

**A job's life:** *waiting* → *active* → *completed*. On failure it's retried after a growing delay (5 s, 30 s, 2 min…, up to 5 tries), then marked *failed* and shown in the admin view.

**What keeps it correct:**
- **No duplicates:** the job id is the event id.
- **One run per user at a time:** a Redis lock per user. A busy user's job is pushed back 2 seconds, so order is kept.
- **Worker crash:** BullMQ puts "stalled" jobs back, and every step checks "already done?".
- **Redis lost:** Redis saves to disk. A recovery step re-adds jobs for events not marked done, and automations are re-registered from Postgres.
- **Admin dashboard:** Bull Board, admin-only.

### 0.3 WhatsApp: in and out

**Setup:**
1. A Meta business app with WhatsApp Cloud API (start with the free test number).
2. Our webhook URL + verify token.
3. Subscribe to messages; get a permanent access token.
4. Get templates approved: *reminder*, *approval needed*, *task done*.

**Incoming:**
1. Signed webhook → verify → look up `channel_links` → save the event (unique on WhatsApp's message id) → **inbound** job → 200.
2. Status updates (sent, delivered, read) only update message status.
3. Voice, images and documents arrive as a media id → the worker downloads them → voice is turned into text.

**Outgoing** (always through the **outbound** queue):
- **Within 24 hours** of the user's last message: free text + reply buttons (max 3). Approval buttons carry the approval id.
- **After 24 hours:** only an **approved template** (paid per message).
- Long replies are split (~4,096 characters). Failed sends are retried. A blocked number is marked, and the web app is used instead.

**Telegram:** no 24-hour rule; inline buttons. **iMessage** (Sendblue): no buttons, so the user replies "yes" or "no".

**Launch channels and the switch** (decided 2026-10-03, `docs/launch-plan.md` D2 and D3):

- **On at launch:** Telegram and the web app. Phone users use Telegram plus the web app's phone layout.
- **Off at launch:** WhatsApp and iMessage. The code stays. WhatsApp's terms forbid a general AI assistant outside the EEA, and the unofficial iMessage route can be cut off without appeal (`docs/market-and-mvp.md` section 6). There is no SMS channel.
- **The setting:** `ENABLED_CHANNELS`, a comma-separated list of `telegram`, `web`, `whatsapp`, `imessage`. Default `telegram,web`. It is checked at startup; an unknown name stops the process.
- **When a channel is off:**
  - No link code can be created for it: `403 channel_disabled`.
  - Its webhook answers 200 and does nothing: no signature check, no event, no job. WhatsApp's verification handshake answers 403.
  - The worker ignores a message from it that was queued earlier, and never sends to it (the message is marked failed).
  - With `web` off, web chat (`POST /v1/messages`) answers `403 channel_disabled`. The rest of the web app keeps working.
  - Links made earlier stay listed, so the user can unlink them.
- **Telling the apps:** `GET /v1/channels` returns `available`, the list of channels that are on. The web app offers only those.

### 0.4 Automations

- **Source of truth:** the `automations` table. BullMQ only holds the timers.

| Kind | Example | Timer |
|---|---|---|
| Once | "Remind me Friday 10am…" | Delayed job in *scheduled* |
| Repeating | "Every Monday 9am…" | BullMQ repeating job scheduler (cron + user timezone), keyed by automation id |
| App event | "When my boss emails me…" | Composio trigger → webhook → inbound job |

- **Create:** the user says it → Hermes calls *create_automation* → the api checks the plan limit, a 15-minute minimum interval and the timezone → saves → registers the timer → confirms.
- **Fire:** a *run-automation* job goes through **the same path as a normal message**, with the saved instruction.
- **Safety:** each run costs credits. An automation auto-pauses at 0 credits or after 3 failures in a row.
- **Recovery:** on worker start, re-register all enabled automations from Postgres.

### 0.5 Hermes inside a container

**The container:**
- **Hermes Agent** (Python) + **Bridge** (our adapter, plugged in as a Hermes messaging platform).
- **Config at creation:**
  - model = LiteLLM (via the egress proxy) with **this user's key**
  - MCP = **Platform MCP** (with this container's token) + the user's own MCP servers
  - Hermes's own chat connectors and cron **off**
  - memory, skills, sessions and files in **/data**

**One turn:**
1. The vm-manager **delivers** a message to the Bridge.
2. The Bridge hands it to Hermes in that chat's session.
3. Hermes loops: LLM → tool call on the Platform MCP → result → … → final answer.
4. The final answer goes out through *send_message* (outbound queue).
5. The Bridge reports **turn done** → the vm-manager's *Deliver* stream ends → the worker releases the user's lock.

**Approvals never block:** *request_approval* returns "pending", and Hermes ends its turn ("waiting for your OK"). The user's ✅ or ❌ arrives later as a new message, and Hermes continues from its saved session.

**Learning:** memory and skills are updated in /data, so each agent improves for its own user only.

### 0.6 Closing containers

**The rule:** stop when **not in a turn** **and** quiet for **3 minutes**. Activity means every delivered message and every Platform MCP call; the api sends *Touch* to the vm-manager.

**A stop:**
1. The idle reaper (every minute) finds a match.
2. It sends a polite shutdown, and Hermes saves to /data (up to 20 s).
3. The container stops (RAM freed; container and /data kept).
4. It's marked stopped, and the awake period is recorded for credits.

**Other stops:**
- **Capacity guard:** stop the longest-idle, not-busy container first.
- **Stuck turn:** over 15 minutes → force-stop, and the user is told.
- **New image:** stopped containers are re-created on their next wake (/data kept).
- **Deleted:** only on account deletion.

---

## 1. Architecture decisions: services, microservices, gRPC

### 1.1 How many services? A modular monolith plus one separate service

| Unit | Why it's separate (or not) |
|---|---|
| **backend** (api + worker) | **One codebase, two processes.** The api and worker share the same modules, database and types. Splitting them into more microservices now would add network calls, deployments and failure points with no benefit at MVP scale |
| **vm-manager** | **A separate service**, because it's a **privilege boundary**: it's the only thing with Docker access, which is effectively root on the server. Keeping it tiny and separate limits the damage if the backend has a bug. It's also written in **Go**, the best language for Docker |
| **agent container** (Hermes + Bridge) | Separate by nature: one per user, untrusted |
| LiteLLM, egress proxy, Postgres, Redis, Caddy | Off-the-shelf infrastructure, configured rather than coded |

**Inside the backend, keep clear modules** so they could be split into services later if ever needed. Each module owns its own tables, and modules talk through function calls (same process) or queues (between api and worker):

| Module | Owns |
|---|---|
| **auth** | Users, Clerk integration, link codes, channel links |
| **channels** | WhatsApp / Telegram / Sendblue / web adapters (receive + send) |
| **events** | Webhook intake, `events` table, queue producers |
| **orchestrator** | Per-user lock, Jev routing, the wake → deliver flow |
| **platform-mcp** | The MCP server the agents call |
| **integrations** | Composio (connect, run actions, triggers), user MCP servers |
| **billing** | Plans, subscriptions, credit grants, ledger, coupons, Polar, LiteLLM keys and budgets |
| **automations** | Automation rows and timers |
| **admin** | Admin APIs, Bull Board, coupon creation |

**Later split candidates**, only if load demands it: *channels* (as a gateway) and *billing*.

### 1.2 Which protocol where

| From → To | Protocol | Why |
|---|---|---|
| Web app → api | **REST (JSON)** + **SSE** for live updates, defined in **`openapi/openapi.yaml`** | Simple for browsers; typed client generated from the spec |
| External services → api | **Webhooks (HTTPS POST)**, also listed in `openapi/openapi.yaml` | That's what they offer |
| api → worker | **BullMQ jobs** (async) | Decouples fast intake from slow work |
| **backend (api/worker) → vm-manager** | **gRPC** (protobuf) | Typed contract between TypeScript and Go; **streaming** for Deliver (progress → turn done); fast on the private network |
| vm-manager → Bridge (in container) | **HTTP (JSON)** on the sandbox network | Bridge is Python inside Hermes; kept simple; one secret per container |
| Container → Platform MCP (api) | **MCP over streamable HTTP**, via the egress proxy | The standard way agents call tools |
| Container → Git gateway (api) | **Git smart HTTP** (`/git/<owner>/<repo>`), via the egress proxy | Real `git clone` / `fetch` / `push` for the user's GitHub without a GitHub token in the container (section 5.1) |
| Container → LiteLLM | **OpenAI-compatible HTTP**, via the egress proxy | What Hermes speaks |
| Backend → Composio / Jev / LiteLLM admin / channel APIs / Polar | Their **HTTP APIs / SDKs** | External |

**The gRPC contract** (`vm-manager/proto/vm/v1/vm.proto`) is the source of truth. The backend generates its TypeScript client from it with **buf** (Connect-ES or grpc-js). Its RPCs:

| RPC | Type | Purpose |
|---|---|---|
| CreateSandbox | unary | New container + volume + tokens (stays stopped) |
| WakeSandbox | unary | Start if needed, wait for the Bridge to be healthy |
| **Deliver** | **server-streaming** | Send a message or approval answer; stream events *accepted → working → turn_done / error* |
| Touch | unary | Refresh last-active |
| StopSandbox | unary | Polite stop (force flag for stuck turns) |
| DeleteSandbox | unary | Remove container, volume, egress rules |
| GetSandbox / ListSandboxes | unary | State, last active, resource use |
| GetUsage | unary | Awake periods per user since a time (for credits) |
| SetEgressAllowlist | unary | The user's MCP domains changed |
| SnapshotVolume | unary | Archive /data for backup |

**Auth on gRPC:** a shared secret in metadata; only the platform network can reach the port. Mutual TLS later.

### 1.3 Contracts are the source of truth

| Boundary | Contract file | Rule |
|---|---|---|
| Web app ↔ api (REST, SSE) and external webhooks | **`beckend/openapi/openapi.yaml`** (OpenAPI 3.1) | **Change the spec first, then the code.** The api validates every request against it and tests validate every response against it. The web app generates its client types from it |
| backend ↔ vm-manager | `vm-manager/proto/vm/v1/vm.proto` | Both sides generated from it with buf |
| agent ↔ platform | Platform MCP tool list in 5.1 | Tool names, inputs and outputs are defined once in the api and exposed via MCP |

**How the OpenAPI spec is used:**
- **CI lints it** (Redocly): an invalid spec fails the build.
- **Route handlers use the spec's schemas** (generated TypeScript types + a validation middleware). A request that doesn't match gets a 400 with the `Error` shape.
- **Contract tests** call every endpoint and check the response against the spec.
- **The `Error` shape, pagination (`cursor`/`nextCursor`), auth (Clerk bearer) and the coupon's generic error** are all defined there; the code follows them exactly.
- **Frontend copy:** a script copies the spec to `user-frontend/ignore/openapi.yaml` (that folder is gitignored in the frontend repo). The backend copy is always the master.

---

## 2. Folders and repos

```
1_personal_agent/
├── beckend/            ← GIT REPO (the backend + docs + infra)
│   ├── README.md
│   ├── docs/mvp-hld.md, docs/deployment.md
│   ├── openapi/openapi.yaml   ← REST + webhook contract (source of truth)
│   ├── src/            api + worker (one TypeScript codebase, modules as in 1.1)
│   ├── proto-gen/      TypeScript client generated from vm-manager/proto
│   ├── migrations/     database migrations
│   └── infra/          docker-compose, Caddy, LiteLLM config, egress proxy config, backup scripts
└── vm-manager/         ← the Go service (its own repo later)
    ├── proto/vm/v1/    gRPC contract (source of truth)
    ├── cmd/, internal/ Go service
    └── agent-image/    Dockerfile for Hermes + Bridge (Bridge adapter in Python)
└── user-frontend/      ← the web app (Next.js)
    └── ignore/         gitignored: copy of openapi.yaml + platform-overview.md
```

The web app lives in `user-frontend/` and is built from `openapi.yaml` + `ignore/platform-overview.md`; it isn't covered by this doc.

---

## 3. Components and tools

| Component | Where | Language / tools | Owns |
|---|---|---|---|
| **api** | beckend | Node 22 · Hono · Drizzle · Zod · BullMQ producer · Clerk SDK · MCP TypeScript SDK · gRPC client | Webhooks, REST + SSE, Platform MCP, admin |
| **worker** | beckend | Node 22 · BullMQ worker · Drizzle · Composio SDK · Jev SDK · channel clients · gRPC client | All jobs |
| **vm-manager** | vm-manager | **Go** · gRPC · Docker Engine SDK · gVisor (`runsc`) · pgx | Container lifecycle, egress allowlists |
| **agent image** | vm-manager/agent-image | Hermes Agent + Bridge (Python) | The agent |
| Postgres 16 | infra | – | All platform data (+ LiteLLM's database) |
| Redis 7 | infra | Append-only persistence | Queues, locks, rate limits |
| LiteLLM | infra | – | Per-user AI keys, budgets, cost tracking, model routing |
| Egress proxy | infra | Squid (or Smokescreen) | The only way out of containers |
| Caddy | infra | – | HTTPS |

**External services:** Clerk, Meta WhatsApp Cloud API, Telegram Bot API, Sendblue (iMessage, enabled last), Composio, OpenRouter (cheap models), Anthropic/OpenAI (paid plans), TypeSafe **Jev** (routing decisions), **Polar** (payments, merchant of record), off-server backup storage.

---

## 4. Networks and communication

| Docker network | Members | Internet? |
|---|---|---|
| **edge** | Caddy, api | Only Caddy (80/443) |
| **platform** | api, worker, vm-manager, Postgres, Redis, LiteLLM, egress proxy | No |
| **sandbox** (internal) | user containers, egress proxy, vm-manager | No |

**Rules:**
- The internet reaches only Caddy → api.
- **`/mcp` and `/git` are not reachable from the internet.** Caddy answers 404 for `/mcp*` and `/git/*`. Only user containers need those two paths, and they reach the api directly on the platform network through the egress proxy, never through Caddy. Attachment URLs under `/mcp/files/` are built from the api's internal address (`INTERNAL_API_URL`), so nothing public depends on either path.
- Containers reach **only the egress proxy**, which allows: LiteLLM, the api's `/mcp` and `/git/`, and that user's allowlisted MCP domains. `github.com` itself is **not** allowed.
- The worker **never** talks to containers directly; it goes through the vm-manager's *Deliver*.
- The vm-manager's gRPC port is on the platform network only.

---

## 5. Backend: api + worker

### 5.1 api

- **Webhooks:** WhatsApp, Telegram, Sendblue, Clerk, Polar, Composio. Each one: verify → save the event (unique key) → add a job → 200. A chat webhook whose channel is switched off answers 200 and does nothing (section 0.3).
- **REST + SSE for the web app** (every endpoint, schema and error is in `openapi/openapi.yaml`): profile, link codes, channels (with the list of channels that are switched on), apps (Composio connect links), user MCP servers, approvals, chat history, **plans / checkout / credits balance / usage history / coupon redeem**, bring-your-own key, automations list.
- **Platform MCP (`/mcp`)**, called with the container token:

| Tool | Effect |
|---|---|
| send_message | Save → outbound job |
| request_approval | Save the approval → outbound job with buttons → returns "pending" |
| run_app_action | Call Composio with **the caller's user id** (forced from the token); plan limits on apps apply. A successful action that changes something costs **1 credit** (section 7.2); it is refused at zero credits |
| list_app_actions | This user's allowed actions (connected apps × plan), each marked with whether it needs approval and whether it costs a credit |
| schedule_reminder / create_automation / list / cancel | Save + register the timer (plan limits apply) |
| get_profile | Name, timezone, plan, connected apps |

Every call is audit-logged and triggers a vm-manager *Touch*. `/mcp` is closed to the internet (section 4).

- **App connections:** a connect link saves the connection as `pending`. Three things move it to `active` (or `expired` / `error`), whichever comes first:
  - Composio's webhook (`/webhooks/composio`),
  - the web app listing the apps, which asks Composio (this is also what happens when the browser lands on the connect return page, which is a web app page and not an api URL),
  - the **check-connection** job (section 5.2), so a connection finishes even with no webhook and no web app.

- **Git gateway (`/git/<owner>/<repo>`)**, called with the container token. It lets the agent work on a GitHub repo with normal git (clone, branch, commit, push) while the GitHub token stays on the platform:
  - The agent image's git config rewrites `https://github.com/` (and the ssh forms) to `http://api:8080/git/` and adds the container token as the `Authorization` header. So `git clone https://github.com/<owner>/<repo>` just works inside the container.
  - The api turns the container token into the user id (same as `/mcp`), takes that user's GitHub OAuth token from their **active Composio GitHub connection**, and forwards the three git smart-HTTP requests (`info/refs`, `git-upload-pack`, `git-receive-pack`) to `https://github.com/<owner>/<repo>.git`, streaming both ways. Nothing else under `/git/` is forwarded.
  - **The GitHub token never enters the container** (it is fetched per request, cached in memory for 60 s, never logged or stored). No GitHub connection → `403` with a message git prints.
  - **Push rules:** the agent may push branches, but a push that updates or deletes the repo's **default branch**, deletes any ref, or touches a tag is refused before it reaches GitHub. Changes reach the default branch through a pull request (opened with the GitHub app action via `run_app_action`).
  - Every clone/fetch/push is audit-logged (`git_fetch` / `git_push`, with the repo) and triggers a *Touch*. Per-user rate limit.
  - It is a protocol endpoint like `/mcp`, so it is described here and not in `openapi/openapi.yaml`; its errors are `text/plain` because that is what the git client shows. Like `/mcp`, it is closed to the internet (section 4).

- **Admin API** (admin role only): create or disable coupons, view users, credits and failed jobs; Bull Board.

### 5.2 worker jobs

| Job (queue) | What happens |
|---|---|
| process-message (inbound) | Take the lock → channel still on? (section 0.3) → **credit check** (section 7.5) → Jev: simple or task, apps, spam → simple: cheap model via LiteLLM → outbound; task: *WakeSandbox* → *Deliver* (stream until turn done) |
| process-approval (inbound) | Mark the approval → Wake + Deliver the answer |
| run-automation (scheduled → inbound) | Same as process-message with the saved instruction |
| composio-trigger (inbound) | Same as process-message with the event summary |
| send-outbound (outbound) | Send via the channel (24-hour rule → template). Nothing is sent to a channel that is switched off. On Telegram, purchase links are taken out (section 7.6) |
| create-sandbox / delete-sandbox (system) | LiteLLM key create/revoke + vm-manager Create/Delete |
| check-connection (system) | Added when a connect link is created. Asks Composio for the account's status 15 s later, then after 30 s, 1 min, 2 min, 4 min and 8 min (six checks in about 16 minutes). It stops as soon as the connection is no longer `pending`. Safe to re-run: it only copies Composio's status. After the last check a connection that is still pending is left as it is; the webhook or the app list can still finish it |
| sync-usage (system, every 5 min) | LiteLLM spend + vm-manager *GetUsage* → **charges** (section 7.4) → enforce zero balance |
| grant-monthly-credits (system) | On subscription renewal (Polar's paid renewal order) → a new monthly grant |
| expire-credits (system, hourly) | Expire grants past their end date |
| cleanup (system, daily) | Old events and messages, used link codes |
| backup (system, nightly) | Postgres dump + *SnapshotVolume* for every user → off-server |

**Job rules:** a per-user lock, 5 retries with backoff, a 15-minute turn timeout, and every step safe to repeat.

---

## 6. vm-manager (Go)

**Owns:** everything to do with Docker, plus the `sandboxes` table and the egress allowlists. Nothing else touches Docker.

**On CreateSandbox:**
- create the container from the current agent image + a /data volume
- create the container's **Platform MCP token** and **Bridge secret** (store only hashes)
- write the Hermes config (LiteLLM URL + the user's key, Platform MCP URL + token)
- write the egress allowlist
- leave it stopped

**Container settings:**
- gVisor runtime
- about 600 MB RAM, 1 CPU, a process-count limit, a disk quota
- read-only system files; only /data writable
- no extra privileges
- sandbox network only
- only its own secrets

**Background loops:**

| Loop | Every | Does |
|---|---|---|
| Idle reaper | 1 min | Stop containers not in a turn and quiet 3+ min (polite) |
| Capacity guard | on each wake | Over the **configurable awake cap** → stop the longest-idle, not-busy container |
| Health checker | 30 s | Awake but not answering → restart; repeated failures → mark broken + alert |
| Reconciler | startup + 5 min | Make Docker's real state match the `sandboxes` table |
| Image rollout | on a new image version | Re-create stopped containers on their next wake (keep /data) |

**Deliver flow:**
1. Check the container is awake (wake if not).
2. POST to the Bridge with the secret.
3. Relay the Bridge's progress as stream events.
4. On *turn done*, mark it not busy, record last active, and end the stream.

A timeout (15 min) ends in a force-stop and an error event.

---

## 7. Plans, credits and coupons

### 7.1 Plans

_Updated 2026-09-29 to match the pricing page: Max $30, automations 1 / 5 / 50, 90-day credits, waitlist offer; model tiers no longer advertised._
_Updated 2026-10-03 with the launch decisions (`docs/launch-plan.md`): AI three ways, 1 credit per app action that changes something, no purchase links on Telegram. Prices and credits are unchanged._

| | **Free** | **Pro** | **Max** |
|---|---|---|---|
| Price | $0 | **$12 / month** | **$30 / month** |
| Credits | **100 once at sign-up** + **coupon codes** | **1,500 every month** | **4,500 every month** |
| Buy top-ups | No (use coupon codes or upgrade) | Yes: $10 = 800 credits | Yes: $10 = 800 credits |
| Textcrew AI models (in code, not advertised) | Cheap model only | All models | All models |
| Priority | – | – | **Priority when things get busy** (queue + awake cap) |
| Apps (Composio) | 10 | All 25 | All 25 + **own MCP servers** |
| Automations | 1 | 5 | 50 |
| Bring your own key | ✓ | ✓ | ✓ |
| Awake cap priority | Lowest (stopped first when the server is full) | Normal | Highest |

**AI, three ways** (decided 2026-10-03, `docs/launch-plan.md` D4). A user picks one in the web app:

| # | Way | How it is shown | Runs | Who pays for the AI |
|---|---|---|---|---|
| 1 | **The user's own API key** | The default and the recommended choice | Hermes | The user, on their key (encrypted at rest). No AI charge in credits |
| 2 | **The user's Claude plan** | Labelled **beta**. Plain text "runs Claude Code"; no Anthropic names or logos beyond that | Claude Code, signed in by the user in their own container | The user, on their Claude plan. No AI charge in credits |
| 3 | **Textcrew AI** | Paid in credits | Hermes on a model we rent through a model API behind LiteLLM. No self-hosted model | Credits, at real cost × 2.5 (section 7.2). The plan decides which models (table above) |

- **Only the AI part is free with the user's own AI.** Awake time, app actions and paid tools are charged in credits whichever way is chosen.
- **First match wins:** a connected Claude plan with Claude Code chosen, then an own API key, then Textcrew AI.
- **`AI_ACCESS_MODE`:** `platform` offers Textcrew AI to a user who brought nothing. `own_only` switches Textcrew AI off; such a user is asked to connect their own AI first.
- Codex comes later.

**Waitlist offer:** waitlist members get **50% off their first month** of Pro ($6) or Max ($15), applied automatically at checkout (a Polar discount applied by id at checkout, once per waitlist entry, verified email only).

### 7.2 What a credit is and what costs credits

**1 credit = $0.01 of price.** Prices are about **2.5× our real cost**.

| Usage | Charge |
|---|---|
| Textcrew AI (via LiteLLM) | Real cost × 2.5, rounded up per turn. Not charged when the user brings their own AI (section 7.1) |
| Container awake time | 1 credit per 10 minutes awake |
| **App action that changes something** (send, create, update, delete) | **1 credit per successful action** |
| App action that only reads (get, list, search) | Free |
| Browser use | 2 credits per minute (Max plan, at launch; design in the crew package) |
| Paid tools (pay-per-use APIs) | Their cost × 2.5 |
| Jev routing, simple replies | Included in the AI cost |
| **Failed turns caused by us** (our bug or outage) | **Not charged**; the charge is reversed |

**App actions** (decided 2026-10-03, `docs/launch-plan.md` D6):

- **What counts as changing something.** Decided per action, in this order (`integrations/catalog.ts`):
  1. It needs approval (risky by name: send, delete, pay, share…) → it changes something.
  2. Its name has a write word (CREATE, ADD, UPDATE, SET, EDIT, MARK, UPLOAD, …) → it changes something.
  3. Its name has a read word (GET, LIST, SEARCH, FIND, FETCH, READ, QUERY, …) and no write word → it only reads. Free.
  4. Its name has neither: Composio's own `readOnlyHint` tag on the tool, when it is there → it only reads. Free.
  5. Anything else → it changes something. **An unknown action is charged.**
- **Only success is charged.** An action that Composio refuses or that fails costs nothing.
- **At zero credits** an action that changes something is refused before it runs. Reading still works.
- **A turn reversed as our fault** gives back the app-action credits charged during that turn, with the rest of the turn.
- **Everyone pays it,** including users on their own API key or Claude plan.

### 7.3 Grants: where credits come from, and expiry

Credits are held as **grants**. Each grant has an amount, **what's left of it**, a source and an expiry. Every change is also written to the **credit ledger** (append-only).

| Source | Amount | Expires |
|---|---|---|
| Sign-up | 100 | **90 days** after the grant |
| Coupon | Set per coupon | **90 days** after redemption (or the coupon's setting) |
| Monthly plan | 1,500 / 4,500 | **90 days** after the grant: unused monthly credits carry over |
| Top-up purchase | 800 per $10 | **90 days** after the grant |
| Admin adjustment | Any | 90 days, unless the admin sets another date |
| Refund / chargeback | Negative | – |

- **Balance** = the sum of what's left in all unexpired grants.
- **Every credit lasts 90 days from the day it's granted**, whatever the source.
- **Spending order:** always spend from the grant that **expires soonest** first (so the oldest credits go first), so users lose as little as possible.

### 7.4 Charging (how usage becomes charges)

1. **Every 5 minutes**, *sync-usage* reads new AI spend per user from LiteLLM and new awake periods from the vm-manager.
2. It turns them into credits (section 7.2) and writes **one charge per user per sync**, with a unique key per (user, period), so a re-run can't double-charge.
3. The charge is taken from grants in the spending order, and the ledger records each part.
4. **After each turn** (on *turn done*), the worker also does a quick sync for that user, so the balance stays fresh.
5. **App actions are charged when they run,** not by the sync: one charge of 1 credit per successful action that changes something, through the same grants and ledger. Each charge has its own unique key, so it can be written only once: the approval id when the action was approved (an approval is single use), otherwise an id made for that one run. The charge shows in the credit history (`App action: <name>`), in the activity log (`creditsCharged`) and in usage (`appActionCredits`).

### 7.5 Enforcing the balance

| Where | Check |
|---|---|
| **Before a turn** (process-message) | Balance > 0? If not → reply "out of credits" and where to top up, upgrade or redeem a coupon; no container wake. On Telegram the reply names the web app and carries **no link** (section 7.6); other channels get the billing link |
| **During a turn** | The user's **LiteLLM key budget = their current balance in dollars of real cost**. If they run out mid-turn, LiteLLM refuses → Hermes stops → "out of credits" |
| **Before an app action that changes something** | Balance > 0? If not → the tool tells the agent the user is out of credits and the action does not run |
| **At zero after a sync** | Set the LiteLLM budget to 0; pause automations |
| **When credits are added** (payment, coupon, monthly grant) | Raise the LiteLLM budget; un-pause automations |

A small negative balance (one turn's overrun) is allowed and recovered from the next grant.

### 7.6 Payments with Polar

- **On the website only** (decided 2026-10-03, `docs/launch-plan.md` D9). Plans and top-ups are bought in the web app. **The Telegram bot never sends a purchase link:** Telegram requires Telegram Stars for digital goods sold inside the app, and a bot that sells another way can be hidden from mobile users.
  - A message to Telegram that would carry a checkout, top-up, upgrade or billing link names the web app instead, with no URL: "Open the Textcrew web app to top up or upgrade".
  - As a safety net, the Telegram sender also replaces any purchase link in an outgoing text (the agent's own messages too) with "the Textcrew web app". A purchase link is a Polar URL, or a web app URL under `/billing`, `/pricing`, `/checkout`, `/upgrade`, `/plans`, `/topup` or `/subscribe`.
  - Other channels keep their links. Links that sell nothing (settings, linking a chat) stay on Telegram too.
- **Checkout:** web → api creates a Polar checkout session for the chosen plan or top-up (user id as `external_customer_id` and in the metadata) → Polar's hosted page.
- **Webhooks** (Polar event names):

| Event | Action |
|---|---|
| `subscription.active` (or the first `order.paid`) | Set plan → grant the monthly credits → raise the budget |
| `order.paid` for a renewal | New monthly grant (90 days); earlier monthly credits keep their own expiry |
| `subscription.canceled` → `subscription.revoked` | Plan kept until the end of the period → back to Free (credits already granted keep their 90-day expiry) |
| `order.paid` for a top-up | Top-up grant (800 credits per $10) |
| `refund.created` / `refund.updated` (succeeded) | Negative grant for the refunded share; if Polar refunded to prevent a chargeback, take back all of it and flag the account |

- **No double-crediting:** every webhook id is unique in `events`, and every grant's idempotency key comes from Polar's ids (order, refund, subscription + period).
- **Plan changes** take effect when Polar's webhook arrives, never from the web app directly.
- **Disputes:** Polar has no dispute webhook. Polar refunds many disputed payments itself before they become chargebacks; those arrive as refunds and are handled above. A dispute Polar does not refund is handled by hand (admin credit adjustment + flag).

### 7.7 Coupon codes (free top-up credits)

**What they're for:** you hand out free credits (to testers, friends, launch promos) without paying out of pocket for more than you choose.

**Admin creates a coupon** (admin API):
- campaign name, credits per redemption (e.g. 200), max total redemptions (e.g. 20), expiry date
- credit expiry after redemption (default 90 days), **cheap-model-only** flag (default on)
- optionally: new users only, or specific plans only
- optionally **generate N single-use codes** for one campaign

**The code is shown to the admin once.** Only its **hash** is stored, plus a short visible prefix (e.g. `AGT-7K…`) for the admin list.

**Code format:** 16+ random characters from an unambiguous alphabet (no 0/O, 1/I), grouped as `AGT-XXXX-XXXX-XXXX`. Generated with a secure random source.

**Redeem flow** (web app, or by sending the code in chat):
1. **Rate limit:** at most 5 attempts per user per hour and 20 per IP per hour, counted in Redis. Wrong codes count too.
2. **Eligibility:** email verified **and** at least one linked chat app. This stops fake-account farming.
3. Hash the code → find an **active, unexpired** coupon.
4. **In one database transaction:**
   - check `redeemed_count < max_redemptions`, and increase it atomically
   - insert the redemption; a **unique (coupon, user)** rule makes a second use impossible
   - create the grant (credits, 30-day expiry, cheap-model flag)
   - write the ledger entry
5. Raise the LiteLLM budget → reply with "+200 credits, expire on …".

**Security rules:**
- Every answer is the same generic "invalid or expired code" for wrong, expired, used-up or not-eligible codes, so attackers can't probe which codes exist.
- Admins can **disable a campaign instantly**. Credits already granted stay unless the admin chooses to revoke them.
- Every redemption goes into the ledger and the audit log (user, coupon, IP, time).
- **Abuse signals** (many accounts redeeming from one IP) are flagged for the admin.
- Coupon grants with the cheap-model flag can only pay for cheap-model AI, awake time and app actions. A Pro user's Claude usage draws from their other grants.
  - **Why app actions are allowed:** the flag exists to keep free credits away from expensive models. An app action is a fixed 1-credit platform charge like awake time, on every plan including Free, so any grant may pay it. If only normal grants could, a user holding only coupon credits would run up a debt with every action.

### 7.8 Free-budget control

- Your real spend on free users = sign-up credits + coupon credits, at real cost (≈ credits ÷ 2.5 ÷ 100 dollars).
- Example: $10/month of free AI ≈ 2,500 credits ≈ 25 sign-ups (100 each), or 12 coupon redemptions of 200.
- The admin view shows **"free credits granted this month"**, with an optional **monthly cap** that blocks new sign-up grants and coupon redemptions when reached.

---

## 8. Data model (tables and key fields)

| Module | Table | Key fields |
|---|---|---|
| auth | users | id, clerk_id, email_verified, name, timezone, plan, role (user/admin), created_at, deleted_at |
| auth | link_codes | code_hash, user_id, expires_at, used_at |
| auth | channel_links | user_id, channel (whatsapp/telegram/imessage), external_id (unique), last_inbound_at (for the 24 h rule) |
| events | events | id, source, external_id (unique with source), type, user_id, payload, status, created_at |
| channels | messages | id, user_id, channel, direction, text, media_ref, status, event_id |
| orchestrator | approvals | id, user_id, action_summary, status (pending/approved/rejected/expired), expires_at |
| integrations | connections | user_id, app, composio_account_id, status |
| integrations | user_mcp_servers | user_id, url, domain, auth_secret (encrypted), enabled |
| integrations | byok_keys | user_id, provider, key (encrypted) |
| automations | automations | id, user_id, kind (once/repeat/event), schedule/cron, timezone, trigger_ref, instruction, enabled, fail_count, next_run_at |
| billing | subscriptions | user_id, plan, polar_subscription_id, status, period_start, period_end |
| billing | credit_grants | id, user_id, source, amount, remaining, expires_at, cheap_model_only, ref (payment/coupon id) |
| billing | credit_ledger | id, user_id, grant_id, delta, reason (grant/charge/expire/refund/adjust), idempotency_key (unique), meta, created_at |
| billing | usage_periods | user_id, period_start, period_end, ai_cost, awake_seconds, credits_charged |
| billing | coupons | id, campaign, code_hash (unique), code_prefix, credits, max_redemptions, redeemed_count, expires_at, credit_expiry_days, cheap_model_only, new_users_only, active, created_by |
| billing | coupon_redemptions | coupon_id, user_id (**unique together**), ip, grant_id, created_at |
| admin | audit_log | id, user_id, actor (user/agent/admin/system), action, details, created_at |
| vm-manager | sandboxes | user_id, container_id, image_version, state (stopped/waking/awake/busy/broken), last_active_at, mcp_token_hash, bridge_secret_hash, allowlist, awake_log |

- Every user-owned query filters by user_id.
- Secrets use encrypted columns.
- **The `sandboxes` table belongs only to the vm-manager.** The backend reads its state through gRPC, never directly.

---

## 9. Build phases (hand these to the AI one at a time)

**How to use:** give the AI **one phase** plus this document. Each phase lists what to read, what to build, and **done when…** checks. Don't start a phase until the previous one's checks pass.

### Phase 0: Foundations
- **Read:** 1, 2, 3, 4
- **Build:**
  - repo structure (section 2)
  - `infra/docker-compose` for **local development**: Postgres, Redis, LiteLLM, Caddy and the egress proxy on the three networks from section 4
  - env/config loading and validation
  - lint, format and test setup; CI running them, **including a Redocly lint of `openapi/openapi.yaml`**
  - a script that copies the spec to `user-frontend/ignore/`
- **Done when:** `docker compose up` starts everything healthy; containers on the sandbox network can reach only the egress proxy (test it).

### Phase 1: Backend skeleton
- **Read:** 0.1, 0.2, 5, 8
- **Build:**
  - api (Hono) with health endpoint
  - **OpenAPI wiring:** TypeScript types generated from `openapi.yaml`, a request-validation middleware, the shared `Error` shape, and contract tests that check responses against the spec
  - Drizzle schema + migrations for **auth, events, channels, admin** tables
  - Clerk token check + `user.created` / `user.deleted` webhooks
  - generic webhook intake (verify → event → job)
  - BullMQ's 4 queues, worker process, per-user lock, retries, Bull Board (admin only)
- **Done when:**
  - every implemented route passes its contract test against `openapi.yaml`
  - a signed test webhook creates exactly one event and one job, even if sent twice
  - two jobs for the same user never run at the same time
  - a crashed job is retried

### Phase 2: vm-manager + agent image
- **Read:** 0.5, 0.6, 1.2 (gRPC), 6
- **Build:**
  - the proto contract
  - the Go gRPC service with every RPC
  - Docker + gVisor container spec
  - the `sandboxes` table
  - idle reaper, capacity guard, health checker, reconciler
  - egress allowlist writer
  - agent image: Hermes + Bridge (HTTP, secret-checked, reports turn done)
  - TypeScript client generated into the backend
- **Done when:**
  - Create → Wake → Deliver("hello") streams *turn_done*
  - it's stopped after 3 idle minutes and wakes again with memory intact
  - the capacity cap is respected
  - a container can't reach the internet except through allowed domains
  - **one container's measured RAM is recorded** in the README (used to set the awake cap)

### Phase 3: Telegram end to end
- **Read:** 0.1 (linking), 0.3 (Telegram notes), 5.2
- **Build:**
  - link codes
  - Telegram webhook + send
  - process-message → Wake → Deliver
  - Platform MCP with send_message + get_profile
  - outbound job
- **Done when:** a linked Telegram user chats with their own agent; an unlinked user only gets the link message; two users' agents never see each other's data.

### Phase 4: Platform MCP tools, Composio, approvals
- **Read:** 5.1, 0.5 (approvals)
- **Build:**
  - Composio connect links + webhook
  - run_app_action / list_app_actions with the forced user id
  - request_approval with Telegram buttons
  - the approval flow back into the agent
  - user MCP servers + allowlist updates
  - audit log
- **Done when:** "email X that…" drafts, asks for approval, sends only after ✅, and is audit-logged; a container can't act as another user even with a crafted request.

### Phase 5: Credits, plans, coupons, payments
- **Read:** 7 (all), 8 (billing tables)
- **Build:**
  - billing tables
  - sign-up grant
  - LiteLLM key per user with a budget
  - sync-usage + charging with spending order + idempotency
  - balance enforcement (before, during, at zero)
  - Polar checkout + webhooks (subscribe, renew, cancel, top-up, refund)
  - monthly grants + expiry jobs
  - **coupons**: admin create, redeem with every rule in 7.7 (endpoints `/v1/coupons/redeem` and `/v1/admin/coupons*` as in the spec)
  - plan limits (apps, automations, models)
  - bring-your-own key
- **Done when:**
  - usage lowers the balance correctly and re-running a sync doesn't double-charge
  - at 0 credits the agent stops and says so
  - Polar sandbox purchases add credits exactly once
  - **coupon tests pass:** a second redemption by the same user fails, the (max+1)th redemption fails even with 50 parallel attempts, expired and disabled codes fail with the generic message, the rate limit kicks in, unverified users can't redeem, and coupon credits expire after 90 days and pay only for the cheap model

### Phase 6: WhatsApp, media, Jev
- **Read:** 0.3, 5.2
- **Build:**
  - WhatsApp webhook + send + templates + the 24-hour rule
  - voice to text and media download
  - Jev routing (simple vs task, app pick, spam) with a fallback if Jev is down
- **Done when:** WhatsApp works like Telegram; a reminder 25 hours later arrives as a template; simple questions don't wake a container.

### Phase 7: Automations and reminders
- **Read:** 0.4
- **Build:**
  - `automations` table
  - schedule_reminder / create_automation / list / cancel tools
  - delayed and repeating jobs with timezones
  - Composio triggers
  - auto-pause rules
  - re-register on start
- **Done when:** once, repeating and app-event automations fire correctly across a worker restart and a Redis wipe, and pause at 0 credits.

### Phase 8: Hardening
- **Read:** 10
- **Build:**
  - nightly backups (Postgres + volumes) and a restore test
  - rate limits on public endpoints
  - structured logs + basic metrics and alerts
  - the admin views (failed jobs, free-credit spend, coupon abuse flags)
  - iMessage via Sendblue (if budget allows)
  - load test at the awake cap
- **Done when:** a restore from backup works; the load test holds the cap without failures; the security checklist in 10.2 is all ticked.

---

## 10. Failures and security

### 10.1 Failures

| Failure | Handling |
|---|---|
| Duplicate webhook | Unique event key → ignored |
| Worker crash | BullMQ re-runs; steps are safe to repeat |
| Container won't start | Retry → re-create from the image (keep /data) → broken + alert + user told |
| Server full | Stop the longest-idle container; else the job waits |
| LiteLLM / model down | Backup model → retry later → "delayed" message |
| Composio down | The tool returns an error to the agent; the user is told |
| vm-manager down | Wake/Deliver jobs retry with backoff; the rest keeps working |
| Jev down | Treat every message as a task (no routing shortcut) |
| Polar webhook late | Credits are added when it arrives; the web app shows "processing" |
| Redis lost | Rebuild jobs from `events`; re-register automations |

### 10.2 Security checklist
- [ ] Only Caddy is exposed; every other service is on the private networks from section 4; `/mcp` and `/git` answer 404 from outside
- [ ] Every webhook is verified before parsing and deduplicated
- [ ] The Docker socket is mounted **only** in the vm-manager
- [ ] Containers: gVisor, limits, read-only files, sandbox network, egress allowlist, only their own secrets
- [ ] No Composio/provider/database keys in containers; the Platform MCP forces the user id from the token
- [ ] No GitHub token in containers: git goes through the git gateway, which forces the user id from the container token and refuses pushes to the default branch
- [ ] Secrets encrypted in Postgres; tokens and codes stored as hashes
- [ ] Approvals before sending to others, deleting or paying; audit log for every action
- [ ] Coupon rules from 7.7; rate limits on redeem, link codes and login-linked endpoints
- [ ] Nightly off-server backups with a tested restore

> Hosting, server setup and sizing live in a separate doc, `docs/deployment.md`. They are not needed to write the code.
