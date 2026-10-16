# Automations on a canvas: a proposal

A design proposal. Nothing is built. No code, contract or server was changed.

Written on 16 October 2026. Read for it: `hld-mvp.md` (5.4, 7, 9), `backend-report.md` (13, 15, 18, 19), the automations module and its Platform MCP tools, `openapi.yaml`, the Bridge's instructions (`core.py`, `crew.py`), and the web app's Automations screens and chat.

**The picture** is in GoDraw, canvas **"Textcrew: automations on a canvas (proposal)"**: https://godraw.app/canvas/6ad1ba249cb5dcdf65b0b58e. Page 1: from chat to a saved automation (section 12). Page 2: the five boxes of one automation (section 3).

| Word | What it means here |
|---|---|
| Canvas | A drawing area with boxes joined by arrows, which can be moved and zoomed |
| Node | One box on the canvas: the trigger, Tex's instruction, and so on |
| React Flow | A free library that draws such canvases in a web page (package `@xyflow/react`) |
| Draft | An automation Tex proposed and the user has not saved. It never runs |

---

## 1. In short

- **Showing today's automations as a flow needs almost no backend work.** Each has the same shape: one trigger, one instruction, fixed rules for approvals and results.
- **In the chat, Tex proposes instead of creating.** The web chat draws the draft as a small diagram card; Telegram gets an outline, a link and a Save button. Nothing runs until the user saves.
- **Building by hand comes in three sizes:** (A) edit today's shape, (C) a few steps inside one run, (B) a real workflow engine. **Recommendation: A, in three phases.** C later if users ask. Not B.
- **React Flow** is MIT licensed, 12.12.0, 59 KB compressed, on one page only. Phones get a list.

---

## 2. Today

An automation is a saved instruction Tex runs later, without the user texting. Its row in the table `automations` holds a kind (once, repeating, app event), a title, the instruction in words, when it runs (a moment, a schedule in the user's time zone, or an app's event), the chat it was made in, and its state (on or paused, next and last run). Pull-request review is the same kind of row, marked `pr_review`.

**The API** lets the web app list, pause, resume and delete. It cannot create or change one.

**How Tex makes one:**

1. The user asks in chat.
2. Tex calls `create_automation` (or `schedule_reminder` for a plain reminder).
3. The platform checks: the plan limit (Free 1, Pro 5, Max 50), 15 minutes between runs, a real time zone, a moment not past, the app connected.
4. It saves it and sets the timer, or asks Composio to watch the app. The user never sees what was saved before it is live.

**A run** is a normal turn in the user's container that answers in the Automations chat. Risky actions still wait for an approval. It pauses at zero credits or after 3 failures in a row.

**The web app** shows a card per automation: when it runs, "What Tex does", next and last run, a switch, Change (which opens the chat) and Delete. Its intro says "There is no form: you make one by asking."

**Example.** Rahul writes on Telegram "every Monday at 9, send me my open pull requests". Tex saves it at once. Each Monday the list lands in his Automations chat, with a copy on Telegram.

---

## 3. What the canvas shows

Every automation draws as five nodes, left to right (GoDraw, page 2):

**Trigger → Tex's instruction → Apps → Asks you first → Results**

| Node | Drawn from | Example |
|---|---|---|
| Trigger | The moment, schedule or app event; the status sits here | "Every Monday at 9:00 AM, your time" |
| Tex's instruction | Title and instruction | "List my open pull requests in acme/web" |
| Apps Tex may use | The trigger's app; later, the apps Tex names when proposing | GitHub. Older ones: "Your connected apps, as needed" |
| Asks you first | The platform's fixed rule | "Sending, deleting or paying waits for your OK" |
| Results | Always the Automations chat, plus the chat it was made in | "Automations chat" and "Copy to Telegram" |

Pull-request review draws as: "A pull request opens in acme/web" → "Patch reviews it" → GitHub → "Comments without asking; never merges or approves" → Automations chat.

**Where it lives.** The list keeps its cards, each with a small flow strip in plain HTML (the same strip as the chat card). A card opens that automation's own page, with the React Flow canvas. A canvas in every card would be slow and show nothing more.

