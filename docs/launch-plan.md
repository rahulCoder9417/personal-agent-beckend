# Launch plan: decisions and work packages

Written 2026-10-03. This is the hand-off file. It records what the founder decided after the market research (`docs/market-and-mvp.md`), the work that follows from it, and where each piece stands. A new session should read this file first, then `docs/mvp-hld.md`.

Keep the status table in section 3 current: update it in the same commit as the work.

## 1. Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | **Audience** | Developers and tech founders who manage a team. First target: pull-request review for a founder's repos (a real lead exists) |
| D2 | **Channels at launch** | Telegram and the web app. Phone users use Telegram plus the web app's phone layout. No Play Store or App Store app |
| D3 | **Channels switched off** | WhatsApp, iMessage and SMS. The code stays and is turned off by a setting. iMessage (Sendblue, $100 a month per number) may come later as a labelled beta. WhatsApp only for EEA users, later |
| D4 | **AI, three ways** | (1) The user's own API key: the default and recommended path. (2) The user's Claude plan, labelled beta; in plain text "runs Claude Code", no Anthropic logos. (3) Textcrew AI, paid in credits, rented through a model API behind LiteLLM. No self-hosted model. Codex comes later |
| D5 | **Plans** | Free $0 with 100 credits once. Pro $12 a month with 1,500 credits. Max $30 a month with 4,500 credits. Top-up $10 for 800 credits. Every credit lasts 90 days. Unchanged |
| D6 | **What costs credits** | Textcrew AI at real cost × 2.5. Container awake time at 1 credit per 10 minutes. **1 credit per app action that changes something** (send, create, update, delete); reading and searching in apps are free. **A web search through Textcrew (Brave): 1 credit** (decided 2026-10-04; Max plan, D7). Browser use at 2 credits per minute, on the Max plan (D10). Reading a web page (`read_page`) is free. The web search built into the user's own Claude Code or Codex costs no credits. Any other paid tool at cost × 2.5. With the user's own AI, the AI part is not charged; the rest is |
| D7 | **Crew** | Tex (lead, the one you text), Byte (coding), Patch (code review, runs several reviewers), Scout (research: searches the web, reads pages, and on Max drives a real browser). Echo, Pitch and Tock are dropped. **Web search is done by Scout only** (decided 2026-10-04). **Which search:** when the user's engine has its own web search (Claude Code on the user's Claude plan today; Codex later), Scout uses that and the platform is not involved. Otherwise Scout uses the platform's `web_search`, backed by Brave. **Scout's two platform services, Brave web search and the real browser, are Max-plan features only:** on Free and Pro `web_search` refuses with a clear message. Reading a page works on every plan |
| D8 | **PR review flow** | A pull request opens → Patch's reviewers look at it (bugs, security, tests) → comments on the PR → a short verdict on Telegram → Byte can fix what was found. Teams use an API key for this, not one person's Claude plan |
| D9 | **Payments** | Polar, on the website only. The Telegram bot never sends a purchase link (Telegram requires Stars for sales inside the app) |
| D10 | **Browser use** | Max plan, at launch (2 credits per minute). **Logins are allowed** (decided 2026-10-04): the user signs in to a site themselves, and the agent never sees the password. Design decision open: a browser inside each user's container, or a hosted browser service driven by platform tools |
| D11 | **Memory** | One memory on the platform, shared by every engine, with remember and recall tools |
| D12 | **No container when it isn't needed** | Simple chat on a cheap model (built, needs a key) and app jobs run in the worker (to build). Containers are for coding, files and long jobs |
| D13 | **Not doing** | A self-hosted model, document search (RAG), phone calls, six specialists, store apps |

## 2. Still to decide or supply (founder)

