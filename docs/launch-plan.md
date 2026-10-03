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
- **Web app repo:** `../user-frontend-web` has no GitHub remote, so it can't be pushed or deployed yet.

## 3. Work packages

| # | Package | Repos | Status |
|---|---|---|---|
| W1a | **Backend launch basics:** design doc and API contract first; channels setting (Telegram and web on, the rest off) exposed to the apps; 1 credit per changing app action; app connections no longer stuck on "pending"; no purchase links in Telegram; `/mcp` and `/git` blocked from the public internet; `system-design.md` and `build-report.md` updated | `beckend` | In progress (started 2026-10-03) |
| W1b | **Landing page copy:** Telegram and web only; Polar instead of Dodo; crew of four; three AI options; new credit wording; named apps; coding and PR-review use cases; roadmap | `landing-page` | In progress (started 2026-10-03) |
| W2a | **Web app update:** pull the new contract; Telegram-only linking; three AI choices; credit wording; crew page; installable on phones | `user-frontend-web` | Not started. Needs W1a and a GitHub remote |
| W2b | **Crew and PR review:** Byte, Patch and Scout defined once and passed to both engines; Scout's search, page reading and browser; activity shows who did what; the PR review flow with its endpoints | `beckend`, `vm-manager` | Not started. Needs W1a |
| W3a | **Shared memory** (D11) | `beckend`, `vm-manager` | Not started |
| W3b | **App jobs without a container** (D12) | `beckend` | Not started |
| W3c | **Web app screens** for PR review, crew and memory | `user-frontend-web` | Not started. Needs W2b and W3a |
| Ops | **On the server** (it is stopped; start it first): reconnect Gmail with the founder's Gmail account; first live run of the git gateway; add a model provider key; off-server backups and alerts; set up Polar; deploy the web app | server | Not started |

## 4. Rules for whoever continues

- **Read each repo's own `CLAUDE.md` first.** In `beckend`: the design doc and `openapi/openapi.yaml` change before code; tests with every change; `pnpm lint && pnpm typecheck && pnpm test` before calling anything done.
- **Use `pnpm`,** never `npx`. The path has spaces; quote it.
- **Small commits** with clear messages, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Pushing:** `beckend` and `vm-manager` work on `mvp-build`; push `origin mvp-build` and then `origin mvp-build:main` as a fast-forward. Never force-push. The founder has approved pushing to `main`.
- **The server deploys from `main`** only when `/opt/textcrew/deploy.sh` is run. A push alone changes nothing there. See `docs/aws-setup.md`.
- **Secrets** stay in `.env.deploy` (gitignored) and on the server. Never print them.
- **The founder's address for everything is his Gmail.** His work mailbox must not be used anywhere.
- **Docs to keep in step:** `docs/mvp-hld.md` (design), `docs/system-design.md`, `docs/build-report.md`, and this file's status table.
