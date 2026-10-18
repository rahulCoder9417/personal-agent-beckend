# Optimization log 4 (from 17 October 2026, evening): what changed in the backend and the vm-manager

This file records every change made to the backend and the vm-manager from the evening of 17 October 2026 on. It takes over from `3optimization-log.md`, which holds the earlier entries of 17 October and is no longer added to. The older entries are in `2optimization-log.md`, `1optimization-log.md` and `optimization-log.md`, also closed. Each change is written up by feature, in plain words, with no code. An entry says what changed and why, what it means for users and for cost, how it was checked, and where it is now.

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
| **Started** | 17 October 2026, evening. Earlier entries are in `3optimization-log.md`, `2optimization-log.md`, `1optimization-log.md` and `optimization-log.md`, all closed |
| **Order** | Newest change first |
| **Where the work goes** | Straight to `main` in each repo, once the checks pass |
| **How it reaches the server** | By running `/opt/textcrew/deploy.sh` on the server (see `aws-setup.md`, section 8) |

---

## 2. How an entry is written

Each entry has a heading with the date and the name of the feature, then the parts below. A part that does not apply is left out.

- **Where it is:** on a branch, on `main` or on the test server, with the date it got there. This is updated as the change moves along.
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

### 18 October 2026: the user is told when the server is full

- **Where it is:** on the branch `fix/launch-ux` of the backend, not merged.
- **Why:** when every awake place was busy, the wake was retried 5 times (5 seconds, 30 seconds, 2 minutes, 10 minutes) and then the message died with no word. The go-live check marked this "fix before launch".
- **What the user notices:** after the last failed try, one plain reply on the channel they wrote from: "Tex is busy right now and couldn't start your request. Please send it again in a few minutes." The message shows as failed in the web app, where it can be sent again.
- **Backend:** the worker now tells the turn which try it is and how many there are. On the last try, a wake that fails because the server is full ends the turn: the message is marked failed, one `server_busy` audit line is written and one reply is queued. A key per message makes a re-run of the job send nothing more. Only messages from a person are affected; automations and crew jobs keep their own handling. The storage-full case (`disk_limit:`) is unchanged.
- **Cost and speed:** nothing charged for the reply; no change in speed.
- **Contracts:** none (the failed status already existed).
- **Database:** none.
- **How it was checked:** a new test (`test/server-busy.test.ts`): after 5 failed wakes exactly one busy reply, the message failed, one audit line, and a re-run adds neither. `test/storage-full.test.ts` still passes. Lint and typecheck pass. Not run on the test server.
- **Docs updated:** `backend-report.md`, the failure lists in sections 9 and 43.


### 18 October 2026: Chat files now survive a restart or a deploy