**Backend change?** Only two small read-only additions to the contract, without which the picture is less complete:

1. **Where the copy goes:** the API does not say an automation was made in Telegram. A field `copyTo` fixes that.
2. **The trigger's settings,** such as "only from boss@acme.com". Today only the app and event are returned.

---

## 4. Building by hand: the big decision

| | (A) Today's shape on the canvas | (C) Steps inside one run | (B) A workflow engine |
|---|---|---|---|
| The user builds | One trigger, one instruction, the apps, where results go | A trigger, then up to 6 steps, each with an app, "ask me first" and "only if …" | Any graph: app steps, AI steps, conditions, branches, waits, loops |
| Who runs it | Tex, one turn, as today | Tex, one turn; the platform enforces each step's app and "ask me first" | A new step-by-step runner; app steps call Composio directly |
| New backend | Create, change and check endpoints, drafts, test run | A, plus stored steps | Workflows, versions, runs and steps; the runner; waits; approvals mid-run; retries |
| Billing | Unchanged | Unchanged | New prices per step or run |
| Size | About 4 weeks, backend and web side by side (section 8) | About 2 weeks more | XL: 10 to 14 weeks, then upkeep |
| Risk | Low: the runner is unchanged | Medium: Tex judges "only if", so it is less certain than it looks | High: another product (a Zapier), and it reverses the decision that every automation goes through the user's container (HLD 9) |

**In A the canvas has fixed slots,** not free wiring. Clicking a node opens its settings in a side panel:

- **Trigger:** one time (date, time); a schedule (days, a time, a time zone; or, for experts, a cron line, the standard short code for a schedule); or an app event (a connected app, an event, its settings).
- **Instruction:** a text box, with "Ask Tex to improve this".
- **Apps:** add or remove connected apps. **Results:** a copy to one linked Telegram chat, or none.
- **Title,** and on or paused.

**Checks while typing.** The server checks without saving, with the same refusals as a save, and gives the next three run times. A node with a problem turns red with the message.

**Saving** runs today's checks. A double click makes one automation: the save carries an idempotency key, a one-time label the server remembers. A changed app event gets its new Composio watch before the old one is removed.

**Test run.** "Run once now" on a saved automation, on or paused: a normal run, marked "Test run" in the Automations chat, at a normal run's cost, with approvals as usual. At most 10 an hour. To try before going live: "Save paused", then "Run once now".

**Recommendation: A.** It offers all that today's runner can really do, at low risk, and can grow into C. Revisit B only if beta users ask.

**Example.** Priya picks Gmail → new email from boss@acme.com, writes "Summarise it in two lines", adds a copy to Telegram, saves paused, runs it once, reads the test, and switches it on.

---

## 5. The diagram in the chat

Tex does not write the HTML. The web app never shows HTML from the agent: a page or email Tex read could then put code in the user's browser. Tex sends data; the web app draws it.

1. The user asks: "When my boss emails me, tell me on Telegram."
2. Tex calls a new tool, `propose_automation`: the parts of `create_automation`, the apps it expects to use, and for a change, which automation.
3. The platform checks it as a save would. A problem goes back to Tex to fix.
4. It saves a draft and posts a message carrying the draft's id, as an approval's question carries the approval's id.
5. The web chat draws a **draft card**: title, the flow strip, "Not saved yet", **Open in Automations** and **Save**. Tex's turn ends.

**Telegram cannot show HTML.** It gets plain text and a Save button, like an approval's buttons:

```
⚡ New automation, not saved yet: Boss emails
When: a new email from boss@acme.com arrives in Gmail
Tex: says who wrote and what they want, in two lines
Asks first: before sending, deleting or paying
Results: your Automations chat, and a copy here
Review it: https://app.textcrew.in/automations/new?draft=drf_…
[ Save ]
```

**Safety:**

