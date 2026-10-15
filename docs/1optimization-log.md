# Optimization log (from 14 October 2026): what changed in the backend and the vm-manager

This file records every change made to the backend and the vm-manager from 14 October 2026 on. It takes over from `optimization-log.md`, which holds the entries before it and is no longer added to. Each change is written up by feature, in plain words, with no code. An entry says what changed and why, what it means for users and for cost, how it was checked, and where it is now.

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
| **Started** | 14 October 2026. Earlier entries are in `optimization-log.md` |
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

### 15 October 2026: a turn's billing runs after the reply, and the next message no longer waits for it

- **Where it is:** on `main`, not yet on the server.
- **Why:** you asked why the billing has to be done before the user can go on, above all for a user on their own Claude plan: "the user can get the reply and in the background we can run the checks for billing". Measured before this change: after the reply was shown, the turn still made 20 trips to the database, 19 of them one after another (5.0 seconds at Neon's distance), while it held the user's lock. 12 of them were the usage sync that charges the turn. A second message sent right after a reply waited for all of it.
- **What the user notices:** a message sent right after a reply starts about 3.4 seconds sooner. The balance in the web app drops a moment after the reply instead of together with it. Nothing else changes.
- **Backend:**
  - **The billing of a turn is a job of its own,** named `bill-turn`, in the system queue. The turn adds it as soon as it knows how it ended, before it gives the lock back. Adding it is one note in Redis, with no trip to the database. Then the turn saves what the next message depends on (the message's last state and which engine has the conversation, now both at once), the event is marked done, and the lock is given back.
  - **The job is the same usage sync as before,** for that one user, followed by the live balance for the web app. There is one job per turn: its id comes from the turn's event. A second run charges nothing twice, because usage is charged by period, never by turn, with the same idempotency keys. A failed run is tried again, 5 tries in all, then an alert is raised and the 5-minute sync charges the usage. If Redis refuses the job, the turn bills itself, the old way.
  - **What each way of paying for the AI costs per turn, and what is asked:**

    | Who pays for the AI | Charged in credits after a turn | Asked before (inside the lock) | Asked now (after the lock) |
    |---|---|---|---|
    | Textcrew AI | AI at cost × 2.5, awake time, browser time | LiteLLM and the vm-manager | The same |
    | The user's own API key | Awake time, browser time. The AI is free | LiteLLM and the vm-manager | The same |
    | The user's own Claude plan | Awake time, browser time. The AI is free | LiteLLM (the AI so far, then the key's budget) and the vm-manager | Only the vm-manager |

    App actions and web searches through Textcrew are charged when they run, for everyone, as before. No price and no rule changed.
  - **On a Claude plan, LiteLLM is no longer asked after a turn:** not for the AI so far, not for the key's budget, and not for the spend log when a failed turn is refunded. Claude Code does not use LiteLLM, so there is nothing there to charge. Any AI that did reach the key would still be charged by the 5-minute sync, which asks LiteLLM as before.
  - **The check before a turn still sees the charges of all but one turn.** The turns waiting for their billing are noted in Redis. A turn may start while the one before it still waits (the usual case: a message sent right after a reply). If two wait, the turn bills them itself first, then checks the balance. So nobody can run turns for free by racing the billing, even with the system queue stopped. Looking costs one read in Redis.
- **Cost and speed:**
  - Measured with the same test as the entry below (`test/read-round-trips.test.ts`): every database query waits 260 ms and every new connection 2 seconds; the AI and the container wake are fakes. The test now also shows the stretch from the reply to the free lock, and the billing job on its own. The "before" numbers come from the same test run on the code before this change.

    | | Before | After |
    |---|---|---|
    | From the reply shown until the lock is free (the next message can start) | 20 trips, 19 in a row, 4.97 s | 8 trips, 6 in a row, 1.58 s |
    | The whole turn, from sending until the job ends | 42 trips, 8.12 s | 30 trips, 4.73 s |
    | Sending until the reply shows | 3.15 s | 3.16 s (no change) |
    | The turn's billing | Inside the turn, 12 of the 20 trips | Its own job after the lock: 12 trips, 2.92 s, nobody waits for it |

  - The billing job in that test had nothing to charge. A turn with something to charge makes a few more trips in it, all after the lock.
  - **Credits:** no change for anyone. The charge reaches the balance a moment later, about 3 seconds at Neon's distance. At a turn's start at most one earlier turn can be unbilled; at zero credits its cost becomes a small debt, as awake time already could.
  - **LiteLLM:** for a Claude-plan user, one call fewer per turn (the read of the key's spend), and a budget update fewer whenever the balance changed.
  - **Redis:** one small list per user of the turns waiting for their billing, gone after an hour at most.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change. The live `credits.updated` event is the same; it is now sent by the billing job.
- **Database:** none.
- **How it was checked:**
  - New tests (7): the next message starts and gets its reply while the first turn's billing job still waits, then both turns are charged once and the web app gets the new balance; the job run twice charges once, and added twice is queued once; a job that fails is tried again and charges the turn exactly once; a job that never ran is covered by the 5-minute sync, and running it later charges nothing more; a Textcrew AI turn is charged exactly what the sync after the turn charged before (the example of section 25: "Usage: AI 8, awake time 1", 9 credits), compared with a user charged the old way; a Claude-plan turn and the refund of a failed Claude-plan turn make no call to LiteLLM at all, and the awake time is still charged and refunded; with 1 credit and the billing stopped, two turns run and the third is billed first and refused with the out-of-credits reply, and the billing jobs that run later charge nothing more.
  - Changed tests: the Claude-plan turn test runs the queued billing job and checks it is marked as a Claude-plan turn; one browser test waits for the turn's billing job; the round-trip test pauses the billing during the turn, counts the trips between the reply and the free lock (at most 8), and measures the billing job apart.
  - Lint and the type check pass. The full backend run: 853 of 853 tests pass.
  - Not yet run on the server.
- **Still open:**
  - **The 5-minute sync still asks LiteLLM for every user with a key,** also for a user on their Claude plan. It finds no AI there and charges none. It could be left out for those users too; it costs one LiteLLM call per user every 5 minutes. Not changed here.
  - **After the reply the turn still makes 8 trips (6 in a row, 1.6 s)** before the lock is free: the end of the agent's send (the conversation's time, a crew job's report, the activity log), the engine's record and the message's last state, the turn's timings and the event. Moving Neon closer to the server is the structural fix (entry below).
  - No pricing question: the docs say clearly what a user on their own AI pays (backend report section 24), and that is what is charged.
- **Docs updated:** `backend-report.md` section 3 (the system queue, the per-user lock), section 4 (a row in "Keeping reads fast"), section 9 (steps 18 and 19, where a turn's time goes), section 12 (`credits.updated`), section 25 (the usage sync, a new part "The billing of a turn", re-runs, the refund, what can go wrong), section 26 (the check before a turn), section 30 (the Claude plan), section 32 (`GetUsage`) and section 43; `hld-mvp.md` section 5.2, step 9.
- **Commits:** `9abf205` (the billing job and the check before a turn), `af805a5` (its tests, and no LiteLLM after a Claude-plan refund), `ef892c8` (the round-trip test), and the docs commit that adds this entry.

### 15 October 2026: pages and replies wait for fewer trips to the database

- **Where it is:** on `main`, not yet on the server. Its database update (`0024_messages_event_id`, one index) runs on Neon at the next deploy.
- **Why:** you said opening chats, lists and the app's pages, and replies, take far too long. Since 14 October the database is on Neon in Ohio and the server in Mumbai: each trip to the database takes about 260 ms, and opening a new connection 1.5 to 2.5 seconds. So a page's time is mostly how many trips it waits for, one after another, plus the connections it has to open. Where the time went, measured:
  - **Every signed-in call first read the user's row:** one trip before the call's own work. Most calls waited for 2 trips (0.53 s), opening a conversation for 3 (0.79 s), the app list for 3.
  - **Connections closed after 5 minutes idle.** The first page after a quiet spell asks for about 8 things at once, so it opened about 8 connections: the chat page took 3.3 to 5.4 seconds instead of 1.3.
  - **Sending a web chat message** waited for 11 trips one after another before the api answered (2.9 s), and about 23 before the reply showed (6.1 s, not counting the AI's own time or a cold container).
  - **Each tool call of the agent** made 2 trips (whose token is this, is the account suspended) before doing anything.
  - **Every incoming Telegram message** was looked up by its event with no index for it, so each lookup read the whole messages table. Small today; it grows with every message.
  - **Found on the way:** the connection pool had nothing listening for errors. A connection that died while idle (Neon restarted, the network dropped it) would have ended the api or the worker, which then restarted.
- **What the user notices:** pages open and replies come faster. The chat page after a quiet spell opens in about half a second instead of 3 to 5 seconds. A reply shows about 3 seconds sooner. See "Cost and speed".
- **Backend:**
  - **Connections stay open.** The api and the worker each keep 10 database connections open at all times (new setting `DB_POOL_MIN`), open them when they start, and check each idle one every minute with a tiny query (`DB_PING_SECONDS`). One that died is replaced then, so a user's request does not pay for opening it. Extra connections, up to 20, still close after 5 minutes idle.
  - **A dropped connection no longer ends the program.** It is written to the log and replaced.
  - **A short copy of the user's row in Redis.** Who is signed in, whether the account is suspended and the plan are read from a copy kept in Redis, on the same server, instead of from Neon. The copy lives 60 seconds at most. Every change to a user's row drops it at once (a suspension or its lifting, a plan, a role, a deletion, a name or time zone, the first-run marks including an admin's reset, a chargeback mark, Clerk's updates), and for 30 seconds after a change no new copy is kept, so a read made just before a transaction is saved can't keep the old row. If Redis is down, reads go to the database as before. A suspension still refuses the very next call.
  - **Which user a container token belongs to** is kept in Redis for 10 minutes, by the token's hash (never the token). Removing the user's container record drops it, so the token stops at once.
  - **Reads that don't depend on each other run at the same time.** Opening a conversation reads its messages, checks it is the user's and reads when web chat started, all at once (a missing one still answers 404). The app list reads the user's connections once instead of twice. Sending a message checks the credits, the files and whether it was already sent at once, and reads a named conversation once instead of twice. The turn reads the conversation, the credit check and the agent settings at once (the settings once, not twice), and the saved memory with the recap.
  - **The balance shown in the app is one read of the grants.** `GET /v1/me`, `GET /v1/credits` and the live balance after a turn each used two queries; now one, with the same numbers. Nothing about credits is cached, and charges are untouched: they still read the grants under the user's lock.
  - **An index on messages by event**, for the Telegram lookup above.
  - Everything else stays as it was: every user query is filtered by the user's id, modules still call each other's functions only, every job is still safe to run twice, errors keep their shape.
- **Cost and speed:**
  - Measured with a test that makes every database query wait 260 ms and every new connection 2 seconds (`test/read-round-trips.test.ts`, which prints this table on request). The same test ran on the code before and after this change. The AI's own time and the container's wake are not in it: the vm-manager and the models are fakes there.

    | | Trips before | Trips after | Time before | Time after |
    |---|---|---|---|---|
    | `GET /v1/me` (profile and balance) | 3 | 1 | 0.53 s | 0.27 s |
    | `GET /v1/approvals`, `/v1/conversations`, `/v1/channels`, `/v1/activity`, `/v1/automations`, `/v1/memories`, `/v1/crew-jobs` and the other lists | 2 | 1 | 0.53 s | 0.27 s |
    | `GET /v1/agent/status`, `/v1/crew` | 1 | 0 | 0.27 s | 0.00 s (plus the vm-manager's own time) |
    | `GET /v1/messages` (open a conversation) | 4 | 3, all at once | 0.79 s | 0.26 s |
    | `GET /v1/apps` | 4 | 2, at once | 0.79 s | 0.26 s |
    | `GET /v1/credits` | 3 | 1 | 0.53 s | 0.26 s |
    | `GET /v1/agent/settings`, `/v1/byok` | 3 | 2, at once | 0.53 s | 0.26 s |
    | The chat page: 8 calls at once, then the messages | 17 | 8 | 1.33 s | 0.54 s |
    | The chat page after a few quiet minutes | 17, and about 8 new connections | 8, no new connection | 3.3 to 5.4 s | 0.54 s |
    | The chat page with no connection open (right after a start) | 17, and about 8 new connections | 8, and 5 new connections | 3.3 to 5.4 s | 2.6 s |
    | The credits page: 8 calls at once | 14 | 5 | 0.54 s | 0.27 s |
    | Sending a web message, until the api answers | 11 in a row | 7 in a row | 2.9 s | 1.8 s |
    | Sending a web message, until the reply shows | about 23 in a row | about 12 in a row | 6.1 s | 3.2 s |
    | The whole turn, until the job ends and the next message can start | 52 | 42 | 11.0 s | 8.1 s |

  - **Moving Neon to Singapore** (about 40 to 60 ms a trip) would come on top. At 50 ms a trip, with this change: about 0.05 s for a simple page call, 0.1 s for the chat page, about 0.6 s until a reply shows, about 1.6 s for the whole turn, and roughly 0.3 s to open a connection. Without this change the reply would still wait about 1.2 s there.
  - **Neon:** 10 connections kept per process, 20 in all, well under Neon's limit. The check every minute sends one tiny query per idle connection. It adds no compute time: the vm-manager already asks its own database, on the same Neon project, every 30 seconds, so the database is kept awake already.
  - **Redis:** one small copy per active user (a few KB) and one short line per container token, each removed by Redis after 60 seconds or 10 minutes.
  - Credits: no change. The index makes each new message a little slower to save, too little to measure.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change.
- **Database:** no new table. One new index, `messages_event_id_index` (database update `0024_messages_event_id`).
- **How it was checked:**
  - New tests: the round trips of every read the web app makes, each with a budget, a whole page opening no new connection with the pool warm, and the Telegram lookup using the new index (25); the pool keeping its connections, using them, replacing one that was killed, and not pinging busy ones (4); the user's copy used, dates kept, Redis down falling back to the database, and each kind of change showing on the very next call: a suspension and its lifting, a change inside a transaction, a plan, a name and time zone, the first-run marks from the user and from an admin's reset, a role from Clerk, a deletion (11); the token owner kept and dropped when the record goes, a made-up token never kept (2); the one-read balance giving exactly the two-read numbers at three moments, with expiring, spent and debt grants (4).
  - The pool test found the missing error listener: a killed connection raised an error nothing handled.
  - Three tests changed: two waited for a container wake that runs in the background and that nobody waits for (a "simple" message), which now can arrive after the answer; and one retry test now counts only its own user's wakes, since an earlier test's background wake could land in it.
  - Lint and the type check pass. After merging `main`, the full backend run: 846 of 846 tests pass. In earlier full runs, now and then one timing test failed while the whole run was busy (a crew job, the browser switch, a refund job's retries, Jev routing), each passing alone; the commit before this work showed the same, 1 failed run in 4.
  - Not run against Neon itself, and not yet on the server.
- **Still open:**
  - **After the reply, a turn still makes about 19 trips in a row (about 5 s at Neon's distance) before it gives the user's lock back.** About 12 of them are the usage sync, which charges the credits. A second message sent right after a reply waits for all of it. It could give the lock back before the sync, or run as a job of its own; both change how the charging is ordered, so it is your call. Not changed here. Done since: see "a turn's billing runs after the reply" above.
  - **The vm-manager's own database is on Neon too.** `GET /v1/agent/status` and every wake ask the vm-manager, which reads its database in Ohio. Not measured here, and the vm-manager is unchanged.
  - **The web app** asks Clerk for a fresh token on every call, and an approval card in a conversation can ask for the approvals up to 4 times in a row (pending, approved, rejected, expired) to find its own. Both are the web app's work.
  - **Moving Neon to Singapore** is the structural fix (above).
- **Docs updated:** `backend-report.md` section 1 (the Redis row), section 4 (the sign-in check and a new part "Keeping reads fast"), section 9 (what the turn reads at once), section 13 (how a container proves who it is), section 23 ("Why no balance number is stored"), section 40 ("Where the database lives") and section 42 (the two new settings); `.env.example`.
- **Commits:** `590470c` (the measuring test), `802c085` (connections kept open, the error listener), `ace4648` (the user's copy), `80563db` (the token owner), `379f85d` (the balance in one read), `6bd4436` (messages and app list), `4503e28` (sending and the turn), `31f84a4` (first-run marks test), `a82d11c` (the index and the budgets), and the docs commit that adds this entry.

### 15 October 2026: the web app's first-run marks (welcome steps and "Getting started")

- **Where it is:** on `main`, not yet on the server. Its database update runs on Neon at the next deploy (`deploy.sh` runs the migrations before it starts the new api and worker).
- **Why:** the web app is getting a first-time onboarding: a few welcome steps, then a "Getting started" checklist on its home page. You wanted whether a user has been through it kept in the database, not in the browser, and both users we already have to get the onboarding too.
- **What the user notices:** nothing from the backend alone. Once the web app uses it, a new user sees the welcome steps once, on any device. The two users we already have see them on their next visit, exactly like a new user.
- **Backend:**
  - **Two marks on each account.** When the welcome steps were finished or skipped, and when the checklist was closed. Both are in `GET /v1/me`; empty means "not yet", so the web app shows the welcome steps, or may show the checklist.
  - **Setting and clearing them.** `PATCH /v1/me` takes two new yes-or-no fields. Yes stamps the time now; if the mark is already set, the first time is kept. No clears it, so Settings can show the welcome steps again. Only the signed-in user's own row changes.
  - **The checklist's steps are not tracked here.** The web app works them out from the account's real data and hides the checklist by itself once all are done.
  - **A new admin tool: show the welcome steps again.** Admins only, with a reason, like the other account tools. It clears both marks for one user and writes one activity-log row with the admin's id, the reason and the two times it cleared. When both are already empty it changes nothing and writes no row. Unlike the other account tools it also works on an admin's own account, because it is harmless.
  - The marks live on the `users` table, which the auth module owns. The admin tool changes them through the auth module's own function, the same one `PATCH /v1/me` uses.
- **Cost and speed:** two more columns on a row that is read anyway: `GET /v1/me` makes no extra query, and `PATCH /v1/me` is still one update. No new job, no Redis. Not measured.
- **Contracts:** `openapi.yaml` changed. `Me` gains `onboardingCompletedAt` and `gettingStartedDismissedAt` (always present, empty or a time). `MeUpdate` gains `onboardingCompleted` and `gettingStartedDismissed` (optional, true or false). New: `POST /v1/admin/users/{userId}/onboarding/reset` (`adminResetUserOnboarding`). The web app has to follow to use them: it needs the new contract copied in. Until then it works as before, since the new fields are only extra. `vm.proto` did not change.
- **Database:** two new columns on `users`: `onboarding_completed_at` and `getting_started_dismissed_at`, both a time that may be empty (database update `0023_onboarding_marks`). No backfill, on purpose: every existing row stays empty, so the users who signed up before this change see the onboarding on their next visit, exactly like new users. The update's own comment says so.
- **How it was checked:**
  - New tests (11), in one new file: a new user has both marks empty; an account made before the change has both empty after the update (the test puts the table back as it was, adds an account the old way, then runs the update file itself, and checks the file has no default and no backfill); yes sets the time, a second yes keeps the first time, no clears it, yes after a clear gives a new time; each mark works on its own and leaving one out keeps it; one user's calls never touch another user's marks; a value that is not yes or no is refused. For the admin tool: 403 in the error shape for a user who is not an admin (also on their own account) and 401 without a session, with nothing changed and nothing logged; it clears both marks and writes one row, the user's own activity list shows the plain line without the reason, a second call writes nothing; one mark set is enough, and an admin may do it on their own account; a missing or blank reason is 400, an unknown or deleted account 404.
  - Lint, the type check and the contract check pass. The full backend run: 798 of 800 tests pass. The 2 that failed are timing tests in parts this change does not touch: one crew-jobs test and one Jev routing test each saw one extra container stop or wake from another test's user while the whole run was busy. Run alone, both files pass (14 of 14 and 10 of 10). A first full run was spoiled by a full `/tmp` on the laptop (the test database could not be created for 16 files); the second run kept the test database's files on the main disk.
  - Not yet run on the server.
- **Still open:**
  - The web app's screens (the welcome steps, the checklist, the Settings button) are the web app's own work.
  - The admin panel has no button for the new admin tool yet.
  - `pnpm openapi:sync` still copies the contract to `../user-frontend/ignore/`, a folder that no longer exists: the web app now lives in `user-frontend-web` and keeps its copies in `openapi/` and `ignore/`. It was not run and not changed. The web app's copy has to be updated by hand, or the script pointed at the new folder; your call.
  - The admin's page for one user does not show the two marks. Easy to add if you want it.
- **Docs updated:** `backend-report.md` section 6 (new part "The first visit to the web app"), section 31 (the opening lines, the table, the shared rules and a new part "Showing the welcome steps again"), section 40 (the `users` row) and section 41 (the Profile and Admin rows); `hld-mvp.md` section 5.1 (a paragraph on the first visit).
- **Commits:** `618f470` (the marks on `/v1/me`), `d4ffb5a` (the admin tool), and the docs commit that adds this entry.

### 15 October 2026: request logs and response times per route

- **Where it is:** on `main`, not yet on the server.
- **Why:** you asked whether the backend keeps request logs, and for the p50, p95 and p99 response times of each endpoint. A request log existed, but a thin one: each request wrote one line with the method, the route, the status, the time and a request id, all at the same level. It had no address, no user and no IP. A request that failed with a 500 was an ordinary line, not an error. Other lines written during the same request had no id to match them with. And the answers that `/mcp`, `/git` and file downloads build themselves went out without the request id. There was no way to see how slow each route is.
- **What the user notices:** nothing. A 500 answer now also gives the request id (`details.requestId`), so a user who reports an error can quote it.
- **Backend:**
  - **The request log.** Still one line per request, written when the answer is ready, now with: the request id, the method, the route as written in the contract, the address without the part after the question mark, the status, the time in milliseconds, the user (the signed-in user, or the container token's user on `/mcp` and `/git`), and the caller's IP as Caddy reports it. A 5xx is an error line, a 4xx a warning, the rest plain information. The health check and `/metrics` are written only at the debug level, which the server does not show.
  - **The request id.** A caller may send its own `X-Request-Id`; it is kept only when it is up to 64 letters, digits, `_` or `-`, otherwise the api makes one, such as `req_01m5a2b3c4d5e6f7g8h9j0k1m2`. Every answer carries it, now also the ones `/mcp`, `/git` and file downloads build themselves. Every log line written while the request runs carries it too, so the "unhandled error" line and the request's own line can be found together.
  - **No secrets.** The request log never holds a body, a header or the part of the address after the question mark. Sign-in tokens, cookies, webhook signatures, container tokens and one-time codes travel in those places, so none of them can reach it. Webhooks are untouched: the log does not read the body, and signatures still verify.
  - **Response times.** Each request's time is also counted in Redis, never in the database. It goes into a time bucket ("up to 250 ms"), per route, per status class (2xx to 5xx) and per time slot: 5-minute slots kept 2 hours and hourly slots kept 8 days. The slowest time of each route is kept exactly. Counting never makes a request wait or fail: the api sends the count and goes on, and drops it when Redis is down. The health check and `/metrics` are not counted.
  - **A new admin endpoint,** `GET /v1/admin/timings/requests`, admins only. For the last hour, the last 24 hours (the default) or the last 7 days, it gives each route and all requests together: the number of requests, how many answered 4xx and 5xx, p50, p95, p99 and the slowest. Slowest p95 first. The percentiles are worked out from the buckets, so they are accurate to one bucket: off by at most a third, usually much less. It never shows a user, an address with its ids, or a query.
  - The existing turn-timings summary works from database rows and their exact values; these times are counted in buckets instead, so its percentile maths could not be reused as it is. The new page uses the same names (count, p50Ms, and so on), and the tests check its estimates against that exact maths.
- **Cost and speed:**
  - Each request sends one batch of commands to Redis, which runs on the same server, and does not wait for it. No delay to the answer was seen in the tests; not measured on the server.
  - Redis memory: each slot holds at most a few hundred counters at beta traffic, and Redis removes old slots by itself. A few MB at most; not measured.
  - No database writes at all, so nothing goes to Neon.
  - The log has the same number of lines as before, each a little longer.
- **Contracts:** `openapi.yaml` changed. New: `GET /v1/admin/timings/requests` (`adminRequestTimes`) and the `AdminRouteTimes` schema. The conventions at the top now say that every answer carries `X-Request-Id` and that a 500 gives `details.requestId`. Nothing has to follow: the web app and the admin panel work as before. `vm.proto` did not change.
- **Database:** none. The counts live in Redis, under keys that start with `pa:reqtimes:`.
- **How it was checked:**
  - New tests for the request log (14): the fields of the line, the route pattern and the address without the query, the IP behind Caddy, a long address cut, a caller's request id kept or replaced, the id on answers from `/mcp`, `/git` and file downloads (this one failed before the fix, which showed the missing header), the levels (a 500 as an error with the id in its answer and on the "unhandled error" line, a 4xx as a warning, the health check at debug), and planted secrets in the sign-in header, cookies, the query, the body and webhook headers, none of which reached the log. A signed Clerk webhook and a Telegram webhook still pass their checks.
  - New tests for the response times (13): the percentile maths against exact values for an even spread and a skewed mix, never above the slowest request, the buckets' sizes (this test found a too-large step between 20 and 30 seconds, now fixed), counting per slot and the three windows, the keys' expiry, the endpoint (401 without a session, 403 in the error shape for a user who is not an admin, 400 for an unknown window, the real requests counted by route pattern and never by address or user), and a Redis failure that leaves the request unharmed.
  - Lint, the type check and the contract check pass. The full backend run: 789 of 789 tests pass. Before the change, one run had 1 failure in the crew-jobs tests (a timing test, unrelated); it passed in the full run after the change.
  - Not yet run on the server.
- **Still open:**
  - The admin panel has no page for the response times yet. It needs the new contract, a call to the new endpoint, and a table with a window switch.
  - A searchable request log in the admin panel was not built. Reading the logs on the server is in `aws-setup.md`, section 13. If you want one, it is a separate decision.
  - The time counted is until the answer starts. For the live stream that is until the stream opens, not how long it stays open.
- **Docs updated:** `backend-report.md` section 4 (the steps, the error table, new parts "The request log" and "Response times", and "Logging without secrets"), section 31 (the admin table and a new part "Response times") and section 37 ("Logs, metrics and alerts"); `aws-setup.md` section 13 (commands to read the request log). `hld-mvp.md` does not describe logging, so it did not change.
- **Commits:** `3ba29dd` (the request log), `444c29a` (the response times), and the docs commit that adds this entry.

### 14 October 2026: the databases move from the server to Neon

- **Where it is:** on `main` since 14 October, and on the test server since 14 October: the server's three databases now live on Neon.
- **Why:** you chose to stop keeping the databases in a container on the test server and to use Neon, a managed Postgres, for all three: the backend's, the vm-manager's and LiteLLM's. The existing data on the server is copied over.
- **What the user notices:** a few minutes when the bot does not answer, while the move runs. After it, replies may be slower: see "Cost and speed".
- **Backend:**
  - The api, the worker, the vm-manager and LiteLLM now take their database address from three settings in `compose.env`: `BACKEND_DATABASE_URL`, `VM_MANAGER_DATABASE_URL` and `LITELLM_DATABASE_URL`. When they are not set, they point at the local `postgres` container as before.
  - That local container now starts only with the `localdb` profile, which the laptop uses and the server does not. The other services wait for it only when it runs.
  - The deploy script no longer starts the local database. It runs the migrations against Neon, and it stops before building anything if the three addresses are missing, so a deploy can't start the services on a database that isn't there.
  - The backend's database on Neon is called `agent`, as on the server today, not Neon's ready-made `neondb`. That one already holds the landing page's waitlist, and it keeps its migration records in the same place the backend keeps its own. Sharing it would have made the backend skip some of its own migrations, and the copy would have collided with the landing page's records.
  - All three use Neon's direct address, not the pooled one. LiteLLM sets up its tables at start in a way that breaks through the pooler; the vm-manager's migrations hold a lock for the whole connection; the nightly copy also needs the direct address. The backend works through the pooler too (tested), but one rule is simpler, and the server keeps few connections (Neon allows 901).
  - The nightly backup: the image now has the Postgres 18 dump tool (Neon runs 18; the old tool, 16, can't dump a newer server). The backup now keeps the address's encryption settings, which Neon requires; before, it dropped them.
  - The backend keeps idle database connections for 5 minutes instead of 10 seconds, since a new one to Ohio is slow (below).
  - A one-off script, `move-to-neon.sh`, does the move: it checks everything first, then stops the services, copies each database, compares every table's row count, stops the old database (its data is kept as the way back) and deploys. It refuses to copy into a Neon database that already has tables unless told to.
- **vm-manager:** no change. Its database driver accepts Neon's address as Neon gives it, including the stricter sign-in (`channel_binding`).
- **Cost and speed:**
  - The Neon project is in Ohio and the server in Mumbai. Each database query takes about 260 ms there and back, against under 1 ms with the database on the server. You chose Ohio knowing this. Measured from the laptop in India: 235 to 275 ms per query, about 1 second for a short transaction, and 1.6 to 2.5 seconds to open a new connection. A reply runs many queries one after another, so it will be slower by a few seconds or more; not measured on the server.
  - Keeping idle connections for 5 minutes means a reply rarely pays the 1.5 to 2.5 seconds of a new connection.
  - LiteLLM setting up its tables on an empty Neon database took about 6 minutes from the laptop. After the move it finds them already there and starts in seconds.
  - The nightly copy now goes over the internet from Ohio. The database is small, so this is little traffic. Neon's own bill is not covered here.
  - The server no longer runs Postgres, which frees some memory on it; not measured.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change.
- **Database:** no new or changed tables. The same three databases, in a new place.
- **How it was checked:**
  - New tests: the compose file (the local database only with `localdb`, each service's address from its setting with the local one as default, no address left hard-coded), the deploy script (no longer starts the database, checks the three addresses), the move script (refuses to start without the three addresses or with one still pointing at the local database, rejects an unknown option), and the backup's connection settings (encryption kept, the password only in the environment, the system's certificates for a checked connection).
  - Lint and the type check pass. The full backend run: 761 of 761 tests pass. A first full run had 2 failures under load (a crew job and the usage sync job, both waiting on timing); both files pass alone, and the second full run passed completely.
  - Against Neon for real, in scratch databases that were dropped afterwards: the vm-manager's own database tests with Neon's address (every one passed except one that can't work on Neon for a test-only reason: the tests give each case its own schema through a connection setting that Neon's proxy ignores); LiteLLM's start-up (all 195 of its table changes applied, "database connected", a key made and saved); the backend's migrations, a query and a credit-style lock; the backup's dump tool with the backend's settings.
  - The move script, from the laptop: a local Postgres with the backend's real tables and some rows, into three scratch Neon databases. It created the missing ones, copied all three with matching row counts (35, 2 and 1 tables), refused a second run into the now full databases, and with `--force` replaced them. Docker isn't on the laptop, so the script's Docker commands (stopping the services, the `postgres:18` tools) did not run; they ran through local Postgres 18 tools instead.
  - On the server, 14 October: the dry run passed, then the move copied all three databases with matching row counts (backend 35 tables and 933 rows, vm-manager 4 tables and 59 rows, LiteLLM 82 tables and 228 rows). Everything started on Neon and `api.textcrew.in/healthz` answers "ok".
  - The deploy at the end of the move reported "failed" by mistake: its health check counted the stopped local database as a service that should be running. Nothing was wrong. The check now leaves that container out, with a test for it.
- **Still open:**
  - Watch how long replies take now that every query goes to Ohio.
  - If replies are too slow, the fix is a Neon project in Singapore or Mumbai; that is a new project and a second move.
  - Neon keeps its own history of the databases. The nightly copy stays as a second, independent one; dropping it is your call.
  - After a few good days, the old database's volume on the server (`personal-agent_pgdata`) can be deleted.
- **Docs updated:** `aws-setup.md` sections 1, 3, 6, 7, 8 (new part "Moving the databases to Neon") and 14; `hld-mvp.md` section 4 ("What runs on the server") and section 12 ("Built, never run for real"); `backend-report.md` "The services it talks to", section 40 (new part "Where the database lives") and "The nightly backup and the restore test". The README's and `CLAUDE.md`'s local start command now names the `localdb` profile.
- **Commits:** backend `f295947`, `a24ab58`, and the docs commit after them.
