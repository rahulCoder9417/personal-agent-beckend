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

### 16 October 2026: small items from the hand-off (flaky tests, reminders, Hermes's crew, the live stream, Neon docs)

- **Where it is:** on the branches `fix/small-items-oct16` (backend), `fix/hermes-crew-model` (vm-manager) and `feat/stream-replay` (web app), pushed, not on `main` yet. Not on the test server.
- **Why:** five small things left over from the hand-off. (1) Seven test files failed now and then when the laptop was busy, and passed alone. (2) `schedule_reminder` was refused only during an automation's run, while other turns also have text in mind the user did not write (`backend-report.md` section 43). (3) On Hermes, Byte and Patch ran at Tex's low effort, because LiteLLM could not tell their calls from Tex's; on Claude Code they think at medium. (4) The live stream had no event ids, so after every reconnect (Vercel cuts it every 5 minutes) the web app asked for all its lists again, and whatever was sent in between was lost. (5) Some docs still said the databases were on the server.
- **What the user notices:**
  - In the Automations chat, in a crew job and in Tex's turn after an approval, a reminder is no longer set at once: Tex offers it as a draft with a Save button. Example: "and remind me at 5 to reply", written in the Automations chat, gives a draft "Reminder: reply".
  - On Hermes (Textcrew AI on Pro and Max, or their own API key), Byte, Patch and Scout think at a medium effort; Tex still answers at low. On Free nothing changes: everything stays on the cheap model.
  - The web app no longer flickers or re-asks for its lists after a short drop: a connection that comes back within about 15 minutes gets exactly what it missed.