- **A draft never runs:** no timer, no Composio watch. Only the user's tap on Save makes it real. Tex has no tool that saves.
- **It closes a gap.** Today a run that reads an outsider's email could talk Tex into calling `create_automation`. With drafts, the user sees whatever Tex proposes.
- **Limits and credits:** a draft does not count against the plan; the limit is checked at proposal and at Save. Proposing is free; runs cost what they cost today.
- **Plain one-time reminders** keep going straight through `schedule_reminder` (decision 2).

---

## 6. Drafts and the link

**A new table, `automation_drafts`,** in the automations module:

| Field | What it holds |
|---|---|
| The parts | All an automation has: kind, title, instruction, when, apps, copy |
| Change of | Empty, or the automation it would change |
| Made by | Tex or the user |
| State | Open, saved, discarded, replaced or expired |
| Lasts | 7 days |

An expired draft's card says "This draft expired. Ask Tex again." A clean-up job removes drafts after 30 days. A user has at most 20 open drafts.

**The links,** under https://app.textcrew.in:

| Address | Opens |
|---|---|
| `/automations/new?draft=drf_…` | A draft of a new automation |
| `/automations/aut_…?draft=drf_…` | A proposed change, changed nodes marked |
| `/automations/aut_…` | One saved automation |
| `/automations/new` | An empty canvas, or a template |

The link asks for sign-in when needed. Another account gets "not found": every query is filtered by the user.

**Canvas or Tex:**

| The user … | What happens |
|---|---|
| saves, with or without changes | The automation is made; the card turns into "Saved · Open" |
| asks Tex in chat to change it | Tex proposes again; the old draft becomes "replaced", as an approval asked again does. An open canvas shows "Tex made a newer version · Open it" |
| changes nodes, then "Ask Tex" | The user's version is kept as a draft, and the chat opens with "Change this draft: …". Tex reads it with a second new tool, `get_automation_draft` |
| leaves without saving | The changes stay in this browser only |

**Example.** Tex proposes "every Monday at 9". Rahul makes it 8:30 on the canvas, then asks Tex to "also include issues". Tex reads his version and proposes both. He saves.

---

## 7. React Flow

| Question | Answer |
|---|---|
| License | MIT (checked in the package, 16 October 2026). Free for commercial use |
| Corner link | It shows a small "React Flow" link. The license allows hiding it; the makers ask that only paying Pro users do (from $169 a month). Keep it |
| Version | 12.12.0 (24 September), pinned exactly; works with our React 19.2. Not the 13.0 test release of 11 October |
| Size | Measured: 59 KB compressed, plus 2.4 KB of styles |
| Loading | Only on one automation's page, when it opens. The chat card and list strips are plain HTML |
| Layout | Today's shape is fixed, so we place nodes ourselves. B would need dagre (MIT, 17 KB); not elkjs (EPL or GPL license) |
| Phones | Under 768 pixels: the same nodes as a list of cards, each opening the same settings. A straight line loses nothing as a list |
| Accessibility | Tab reaches each node, Enter opens it. The side panel is the real form, for keyboard and screen-reader users. A "List view" switch works on wide screens too |
| Look | The web app is light only, matching textcrew.in. The canvas uses the app's own colours and React Flow's light mode |

---

## 8. Changes per repo

S is up to 2 days, M about a week, L about two weeks, for one builder.

**Backend.** Each endpoint goes into `openapi.yaml` first, then types, then code.