- **Textcrew AI:** which models to offer, and whether 2.5× is the right markup.
- **Legal pages:** the terms page and the privacy update need the company's legal name, address and governing law.
- **Anthropic:** accept the Commercial Terms and ask sales to confirm the hosted Claude Code setup in writing (`docs/market-and-mvp.md` section 6.5).
- **Google:** start verification of our own OAuth app; the shared Composio app is capped at 100 Gmail users.
- **Polar:** create the account, products, discount and webhook.
- **Browser for Scout (D10):** a browser inside each user's container, or a hosted browser service. The proposal is written (`docs/mvp-hld.md` section 11) and recommends a hosted browser driven by platform tools, starting on Browserbase's Developer plan ($20 a month for 100 hours, then $0.12 an hour; Steel at $0.10 an hour with no monthly fee is the fallback). Decided 2026-10-04: logins are allowed, and the user signs in themselves (section 11.6 says what that needs: a view of the browser session to sign in through, and where the session cookies live for each option). To decide: which option; if hosted, which provider and who opens the account; how far Scout may type into pages; and for logins, how long a sign-in is kept, which sites are allowed, what Scout may do on a signed-in site without asking, and whether the minutes the user spends signing in are charged.
- **Search provider for Scout:** Brave is built. To supply: a **Brave Search API key** (the "Search" plan: $5 per 1,000 searches, with $5 of free credit a month; `BRAVE_SEARCH_API_KEY` on the server). Until then `web_search` tells the agent that search isn't set up. Another provider can be added behind the same interface. A search is sold for 1 credit ($0.01) and Brave bills $0.005 for it once the free credit is used: 2× its cost, not the usual 2.5×.
- **Pull-request review:** the GitHub account the user connects needs admin access to a repo before review can be turned on for it (Composio puts a webhook on the repo). On the Composio project, "mask connected account secrets" must be off, as for the git gateway.
- **`read_page` and redirects:** it opens only an address already seen for the user, and refuses a redirect to an address that wasn't seen, on the same site too. To decide after the first live runs: keep that, or allow redirects within the same site.
- **`read_page` after an engine's own search** (open since 2026-10-04): on Claude Code, Scout searches with the engine's built-in search. Those results never pass through the platform, so they are not "seen" addresses and `read_page` refuses them: Scout can search but can only read a page the user named, or one linked from such a page. To decide: may `read_page` open an address it hasn't seen when the user's engine is Claude Code? That would reopen, for those users, the way out the seen-address rule closes (`docs/mvp-hld.md` section 5.1). `read_page`'s rules are unchanged until this is decided.
- **`CREW_AVAILABLE` on the server:** which specialists the apps show as available. Set it to match the agent image that is deployed.
- **Waitlist form:** it still asks "WhatsApp / Telegram / iMessage". Keep it as a demand signal, or change it.

## 3. Work packages