- **Where it is:** on branch `fix/attachments-volume`, not merged yet.
- **Why:** files users attach (images, documents, voice notes) were saved inside the api and worker containers, in a folder that is wiped each time they are rebuilt. After every deploy, earlier attachments could no longer be opened or given to the agent.
- **What the user notices:** files sent before a deploy are still there afterwards. Files sent before this change are already lost; their chat messages stay, but the file can no longer be fetched (the agent link now answers "not found" instead of failing).
- **Backend:** files go to one folder (`ATTACHMENTS_DIR`, `/data/attachments` in the containers), one subfolder per user. In Docker Compose that folder is a named volume, `attachments`, mounted in both the api (web uploads, and serving files to the agent containers) and the worker (files from chat apps). All reading, writing and deleting of these files now goes through one small piece of code that accepts only plain ids (no `..`, no slashes) and only touches a file inside its own owner's folder. A file is served only when its stored path is in the folder of the user the row belongs to. Size limits are unchanged (10 MB for web uploads, 25 MB for chat apps). There was no automatic clean-up of old files before and there is none now; files are removed when a conversation or an account is deleted, as before, and that works on the new folder.
- **Cost and speed:** none. The volume uses the server disk; no extra cost.
- **Contracts:** none.
- **Database:** none.
- **How it was checked:** new tests: an upload is still readable (also through the agent's signed link) after the code is reloaded as in a restart; ids that climb out of the folder are refused; one user's file is not served under another user; deleting an account removes its files. The existing media, web chat and conversation tests, lint and type check pass.
- **Still open:** no server step: `deploy.sh` creates the volume on its own. The volume is not in the nightly backup, which covers only the database. A cap on how much one user's files can use is not set.
- **Docs updated:** backend-report sections 11 and 40.
- **Commits:** the commits on `fix/attachments-volume`.

---

### 18 October 2026: The wake fee is removed; waking the agent costs nothing extra

- **Where it is:** `main` in the backend, the web app, the landing page and the admin panel; deployed to the test server.
- **Why:** a few hours earlier the same day a wake fee went live at 1 credit each time the agent woke to do work. The founder meant a tiny amount (0.0025 credit per wake, which is 1 credit per 400 wakes), then chose no fee at all: waking costs us almost nothing (about 3 seconds to start the container), and the awake time, now 1 credit per 5 minutes, already pays for the awake place a wake holds.
- **What the user notices:** no "Waking your agent" line any more in the credit costs, the pricing box, Help, automations or the usage list. A typical active day now uses about 12 to 14 credits instead of 18 to 22, so the 100 free credits last about 7 to 8 days of real use. Example: a 1-minute chat after the agent slept now costs about 0.2 credit of running time, not 1.2.
- **Backend:** the fee's amount is one number in the code, now 0; at 0 nothing is charged and no ledger row is written. The parts that find each awake period stay, so a fee could come back by changing that number. The usage report keeps `wakeCredits`; it is 0 except for the hours the fee was live.
- **Refund:** a new script, `scripts/refund-wake-fees.ts`, gives back every wake charge made while the fee was live: one admin grant per charge, keyed by the charge's own id, so running it twice gives nothing twice. Without `--apply` it only lists what it would give back.
- **Contracts:** `openapi.yaml` descriptions only (the prewarm, the admin wake, the Claude sign-in, `wakeCredits`); no field removed.
- **Database:** none.
- **How it was checked:** the wake-fee tests now check that no wake charge is written for a work wake, a second wake after sleep, or a prewarm then a message. The billing, browser, pull-request review and dev-user tests expect one credit less where the fee used to be. Backend full suite (two unrelated flaky tests passed on a re-run), lint and type check; web lint, tests, build and type check; landing lint and build; admin panel lint, type check and tests.
- **Refund run:** the script ran on the test server after the deploy and found 0 wake charges: no one was charged while the fee was live, so nothing had to be given back.
- **Still open:** nothing.
- **Docs updated:** hld-mvp sections 7 (cost table, the 18 October decision); backend-report sections 24 to 26 (the wake fee marked removed, the example without it).
- **Commits:** the commit that adds this entry, in each repo.

---

### 18 October 2026: Free credits last 14 days, awake time costs more, a fee for each wake, and two free-credit loopholes closed

- **Where it is:** merged to `main` in the backend, the vm-manager and the web app; deployed to the test server with the disk limit below.
- **Why:** the free-credits audit of 17 October. The founder decided: free credits should run out sooner, awake time should cost more, and the loopholes that give free credits or free awake time should close.
- **What the user notices:**
  1. The 100 credits at sign-up last 14 days (they lasted 90). Credits from a plan, a top-up or a coupon still last 90 days.
  2. Awake time costs 1 credit per 5 minutes (it was 10).
  3. Each time the agent wakes up to do work, that costs 1 credit, on top of the time. Work means a message, an automation or reminder run, a crew job or an approved action. A message while the agent is already awake costs no fee. The web app waking the agent early because the chat was opened costs only its time, unless a message follows. Starting a Claude sign-in costs only its time.
  4. Connecting a Claude plan now needs credits. At zero it is refused, and nothing wakes. A user may start it 3 times an hour. A sign-in waits 5 minutes for its code (it was 10). At most 2 sign-ins may wait at once on the server, so they can't fill the 8 awake places.
  5. One inbox gets the 100 sign-up credits once. The same Gmail with dots or a +tag, a googlemail.com address, or an account deleted and made again gets no second 100. The account is made normally, and an audit line says why no credits came. A coupon is now once per person too, checked by inbox and linked chats.
  Example: a typical active day (6 to 8 wakes, about 45 minutes awake, a few app actions) uses about 18 to 22 credits, so the 100 free credits last about 4 to 6 days of real use.
- **The change of rate:** each usage sync charges only the 5-minute blocks the new seconds complete. Time already charged at the old rate is never charged again. At most 1 extra credit can come from the switch itself, once per user.
- **How the wake fee is counted:** the vm-manager already says on each wake whether the container was asleep. That starts a new awake period. The first turn that hands work to the container in that period charges the fee, with a key made of the user and the period, so a retried job never charges twice. The usage list shows it as its own line ("waking your agent").
- **Backend:** sign-up credits 14 days; awake 300 seconds per credit; wake fee; Claude sign-in credit check and 3 starts an hour; normalized-email marks; coupons once per person.
- **vm-manager:** at most 2 Claude sign-ins waiting at once (a setting, `CLAUDE_LOGINS_MAX`); a sign-in waits 5 minutes. The Bridge's sign-in wait is 5 minutes too (needs the agent image rebuilt, which the deploy does).
- **Web app:** credit costs, the pricing "how credits work" box, Help, automations and the credits chart show the new numbers and the wake line; the demo data follows.
- **Contracts:** `openapi.yaml`: the Claude sign-in can answer 402 (no credits) and 429 (too many starts); usage and the admin's day show wake credits; the new numbers in the descriptions.
- **Database:** migration `0036_credits_abuse_marks`: a table of hashed, normalized inbox marks owned by billing. Only a hash is kept, never the email itself, and it stays when an account is deleted.
- **Cost and speed:** no new cost. Each first turn of an awake period does one extra small credit charge.
- **How it was checked:** new tests for each rule: sign-up grant 14 days; 300 seconds per credit with no double charge across the switch; the wake fee charged once per awake period, never while already awake, never for a prewarm alone, once for a prewarm then a message, never twice on a retry; Claude sign-in refused at zero and on the 4th start in an hour; at most 2 sign-ins waiting (vm-manager); email normalization; a repeated inbox gets no sign-up credits. Backend full suite, lint and type check; vm-manager build, vet, tests and the Bridge's 293 tests; web lint, type check, tests and build.
- **Still open:** throwaway email sites and catch-all domains can still make new inboxes; Clerk has dashboard switches to block those. A monthly cap on free credits for the whole server (`FREE_CREDITS_MONTHLY_CAP`) is not set. The admin panel and the landing page still state the old numbers until they are updated.
- **Docs updated:** backend-report sections 23 to 26 and section 30 (the Claude sign-in wait); hld-mvp sections 6 and 7.
- **Commits:** backend `076bf2f` to `f43e325` and `5f3d147`; vm-manager `5a368ae` `0a882b7`; web `f222a16` `1c9a74e`; this entry in the commit that adds it.

---

### 18 October 2026: A disk limit for each user's folder, and a guard for the whole server disk

- **Where it is:** merged to `main` (vm-manager and backend) on 18 October; deployed to the test server together with the credits changes above.
- **Why:** the audit of 17 October found no limit on how much a user (or a runaway agent) can write into their folder. The server has one 29 GB disk, about 80% full, so one user could fill it and stop everybody.
- **What the user notices:** nothing for normal use. A user whose folder holds more than 2 GB cannot wake their agent. They get one clear reply on the channel they wrote from: the storage is full (over 2 GB), Tex can't start, write to support@textcrew.in. The reply is sent at most once an hour per user; their message is marked failed and is not retried, and an audit line (by the system) appears in the admin panel each time. If the server disk is over 90% full, nobody asleep can wake, until space is freed. Agents that are already awake are not touched.
- **vm-manager:** before a sleeping container is woken, two checks run. First the server guard: if the disk is 90% full or more, the wake is refused and an alert line is logged. Second the user limit: Docker is asked how big the user's folder is, and if it is over the limit the wake is refused and an alert line names the user and the size. If either measurement itself fails, the wake goes ahead and a warning is logged, so a broken check cannot lock everyone out. The limits are settings: 2048 MB per user, 90 percent for the server, and 0 turns either one off. It is a soft limit: the disk cannot enforce it (the server disk is plain ext4, which has no per-folder quotas, and Docker's own size option needs a different disk type), so an agent that is already awake can go past 2 GB until it goes to sleep (idle agents sleep after 3 minutes). Existing users keep their folders and data as they are; there is nothing to migrate. A user with a folder under 2 GB sees no change.
- **Cost and speed:** no new cost. Each wake of a sleeping agent asks Docker for its disk report, which takes a moment on a server with few users; not measured on the server.
- **Backend:** the turn tells the two refusals apart by a fixed prefix at the start of the vm-manager's message (`disk_limit:` and `disk_guard:`), never by the sentence. Over the user limit: the turn ends without a retry, with the reply and audit line above. Server disk over 90%: the old busy-and-retry behaviour stays, and an error line is logged for each wake attempt.
- **Contracts:** none changed. The proto has no code for "storage full", so both refusals use the existing "resource exhausted" answer, told apart by the prefix.
- **Database:** none.
- **How it was checked:** new tests: a user over the limit is refused and not marked broken; under the limit wakes; freeing space lets the wake work; the limit can be turned off; an awake agent is not checked again; the server guard refuses at 91.5% and allows 89.9%; a failed measurement lets the wake go; the guard can be turned off; the settings' defaults and bad values. Backend tests (new file `storage-full.test.ts`): over the limit, the wake is tried once, one reply is sent for two messages, both are marked failed and two audit lines are written; with the server guard the wake is retried and no "storage full" reply is sent. Those, plus the prewarm, refund, latency and admin-agent tests, lint and type check pass. Build, vet and all vm-manager tests pass. Not run on the test server.
- **Still open:** (1) A user over the limit cannot clear their own folder, because their agent will not wake. Until a cleanup tool exists, an admin has to trim the folder on the server or raise the limit for a moment. (2) The 4.3 GB of old build cache on the server should still be deleted. (3) A true hard limit would need a separate disk image per user or a disk with quotas; worth it only if the soft limit proves too loose. (4) The user is told in the chat, but through the message prefix; a proper new answer code in the proto would be cleaner.
- **Docs updated:** none beyond the vm-manager's `.env.example`.
- **Commits:** vm-manager `ce52948` (the check) `4b4c946` (settings in `.env.example`) and `9e070de` (message prefixes); backend: the commit that adds this text.

