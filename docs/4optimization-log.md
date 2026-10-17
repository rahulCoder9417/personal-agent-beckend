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

### 17 October 2026: Code review that reads before it judges (files as text, Patch never posts, plain command cards)

- **Where it is:** on the branch `fix/review-no-guessing` in the backend and in the vm-manager, not merged or deployed yet.
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
