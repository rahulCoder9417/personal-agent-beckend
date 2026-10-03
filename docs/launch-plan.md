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
| D6 | **What costs credits** | Textcrew AI at real cost × 2.5. Container awake time at 1 credit per 10 minutes. **New: 1 credit per app action that changes something** (send, create, update, delete); reading and searching are free. Browser use at 2 credits per minute, on the Max plan at launch (D10). Paid tools at cost × 2.5. With the user's own AI, the AI part is not charged; the rest is |
| D7 | **Crew** | Tex (lead, the one you text), Byte (coding), Patch (code review, runs several reviewers), Scout (research: searches the web, reads pages, and on Max drives a real browser). Echo, Pitch and Tock are dropped |
| D8 | **PR review flow** | A pull request opens → Patch's reviewers look at it (bugs, security, tests) → comments on the PR → a short verdict on Telegram → Byte can fix what was found. Teams use an API key for this, not one person's Claude plan |
| D9 | **Payments** | Polar, on the website only. The Telegram bot never sends a purchase link (Telegram requires Stars for sales inside the app) |
| D10 | **Browser use** | Max plan, at launch (2 credits per minute). Design decision open: a browser inside each user's container, or a hosted browser service driven by platform tools |
| D11 | **Memory** | One memory on the platform, shared by every engine, with remember and recall tools |
| D12 | **No container when it isn't needed** | Simple chat on a cheap model (built, needs a key) and app jobs run in the worker (to build). Containers are for coding, files and long jobs |
| D13 | **Not doing** | A self-hosted model, document search (RAG), phone calls, six specialists, store apps |

## 2. Still to decide or supply (founder)

- **Textcrew AI:** which models to offer, and whether 2.5× is the right markup.
- **Legal pages:** the terms page and the privacy update need the company's legal name, address and governing law.
- **Anthropic:** accept the Commercial Terms and ask sales to confirm the hosted Claude Code setup in writing (`docs/market-and-mvp.md` section 6.5).
- **Google:** start verification of our own OAuth app; the shared Composio app is capped at 100 Gmail users.
- **Polar:** create the account, products, discount and webhook.
- **Browser for Scout (D10):** a browser inside each user's container, or a hosted browser service. A proposal with prices is part of W2b.
- **Search provider for Scout:** which one, and its API key.
- **Waitlist form:** it still asks "WhatsApp / Telegram / iMessage". Keep it as a demand signal, or change it.

## 3. Work packages

| # | Package | Repos | Status |
|---|---|---|---|
| W1a | **Backend launch basics:** design doc and API contract first; channels setting (Telegram and web on, the rest off) exposed to the apps; 1 credit per changing app action; app connections no longer stuck on "pending"; no purchase links in Telegram; `/mcp` and `/git` blocked from the public internet; `system-design.md` and `build-report.md` updated | `beckend` | **Done 2026-10-03.** Not deployed: the server is stopped, and the Caddy rule has not been tried against a live Caddy |
| W1b | **Landing page copy:** Telegram and web only; Polar instead of Dodo; crew of four; three AI options; new credit wording; named apps; coding and PR-review use cases; roadmap; Scout's browser on Max | `landing-page` | **Done 2026-10-03, live on textcrew.in.** Left as is: the waitlist form's channel question, Scout's "Soon" label, the trust line about the sandbox reaching only approved services, the privacy page's line about providers not training on API data |
| W2a | **Web app update:** channels from the API (Telegram-only linking); three AI choices; credit wording with app actions in the usage chart; crew page; installable on phones | `user-frontend-web` | **Done 2026-10-03,** pushed to `main` of `personal-agent-web-frontend`. Viewed in demo mode only. Not deployed, and never run against the real backend or on a real phone |
| W2b-1 | **Crew on the platform side, and PR review:** the PR review flow (D8); Scout's `web_search` and `read_page` platform tools; the crew list for the apps; crew progress in chat; the API gaps found by W2a (choosing Textcrew AI, browser credits split from paid tools, browser use in Max's features); a browser proposal with prices (no browser code) | `beckend` | **Paused 2026-10-03, about half done.** On `mvp-build` (not on `main`, checks not confirmed): the design doc, the contract, choosing Textcrew AI, the usage split, browser use in Max's features, the crew list and crew progress lines. Unfinished and uncommitted in the working tree, backed up on branch `wip/w2b-1`: the PR review flow. Not started: Scout's `web_search` and `read_page`, the docs update |
| W2b-2 | **Crew in the agent image:** Byte, Patch and Scout defined once in the Bridge and given to both engines; the lead's instructions; progress lines | `vm-manager` | **Paused 2026-10-03, mostly done.** On `mvp-build` (not on `main`, checks not confirmed): the crew definitions, the lead's instructions, Claude Code sub-agents with progress lines, Hermes delegation. Left: the README (in the working tree, backed up on branch `wip/w2b-2`), the build report, the final test run |
| W2c | **Scout's browser** (D10), after the founder picks the option proposed in W2b-1 | `beckend`, `vm-manager` | Not started |
| W3a | **Shared memory** (D11) | `beckend`, `vm-manager` | Not started |
| W3b | **App jobs without a container** (D12) | `beckend` | Not started |
| W3c | **Web app screens** for PR review, crew and memory, and the new fields from W2b-1 | `user-frontend-web` | Not started. Needs W2b-1 and W3a |
| Ops | **On the server** (it is stopped; start it first): reconnect Gmail with the founder's Gmail account; first live run of the git gateway; add a model provider key; off-server backups and alerts; set up Polar; deploy the web app | server | Not started |

