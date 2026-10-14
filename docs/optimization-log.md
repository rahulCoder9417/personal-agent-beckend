# Optimization log: what changed in the backend and the vm-manager

This file records every change made to the backend and the vm-manager while we optimize the product, starting on 13 October 2026. Each change is written up by feature, in plain words, with no code. An entry says what changed and why, what it means for users and for cost, how it was checked, and where it is now.

Only the backend and the vm-manager are logged here. Changes made only to the web app's screens are not; the web app's README describes those.

This file does not replace the other docs. `hld-mvp.md` is still the design and `backend-report.md` still explains the logic. When a change alters how something works, those two files are updated as well, and the entry here says which sections.

## Contents

1. [In short](#1-in-short)
2. [The starting point](#2-the-starting-point)
3. [How an entry is written](#3-how-an-entry-is-written)
4. [The log](#4-the-log)

---

## 1. In short

| | |
|---|---|
| **What it covers** | The backend (api and worker) and the vm-manager (the containers, the Bridge, the egress proxy) |
| **What it leaves out** | Changes made only to the web app's screens |
| **Started** | 13 October 2026 |
| **Order** | Newest change first |
| **Where the work goes** | Straight to `main` in each repo, once the checks pass |
| **How it reaches the server** | By running `/opt/textcrew/deploy.sh` on the server (see `aws-setup.md`, section 8) |

---

## 2. The starting point

Both repos start from `main` as it was on 9 October 2026:

| Repo | Last change on `main` | Commit |
|---|---|---|
| Backend | Replies as Markdown in the web app and as plain text on Telegram | `6f9cb52` |
| vm-manager | The agent is told how to format its answer for each channel | `bbe8f05` |

What worked on the test server at that point, what was built but never run for real, and the decisions waiting on you are in `hld-mvp.md`, section 12. Every entry below is a change from that point.

---

## 3. How an entry is written

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

## 4. The log

### 14 October 2026: admin tools for one user's apps, chats and automations

- **Where it is:** on `main` since 14 October, in the backend. It reaches the server with `deploy.sh`, which also adds the new column.
- **Why:** support had no way to see or fix a user's apps, linked chats or automations without the database. When a user wrote "my Gmail says connecting" or "my automation keeps failing", only the dev-user script on the server could tell why, and nothing could be changed safely by hand.
- **What the user notices:**
  - Nothing, until support acts for them. Then the action works exactly like their own button, and their activity log shows it, for example "Textcrew support paused "Daily summary"". The reason the admin gave is not shown to them.
  - An automation paused by support says so: its paused reason is `admin`. Adding credits does not switch it on again; the user can resume it themselves.
- **Backend:**
  - **One user's apps:** a list of every connection in any state, with the app, the state, the account's label, where the app's Composio setup comes from on this server (`settings`, `server_made` or `none`), whether the app can be connected here, when the user started connecting it, and when the platform last heard from Composio about it. Disconnect is the user's own (the account is removed at Composio). Recheck asks Composio about that one connection now, whatever its state, and copies its answer; one still being set up gets a fresh series of checks.
  - **One user's chats:** the linked chats with the chat id masked, whether the channel is on here, and whether the bot is blocked. Unlink is the user's own, with the same activity log entry. The unlink and its entry now live in one place that both use.
  - **One user's automations:** every automation, finished reminders too, without the instruction text. Pause, resume and delete go through the automations module's own functions: timers removed or set again, the Composio trigger deleted on delete (for pull-request review, the watch on the repo).
  - **Apps in numbers:** for each app, where its setup comes from, whether it can be connected, how many users connected it, and its connections by state.
  - **Every action needs a reason** (up to 200 characters, not blank) and writes one activity log row with the admin's id and the reason. All the new operations are admin only.
  - **No secrets:** no Composio account id, token or secret, and chat ids only masked.
  - **Each connection now keeps when Composio last answered about it:** a check, the app list, Composio's webhook or a recheck.
- **Cost and speed:** none for users. The list calls read our own tables only. A recheck is one Composio request. A pending connection's check writes one more small update when Composio answers.
- **Contracts:** `openapi.yaml` changed: ten new admin operations under `/v1/admin/users/{userId}/apps`, `/channels` and `/automations`, `/v1/admin/automations/{automationId}` and `/v1/admin/apps/summary`; the automation's and the pull-request review's `pausedReason` can now be `admin`. The web app should show that one as "Paused by Textcrew support". `vm.proto` did not change.
- **Database:** a new column, `checked_at`, on `connections` (migration 0021). The automations' paused reason is a text column; `admin` needed no migration.
- **How it was checked:**
  - 23 new backend tests: every operation refuses a user who is not an admin (403) and a call with no session (401); a missing or blank reason is refused; disconnect removes the account at Composio (the fake) and the row, leaves app-event automations as the user's disconnect does, and writes the audit row, which the user's activity log shows without the reason; another user's connection or chat answers 404 and changes nothing; recheck copies Composio's answer for a pending and for an active connection, marks one Composio no longer has as failed, queues fresh checks for one still being set up, and answers 503 with nothing changed when Composio is down; the summary counts per app and holds no user id; chat ids are masked, also a Telegram chat saved under its id; an admin's unlink writes the same entry as the user's; pause removes the timer and survives added credits; resume sets the timer again and clears the failures; delete removes the timer and the Composio trigger, for pull-request review too; a reminder that already ran answers 409. Three of them failed when the pause reason or the masking was broken on purpose.
  - Lint, the type check and the OpenAPI lint pass. 684 of 685 backend tests pass; the one failure is the Hindi title test, which already failed before.
  - Not with real Composio or Telegram: Composio is a stand-in in the tests. Not on the server.
- **Still open:**
  - Whether Composio removes its triggers when an account is deleted is not known from here. Neither the user's disconnect nor the admin's touches the user's app-event automations; they stay on and get no events.
  - The admin panel has no screens for these yet.
  - Your decision: should a user be able to resume an automation that support paused? Today they can, as with every other pause.
- **Docs updated:** `backend-report.md` sections 7, 14, 18, 31 (a new part, "One user's apps, chats and automations"), 40 and 41.
- **Commits:** backend `ee28db1`, `bfac455`, `daf9666`, `5eb0805`, `c65fb44`.

### 14 October 2026: support can see and put right one user's agent

- **Where it is:** on `main` since 14 October, in the backend. It reaches the server with `deploy.sh`.
- **Why:** when a user writes in, support had no way to see their agent: whether the container is awake or stuck, which engine and model run, what pays for the AI, what waits for a yes. Nor to put it right without touching the database.
- **What the user notices:**
  - Nothing, until support acts. Then a short line in their activity log, such as "Textcrew support stopped the agent's container". Never the admin's reason.
  - A crew job support cancels is shown as failed with "Cancelled by Textcrew support.", and the job's chat says it won't run.
  - After a stop by force in the middle of a turn, that turn's answer is "Sorry, something went wrong on our side", and its credits come back.
- **Backend:** eight new admin calls, for admins only:
  - **The view** of one user's agent: the container as the vm-manager reports it (state, busy, last active, image, memory, the engine and browser switch on record, Claude signed in or not), the engine chosen and the one that runs, Claude plan connected and since when, the model and effort, the browser, what pays for the AI, and the usage charged since midnight UTC. If the vm-manager can't be asked, the rest still shows.
  - **Stop the container**, politely (refused while it is in use) or by force, which is marked dangerous in the contract and the report. **Wake it**, the same wake a turn makes; the user must have credits, since the awake time is theirs to pay.
  - **Reset settings**: the engine back to Hermes, the Claude model and the effort back to Default, the browser switch set again from the plan. The user's own settings functions make the change.
  - **Approvals**: the list without the actions' inputs, and cancelling a waiting one the way the 24-hour expiry does.
  - **Crew jobs**: the list without the brief's text (the report only when asked for), and cancelling one that hasn't started. A running job can't be stopped on its own, so that is refused.
  - Every change needs a reason and is written to the audit log with the admin's id and the reason. No answer holds a container token, a Bridge secret, a LiteLLM key or an API key.
- **Cost and speed:** none for users who are left alone. A wake by support costs the user its awake time, 1 credit per 10 minutes, about a third of a credit before the idle stop.
- **Contracts:** `openapi.yaml` changed: the eight calls above and four new shapes for them, all under the `admin` tag. Nothing changed for the web app's existing calls. `vm.proto` did not change: only calls it already has are used (`GetSandbox`, `StopSandbox`, `WakeSandbox`, `SetAgentRuntime`, `SetBrowser`).
- **Database:** none.
- **How it was checked:**
  - New backend tests (20): every call answers 401 without a session, 403 to a user who isn't an admin and 404 for an unknown user, and needs a real reason; the view's fields, with no container id, allowlist, token or LiteLLM key in it, and with the vm-manager down or no container; the fake vm-manager receives the polite stop, the forced stop and the wake with the plan's priority, and the engine is set again after the wake; a refused stop is 409 and audits nothing; a user without credits is not woken; the reset changes the settings and tells the fake vm-manager, and a browser switch that can't be sent answers 503 with the rest kept; approvals are listed without their inputs, and a cancelled one can't be answered or cancelled twice; crew jobs are listed without the brief or the report, a cancelled one never runs and its user is told, and running, finished and unknown jobs are refused. Two deliberate mistakes in the code (an approval's inputs in the answer; cancelling a running job) made three of these tests fail.
  - Lint, the type check and the spec check pass. 681 of 682 backend tests pass; the one failure is the Hindi title test, which already failed before.
  - Not run against a real vm-manager: the tests use the fake one. Not on the server.
- **Still open:**
  - The vm-manager does not say when a container woke, so the view has no "awake since". A new field on `Sandbox` would give it, if you want it.
  - A running crew job can't be stopped on its own. That needs a new call to the vm-manager and the Bridge; today a stop by force ends it, as a failure on our side.
  - No admin screen uses these calls yet.
- **Docs updated:** `backend-report.md` sections 31 (a new part, "One user's agent and container"), 33 and 41.
- **Commits:** backend `f43668f`, `81e5a1b`.

### 14 October 2026: admin pages for the job queues, the audit log, turn timings, the settings and health

- **Where it is:** on `main` since 14 October, in the backend. It reaches the server with `deploy.sh`.
- **Why:** to run the beta, an admin needs to see what failed and act on it, read what happened for any user, see where replies spend their time, check the settings in use and see whether each service answers, without logging in to the server. Before, failed jobs were only on the queue board, turn timings only in a script run on the server, and the settings only in the server's `.env` file.
- **What the user notices:** nothing. These are tools for admins. The admin panel can now be built on them.
- **Backend:**
  - **Jobs.** A list of the jobs of one queue, or of all four, in one state: failed (the default), waiting, running, delayed or finished. Each job shows its name, tries, times, the user, the first line of its last error and its ids. Its data is shown as ids only: the text of a message, buttons, tokens and keys are left out, and only the names of those fields are listed. A count per queue and state comes with it.
  - **Retry and remove.** A failed job can be run once more; a failed or finished job can be removed. A job that is waiting, delayed or running is never removed or retried: the answer is "conflict" and nothing changes. Both need a reason, and both go to the audit log with the admin's id. A retry is the same as the queue board's retry button: one more run, and the job's own "already done?" check decides what is left, so no work is done twice.
  - **The audit log of every user,** newest first, with filters for the user, the actor, the action and a time window. Secrets in an entry's details are replaced by "[redacted]", at any depth.
  - **Turn timings over the last days** (7 by default, up to 30), from the timings table only: for each stage, the count, the median and the 90th percentile; the wake split into warm, cold, room made and made again; the turns per route, engine and outcome; and the 20 slowest turns with their biggest stage.
  - **The settings in use,** read-only, from a fixed list: the switches, lists, limits, models and addresses (without any password in them). Each secret shows only whether it is set. The app catalog shows, per app, whether it can be connected on this server and how. `AWAKE_CAP` belongs to the vm-manager, which the backend cannot ask, so it is shown empty.
  - **Health:** Postgres, Redis, the vm-manager (with its count of containers and awake ones), LiteLLM and Composio (with its key checked), each within 3 seconds, as ok, error or off, with a short message. It also shows the backend's version and the deployed commit, which `deploy.sh` now passes on as `GIT_COMMIT`.
- **Cost and speed:** nothing for users. Each page is read only when an admin opens it. The health page sends one small request to LiteLLM and one to Composio each time. The timings summary reads at most 20,000 turns.
- **Contracts:** `openapi.yaml` grew by eight admin operations, all tagged `admin`: `GET /v1/admin/jobs`, `GET /v1/admin/jobs/counts`, `POST /v1/admin/jobs/{queue}/{jobId}/retry`, `DELETE /v1/admin/jobs/{queue}/{jobId}`, `GET /v1/admin/audit`, `GET /v1/admin/timings/summary`, `GET /v1/admin/config` and `GET /v1/admin/health`. Nothing existing changed. `vm.proto` did not change.
- **Database:** none. No new table and no migration.
- **How it was checked:**
  - New backend tests: every new operation answers 401 without a session and 403 to a user who is not an admin; the jobs list with ids only, the error scrubbed, and planted fake secrets (a message, a token, a key, a Telegram bot token, a password) never in the answer; waiting jobs with and without a priority, delayed jobs with the time they are due; paging through one queue and through all four without repeats; retry only of a failed job, with a reason, audited, and running exactly once more; remove only of a failed or finished job, never a running, waiting or delayed one; the audit log's filters, paging, newest first, and secrets removed at any depth; the timings math on sample turns (median, 90th percentile, wake kinds, routes, engines, the 20 slowest) and the window of days; the settings page with planted secrets, which shows none of them; the health page with each service ok, off, a refused key and the vm-manager down.
  - Lint, the type check and the contract check pass. 677 of 678 backend tests pass; the one failure is the Hindi title test, which already failed before.
  - Not on the server.
- **Still open:**
  - The awake cap can be shown only if the vm-manager says it. A small new call in `vm.proto` could return it with the number of awake containers. Not built; for your decision.
  - The jobs list pages by position. A job that changes state while someone pages can be shown twice or skipped.
  - Removing a finished job lifts, for that job, the 7-day guard against the same job being added twice. Its own "already done?" check still stops double work.
  - Restarting the api or the worker by hand with `./dc up -d` leaves the commit empty until the next `deploy.sh`, as it already does for `AGENT_IMAGE_VERSION`.
  - The admin panel has no screens yet.
- **Docs updated:** `backend-report.md` sections 3, 31 (new parts: "Jobs", "The audit log", "Turn timings", "Settings", "Health"), 37, 41 and 42.
- **Commits:** backend `9ded30d`, `87d7fa9`, `d8e75d4`, `4e13077`, `176a382`.

### 14 October 2026: admins can change a role, suspend an account, delete one, and sign a user out

- **Where it is:** on `main` since 14 October, in the backend. It reaches the server with `deploy.sh`, which also adds the two new columns.
- **Why:** the admin tools could hand out and take back credits, but not act on an account. Making someone an admin meant editing Clerk by hand, there was no way to stop an abusive account short of deleting it in Clerk, and no way to sign a user out.
- **What the user notices:**
  - Nothing, unless an admin acts on their account.
  - A suspended user: the web app gets "account suspended" on every call (403, code `account_suspended`), so it can say so. Telegram messages are saved but not answered, with one short notice a day at most: "Your Textcrew account is suspended, so I can't answer messages right now." Automations stop. When the suspension is lifted, everything works again and the automations come back (or wait for credits, at zero). Messages sent while suspended stay unanswered.
  - A deleted user: the same as deleting their own account.
  - A user signed out by an admin: asked to sign in again within about a minute.
- **Backend:**
  - **Four admin tools,** each with a required reason and one activity-log row holding the admin's id and that reason. The user's own activity list shows a plain line ("An admin suspended this account"), never the reason.
  - **The role** is set in Clerk first, in the user's public metadata, through Clerk's Backend API, then on our own row at once. Clerk's next "user updated" webhook carries the same role. An admin cannot remove their own admin role. A suspended account cannot be made an admin.
  - **Suspend:** the account gets a status, owned by the sign-in part of the backend. While suspended, every signed-in call is refused, the live stream too; the container's calls to the platform's tools and the git gateway are refused; chat messages are saved, marked handled and not answered; no turn runs and the container is never woken, also for a web message, an automation's run or a crew job queued just before. Automations that are on, or paused for lack of credits, are paused with a new reason, "suspended" (kept apart from "admin", which support uses to pause one automation). The container is stopped politely through the vm-manager; while a turn runs the vm-manager refuses, and the idle check stops it 3 minutes after the turn. The admin's answer says whether it stopped at once.
  - **Unsuspend:** the account works again; the automations paused by the suspension come back on, or, at zero credits, wait paused for lack of credits.
  - **Delete:** the admin types the user's email as a check. The user is deleted in Clerk, the account is marked deleted at once, and the same deletion job as a user's own deletion runs (the container and folder through `DeleteSandbox`, keys, connections, automations, chats, messages, files, memories; the subscription set to not renew). The log row keeps only the admin's id, the user's id and the reason.
  - **Sign out everywhere:** every active Clerk session of the user is ended.
  - An admin cannot suspend or delete themselves, nor another admin before taking their role away. Repeating an action changes nothing and writes no second row.
  - Decided here: one notice a day per chat rather than none, so a Telegram user is not left guessing; a suspension does not ban the user in Clerk (they can still sign in, and the web app gets the clear `account_suspended` answer instead); held messages are never answered later; a paid subscription keeps renewing during a suspension.
- **Cost and speed:** each call from a container to the platform's tools or the git gateway, and each turn, reads the account's status once more: one small database read. Not measured.
- **Contracts:** `openapi.yaml` changed: five new admin operations (`PUT /v1/admin/users/{userId}/role`, `POST .../suspend`, `POST .../unsuspend`, `POST .../sessions/revoke`, `DELETE /v1/admin/users/{userId}`), the error code `account_suspended`, and the automation pause reason `suspended`. The web app should show a clear "account suspended" screen on that code. `vm.proto` did not change.
- **Database:** two new columns on `users`, owned by the sign-in part: the status (active or suspended) and when the suspension started (migration 0021). No new table.
- **How it was checked:**
  - New tests: every tool is admin-only (403 for a normal user, 401 without a session) with the error shape; a blank reason is refused; an unknown user is 404; the role is set through the Clerk stand-in and applies at the next request, the following Clerk webhook keeps it, setting it twice writes nothing, removing your own admin role is refused and Clerk is not asked, Clerk down or not set up answers 503 and changes nothing; a suspended user is refused on the profile, the automations list, sending a web message and the live stream, the container's tool call and git call are refused, two Telegram messages are saved and not answered with exactly one notice, no wake and no delivery, a turn queued before does nothing, suspending twice writes one row; automations are paused and resumed (the user's own pause kept, the timer removed and set again), at zero credits they wait for credits, a run that fires during a suspension goes back to paused; the container stop is asked of the vm-manager fake, and a refused stop is reported; self and admins are refused; delete refuses a wrong email, yourself and an admin, deletes in Clerk, runs the deletion job through `DeleteSandbox`, keeps no email in the log row, and Clerk down changes nothing; signing out ends the sessions and is logged.
  - Lint, the type check and the contract check pass. The 18 new tests pass, three runs in a row. The whole suite: 677 of 680 pass. The three failures are not from this change: the Hindi title test, which already failed before, and two Jev-routing tests that depend on timing; they pass when run alone (3 runs of 3), and one of them failed the same way on `main` without this change.
  - Not run against the real Clerk, nor on the server.
- **Still open:**
  - The web app needs a screen for `account_suspended`, and the admin panel needs buttons for these tools.
  - A live stream already open when an account is suspended stays open until it reconnects.
  - Whether a suspension should also cancel a paid subscription is your decision; today it does not.
- **Docs updated:** `backend-report.md` sections 4, 6, 13, 17, 18, 31 (new parts on the account tools), 33, 38, 40, 41 and 43.
- **Commits:** backend `e95e033`, `d8cc52f`, `560f17b`, `a7cee95`.

### 14 October 2026: every turn says where its time went; a greeting no longer waits for each step in turn

- **Where it is:** on `main` since 14 October, in the backend and the vm-manager. It reaches the server with `deploy.sh`, which also adds the new table.
- **Why:** you said replies take far too long, even for a simple check. Your server showed it: a greeting 4 to 10 seconds, a calendar check 36 seconds, research handed to Scout 4 to 6 minutes. Nothing recorded where a turn's time went: only when the message and the answer were saved, and when the event was handled.
- **What the user notices:**
  - A greeting on the quick-reply path comes back sooner: the quick reply is written while Jev decides, so it waits for the slower of the two, not for both.
  - A task that finds the container asleep starts sooner: the container starts waking while Jev decides.
  - A message sent right after an answer starts within a quarter of a second of the turn before it ending, not up to 2 seconds later.
  - Nothing changes in what the answers say.
- **Backend:**
  - **Every turn is timed.** When a turn ends, whatever the outcome, it writes one row with the moment of each stage: the queue (the per-user lock included), preparing the message, the route (Jev and the quick reply, each apart), the wake (warm, cold, room made under the awake cap, or a container made again, with the vm-manager's own parts), building the turn, the hand-over to the container, and the Bridge's own report (below). Only stage names, times, ids and counts: never the message or the answer. A retried job writes the row again. Rows are kept 30 days and removed with the account.
  - **A new check for you:** `scripts/dev-user.ts timings --email <your email> [--last 10]` prints each of the last turns, stage by stage, how long you waited for the answer, and a line on the biggest stage, then the middle answer time and the stage most often the biggest.
  - **The quick reply is written while Jev decides** for a message of up to 200 characters. It is used only when Jev says "simple" and the cheap model did not pass it on; otherwise its request is stopped. The cheap model is also told to pass on a follow-up (a yes, a no, a choice), next to what it already passed on.
  - **The container starts waking while Jev decides.** A message that turns out simple leaves it idle until its idle stop. The setting `WAKE_WHILE_ROUTING` (on unless set to `false`) switches this off.
  - **The per-user lock:** a job that finds it taken looks again after a quarter of a second during its first 10 seconds of waiting, then every 2 seconds as before.
  - **An app's Composio actions are listed once per 10 minutes,** for every user, instead of at every `list_app_actions` call. A failed listing is not kept.
  - The agent settings are read once per turn, while the container wakes, instead of three times one after the other.
- **vm-manager:**
  - **The Bridge times every turn** and reports it with the turn's last event: the engine's start, Claude Code ready (its tool servers asked), the model's first response and the start of its thinking (web chat turns), the lead's first words and first tool call, the time in the lead's tools and in the crew, the engine's end and the answer sent. Claude Code adds its own numbers: its total, the time in calls to the model, the model rounds, and the prompt cache's token counts.
  - **A wake says where its time went:** a wait for another operation on the container, making room under the awake cap, a container made again, the container start, and the Bridge's ready check. It also writes one log line with them.
  - **Fewer waits:** each answer goes to the platform's tool server in one request instead of three, after one introduction per container start. Claude Code's two settings files are written only when they change. On Hermes, the second "the crew is done" check comes half a second after the first, not 2 seconds.
- **Cost and speed:**
  - Nothing was measured: there is no real model, Docker or server here. The timings exist so the next turns on the server measure it.
  - A greeting on the quick-reply path saves Jev's time, usually under a second (the setting says Jev is sub-second; 3 seconds at most), plus the two small reads before it. The cheap model's own time, Llama 3.3 70B through OpenRouter, stays: estimated 1 to 5 seconds, and most likely the main part of the 4 to 10 seconds you saw.
  - A task with the container asleep saves up to the routing time, estimated under 1 to 3 seconds; with the container awake, nothing.
  - A message right after an answer saves up to 1.75 seconds when it meets the end of the turn before. Each answer saves two round trips through the egress proxy, estimated tens of milliseconds. A repeated app listing saves one Composio request per app, estimated 0.3 to 2 seconds each time the lead lists its apps. On Hermes a crew round saves up to 1.5 seconds. Settings read once and files not rewritten: milliseconds.
  - What costs more: a short message's quick reply is asked for even when Jev then says "task"; it is stopped at once, so a few hundred tokens of the cheap model at most. A greeting now wakes a sleeping container: about a third of a credit of awake time, and a place under the awake cap for 3 minutes. Both are off when Jev is not set up, and nothing changes for a Claude-plan user, who never reaches Jev.
  - The new table adds one small row per turn.
- **Contracts:** `openapi.yaml` did not change. `vm.proto` grew, without breaking anything: `WakeSandboxResponse.timings` (a new message, `WakeTimings`) and `DeliverEvent.timings_json`. An older vm-manager or Bridge leaves them empty and the turn is timed without them; an older backend ignores them. The two can be deployed in either order.
- **Database:** a new table, `turn_timings`, owned by the orchestrator (migration 0020).
- **How it was checked:**
  - Backend: new tests for the quick reply written while Jev decides (the model is asked before Jev answers; a "task" stops it; a long message waits for Jev; a follow-up is passed on), the wake while routing (before Jev answers, once; idle after a simple message; off with the setting; a failed wake does not fail a simple message), a Claude plan never reaching Jev, the timings row (each stage, the wake's kind and parts, the Bridge's report placed after "accepted", out of credits, a retried turn keeping its last try, no text anywhere), a Bridge report with anything but names and numbers refused, the lock (picked up within 0.9 s of the lock coming free; the same test with the old 2-second wait failed at 1.4 s), the Composio listing kept and refreshed, and the `timings` command. Four routing tests were changed: a greeting now wakes the container, and a dropped quick reply is asked for once and stopped.
  - Lint and the type check pass. 659 of 660 backend tests pass; the one failure is the Hindi title test, which already failed before.
  - vm-manager: new Go tests for the wake's parts (cold, warm, room made, a new image) over the manager and over gRPC, and for the Bridge's report passed on (and refused when it is not a JSON object of at most 16 KiB). New Bridge tests for the clock, the report on the last event, Claude Code's marks with the fake CLI (web chat and chat app, the crew), Hermes's marks with a fake Hermes, one introduction to a stateless tool server, the half-second crew check and the files not rewritten. `go vet`, the linter (0 issues) and the Go tests pass; 239 Bridge tests pass.
  - Not run on the server, not with the real Claude Code binary, not with a real model.
- **Still open:**
  - After the deploy, send a few messages (a greeting, a calendar check, a research task), then run `cd /opt/textcrew && ./dc --profile app exec -T api node --import tsx scripts/dev-user.ts timings --email <your email> --last 10`.
  - By the code, a user whose AI is a connected Claude plan never takes the quick-reply path: every message, a greeting too, goes to Claude Code. If your greetings came back with no container, your account was on another AI at that moment. The `route` and `engine` of each turn in the timings will say which.
  - Most likely, for you on Claude Code with Opus 5.5 at medium: "first output" and "work" are the biggest stages (the model thinking, and each tool call being one more model round), then "wake" when the container was asleep (it sleeps after 3 idle minutes), then "engine start". Our own stages before the hand-over should be well under a second. Options, for your decision, none built: a lighter model or a lower effort for a simple message on Claude Code (Jev could pick it, still in the same Claude session); a longer idle time before a container sleeps (`IDLE_TIMEOUT`, which costs awake credits); waking the container when you start typing (the web app would call a small wake endpoint when the message box gets focus); a faster quick-reply model (OpenRouter's `:nitro` variant of the same model, or another provider, in LiteLLM's settings); and starting Hermes later in a Claude Code container, so it does not share the one CPU with the first turn after a wake.
- **Docs updated:** `backend-report.md` sections 3, 9 (a new part, "Where a turn's time goes"), 14, 32, 34, 37, 40 and 42; the vm-manager's README ("gRPC", "Bridge contract" with a new part "Stage times", "Claude Code runtime", "The crew", "Not verified yet").
- **Commits:** backend `368c539`, `6518ca5`, `09733c1`, `ea55c02`, `1209605`, `0b8aa23`; vm-manager `029e250`, `6c6c8c3`, `1f88203`, `a70c319`, `a98b68f`.

### 14 October 2026: the Automations chat can't be deleted

- **Where it is:** on `main` since 14 October, in the backend. It reaches the server with `deploy.sh`.
- **Why:** you saw "Delete the Automations chat?" in the menu of the pinned Automations chat and don't want it deletable. Every run of every automation answers there, so it should always be there.
- **What the user notices:**
  - The pinned Automations chat has no menu any more, so there is nothing to delete it with (the web app's part, described in its README).
  - Asked to delete it all the same, the api refuses with "The Automations chat can't be deleted", the way it already refused a rename. Nothing changes and nothing goes into the activity log.
  - Deleting the account still removes it, with everything else.
- **Backend:**
  - **Deleting a conversation** answers 409 when it is the Automations chat. Every other conversation is deleted as before; one that isn't the user's still answers 404.
  - **The yearly clean-up** of old conversations that are empty and not active now leaves the Automations chat too. Before, one with no run for a year would have been removed. It now goes only with the account.
  - **The safety net stays:** should the Automations chat be missing all the same, the next run starts a new one, with a number never used before, and never answers in the conversation the user has open.
- **Cost and speed:** none. A delete reads the conversation once more before it starts.
- **Contracts:** `openapi.yaml` changed: `DELETE /v1/conversations/{conversationId}` lists the 409 and says the Automations chat cannot be deleted, and the conversation's `kind` says so too. The web app has the new copy. `vm.proto` did not change.
- **Database:** none.
- **How it was checked:**
  - New backend tests: the delete answers 409 with the error shape, the chat and its runs stay, the activity log gets nothing, another user gets 404, and the next run still answers there; a missing Automations chat is started again by the next run; deleting the account removes it; the yearly clean-up leaves an old, empty one. The 409 test and the clean-up test failed on the old code.
  - Lint and the type check pass. 646 of 647 backend tests pass; the one failure is the Hindi title test, which already failed before.
  - Not on the server.
- **Docs updated:** `backend-report.md` sections 8, 18, 37, 41 and 44; `hld-mvp.md` section 5.4.
- **Commits:** backend `c8b4f87`, `88df748`, `dba41ce`.

### 13 October 2026: Tex knows who it is, and sees every app the user connected

- **Where it is:** on `main` since 13 October, in the backend and the vm-manager. It reaches the server with `deploy.sh`.
- **Why:** you connected Google Calendar in the web app, with the server making Calendar's Composio setup itself. In web chat Tex then said that only GitHub was connected, and told you to check "your Claude settings". Two problems: Tex did not know it is Textcrew's agent, and Calendar was not usable even though it was connected.
- **What the user notices:**
  - Tex speaks as the user's agent in Textcrew. It sends the user to Textcrew's Apps page to connect an app, never to Claude's settings, and does not call itself Claude or Claude Code.
  - An app the user just connected can be used right away, next to GitHub.
  - When an app is not ready, Tex says so plainly: "Google Calendar is still connecting", or that it needs connecting again on the Apps page.
- **Backend:**
  - **The cause, most likely:** to list the actions Tex may run, the server asked Composio once for all connected apps, with one limit of 200 tools for all of them, and kept the first 100. GitHub alone has more than 200, so Google Calendar's actions never reached Tex. Now Composio is asked once per app, and the 100 places are shared fairly: an app with few actions gets them all, the rest goes to the big ones, and a cut-short app comes with a note on how to see more.
  - **The agent's answer names every app** with its status: connected, still connecting, never finished, needs connecting again, or not on the plan, with a note saying what to tell the user and the Apps page address. `get_profile` lists the apps that are not ready too.
  - **The agent's own tools check a pending connection with Composio first,** so an app that finished connecting a moment ago is usable in the same turn. Before, only the web app's app list and the worker's six checks did.
  - **Each check asks about the connection's own account.** It used to read the user's whole list of accounts at Composio, which comes in pages, so a new account could be missed for good.
  - **A setup the server reuses** must be one Composio says is for the same app.
  - **A new check for you:** the dev-user script's `apps` command prints each connection with our status, its Composio account id, what Composio says, its setup, and what Tex sees. Every command of the script now takes `--email` in place of `--user`.
- **vm-manager:**
  - The lead's instructions open with a short identity block, the same on both engines: Tex is the user's own agent in Textcrew; apps are connected on the Apps page, `https://app.textcrew.in/apps`; `get_profile` and `list_app_actions` show what is connected; a missing app may still be finishing or needs connecting again; never Claude's settings, never "I am Claude", the engine named only when the user asks. Claude Code's own system prompt says "You are Claude Code", which is what made Tex talk about Claude's settings.
- **Cost and speed:** a listing of apps now makes one Composio request per connected app instead of one in all, at the same time. A pending connection costs one small Composio request when Tex looks at the apps. The instructions grow by about 900 characters a turn. Not measured.
- **Contracts:** `openapi.yaml` and `vm.proto` did not change. The answer of the agent's tool `list_app_actions` changed shape: it was a list of actions, it is now the apps and their statuses, and the actions.
- **Database:** none.
- **How it was checked:**
  - New backend tests reproduce each cause on the old code first: Calendar crowded out by 320 GitHub actions, a connection active at Composio but pending here and missing for the agent, and a new account missed past the first page of the list. All three failed before the fix and pass after it. Other new tests: the fair share, one app failing to list, each not-ready status and its note, the plan, `get_profile`, `run_app_action`, the setup reuse, and the dev-user `apps` command.
  - Lint and the type check pass. 644 of 645 backend tests pass; the one failure is the Hindi title test, which already failed before.
  - vm-manager: new Bridge tests check the identity block opens the instructions for every channel, kind and crew job, and reaches both Hermes and Claude Code. The 225 Bridge tests pass, `go vet` and the Go tests pass.
  - Not on the server, not against Composio itself, and not with a real model.
- **Still open:**
  - Run `scripts/dev-user.ts apps --email <your email>` on the server after the deploy, and ask Tex about your calendar again.
  - The web app says "connected" from Composio's word in the return address alone. It could show "connecting" while our record is still pending; that needs a small change to the app list's contract and to the web app.
  - Composio's webhook names only "expired" for connections. Our code reads any other connection event as "active". Not changed here.
- **Docs updated:** `backend-report.md` sections 13, 14 and 34; `composio.md` sections 3, 4, 8 and 11; the vm-manager's README ("The crew").
- **Commits:** backend `adbd533`, `8343501`, `84ec22d`, `6ad5d3b`; vm-manager `6481354`, `edd6191`.

### 13 October 2026: a separate Automations chat for every automation

- **Where it is:** on `main` since 13 October, in the backend. It reaches the server with `deploy.sh`.
- **Why:** you decided that automation results should not mix into the user's normal chats at all: "we can have a separate automation chat channel". Until now a run in web chat answered in the conversation the automation was made in (or one named after it), and a Telegram run answered in the chat's current conversation.
- **What the user notices:**
  - Every run answers in one conversation of its own, the Automations chat: reminders, repeating automations, app events, pull-request review verdicts, and the notices "out of credits" and "paused after 3 failures". Wherever the automation was made.
  - The Automations chat is never made the active conversation, so the user's next message never goes into it by accident. The user can open it and write there; the agent then answers with the runs in mind.
  - An automation made on Telegram still reaches Telegram: a copy of each answer arrives there, with the automation's name on the first line ("⏰ Daily open PRs and issues") and, on the last line, that the follow-up happens in the Automations chat of the web app, with a link that opens it.
  - The Automations chat keeps its name. If the user deletes it, the next run starts a new one.
- **Backend:**
  - **The Automations chat:** a conversation of its own kind, one per user, in web chat with a number of its own, so the agent keeps a separate context for it. It is started when the user makes an automation and has none, or at the next run. Two runs at the same moment start one between them.
  - **Writing in it:** a message sent into it does not make it active. Renaming it, or making it active, is refused.
  - **The copy on Telegram:** after a run, the worker finds the run's reply (every message written during a turn now carries the turn's id) and sends a copy to the Telegram chat the automation was made in. The copy is saved in that chat's current conversation, marked as a copy, and is left out of everything that gives the agent context there (the router and the recap). A message is copied once, so a job that runs again sends no second copy. No copy goes to a chat that is unlinked, blocked or switched off.
  - **If the user deletes the Automations chat during a run,** the run's answer starts a new one; it never falls back to the conversation the user has open.
  - **The agent is told** where the runs of an automation it makes will answer, so it can say so.
  - This morning's conversation per automation is gone. The conversations it made stay as ordinary chats.
- **Cost and speed:** no extra AI cost. One more database lookup per run, and one more short message to Telegram for an automation made there. Not measured.
- **Contracts:** `openapi.yaml` gained a `kind` on each conversation (`chat` or `automations`) and a `kind` filter on the conversation list, and says that renaming or activating the Automations chat answers 409. Only additions. `vm.proto` did not change.
- **Database:** one migration that only adds: the kind of a conversation (at most one Automations chat per user), and on a message the message it copies (usable once) and an index to find a turn's messages. The automation's conversation column from this morning stays, unused, so a server still on the older code during a deploy keeps working; a later change can drop it.
- **How it was checked:**
  - New and changed backend tests: runs from automations made in web chat, on Telegram and from the web app all answer in the one Automations chat; it is never made active and the next message goes where it went before; a deleted one is started again with a new number; two runs at once start one; the user's message there continues its context; renaming and activating it are refused; the Telegram copy is sent once, also when the job runs again, and is not in the Telegram conversation's context; no copy to an unlinked chat; pull-request verdicts and both notices go there.
  - Lint and the type check pass. 629 of 630 backend tests pass; the one failure is the Hindi title test, which already failed before.
  - Not yet on the server.
- **Still open:**
  - No real run has gone through it on the server, on Telegram or with a real model.
  - A user who answers a run's copy on Telegram reaches an agent without the run in mind. Your decision: leave it, or later carry such an answer into the Automations chat (`hld-mvp.md`, section 12).
  - The unused column `automations.conversation_id` can be dropped in a later change.
- **Docs updated:** `backend-report.md` sections 8, 9, 10, 12, 13, 18, 19, 20, 26, 40, 41, 43 and 44; `hld-mvp.md` sections 5.4, 5.5 and 12.
- **Commits:** backend `9d41814`, `cd73229`, `2ad3ace`, `8211146`, `69d294e`.

### 13 October 2026: proper jobs for Patch and Byte

- **Where it is:** on `main` since 13 October, in the backend and the vm-manager. It reaches the server with `deploy.sh`.
- **Why:** Patch only reviewed pull requests automatically, and Byte only worked from chat. Neither could be given a brief, neither said where its report should go, and neither cleaned up the programs it started.
- **What the user notices:**
  - **Giving a job:** a job can be given to Patch or Byte from the web app or from chat, for example "Patch, review acme/web PR 42, run pnpm test, post it on the PR". The brief names the repo, the branch or pull request, and what to do.
    - **For Patch:** what to focus on (bugs, security, tests, speed, style) and the commands to run.
    - **For Byte:** what to fix or build, what to test for, and whether to open a pull request or only push a branch.
  - **Where the report goes:** it always comes to the user's chat. It can also be posted on the pull request, or opened as a GitHub issue.
  - **The report's shape:** the verdict, the findings by file and line, the tests that were run and their results, and what was not checked.
- **Backend:**
  - **Running a job:** the brief is saved and run as one turn of the agent, on the same per-user queue as messages, so it never runs twice. The platform writes the instruction from the brief; nothing written on GitHub is put into it as an instruction. The report is kept on the job.
  - **The repo list:** a list of the user's GitHub repositories, through Composio, so one can be picked.
  - **What "post it on the pull request" allows:** exactly one review of the "comment" kind on that pull request, for that job. Merging, approving, closing and pushing to the main branch are never allowed. A job started from chat must still be approved before it posts, because the platform cannot tell that the request really came from the user.
  - **Limits:** at most 5 jobs waiting and 20 an hour.
  - **After a job:** the container is put to sleep right away instead of after 3 idle minutes.
- **vm-manager:**
  - **A folder per job:** inside the container, each job gets a folder of its own. When the job's turn ends, whatever happened, the Bridge stops every program the job started and deletes the folder. Folders left behind are cleared when the container starts.
  - **Patch's parallel reviews:** Patch may split a large review into up to 3 parallel reviews.
  - **Sign-in safety:** a polite stop now also waits while a Claude sign-in is waiting for its code.
- **Cost and speed:** a job costs what a turn costs, plus 1 credit for each review, issue or pull request it creates. The container sleeps sooner after a job, which saves awake time. Not measured.
- **Contracts:** `openapi.yaml` gained the crew jobs (`/v1/crew-jobs`) and the list of the user's GitHub repos (`/v1/github/repos`). `vm.proto` did not change.
- **Database:** a new table, `crew_jobs`.
- **How it was checked:** new tests in the backend and the vm-manager, including real programs being started and stopped for the clean-up. Backend 625 of 626 tests pass (the one failure is the Hindi title test, which already failed before). The vm-manager's tests all pass.
- **Still open:**
  - A real run against GitHub in a real container.
  - The clean-up inside the container's gVisor sandbox.
  - On Hermes, the clean-up finds a job's programs by its folder only.
  - What Composio's repo-list action really returns.
- **Docs updated:** `backend-report.md` sections 13, 15, 19, 20, 32, 33, 34, 40, 41, 43 and 44; `hld-mvp.md` sections 2, 5.6 (new; the two after it renumbered) and 12; the vm-manager's README.
- **Commits:** backend `6c3b1b6`, `43e58ed`, `74595fa`, `ffde17a`, `b596c81`, `225e9d0`, `09b8fce`, `e9327a9`, merged in `4790b72`; vm-manager `f057f96`, `9b02bce`, `370ab8b`, merged in `af7dcf2`.

### 13 October 2026: replies appear in web chat as they are written

- **Where it is:** on `main` since 13 October, in the backend and the vm-manager. It works only once the server is deployed.
- **Why:** web chat showed "Tex is working…" and then the whole answer at once, which felt slow.
- **What the user notices:**
  - In web chat, Tex's answer appears a few words at a time, then becomes the normal message.
  - A sentence Tex writes just before using a tool ("Let me check your calendar.") shows briefly, then "Tex is working" comes back while the tool runs.
  - Only Tex's own answer streams, not the crew's work.
  - Telegram is unchanged: it still gets one finished message.
- **Backend:** for web chat turns only, the worker asks the container for the answer as it is written and passes each version on to the web app's live stream. It saves nothing extra: the final answer is saved exactly as before. If a turn fails, the half-written answer is cleared before the apology. A slow connection gets only the latest version.
- **vm-manager:**
  - **The Bridge:** about four times a second, it reports the whole text so far of the lead's answer. It reads it from Claude Code's partial messages, or from Hermes's own text events. The text starts over at a new message, a tool call, a crew round or a restarted session. Hermes's "connection dropped, reconnecting" notice is left out.
  - **The vm-manager:** passes these reports on to the backend.
- **Cost and speed:** no extra AI cost. A little more traffic inside the server during web chat turns. Not measured.
- **Contracts:** `vm.proto` gained the event type `TEXT_DELTA` (value 5). `openapi.yaml` gained the live-stream event `message.draft`. Both only add.
- **Database:** none.
- **How it was checked:**
  - New tests in the backend and the vm-manager, and all their checks pass.
  - The real Claude Code program (2.1.296, the version now pinned) ran through the Bridge against a stand-in AI service: the text grew in steps until it equalled the final answer, with none of the model's thinking in it.
- **Still open:** not yet run on the server, with a real model, or with Hermes itself. Hermes's text events were read in its source code only.
- **Docs updated:** `hld-mvp.md` sections 5.2 and 12; `backend-report.md` sections 9, 12 and 34; the vm-manager's README and build report (section 15).
- **Commits:** backend `9d66044`, `252b9d9`, `2e441cd`, `31eac52`, `332cd83`, merged in `6f7b746`; vm-manager `8736533`, `909508d`, `bcc6576`, `4cb3e82`, `4cea44c`, merged in `ed9e2c3`.

### 13 October 2026: automations answer in their own conversation, say when they are late, and keep the user's time zone

- **Where it is:** on `main` since 13 October, in the backend. It reaches the server with `deploy.sh`.
- **Why:** on 13 October a summary of open pull requests appeared in the middle of an unrelated web chat ("hlo") at 3:01 PM India time. Three things caused it:
  1. An automation answered in whatever conversation was open at the time.
  2. Every account was on UTC, so a time like "9 in the morning" meant 2:30 PM in India.
  3. The run was late because the server had been off, and nothing said so.
- **What the user notices:**
  - In web chat, an automation answers in the conversation it was made in. If there is none, or it was deleted, it answers in a conversation of its own named after the automation. It never answers in the conversation that happens to be open.
  - A run that starts more than 10 minutes after it was due says so, and says when it was due.
- **Backend:**
  - An automation remembers the conversation it was made in.
  - **The time zone:** the account now records whether its time zone was ever set. The web app uses this to set a new account's time zone from the browser once, without ever replacing one the user chose.
  - **Fixed a bug where a missed run could be dropped:** when the worker started, setting an automation's timer again replaced a run that had come due while the worker was off. Such a run now runs late instead of being dropped.
  - A run rebuilt after the job queue lost its jobs still knows its automation and when it was due.
- **Cost and speed:** none worth measuring: one more database lookup per run.
- **Contracts:** `openapi.yaml` gained one field in the account answer (`timezoneSet`). The change only adds a field. `vm.proto` did not change.
- **Database:** two new columns: whether the user's time zone was ever set, and the automation's conversation. Every account whose time zone is not UTC was marked as set.
- **How it was checked:** 14 new backend tests; all backend checks pass. Not yet on the server.
- **Still open:**
  - **Replaced:** you chose a separate Automations chat for every run (13 October). See the entry "a separate Automations chat for every automation", above.
  - The container's own clock stays on UTC. Automations use the account's time zone, so this does not change when they run.
  - Someone who chose UTC in Settings before this change gets the browser's time zone once.
- **Docs updated:** `backend-report.md` sections 8, 18, 19, 40, 41 and 44; `hld-mvp.md` sections 5.4 and 12.
- **Commits:** backend `e86c91b`, `bc6f342`, `e6470a1`, `27eb459`, `243fa22`, `61570bb`, merged in `dfff18d` (its database change renumbered to 0017).

### 13 October 2026: straight to Google or GitHub with our own sign-in app, and more apps

- **Where it is:** on `main` since 13 October, in the backend. It reaches the server with `deploy.sh`.
- **Why:** connecting an app showed Composio's logo and name. Only Gmail and GitHub could be connected.
- **What the user notices:**
  - For an app that uses our own sign-in app, connecting goes straight to Google's or GitHub's page, with no Composio page on the way.
  - More apps can be connected once you switch them on (see "Still open").
- **Backend:**
  - **Our own sign-in app:** when an app's Composio setup uses our own sign-in app (a Google or GitHub app registered by us), the connect link goes straight to the provider. Composio's shared sign-in still goes through Composio's page: Composio forces that since July.
  - **More apps:** a new setting, `COMPOSIO_MANAGED_APPS`, lets the server make an app's Composio setup by itself the first time someone connects it. It is off until you turn it on. The setups it makes are kept in a new table.
  - **Each app's description:** each app now says whose sign-in comes next and, in one sentence, what Tex can do with it, so the web app can show that before the sign-in.
  - **The way back:** a new address, `api.textcrew.in/oauth/callback`, can carry users back from a sign-in through our own domain. It only forwards to Composio and saves nothing.
  - **Fixes on the way:**
    - The address users return to after a sign-in must now be exactly our web app. Before, any address that only started with it was accepted, which a bad link could misuse.
    - A second account of the same app now works.
    - Composio failing during a connect is now a clear "try again" (503) instead of a server error.
- **Cost and speed:** no change for apps that already work. Apps on Composio's shared sign-in count against Composio's smaller free limits.
- **Contracts:** `openapi.yaml` gained two fields on each app (whose sign-in comes next, and what Tex can do with it), a 503 answer on connect, and the `/oauth/callback` address. `vm.proto` did not change.
- **Database:** a new table, `composio_auth_configs`, for the app setups the server made itself.
- **How it was checked:** 22 new backend tests, with Composio stood in for: there is no Composio key on the cloud machine. All backend checks pass. Nothing has run against the real Composio yet.
- **Still open, your steps** (written out in `composio.md`, sections 8 and 9):
  1. **More apps:** set `COMPOSIO_MANAGED_APPS=all` in the server's `beckend/.env`, then restart the api and the worker.
  2. **Our logo on Composio's page:** in Composio's dashboard, Project Settings → White Labeling → Branding, set the title "Textcrew" and our logo.
  3. **No Composio at all for GitHub:**
     - Register our own GitHub sign-in app. GitHub needs no review.
     - Make a Composio setup that uses it.
     - Put its id under `github` in `COMPOSIO_AUTH_CONFIGS`, then restart.
  4. **Gmail the same way** needs Google's review and a yearly outside security check, six weeks or more. Until then Google shows an "unverified app" warning and allows at most 100 users.
  5. **Existing users** keep the old setup until they disconnect and reconnect.
- **Docs updated:** `composio.md` (new sections 8 and 9), `backend-report.md` (sections 2, 14, 40, 41, 42 and 44), `hld-mvp.md` (sections 10 and 12).
- **Commits:** backend `51c80a6`, `15fc42c`, `36cdf6f`, `292726c`, `202afa3`.

### 13 October 2026: every Claude model Claude Code can use

- **Where it is:** on `main` since 13 October, in the backend and the vm-manager. Not on the server yet: the agent image has to be rebuilt there.
- **Why:** with a Claude plan connected, the model choice offered only four models, and one of them (Haiku 4.5) was out of date.
- **What the user notices:** the model choice lists every model Claude Code can use. The four current ones (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1) come first. The nine older ones Claude still offers come after them. Each model says which effort levels it takes. Both Fable models carry a note: on Pro they are paid with usage credits, and on Max they may use up to half the weekly limit before credits.
- **Backend:** the list of models is kept by hand in one place, because Claude has no way to tell an app which models a plan allows. Each model now says its group (current or older), its effort levels, and an optional note. Choosing an unknown model is still refused, and a saved model later taken off the list still reads as "Default".
- **vm-manager:** the agent image now installs Claude Code 2.1.296 instead of 2.1.283. The old version did not know Sonnet 5.5 or Haiku 5.5. The Bridge needed no change: it already passes any well-formed model name to Claude Code.
- **Cost and speed:** no change for us. A user who picks Fable on a Pro plan spends their own Claude usage credits without being asked again, because Claude Code works that way when it runs without a screen. The note warns them before they pick it.
- **Contracts:** `openapi.yaml` gained three fields on each model choice (group, effort levels, note). The change only adds fields. `vm.proto` did not change.
- **Database:** none.
- **How it was checked:** new tests save every model and check it reaches the turn, check the list's shape, and send all 13 names through the Bridge to Claude Code. Backend and vm-manager checks pass. The 13 names and their effort levels were checked against Anthropic's model pages and against the model table inside Claude Code 2.1.296 itself.
- **Still open:** the agent image has not been built with 2.1.296 (its download could not be checked from the cloud machine), and no real turn has run on it yet. Whether a given plan really allows each older model has not been tried.
- **Docs updated:** `backend-report.md` (the Claude Code model and effort part), `hld-mvp.md` section 2, the vm-manager's README and build report (section 14).
- **Commits:** backend `2c00d15`, `5c2a38b`, `3ae170a`; vm-manager `6504752`, `bb742c1`, `47d0290`.
