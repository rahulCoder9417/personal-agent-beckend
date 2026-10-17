# Optimization log 3 (from 17 October 2026): what changed in the backend and the vm-manager

This file records every change made to the backend and the vm-manager from 17 October 2026 on. It takes over from `2optimization-log.md`, which holds the entries of 16 October and is no longer added to. The entries before that are in `1optimization-log.md` and the oldest in `optimization-log.md`; both are closed too. Each change is written up by feature, in plain words, with no code. An entry says what changed and why, what it means for users and for cost, how it was checked, and where it is now.

Only the backend and the vm-manager are logged here. Changes made only to the web app's screens are not; the web app's README describes those. When a piece of work changes both, its entry says what the web app did too.

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
| **Started** | 17 October 2026. Earlier entries are in `2optimization-log.md`, `1optimization-log.md` and `optimization-log.md`, all closed |
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

### 17 October 2026: "Tex is working" from the moment of sending, and where the load time goes

- **Where it is:** on the branch `perf/load-and-working` in the backend and in the web app, not on `main` yet, and not on the server or Vercel.
- **Why:** you asked why the app takes so long to load, and why, after sending a message, nothing shows for a while: no "Tex is working".
- **What was measured (17 October):**
  - **Your turns that morning** (six web messages, 04:54 to 05:20 UTC, Claude Code on your Claude plan, from the `turn_timings` table). The agent took the message (`processing`, "busy") 1.2 to 1.6 seconds after it was queued when the container was awake, 3.7 to 4.1 seconds when it had to wake. The api's own answer to Send comes before that: 3 trips to the database, about 0.8 seconds. So from Send to "Tex is working" took about 2.5 seconds when awake and 5 to 7 when waking, and the thread showed nothing at all in between, because "Tex is working" waited for both "processing" and "busy". The first progress line came 5.5 to 10 seconds after the message was queued, the answer 12 to 85 seconds after.
  - **Vercel's request log** (it keeps one hour). At 05:10:39 your message and its wake-up were refused with 401 ("Sign in to continue"), while a read of the same moment went through: the sign-in token in the cookie had run out (it lasts 60 seconds), and Clerk renews it on the web app's server for a read but never for a write. Your next message went at 05:11:00. Also: while nothing happened, the web app replaced your live connection about every 78 seconds, that is 70 seconds with nothing at all heard, not even the api's ping every 25 seconds. And you reloaded the page several times right after sending (05:12:18, 05:19:18, 05:23:38).
  - **Distance.** A trip to the database (Neon, Ohio) took 241 to 251 ms from the laptop, and a new connection 1.5 seconds; the server's figure is about 260 ms. The backend's test that makes every query wait 250 ms gives: the chat page 0.52 seconds (two trips one after the other), Send answered 0.76 seconds, Send to the reply shown with no AI time 2.53 seconds.
  - **The pages.** The chat's page is built ahead and comes from Vercel's CDN; its scripts are about 285 kB (brotli), plus Clerk's own script. A page opened after a minute away first goes to Clerk and back (Clerk answered in 0.47 to 0.59 seconds), so about 1 second more. `CLERK_JWT_KEY` is not set on Vercel, so a new Vercel instance first fetches Clerk's keys (Clerk's API answered in 0.4 to 0.6 seconds) before it lets a request through.
  - **`app.textcrew.in/` answering 404** is Clerk's answer to a request that is not a page load and has no session (a script, `curl`). A browser gets a redirect to `/sign-in` in about 0.25 seconds. Nothing to fix.
- **What the user notices:**
  - "Tex is working…" shows the moment a message is sent, and stays until Tex's own state takes over and the turn ends (before: nothing for 2.5 to 7 seconds, longer when the stream was slow). Under the message, "sending" now means on its way, and "sent" once the api has it (before it said "sending" until Tex took it).
  - A message sent after the tab sat in the background is no longer refused with "Sign in to continue".
  - On a return visit the chat shows its messages one database trip sooner, about 0.3 seconds.
  - If the live connection goes quiet while Tex works, the answer still shows within about 30 seconds, without a reload.
- **Backend:** when the agent accepts a message, the worker now tells the web app "busy" first and then marks the message `processing`. "busy" is only a note in Redis; `processing` is a database write first (about 260 ms). Before, "busy" waited for that write.
- **Web app** (for the record; its README has the details): Tex shows at work while the person's newest message waits, for up to 2 minutes (15 while the agent is waking or busy, since the message waits behind that turn), so a message whose turn never ran doesn't keep it up; the check 10 seconds after an answer uses the same rule. Before each call through its proxy it asks Clerk's script for a good token (no wait while the token is good, a new one written to the cookie otherwise, never more than 4 seconds). While Tex works and the stream has said nothing for 30 seconds, it asks the api again for the thread and the agent's state, every 30 seconds while that lasts. It notes per account which chat opened by itself (an id only, dropped on sign-out) and asks for its messages beside the list on the next visit.
- **Cost and speed:** no new cost. "busy" reaches the web app about 0.26 seconds sooner. The web app's checks add at most one request when a token must be renewed, and two reads every 30 seconds while a turn runs on a quiet connection.
- **Contracts:** none changed.
- **Database:** none.
- **How it was checked:**
  - Backend: a new test, `test/turn-accepted.test.ts`: with every query made to wait 200 ms, "busy" goes out first and the message's `processing` a database trip later. It fails on the old order. Lint, types and the whole suite: see the results below.
  - Web app: new tests for Tex at work from the moment of sending (at once, through the agent's own state to the end, a quick reply, the 2 and 15 minute limits, only the newest message), the words "sending" and "sent", the first seconds after Send played through the query cache (sending, saved, busy, processing, the answer; a failed send; a quick reply whose last event is lost), the quiet-connection check, the token renewal (shared, never more than 4 seconds, never failing a call, done before a real API call leaves the page) and the note of the opened chat. The ones for the new rule fail with it switched off. Lint, types, all 1163 tests and the production build pass. In the demo build with headless Firefox: "Tex is working" showed 53 ms after Enter, with the "sending" bubble ("Tex is on it" came at 366 ms, when the demo's agent took it); on a second visit the chat's messages were asked for at the same moment as the list.
  - Not tried on the server or on Vercel: the server could not be reached by SSH that day (the laptop's address had probably changed), and nothing is deployed.
- **Still open:**
  - **Your decisions** (`hld-mvp.md`, section 12, "Speed"): moving the database to Neon in Singapore (prepared; the same message would wait about 0.4 to 0.6 seconds of trips instead of about 2, the chat page about 0.1 seconds instead of 0.26 to 0.52), and setting `CLERK_JWT_KEY` on Vercel (free).
  - **Where the pings are held.** Not found. With the server reachable, the api's "live stream closed" lines for your account say whether it kept writing to the connections your browser stopped hearing.
  - A Vercel connection the web app replaces stays open at Vercel until its 5 minutes are up. Harmless for now; worth a look with the pings.
  - Requests to `/__clerk/…` answered 400 at 05:07 and 05:13. Clerk's script uses that address only on a `.vercel.app` address, so someone opened the app there; app.textcrew.in is not affected.
- **Docs updated:** `backend-report.md` section 4 ("Keeping reads fast": the web app's own share), section 9 ("Waking and delivering": Accepted), section 12 ("When the stream stops getting through": seen again on 17 October, and the two new checks); `hld-mvp.md` section 12 ("Not finished": the pings; "Decisions waiting on you": speed). `CLAUDE.md` now names this file as the log. The web app's README ("Loading", "Sign-in", "Chat").
- **Commits:** backend `5752968` (busy first, with its test) and the docs commit with this entry; web app `9afc5b8` (Tex at work from Send, the quiet-connection check), `7275647` (the token renewal), `7c0d995` (the remembered chat), `b618bef` (README).
