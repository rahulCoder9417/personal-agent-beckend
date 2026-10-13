# Optimization log: what changed in the backend and the vm-manager

This file records every change made to the backend and the vm-manager while we optimize the product, starting on 13 October 2026. Each change is written up by feature, in plain words, with no code. An entry says what changed and why, what it means for users and for cost, how it was checked, and where it is now.

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
| **Started** | 13 October 2026 |
| **Order** | Newest change first |
| **Where the work is done** | The branch `claude/determined-ride-icigwz` in both repos |
| **How it reaches `main`** | A pull request that you merge |
| **How it reaches the server** | After it is on `main`, by running `/opt/textcrew/deploy.sh` on the server (see `aws-setup.md`, section 8) |

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

- **Where it is:** on the branch, on `main`, or on the test server, with the date it got there. This is updated as the change moves along.
- **Why:** the problem or the goal behind the change.
- **What the user notices:** what changes for someone using Textcrew. "Nothing" is a fine answer for a change on the inside.
- **Backend:** what changed in the api or the worker, in words.
- **vm-manager:** what changed in the containers, the Bridge or the egress proxy, in words.
- **Cost and speed:** what the change does to our bills, to users' credits, to the memory a container uses, or to how fast a reply comes. Numbers when they were measured, and "not measured" when they were not.
- **Contracts:** whether the REST contract (`openapi.yaml`) or the contract with the vm-manager (`vm.proto`) changed. A changed contract means the web app or the backend has to follow.
- **Database:** new or changed tables, or "none".
- **How it was checked:** the tests added and their real results, and whether it has run on the test server.
- **Still open:** what is left to do, or what needs your decision.
- **Docs updated:** the sections of `hld-mvp.md` and `backend-report.md` that were changed.
- **Commits:** the short commit ids in each repo, so the change can be found later.

---

## 4. The log

### 13 October 2026: replies appear in web chat as they are written

- **Where it is:** on `main` since 13 October, in the backend, the vm-manager and the web app. It works only once the server is deployed: the web app on its own shows nothing new.
- **Why:** web chat showed "Tex is working…" and then the whole answer at once, which felt slow.
- **What the user notices:**
  - In web chat, Tex's answer appears a few words at a time, then becomes the normal formatted message.
  - A sentence Tex writes just before using a tool ("Let me check your calendar.") shows briefly, then "Tex is working" comes back while the tool runs.
  - Only Tex's own answer streams, not the crew's work.
  - Telegram is unchanged: it still gets one finished message.
- **Backend:** for web chat turns only, the worker asks the container for the answer as it is written and passes each version to the web app's live stream. It saves nothing extra: the final answer is saved exactly as before. If a turn fails, the half-written answer is cleared before the apology. A slow connection gets only the latest version.
- **vm-manager:**
  - **The Bridge:** about four times a second, it reports the whole text so far of the lead's answer. It reads it from Claude Code's partial messages, or from Hermes's own text events. The text starts over at a new message, a tool call, a crew round or a restarted session. Hermes's "connection dropped, reconnecting" notice is left out.
  - **The vm-manager:** passes these reports on to the backend.
- **Cost and speed:** no extra AI cost. A little more traffic inside the server during web chat turns. Not measured.
- **Contracts:** `vm.proto` gained the event type `TEXT_DELTA` (value 5). `openapi.yaml` gained the live-stream event `message.draft`. Both only add.
- **Database:** none.
- **How it was checked:**
  - New tests in all three repos, and all checks pass.
  - The real Claude Code program (2.1.296, the version now pinned) ran through the Bridge against a stand-in AI service: the text grew in steps until it equalled the final answer, with none of the model's thinking in it.
  - The web app's demo mode was checked in a browser: the answer grows, then becomes the formatted message.
- **Still open:** not yet run on the server, with a real model, or with Hermes itself. Hermes's text events were read in its source code only.
- **Docs updated:** `hld-mvp.md` sections 5.2 and 12; `backend-report.md` sections 9, 12 and 34; the vm-manager's README and build report (section 15); the web app's README.
- **Commits:** backend `9d66044`, `252b9d9`, `2e441cd`, `31eac52`, `332cd83`, merged in `6f7b746`; vm-manager `8736533`, `909508d`, `bcc6576`, `4cb3e82`, `4cea44c`, merged in `ed9e2c3`; web app `0536bba`, `c0aa97b`, `6f8584f`, `ae63a23`, merged in `1176fbc`.