---

### 18 October 2026: Cancelling or keeping a plan now leaves a line in the activity log

- **Where it is:** on a branch (`fix/billing-audit`) in the backend, not merged yet. The admin panel needed no change.
- **Why:** while testing Polar payments live, you pressed "Cancel plan" and then "Keep my plan". Both worked, but neither wrote anything to the activity log, so the admin panel could not show who cancelled or resumed, or when.
- **What the user notices:** nothing on screen. In the activity log (and so in the admin panel) there is now a line for each action, for example "Pro plan cancelled: stays until 18 Nov" and "Pro plan kept: renews again", with the subscription and the period end kept inside the row.
- **Backend:** pressing Cancel plan or Keep my plan writes one line, as done by the user. Pressing Cancel twice writes one line, because the second press changes nothing. Changes that come only from Polar now also write one line each, as done by the system: cancelled or kept in Polar's own customer portal, a failed payment (past due), payment going through again, and a move between Pro and Max. A line is written only when our stored state really changes, so a repeated webhook, a re-run job, or Polar echoing the user's own button press adds nothing. The end of a paid plan (back to Free) now writes one "plan ended" line, whether Polar revokes it or the hourly safety net ends it; before this it wrote none.
- **Cost and speed:** one small database write per real change. Nothing measured.
- **Contracts:** none changed.
- **Database:** none (the existing activity log table).
- **How it was checked:** three new tests in the Polar test file: cancel writes one line, cancel twice and Polar's echo add none, Keep my plan writes one; Polar-only cancel, un-cancel, past due and revoke write one line each, and repeats add none; the hourly safety net writes the "plan ended" line once. The Polar test files and the other tests that end subscriptions pass; lint and type check are clean. Not run on the test server.
- **Still open:** nothing. Older cancels and resumes (before this change) have no line and cannot be recovered.
- **Docs updated:** none. `backend-report.md` section 28 does not list the activity lines.
- **Commits:** backend `e6583f1` (this entry follows in the next commit).

---

### 17 October 2026: "Don't ask again": skip rules, logged as auto-approved

- **Where it is:** merged to main in the backend and the web app, and live on the test server and app.textcrew.in since 17 October (evening). Migration 0035 is applied on Neon; the backend went out before the web app, as it must.
- **Why:** your decision, 17 October: "a section where it is asked if it wanna be skipped, like skip approval, but have a log in the approvals with auto approved". Approving the same email to yourself again and again is only noise.
- **What the user notices:** on the card of a risky action in an app, a quiet "Don't ask again for this…". It opens a small choice: "Only to" the request's own recipients (the default) or "Anyone", with a one-line warning. Picking one approves this card and saves the rule. After that, the same action to the people on the list (or to anyone) runs at once, with no card, and Tex says what it did. The Approvals page gets an "Auto-approved" tab (what ran, when, by which rule, the result) and a "Skip rules" list, each rule with Remove. Deleting, paying, merging a pull request and Tex's own commands, pushes and crew jobs never show the link and always ask.
- **Backend:** a new table of the user's rules, one rule per action and choice. Before a risky action with no approval runs, the api looks for a rule that covers exactly this request: with "Only to these", every recipient must be on the list, cc and bcc included; for GitHub the repository counts. With a match the action is saved as an approval with the status "auto-approved" (which rule, when, the result) and run the way an approved one runs. Tex is told it ran because of the user's rule and not to run it again. The same call again in one turn finds the first and runs nothing. Which actions can never be skipped is checked every time an action runs, so a rule put straight into the database does nothing for them. Only the web API, with the user's own sign-in, makes or removes a rule; the agent has no tool for it, and the rules API refuses a container's token. An automation set to ask before anything that changes something never uses a rule. Making and removing a rule go into the activity log, and deleting the account deletes the rules.
- **Cost and speed:** the same 1 credit as an approved action, charged once, with the approval's id as its key. A skipped action is faster than an approved one: no card, no wait for a tap, no second turn to tell Tex. One more small database read before a risky action runs, not measured.
- **Contracts:** `openapi.yaml` changed, and the web app follows it: three new endpoints (list, make and remove skip rules), the new approval status `auto_approved`, and on an approval its card's skip offer (`skip`), the rule that let it run (`skipRule`) and how the platform's run went (`run`). `vm.proto` did not change.
- **Database:** migration 0035: the new table `skip_rules`, and a new column on `approvals` holding a fingerprint of the turn, the action and its inputs, so a skip runs once.
- **How it was checked:** a new test file of 13 tests: which actions may be skipped; a rule letting a matching send run once without a card and logging it auto-approved, from both of Tex's tools; a recipient outside the list (another address, a cc, a bcc, extra recipients) still asking; deleting, merging and Tex's own kinds asking even with a rule forged into the database; the agent unable to make, widen or list rules; one user's rule doing nothing for another; the same request again in one turn sending once; the strict automation setting still asking, with and without steps. With the approval tests (approve-runs-now, approval-args, app-action-charge, phase4-approvals), automation-steps and account-deletion: 7 files, 80 tests, all passed. Lint and type-check clean. The web app: lint, 102 test files with 1,291 tests, build and type-check all passed, with new tests clicking through the card's choice, the Auto-approved tab and the Skip rules list in its demo mode; headless screenshots at phone and desktop width were looked at. Those screenshots found one real gap the tests had missed: the web app's API proxy did not let the new rules address through, so making or listing a rule would have failed on the live site. Fixed, and the web tests now go through the same check as the proxy. Not run on the test server yet.
- **Still open:** nothing to decide. Merging a pull request stays never skippable: it writes to the default branch, may put a change live and can't simply be taken back.
- **Docs updated:** `hld-mvp.md` 5.3 (step 4 and a new part "Don't ask again"), rule 9 in section 8, the decisions table in section 9 and section 12; `backend-report.md` section 15 (which actions ask, a new part on skip rules, what can go wrong).
- **Commits:** backend: contract `3067211`, skip rules and auto-approved `2628291`, docs `ce2cfff` and this entry's update after it. Web app (branch `feat/skip-approval`): contract copy and hooks `08e1d5c` (still named "wip"), words `4b4624b`, the card `be71f01`, the Approvals page and the proxy `b4e3638`, demo mode `57f8921`.

