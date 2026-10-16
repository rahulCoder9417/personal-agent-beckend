# Automations with steps: a proposal (phase 4, option C)

A design proposal. Nothing is built. No code, contract or server was changed.

Written on 16 October 2026, after your choice of option C on top of A. It builds on phase 3 (option A, editing by hand), now being built on `feat/automations-manual`.

| Word | What it means here |
|---|---|
| Step | One thing a run does: an app action, or a Tex instruction |
| Run record | What the platform keeps about one run: which step it is on, and each step's result |
| dagre | A free library that works out where boxes go on a canvas (package `@dagrejs/dagre`) |

---

## 1. In short

- **Up to 6 steps** per automation. Today's one-instruction automations stay as they are.
- **A run is still one turn of Tex in the user's container** (HLD 9). The platform keeps the step pointer and **refuses any call that does not fit the current step**.
- **No new prices.** The canvas lays out the steps with dagre (MIT, 17 KB compressed); phones get a form.
- **About 3 weeks,** backend and web side by side: more than the first guess of 2, because enforcing steps and pausing for a yes were costed fresh.

---

## 2. What a step is

| Part | Choices | Example |
|---|---|---|
| Type | **App action** (one named action, such as Gmail's "send email") or **Tex instruction** (words) | Tex: "Draft a short, polite reply" |
| App | One connected app. A Tex step may name apps it may **read** | Gmail |
| Fixed inputs | App action only: inputs the user sets, such as a recipient. Tex fills the rest from earlier results | `from: boss@acme.com` |
| Ask me first | On or off. Always on, and locked, for risky actions (send, delete, pay; `backend-report.md` 15) | On |
| Only if | Always; "the step before found something"; "the step before mentions any of these words"; "Tex decides: <question>" | Mentions "urgent" |
| Its result | Goes to the next step, and also into the run's answer if "Show me this" is on | Show me this: on |

Step 1 has no "only if". A Tex step only reads and writes words: a change in an app is always an app step, so the user sees it (decision 3). Each step has a short id, so reordering never mixes up results.

**The example.** Priya builds "Urgent mail from my boss":

- **Trigger:** every weekday at 8:00 AM, Asia/Kolkata.
- **Step 1, app action:** Gmail, fetch emails, fixed `query` "from:boss@acme.com is:unread newer_than:1d".
- **Step 2, Tex:** "Pick the emails that are urgent and say why", only if step 1 found something.
- **Step 3, Tex:** "Draft a two-line reply to each urgent one", only if step 2 mentions "urgent". Show me this: on.
- **Step 4, app action:** Gmail, send each reply (ask me first, locked on: one yes per email).

---

## 3. How a run follows the steps

Every run is still a turn of Tex in the user's container; nothing calls Composio on its own. What changes: the platform knows the list and the current step, and checks every tool call against it.

1. The trigger fires, as today. The worker makes a **run record**, keyed by the event, so a job that runs again never starts twice.
2. The worker notes the run's id beside the turn in Redis, as it notes the turn's kind today. Tools find the run by the user, never by what Tex says.
3. Tex gets the purpose, the numbered steps and the rules: one at a time, in order, nothing extra.
4. **An app step:** Tex calls `run_app_action`. The platform checks:
   - the action is the current step's, or a read-only action of the same app (to look something up first);
   - the fixed inputs are there unchanged; the platform puts them in if Tex left them out;
   - "ask me first": it needs an approval for exactly this action, as for risky ones today.

   On success the platform saves a short result (at most 4,000 characters) and moves to the next step.
5. **A Tex step:** Tex may read from the step's apps (free actions only), then calls a new tool, `finish_step`, with its result in words. The platform saves it and moves on.
6. **Before each next step** the platform checks its "only if" on the saved result:
   - "found something": the result is not empty (no emails, an empty list);
   - "mentions": any of the words, ignoring capitals;
   - "Tex decides": Tex answers yes or no with one line why, in `finish_step`. The run record keeps the line.
7. Every tool answer ends with what comes next: "Now step 3: …", or "The condition is false: end the run."
8. **The end.** Tex writes the run's answer, with the results marked "Show me this". The platform adds one line: "Steps: 1 ✓ 2 ✓ 3 ✓ 4 waiting for your OK". It answers in the Automations chat with the copy to Telegram, as today.

An action of another step or app, or a changing action in a Tex step, is refused, naming the current step.

### Asking first in the middle of a run

An approval ends the turn today, and that stays. So a run with "ask me first" has two parts:

1. Tex calls `request_approval` for the current step. The approval remembers the run and the step. The run record says "waiting".
2. The user answers. The yes wakes Tex in the Automations chat, as today; the worker puts the run's id beside that turn too.
3. Tex runs the approved action and goes on with the steps after it.
4. A no, or 24 hours without an answer: the run stops there. The steps after it are skipped.
5. A new run of the same automation while one still waits: the older approval becomes "replaced", the older run "superseded" (decision 6). So a morning run never sends yesterday's draft too.

### When a step fails or a condition is false

| Case | What happens |
|---|---|
| The app refuses the action | Tex may try once more, as today. A second failure fails the step |
| A step fails | The run stops; later steps are skipped. Tex says which step failed. It counts toward "paused after 3 failures in a row" |
| "Only if" is false | The run stops there, as a success (decision 1). One short line in the Automations chat, no copy to Telegram (decision 2) |
| Tex ends the turn early | The run is marked "stopped at step N" and counts as a failure |
| The job runs again after a crash | Steps marked done are not done again: the run carries on from the first step not done |

### Timeouts

- A turn may last 15 minutes (the vm-manager's `DELIVER_TIMEOUT`); past that, the run fails at its current step.
- At most 10 app calls per step, 30 per run.
- A run waiting for a yes holds no container.

### Credits

- **No new price.** A run is a turn: AI, awake time, and 1 credit per successful changing app action. A run paused for a yes is two turns, each billed as today.
- At zero credits a changing action is refused, so the step fails and the run stops; automations pause, as today.
- The canvas shows the most the app actions can cost: Priya's, 1 credit per email sent, plus AI and awake time.

---

## 4. Data

### Stored steps

1. A new column `steps` on `automations` and `automation_drafts`. Empty, as for every automation today, means today's one-instruction run.
2. With steps, the instruction is the purpose in one line ("Reply fast to urgent mail from my boss"), and `apps` are all apps the steps name.
3. Pull-request review never has steps.

### The run record

A new table `automation_runs` in the automations module:

| Field | What it holds |
|---|---|
| Automation and event | Which automation, and the event that started it (unique) |
| State | running, waiting, done, stopped, failed, superseded |
| Current step | The step's id |
| Each step | done, skipped, failed or waiting; its short result; tries; Tex's reason for a "Tex decides" |
| Test | Whether it was "Run once now" |

Results can hold bits of emails: removed 2 days after the run ends; the trail stays 30 days (decision 7). All goes with the account. The approval (orchestrator module) is linked to its run through that module's own function.

### The migration

One migration, numbered after phase 3's: the two `steps` columns, the table `automation_runs`, and the run and step on `approvals`. Nothing already there changes.

### `propose_automation` with steps

It takes an optional `steps` list. Beyond a save's checks, each step's app must be connected, its action must exist at Composio with fixed inputs that fit (the approval check), and a risky action must ask first. A problem names the step: "Step 4: Gmail has no input `to`; use `recipient_email`." `get_automation_draft` gives the steps back; the Telegram outline lists them, one line each.

---

## 5. The canvas

### Layout

- **Trigger → Step 1 … Step N → Results.** A step box shows its type, title, app icon, a lock for "ask me first", and "Show me this".
- A condition is a short label on the arrow into its step ("only if: mentions 'urgent'"), with a small grey exit beside it: "otherwise: stop".
- Today's one-instruction automations keep their five boxes.
- **dagre** places the boxes and the exits: left to right on wide screens, top to bottom below 1,280 pixels.

| Question | Answer |
|---|---|
| Package | `@dagrejs/dagre` 3.1.1 (8 August 2026), pinned exactly. The old `dagre` 0.8.5 is unmaintained since 2022 |
| License | MIT (checked in the package, 16 October 2026) |
| Size | Measured: 48 KB minified, **17 KB compressed**, with its one dependency |
| Loading | Only on an automation's page, with React Flow. Phones never load either |

### Editing

1. **Add:** a "+" on each arrow inserts a step there; one after the last adds at the end. At 6 it is greyed with "Up to 6 steps".
2. **Remove:** "Remove step" in the step's panel. The step after it now follows a different step, so its "only if" turns red: "Check this: it now looks at step 2."
3. **Reorder:** "Move up" and "Move down" in the panel, also by keyboard. Dragging comes later, if asked (decision 8).

### The step panel

- **Type, app** (connected ones only) and **action** (a searchable list, risky ones marked).
- **Fixed inputs:** a small form from the action's inputs (text, number, yes or no, a list). Other kinds are left to Tex.
- **Instruction** for a Tex step, with "Ask Tex to improve this".
- **Ask me first** (locked on for risky actions), **Only if** ("Tex decides" says it is less certain) and **Show me this**.

Each change is checked with phase 3's "check without saving"; a bad step turns red with its message.

**After a run** the boxes show the last run's trail: done, skipped, "failed: …", "waiting for your OK".

**Phones** (under 768 pixels) get a form: the trigger, then step cards, each opening the same panel as a full sheet, with Move up, Move down, Remove and "Add a step".

---

## 6. How it builds on phase 3

| Phase 3 gives | Phase 4 adds |
|---|---|
| Create, change and "check without saving" endpoints | They take `steps`; the check gives problems per step id |
| "Run once now", at most 10 an hour | A test run follows the steps, marked "Test run"; approvals as usual |
| The apps limit on a run | Per step: a step may use only its own app. |
| Each app's events | Each app's actions, for the step panel (one more endpoint) |
| Drafts made on the canvas | Stepped drafts, the same states and Save |

---

## 7. Changes per repo

S is up to 2 days, M about a week, L about two weeks, for one builder. Every endpoint goes into `openapi.yaml` first.

**Backend.**

| Change | Size |
|---|---|
| Contract: steps on automations, drafts, create, change and check; an app's actions; the last runs of an automation | S |
| Migration; saving and reading steps; the run record and its clean-up | S |
| `propose_automation` and `get_automation_draft` with steps; the Telegram outline | M |
| The runner: run record per event, step pointer, `finish_step`, the checks in `run_app_action` and `request_approval`, conditions, the pause for a yes, superseding, limits, failure counting | L |

**vm-manager.** One paragraph in Tex's instructions on stepped runs (one step at a time, `finish_step`, never skip, end when told), with a test. S. No `vm.proto` change: `finish_step` reaches both engines through the Platform MCP.

**Web app.**

| Change | Size |
|---|---|
| Canvas with dagre: variable steps, condition labels and exits, last run's trail | M |
| Editing: add, remove, move, the step panel, action picker, inputs form, conditions, live checks | L |
| Phone form; draft card and chat strip with steps; Help words | S |

---

## 8. Build order

Every part also ends with lint, types and tests passing.

| Part | Done when |
|---|---|
| **4a. Data and drafts** | A stepped draft is proposed, checked per step, shown on the canvas read-only and saved. Old automations read back unchanged. A server setting keeps stepped automations from running until 4b |
| **4b. The runner** | Priya's example, with stand-ins: no email → the run stops after step 1, one line, nothing charged for actions; an "urgent" email → steps 2 and 3, then an approval; the yes sends once and charges 1 credit; a no skips step 4. An action of another step, of another app, or a send without a yes, is refused. A job run twice does not send twice. A new run supersedes a waiting one. 31 app calls are refused |
| **4c. Editing** | Each step type built on an empty canvas; add, remove and move work, with the condition warning; 7 steps refused; every refusal on the right box before Save; the phone form does the same; dagre and React Flow only on that page |
| **4d. For real** | Priya's example run on the test server with a real Tex, Gmail and Telegram, on Claude Code and on Hermes |

---

## 9. Risks

- **Tex fills the open inputs.** A planted email could steer a reply's words. A send always asks first, and the user can fix the recipient.
- **Tex may stop early or wander:** a failure, shown on the trail. Hermes follows instructions less strictly than Claude Code; 4d tests both.
- **The pause for a yes** is the delicate part: a run across two turns. A lost Redis note must refuse, never run free.
- **Composio renames actions** at times: the run fails with "Step 1's action no longer exists; change it on the canvas".
- **dagre 3 is young** (March 2026). Pinned; the fallback is our own placement of a straight line.

---

## 10. Decisions for you

| # | Decision | My recommendation |
|---|---|---|
| 1 | "Only if" is false: stop the run, or skip only that step? | Stop the run. Each step uses the one before it, so skipping one breaks the chain |
| 2 | A run that stops on a false condition: quiet, or one line? | One line in the Automations chat ("Nothing to do: no urgent email"), no copy to Telegram |
| 3 | May a Tex step change things in an app? | No. Changes are app steps, so the user sees each one |
| 4 | May the user turn "ask me first" off for a risky action? | No, as today. They may turn it on for any other |
| 5 | Offer "Tex decides" conditions? | Yes, marked as Tex's judgement |
| 6 | A new run while the last one waits for a yes | The older approval is replaced and its run superseded |
| 7 | How long the platform keeps step results | Results 2 days; the trail 30 days |
| 8 | Reordering: buttons, or dragging too? | Buttons now; dragging only if users ask |
| 9 | Steps on every plan? | Yes, up to 6. The plan's count of automations already limits it |
| 10 | dagre, or our own placement? | dagre: 17 KB on one page, and it places the "otherwise: stop" exits |