| # | Package | Repos | Status |
|---|---|---|---|
| W1a | **Backend launch basics:** design doc and API contract first; channels setting (Telegram and web on, the rest off) exposed to the apps; 1 credit per changing app action; app connections no longer stuck on "pending"; no purchase links in Telegram; `/mcp` and `/git` blocked from the public internet; `system-design.md` and `build-report.md` updated | `beckend` | **Done 2026-10-03.** Not deployed: the server is stopped, and the Caddy rule has not been tried against a live Caddy |
| W1b | **Landing page copy:** Telegram and web only; Polar instead of Dodo; crew of four; three AI options; new credit wording; named apps; coding and PR-review use cases; roadmap; Scout's browser on Max | `landing-page` | **Done 2026-10-03, live on textcrew.in.** Left as is: the waitlist form's channel question, Scout's "Soon" label, the trust line about the sandbox reaching only approved services, the privacy page's line about providers not training on API data |
| W2a | **Web app update:** channels from the API (Telegram-only linking); three AI choices; credit wording with app actions in the usage chart; crew page; installable on phones | `user-frontend-web` | **Done 2026-10-03,** pushed to `main` of `personal-agent-web-frontend`. Viewed in demo mode only. Not deployed, and never run against the real backend or on a real phone |
| W2b-1 | **Crew on the platform side, and PR review:** the PR review flow (D8); Scout's `web_search` and `read_page` platform tools; the crew list for the apps; crew progress in chat; the API gaps found by W2a (choosing Textcrew AI, browser credits split from paid tools, browser use in Max's features); a browser proposal with prices (no browser code) | `beckend` | **Done 2026-10-04,** on `main`. Lint, type check and all tests pass. Added while finishing: `read_page` opens only an address already seen for the user (their own messages, a search result, a link on a page already read), so it can't be used to send data out. Not deployed, and never run against the real Composio, GitHub, Brave or the open internet: the Composio trigger and the four GitHub action names of the review permission are unchecked, and there is no search key yet |
| W2b-2 | **Crew in the agent image:** Byte, Patch and Scout defined once in the Bridge and given to both engines; the lead's instructions; progress lines | `vm-manager` | **Done 2026-10-04.** `vm-manager` `main` is at `a880060`. On Claude Code, Scout has exactly `web_search` and `read_page` and no file access. 88 Bridge tests and the Go tests pass. Untested on a real CLI, Hermes or Docker. On Hermes, Scout's tool limits are instructions only (the pinned Hermes has no tool list per delegated task) |
| W2c | **Scout's browser** (D10), after the founder picks the option proposed in W2b-1. Navigation needs the same seen-address rule as `read_page`, and typing into pages needs its own limit (`docs/mvp-hld.md` section 11.5). Logins are allowed, with the user signing in themselves (section 11.6) | `beckend`, `vm-manager` | Not started |
| W2d | **Search and browser decisions of 2026-10-04, platform side** (D6, D7, D10): `web_search` is part of the Max plan and refuses on Free and Pro; a search costs exactly 1 credit; Max's feature list and Scout's description say so; the design doc records who searches and with what, and that the browser allows logins | `beckend` | **Done 2026-10-04,** on `main`. Lint, type check and all tests pass (38 files, 396 tests). No change to the API's shape, no migration, no new setting; the activity log has a new action, `web_search_refused`. The 1 credit comes from the setting `WEB_SEARCH_COST_USD`, now 0.004 by default (× 2.5 = one credit). What it means: on Free and Pro with Hermes (own API key or Textcrew AI) Scout can't search the web; it can read a page the user names. Not deployed. Which search Scout is given on each engine is the agent image's side (`vm-manager`), a separate package |
| W3a | **Shared memory** (D11) | `beckend` | **Done 2026-10-04,** on `main`. Backend only: `vm-manager` and the proto did not change. One memory on the platform (table `memories`, owned by the orchestrator); the tools `remember`, `recall` and `forget` for both engines; what is known about the user at the top of every delivered turn; a recap of the chat when the engine changes; endpoints to list and delete. Lint, type check and all tests pass (38 files, 388 tests). Not deployed, and never run on a real Hermes or Claude Code: how an engine reads the block, and whether it saves with `remember` rather than its own memory, is unchecked. Design: `docs/mvp-hld.md` section 0.9. What the web app needs and what the founder decides: under this table |
| W3b | **App jobs without a container** (D12) | `beckend` | Not started. Proposed to wait until there is load: it only saves container time, and the simple-chat path that is already built needs just a key |
| W3c | **Web app screens** for PR review, crew and memory, and the new fields from W2b-1 | `user-frontend-web` | **Done 2026-10-04,** on `main` of `personal-agent-web-frontend`: the crew page from the API, pull-request review (a tab under Automations), choosing Textcrew AI, the usage split, crew in chat and activity, and Settings → Memory. 191 tests pass. Viewed in demo mode only; never run against the real backend, real sign-in or a phone. Gaps it found in the contract are listed under "Follow-ups" below |
| Ops | **On the server** (it is stopped; start it first): reconnect Gmail with the founder's Gmail account; first live run of the git gateway; add a model provider key; add a Brave Search key; first live run of pull-request review (the Composio trigger, the four GitHub action names, one review per pull request) and of `web_search` (as a Max user: 1 credit; as a Free or Pro user: the refusal) and `read_page`; make sure the server's settings don't still say `WEB_SEARCH_COST_USD=0.005`; first live run of shared memory (a fact saved on one engine and used on the other, and the recap after a switch); off-server backups and alerts; set up Polar; deploy the web app | server | Not started |

### Memory screen: what the web app needs (from W3a)