| Change | Phase | Size |
|---|---|---|
| `copyTo` and trigger settings in the API; get one automation | 1 | S |
| Drafts table and migration, clean-up job; draft endpoints (get, save, discard, the user's own draft); `automationDraftId` on messages; a live event | 2 | M |
| Tools `propose_automation` and `get_automation_draft`; `create_automation` taken from the agent; the Telegram outline and Save button | 2 | M |
| Create, change and check endpoints, each app's events, test run | 3 | M |
| If decided: the canvas's apps become a limit for that automation's runs | 3 | S |

**vm-manager and Bridge.**

| Change | Phase | Size |
|---|---|---|
| One line in Tex's instructions: propose an automation and end the turn; plain reminders go straight through. With a test | 2 | S |

The tool needs no Bridge code: platform tools reach both engines through the Platform MCP.

**Web app.**

| Change | Phase | Size |
|---|---|---|
| Flow strips on cards; the automation's read-only canvas; phone list; React Flow on that page only; demo mode | 1 | M |
| Draft card in chat; draft on canvas with Save, Save paused, Discard; replaced, expired, saved states | 2 | M |
| Editing: settings panels, schedule builder, app-event picker, live checks, Ask Tex, Run once now, empty canvas, templates | 3 | L |
| Words: the intro ("There is no form") and Help | 1 to 3 | S |

---

## 9. Phases

Every phase also ends with lint, types and tests passing.

| Phase | Done when |
|---|---|
| **1. Today's automations on a read-only canvas** | Every kind and paused state draws correctly, checked by tests. The build shows React Flow on that one page only. Phones get the list; Tab and Enter work. The demo mode shows it |
| **2. Chat draft, card and link** | "Every Monday at 9, send me my open pull requests" shows a card, and nothing is saved, scheduled or watched before Save. Save makes exactly one automation, even on a double click; a replaced, expired or saved draft cannot be saved. A full plan is refused at proposal and at Save. Telegram's Save button works. A replaced draft's card says so. Tried for real on the test server, with Telegram |
| **3. Building today's shape by hand** | Each kind can be built on an empty canvas, and any part of one changed. Every refusal shows on the right node before Save. A changed app event leaves exactly one Composio watch. "Run once now" is marked as a test. Tried for real on the test server |

**Phase 4, only if chosen:** C, or later B, each with its own proposal first.

---

## 10. Risks and open questions

- **The picture is not the program.** Tex still reads the instruction and decides. The instruction node says "Tex follows this in its own way", so the canvas does not look like a machine.
- **Composio's list of events** and their settings is needed for building an app event by hand. Not yet checked against our SDK version.
- **Old habits.** If `create_automation` stays, Tex may skip the draft. Take it from the agent; the save code stays for the web.
- **Reminders keep the old path,** so an outsider's email read during a run could still plant a reminder. Refusing `schedule_reminder` inside automation runs closes that (S, phase 2).
- **A change of app event that stops halfway** is tried again, as moving a reconnected app's watches is today.
- **Next.js 16** has breaking changes: read its own guide to loading code later before building.
- **Open:** should a run with nothing new stay quiet? Today every run answers. It fits C better than A.

---

## 11. Decisions for you

| # | Decision | My recommendation |
|---|---|---|
| 1 | A, B or C for building by hand | A now. C later, if users ask. Not B |
| 2 | Does every automation go through a draft? | Yes for repeating and app-event ones, on web and Telegram. Plain one-time reminders stay one step |
| 3 | Telegram: a Save button, or only the link | Both: Telegram is the main channel |
| 4 | Web chat card: Save too, or only "Open in Automations" | Both |
| 5 | How long a draft lasts | 7 days |
| 6 | The canvas's apps: a limit on the run, or only a picture | A limit, from phase 3 |
| 7 | Phones: a list instead of the canvas | Yes |
| 8 | React Flow's corner link: keep, or pay Pro to hide | Keep it |
| 9 | Test run before saving, or only on a saved one | Saved only, with "Save paused" to try first |
| 10 | May Tex still delete an automation without asking? | Yes, as today: it harms nobody and is in the activity log |

---

## 12. The picture: from chat to a saved automation

GoDraw, page 1: https://godraw.app/canvas/6ad1ba249cb5dcdf65b0b58e

1. The user asks Tex, in web chat or on Telegram.
2. Tex calls `propose_automation`. The platform checks it and saves a draft. Nothing runs.
3. Web chat shows a card with a small diagram. Telegram gets an outline, a link and Save.
4. The link opens the draft on the canvas.
5. The user saves it as it is, or changes nodes and saves, or asks Tex to change it (a new draft replaces the old: back to step 3).
6. Saved: the automation is made, its timer or watch set; the card shows "Saved". Save on the card or on Telegram jumps here from step 3.
7. Each run answers in the Automations chat, as today.
