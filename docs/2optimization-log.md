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

### 16 October 2026: only an automation's approvals go to Telegram

- **Where it is:** on the branch `feat/tg-automation-approvals` in the backend and the web app, pushed, not on `main` yet. Not on the test server.
- **Why:** the founder asked Tex something in the web app and got the approval question on Telegram as well. His words: "it should not. The approvals should be of automations to telegram and it can be turned off/on by user on the settings page." Until now every approval asked outside Telegram was copied there whenever Telegram was linked, with no switch.
- **What the user notices:** a question asked in the web app (web chat with Tex, Scout or Claude Code, a crew job or a pull-request review given there and its "run it again?", and "Run once now" on an automation) now waits in the web app only. A question asked by an automation's run (a timer or an app event, a pull-request review included) still goes to Telegram too, with the same Approve and Deny buttons, the first answer winning and quiet hours as before. Its last line now says "Asked by one of your automations. Tex carries on in the web app after your answer." Settings → General, "Tell me on Telegram when…" has a fourth switch, "An automation needs my OK", on at first; off, an automation's question waits in the Automations chat only. Work asked in a Telegram chat asks there, as before.
- **Backend:** the worker notes on each turn whose work it is: an automation's run, the turn after the user answers one of that run's questions, and a crew job that run started. An approval asked during such a turn keeps the automation's id, and so does a crew job started then; only those questions are copied to Telegram, and only while the switch is on. The note comes from the worker, never from what the agent says, and when it can't be read the question stays where it was asked. A test run ("Run once now") is the user's own, so it gets no note.
- **Cost and speed:** nothing measurable. Fewer Telegram messages for people who work in the web app.
- **Contracts:** `openapi.yaml` changed: `automationApprovals` in the Telegram notice settings of `GET /v1/me` and `PATCH /v1/me`, and the words on "Run once now". The web app has the same copy. `vm.proto` unchanged.
- **Database:** migration 0031 (`0031_automation_approvals`): a new switch on `users` (on at first), and the asking automation on `approvals` and on `crew_jobs` (empty for the user's own work, so nothing older changes).
- **How it was checked:** new automated tests: a web-chat approval sends nothing to Telegram; an automation run's approval goes to Telegram with its buttons, loses them once answered in the web app, and a late tap is refused; a denial on Telegram keeps the run's next question on Telegram too; with the switch off nothing goes; a test run's question stays in the web app; a question asked on Telegram is asked there once, whatever the switch; a crew job's "run it again?" follows who started the job; a crew job started during an automation's run is marked as that automation's, and one given in the web app is not. In the web app: the fourth switch is shown on at first, saves at once with a toast ("An automation needs my OK: off"), and a refused save is put back with an error toast. Backend: lint and type-check clean, the full suite 1147 tests in 98 files passed. Web app: lint and type-check clean, 1004 tests in 79 files passed, the build passed. Not run on the test server, and no real Telegram message has gone through it yet.
- **Still open:** an automation made on a Telegram chat now follows the switch too: with it off, its questions wait in the Automations chat even though its answers go to Telegram. The other choice is to always send those to Telegram. A crew job started from a Telegram chat asks its "run it again?" in that chat, as before. The automations phase 4 branch also made a migration 0031: whichever reaches `main` second takes the next number.
- **Docs updated:** `hld-mvp.md` sections 5.3, 5.6 and 12; `backend-report.md` sections 10 ("Notices on Telegram"), 15 ("The same question on Telegram too"), 18 and 40; the web app's Help ("Hear on Telegram when work is done", "Approve in Telegram").
- **Commits:** backend `5345cc3` (contract), `e7829a5` (the change and migration 0031), `9efede8` (tests); web app `3536c1f` (contract copy), `0f03ce0` (the switch and Help), `48d0590` (tests).