### 17 October 2026: The regular price is shown crossed out beside the launch price

- **Where it is:** on a branch (`ui/struck-regular-price`) in the backend, the web app and the landing page, not merged yet.
- **Why:** you reversed the 16 October choice. Pro stays $19 a month and Max $30 a month, and the regular prices ($30 and $50) are now shown crossed out, the usual sale look, instead of plain words.
- **What the user notices:** on the pricing page, the Credits plan card and the website's pricing page and teaser, Pro reads "$30 crossed out, then $19, per month" and Max "$50 crossed out, then $30". A small muted "Launch price" tag stays beside it, because the regular price has never been charged. Free shows nothing crossed out. The crossed-out price is read out as "Regular price $30" by screen readers.
- **Backend:** only a comment next to the regular price in the plans file. No logic changed.
- **Cost and speed:** none. The charges, the amounts sent to Polar and the plans list in the API are exactly as before.
- **Contracts:** none changed. The terms page wording ("these are launch prices: the regular prices are $30 and $50") is still true and was left as it is.
- **Database:** none.
- **How it was checked:** the web app's pricing tests were changed to look for the crossed-out price and the tag; lint lists clean in the backend (docs and a comment only).
- **Docs updated:** `hld-mvp.md` (the launch-price paragraph in section 5, the plans row, and the decision on the struck-out price) and `backend-report.md` (the "Launch prices" part).
- **Commits:** see the branch `ui/struck-regular-price` in each repo.

### 17 October 2026: "Draft it" on the New automation page stays on the page and gives Tex's verdict

- **Where it is:** merged to main in the backend and the web app, and live on the test server and app.textcrew.in since 17 October (evening). The backend went out first, as it must.
- **Why:** you asked that "Draft it" on the New automation page stop sending you to the chat. It should stay on the page, check whether the request can be an automation, and either open the canvas with Tex's draft or say why not and what would work.
- **What the user notices:**
  - After "Draft it" the box says "Tex is checking if this can be an automation…", with the button off and the words kept in the box.
  - When it can be built, the canvas opens with Tex's draft, marked "Not saved". Nothing runs until it is saved, as before.
  - When it can't, a short note under the box gives Tex's reason in a sentence or two and a request that would work ("Try: …"), with a "Try another prompt" button that puts the cursor back in the box. The words stay there to edit.
  - A failed turn, or a send that is refused (out of credits, offline), is a plain error note; out of credits links to Credits. With no answer after 90 seconds the note says "Tex is taking longer — see it in Chat", links to the Automations chat, frees the box for another try, and the page keeps watching: a draft that comes later still opens.
  - The request and Tex's answer stay in the Automations chat, so they can be found later. The chat that was open stays the open one, and no new chat is started for each try.
  - An empty box still does nothing, and the three ideas under it still fill it. It works at 375 px wide (the note's button goes under the words).
- **Backend:**
  - A web message can say it comes from the New automation page. Such a message goes into the user's Automations chat, which is started if there is none yet; naming a conversation as well is refused.
  - Its turn is one normal turn of Tex in that chat. The worker puts a note from the platform at the start of the turn's text: the request came from the New automation page, the user is waiting there for a draft, and Tex may only do one of two things. Either it proposes the automation with its usual draft tool, filling what is left open with sensible defaults, or it says why it can't be one in one or two sentences and suggests a request that would work, with no question. It must not do the task itself in that turn. The user's message is saved as typed; the note is only in the turn.
  - Such a request always reaches Tex: the quick router never answers it, and text that looks like a coupon code is not taken as one.
  - In the Automations chat Tex already can't set a reminder straight away, so a one-time reminder asked on this page also comes back as a draft, and nothing is set before the user saves.
  - Every message the api lists or sends on the live updates now carries the id of the turn it belongs to: on the user's message the turn that answers it, on Tex's (and on the platform's "out of credits" or "something went wrong") the turn it was written in. The page uses it to find the answer to its own request, also when an automation's run answers in the same chat at the same moment.
  - The job of a web message, when added again from its saved event alone (after Redis lost its jobs), now reads the message and this mark from the event. Before, such a job found no message and was dropped.
- **vm-manager:** nothing. The note travels in the turn's text, which the Bridge already passes on, so Tex's rules and the agent image do not change.
- **Cost and speed:** each try is one normal turn, charged like a chat message. The turn's text grows by about 800 characters. The page waits for the same live updates the chat uses; the only other requests are the Automations chat's newest messages once per try, and the draft itself before the canvas opens (which the canvas needs anyway).
- **Contracts:** `openapi.yaml` changed. Sending a message (`POST /v1/messages`) takes `purpose: automation_draft`, and every message has `turnId`. The web app's copy is synced. `vm.proto` is unchanged.
- **Database:** none.
- **How it was checked:**
  - Backend: a new test file, `automation-draft-ask.test.ts`, with 13 tests: the request goes into the Automations chat (started for it) and the open chat stays as it was; the turn's text carries the note and ends with the user's words, while an ordinary message carries none; a draft's message and a plain answer carry the request's turn id, and another turn's answer in the same chat has another; the quick router and a coupon-looking text never take it from Tex; a conversation named beside it and an unknown purpose are refused; at zero credits nothing is saved and no Automations chat is started; each user's request goes into their own Automations chat and another user can't read it; the same request sent twice is one message and one turn; and a job added again from the saved event alone still carries the note, and does nothing once the turn has run. All 13 pass. Lint and type check pass. With the suites nearest to it (`phase3-web`, `conversations`, `automation-conversations`, `automation-drafts`, `phase6-routing`, `new-chat`, `dev-user-script`, `memory-turns`, `channels-switch`, and the approvals' `approve-runs-now` and `approval-message`), 175 tests in 12 files pass, on the branch moved onto today's `main` (after "Approved means done"). The whole suite was not run here; the main session runs it at merge.
  - Web app: the page's states in `new-automation.test.ts` (checking, the canvas opening on a draft, the note on a plain answer, another turn's message ignored, a failed turn, a refused send with the link to Credits, and the 90-second note with the link to the chat), tried both as rules and by clicking through the page against the demo account. Lint, 1258 tests in 99 files, build and type check pass. The demo account answers such a request the same way, so the page can be tried there.
  - Not tried with a real Tex: how well Tex keeps to "draft it or say why not" is up to the note, and was not measured.