All three need the Clerk session, like every `/v1` route. The contract is `openapi/openapi.yaml` (tag `memory`).

| Call | Answer |
|---|---|
| `GET /v1/memories` | `200 { items: Memory[], max: number }`. Every memory, newest first, in one answer (no cursor). `max` is 200 |
| `DELETE /v1/memories/{memoryId}` | `204`. `404` if it isn't this user's |
| `DELETE /v1/memories` | `200 { deleted: number }`. Removes all; can't be undone |

- **`Memory`:** `{ id, kind, content, createdAt, updatedAt, lastUsedAt, useCount }`.
  - `kind`: `preference`, `person`, `project`, `instruction` (a standing instruction) or `fact`.
  - `content`: one line of plain text, at most 300 characters.
  - `updatedAt`: when the agent last corrected the text; equal to `createdAt` if never.
  - `lastUsedAt` (a time or null) and `useCount`: when and how often the agent found it with a search.
- **There is no call to add or edit a memory.** The user tells the agent ("remember that…", "that's wrong, it is…").
- **No live event for memory.** Fetch the list when the screen opens, and again when a turn ends (`agent.status` goes back to `awake`).
- **Full:** when `items.length` reaches `max`, the agent can't save more until some are deleted. Say so on the screen.
- **Activity log** (`GET /v1/activity`): entries can carry `memoryId` (a string or null). New actions: `remember`, `recall`, `forget`, `memory_refused` (by the agent), `memory_deleted`, `memories_cleared` (by the user). **An entry never holds the memory's text.** To show it, look `memoryId` up in the list; the memory may be gone.

### Shared memory: for the founder to decide