### 13 October 2026: automations answer in their own conversation, say when they are late, and use your time zone

- **Where it is:** on `main` since 13 October (backend and web app). The backend part reaches the server with `deploy.sh`.
- **Why:** on 13 October an "every morning at 9" summary of open pull requests appeared in the middle of an unrelated web chat ("hlo") at 3:01 PM India time. Three things caused it:
  1. An automation answered in whatever conversation was open at the time.
  2. Every account was on UTC, so "9 in the morning" meant 2:30 PM in India.
  3. The run was late because the server had been off, and nothing said so.
- **What the user notices:**
  - In web chat, an automation now answers in the conversation it was made in. If there is none, or it was deleted, it answers in a conversation of its own named after the automation. It never answers in the conversation that happens to be open.
  - A run that starts more than 10 minutes after it was due says so, and says when it was due.
  - A new account takes the browser's time zone once, so "9 in the morning" means 9 where the user is. A time zone the user chose in Settings is never replaced.
- **Backend:**
  - An automation remembers the conversation it was made in.
  - **Fixed a bug where a missed run could be dropped:** when the worker started, setting an automation's timer again replaced a run that had come due while the worker was off. Such a run now runs late instead of being dropped.
  - A run rebuilt after the job queue lost its jobs still knows its automation and when it was due.
- **Cost and speed:** none worth measuring: one more database lookup per run.
- **Contracts:** `openapi.yaml` gained one field in the account answer (`timezoneSet`). The change only adds a field. `vm.proto` did not change.
- **Database:** two new columns: whether the user's time zone was ever set, and the automation's conversation. Every account whose time zone is not UTC was marked as set.
- **How it was checked:** 14 new backend tests, all backend and web app checks pass, and the web app's part was tried in demo mode in a browser. Not yet on the server.
- **Still open:**
  - **On Telegram, a run still answers in the chat's current conversation.** On Telegram the user can only write in the latest conversation, so an answer kept anywhere else could not be followed up with its context. Say if you want it the same as web chat.
  - The container's own clock stays on UTC. Automations use the account's time zone, so this does not change when they run.
  - Someone who chose UTC in Settings before this change gets the browser's time zone once.
- **Docs updated:** `backend-report.md` sections 8, 18, 19, 40, 41 and 44; `hld-mvp.md` sections 5.4 and 12; the web app's README.
- **Commits:** backend `e86c91b`, `bc6f342`, `e6470a1`, `27eb459`, `243fa22`, `61570bb`, merged in `dfff18d` (its database change renumbered to 0017); web app `c6d6864`, `0151bb7`, merged in `76db6ef`.

### 13 October 2026: our own connect screen, straight to Google or GitHub, and more apps

- **Where it is:** on `main` since 13 October (backend and web app). The backend part reaches the server with `deploy.sh`.
- **Why:** connecting an app showed Composio's logo and name. Only Gmail and GitHub could be connected.
- **What the user notices:**
  - Before any sign-in page, a Textcrew screen shows Tex and the app, says in plain words what Tex will be able to do with it, and gives the rules for approvals, credits and the sign-in. It then offers "Continue to Google" (or GitHub, and so on), or Cancel. It is used for Connect, Add account and Reconnect on the Apps page, and in onboarding.
  - Back from the sign-in, the page and the Apps screen say clearly "connected" or "didn't connect".
  - More apps can be connected once you switch them on (see "Still open").
- **Backend:**
  - **Our own sign-in app:** when an app's Composio setup uses our own sign-in app (a Google or GitHub app registered by us), the user now goes straight to Google's or GitHub's own page, with no Composio page on the way. Composio's shared sign-in still goes through Composio's page: Composio forces that since July.
  - **More apps:** a new setting, `COMPOSIO_MANAGED_APPS`, lets the server make an app's Composio setup by itself the first time someone connects it. It is off until you turn it on. The setups it makes are kept in a new table.
  - **The way back:** a new address, `api.textcrew.in/oauth/callback`, can carry users back from a sign-in through our own domain. It only forwards to Composio and saves nothing.
  - **Fixes on the way:**
    - The address users return to after a sign-in must now be exactly our web app. Before, any address that only started with it was accepted, which a bad link could misuse.
    - A second account of the same app now works.
    - Composio failing during a connect is now a clear "try again" (503) instead of a server error.