- **Still open:**
  - Deploy the backend before the web app: an older backend ignores the mark and would treat the request as an ordinary chat message (in the open chat, where Tex might do the task). No migration and no new agent image.
  - If Tex still asks a question or does the task now and then, the next step is one sentence in Tex's own rules about requests from this page (in the vm-manager), or refusing app actions during such a turn.
- **Docs updated:** `backend-report.md`: section 9 ("A message from web chat": the page's requests and the turn's id on every message), section 18 ("Creating one", and a new part "Asked from the New automation page" at the end of "Drafts"), and the chat line of section 41. `hld-mvp.md`: section 5.4 (the "New automation" line, and step 1 of "a draft first") and section 12 (an item under "Built, never run for real").
- **Commits:** backend `e6244f7` (contract, send, turn, tests), `d52694b` (this entry and the docs); web app `2dffc7e`.

### 17 October 2026: Approved means done (an approved app action runs the moment you press Approve)

- **Where it is:** merged to main in the backend and the vm-manager, and live on the test server since 17 October (evening). Migration 0034 is applied on Neon.
- **Why:** on 17 October at 11:07 UTC you asked Tex to merge a pull request. Two things went wrong.
  - Tex raised the card for the merge, then wrote a second message: "The approval card is waiting for you above — approve or deny it there." After your Approve the card said "You approved this" with that line still under it. An earlier rule told Tex to say in a few words what waits on the card; it did.
  - You pressed Approve at 11:08:36.269 and sent a new message 0.1 seconds later. The api saved the "approved" event about half a second after your answer, after your message's event. Your message's turn took your lock first and ran Byte for about 50 seconds. Only then did Tex's turn after the yes run, and the merge happened at 11:09:33. You waited about a minute: "I clicked approve, why is it taking so much time".
  - Your decision: for actions in apps (merging, sending an email, posting a review), the server does the approved action the moment you press Approve, and tells Tex the result. Commands in Tex's container, pushes and running a crew job again still go through Tex.