- **Saves in turns the user didn't start.** An app event (an email, a pull request) or a scheduled automation can run with nobody watching, and the agent can save a memory in it. Refusing saves in those turns would close the most likely way a planted "fact" gets in. It would also stop "remember what this email says". Not built.
- **Adding and editing from the web app.** Today the user can only list and delete; every memory is made by the agent.
- **No memory text in the activity log.** The log says a memory was saved, corrected or removed, and which one; the text is only in the memory list, so a delete really removes it. The cost: after a delete the log can't show what was there.
- **The activity log after an account is deleted.** It is kept (this is not new). It holds no memory text, but it holds other summaries, such as approval texts and search queries. Delete it with the account?
- **The limits:** 200 memories of 300 characters on every plan; 2,000 characters of memory on each turn (about 500 tokens of the user's AI per turn at most).
- **The agent image** (`vm-manager`, not changed): the lead's instructions don't mention memory, and Hermes still has its own memory tool, so facts can end up in two places. One line in the Bridge's instructions, and perhaps switching Hermes's own memory off, would settle it.
- **Simple chat.** A reply from the cheap model (no container) is not shown to the engine afterwards, as before. The recap could carry those messages too.

### Follow-ups found while building

Small gaps between what the web app's screens want and what the API offers. None blocks the launch.

- **Pull-request review:** no history of past reviews, no verdict or failure reason on a review, no list of the user's repos to pick from, and no check for admin access before turning review on.
- **Automations:** a review automation doesn't carry its repo (the web app joins it with `/v1/pr-reviews` by id).
- **Credit ledger:** entries have no charge kind, so "Web search" is recognised by its name.
- **Progress:** only live progress lines carry the crew member, and progress isn't replayed after a page reload.
- **Memory:** `forget` doesn't say whether it removed or corrected; there is no add or edit from the web app and no live event.
- **Web app:** the usage chart's first date label overlaps at phone width (older issue).

### Deploy order

Deploy `beckend` and `vm-manager` together (`/opt/textcrew/deploy.sh` does). The agent image now gives Scout the tools `web_search` and `read_page`; with an older backend those tools don't exist and Claude Code won't start Scout.

Shared memory (W3a) adds the migration `0011_shared_memory` (`deploy.sh` applies it) and needs no new setting and no new agent image.

The search decisions (W2d) need no migration and no new setting. Two things to watch:

- **The price is a setting.** `WEB_SEARCH_COST_USD` is now 0.004 by default, which is 1 credit a search. If the server's settings file has the old line `WEB_SEARCH_COST_USD=0.005`, a search costs 1.25 credits again. Remove the line or set 0.004.
- **Deploy with the agent image that gives Scout its engine's own search.** With an older image, Scout on Claude Code has only the platform's `web_search`, so a Free or Pro user on Claude Code gets the Max refusal and can't search at all.

## 4. The crew: shared design for W2b

Both W2b packages build against this. The design doc (`docs/mvp-hld.md`) gets the full version in W2b-1.

- **Members:** Tex is the lead (the agent the user texts). The specialists are `byte` (coding), `patch` (code review) and `scout` (research). These ids are fixed.
- **Where they are defined:** once, in the Bridge inside the agent image (`vm-manager`), with a description, a role prompt and a tool list each. The same definitions serve both engines. No change to the gRPC proto.
- **Claude Code:** the definitions are passed as sub-agents, and only the lead may start them. A specialist can't start its own helpers.
- **Hermes:** the lead gets the same role prompts to use with its built-in delegation, one level deep.
- **How many at once:** at most 3 specialists per job to start with.
- **Tools:** Byte gets files, shell and git (through the git gateway) plus the platform tools. Patch gets read access to the code, shell for running tests and diffs, and the platform tools for commenting. Scout gets one web search (its engine's own, or the platform's `web_search`: see "Web search" below), the platform tool `read_page` (and the browser later); no shell and no app actions, so a web page can't make it send or delete anything.
- **Progress lines:** when a specialist starts or finishes, the Bridge sends a progress event whose text starts with the member's name and a colon, for example `Scout: reading 4 pages`. The backend passes these to the chat.
- **Scout's tools run on the platform,** not in the container: `web_search(query)` and `read_page(url)` on the Platform MCP. The container's network stays locked.
- **Web search** (decided 2026-10-04): only Scout searches. When the user's engine has its own web search (Claude Code on the user's Claude plan today; Codex later), Scout uses that: the platform is not involved, it costs no credits and it works on every plan. Otherwise Scout uses the platform's `web_search` (Brave), which is part of the Max plan and costs 1 credit per search. On Free and Pro the platform's tool refuses with a message that tells the agent so. The agent image decides which search Scout is given and who may call it; the platform only checks the plan.
- **`read_page` opens only an address already seen for the user** (added 2026-10-04): one in the user's own messages, a `web_search` result, or a link on a page already read, and the same at every redirect. Otherwise an injected instruction could make an agent fetch a made-up address with the user's data in it. On Hermes a specialist's tool list is only an instruction, so this platform check is the control that holds on both engines. The browser's navigation will need the same rule.
- **PR review (D8):** turned on per repo by the user. Turning it on is the standing permission for Patch to comment on pull requests in those repos; everything else risky still needs approval. Patch never merges, and the git gateway already refuses pushes to the default branch. One review per pull-request head commit. The permission covers four GitHub actions by exact name, and the review instruction carries no text from the pull request.

## 5. Rules for whoever continues

- **Read each repo's own `CLAUDE.md` first.** In `beckend`: the design doc and `openapi/openapi.yaml` change before code; tests with every change; `pnpm lint && pnpm typecheck && pnpm test` before calling anything done.
- **Use `pnpm`,** never `npx`. The path has spaces; quote it.
- **Small commits** with clear messages, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Pushing:** `beckend` and `vm-manager` work on `mvp-build`; push `origin mvp-build` and then `origin mvp-build:main` as a fast-forward. Never force-push. The founder has approved pushing to `main`.
- **The server deploys from `main`** only when `/opt/textcrew/deploy.sh` is run. A push alone changes nothing there. See `docs/aws-setup.md`.
- **Secrets** stay in `.env.deploy` (gitignored) and on the server. Never print them.
- **The founder's address for everything is his Gmail.** His work mailbox must not be used anywhere.
- **Docs to keep in step:** `docs/mvp-hld.md` (design), `docs/system-design.md`, `docs/build-report.md`, and this file's status table.