- **Cost and speed:** no change for apps that already work. Apps on Composio's shared sign-in count against Composio's smaller free limits.
- **Contracts:** `openapi.yaml` gained two fields on each app (whose sign-in comes next, and what Tex can do with it), a 503 answer on connect, and the `/oauth/callback` address. The web app follows. `vm.proto` did not change.
- **Database:** a new table, `composio_auth_configs`, for the app setups the server made itself.
- **How it was checked:**
  - 22 new backend tests, with Composio stood in for: there is no Composio key on the cloud machine.
  - Backend, web app and demo walk-through checks pass.
  - Nothing has run against the real Composio yet.
- **Still open, your steps** (written out in `composio.md`, sections 8 and 9):
  1. **More apps:** set `COMPOSIO_MANAGED_APPS=all` in the server's `beckend/.env`, then restart the api and the worker.
  2. **Our logo on Composio's page:** in Composio's dashboard, Project Settings → White Labeling → Branding, set the title "Textcrew" and our logo.
  3. **No Composio at all for GitHub:**
     - Register our own GitHub sign-in app. GitHub needs no review.
     - Make a Composio setup that uses it.
     - Put its id under `github` in `COMPOSIO_AUTH_CONFIGS`, then restart.
  4. **Gmail the same way** needs Google's review and a yearly outside security check, six weeks or more. Until then Google shows an "unverified app" warning and allows at most 100 users.
  5. **Existing users** keep the old setup until they disconnect and reconnect.
- **Docs updated:** `composio.md` (new sections 8 and 9), `backend-report.md` (sections 2, 14, 40, 41, 42 and 44), `hld-mvp.md` (sections 10 and 12), the web app's README.
- **Commits:** backend `51c80a6`, `15fc42c`, `36cdf6f`, `292726c`, `202afa3`; web app `a0ccb19`, `0d6d0af`, `80edc3d`, `1e62789`, `3633019`.

### 13 October 2026: a calmer Settings screen and our own dropdowns

- **Where it is:** on `main` since 13 October. The web app only.
- **Why:** Settings was crowded, and the browser's own dropdowns looked poor and out of place.
- **What the user notices:**
  - Settings reads top to bottom in one column of grouped cards. Each setting has its name and a line of help on the left and its control on the right; on a phone the control goes underneath.
  - On a laptop, a menu of the sections sits on the left. On smaller screens there is a tab strip.
  - "Agent & AI" is split into two groups:
    - **Engine:** the choice of agent, plus Claude Code's model and effort.
    - **AI access:** your API key, your Claude plan and Textcrew AI.

    The rules that decide which AI runs are folded away under "How it's decided".
  - Every dropdown in the app looks like the rest of the app and works with the keyboard. On a phone, a list opens as a sheet from the bottom with big rows.
  - The time zone can be found by typing a city or an offset such as "5:30".
- **Backend:** no change.
- **vm-manager:** no change.
- **Cost and speed:** none. No new library.
- **Contracts:** none.
- **Database:** none.
- **How it was checked:**
  - New tests cover the dropdowns' keys, search and placement, and every Settings group drawn from the demo data.
  - The screens were driven in a real browser at phone, laptop and desktop widths.
  - All web app checks pass.
- **Still open:**
  - The app has no dark theme yet.
  - Nobody has tried the dropdowns on a real phone or with a screen reader.
  - **Two choices you may want to change:**
    - The section menu only appears from 1280 pixels wide, because below that it squeezed the Credits table.
    - Pressing Tab closes a list without choosing, because on Agent & AI a choice saves at once.
- **Docs updated:** the web app's README (the "Width" rule now makes Settings the exception, plus new sections on Settings and the dropdowns).
- **Commits:** web app `628b476`, `b6ad656`, `be4c02e`, `bff7d94`, `a713f67`, `e7101da`, `6f667e3`, `ea091a3`, `88b0f53`, `b99ca3f`, merged in `0cdd79c`.

