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

### 16 October 2026: automations with steps (phase 4)

- **Where it is:** on the branch `feat/automations-steps` in the backend, the web app and the vm-manager, pushed, not on `main` and not on the test server yet.
- **Why:** your choice of option C on 16 October (`automations-steps-proposal.md`): an automation can be a short list of steps (find, decide, act) instead of one instruction, and the platform holds Tex to the steps. The smaller choices follow the proposal's recommendations: a false "only if" stops the run; such a stop is one line in the Automations chat with no Telegram copy; Tex steps only read; a risky action always asks first; "Tex decides" conditions are offered and marked as Tex's judgement; a newer run replaces one that waits for a yes; results are kept 2 days and the trail 30 days; steps move with buttons; steps are on every plan; dagre 3.1.1 lays out the canvas. Also folded in: saving Tex's draft of a change keeps the automation on or paused, and Tex is told about the "Automation runs finish" switch when it says where a run's answers go.
- **What the user notices:** on the canvas, "Split into steps" turns an automation into steps: up to 6, each an app action (one named action, such as Gmail's "Send email", with inputs the user can fix) or a Tex instruction. A "+" on each arrow adds a step there (greyed at 6, "Up to 6 steps"); each step's panel has Move up, Move down and Remove, the app and a searchable action list (the ones that always ask first marked), the fixed inputs, "Ask me first" (locked on for sending, deleting or paying), "Only if" and "Show me this". A condition shows on its arrow with a grey "otherwise: stop" beside its step. When a step is removed or moved, a condition that now looks at another step turns red ("Check this: it now looks at step 2.") until the user checks it. On a phone the steps are cards that open in place, with "+ Add a step". After a run, each box says how its step went ("Done", "Skipped", "Failed: …", "Waiting for your OK") and a line above the canvas sums up the last run. In the chat, Tex can propose an automation with steps; the Telegram outline lists them one line each. A run ends with "Steps: 1 ✓ 2 ✓ 3 ✓ 4 waiting for your OK" under Tex's answer.
- **Backend:** steps are saved on automations and drafts and checked with every problem on its step ("Step 4: Gmail's GMAIL_SEND_EMAIL has no input `to`. Its inputs: …"). A new list of an app's actions feeds the step panel. Each run of an automation with steps gets a run record (one per event, so a job that runs again starts nothing twice), and the worker notes the run beside the turn. The app tools then allow only the current step's action (its fixed inputs put in, a changed one refused) or a read in the same app; a Tex step finishes with a new tool, `finish_step`, and can't change anything. Between steps the platform checks the "only if". "Ask me first" ends the turn with an approval bound to that step of that run; the yes wakes Tex to go on, a no or 24 hours without an answer stops the run, and a newer run supersedes a waiting one (its question becomes "replaced"). At most 10 app calls a step and 30 a run. Tex ending early, or a step failing twice, fails the run and counts toward "paused after 3 failures". Results are removed 2 days after a run ends and runs after 30 days. A server setting, `AUTOMATION_STEPS=false`, switches runs with steps off. An automation's run with steps keeps the Telegram approvals rule of the entry below: its questions go to Telegram while "An automation needs my OK" is on.
- **vm-manager:** one sentence more in Tex's automation rules: one step at a time, finish a Tex step with `finish_step`, follow the "next" line of each tool answer, end the turn when the run ends or waits. The platform enforces the steps without it; it helps Tex, Hermes most.
- **Cost and speed:** no new price. A run is a turn as before (AI, awake time, 1 credit per changing app action); a run that waits for a yes is two turns. The canvas library (dagre, 17 KB compressed) loads only on an automation's page from tablet width, never on a phone or another page.
- **Contracts:** `openapi.yaml` changed (already committed first): `steps` on automations, drafts and the parts the canvas sends; `stepId` on a problem; `GET /v1/apps/{appSlug}/actions`; `GET /v1/automations/{automationId}/runs`; the stream event `automation_run.updated`; a draft's Save without `enabled` keeps a change on or paused. The web app has the same copy. `vm.proto` unchanged.
- **Database:** migration 0032 (`0032_automation_steps`, renumbered after the Telegram approvals' 0031): a `steps` column on `automations` and `automation_drafts` (empty for every automation so far, so nothing older changes), the new table `automation_runs`, and the run and step on `approvals`.
- **How it was checked:** new backend tests on Priya's example with stand-ins for Tex, Gmail and Telegram: no email stops the run after step 1 with one line and no Telegram copy, nothing charged; an urgent email runs steps 2 and 3 and asks; the question goes to Telegram; the yes sends once and charges 1 credit; a no skips step 4; another step's action, another app, a changed fixed input, a change in a Tex step and a send without a yes are refused; the answer's job run again sends nothing more; a new run supersedes a waiting one; Tex ending early fails the run and counts; 10 calls in a step and 30 in a run; the 24-hour stop and the clean-up; the server switch; 7 steps refused; every problem on its step; the actions list; a stepped draft from Tex with its Telegram outline; a paused automation stays paused when Tex's change is saved; where the answers go mentions the switch. Web app tests: the list's editing and its warning, what is sent, problems by step, the flow and the dagre layout (with its fallback), the cost line, the trail, the phone form with "+ Add a step" and "Up to 6 steps", a step's problem on its card, the last run on the page, the canvas's "+" greyed at 6, and dagre only in the canvas's own chunk; demo mode does steps too, with a template ("Urgent mail from my boss, in steps"). The canvas was looked at in a browser in demo mode (boxes in one line, conditions on the arrows, the exits beside, "+" adding a step). Results: backend lint and type-check clean, the full suite 1161 tests in 99 files passed (after the rebase on `main`); web app lint and type-check clean, 1032 tests in 83 files passed, the build passed; the vm-manager's Bridge tests, 274 passed. Not run on the test server, and not with a real Tex yet (step 4d).
- **Still open:** step 4d, a real run of Priya's example on the test server, on Claude Code and on Hermes. The Automations page redesign and the draft card restyle will want to show steps their way; this branch keeps its styling plain so they can go on top.
- **Docs updated:** `hld-mvp.md` sections 5.4 ("Steps"), 12 and 13 (Part E); `backend-report.md` section 12 (the events), 18 ("Drafts", "Automations with steps"), 40 and 41 and 42 (`AUTOMATION_STEPS`); the vm-manager's README.
- **Commits:** backend `f66ec7d` (contract), `befba72` (4a: data, checks, drafts, migration), `1e65d0f` (4b: the runner and its tests); web app `68d2a7b` (contract copy, dagre), `9ece336` (data and layout), `f2a9393` (canvas, editing, page, demo, tests); vm-manager `d01e62b`.

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
