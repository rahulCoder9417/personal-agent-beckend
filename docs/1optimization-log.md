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

### 16 October 2026: automations on a canvas, phase 1 (read-only)

- **Where it is:** on the branch `feat/automations-canvas` in the backend and the web app, not on `main` yet. Not on the test server.
- **Why:** you approved `automations-flow-proposal.md` (option A, with C to follow). Phase 1 shows today's automations as a flow before anything can be built by hand.
- **What the user notices:** each automation card on the Automations page has a small strip of its five steps and opens a page of its own. That page draws the automation as five boxes joined by arrows: when it runs, what Tex does, the apps, "asks you first" and where the results go (the Automations chat, and "Copy to Telegram" for one made there). Clicking a box, or Tab and Enter, opens its details beside the canvas. Phones, and anyone who picks "List view", get the same boxes as a list. Nothing can be changed on the canvas yet; pausing, resuming and deleting work as on the card.
- **Backend:** the api reads one automation (`GET /v1/automations/{id}`), only the user's own. Each automation now also says where the copy of each answer goes (`copyTo`: Telegram, or none) and its trigger's settings, for example the repository a pull-request review watches. Both were already in the table; the api did not give them out.
- **Cost and speed:** none on the backend. The web app loads the drawing library (React Flow 12.12.0, about 59 KB compressed) only on an automation's own page.
- **Contracts:** `openapi.yaml`: the new `GET /v1/automations/{automationId}`, and `copyTo` and `trigger.config` on `Automation`. `vm.proto`: none.
- **Database:** none.
- **How it was checked:** a new test file (every kind read back with where its copy goes and its settings, an empty `config` for a trigger without settings, another user's automation and an unknown id answer 404, a finished one-time reminder is gone from the list but found by its id). Lint, types and all 958 backend tests pass. The web app's checks are in its README.
- **Still open:** phases 2 (drafts from the chat) follows in the same piece of work; phases 3 and 4 come after.
- **Docs updated:** `hld-mvp.md` sections 5.4 and 12, and the docs table; `backend-report.md` sections 18 ("What the web app draws: the canvas") and 41.
- **Commits:** backend `954f60f`, `48851e9`.

### 16 October 2026: "Tex is working…" no longer stays under a finished answer

- **Where it is:** on `main` (backend) and live in the web app since 16 October. The backend log lines reach the server with the next deploy.
- **Why:** at 10:32 AM you sent "hlo" in web chat. Tex answered "Hey! How can I help you today?", but "Tex is working…" stayed under the answer and your message kept saying "Tex is on it", though the turn was over. What happened, from the server's logs, the message as it is saved and the turn's timing record (India time):
  1. **10:32:15.** The message was saved and the turn started. The container was asleep and woke in 2.6 seconds.
  2. **10:32:19.** The agent took the message. The worker marked it "processing" and the agent "busy", and sent both to the web app. That is what "Tex is on it" and "Tex is working…" show.
  3. **10:32:23.** Tex's answer was saved and sent to the web app. It showed.
  4. **10:32:25.** The turn ended normally ("done" in its timing record). The worker marked your message "delivered", which is how it is saved now, and the agent "awake", and sent both. The timing record is written only after both have gone to Redis, so they were sent.
  5. **They never reached the page.** It went on showing the message "processing" and the agent "busy", which happens only without those two. Nothing else could have put the old state back: between 10:32:16 and 10:34:36 the page asked the api for nothing but your profile.
  6. **10:34:36.** The page's live connection broke, the browser opened a new one and asked again for the thread and the agent's state. That cleared it, about two minutes late. The page had no other way to find out.
- **Why the events didn't get through:** the live connection runs from the browser to the web app's host (Vercel), which passes it on to the api. Watching the server's connections later that morning showed two things. The host cuts every connection after 5 minutes (10:34:22 to about 10:39:22, and again 10:39:27 to 10:44:27). And the browser's side can break while the host's side stays open: at 11:12:26 the browser opened a new connection while the old one was still being read from the api, a ping every 25 seconds, until 11:14:27. What the api writes in such a gap reaches nobody, and the api can't tell. Where exactly your connection stopped at 10:32 can't be seen in the logs we had; the log lines below show it next time.
- **What the user notices:** "Tex is working…" goes within about 10 seconds of Tex's answer even when the turn's last events are lost on the way, and a connection that has gone quiet is replaced within about 80 seconds, with what was missed asked for again. Normally nothing changes: the bubble goes a second or two after the answer, as before.
- **Web app:** three things (they are described in its README):
  - 10 seconds after Tex's answer, a thread that still shows Tex at work asks the api again for the agent's state and the thread. A turn that really goes on (Tex said it is on it and keeps working) stays at work, because the api says so too.
  - A connection with nothing at all for 70 seconds (the api pings after 25 quiet seconds) is replaced, and the new one catches up. This is looked at every 10 seconds, and at once when the tab is shown again. A connection the host refused (a 401 or a 502), which the browser gives up for good, is opened again after 3 seconds, then twice as long each time, up to a minute.
  - A late word never puts Tex back to work: a message's status only moves forward on the page, and the agent's state read from the api gives way to the live connection's when that spoke while the answer was on its way.
- **Backend:** the api writes one line when a live connection closes: how long it was open, how many events and pings went out, the last event and how long before the close, how long it had been quiet, and how many events were still waiting. A write that waits 5 seconds or more, because nothing downstream reads the connection, is a warning. Nothing of what the events hold is logged.
- **Cost and speed:** two extra requests (the agent's state and the thread) only when a turn's end is missing 10 seconds after an answer; none otherwise. One log line per connection, about one every 5 minutes for each open tab.
- **Contracts:** none. **Database:** none.
- **How it was checked:** web app: a test plays the 10:32 turn with its last two events lost, and the thread stops showing Tex at work 10 seconds after the answer (with the check switched off it stays at work); tests that a late "processing", the answer to sending a message and a list read during the turn never take a delivered message back, that the agent's state from the api gives way to a newer one from the stream, and that a quiet or refused connection is replaced and catches up while a pinged one is kept (each fails with its part switched off). Lint, types, the build and all 851 tests pass. Backend: a test for the closing line (and that no event's text gets into it), the slow-write warning and one line per connection (they fail on the old code). Lint, types and all 944 tests pass. Not yet tried on the server.
- **Still open:** the stream still has no event ids, so what is sent while a connection is down is not replayed; the web app asks again instead. Sending ids and replaying the last minute's events on reconnect would close that gap; it changes the contract and is only proposed here.
- **Docs updated:** `backend-report.md` section 12 ("When the stream stops getting through").
- **Commits:** backend `92126ca`; web app `781407c`, `2a1a440`, `67d23ea`.

### 16 October 2026: the crew is asked for in chat; the web app's Crew page and crew jobs screen are gone

- **Where it is:** on `main` in the vm-manager (the Bridge passage) and live in the web app since 16 October. The Bridge part reaches containers with the next deploy.
- **Why:** you wanted the crew simpler. The web app had a Crew page (a card per member) with a form for crew jobs ("Give Patch a review", "Give Byte a job") and a list of them. Byte and Patch are now used only from the chat: asking Tex to make a code change means Byte, and a pull-request review means Patch.
- **What the user notices:**
  - **No Crew page, no jobs form, no jobs list.** "Crew" is gone from the sidebar, from More and from the phone's tabs. The old address `/crew` leads to the crew's part of Help (`/help#crew`).
  - **Help explains the crew** in a part of its own: who is on it here (from the crew list, with "Coming soon" on one not switched on), what each one does, and how to ask in the chat, for example "Fix the typo in the README on my repo acme/website" for Byte and "Review pull request 42 in acme/website" for Patch.
  - **Pull-request review per repo stays** on Automations → Pull-request review, because only the user can switch it on and no agent tool can. That screen now also says that one review, once, is asked of Tex in the chat.
  - **In the chat,** Tex now hands even a one-line change to a repository to Byte, instead of doing it itself as a "small edit". Asked to review every pull request in a repo, Tex sends the user to Automations → Pull-request review instead of making an automation of its own.
- **Backend:** no code changed. The crew jobs API (`POST` and `GET /v1/crew-jobs`, `GET /v1/github/repos`) stays; no app calls it now. Tex still starts the same jobs from chat with `start_crew_job`.
- **vm-manager:** the lead's instructions in the Bridge have one more part: a change to the code or files of a repository goes to Byte however small it is, even a typo in a README; every review of a pull request goes to Patch; the user asks for both in chat; and review of every new pull request in a repository is switched on only by the user, in the web app under Automations, Pull-request review (its address is given), so the lead sends the user there.
- **Cost and speed:** the instructions are about 90 words longer on every turn, a few more input tokens. The web app's sidebar asks for one call fewer on a wide screen (the crew list). Not measured.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change.
- **Database:** none.
- **How it was checked:**
  - vm-manager: a new Bridge test checks the new part of the lead's instructions, its address, and that it comes after "a small edit" so it narrows it. All 240 Bridge tests pass (1 skipped, as before).
  - Web app: new tests check that there is no `/crew` page, no address to it in the code except the redirect, nothing left of the jobs form or list, that `/crew` redirects to Help's crew section, that the sidebar, More, the phone's tabs and Pull-request review have no link to `/crew`, and that Help draws the crew section and its line-up. Lint, the type check and the build pass, and 795 of 795 tests pass. The built app was started and `/crew` answered 307 to `/help#crew`.
  - Nothing has run on the test server. The agent image must be rebuilt for the new instructions to reach containers.
- **Still open (what chat can't do yet that the jobs screen did; your decision):**
  - **No list of jobs.** The screen listed every job with its state (Waiting, Working, Done, Failed) and kept each report. From chat a job shows only as Tex saying it is queued, the specialist's lines while it works (web chat only, and gone after a reload), and the report in the chat. A failed job is said in the chat.
  - **No repo picker.** The form picked from the user's GitHub repos. In chat the user names the repo, or Tex looks it up with GitHub's own actions.
  - **Posting a review on the pull request** took one tick on the form, which was the yes. From chat it needs an approval card first: one more tap.
  - **Cancelling a job that waits** was never in the web app, and is still only for support.
  - **Turning on review per repo** has no chat route, by design. It stays on its own screen.
- **Docs updated:** `hld-mvp.md` section 2 ("Give the crew a job"), section 5.6 (the brief comes from chat; the report goes to that chat; the tick is the API's), section 12 (crew jobs not yet run for real; the repo list; a new open question on crew jobs without a screen); `backend-report.md` section 20 (crew jobs are given in chat; the example) and "The crew, as defined in the container" (the new part of the lead's instructions); the vm-manager's README (the lead's instructions).
- **Commits:** vm-manager `f447c58`; web app `ef166f3` (the screens, Help, the redirect, the tests) and `5210f12` (its README); backend: the docs commit that adds this entry.

### 16 October 2026: a blue dot on unread conversations

- **Where it is:** on `main` (backend, with migration 0025) and live in the web app since 16 October. The backend part is not on the test server yet.
- **Why:** you asked for the web app's chat list to show which conversations have something new in them: a reply from Tex, or anything else the user hasn't seen yet. Until now only the Automations chat had a mark, and each browser kept it for itself, so the phone and the laptop disagreed.
- **What the user notices:**
  - **A blue dot** before the name of a conversation with a message from Tex they haven't seen, and the name a little bolder. It shows in the list beside the chat and in the phone's drawer. With the list put away, the button that shows it has a dot too.
  - **Opening the conversation clears it**, on every device and tab, not only the one they used.
  - **A reply that arrives while the conversation is open** doesn't leave a dot. If the tab is in the background, it stays unread until the tab is shown again.
  - **Telegram counts the same way.** A reply on Telegram puts the dot on that Telegram conversation in the web app. Writing in that Telegram chat again counts as having seen what came before.
  - **The Automations chat** now takes its mark from the server too, so it is the same on every device.
  - **Nothing old lights up.** Everything said before the change counts as read.
- **Backend:**
  - **Two times per conversation:** when the agent last saved a message in it, and up to when the user has read it. A conversation is unread while the first is later. Every conversation in the api's answers now says `unread`.
  - **What changes them:** a message from the agent (a reply, an approval request, a run's answer, a copy sent to Telegram) moves the first. A message the user writes, in any channel, moves the second to that message. Both happen in the same database write that already updates the conversation's last-message time.
  - **A new address to mark one read:** `POST /v1/conversations/{conversationId}/read`. It works on any of the user's conversations, Telegram ones and the Automations chat too. Only an unread one is written; then the live stream says so (`conversation.updated`), so other tabs and devices drop the dot. Another user's conversation answers 404.
  - **Why a separate address, and not reading the messages:** the web app fetches messages for other reasons too (older pages, catching up after the connection drops), and a reply that arrives while a conversation is open comes over the live stream without any fetch. So "I have seen it" is its own small call, which the web app makes when it shows a conversation and when something new arrives in it.
- **Cost and speed:** no extra trip to the database per message, and marking costs one short write, only when something was unread. No container wakes and no credits are charged. Not measured.
- **Contracts:** `openapi.yaml` changed: a conversation has `unread`, and there is the new mark-read address. The web app follows on its own `feat/unread-dot` branch, and it treats `unread` as optional, so it works with the backend before and after this goes out. `vm.proto` did not change.
- **Database:** two new columns on `conversations` (migration 0025): the time of the agent's newest message and the "read up to" time. The migration gives each existing conversation the time of the agent's newest message in it for both, so none of them shows as unread. No new index. The server's deploy script runs the migration by itself.
- **How it was checked:**
  - New backend tests (9), in `test/unread.test.ts` and `test/unread-backfill.test.ts`:
    - the rule itself, with its edge cases (never read, the same moment, read later);
    - a reply makes a web conversation unread, the user's own message never does;
    - marking read clears it, sends one live event, and a second mark sends nothing; the next reply brings the dot back;
    - a conversation the user isn't in keeps its dot while they read another;
    - Telegram: a reply there makes it unread, writing there marks it read, and the web app can mark it read;
    - the Automations chat: a run's answer makes it unread, and it can be marked read;
    - another user can't mark it (404) and nothing changes; an unknown conversation is 404, no sign-in is 401;
    - the migration, run on a database of its own: old conversations with the agent's answers count as read, the ones without have neither time.
  - The whole backend suite: 81 files, 950 tests passed. Lint, types and the contract check pass.
  - The web app (its own README says how it works): 58 files, 826 tests passed, lint, types and the production build pass. Not looked at in a browser, and nothing has run on the test server.
- **Still open:**
  - Telegram never tells a bot that its message was read, so the last reply in a Telegram chat stays unread in the web app until the conversation is opened there, or the user writes in that chat again.
  - WhatsApp does report "read", which could also mark a conversation read. Not done, since WhatsApp isn't switched on.
  - To ship: merge the backend first and deploy (the migration runs by itself), then the web app. Either order works, because the web app treats `unread` as optional.
- **Docs updated:** `hld-mvp.md` section 2 (see what is new) and section 12 (built, never run for real); `backend-report.md` section 8 (the conversation table, a new part "Unread conversations", the web app's calls), section 12 (the events), section 40 (the `conversations` table) and section 41 (the chat row).
- **Commits:** backend `d4adfb9` (the feature) and the docs commit after it; web app `67c95fe` and `97fb3e9`.

### 15 October 2026: an approval holds exactly what runs, and a request asked again shows as "replaced"

- **Where it is:** on `main` and on the test server (backend), and live in the web app, since 15 October.
- **Why:** on 15 October your test email from web chat ("Email rahulkum94l94@gmail.com: subject Test, body Hello.") was never sent, and you were asked twice. What happened, from the server's logs, the approvals table, the activity log and Tex's own record of the turn (times in India time):
  1. **9:16 PM.** Tex asked to approve Gmail's send action with four inputs: `to`, `subject`, `body`, `user_id`. Gmail's send action at Composio has no `to`: the address goes in `recipient_email`. Tex never looked at the action's list of inputs in that turn; it guessed. The card showed "To". Tex then said it was waiting for your OK, which was true at that moment. (Since the approval question change below, Tex no longer writes that line.)
  2. **9:26:51 PM.** You pressed Approve in the web app, about 11 minutes later. The card has said "You approved this" since then, which is why the waiting message above it now reads oddly.
  3. **9:26:55 PM.** Your container woke and Tex got the yes. Its first try left out the approval's id and was refused ("needs the user's approval first"). Its second try had the id and the same four inputs: our check passed, and Composio refused the email ("Input should be a valid string on parameter `recipient_email`"). Its third try used `recipient_email`, and our own check refused it, because those were not the inputs you had approved.
  4. **9:27 PM.** Tex asked again with `recipient_email` (the card showed "Recipient email") and wrote "Sorry about that, the first approval had a parameter mismatch".
  5. **9:28:15 PM.** The second card was rejected from the web app, signed in as you, 58 seconds after it appeared. Nothing in the backend or the web app rejects on its own: running out of time and a support cancel both show as "expired", and the web app sends an answer only when a button is pressed. So "You rejected this" (now "You denied this") on that card was a real press of the Reject button. Tex then said the email had not been sent.

  The email was never sent. No credit was charged. The first approval is still "approved" and unused; it can't send anything, because Composio refuses its inputs, and it lapses 24 hours after the yes. None of the three failed tries is in the activity log, because only a tool call that succeeds is logged there.
- **What the user notices:**
  - **One request, one card.** A request whose inputs don't fit the action never reaches the user: Tex is told the action's real inputs at once and asks again, correctly, in the same turn. The card shows the inputs under the action's own names ("Recipient email").
  - **After Approve, the action runs as approved.** Tex no longer has to send the inputs again, so it can't get them wrong after the yes.
  - **If an app still refuses an approved action,** Tex is told to say in plain words that the app did not accept it and nothing was done yet, and to ask again. The earlier card then says "Replaced by a newer request", not "You approved this" or "You denied this". Pressing an old Telegram button for it says "That request was replaced by a newer one. Please answer the newest request."
  - **The Approvals screen** says "Tex was told to go ahead" for an approved request, instead of "Tex went ahead with it", which was not always true.
- **Backend:**
  - **A check when Tex asks.** For an app's action, `request_approval` compares the inputs with Composio's own description of the action: every input must be one the action has, every input it requires must be given, and each value must be the right kind (text, a number, a list). An empty value is left to the app. A request that doesn't fit is refused with the action's real inputs. The description comes from the app's list of actions, kept for 10 minutes; that list holds at most 200 actions and GitHub has more, so an action not on it is asked of Composio by name. When Composio can't be asked, the request is refused with "try again in a moment".
  - **The approval holds what runs.** An app action's approval always keeps its inputs (none given means none). `run_app_action` with the approval's id runs those saved inputs. Inputs sent again must be exactly the same, as before. The message that wakes Tex after a yes says to leave the inputs out.
  - **A new state, "replaced".** `request_approval` takes the id of an earlier request (`replaces_approval_id`). The earlier one, if still waiting or approved and unused, becomes "replaced": it can't run and can't be answered, the web app is told at once, and the activity log says "Asked again with corrected details". It must be the same user's request for the same action.
  - **Clearer messages to Tex.** A risky action tried without the approval's id now says "if the user already approved it, use that approval_id", so Tex doesn't ask twice. An approved action the app refuses says nothing was done and how to ask again.
  - **Fixed on the way:** an app whose name has an underscore (Microsoft Teams, OneDrive) is now found from the action's name when Tex asks; before, the card had no app.
- **Cost and speed:** when Tex asks for an approval, the action's description is read from the list the api already keeps for `list_app_actions`; at most one more Composio request when the list has expired or lacks the action. No change to credits. Not measured.
- **Contracts:** `openapi.yaml` changed: an approval's status can now be `replaced`, and the list of approvals can be filtered by it. The web app follows, on its own `fix/approval-args` branch. `vm.proto` did not change.
- **Database:** none. The status column is plain text, so the new state needs no migration (checked: `db:generate` finds nothing to do).
- **How it was checked:**
  - New tests (15), in `test/approval-args.test.ts`. 13 of them fail on the old code; the other checks behaviour that did not change.
    - a name the action doesn't have (`to`) is refused, with the real inputs, and nothing is saved or shown;
    - a missing required input and a wrong kind of value are refused; an empty value and an input that takes several kinds pass;
    - an action the app doesn't have is refused; Composio being down refuses with "try again";
    - an action left off the 200-action list is asked of Composio by name, once, and checked;
    - a request without inputs holds none and runs with none, and inputs added after the yes are refused;
    - a request that is not about an app's action is saved as before;
    - after a yes the saved inputs run with no inputs sent, once only; the same inputs sent again also work; changed ones are refused and the approval stays usable;
    - the message without an approval's id points Tex to the id it already has; the wake-up after a yes says to leave the inputs out;
    - the app refusing an approved email: nothing sent, the approval stays usable, asking again replaces it; the replaced one is listed as "replaced" (not "rejected"), can't run, and answering it gets 409 "replaced by a newer one"; the new one runs;
    - a waiting request can be replaced; a rejected one stays rejected;
    - replacing another action's request or another user's is refused;
    - a late Telegram tap on a replaced request gets the "replaced" message;
    - the 15 October email replayed: one card, one yes, the email goes out with `recipient_email`.
  - Changed: the stand-in for Composio can now answer for one action by name, and the approval question's tests (`test/approval-message.test.ts`) now use that stand-in, because asking now reads the action's inputs from Composio.
  - Lint and the type check pass. The full backend run: 927 of 927 tests pass.
  - The web app: 2 new tests on the words for each state; lint, the type check and the build pass, and 804 of 804 tests pass.
  - The investigation read the server's logs, the approvals table (through the product's own admin function, inputs' names only), the activity log and Tex's record of the turn in your container's folder (tool names, input names and error texts only). Nothing on the server was changed.
  - Not yet run on the server.
- **Still open:**
  - **The "I'm waiting for your approval" line** under a card that later says "You approved this" was Tex's own closing line, written right after it asked, as its instructions then said. The approval question change below removed it. Not touched here.
  - **Failed tool calls are not in the activity log.** That is why the failed email could only be found in Tex's own record. Logging a refused app action (without its inputs) would make this visible to you and to support. Your decision.
  - **A crew job's approval** still needs Tex to send the brief again after the yes; it is compared exactly, as before. It could run from the saved brief the same way. Not changed here.
  - **The Approvals screen has no tab for replaced requests.** The newer request is listed; the replaced one shows only in the chat.
- **Docs updated:** `backend-report.md` section 13 (the `request_approval` row) and section 15 (the life of an approval, a new part "The inputs are checked when the agent asks", "Single use and exact match", a new part "Asking again: replaced", "What can go wrong"); `hld-mvp.md` section 5.3 and section 12.
- **Commits:** backend `9a24178` (contract), `326d791` (the fix), and the docs commit on the same branch; web app `b0eb988` (contract), `9ee3d16` (the words).

### 15 October 2026: Telegram replies: where the time goes, "typing…" while the agent works, and fewer waits

- **Where it is:** on `main` and on the test server, in the backend and in the vm-manager, since 15 October.
- **Why:** you said replies from your agent on Telegram take too long, and asked which AI model it uses and whether the "high/low" setting is right. So the last Telegram turns on the test server were taken apart, stage by stage, from their stage times and the logs.

  **Where the time went.** There are two Telegram turns in the stage times, one on each of your accounts. Both woke a sleeping container. Both ran on Claude Code, on your Claude plan, with the model and effort you chose in Settings: Sonnet 4.6, effort "low".

  | Stage | Your new account, 15:33 | Your old account, 15:14 | What it is |
  |---|---|---|---|
  | Telegram to our server, until the job is queued | about 0.5 s | about 0.5 s | The webhook: find the chat, save the event, queue the job. Not in the totals below |
  | Waiting for the worker and the lock | 0.00 s | 0.00 s | Nothing was waiting |
  | Reading and saving the message | 1.6 s | 1.5 s | 6 to 7 trips to the database, one after another |
  | Credits and the route | 0.23 s | 0.21 s | One trip. No router on the server, and a Claude-plan turn skips it anyway |
  | Waking the container | 3.0 s (from sleep) | 4.7 s (made again, a new image) | The vm-manager: room under the awake limit 0.43 s, start 0.38 s, Bridge ready 0.56 s. The rest is our own and the vm-manager's trips to the database |
  | Memory and the recap | 0.46 s | 0.21 s | Read after the wake |
  | Handing the message to the Bridge | 0.66 s | 0.67 s | The vm-manager's trips to its database, then the Bridge takes it |
  | Claude Code starting | 2.2 s | 3.7 s | The program starts and connects to our tools. About 1 s in a container that is already awake |
  | The model, until its first words | 5.1 s | 2.8 s | Sonnet 4.6. The prompt cache was cold: 0 tokens read, 15 to 20 thousand written |
  | Tool calls and later rounds | 0.07 s | 0.03 s | One model round, no tool |
  | The reply, until it is on Telegram | 1.5 s | 1.4 s | `send_message` alone took 1.36 s on our server (5 trips), then the outbound job sends it |
  | **The answer, after** | **14.9 s** | **15.1 s** | |
  | Ending the turn, after the answer | 0.42 + 0.23 s | 0.46 + 0.22 s | The user already has the answer. The billing is a job of its own after this (no wait) |

  For comparison, your web chat turns of the same afternoon with the container already awake took 6.3 to 6.5 s for a short answer, of which the model was 1.3 to 1.9 s (cache warm, 14 to 19 thousand tokens read). A Telegram turn with the container awake pays the same plus about 1.3 s more for reading and saving the message: about 8 s, which matches the 8.5 s measured earlier.

  So in a warm Telegram turn about 5 s of the 8 is the database at Neon's distance: about 20 trips one after another, 0.2 to 0.26 s each (2 in the webhook, 7 reading and saving the message, 6 around the wake and the hand-over, 5 for the reply). About 1 s is Claude Code starting, and 1.5 to 2 s is the model. From sleep, the wake (3 to 4.7 s), a slower first start of Claude Code (2 to 4 s) and a cold prompt cache come on top.
- **The model and the effort.**
  - **Which engine ran:** Claude Code on your own Claude plan, on both accounts. Hermes did not run: the server has no provider key for Textcrew AI and no key for the router (Jev).
  - **Which model and effort:** `claude-sonnet-4-6` with effort `low`, on both accounts. You chose them in the web app's AI settings (on the new account at 14:21 today). They are kept in the agent settings, travel with every Claude Code turn, and the Bridge starts Claude Code with `--model` and `--effort`. Effort low is right for chat: the model thinks little before it answers. One web turn at 14:19, just before you set "low", thought for 14 seconds before its first word.
  - **When "Default" is left:** Claude Code picks. On a Max plan that is Opus 5.5 at effort medium (seen in the vm-manager's checks of Claude Code); Sonnet 4.6's own default is high. The platform sets no default model of its own (`BRIDGE_CLAUDE_MODEL` is not set). The crew uses the lead's model and effort.
  - **A cheaper, faster choice:** Sonnet 4.6 is an older model. For short chat, Haiku 5.5 at "low" is likely the quickest; Sonnet 5.5 is the current Sonnet. Not measured here. You can switch in Settings at any time.
  - **Prompt caching:** Claude Code uses Anthropic's prompt cache by itself, and it works: turns a few minutes apart read 14 to 51 thousand tokens from it. The two Telegram turns came more than an hour after the last one, so the cache had expired.
  - **The size of the prompt:** about 15 to 20 thousand tokens at the start of a conversation: Claude Code's own instructions and tools, the three crew members, our 15 platform tools and our instructions. Normal for Claude Code; it is cached between turns.
  - **Hermes (not running today):** Textcrew AI uses `cheap` (Llama 3.3 70B through OpenRouter) on Free and for quick replies, and `claude` (Claude Sonnet 5) on Pro and Max (`infra/litellm/config.yaml`). Neither our Hermes settings nor LiteLLM set a reasoning effort, so Hermes's own default applies; Hermes's source could not be checked from here. LiteLLM is not set to add prompt-cache marks, and the container asks for the name `agent-default`, so Hermes likely sends none: every model call would pay for its whole prompt again. Both are worth checking once a provider key works (see "Still open").
- **What the user notices:**
  - **"typing…" in Telegram** within about a second of sending, kept up while the agent works, gone with the answer. Before, the chat showed nothing for 8 to 15 seconds.
  - **Replies come about 1.5 to 2 s sooner** (estimate for the server, see "Cost and speed").
  - Nothing else changes: the same answers, the same credits.
- **Backend:**
  - **"typing…" on Telegram.** As soon as a message is known to be for the agent (after the special cases: link codes, `/new`, approval answers, coupons), the worker sends Telegram's "typing…" to the chat, and again every 4 seconds until the turn is over (Telegram keeps it about 5 seconds). The same for the agent's answer to an approval asked in a Telegram chat.
    - Just before any message goes to a Telegram chat, the sender notes it in Redis. "typing…" then waits 6 seconds, so it never comes back under the answer while the turn ends (about 1 to 2 s on the server). If the turn goes on after a message, "typing…" comes back.
    - It never holds up or fails a turn: a failed call is logged and the next one tried at the usual time.
    - A new setting, `TELEGRAM_TYPING`, turns it off (`false`). It is on by default and shown on the admin settings page. Web chat, WhatsApp and iMessage are unchanged.
  - **Reading and saving a Telegram message: 2 trips fewer.** The chat's "last message" time (which also clears the "blocked" mark) is written beside the next steps instead of before them; the turn starts only once it is saved, and a failed write still fails the job, which then runs again. Saving the message reads "already saved?" and the chat's active conversation at once.
  - **The turn: 1 to 2 trips fewer.** Whether the user's container exists is read with the turn's first reads (credits, settings, conversation), not after the route. The memory block and which engine had the conversation are read while the container wakes, not after it. Only reads; the user's lock keeps any other turn from changing them meanwhile.
  - **The reply: 2 trips fewer before it reaches Telegram.**
    - `send_message` checks that the chat is the user's and reads the turn's conversation at once; the conversation is not read a second time when the message is saved.
    - The send is queued as soon as the message is saved; the conversation's last-message time (the order of the chat list) is saved after it. That write no longer fails a message that is already on its way: before, a failure there made the Bridge send the answer again.
    - A crew job's report is saved beside the message.
- **vm-manager:**
  - **Delivering a message: 1 trip fewer.** The turn's start is written as activity beside the hand-over to the Bridge, not before it. Nothing needs it first: the delivery counts as in flight, so neither the idle check nor the awake limit can stop the container, and the turn's end writes the activity again. A failed write is logged.
  - **Waking from sleep: 1 trip fewer.** "Awake" and the time of last activity are written in one statement instead of two.
- **Cost and speed:**
  - Measured with the test `read-round-trips.test.ts` (every query waits 260 ms, every new connection 2 s; the vm-manager and the AI are fakes that take no time, so only our own work is in it), on the code before and after:

    | A Telegram message | Before | After |
    |---|---|---|
    | The webhook answers Telegram | 0.79 s | 0.79 s |
    | The first "typing…" | none | 1.05 s |
    | The reply reaches Telegram | 5.04 s | 3.68 s |
    | The job ends | 6.09 s | 4.74 s |

    On the server the memory read also hides behind the wake (here the wake takes no time), about 0.25 s more.
  - The vm-manager's two changes save one trip each to its database, about 0.2 s: on every turn, and again on every wake from sleep. Not measured on the server.
  - **Expected on the server:** a Telegram reply with the container awake about 1.8 s sooner (8 s to about 6 s); from sleep about 2 s sooner (15 s to about 13 s). Not measured yet.
  - **Telegram:** one extra Bot API call ("typing…") every 4 seconds while a turn runs. Free, and far under Telegram's limits.
  - **Redis:** one short note per message sent to a Telegram chat, gone after 6 seconds.
  - Credits: no change.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change. One new setting, `TELEGRAM_TYPING` (in `.env.example`). Inside the vm-manager its store has one new write (`MarkAwake`); nothing outside it changes.
- **Database:** none. No new table, column or index, in either service.
- **How it was checked:**
  - Backend, new tests:
    - `test/telegram-typing.test.ts` (6): "typing…" goes out before the agent has the message, is kept up while it works, and never comes after the answer; after a message in the middle of a turn it pauses, then comes back while the work goes on; the agent's answer to an approval asked in a Telegram chat gets it too; a failing "typing…" never holds up the turn; `TELEGRAM_TYPING=false` sends none; nothing for web chat, nothing for a chat that is not linked.
    - `test/telegram-reply-speed.test.ts` (7): a chat marked blocked that writes again has the mark cleared before the agent answers; a failed write of the chat's last message time fails the job and the next try answers once; with every query delayed, at most 8 rounds of queries before the agent gets the message (11 before) and 3 from its answer to Telegram (5 before); `send_message` reads the chat and the conversation at the same moment, and the conversation once; a reply goes out once even when the conversation's last message time can't be saved (before: never sent); whether the container exists is read with the turn's first reads; memory and the engine record are read while the container wakes, and the memory still reaches the agent.
    - Each new test was also run on the code before the change: the ones about speed and the one about the failed write fail there, as they should.
    - `test/read-round-trips.test.ts` now also follows a Telegram message (the table above). The test database meter can now make one query fail, and count rounds of queries.
  - vm-manager, new tests (`internal/sandbox/fewer_waits_test.go`, and the store suite on memory and on real Postgres): a wake from sleep writes "awake" and the activity once, a warm wake writes neither; a delivery reaches the Bridge while the activity write is still held, the write then lands, and a failing write does not fail the delivery; `MarkAwake` never moves the last activity backwards. Both sandbox tests fail on the code before.
  - Results: see "Test results" below.
  - Not yet run on the server.
- **Test results:**
  - Backend: lint and the type check pass. The full run: 916 of 916 tests pass (76 files).
  - vm-manager: `go vet` is clean, the linter finds 0 issues, and `go test -race ./...` passes in every package, the store suite on real Postgres included. The Bridge's tests (unchanged): 239 pass, 1 skipped (the real browser).
  - On this laptop the test runs kept their temporary files on the main disk, because `/tmp` was full with other test runs. One Bridge test (the browser meter reached through a link) fails when the temporary folder's path has a space in it; it passes with the usual `/tmp`, on this branch and on `main`. Inside a container the paths have no spaces.
- **Still open (your decisions):**
  - **Moving Neon closer.** The biggest share of a warm reply is still trips to the database in Ohio: about 13 in a row after this change (20 before), 0.2 to 0.26 s each. Neon in Singapore (about 50 ms from Mumbai) would take about 2.5 s more off every Telegram turn, and the vm-manager's trips too. Same plan price; it needs a move of both databases with a short stop.
  - **Keeping containers awake longer.** A message after more than 3 idle minutes pays the wake (3 to 5 s), a slower first Claude Code start (1 to 3 s more) and often a cold prompt cache (2 to 3 s more). An idle stop at 10 or 15 minutes would spare that for messages in that window. Cost: the awake time is charged to users in credits, and each awake container holds about 600 MB of the server's memory (the test server allows 3 at once).
  - **A default model for chat.** With "Default" left in Settings, a Claude-plan user runs Claude Code's own choice: Opus 5.5 at medium on Max, which thinks longer than a chat reply needs. A platform default (for example Sonnet 5.5 or Haiku 5.5 at "low") would be faster. It is the user's plan and the answers' quality, so it is your call. For your own account: Haiku 5.5 or Sonnet 5.5 at "low" in Settings is worth a try.
  - **Hermes, once a provider key works:** turn on prompt caching for the Anthropic model in LiteLLM (it can add the cache marks itself), set Hermes's reasoning effort explicitly (low for chat), and check the models: Llama 3.3 70B for Free is weak with tools.
  - **Claude Code starts for every turn** (about 1 s awake, 2 to 4 s after a wake). Keeping one Claude Code running per conversation between turns would save most of it. A larger change in the Bridge; it needs a design first.
  - **Answers streamed on Telegram.** Telegram gets the answer in one piece. Showing it as it is written (editing the message) costs many Bot API calls and helps mainly long answers; "typing…" covers the wait for short ones.
  - **"typing…" half a second sooner.** The worker reads the event and the chat's link before it knows where to send "typing…" (2 trips). The job could carry the chat from the webhook. Small; not done.
  - **The vm-manager's end of a turn** writes 3 times to its database before it tells the backend the turn is over (about 0.6 s before the next message can start). It could tell first; that needs care with the "busy" state. Not changed.
  - The 16.4 s and 8.5 s turns measured earlier are no longer in the stage times of your two accounts, so the table above uses the two Telegram turns that are.
- **Docs updated:** `backend-report.md` section 4 ("Keeping reads fast"), section 9 (what the turn reads at once, a new part "\"typing…\" in the chat"), section 10 (the path), section 33 (waking, delivering) and section 42 (the new setting); `hld-mvp.md` section 5.2, step 7.
- **Commits:** backend `ef701b8` (the measuring test), `851ba42` (fewer trips for a Telegram message), `7b89896` (the turn's early reads), `2438629` ("typing…"), and the docs commit that adds this entry; vm-manager `c6611b6`.

### 15 October 2026: when Tex asks for an OK, it says what it wants to do, and the "working" sign stops

- **Where it is:** on `main` and on the test server (backend), and live in the web app, since 15 October.
- **Why:** the founder tested an email in web chat at 21:15 IST. The question said only "Approval needed: <summary>", and under its card the chat kept showing "Tex is working…" until the agent's own line ("I've asked for your OK…") came about 3 seconds later. After he tapped Approve, nothing showed Tex at work until its answer, which took 25 seconds with a cold container. He wants Tex to say plainly what it wants to do and that it waits for his Approve, and the "working" sign to stop while Tex only waits for him.
- **What the user notices:**
  - Tex's question reads like Tex: "I'd like to send an email to x@acme.com with subject "Test". Approve or Deny below." In web chat the Approve / Deny card sits right under it. On Telegram (and WhatsApp) the two buttons say ✅ Approve and ❌ Deny. On iMessage the line under it says "Reply YES to approve or NO to deny."
  - In web chat the "Tex is working…" bubble stops as soon as the question is there, and a quiet line under the card says "Waiting for your OK".
  - After Approve or Deny, "Tex is working…" shows again at once, until Tex's reply: the result after Approve, one sentence saying it won't do it after Deny.
  - Tex no longer adds its own "waiting for your OK" line after the question.
  - The word is Deny everywhere: the buttons, the Approvals screen ("Denied") and the activity log ("Denied: …").
- **Backend:**
  - The question is made from the approval's own summary: "I'd like to " goes before it, its first word in small letters, then the way to answer for that chat. A summary that does not start with a common verb is kept as written ("I'd like your OK for this: …"). No model is asked, so it is there at once and costs nothing.
  - The `request_approval` tool tells the agent to write the summary as what it will do, starting with the verb, and to end its turn without repeating the question or saying it waits. Its answer now holds the question the user sees and that instruction.
  - After Deny, the message that wakes the agent asks it to say in one short sentence that it won't do it.
- **vm-manager:** nothing. When the agent ends its turn with no text, the Bridge already sends nothing.
- **Cost and speed:** the question costs no credits and no model call. The asking turn no longer writes a closing line, so it ends one short model round sooner and writes fewer words (about 1 to 3 seconds; not measured on the server yet). The follow-up after Approve or Deny costs what it did.
- **Contracts:** none. The question is the same message with its approval id; only its text changed. The decision in the API is still `approve` / `reject`, and the state `rejected`.
- **Database:** none.
- **How it was checked:** backend: a new test file (the question's wording for each chat, a summary that doesn't start with a verb, the tool's answer, the message saved and sent on the live stream, and the Deny follow-up's instruction) and the existing approval, iMessage, plain-text and ops-script tests updated: lint, types and all 908 tests pass. Web app: tests for when the thread waits and when it works, for the steps folding into the question, and for the question drawn above the card: lint, types, the build and all 760 tests pass. Tried in the web app's demo mode at 1280 and 390 pixels wide: the question with its card and "Waiting for your OK", then "Tex is working…" right after Approve, then the reply; the same with Deny. Not yet tried against the server.
- **Still open:**
  - WhatsApp's template for a question sent after 24 hours was registered with its own words around the text; with the new text it may read twice. WhatsApp is not live.
  - On Telegram the buttons stay under the question after a tap, and Telegram shows no "working" sign while Tex finishes.
  - In the founder's test the approved email was not sent: Tex tried at 21:27 IST, Gmail (through Composio) refused it, and Tex asked again. The reason is not in the logs, because the tools' errors are not logged. This change does not touch that.
- **Docs updated:** `hld-mvp.md` 5.3; `backend-report.md` 12 (the web app's rules), 15 (the life of an approval, what can go wrong) and 20 (the crew job example).
- **Commits:** backend c16d374, 3283290 and this entry. Web app 6280bc4, 2bd9523.

### 15 October 2026: the bot and Tex point to Integrations, and the user sees more about each linked chat

- **Where it is:** on `main` and on the test server (backend), and live in the web app, since 15 October.
- **Why:** the web app now has one Integrations page (`/integrations`), with tabs for the chat apps, the apps (`/integrations/apps`) and the user's own MCP servers. Settings → Channels is gone and `/apps` only redirects, but the backend still sent people to both. Also, an admin could see for each linked chat its masked chat id, when it last wrote and whether the user blocked the bot. The user could not see this about their own chats.
- **What the user notices:**
  - **A chat that is not linked** gets: "Open Integrations at https://app.textcrew.in/integrations and send me the code you get there", instead of "go to Settings → Channels".
  - **A chat linked to another account** that sends a code is told to sign in to that account at the same address and unlink the chat in Integrations.
  - **Tex says "the Integrations page"** when an app is still connecting, needs connecting again or is not connected, with the address `https://app.textcrew.in/integrations/apps`. After an app's sign-in the browser comes back to that address too.
  - **In Integrations → Chat apps,** each linked chat now shows its chat id masked ("•••• 4821"), "Last message 2h ago", and "Blocked the bot", with what to do, when the user blocked the bot there.
- **Backend:**
  - The bot's two link replies use the Integrations page's address and the word "Integrations". No other text of the bot or of Tex said "Settings → Channels".
  - The Apps address the backend builds is now `/integrations/apps`. It is the page to come back to after an app's sign-in, when the web app names none, and the address in the notes Tex gets about apps that are not ready. Old links to `/apps` keep working: the web app redirects them.
  - The user's own list of linked chats (`GET /v1/channels`) gives for each chat the masked chat id, when it last wrote (or nothing if that was never recorded), and whether the user blocked the bot. They are worked out exactly as for the admin's list. The full chat id is never sent.
  - The script that copies the contract to the web app (`pnpm openapi:sync`) wrote to a folder that no longer exists, `../user-frontend/ignore`. It now writes to `../user-frontend-web/ignore`.
- **Cost and speed:** nothing. The three new fields come from the row that was already read.
- **Contracts:** `openapi.yaml` changed, only by adding. `ChannelLink` gets three optional fields: `maskedChatId`, `lastInboundAt` (may be null) and `blocked`. The default return page of `POST /v1/apps/{appSlug}/connect` now reads `/integrations/apps`, and the admin's `AdminUserChannel.label` description says Integrations → Chat apps. The web app has the new copy and treats the new fields as optional, so it works with the server before and after the deploy. `vm.proto` did not change.
- **Database:** none.
- **How it was checked:**
  - New tests: the user's list shows the masked chat id, the last message and blocked, the same as the admin's list says for the same chats, and never the full chat id; a short chat id shows nothing of itself; blocking shows, and writing again clears it and moves the last message on; only the user's own chats are listed.
  - Changed tests: the two link replies name the Integrations address and not Settings; the page to come back to after a sign-in and Tex's notes use `/integrations/apps` and "the Integrations page", also for one named app that is not connected; `/integrations` addresses are not taken for purchase links on Telegram.
  - Lint, type-check and the OpenAPI lint pass. The first whole test run had 904 of 906 passing. The two that failed were timing tests (the page reader's speed limit, 5.7 seconds where 5 are allowed, and the billing job's retry count) while other test runs were using the machine. On their own both files passed, and a second whole run passed 906 of 906.
  - The web app: lint, type-check, its 755 tests and a production build pass.
  - Not run on the test server.
- **Still open:**
  - The vm-manager's Bridge still tells Tex, in its opening lines, that the user connects apps "on Textcrew's Apps page, https://app.textcrew.in/apps" (`agent-image/bridge/core.py` and its tests). The redirect keeps that working; changing it to the Integrations page is a small vm-manager change for another piece of work.
  - `CLAUDE.md` still says `pnpm openapi:sync` copies to `../user-frontend/ignore/`.
- **Docs updated:** `backend-report.md`, section 7 (the replies to an unknown or already linked chat, unlinking, and a new part "What the user sees for each linked chat"), section 14 (the page to come back to, the notes Tex gets, an example and one item under what can go wrong) and section 31 (what the user sees for a chat).
- **Commits:** backend `fa85985`, `ef5e6c8`, `5ebf630`, `8f08077`, `28f62f8`, and the docs commit with this entry; web app `42aac50`, `795a997`, `1a04678`, `2f6ec18`.

### 15 October 2026: connecting the same account again replaces the old connection, and its automations move over

- **Where it is:** on `main` and on the test server since 15 October.
- **Why:** to move a user from Composio's shared Google sign-in app to our own, the user connects the app again. That made a second connection next to the old one, which caused three problems:
  - **Tex picked either one.** The server took "an active connection" with no order, so which one Tex used was not defined.
  - **Automations stayed on the old connection.** An automation of the kind "when an email arrives" watches the connection it was made on. Removing the old connection would stop it without a word.
  - **The old connection stayed.** The user kept seeing it, and Google kept listing Composio's app in their Google account.

  The same happened after **Reconnect** on a connection that had expired: its automations stayed on the dead connection.
- **What the user notices:**
  - **After connecting the same account again,** the Apps page shows one connection for it, the new one, a few seconds later.
  - **Automations keep working,** now on the new connection. One that stopped because its connection expired works again after Reconnect.
  - **A second account of the same app is kept.** "Add account" (two Gmail addresses, for example) works as before.
- **Backend:**
  - **Tex uses the newest active connection** of an app. New automations and the git gateway use the same one.
  - **A new job, `settle-connection`, in the system queue.** It is added whenever a connection becomes active, in any of the four ways: the app list, the check job, Composio's webhook, or an admin's recheck. One job per connection.
  - **What the job does:**
    1. It looks for the user's older connections of the same app to the same account. "The same account" means the same account label, which is the email Composio gives for the account, in any letter case. A label we don't have yet is asked of Composio first, and kept.
    2. For each one, it moves the user's app-event automations to the new connection: a new trigger on the new connection, the automation pointed at it, then the old trigger removed. Which automations watch the old connection is asked of Composio.
    3. It removes the old connection at Composio, then in our database.
  - **What it never removes:**
    - a connection to another account of the app;
    - any connection, when neither side has a label: it could be a second account;
    - a newer connection;
    - a connection still being set up;
    - another app's connections.
  - **Safe to re-run.** A run that finds nothing to do does nothing. If a run stops after making a new trigger but before saving it, the next run uses that trigger instead of making another. An old account Composio no longer has counts as removed. Runs for the same user wait for each other, with a short lock of their own (not the lock a turn holds).
  - **The automations module does the moving** (`moveAppTriggers`). The integrations module never touches the automations table.
- **Cost and speed:** a few Composio calls each time a connection becomes active: one or two to read account labels, and, when an old connection is replaced, two to list triggers, one per moved automation, and one to remove the old account. None of them is an app action. Fewer trigger events later: an old connection's triggers no longer run next to the new ones.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change.
- **Database:** none. No new table or column.
- **How it was checked:**
  - New tests (15), in `test/connection-replace.test.ts`:
    - Tex gets the newest of two active connections, never a pending one;
    - a connection that becomes active queues exactly one job, and another status queues none;
    - an automation moves to the new connection, the old trigger and old connection are removed, here and at Composio;
    - an expired connection to the same account is replaced too, and its automation works again;
    - a missing label is asked of Composio and kept;
    - a second account is never removed, nor anything when there is no label, nor a newer, pending or other app's connection;
    - a connection that is gone or not active is ignored;
    - a second run finds nothing to do;
    - Composio refusing to remove the old account fails the job, and the next try finishes without moving anything twice;
    - an account Composio no longer has counts as removed;
    - a trigger left by a run that stopped half-way is reused, even when Composio added a setting of its own to it;
    - two runs for one user don't overlap, and the lock is given back;
    - an admin's recheck that finds the connection active queues the job too.
  - Changed: the stand-in for Composio now remembers which account each trigger watches, and which accounts were removed; one pull-request review test checks that field.
  - Lint and the type check pass. The full backend run: 892 of 892 tests pass.
  - Not yet run on the server.
- **Still open:**
  - **The label is Composio's email for the account.** Whether Composio gives it for every Google app is not confirmed. Where it doesn't, the old connection is kept, and Tex simply uses the newer one. The user can remove the old one with **Disconnect**.
  - **Disconnecting a connection by hand still leaves its automations on it.** Unchanged here.
  - **The web app doesn't yet ask users to connect again** when a connection is on an older setup (the "Reconnect" marker). It waits until we switch an app for everyone.
- **Docs updated:** `composio.md` section 9 (step 6, "Switching an app that people already use") and section 11 (a row for two connections that stay); `backend-report.md` section 3 (the system queue), section 14 (a new part "Connecting the same account again", the agent's choice of connection, "What can go wrong"), section 18 (where an app-event trigger watches) and section 44; `hld-mvp.md` section 12.
- **Commits:** `d19219e`, and the docs commit on the same branch.

### 15 October 2026: a scope check in the ops script, before asking Google to review our sign-in app

- **Where it is:** on `main` and on the test server since 15 October.
- **Why:** a scope is one permission a sign-in screen asks for, such as "see and edit your calendar events". Google sorts scopes into four classes, and the class decides what Google wants before real users can allow our own Google sign-in app:

  | Class | What Google wants | Example |
  |---|---|---|
  | Basic | Nothing beyond the brand check | Your name and email |
  | Non-sensitive | Nothing beyond the brand check | `drive.file`: only files the app made or the user picked |
  | Sensitive | Google's review: a demo video and a reason for each scope | Calendar, Docs, Sheets |
  | Restricted | Google's review and a yearly outside security check (CASA), about US$675–855 a year | Reading Gmail, all of Drive |

  Our server sets no scopes. Each app uses Composio's default set, and Composio does not publish it. So before you ask Google for a review, we need to know exactly which scopes each app asks for.
- **What the user notices:** nothing. It is a command for us.
- **Backend:**
  - **A new command, `scopes`,** in `scripts/dev-user.ts`. Example: `scopes --app googlecalendar`. It prints, one line each:
    - the setup the app uses (or would use for a given user, `--user` or `--email`), and whether it is Composio's shared sign-in or our own sign-in app;
    - the scopes that setup names, or "Composio's default set" when it names none;
    - the scopes Composio's sign-in for the app always asks for;
    - Composio's recommendation for the app's actions: the narrowest set and the smallest set. `--tools` limits it to some actions. Composio marks this part as "beta", so it may say "not available";
    - for a Google app, each scope's class at Google and what that class needs, then the hardest class of them all.
  - **It only reads.** It makes no setup at Composio and starts no connection.
  - **It prints no secret.** A setup at Composio keeps our sign-in app's client id and secret next to its scopes. The command reads the scope fields only, never the others.
  - **Google's classes are a small table in our code,** from Google's own scope pages for Gmail, Drive, Docs and Sheets, read on 15 October. Google's Calendar page gives no classes; Google names reading calendar events as its own example of a sensitive scope. A scope that isn't in the table is printed as "look it up at Google", never guessed.
- **Cost and speed:** none. Each run asks Composio up to four questions about setups and apps. None of them runs an action in an app.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change.
- **Database:** none.
- **How it was checked:**
  - New tests (13), in `test/composio-scopes.test.ts`, all against a stand-in for Composio, never the live key:
    - only the scope fields of a setup are read: a setup holding a client id and secret gives back its scopes and nothing else;
    - scopes written as a list, or as text with commas or spaces, are read;
    - the scopes Composio's sign-in always asks for are taken from its sign-in method;
    - Google's classes: Gmail reading and Drive are restricted, sending mail alone is sensitive, Calendar, Docs and Sheets are sensitive, `drive.file` is non-sensitive, an unknown scope is not guessed;
    - the command for our own Calendar app and a trial user prints exactly the expected lines, and makes and starts nothing;
    - for Gmail on Composio's shared sign-in it prints "Composio's default set" and ends with "restricted";
    - `--tools` asks about just those actions;
    - an app with no setup says what would happen and makes none;
    - Composio being down is reported, not a crash;
    - an app that isn't Google gets no Google classes;
    - an unknown app is refused.
  - Lint and the type check pass. The full backend run: 877 of 877 tests pass.
  - Not run against the live Composio key: the founder decides when. It is safe to run on the server: it only reads.
- **Still open:** run it once on the server for each Google app before our own Google sign-in app is set up: `cd /opt/textcrew && ./dc --profile app exec -T api node --import tsx scripts/dev-user.ts scopes --app googlecalendar`.
- **Docs updated:** `composio.md` section 9 ("What Google wants first", and step 3, part A); `backend-report.md` section 14 ("What can go wrong").
- **Commits:** `59672a0`, and the docs commit on the same branch.

### 15 October 2026: a trial switch, so only some users connect through our own Google sign-in app

- **Where it is:** on `main` and on the test server since 15 October.
- **Why:** when someone connects a Google app, Google's screen says "continue to Composio". To make it say Textcrew, each Google app needs our own sign-in app at Google. Google must review that app first. While it does, at most 100 people can ever use it, and each of them sees a "Google hasn't verified this app" warning. Until now an app had one setup for everyone, and there is only one server. So there was no way to let you and a few testers try our own sign-in app while everyone else stays on Composio's.
- **What the user notices:** nothing, until the two new settings are filled in. Then:
  - a user named in the trial list connects that app through our own sign-in app. Google's screen names Textcrew, and there is no Composio page on the way;
  - everyone else connects as before;
  - an app with only a trial setup shows a **Connect** button to trial users and "Not available yet" to everyone else.
- **Backend:**
  - **Two new settings.** `COMPOSIO_TRIAL_AUTH_CONFIGS` names a second setup per app, written like `COMPOSIO_AUTH_CONFIGS`, for example `{"googlecalendar":"ac_…"}`. `COMPOSIO_TRIAL_USERS` names who gets it: user ids, or email addresses, separated by commas.
  - **An email counts only once it is verified.** Otherwise anyone could sign up with your address and be let in.
  - **For a trial user, the trial setup comes first,** before every other setup of that app. Plan limits still apply first: a Free user gets no Pro app this way.
  - **Both settings are checked when the api and the worker start.** A damaged value stops the start and says what is wrong: not JSON, not an app name, an id that doesn't start with `ac_`, or something that is neither a user id nor an email. The older `COMPOSIO_AUTH_CONFIGS` quietly turns every app off when damaged; this one cannot.
  - **The ops script's `apps` command** shows a trial user's setup as coming from `COMPOSIO_TRIAL_AUTH_CONFIGS`.
- **Cost and speed:** with no trial users, nothing changes. With some, one quick read of the user (from the short-lived copy) when the app list is shown or an app is connected, and only when the list holds an email.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change.
- **Database:** none.
- **How it was checked:**
  - New tests (9), in `test/composio-trial.test.ts`:
    - the two settings are read, and every kind of damaged value stops the start with its reason;
    - a user named by verified email or by id is a trial user; an unverified email or anyone else is not;
    - a trial user connects straight to the provider with the trial setup, while another user gets the usual shared setup;
    - for a trial user, the trial setup wins over `COMPOSIO_AUTH_CONFIGS`, and other apps are untouched;
    - an app with only a trial setup can be connected by trial users only, and nothing is made at Composio;
    - plan limits still come first.
  - Lint and the type check pass. The full backend run: 864 of 864 tests pass. One run before that had a single failure in `test/turn-billing.test.ts`, a test this change doesn't touch; it passed three times on its own, and the full run again after that.
  - Not yet run on the server.
- **Still open:** filling in the two settings is yours, once our own Google sign-in app exists. `composio.md`, section 9, has the steps.
- **Docs updated:** `composio.md` section 9, rewritten (the four places, what Google wants, the plan, Google Calendar step by step, the trial switch in step 5, other apps), section 8 (the 100-user count), section 11 (three new rows) and section 13 (the pages read on 15 October); `backend-report.md` section 14 (the setup order, a new part "Trying our own sign-in app with a few users") and section 42 (the two settings); `hld-mvp.md` section 12 (the plan, and what you do by hand) and section 13.
- **Commits:** `af46692`, and the docs commit on the same branch.

### 15 October 2026: deleting an account also removes the approvals and the activity log

- **Where it is:** on `main` and on the test server since 15 October.
- **Why:** the live privacy page says "Messages, approvals, automations, activity log: until you delete them or your account", and the web app says data is kept until the account is deleted. The delete job removed the container, messages, memories, files, connections, automations and links, but never the user's approvals or their activity log. Both hold the inputs of actions: an approval keeps the exact details it was asked for, such as an email's recipient, and an activity-log entry keeps a tool call's inputs, such as an event's title. Google's review of the app will check how users delete their data. Nothing in the design said these two were kept on purpose: no code reads the activity log except to show it, and the abuse checks use the coupon redemptions, not the log.
- **What the user notices:** after deleting their account, nothing of their approvals or activity log is left. Nothing else changes.
- **Backend:**
  - **Approvals:** the delete job removes every approval of the user, in any state, with its saved inputs. The orchestrator, which owns the table, does it.
  - **The activity log:** the delete job removes the user's whole log, as its last step, so a row written by an earlier step does not stay behind. The admin module, which owns the table, does it. One row stays: when an admin deleted the account, their record of it (the admin's id, the user's id and the reason, never the email or the name). The design already said this row is kept, so there is a record of who deleted an account and why.
  - **The order of the steps:** the user's own data goes first, then the steps that ask outside services (LiteLLM, Polar, Composio), then the activity log. A failure at an outside service now holds back as little as possible. Before, a Polar failure stopped the job before the chats and messages were removed.
  - **Composio:** when Composio could not remove a connected app, the failure was swallowed without a log line, and our row was deleted anyway. The app's sign-in then stayed at Composio with nothing pointing to it. Now the row stays, the failure is logged (the user id, the connection id, the app and the error, never a secret) and the job fails, so it runs again: 5 tries over about 13 minutes, then an alert, and an admin can run it once more from the Jobs page. An app that Composio no longer has counts as removed, so a try that got half-way does not fail forever. This is only for account deletion. Disconnect still deletes the row when Composio fails (see "Still open").
  - **Not touched:** the credits ledger and grants, usage periods, payments, subscriptions and coupon redemptions. They are money records, and the ledger is never edited.
  - Every step is still safe to run again.
- **Cost and speed:** none worth measuring. Two more deletes per account deletion.
- **Contracts:** `openapi.yaml` changed in words only: the admin delete now lists approvals and the activity log among what the job removes, says the ledger and grants stay and that the admin's row is the one activity-log row left, and the activity list says the log is kept for as long as the account exists. No field changed. `vm.proto` did not change.
- **Database:** none. No new table and no migration.
- **How it was checked:**
  - New tests (4), in one new file: deleting an account removes its approvals and activity log, and the recipient of an approved email is then in no approval, no activity-log row and no message; another user keeps their approvals, log, messages and container. An admin's record of the deletion stays, and so do the credit grants and ledger, unchanged. A second and a third run succeed and change nothing. With Composio failing for one of two connected apps, the first run removes the other one at Composio, keeps the failed row and fails, while the messages and approvals are already gone; the next run removes the second app at Composio and then the activity log; the other user's app is never asked about.
  - With the two new delete steps taken out on purpose, all 4 new tests failed. With them in, they pass.
  - One older test changed: the memory test said the activity log is kept after the account is deleted. It now checks that the log goes, and that another user's stays.
  - `pnpm lint`, `pnpm typecheck` and `pnpm test` pass: 70 test files, 859 tests.
  - Not run on the test server, and not against the real Composio. Composio's "not found" answer is read the same way the code already read it when asking about one account.
- **Still open:**
  - **Disconnect does not try again.** When Composio fails, the failure is only logged (without the user or the connection) and our row is deleted. Two ways to fix it: keep the row as "removing" and let a small job try again, or add a job with the Composio account id that BullMQ retries. A third, wider net: on account deletion, ask Composio for every account it holds under the user's id and remove those too, which also catches ones a failed Disconnect left. Not built: it is outside the delete job.
  - **Composio triggers** of a user's automations are still removed with the failure swallowed, on account deletion and on delete.
  - **The privacy page and the backups.** The page says backups are "14 days rolling" and "fully cleared within 30 days". The backend keeps its database dumps 7 days (`BACKUP_KEEP_DAYS`, 7 by default and in `.env.example`; the server's own value was not read: the admin Settings page shows it). The archives of users' files are never deleted, so a deleted user's files stay in them. The nightly backup has also not been seen to work on the server yet (`aws-setup.md`). Neon keeps its own history of the database too.
  - **Other things the page promises:** raw incoming events "30 days", but a failed event is never removed. A deleted account's `users` row keeps the email and the name.
- **Docs updated:** `backend-report.md` sections 6, 13, 14, 15, 31, 33 (the steps, a Composio failure, and a new table of what stays), 37 and 43; `hld-mvp.md` section 12 (built, never run for real; and a new open question on the privacy page).
- **Commits:** `86ed5e3` (code and tests) and `d497871` (docs).

### 15 October 2026: where a sign-in's seconds go, and a new account's first page one trip shorter

- **Where it is:** on `main` and on the test server since 15 October (backend), and live on app.textcrew.in since 15 October (web app, together with the welcome flow shown first).
- **Why:** you signed up and signed in on `app.textcrew.in` with Google on 15 October and said it took too long. Each step was measured: the server's request log from your sign-up, the sign-in pages loaded in a headless browser from a laptop in India (no account made, nothing typed), and the backend's own tests with every database trip slowed to Neon's distance.
- **Where the seconds go** for someone new who uses "Continue with Google" on the sign-in page. "Ours" means our code or our setup; "Clerk" is the sign-in service, whose servers are in the US, about 0.5 s away per request from India.

    | Step | Time | Whose |
    |---|---|---|
    | Opening `app.textcrew.in` signed out: the proxy sends the browser to `/sign-in` | 0.45 s, first time | Ours, needed |
    | The sign-in page shows | 0.6 to 1.0 s first time, 0.15 s after | Ours (Vercel, Mumbai) |
    | Clerk's script is ready (two requests to Clerk) | 1.2 to 1.7 s after opening, first time | Clerk |
    | **The click on "Continue with Google" until Google's page** | **3.3 to 6.4 s (middle value 4.5 s, 9 tries) when clicked as soon as the page is ready; 1.0 to 1.5 s when clicked 8 s later** | **Clerk.** Clerk's "Protect" check holds the click until its script has loaded: 1.7 to 4.3 s, and once the full 5 s Clerk waits at most. Its script comes from AWS in Oregon, on the US west coast, and its address is never cached (time to live 0): 1.4 s even from our Mumbai server, 2.3 to 4.8 s from the laptop. Then Clerk's sign-in request, 0.5 s. The development setup didn't have this check; the production setup (from 15 October) does |
    | Choosing the Google account (and agreeing, the first time) | The person's time, plus about 0.5 s a page | Google |
    | Google to Clerk to our `/sso-callback` page | About 0.5 to 1 s, not measured | Clerk and Google |
    | `/sso-callback` loads and Clerk's script is ready again | 2.2 s with nothing cached; about 0.8 s with the sign-in page's files already in the browser | Ours (the page) and Clerk (two requests) |
    | Turning the sign-in into a new account: Cloudflare's robot check, creating the account, making the session active | About 1.5 to 3 s, not measured: three requests to Clerk, plus the robot check | Clerk and Cloudflare; only for a new account |
    | Clerk's webhook makes our account row | About 0.4 s, alongside the steps above, not in the way | Ours |
    | **The home screen asks the API for the account, then moves on to the welcome flow** | **0.86 s in your sign-up** (from the first request at 12:09:45.3 to the welcome flow's requests) | **Ours: fixed in the web app** |
    | **The first page's requests each look the user up in the database** | **About 0.2 to 0.26 s** | **Ours (Neon's distance): fixed here** |
    | The first requests after 5 quiet minutes fetch Clerk's keys | 0.31 to 0.33 s, measured from the server | Ours: a setting (see "Still open") |
    | The welcome flow's requests | 0.2 to 0.4 s each on the server in your sign-up, plus about 0.1 s through Vercel | Ours (Neon's distance) |

    Someone who already has an account skips the new-account steps. Google sends them straight to the home screen, where Clerk's check of the new session makes one more stop at Clerk (about 0.5 to 1 s, not measured). The Protect check holds their click just the same.

- **What the user notices:** a new account opens the welcome flow about a second sooner: about 0.86 s from the web app's change and about 0.2 s from the backend's. The rest of the wait above is Clerk's and Google's, and changes only with the settings under "Still open". Nothing else changes.
- **Backend:**
  - **A new account's copy is ready at once.** When Clerk's webhook creates the account (in your sign-up, 3 seconds before the web app's first request), the worker also puts the user's copy in Redis, the one every signed-in request reads (section 4 of `backend-report.md`, "Keeping reads fast"). Before, each of the first page's requests found no copy and looked the user up in the database first. The same happens when the first request creates the account.
  - **Clerk saying again what we have writes nothing.** Clerk's "user updated" comes for changes we don't keep, such as a new picture or name, and for a new account its webhook may come after the first requests. Each of those used to write the row again, which drops the user's copy and keeps none for 30 seconds, so every request in that time made one more trip. Now the row is written only when Clerk's email, its verified state or the role differ from ours. A real change still counts from the very next request.
  - **Requests that come before the webhook share one look-up.** If the web app's first requests arrive before Clerk's webhook, each of them used to ask Clerk for the user and try to create the account; all but one then wrote the row a second time. Now they share one request to Clerk and one new row.
- **Web app** (in its own repo, on the same branch name): a new account now lands on the welcome flow straight from the sign-up, without the stop on the home screen. That covers email sign-up, Google from the sign-up page, and Google from the sign-in page. Someone sent to sign up from another page lands on that page, as before. The web app's README says so.
- **Cost and speed:**
  - Measured with the new test (`test/new-account-sign-in.test.ts`), every database trip slowed to 260 ms. The "before" numbers come from the same test run on the code before this change.

    | | Before | After |
    |---|---|---|
    | The welcome flow's four first requests, account made by the webhook | 10 trips, 0.54 s | 6 trips, 0.34 s |
    | The chat page's eight first requests, arriving before the webhook | 29 trips, 1.13 s, Clerk asked 8 times, then 30 s of one more trip per request | 15 trips, 0.92 s, Clerk asked once, nothing extra after |
    | Clerk's webhook arriving with nothing new | The row written, then 30 s of one more trip per request | One read, nothing written |

  - In your own sign-up the first page's requests took 0.26 to 0.66 s each on the server. A new account now saves one trip there.
  - No change to credits or to our bills.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change.
- **Database:** none.
- **How it was checked:**
  - The new test file has 6 tests: the copy is ready after the webhook (the first request makes no database trip of its own), the welcome flow's first requests make only their own trips, the same details again write nothing and keep the copy, a real role or email change counts at once, eight requests before the webhook make one request to Clerk and one row, and an account Clerk doesn't know is refused and asked about again next time. Run on the old code, 5 of the 6 fail, as they should.
  - The whole backend: lint and type-check clean, 70 test files and 861 tests passed.
  - The web app: lint and type-check clean, 47 test files and 676 tests passed, and a production build in Clerk mode.
  - Not run on the test server yet.
- **Still open, for you to decide:**
  - **Clerk's Protect check** (production setup only) is the largest part of the wait: 1.7 to 4.3 s on the click on "Continue with Google", or on any sign-in or sign-up button, when the person clicks within a few seconds of the page opening. It shows in the setup's public settings as `protect_config`, with a script from `cdn.protect.clerk.com`. Switching it off in Clerk's dashboard would save about 2 to 4 s on that click. Sign-ups would still have Cloudflare's robot check. If you want to keep it, ask Clerk whether it can be served from nearer India.
  - **Cloudflare's robot check on Google sign-ups.** Clerk runs it on every new account, Google ones included (the setting `captcha_oauth_bypass` is empty). Letting Google sign-ups skip it should save about 1 to 2 s on a new account's `/sso-callback` page (not measured). Google has already checked the person.
  - **`CLERK_JWT_KEY` with the production key,** on the server (`beckend/.env`) and on Vercel (the web app's production settings). Both were emptied on 15 October because they held the development key. Without it the api fetches Clerk's keys every 5 minutes (0.31 to 0.33 s, and every request of a page waiting at that moment fetches them at once), and so does each new copy of the web app's proxy on Vercel. The key is public: Clerk's dashboard shows it under API keys. If Clerk's key ever changes, both places need the new one.
  - **The database's distance.** Every trip to Neon in Ohio takes about 260 ms from Mumbai. A Neon region nearer Mumbai (Singapore is one) would make every page faster, not only sign-in. It is a bigger move: the data has to be copied over.
  - **A smaller one in our code, for later:** the web app sets a new account's time zone on its first page, and that change drops the user's copy for 30 seconds. The welcome flow's requests in that time each make one more trip (about 0.2 s). Taking the time zone at sign-up would avoid it.
- **Docs updated:** `backend-report.md` section 4 ("The sign-in check" and "Keeping reads fast") and section 6 ("The steps" and "Other paths").
- **Commits:** backend `40874d0` (the code and its test) and the docs commit that adds this entry, on `perf/sign-in-speed`. Web app `c61d19b` on `perf/sign-in-speed`.

### 15 October 2026: sign-in moves to Clerk's production setup, with Textcrew's own Google sign-in

- **Where it is:** live on the test server and the web app since 15 October.
- **Why:** Clerk is the outside service that handles sign-in. Until now the web app and the backend used Clerk's development setup. That setup is meant for building: it has test keys, it lives on Clerk's own addresses, and Google's sign-in screen said "continue to Clerk" instead of Textcrew. You chose to move to Clerk's production setup before the beta. The design already listed it as needed before a public launch.
- **What the user notices:**
  - **Everyone signs up again.** Accounts made on the development setup do not carry over to the production one. A new sign-up makes a new account in our database, as for any new user.
  - **Google's sign-in screen names Textcrew,** not Clerk. Until Google has checked the brand (see "Still open"), it shows the name without the logo.
  - **Your new account has to be made an admin again.** The admin role travels in the account's details at Clerk, and the old account's details stayed on the development setup.
  - **Local development:** the laptop's `beckend/.env` now holds the live keys. The live keys only work on `textcrew.in`, so signing in on `localhost` needs the old test keys put back. They are kept in that file as commented lines.
- **Backend:** no code changed. Only settings and outside services changed:
  - **Where the keys live now** (names only, no values here):

    | Where | Settings | Notes |
    |---|---|---|
    | The server, `beckend/.env` | `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | The file as it was before is kept as `beckend/.env.bak-2026-10-15-clerk-dev`. The api was restarted to read them |
    | Vercel, the web app's production settings | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `CLERK_JWT_KEY` was removed there: it belonged to the development setup and would have refused every live sign-in. The server's and the laptop's `CLERK_JWT_KEY` held the same development key; it was emptied on 15 October (kept as a commented line on the laptop), so the api checks sign-ins with the live secret key |
    | The laptop, `beckend/.env.deploy` and `beckend/.env` | The same keys | Both files are kept out of git. The old test keys stay in them as commented lines |

  - **Clerk's sign-in service now answers at `clerk.textcrew.in`,** our own address, with Clerk's sign-in pages at `accounts.textcrew.in`.
  - **Five DNS records were added to `textcrew.in` at Vercel.** DNS is the internet's phone book: it turns a name into an address. All five are CNAMEs, records that point one name at another name. `clerk` points at Clerk's sign-in service, `accounts` at Clerk's sign-in pages, and `clkmail`, `clk._domainkey` and `clk2._domainkey` at Clerk's mail service, so the emails Clerk sends for us (codes, links) are trusted as ours. `domain-setup.md`, section 4, lists them with their values.
  - **Google sign-in uses Textcrew's own Google sign-in app.** It is in a Google Cloud project named "textcrew", under your Gmail address, and it is published. Its redirect address, where Google sends the user back after they say yes, is `https://clerk.textcrew.in/v1/oauth_callback`. Its id and secret are kept in Clerk's production setup, not by us.
  - **A new webhook in Clerk's production setup.** A webhook is a message Clerk sends our server when something happens. This one sends "user created", "user updated" and "user deleted" to `https://api.textcrew.in/webhooks/clerk`, the same address as before.
- **Cost and speed:** not measured. The design expected the first visit to be about a second faster on a production setup. No change to credits or to our bills from this.
- **Contracts:** none. `openapi.yaml` and `vm.proto` did not change.
- **Database:** none. The accounts made on the development setup stay in the database as they were, with their credits, chats and containers. Nobody can sign in to them any more.
- **How it was checked:**
  - The live web app loads the live key.
  - `clerk.textcrew.in` answers with a valid certificate.
  - The api restarted with the new keys and reports healthy.
  - The five records answer on public DNS with the values in `domain-setup.md`.
  - Not yet done at the time of writing: a real sign-up on the production setup, so the webhook's first delivery has not been seen.
- **Still open:**
  - **Do one real sign-up** in the web app, and check that the account appears with its credits and container. This also proves the new webhook.
  - **Make your new account an admin.** In Clerk's dashboard (production), add the role "admin" to your new user's public metadata. Clerk's "user updated" webhook then brings the role to our database.
  - **Upload the logo** in Textcrew's Google sign-in app and **submit the brand for Google's check.** It takes a few days. Until then Google shows the name without the logo.
  - **Your old account's plan, extra credits and Telegram link stay on the old account.** Moving your Max plan and credits to the new account is done by hand again, from the admin panel. A Telegram chat linked to an old account cannot be linked to a new one. The bot answers that the chat is linked to another Textcrew account and must be removed there first, but nobody can sign in to the old account any more. So an admin unlinks it on the old account's page in the admin panel. Then the new account's link code works. Beta testers who linked Telegram before 15 October need the same.
- **Docs updated:** `domain-setup.md` sections 1, 2, 4 and 7 (the five Clerk records); `aws-setup.md` section 6 (what `beckend/.env` sets), section 9 (the Clerk row), section 13 (the SSH note: on 15 October SSH was locked out for a while after your home address changed, and CloudShell's pager swallowed a pasted command, so the firewall commands now carry `--no-cli-pager`), section 14 and the timeline; `hld-mvp.md` section 12 (the first sign-up was on the development setup; the production setup under "Built, never run for real"; the Clerk decision taken off "Decisions waiting on you"; the open steps under "Also waiting on you") and section 13 (the progress table, and Part D's note on Clerk's production setup, now marked done).
- **Commits:** the docs commit that adds this entry. No code changed.

### 15 October 2026: a turn's billing runs after the reply, and the next message no longer waits for it

- **Where it is:** on `main` and on the test server since 15 October. Checked there: two quick messages in a row both got their reply (16.4 s with the container waking, then 8.5 s).
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

### 15 October 2026: the admin's user view shows the two first-run marks

- **Where it is:** on `main` and on the test server since 15 October.
- **Why:** the entry "the web app's first-run marks" below left this open: an admin could clear a user's welcome-steps and checklist marks, but could not see them.
- **What the user notices:** nothing. An admin now sees, in the user list and on one user's page, when the user finished or skipped the welcome steps and when they closed the "Getting started" checklist, or that they have not yet.
- **Backend:** the admin's user view adds the two marks, read from the user's row that the admin module already gets through the auth module's own functions. No new query.
- **Cost and speed:** none; the row was read anyway. Not measured.
- **Contracts:** `openapi.yaml` changed. `AdminUser` (used by `GET /v1/admin/users` and inside `GET /v1/admin/users/{userId}`) gains `onboardingCompletedAt` and `gettingStartedDismissedAt`, always present, empty or a time, with the same meaning as on `Me`. The admin panel has to copy in the new contract to show them; until then it works as before. `vm.proto` did not change.
- **Database:** none.
- **How it was checked:** two new tests. An admin sees both marks empty for a new user, in the list and on the user's page; the same time the user's own `/v1/me` shows once the user sets each mark; both empty again after the admin's reset. A user who is not an admin still gets 403 in the error shape, with no marks in it. One older admin test now expects the two empty marks. Lint, the type check and the contract check pass; the full backend run passed 848 of 848 tests. Not yet run on the server.
- **Still open:** nothing. The admin panel shows the marks since 15 October (an "Onboarding" row on a user's page and an "Onboarded" column in the user list).
- **Docs updated:** `backend-report.md` section 31, part "Users and one user's page" (one paragraph).
- **Commits:** `fa98a9c` (the contract), `e5ff808` (the admin view and tests), and the docs commit that adds this entry.


### 15 October 2026: pages and replies wait for fewer trips to the database

- **Where it is:** on `main` and on the test server since 15 October. Its database update (`0024_messages_event_id`, one index) ran on Neon in that deploy.
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

- **Where it is:** on `main` and on the test server since 15 October. Its database update ran on Neon in that deploy; all five accounts on the server have both marks empty, so each sees the welcome steps on its next visit.
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

- **Where it is:** on `main` and on the test server since 15 October.
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