### 13 October 2026: side panels that fold away, each with a close button

- **Where it is:** on `main` since 13 October. The web app only, so it reaches app.textcrew.in when Vercel builds `main`.
- **Why:** the chat history appeared and disappeared with no movement, and the left menu and the right "Tex is awake" panel could not be closed.
- **What the user notices:**
  - **The left menu** folds down to a slim rail of icons with one button, and opens again with the same button. On the rail, waiting approvals show as a number on their icon, and the credits card shrinks to the balance (for example "1.9K").
  - **The chat history and the right panel** slide away and back. Each has its own close button, and a button in the chat's header brings it back.
  - **Chats** slide into the history when started, and fold shut when deleted.
  - **On a phone**, the chat drawer now slides out as well as in.
  - **Remembered:** the browser remembers what was closed.
  - **Reduce motion:** with "reduce motion" switched on in the device's settings, nothing moves.
- **Backend:** no change.
- **vm-manager:** no change.
- **Cost and speed:** none. All of it is done with the browser's own styling, with no new library.
- **Contracts:** none.
- **Database:** none.
- **How it was checked:**
  - Lint, the type check and all 465 web app tests pass.
  - In the web app's demo mode, each panel's width was measured frame by frame while it moved, and the keyboard was walked through every button.
  - It was checked that nothing slides when a page first loads, and that nothing moves with reduce motion on.
  - Screenshots were taken at phone, tablet and desktop widths.
- **Still open:**
  - A panel that was closed shows open for a split second when a page is first loaded, until the app has started.
  - The phone drawer's slide-out needs a recent browser. On an older one it simply closes at once.
- **Docs updated:** the web app's README.
- **Commits:** web app `7d1ac68`, `873a51b`, `e400593`, `9f6b181`, `bc36b60`, `69e6b6c`, merged in `c66a4b9`.

### 13 October 2026: every Claude model in Settings

- **Where it is:** on `main` since 13 October. Not on the server yet: the agent image has to be rebuilt there.
- **Why:** with a Claude plan connected, the Model choice offered only four models, and one of them (Haiku 4.5) was out of date.
- **What the user notices:** the Model choice now lists every model Claude Code can use. The four current ones (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1) come first under one heading. The nine older ones Claude still offers come under a second heading. The effort choice offers only the levels the chosen model takes, and is greyed out for the two models that take none. Both Fable models carry a note: on Pro they are paid with usage credits, and on Max they may use up to half the weekly limit before credits.
- **Backend:** the list of models is kept by hand in one place, because Claude has no way to tell an app which models a plan allows. Each model now says its group (current or older), its effort levels, and an optional note. Choosing an unknown model is still refused, and a saved model later taken off the list still reads as "Default".
- **vm-manager:** the agent image now installs Claude Code 2.1.296 instead of 2.1.283. The old version did not know Sonnet 5.5 or Haiku 5.5. The Bridge needed no change: it already passes any well-formed model name to Claude Code.
- **Cost and speed:** no change for us. A user who picks Fable on a Pro plan spends their own Claude usage credits without being asked again, because Claude Code works that way when it runs without a screen. The note warns them before they pick it.
- **Contracts:** `openapi.yaml` gained three fields on each model choice (group, effort levels, note). The change only adds fields. `vm.proto` did not change.
- **Database:** none.
- **How it was checked:** new tests save every model and check it reaches the turn, check the list's shape, and send all 13 names through the Bridge to Claude Code. Backend, web app and vm-manager checks pass. The 13 names and their effort levels were checked against Anthropic's model pages and against the model table inside Claude Code 2.1.296 itself.
- **Still open:** the agent image has not been built with 2.1.296 (its download could not be checked from the cloud machine), and no real turn has run on it yet. Whether a given plan really allows each older model has not been tried.
- **Docs updated:** `backend-report.md` (the Claude Code model and effort part), `hld-mvp.md` section 2, the vm-manager's README and build report, and the web app's README.
- **Commits:** backend `2c00d15`, `5c2a38b`, `3ae170a`; vm-manager `6504752`, `bb742c1`, `47d0290`; web app `ff453a6`, `47b02c9`, `931a63e`, `afe22d5`.