- **What the user notices:**
  - Approve on a merge, an email or a review: it happens within a second or two, also while Tex is busy with another message. Tex then says how it went ("Merged"), from the result.
  - The same with the Approve button on Telegram (and WhatsApp): a tap no longer waits behind a busy turn. A typed "yes" is a message and still waits its turn.
  - If the app refuses it (for example the pull request can't be merged), Tex says so right after, with why. Nothing was done and nothing is charged, and Tex may try once more or ask again with corrected details.
  - After Tex raises a card, no line pointing at the card comes after it. The card is the message.
- **Backend:**
  - The answer and the event that wakes Tex are saved in one database step, and its job is added before the web app gets the answer back. A message sent right after the answer is queued after it.
  - An approved app action (one whose app is known, because its inputs were checked when Tex asked) gets a job on the system queue, which never waits for your lock. The job runs it the way `run_app_action` does: the saved inputs, your newest connection of that app, nothing at zero credits, the same 1 credit charged once with the approval as its key, the same short result, the same activity-log entry ("Ran … (approved)").
  - It marks the approval used in one database step first, so nothing runs it twice: not the job run again, not the turn after the yes, not Tex. The result is kept on the approval.
  - The turn after the yes reads that result, waiting up to 90 seconds if the job is still running, or running it itself if the job has not started. Tex is told "The user APPROVED … It is DONE …", with the result and "Don't run it again", instead of "Go ahead: call run_app_action".
  - If Tex calls `run_app_action` with that approval anyway, it gets the kept result, charged nothing more; other inputs with it are refused and run nothing.
  - A failure (the app refused, out of credits, the app not connected) is kept with its reason, the approval is handed back unused, and Tex is told in the same turn. The job does not try again by itself. A run that never reports back (the worker stopped mid-way) is never run again; after 5 minutes Tex is told it was started and to have you check in the app.
  - A tap on an approval's button in Telegram or WhatsApp goes to the system queue instead of the inbound one: it runs no turn, so it does not wait for your lock. Every other button and message stays in line on inbound.
  - A small repair on the way: an approval's answer whose job was added again after Redis was lost carried no approval id and was dropped; it now takes the id from its event.
  - Unchanged: Tex's own commands and pushes, starting a crew job, running a crew job again, and the steps of an automation's run with steps (their approvals go on through Tex, one step at a time, as before; running those at once would bypass the run's step pointer). A "no" works as before.
- **vm-manager (the Bridge, in the agent image):**
  - Tex's rules: after asking for your OK (an approval, or a command or a push that waits for it), the card is the message. Tex never points at it, repeats its question or says it is waiting. With nothing else to say, its final answer is the word `NO_REPLY`, and the Bridge sends nothing: the turn just ends. The old rule that told Tex to say what waits on the card is gone.
  - Why a marker and not an empty answer: after a tool call, Hermes answers an empty reply with a nudge ("You just executed tool calls but returned an empty response…"), then retries, and at last answers "(empty)", which would reach you. `NO_REPLY` is the marker Hermes's own chat gateways keep back. A line that is only the marker before or after real text is dropped and the text is sent. While Tex writes, the web chat's draft keeps back anything that could still become the marker, so it never flashes.
  - No backend check for a line that only points at the card: it can't be told reliably from a line that matters, so the fix is the rule and the marker.
- **Cost and speed:** an approved action now takes the time of the app's own answer after the tap (about 1 to 3 seconds for a merge or an email, not measured on the server) instead of waiting for Tex's turn, which could be a minute when you are busy with Tex. Tex's turn after the yes no longer makes the tool call itself, so it is one model round shorter. The same 1 credit per action. Tex's instructions grow by 414 characters (measured), in the part the prompt cache keeps.
- **Contracts:** none. `openapi.yaml` and `vm.proto` are unchanged. The card still shows "You approved this"; the result reaches you through Tex's message.
- **Database:** one new column, `approvals.run_result` (the run's state and short result), migration `0034_approval_run_result`. It comes after the crew models' `0033_crew_models`.
- **How it was checked:**
  - Backend: a new test file, `approve-runs-now.test.ts` (10 tests): Approve on the web while Tex is busy (the lock held) runs the merge once, with no Tex turn, and Tex's later turn says "It is DONE" with the result while its own `run_app_action` gets the kept result and the activity log has one charged run; a Telegram tap while Tex is busy runs it too (the tap's job is on the system queue); the job run again and three runs at the same moment run it once, and other inputs with the approval are refused; a refused merge is told to Tex with the reason and `replaces_approval_id`, the job is not retried and Tex's one more try goes through; out of credits runs nothing; the event and both jobs exist when the decision request returns; a run stuck as "running" is never run again; a command's approval is answered as before with no job; only an approval tap skips the lock. Older tests now expect the new flow: `approval-args.test.ts`, `app-action-charge.test.ts` and `phase4-approvals.test.ts` (the action runs at the yes; Tex's call gets its result; a refusal at the yes hands the approval back). Lint and type check pass. The whole suite on the branch (after the crew models were merged): 1,274 of 1,275 tests pass; the one failure, `telegram-reply-speed.test.ts` ("whether the container exists goes with the turn's first reads"), is a timing test of the message path that this change does not touch, and it passed 3 times of 3 when run alone. The four approval test files passed 3 times of 3 in a row (47 tests).
  - vm-manager: new Bridge tests for the marker (never sent, with stray punctuation; real text before it is sent without it; the draft never shows it), the rule's words, and the crew rule without "approve or deny it on the card". All 293 Bridge tests pass (1 skipped, the real-browser test, as before). No Go code changed.
  - Not tried on the server or with your GitHub account.
- **Still open:**
  - The approval card in the web app still says "You approved this" only. A "Done" or "Failed" on the card would need a field in the contract and the web app; not part of this change.
  - Approvals of an automation's steps still wait for Tex's turn, as before.
  - Deploy: the backend with the database update (migration 0034, after 0033) and a restart of api and worker, and the new agent image. Either order works: an old agent image just keeps writing a line after the card until it is replaced.
- **Docs updated:** `hld-mvp.md`: section 5.3 (steps 5 and 6, "Approved means done"), section 9 (the decision), section 12 (the status line). `backend-report.md`: section 3 (the system queue and the lock), section 5 (Telegram and WhatsApp taps), section 15 ("The life of an approval", the new part "Approved means done", "Single use and exact match", "Asking again", "What can go wrong"). The vm-manager's `README.md` ("The card is the message", and the answer that is not sent).
- **Commits:** backend `d284790` (the action runs at the yes) and the docs commit with this entry; vm-manager `cd32125` (the card is the message).

### 17 October 2026: A model and a thinking effort for each of the crew (Tex, Byte, Patch, Scout)

- **Where it is:** merged to main in the backend, the vm-manager and the web app, and live on the test server and app.textcrew.in since 17 October (evening). Migration 0033 is applied on Neon.
- **Why:** you said reviews of pull requests take too long, and that Tex, Byte and Patch should each have their own model in Settings, because not every job needs a strong or a weak one. Until now there was one choice for Claude Code. A model picked for Tex also ran for Byte, Patch and Scout, so a deep model picked for chat made every review slow too, and there was no way to give a helper something else.
- **What the user notices:**
  - Settings, Agent & AI has a new part, **Crew**, under Engine. One row each: Tex (leads, talks to you), Byte (writes code), Patch (reviews code), Scout (researches and uses the browser). Each row has a model and a thinking effort. "Default" comes first and says what it runs: "Default (Sonnet 5.5, quick)" and "Default (Low)" for Tex as before; for Byte and Patch "Default (same as Tex)" when a model is picked for Tex, else "Default (Opus 5.5)" and "Default (Medium)"; "Default (same as Tex)" for Scout. One quiet line under the heading: "Faster models answer sooner; stronger ones are more careful on hard code." Each change is saved as it is made.
  - Tex's model and effort are the same control as before, moved into this part.
  - On Hermes the crew's rows give way to a note: on Hermes the crew shares one model, and each gets its own once Claude Code is the engine. Without a Claude plan the part says the same and links to connecting one. Hermes itself is unchanged.
  - Nothing changes for anyone until they pick a model for a helper. "Default" means what it meant before: a helper runs on the model picked for Tex, and with Tex on "Default" too, Byte and Patch run on Opus 5.5 at medium and Scout on Tex's. (A first version decoupled Byte and Patch from Tex; you chose to keep the old meaning.)
  - On a phone the two choices of each row go under the name, each with its caption. Checked at 375 px wide.
- **Backend:**
  - The agent settings have a new part for the crew: for Byte, Patch and Scout, a model (one from the same list as Tex's) and an effort, each "Default" until picked. Reading the settings gives every member's choice, and what "Default" is for each for this user right now (it follows whether a model is picked for Tex), so the web app's labels come from one place. That place matches what the Bridge does.
  - Saving changes only the members and the fields sent. A model not on the list, an unknown effort, or anyone other than Byte, Patch and Scout is refused with "invalid request", and nothing is saved. A saved model later taken off the list counts as "Default".
  - Every turn that runs on Claude Code tells the Bridge the crew's choices next to Tex's, leaving out every member on "Default". A turn on Hermes carries none of them.
  - Support's "reset the model" and "reset the effort" put the crew's back to "Default" too, and the activity log says so.
- **vm-manager (the Bridge, in the agent image):**
  - The Bridge reads the crew's choices from the turn and puts each into that member's description, which Claude Code reads at the start of the turn (its model and, when picked or by default, its effort). For each member, in order: the user's pick for that member; then a crew model the server may set for all three (`BRIDGE_CLAUDE_CREW_MODEL`, not set today); then Tex's model at Tex's effort, when one is picked for Tex; then the member's default (Byte and Patch: Opus 5.5 at medium; Scout: Tex's model at Tex's effort). Model and effort are picked apart: Patch with only an effort picked runs on its default model at that effort.
  - A member that is not one of the crew, or a value of the wrong shape, is left out with a warning, and that member keeps its default. Tex's own model and effort are handled as before.
- **Cost and speed:** the Claude plan pays for Claude Code, so no credits change and no AI cost of ours changes. A quicker model or a lower effort picked for Patch makes reviews come back sooner; how much was not measured. The turn's message to the container grows by at most about 200 bytes.
- **Contracts:** `openapi.yaml` changed: the agent settings answer has `claudeCrew` (each member's model and effort) and `claudeChoices.crewDefaults` (what "Default" is for each, for this user); the PATCH takes `claudeCrew`. The web app's copy is synced. `vm.proto` is unchanged: the crew's choices go in the turn's metadata, under `claude.crew`, next to Tex's `claude.model` and `claude.effort`.
- **Database:** one new column on `agent_settings`, `claude_crew` (JSON, empty for everyone today), migration `0033_crew_models`. It only adds a column; nothing is copied or changed.
- **How it was checked:**
  - Backend: 6 new tests in `claude-plan.test.ts` (every member on "Default" and what "Default" is, matching the model list; "Default" for Byte and Patch following a model picked for Tex and coming back with Tex's "Default"; saving one member and one field at a time, Tex's choice leaving the crew alone, back to "Default" clearing the column; 9 refused bodies with nothing saved; a Claude Code turn carrying only the members off "Default", and a Hermes turn carrying none; stored values no longer on offer read as "Default"), and the admin reset tests now check the crew goes back with Tex. Lint and type check pass. `claude-plan`, `admin-agent` and `turn-latency`: 61 tests pass; `admin-users`, `crew` and `crew-jobs`: 32 pass. The whole suite was not run here; the main session runs it at merge.
  - vm-manager: new Bridge tests for reading `claude.crew` (good and bad values, unknown members, nothing bad written to the log), for each member's model and effort in Claude Code's crew description in every order of precedence, for a turn that carries them (with the server crew model set too), and for "a model picked for Tex, Patch on Default: Patch runs Tex's model". The existing tests that a model picked for Tex runs for every member left on "Default" pass unchanged. All 286 Bridge tests pass (1 skipped, the real-browser test, as before). No Go code changed.
  - Web app: lint, 1217 tests in 99 files, build and type check pass. The Crew part was drawn from the demo account at 900 px and 375 px wide and looked at.
  - Not tried with the real Claude Code or a real plan. Two things are read in Claude Code's docs only: Scout with only an effort picked (its own effort on top of "same model as Tex"), and what happens when the plan refuses a model picked for one member.
- **Still open:**
  - Deploy: all three parts, in any order. The server's deploy script runs the new migration before it starts the api and the worker, and builds the new agent image; containers take it at their next wake. The web app goes out with a push to `main` (Vercel). Before the backend is deployed, the web app shows only Tex's row, as today. An old agent image ignores the crew's choices.
  - The admin panel does not show the crew's choices yet; support's reset covers them.
- **Docs updated:** `backend-report.md`: section 30 "The Claude model and the thinking effort" (who has which default, the steps, Byte and Patch keep their own while Tex is on "Default", an example), and one line each in section 20 (which model each one runs on), the admin reset table and its example, and the table of who owns which table. The vm-manager's `README.md`: the metadata table, "The crew" and "The chat default" under "Claude Code runtime", the crew's "Model" line and `BRIDGE_CLAUDE_CREW_MODEL`.
- **Commits:** backend `b7b591e` (contract), `2f93db2` (settings, turn, admin reset, migration), `6f77d1e` (docs), `07970e7` ("Default" follows Tex, with this entry's update); vm-manager `cdd3a4a`, `0602512` ("Default" follows Tex); web app `4e8a826`, `440c094` (the same).

### 17 October 2026: Tex hands a web job to Scout at once

- **Where it is:** merged to main in the vm-manager and the backend, and live on the test server since 17 October (evening).
- **Why:** in your web chat (17 October, 11:13 UTC) you wrote "Run curl -s https://youtube.com in your workspace." Tex answered that web fetching is Scout's domain and asked what you were trying to get from YouTube. You said it should have given it to Scout. Tex was right that the web is Scout's, but it explained that to you and asked back, when it should simply have handed the job over.
- **What the user notices:** a request to fetch, curl, wget or open an address now goes to Scout straight away, with no explaining whose job it is and no question first. Tex then reports what Scout found in plain words, including when the page shows little because it needs JavaScript. Tex asks you something only when the job cannot start without the answer.
- **Backend:** nothing, apart from this entry.
- **vm-manager (the Bridge, in the agent image):** Tex's rules gain three short sentences saying the above. The message the gate sends back when Tex itself tries to use a web tool now says to hand the job to Scout now, without explaining or asking first, and to report what Scout found.
- **Cost and speed:** Tex's instructions grow by about 500 characters, in the part the prompt cache keeps. A fetch request skips one round of talk with you.
- **Contracts:** none changed. **Database:** none.
- **How it was checked:** a new test checks that Tex's rules hold the straight-away rule, that fetch, curl, wget and open-an-address count as web jobs, and that Tex asks only when it cannot start. The Bridge's tests all pass (284 run, 1 skipped as before). Not run on the test server yet.
- **Still open:** try the same sentence in the web chat.
- **Docs updated:** none.
- **Commits:** vm-manager c6fb9f9 on `fix/web-straight-to-scout`; backend: the commit with this entry on the same branch name.

### 17 October 2026: Code review that reads before it judges (files as text, Patch never posts, plain command cards)

- **Where it is:** merged to main in the backend and the vm-manager, and live on the test server since 17 October (evening). The founder's next review after it (PR #1 in Code-Smith, 11:00 UTC) read the real files and found the PR ready to merge.
- **Why:** you called your chat "hey can u check for the unchecked pr" (17 October, 10:00 to 10:04 UTC) hallucinating, and it was. What happened, step by step:
  - Asked about "the unchecked pr", Tex searched only pull requests waiting for your review, found none and said nothing was waiting. Your own repository Code-Smith had pull request #1 open.
  - Asked to check Code-Smith, Tex handed it to Patch. Patch asked GitHub for a file (`GITHUB_GET_RAW_REPOSITORY_CONTENT`), and Composio answered with a link to its temporary file storage, signed and good for an hour, instead of the file. Patch tried to download that link with `curl`, twice. Each try became a card for you whose title was the whole signed address, with the reason "it reaches the internet, and Scout's browser is on, so any website can be reached". You could read neither.
  - Without the files, Patch reviewed from a diff that was cut off and wrote guesses as findings. It called `openai>=3.13.0,<4` invalid because "openai has no 3.x release": false, openai is at 3.33.0 (its memory is out of date). It asked for the secret key to be unwrapped with `.get_secret_value()`: false, line 41 of `app/llm/chat_client.py` already does it, and its own review said that file's part of the diff was cut off.
  - Patch then asked to post a "request changes" review with those findings on your pull request, which you never asked for (you asked to "check"). Tex's answer said "Patch is done… Should I go ahead and post it?", asking a second time while the card was already there, and named "Patch" as if you knew who that was.
- **What the user notices:**
  - "Unchecked", "open" or "pending" pull requests: Tex looks at the open ones in your own repositories and at the ones waiting for your review, and says what each search found.
  - "Check this pull request": the review comes in the chat. Nothing is posted on GitHub unless you ask; then Tex posts one review that comments (not "request changes" or "approve" unless you ask for that).
  - The review's findings point to a file and a line Patch read. What it could not read or check is named as such, with no finding about it. No more package versions or library behaviour stated from memory.
  - No more cards for downloading a file an app already gave. When a card for a command does come, its title says what the command does, with the address cut to its host, for example "Download a file from temp.4d4f….r2.cloudflarestorage.com (a temporary signed link)", and the reason reads "It needs your OK because it downloads from the internet." The exact command is still on the card, under the title.
  - Tex does not ask in its answer when a card already asks, and names a crew member only with who it is ("Patch, my code reviewer"), or not at all ("the review is done").
- **Backend:**
  - When an app's answer holds a link to Composio's temporary file storage, the api fetches the file itself and puts its text in the answer in place of the link. Only Composio's own storage address is fetched, over https, with no redirect followed, 10 seconds and 1 MB at most, and at most 5 files per answer. A long file is cut at the end of a line, with a note saying which lines are shown and that nothing after them was read. A binary file is named with its type and size. A file that can't be fetched becomes a plain note saying so, with no link. The link is never sent to the agent and never written to the logs. Nothing goes wrong for the action itself if a fetch fails: the action has already run and is charged as before.
  - The card for one of Claude Code's commands gets its title from the command itself: a lone download or upload in plain words with the host ("Download data.json from example.com", "Send data to hooks.example.com"); anything else (a pipe into another program, two commands, a script) is shown as the command with its long addresses cut to their host, and the reason after it. A command asked about for another reason (writing outside the workspace) is always shown in full. What is approved is unchanged: the exact command. Old agent images still sending the old reason get the new title too.
  - The pull-request review automation's instruction and the crew-job tool now say that Tex posts the review, not Patch.
- **vm-manager (the Bridge, in the agent image):**
  - Patch gets the code with git (clone, then fetch the pull request), which needs nobody's OK and makes no card, and reads the changed files in full. It never downloads with `curl` or `wget` and never opens a link from a tool's answer; when git can't get the code it uses GitHub's actions, whose answers now hold the files.
  - Patch makes findings only from code it read, each with its file and line. A file or part it could not read is named as not reviewed, with no "if X is …, then …" findings. It never states a package's versions or a library's behaviour from memory: it checks (the repository's lock file, `pip index versions`) or leaves the point out.
  - Patch never posts on GitHub and never asks you for an OK; it returns its review to Tex. On Claude Code, Byte, Patch and Scout can no longer call `request_approval` at all (it is in their refused tools); only Tex asks you.
  - Tex's rules: "check / look at / review a pull request" means the review in the chat; posting only when you asked (or a review automation says so), as one review that comments; Patch's findings passed on as given, with what it could not check, and none added from memory; a crew member named only with who it is; no second question when a card already asks; the "unchecked / open / pending" search above.
  - The gate's reason for a network command is plain words: "it downloads from the internet", "it sends data over the internet" or "it connects to the internet". When the gate asks is unchanged: network commands still need your OK only while Scout's browser is on, because only then can the container reach any website.
- **Cost and speed:** an action that returns a file now waits for that one download (usually well under a second, 10 seconds at most), and its answer holds the file's text: up to about 20,000 characters (about 5,700 tokens) per file, read again on later rounds of that turn. That is the content the review needs; before, the agent got a link, then tried `curl` and asked you. Tex's instructions grow by 1,289 characters and Patch's by 1,172 (measured), all in the part the prompt cache keeps. No new supplier, no new charge.
- **Contracts:** none. `openapi.yaml` and `vm.proto` are unchanged. An approval's summary for a command reads differently; its details (the exact command, why, the folder) are as before.
- **Database:** none.
- **How it was checked:**
  - Backend: two new test files. `app-files.test.ts` (13 tests): 17 October's link shape is fetched and replaced by the file's text, with no link left; other addresses (another host, http, a port, a look-alike host) are not fetched; a long file is cut at a line with the right note and is not cut a second time; a failed fetch, a binary file and too many files each give their note; the download itself refuses a redirect and an error page and stops at 1 MB (against a small local server); and `run_app_action` sends the agent the text, not the link. `command-words.test.ts` (21 tests): 17 October's command gets the plain title, also with the old reason; downloads and uploads in plain words; pipes into a shell, two downloads, substitutions and ssh shown as the command with long addresses cut; a command asked about for writing outside the workspace shown in full. The Telegram question in `agent-approvals.test.ts` now reads "I'd like to download data.json from example.com". Lint and type check pass. The touched and nearby test files pass: 10 files, 127 tests (`app-files`, `command-words`, `agent-approvals`, `approval-message`, `pr-review`, `crew-jobs`, `app-results`, `github-results`, `app-action-inputs`, `app-action-charge`). The whole suite was not run here; the main session runs it at merge.
  - vm-manager: new Bridge tests for Patch's rules on both engines (never posts or asks, git first, no curl, findings only from what it read, nothing from memory), for the specialists' refused `request_approval`, for Tex's rules (reviews in chat, posting, naming the crew, one question), for the "unchecked" search, and for the gate's plain reasons (download, upload, connect, and no "Scout" or "browser" in any reason). All 283 Bridge tests pass (1 skipped, the real-browser test, as before). No Go code changed.
  - Not tried on the server or with your GitHub account.
- **Still open:**
  - The three cards from 17 October (`apr_01m54n0syrv70rqd1gsyb98esw`, `apr_01m54n0w3800r8mqbprgmd591j` and the "request changes" review `apr_01m54n26crgjwdww41fz5z3z8j`) are still waiting for your Deny; nothing here touched them.
  - The storage address is Composio's R2 account as seen on 17 October. If Composio moves its files to another address, the api will not recognise the link and will pass it on as before; Patch is now told never to download a link, so it would say it could not read the file rather than ask you. If that shows up, the new address goes into `app-files.ts`.
  - The card that offers to run a crew job again still lists a refused command as written (with its full address). It was not part of this change.
  - Deploy: the backend (restart of api and worker) and a new agent image (the Bridge), in either order. The card's new title works with the old image too.
- **Docs updated:** `backend-report.md`: section 14 (a file given as a link), section 15 "Approvals for the agent's own actions" (the card's words, the example question), section 19 (Tex posts the review), section 20 (the crew table, the example, and "How Patch reviews, and who posts"). `hld-mvp.md`: section 5.5 (Tex posts the review). The vm-manager's `README.md` (the crew table) and `docs/build-report.md` (Patch's row). `CLAUDE.md` now names this file as the log and lists `3optimization-log.md` as closed.
- **Commits:** backend `60a5c5a` (files as text), `35ab475` (the card's title), `89044ea` (who posts, in the automation's and the crew job's words), and the docs commit with this entry; vm-manager `5493b67` (the gate's reasons), `7f4680d` (Patch's and Tex's rules), `d171d1f` (docs).