- **Backend:**
  - **Flaky tests.** The cause, in every one of the seven: a test file shares its fakes and queues across its tests, and work a test leaves running (a wake nobody waits for, a crew job's stop, a billing or refund job, a reply going out) finished during the next test, which then counted it as its own. Two more causes: fixed waits (700 ms, 10 s) too short on a busy machine, and BullMQ jobs read before their state said "finished", which gave a finished job with no result. A database connection that was just closed also stays in Postgres's list for a moment. The tests now count only their own user's calls, wait for the work to end instead of a fixed time, read a job again after it finished, and wait for the queues to be quiet before counting queries. One more found on the way: a test removed queued runs while a worker could already have taken one.
  - **Reminders.** The note the worker keeps for the turn in progress already says what kind of turn it is and whether it is in the Automations chat. `schedule_reminder` now reads it and refuses in four kinds of turn: an automation's run, a crew job, any turn in the Automations chat, and the turn after an approval, each with its own reason, and each telling the agent to use `propose_automation` instead. If the note can't be read, it refuses too.
  - **The crew's model name.** Each user's LiteLLM key now has a second alias, `agent-crew`: the cheap model on Free, and on Pro and Max a new server model `claude-crew` (the same Claude as `claude`, the same cache marks and backup, at medium effort). With the user's own key, LiteLLM holds the key twice: the chat copy at low effort and a crew copy at medium, saved and deleted together. The tuning version went to t2, so every own-key model is saved again at the next 5-minute sync, which also gives every key the new alias. Two new settings: `LITELLM_CREW_MODEL` (default `agent-crew`) and `LITELLM_PREMIUM_CREW_MODEL` (default `claude-crew`).
  - **The live stream.** Every event but a draft also goes into a short record per user in Redis (the last 500 events of the last 15 minutes) and gets its id there, in the same step as it is published, so both have the same order. A connection that gives the last id it got (the browser's `Last-Event-ID`, or `?lastEventId=`) is sent what came after it first, then the live events, each once; `ready` says `{"resumed": true}`. When the record no longer holds that id, `ready` says `{"resumed": false}` and the web app asks for its lists again, as before. A draft carries the id of the newest event before it, so it is never sent after the end of its turn.
- **vm-manager:** the Bridge tells Hermes to have its helpers ask for `LITELLM_CREW_MODEL` (Hermes's `delegation.model`; a helper keeps Tex's LiteLLM address and key), and gives that name the same context size as Tex's, so a helper does not probe LiteLLM for it. The vm-manager passes the setting to new containers (default `agent-crew`; set it to `agent-default` to go back). Checked against Hermes's own source at the pinned commit; Hermes itself was not run.
- **Web app:** a connection the app opens itself gives `?lastEventId=`; the browser's own reconnects send the header, which the proxy already passed on. When `ready` says resumed, nothing is asked for again. A backend from before this never says it, so the app catches up as before.
- **Cost and speed:** the crew's calls on Textcrew AI think more, so they cost more credits than at low effort (not measured: no provider key with balance). The stream's record is a few hundred kilobytes of Redis per active user at most, and gone after 15 quiet minutes. A reconnect that resumes saves 4 requests to the api (messages, chat history, approvals, agent state), each a trip to Neon.
- **Contracts:** `openapi.yaml`: `GET /v1/stream` documents the event ids, the `Last-Event-ID` header and the `lastEventId` query, and a new schema `StreamReady` for `ready`. Copied into the web app. `vm.proto` unchanged.
- **Database:** none. The new record is in Redis.
- **How it was checked:** new tests for the four kinds of turn that refuse a reminder and the one that still sets it (`reminder-refusal.test.ts`), for the crew's alias on every plan, the own key's crew copy, a key made before the change getting the alias at the next sync and the LiteLLM config (`litellm-chat-tuning`, `own-key-routing`, `phase5-litellm`, `phase5-polar`), and for the stream: ids, replay in order with each event once, the header and the query, an unknown or trimmed id, and the order rule for drafts (`live-stream-replay.test.ts`). Lint and type-check pass. The whole backend suite, 1,154 tests in 100 files, passed 3 times in a row with 2 workers while the laptop also built the web app, and a 4th time with `pnpm test`: no failure in any run. vm-manager: `go vet` and `go test ./...` pass; the Bridge's Python tests, 275, pass (1 skipped). Web app: lint, type-check and its 1,012 tests pass, and it builds. Not run on the test server, and Hermes itself was not run (its settings were checked in its source).
- **Still open:**
  - Deploy order: the backend first (with LiteLLM restarted, for `claude-crew`), then the vm-manager and a new agent image. A container whose key does not have `agent-crew` yet would have its helpers' calls refused; the backend adds it to every key within 5 minutes of starting.
  - Your call: on Textcrew AI, Byte and Patch stay on the same Claude as Tex (Sonnet 5) at a higher effort. Claude Code's "Default" puts them on Opus 5.5. Opus costs more credits per call. Recommendation: keep it as built; moving them to Opus is one line in `infra/litellm/config.yaml`.
  - Your call: the reminder refusal after an approval holds in the user's own chat too ("send the email, then remind me tomorrow": the reminder becomes a draft). Recommendation: keep it; the user still gets it with one tap. And a turn from the user's own message that read their email can still set a reminder (`backend-report.md` section 43). Recommendation: leave it for now.
  - On Hermes, Scout gets the crew's medium effort too: Hermes has one setting for all its helpers.
- **Docs updated:** `hld-mvp.md` 5.2 ("Quicker answers on Hermes") and 12 (the databases on Neon moved to "Works for real"; a new entry for these fixes); `backend-report.md` sections 12 (event ids, "Catching up after a reconnect"), 13 (the `schedule_reminder` line), 18 ("No reminder when the agent has read what the user did not write"), 30 (the crew's copy of the own key; "The crew thinks harder than chat"), 34 (which model each crew member runs on), 43 (the reminder gap that is left), 44 (the number of tests); the vm-manager's README ("The crew's model", the settings list); the web app's README (the live stream's reconnects). The Neon docs (`aws-setup.md` 1, 3, 6, 7, 8, 14; `hld-mvp.md` 4; `backend-report.md` 1) were done in the first commit; one more stale line was found and fixed in `hld-mvp.md` 12.
- **Commits:** backend `c27c137`, `c9807f1`, `2261366`, `fd674b9`, `3cc21a1`, `641a226`, and the docs commit; vm-manager `99bc228`; web app `cd5a3d8`, `70e1edb`.

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