### Resuming W2b

Both agents were stopped mid-task so the laptop could be closed. Nothing was lost.

- **Finished commits** are on `mvp-build` in both repos and pushed there. `main` was left alone, because lint, type check and tests were not confirmed after the last commits. The server deploys from `main`, so it is unaffected.
- **Unfinished work** is still in each working tree as uncommitted changes, and a copy is pushed on `wip/w2b-1` (`beckend`) and `wip/w2b-2` (`vm-manager`). If a working tree is ever clean, restore it with `git cherry-pick -n wip/w2b-1 && git reset` (or `wip/w2b-2`).
- **To continue:** first run each repo's checks on what is committed. Then finish the package from its task list (the briefs are summarised in the table above), with proper commits, and only then fast-forward `main`. Delete the `wip/` branches when their work has landed.

## 4. The crew: shared design for W2b

Both W2b packages build against this. The design doc (`docs/mvp-hld.md`) gets the full version in W2b-1.

- **Members:** Tex is the lead (the agent the user texts). The specialists are `byte` (coding), `patch` (code review) and `scout` (research). These ids are fixed.
- **Where they are defined:** once, in the Bridge inside the agent image (`vm-manager`), with a description, a role prompt and a tool list each. The same definitions serve both engines. No change to the gRPC proto.
- **Claude Code:** the definitions are passed as sub-agents, and only the lead may start them. A specialist can't start its own helpers.
- **Hermes:** the lead gets the same role prompts to use with its built-in delegation, one level deep.
- **How many at once:** at most 3 specialists per job to start with.
- **Tools:** Byte gets files, shell and git (through the git gateway) plus the platform tools. Patch gets read access to the code, shell for running tests and diffs, and the platform tools for commenting. Scout gets only the platform tools `web_search` and `read_page` (and the browser later); no shell and no app actions, so a web page can't make it send or delete anything.
- **Progress lines:** when a specialist starts or finishes, the Bridge sends a progress event whose text starts with the member's name and a colon, for example `Scout: reading 4 pages`. The backend passes these to the chat.
- **Scout's tools run on the platform,** not in the container: `web_search(query)` and `read_page(url)` on the Platform MCP. The container's network stays locked.
- **PR review (D8):** turned on per repo by the user. Turning it on is the standing permission for Patch to comment on pull requests in those repos; everything else risky still needs approval. Patch never merges, and the git gateway already refuses pushes to the default branch. One review per pull-request head commit.

## 5. Rules for whoever continues

- **Read each repo's own `CLAUDE.md` first.** In `beckend`: the design doc and `openapi/openapi.yaml` change before code; tests with every change; `pnpm lint && pnpm typecheck && pnpm test` before calling anything done.
- **Use `pnpm`,** never `npx`. The path has spaces; quote it.
- **Small commits** with clear messages, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Pushing:** `beckend` and `vm-manager` work on `mvp-build`; push `origin mvp-build` and then `origin mvp-build:main` as a fast-forward. Never force-push. The founder has approved pushing to `main`.
- **The server deploys from `main`** only when `/opt/textcrew/deploy.sh` is run. A push alone changes nothing there. See `docs/aws-setup.md`.
- **Secrets** stay in `.env.deploy` (gitignored) and on the server. Never print them.
- **The founder's address for everything is his Gmail.** His work mailbox must not be used anywhere.
- **Docs to keep in step:** `docs/mvp-hld.md` (design), `docs/system-design.md`, `docs/build-report.md`, and this file's status table.
