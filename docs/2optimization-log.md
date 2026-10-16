# Optimization log 2 (from 16 October 2026): what changed in the backend and the vm-manager

This file records every change made to the backend and the vm-manager from 16 October 2026 on. It takes over from `1optimization-log.md`, which holds the entries before it and is no longer added to. The oldest entries are in `optimization-log.md`, also closed. Each change is written up by feature, in plain words, with no code. An entry says what changed and why, what it means for users and for cost, how it was checked, and where it is now.

Only the backend and the vm-manager are logged here. Changes made only to the web app's screens are not; the web app's README describes those.

This file does not replace the other docs. `hld-mvp.md` is still the design and `backend-report.md` still explains the logic. When a change alters how something works, those two files are updated as well, and the entry here says which sections.

## Contents

1. [In short](#1-in-short)
2. [How an entry is written](#2-how-an-entry-is-written)
3. [The log](#3-the-log)

---

## 1. In short

| | |
|---|---|
| **What it covers** | The backend (api and worker) and the vm-manager (the containers, the Bridge, the egress proxy) |
| **What it leaves out** | Changes made only to the web app's screens |
| **Started** | 16 October 2026. Earlier entries are in `1optimization-log.md` and `optimization-log.md` |
| **Order** | Newest change first |
| **Where the work goes** | Straight to `main` in each repo, once the checks pass |
| **How it reaches the server** | By running `/opt/textcrew/deploy.sh` on the server (see `aws-setup.md`, section 8) |

---

## 2. How an entry is written

Each entry has a heading with the date and the name of the feature, then the parts below. A part that does not apply is left out.

- **Where it is:** on `main` or on the test server, with the date it got there. This is updated as the change moves along.
- **Why:** the problem or the goal behind the change.
- **What the user notices:** what the backend or vm-manager change means for someone using Textcrew. "Nothing" is a fine answer for a change on the inside.
- **Backend:** what changed in the api or the worker, in words.
- **vm-manager:** what changed in the containers, the Bridge or the egress proxy, in words.
- **Cost and speed:** what the change does to our bills, to users' credits, to the memory a container uses, or to how fast a reply comes. Numbers when they were measured, and "not measured" when they were not.
- **Contracts:** whether the REST contract (`openapi.yaml`) or the contract with the vm-manager (`vm.proto`) changed. A changed contract means the web app or the backend has to follow.
- **Database:** new or changed tables, or "none".
- **How it was checked:** the tests added and their real results, and whether it has run on the test server.
- **Still open:** what is left to do, or what needs your decision.
- **Docs updated:** the sections of `hld-mvp.md`, `backend-report.md` and the vm-manager's docs that were changed.
- **Commits:** the short commit ids in the backend and the vm-manager, so the change can be found later.

---

## 3. The log

### 16 October 2026: Polar ready for real money, and Polar's account review prepared

- **Where it is:** on the branches `feat/polar-production` (backend), `feat/polar-portal` (web app), `feat/polar-review` and `legal/google-limited-use-and-terms` (landing page). Not on `main`, not on the server.
- **Why:** you asked for a proper Polar integration and for Polar's account review to be sent. Payments had only ever run in tests. Checked against Polar's documentation of 16 October (API version 2026-10, webhook events, signatures, refunds, failed payments, the customer portal, the account review and the acceptable use policy).
- **What was found:**
  - The integration was sound: the signature check (both kinds of Polar secret), the event saved once, credits from "order paid" given once, renewals only after payment, refunds and Polar's own anti-chargeback refunds, the waitlist discount, and our user id as Polar's customer id.
  - Missing: a way to Polar's billing page (card, invoices, receipts), so a user whose payment failed had no way to fix the card from the app; handling of a paused subscription (Polar has pausing; a paused plan stayed on); a guard against a free trial set on a product in Polar's dashboard; a clear answer when the server has no Polar token; and any check that Polar's real products match our prices.
  - In Polar's real account (`text-crew`): identity, payout account, description, website and support email are done; "Set up checkout" is not (no token, no webhook), so "Submit for review" cannot be pressed yet. The only product is "Text crew Pro Plan" at $6 a month (our Pro is $12; $6 is the waitlist's first month). There is no Max, no top-up and no discount. The description there is generic: it doesn't name Textcrew or its prices, and mentions a mobile app we don't have.
  - On the website: no contact email anywhere, no word on who handles payments or tax, the terms page not published, and no refund policy.
- **What the user notices:** Pricing has **Invoices and card**, which opens Polar's billing page; after a failed payment it reads **Update card**. The website shows `support@textcrew.in`, says payments go through Polar, that prices are in dollars with tax by country, and how to cancel.
- **Backend:**
  - `POST /v1/billing/portal` gives a signed-in link to Polar's billing page with a way back; 409 for someone who never bought anything, 503 when Polar does not answer.
  - A checkout or the billing page on a server with no Polar token says "payments are not set up yet" (503) instead of failing.
  - Checkouts switch free trials off, carry a back link to Pricing and pass the checkout's id back to the billing page.
  - `subscription.paused` ends the plan at once (Free); the paid month after `subscription.resumed` brings it back with its credits. A revoked plan is never brought back by a late event.
  - A payment is matched to a live account before a deleted one (someone who signed up again with the same email).
  - `polar-check`: a read-only check of the token, the three products and prices, the discount and the webhook endpoint against our plans. It prints no secret.
  - The switch from sandbox to real money is settings only; `.env.example` lists the token's scopes and the endpoint's settings.
- **Cost and speed:** none. One call to Polar when someone opens the billing page.
- **Contracts:** `openapi.yaml` has the new `POST /v1/billing/portal` and a 503 on the checkout. The web app follows on its branch.
- **Database:** none.
- **How it was checked:** the Polar tests: the billing page (link, 409, 503, 401), what the real HTTP client sends (version header, our user id, no trial, back link, `api.polar.sh` when the setting says production), a pause and a paid resume, a late event after a revoke, the deleted account, and the check (all OK, a wrong price, a missing event, a wrong discount, a price in two currencies, no token). Lint, types and the OpenAPI check pass. The full suite: 1,154 of 1,154 before the rebase on `main`; after it, 1,158 of 1,160, the two failures in `browser.test.ts` and `turn-billing.test.ts`, which this work does not touch and which pass when run alone (the known slowness under load). The web app: a click-through test of the button on a paid plan, after a failed payment, on Free and when Polar does not answer; lint, types, all tests and the build. The landing page: lint and build. Nothing has run against Polar's real system: there is no token there.
- **Still open:**
  - Your steps in Polar, the decisions (refund policy, the struck-out prices, moving between Pro and Max) and the terms page's blanks: `hld-mvp.md` section 12.
  - For "Describe what you sell" in the review, this text (from the website and these docs):

    > Textcrew (textcrew.in) is a personal AI assistant that people text from Telegram or the web app (app.textcrew.in). Each user gets their own agent, Tex, in a private, isolated workspace. Tex answers and does work in the apps the user connects (Gmail, Google Calendar, Notion, Slack, GitHub and others, each through its own sign-in), and hands parts of a job to specialists: Scout for web research and browsing, Byte for code changes delivered as GitHub pull requests, Patch for pull-request reviews. Anything that sends to other people, deletes or spends money waits for the user's approval. Users can also set up scheduled automations, such as a morning email summary.
    >
    > It is for individuals (founders, developers, busy professionals) who want an assistant that acts in their own accounts. Adults only. It is not a companion or relationship bot, does not generate images, video or voice, and does no outreach or bulk messaging: it only acts for the account owner, in their own apps.
    >
    > Pricing, in US dollars, paid through Polar: Free at $0 with 100 credits at sign-up; Pro at $12 a month with 1,500 credits a month; Max at $30 a month with 4,500 credits a month, browser use and the user's own MCP servers; a top-up of $10 for 800 credits on Pro and Max. Credits pay for the agent's running time, app actions and the built-in AI, and each lasts 90 days. Waitlist members get 50% off their first month. Access is automatic: our backend changes the plan and adds the credits as soon as Polar's webhook confirms the payment. Plans can be cancelled any time in the app and run to the end of the paid month.

    "What are you selling": Software / SaaS. "Pricing model": Subscription, and One-time purchase for the top-up.
- **Docs updated:** `hld-mvp.md` sections 7 ("Invoices, the card, and a failed payment"), 12 (built list, decisions, "Also waiting on you") and 13; `backend-report.md` section 28 (settings, checkout, which account, events, the billing page, failed payments, chargebacks, moving to real money).
- **Commits:** backend `6f0ea19` (contract), `0d929d7` (billing), then this docs commit. Web app `8668369`, `09b7cd9`. Landing page `39e52fe` (`feat/polar-review`) and `1fd5b30` (terms, on `legal/google-limited-use-and-terms`). The scratchpad script that puts the Polar settings on the server is not in a repo.

### 16 October 2026: only an automation's approvals go to Telegram

- **Where it is:** on `main` in the backend and the web app, and on the test server, since 16 October. The database change (migration 0031) is in.
- **Why:** the founder asked Tex something in the web app and got the approval question on Telegram as well. His words: "it should not. The approvals should be of automations to telegram and it can be turned off/on by user on the settings page." Until now every approval asked outside Telegram was copied there whenever Telegram was linked, with no switch.
- **What the user notices:** a question asked in the web app (web chat with Tex, Scout or Claude Code, a crew job or a pull-request review given there and its "run it again?", and "Run once now" on an automation) now waits in the web app only. A question asked by an automation's run (a timer or an app event, a pull-request review included) still goes to Telegram too, with the same Approve and Deny buttons, the first answer winning and quiet hours as before. Its last line now says "Asked by one of your automations. Tex carries on in the web app after your answer." Settings → General, "Tell me on Telegram when…" has a fourth switch, "An automation needs my OK", on at first; off, an automation's question waits in the Automations chat only. Work asked in a Telegram chat asks there, as before.
- **Backend:** the worker notes on each turn whose work it is: an automation's run, the turn after the user answers one of that run's questions, and a crew job that run started. An approval asked during such a turn keeps the automation's id, and so does a crew job started then; only those questions are copied to Telegram, and only while the switch is on. The note comes from the worker, never from what the agent says, and when it can't be read the question stays where it was asked. A test run ("Run once now") is the user's own, so it gets no note.
- **Cost and speed:** nothing measurable. Fewer Telegram messages for people who work in the web app.
- **Contracts:** `openapi.yaml` changed: `automationApprovals` in the Telegram notice settings of `GET /v1/me` and `PATCH /v1/me`, and the words on "Run once now". The web app has the same copy. `vm.proto` unchanged.
- **Database:** migration 0031 (`0031_automation_approvals`): a new switch on `users` (on at first), and the asking automation on `approvals` and on `crew_jobs` (empty for the user's own work, so nothing older changes).
- **How it was checked:** new automated tests: a web-chat approval sends nothing to Telegram; an automation run's approval goes to Telegram with its buttons, loses them once answered in the web app, and a late tap is refused; a denial on Telegram keeps the run's next question on Telegram too; with the switch off nothing goes; a test run's question stays in the web app; a question asked on Telegram is asked there once, whatever the switch; a crew job's "run it again?" follows who started the job; a crew job started during an automation's run is marked as that automation's, and one given in the web app is not. In the web app: the fourth switch is shown on at first, saves at once with a toast ("An automation needs my OK: off"), and a refused save is put back with an error toast. Backend: lint and type-check clean, the full suite 1147 tests in 98 files passed. Web app (rebased on its newest `main`): lint and type-check clean, 1012 tests in 81 files passed, the build passed. Not run on the test server, and no real Telegram message has gone through it yet.
- **Still open:** an automation made on a Telegram chat now follows the switch too: with it off, its questions wait in the Automations chat even though its answers go to Telegram. The other choice is to always send those to Telegram. A crew job started from a Telegram chat asks its "run it again?" in that chat, as before. The automations phase 4 branch also made a migration 0031: whichever reaches `main` second takes the next number.
- **Docs updated:** `hld-mvp.md` sections 5.3, 5.6 and 12; `backend-report.md` sections 10 ("Notices on Telegram"), 15 ("The same question on Telegram too"), 18 and 40; the web app's Help ("Hear on Telegram when work is done", "Approve in Telegram").
- **Commits:** backend `5345cc3` (contract), `e7829a5` (the change and migration 0031), `9efede8` (tests); web app `79b7355` (contract copy), `8ef8a83` (the switch and Help), `bad156c` (tests).
