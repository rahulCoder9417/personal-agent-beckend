# The Textcrew backend: how it works

This report explains every piece of logic in the backend, in words. It has no code. It says what each part does, in what order things happen, what the rules are, and what happens when something fails.

Read `hld-mvp.md` first. It gives the short version and explains the words. This report is the long version: come here when you want to know exactly how one thing works.

| | |
|---|---|
| **What the backend is** | One program, started as two processes: the api and the worker |
| **What it does** | Receives messages, runs each user's agent through the vm-manager, charges credits, sends replies |
| **What it does not do** | It does not run the AI itself. Each user's agent runs in its own container |
| **Where it runs** | On the AWS test server (see `aws-setup.md`) |
| **How it is tested** | 749 automated tests, with a real database and real queues |
| **What is in this report** | The backend, and the parts it depends on: the vm-manager, the container, the proxy |

## How to read this report

The report has five parts. Each section starts by saying what it is for. Most sections have a small example and end with "What can go wrong".

| Part | Sections | What it covers |
|---|---|---|
| A. The message path | 1 to 12 | The two processes, jobs, webhooks, sign-up, linking, one message from start to end |
| B. What the agent can do | 13 to 22 | The agent's tools, apps, approvals, automations, pull-request review, the crew, the web, memory |
| C. Money | 23 to 31 | Credits, charging, plans, payments, coupons, the three ways to bring AI |
| D. Containers and operations | 32 to 42 | Containers, the proxy, the browser, backups, security, the database, the API, settings |
| E. Where it stands | 43 to 45 | The known risks, what has run for real, and a table for developers |

Names in `this style` are real names you will meet: a setting, a database table, an address or a tool.

## Contents

**Part A. The message path**

1. What the backend is
2. How the code is divided
3. Jobs and queues
4. A request inside the api
5. Webhooks
6. Sign-up and the first container
7. Linking a chat app
8. Channels
9. One message from start to end
10. Sending replies
11. Voice, images and documents
12. Live updates in the web app

**Part B. What the agent can do**

13. The agent's tools (Platform MCP)
14. Apps through Composio
15. Approvals
16. The user's own MCP servers
17. Git through the git gateway
18. Reminders and automations
19. Pull-request review
20. The crew
21. Web research: search and reading pages
22. Shared memory

**Part C. Money**

23. Credits: the idea
24. What costs credits
25. How charging happens
26. When credits run out
27. Plans
28. Payments with Polar
29. Coupon codes
30. AI, three ways
31. Admin tools

**Part D. Containers and operations**

32. Containers: what the backend asks for
33. The life of a container
34. Inside the container
35. The way out: the egress proxy
36. Scout's browser
37. Operations
38. The security rules
39. When something fails
40. What the database holds
41. The API in words
42. Settings

**Part E. Where it stands**

43. The known risks, said plainly
44. What has run for real
45. For developers: where the old section numbers went

---

# Part A. The message path

## 1. What the backend is

The backend is the server side of Textcrew. It receives messages, decides what to do with each one, and sends the replies. It also keeps accounts, credits and settings. It does not run the AI agent itself. Each user's agent runs in its own container, which is a small closed-off computer on our server.

Example: Rahul texts "email Priya the notes" on Telegram. The backend receives the text, checks his credits, wakes his container and hands the text to his agent. Later it sends the agent's answer back to Telegram.

### Two processes

The backend is one codebase that is started in two ways. A process is one running program.

| Process | What it does |
|---|---|
| api | Answers the web app, other services and the agents. It must be fast. |
| worker | Does the slow work: agent turns, sending replies, timers, backups. |

There are two because some work is slow. One agent turn can take up to 15 minutes, and a caller should not wait that long. So the api only saves what came in and adds a job. A job is a note that says "do this work". The worker picks the job up and does it. The two never call each other. They share the database and pass jobs through Redis.

### What the api answers

- The web app's requests, under `/v1`.
- Webhooks, under `/webhooks`. A webhook is a message another service sends to our server.
- The tool server for agents, at `/mcp`. Agents call it to send messages and to use apps.
- The git gateway, at `/git`. Agents use it to work on GitHub repos.
- A health check at `/healthz`, and an admin page for the queues at `/admin/queues`.

### The services it talks to

| Service | What it is for |
|---|---|
| Postgres | The database. Keeps what must last: users, messages, events, credits. On the laptop it is a container. On the server it moves to Neon, a managed Postgres in Ohio (section 40). |
| Redis | A fast store in memory. Holds the job queues, locks, counters and live updates, and short-lived copies of what almost every request reads (section 4, "Keeping reads fast"). |
| vm-manager | Our Go service. The only one that may create, wake or delete containers. |
| LiteLLM | A gateway to the AI models. Gives each user a key with a spending limit. |
| Caddy | The web server at the front. Handles HTTPS and forwards requests to the api. |
| Clerk | The sign-in service for the web app. It also reports new and deleted users. |
| Telegram | The chat app. It sends us user messages and delivers our replies. |
| Composio | Connects the user's apps, such as Gmail and GitHub, and runs actions in them. |
| Polar | Takes payments for plans and top-ups, and reports them to us. |

The backend never talks to Docker or to a container directly. It always asks the vm-manager, over a private connection with a shared secret. Caddy answers "not found" for `/mcp` and `/git`. Only containers reach those two, from inside the server.

## 2. How the code is divided

The code is split into nine modules, so every area has one owner. A module is a folder of code for one part of the product.

| Module | What it does | Tables it owns |
|---|---|---|
| auth | Users, sign-in checks, link codes, linked chats, the waitlist | `users`, `link_codes`, `channel_links`, `waitlist_entries`, `waitlist_attempts` |
| channels | Talks to the chat apps. Stores messages and files, and groups messages into conversations. Carries live updates | `messages`, `attachments`, `conversations`, `chat_epochs` |
| events | Saves everything that comes in. Owns the queues | `events` |
| orchestrator | Runs one agent turn. Also approvals, agent settings and memory | `sandbox_tokens`, `approvals`, `agent_settings`, `memories`, `chat_engines` |
| platform-mcp | The tool server that agents call | None. It keeps short-lived data in Redis |
| integrations | Composio apps, the user's own tool servers and API keys, the git gateway, web search | `connections`, `composio_auth_configs`, `user_mcp_servers`, `composio_triggers`, `byok_keys` |
| billing | Plans, subscriptions, credits, coupons, Polar, LiteLLM keys | `subscriptions`, `credit_grants`, `credit_ledger`, `usage_periods`, `coupons`, `coupon_codes`, `coupon_redemptions`, `litellm_keys`, `payments` |
| automations | Reminders, repeating tasks, pull-request review | `automations`, `pr_reviews` |
| admin | The activity log, alerts, metrics, the health check, backups | `audit_log` |

### The rule

A table is one list of rows in the database, such as all users. Each module owns its tables. No other module reads or writes them. A module that needs something from another module calls a function that the other module offers. This keeps changes safe: billing can change how it stores credits, and no other module breaks. Example: the orchestrator must know if Rahul has credits. It does not read the credit tables. It asks billing, and billing answers yes or no.

One small piece of code connects the modules when a process starts. Both the api and the worker run it. It hands billing's credit check to the orchestrator, and the coupon check to the message path. So the orchestrator works without knowing how billing is built.

## 3. Jobs and queues

Jobs let the backend do slow work later without losing it. This section says what a job is, where it waits, and what happens when something fails.

### What a job is

A job is a small note kept in Redis. It has a name and a little data, such as an event id. A queue is a line of jobs that wait for the worker. A library named BullMQ manages the queues. Example: Rahul's Telegram message becomes one job named `process-message` in the inbound queue.

The api only adds jobs, and the worker runs them. This keeps the api fast. It saves a row in the `events` table, adds the job and answers. If the worker is down, the jobs wait in Redis until it is back.

### The four queues

| Queue | What goes in it | Jobs at once |
|---|---|---|
| inbound | User messages, approval answers, fired automations, app events | 20 |
| outbound | Replies to send, delivery receipts | 20 |
| scheduled | Timers of reminders and automations | 5 |
| system | Sign-up, account deletion, payments, usage sync, the billing of each turn, refunds of failed turns, checking and tidying app connections, cleanup, backup | 5 |

There are four so slow work never blocks fast work. A long agent turn in inbound does not hold back a reply in outbound. Some system jobs repeat on their own. Usage sync and the health check run every 5 minutes. Credit expiry and approval expiry run every hour. Cleanup and backup run once a day.

### Why every job is safe to run twice

A job can run a second time, for example after a crash. Three things stop double work.

1. Each thing that comes in is one row in `events`. The row is unique for the sender plus the sender's own id.
2. The job id is the event id. BullMQ refuses a second job with the same id. Finished jobs are kept 7 days for this.
3. Every job first checks if its work is already done. A message is saved once per event. A reply that is no longer `queued` is not sent again. Sign-up credits are given once per user.

### Retries

A job that fails is tried again, 5 tries in total. The waits are 5 seconds, 30 seconds, 2 minutes and 10 minutes. After the last try the event is marked `failed`, with the error text. An alert is raised: an error line in the log. If `ALERT_WEBHOOK_URL` is set, the alert is also posted there. The failed job stays on the admin page for 30 days. An admin can run it once more or remove it there (section 31).

### The per-user lock

Only one inbound job per user runs at a time. Two turns at once would mix up the conversation. Before an inbound job starts, the worker takes a lock for that user in Redis. If the lock is taken, the job goes back in line for a quarter of a second, and after it has waited 10 seconds, for 2 seconds at a time. When the job ends, the worker gives the lock back.

Why the short wait first: the lock is often held only by the end of the turn before, the few things it saves after the answer is already out. A message sent right after an answer then starts within a quarter of a second of the lock coming free, not up to 2 seconds later. A long turn still sees the next message look again only every 2 seconds.

The lock covers only what the next message depends on: the turn itself, its messages and the state of its conversation. The billing of a turn is not part of it. Since 15 October 2026 it runs as a job of its own in the system queue, after the lock is given back (section 25).

So one user's messages are handled one by one, in order. The lock ends on its own after 16 minutes, a little longer than the longest turn. Paying users go first in the inbound queue: Max, then Pro, then Free.

### What can go wrong

- **The worker crashes during a job.** BullMQ notices and puts the job back. The "already done" checks stop double work.
- **The worker crashes while it holds a lock.** The lock ends after 16 minutes. Then that user's jobs run again.
- **The api stops between saving an event and adding its job.** The sender sends the message again. The api then adds the missing job.
- **A job ends before the api writes "queued" on its event.** A quick reply can be that fast. The api writes "queued" only on an event that is still "received", so a finished event stays finished.
- **Redis loses its data.** Redis writes its data to disk, but a loss is still covered. Every time the worker starts, it adds jobs again for unfinished events of the last 7 days. It also sets up every automation timer again from Postgres.

## 4. A request inside the api

This section follows one request from the web app through the api, check by check. Example: the web app asks for Rahul's profile with `GET /v1/me`.

### The steps

1. Caddy receives the request over HTTPS and forwards it to the api.
2. The api gives the request an id. The answer carries the same id in the `X-Request-Id` header. If the caller sent its own `X-Request-Id`, the api keeps it, but only when it is up to 64 letters, digits, `_` or `-`; otherwise it makes a new one, such as `req_01m4z1tdg2p20p83w3f87072p1`.
3. The api reads the caller's IP address and counts the request against the IP limit. With `TRUST_PROXY` on, it uses the address Caddy wrote, which a caller cannot fake.
4. The api finds the route. Each route's address, method and rules come from the API contract, one file that lists every address the api answers.
5. If the route needs a signed-in user, the api checks the session (below). Admin routes also need the role `admin`.
6. The api checks the address, the query and the body against the contract.
7. The route's own code runs. Every database query is filtered by the user's id.
8. The api writes one log line and counts the request's time (below).

### The sign-in check

The web app signs the user in with Clerk. Clerk gives the browser a session token, a signed text that proves who the user is. The web app sends it with every request.

1. The api checks the token's signature with Clerk's key. A missing, old or forged token is refused.
2. The token holds Clerk's id of the user. The api finds the matching row in `users`, from the short copy in Redis when there is one (below). A deleted account is refused. A suspended account is refused with `account_suspended` (section 31).
3. If there is no row yet, the api reads the user from Clerk and creates the account. This covers a user who arrives before Clerk's sign-up webhook. A new account's first page sends about a dozen requests at once; they share one read at Clerk and one new row, instead of each making its own.

### Keeping reads fast

The database is on Neon, in Ohio, and the server is in Mumbai. Each trip to the database takes about 260 ms there and back, and opening a new connection to it about 1.5 to 2.5 seconds. So the time a page takes is mostly the number of trips it waits for, one after another, plus any connection it has to open. Since 15 October 2026 the backend cuts both.

**The connections stay open.** The api and the worker each keep 10 connections to the database open at all times (`DB_POOL_MIN`), however long nothing happens. They open them when they start, and every minute (`DB_PING_SECONDS`) each idle one is checked with a tiny query. A connection that died, because Neon restarted or the network dropped it, is replaced then, so a user's request does not pay for opening it. More connections are opened when needed, up to 20, and those close again after 5 minutes idle. Before, every connection closed after 5 minutes idle, so the first page after a quiet spell opened about 8 at once and waited 2 to 5 seconds for them.

**A dropped connection no longer stops the program.** Before, a connection that died while idle raised an error nothing listened to, and Node ends a program on such an error. The api or the worker then restarted. Now the error is written to the log and the connection replaced.

**A short copy of the user's row in Redis.** Who is signed in (every web app call), whether the account is suspended (every turn and every tool call of the agent) and the plan (the queue's priority, the wake) all come from the user's row in `users`. Each read was a trip to Neon. They now read a copy kept in Redis, on the same server:

- The copy is used for 60 seconds at most.
- Every change to a user's row drops the copy at once: a suspension or its lifting, a new plan, a new role, a deletion, a new name or time zone, the first-run marks (also an admin's reset), a chargeback mark, and Clerk's updates. For the next 30 seconds no new copy is kept, and reads go to the database. A change made inside a longer transaction is saved within that time, so a read that saw the old row just before can't keep it.
- An update from Clerk changes the row only when Clerk's email, its verified state or the role differ from ours. Clerk also reports changes we don't keep (a new picture, a name), and for a new account its webhook may come after the first requests; those write nothing and leave the copy in place. Before 15 October each of them dropped the copy, and the next 30 seconds of requests each made one more trip.
- A new account gets its copy as soon as the account is made, by the webhook's job or by the first request. So the first page's requests don't each look the user up: one trip less on that page, about 0.2 seconds.
- If Redis can't be reached, every read goes to the database, as before.
- Which user a Clerk id belongs to never changes, so that is kept for a day.

Example: an admin suspends Ravi while he has the web app open. His next request is refused with `account_suspended`, not up to a minute later.

**Who a container token belongs to** is kept in Redis for 10 minutes (section 13).

**Reads that don't depend on each other run at the same time.** Examples: opening a conversation reads its messages, checks that it is the user's and reads when web chat started, all at once. The balance shown in the web app is one read of the grants (section 23). Sending a message checks the credits, the files and whether it was already sent, all at once.

What this means, measured with every query made to wait 260 ms and every new connection 2 seconds (the test `read-round-trips.test.ts` does this on request):

| | Before | After |
|---|---|---|
| A simple page call (the profile, the approvals, a list) | 0.53 s | 0.27 s |
| Opening a conversation's messages | 0.79 s | 0.26 s |
| The chat page, all its calls, then the messages | 1.33 s | 0.54 s |
| The chat page after a few quiet minutes | 3.3 to 5.4 s | 0.54 s |
| Sending a message, until the api answers | 2.9 s | 1.8 s |
| Sending a message, until the reply shows (not counting the AI's own time) | 6.1 s | 3.2 s |
| After the reply, until the user's next message can start | 5.0 s | 1.6 s |

The last row comes from moving the billing of each turn out of the turn, into a job of its own that runs after the user's lock is free (section 25). Before, the turn charged its credits itself while it still held the lock: 12 trips of the 19 it made after the reply.

**A Telegram message waits for fewer trips (15 October, evening).** Saving it, the turn's first reads, the agent's answer and its send each wait for fewer trips one after another (sections 9 and 10), and the chat shows "typing…" meanwhile. Measured the same way, from the moment Telegram calls the webhook, with the AI and the container taking no time:

| | Before | After |
|---|---|---|
| The first "typing…" in the chat | none | 1.05 s |
| The reply reaches Telegram | 5.04 s | 3.68 s |
| The job ends | 6.09 s | 4.74 s |

### The error shape

Every error looks the same: an `error` object with a `code`, a `message` and sometimes `details`.

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | The input does not match the contract |
| 401 | `unauthorized` | No session, or a bad one |
| 402 | `out_of_credits` | The balance is zero |
| 403 | `forbidden`, `plan_limit`, `channel_disabled` | Not allowed, not in the plan, or the channel is off |
| 403 | `account_suspended` | An admin suspended the account. Every signed-in call answers this until it is lifted |
| 404 | `not_found` | Unknown address or item |
| 409 | `conflict` | The action does not fit the current state |
| 429 | `rate_limited` | Too many requests. `Retry-After` says how long to wait |
| 500 | `internal` | An unexpected error. The details stay in the log. The answer gives the request id as `details.requestId`, so a user can quote it and the admin can find the log lines |

### Rate limits

A rate limit is a cap on how often something may be done. The counters live in Redis and start again when their time window ends. Any request: 600 a minute per IP address (`RATE_LIMIT_PER_IP_PER_MIN`). Web chat messages: 30 a minute per user. New web chats: 30 an hour per user. New link codes: 10 an hour per user. Tool calls from one user's container: 240 a minute.

### The request log

Each request writes one line when its answer is ready. It holds:

- the request id;
- the method and the route, as written in the contract, such as `/v1/conversations/:conversationId`. When no route answered (an unknown address, or a request stopped by the per-address limit) the route is empty;
- the address that was asked for, without the part after the question mark. A very long address is cut at 200 characters;
- the status and the time taken, in milliseconds;
- the user, when known: the signed-in user, or for `/mcp` and `/git` the user the container token belongs to;
- the caller's IP address. Behind Caddy it is the address Caddy wrote, as for the rate limits.

The level follows the status. A 5xx is an error line, a 4xx a warning, the rest plain information. The health check and `/metrics`, which machines ask every few seconds, are written only at the debug level, which the server does not show.

Every other line written while the request runs carries the same request id. So when a route fails, the "unhandled error" line and the request's own line can be found together.

The time is until the answer starts. For the live stream it is the time until the stream opens, not how long it stays open.

Example line, with made-up values:

`{"level":30,"time":1792058400123,"service":"api","requestId":"req_01m5a2b3c4d5e6f7g8h9j0k1m2","method":"GET","route":"/v1/conversations","path":"/v1/conversations","status":200,"ms":284,"userId":"usr_01m3sk0g2wwgm7wj60822scjtp","ip":"203.0.113.9","msg":"request"}`

### Logging without secrets

The request log never holds a request body, a header or the part of the address after the question mark. So sign-in tokens, cookies, webhook signatures, container tokens and one-time codes never reach it, wherever they travel. Tests send planted secrets in each of these places and check that none shows up. In any log line, fields named like password, token, secret, API key, authorization or code are also replaced with "[redacted]".

### Response times

Each request's time is also counted per route, so the admins can see which routes are slow (section 31, "Response times"). The count is kept in Redis, never in the database: a database write per request would cost a trip to Neon, about 260 ms, and would grow without end.

How it is counted:

- The route is the method and the route as written in the contract, such as `GET /v1/conversations`, never the address with its ids. Requests no route answered share one line, `GET (no route)`.
- The time goes into a bucket, such as "up to 250 ms". From 4 ms to 30 s each bucket is at most a third larger than the one before. The count is kept per route, per status class (2xx, 3xx, 4xx, 5xx) and per bucket. The slowest time of each route is kept exactly.
- There are two sets of counts: one per 5 minutes, kept 2 hours, and one per hour, kept 8 days. Redis removes them by itself after that.
- Counting never makes a request wait and never makes it fail. The api sends the count and goes on. If Redis does not take it, the time is dropped and a debug line says so.
- The health check and `/metrics` are not counted.

## 5. Webhooks

A webhook is a message another service sends to our server when something happens. This section says how the api takes them in safely.

### The rule

Every webhook goes through the same four steps. The api does no real work here.

1. **Verify.** The api checks that the message really comes from the sender. If not, it answers 401 and saves nothing.
2. **Save the event once.** The api writes a row in `events` with the sender's name and the sender's own id. That pair is unique.
3. **Add one job.** The job id is the event id.
4. **Answer 200.**

Example: Telegram sends Rahul's text twice. The second copy matches the saved event, so no second job is added. Rahul gets one reply.

### The six senders

| Sender | How it is verified | What it becomes |
|---|---|---|
| Clerk | Signed with a secret we share (`CLERK_WEBHOOK_SECRET`) | A system job: create, update or delete the user |
| Telegram | Telegram sends back a secret we gave it, in a header | An inbound job for a message or a button tap |
| WhatsApp | Meta signs the body with our app secret | One inbound job per message. Receipts go to outbound |
| Sendblue (iMessage) | A shared secret in a header | An inbound job, or a receipt in outbound |
| Polar | Signed with a secret we share (`POLAR_WEBHOOK_SECRET`) | A system job that applies the payment |
| Composio | Composio's own library checks the signature | Inbound for an app event. System for a connection change |

- The check runs on the body exactly as it arrived, before the api reads the content.
- WhatsApp has one extra step at setup. Meta calls once with a verify token, and the api answers with a value Meta sent.
- While a chat channel is switched off, its webhook answers 200 and does nothing.

### What can go wrong

- **The signature is wrong or missing.** The api answers 401 and saves nothing. The same happens when the secret is not set in our settings.
- **The same message arrives twice.** It is saved once and one job runs.

## 6. Sign-up and the first container

This section follows a new person from sign-up to an account with credits and a container. Example: Priya signs up in the web app with her email.

### The steps

1. Priya signs up. Clerk creates her sign-in account and sends a "user created" webhook to the api.
2. The api verifies it, saves the event and adds a system job.
3. The worker creates her row in `users`: email, name and role. She starts on the Free plan. It also puts a copy of the row in Redis, so the web app's first page finds her without a trip to the database (section 4, "Keeping reads fast").
4. Because the row is new, the worker adds one onboarding job. Its id holds her user id, so there is only one.
5. The onboarding job gives her 100 sign-up credits. They are given once, ever.
6. It asks LiteLLM for her own key. The key's spending limit follows her credit balance. The key is stored encrypted.
7. It asks the vm-manager to create her container. It passes her key, her plan's priority and her timezone.
8. The vm-manager creates the container and its storage, and leaves it stopped. It makes a secret token for the container. It returns only the token's hash, a one-way fingerprint.
9. The worker saves the hash in `sandbox_tokens`. From now on, a call that carries this token is known to come from Priya's container. The container is started later, when she sends her first task.

### Other paths

- **The web app arrives first.** If a request comes before Clerk's webhook, the api creates the account from Clerk's data. The requests that arrive together share that one read at Clerk. The same onboarding job is added once. The webhook that follows finds the same details and writes nothing.
- **Clerk reports a change.** The email, its verified state and the role are updated, when they differ from ours. A report that changes none of them writes nothing. An admin is a user whose role is set to admin in Clerk. The admin tool that changes a role sets it in Clerk first and on our row at once, so this webhook then agrees (section 31).
- **Clerk reports a deletion.** The account is marked deleted and a delete job runs. It removes the container and its data, the LiteLLM key, app connections, automations, linked chats, conversations, messages, files, memories, approvals and the activity log. It also stops the subscription from renewing. Section 33, "What is kept and what is deleted", has the steps and what stays.
- **An admin deletes the account.** The admin tool deletes the user in Clerk, marks the account deleted and adds the same delete job. Clerk's deletion webhook then finds nothing left to do (section 31).

### The first visit to the web app

The web app greets a new user with a few welcome steps, then shows a "Getting started" checklist on its home page. The backend keeps two marks on the user's row in `users`, so this happens once for the account, on any device and any browser.

| Mark | Empty means | Set when |
|---|---|---|
| `onboardingCompletedAt` | The welcome steps were not finished or skipped yet, so the web app shows them | The user finishes or skips them |
| `gettingStartedDismissedAt` | The checklist may still show | The user closes it |

- Both are in `GET /v1/me`. The web app sets one with `PATCH /v1/me`, sending `onboardingCompleted: true` or `gettingStartedDismissed: true`. The time is now; if the mark is already set, the first time is kept.
- Sending `false` clears a mark. Settings uses this to show the welcome steps again.
- The backend does not track the checklist's steps. The web app works them out from the account's real data and hides the checklist by itself once every step is done.
- Every account starts with both marks empty. So do the accounts made before the marks existed (15 October 2026): the database update added the two columns and filled nothing in. The users we already have see the welcome steps once on their next visit, like a new user.
- An admin can clear both marks for one user (section 31).

Example: Priya signs up on her laptop and skips the welcome steps. The next day she opens the app on her phone and lands straight on the home page, because the mark is on her account, not in the browser.

### What can go wrong

- **LiteLLM or the vm-manager is down.** The onboarding job fails and is retried. Steps that are already done are skipped.
- **The monthly cap on free credits is reached** (`FREE_CREDITS_MONTHLY_CAP`). No sign-up credits are given. The activity log records it. The rest still runs.
- **The container is still missing at the first message.** The worker creates it then.

## 7. Linking a chat app

Linking proves that a chat on Telegram belongs to an account. Without a link, the backend does not know who is writing. Example: Rahul opens the web app, gets the code LINK-7KQ2-M9XP and sends it to the bot.

### The steps

1. The web app asks the api for a link code for Telegram, with `POST /v1/channels/link-codes`.
2. The api checks that Telegram is switched on. Then it counts the request against the limit.
3. The api makes a random code. It stores only the code's hash, with the user id, the channel and the end time.
4. The api returns the code, a short instruction and a link that opens the bot with the code filled in.
5. Rahul sends the code to the bot. The webhook saves the event as usual.
6. The worker sees that the chat is not linked, and finds a code in the text.
7. In one database step, the worker marks the code as used and saves the link: this chat belongs to this user.
8. The bot replies that the chat is linked. The activity log records it.

### The limits

A code lives 10 minutes and works once. A user can make 10 codes an hour. One chat gets 10 tries an hour, linked or not, and wrong codes count. Codes never use 0, O, 1 or I, so they are not mixed up.

### What an unknown sender gets

A message from a chat that is not linked never reaches an agent. It is not saved in `messages`. The sender gets one short reply.

| The message has | The reply says |
|---|---|
| No code | The chat is not linked yet. Open Integrations in the web app (its address, ending in `/integrations`) and send the code from there |
| A wrong or expired code | The code is invalid or expired |
| A code, after too many tries | Too many attempts. Try again in an hour |
| A code, but the chat belongs to another account | The chat is linked to another Textcrew account. Unlink it there first |

### A code from a chat that is already linked

A code never moves a linked chat to another account. The user unlinks the chat first, in the web app. So the worker only looks the code up. It does not use it, and the code still works after the unlink.

| The code is | The reply says |
|---|---|
| A valid code of another account | The chat is linked to another Textcrew account. Sign in to that account at the Integrations page's address, unlink the chat in Integrations, then send the code again |
| A code of the same account, or a wrong or expired one | This chat is already linked to your account |
| Any code, after too many tries | Too many attempts. Try again in an hour |

The reply says nothing about the other account: no name, no email. It goes out once per event, even if the job runs twice. A code that comes through the bot's link, after the word /start, counts as a code too. It never reaches the agent.

Example: Rahul's Telegram is linked to his first account. He signs in to a second account and sends its code from the same chat. The bot says the chat is linked to another Textcrew account. The chat stays with the first account until he unlinks it there.

### Unlinking

The user removes a link in the web app, on the Integrations page (its Chat apps tab). The activity log records it, like the link: the channel and the name shown when it was linked, never the chat id. From then on the chat gets the "not linked yet" reply.

### What the user sees for each linked chat

The web app lists the user's linked chats with `GET /v1/channels`. For each chat it gets:

- the channel, and the name shown for it (a Telegram name, or a masked number);
- when it was linked;
- the chat id, masked: a Telegram chat keeps its last 4 digits, a phone number its country code and its last 4 digits. The full id is never sent;
- when the chat last wrote to the bot, or nothing if that was never recorded. Linking counts as writing;
- whether the user blocked the bot there. Nothing is sent to a blocked chat. The mark goes away when the chat writes again.

These are the same as an admin sees for the chat (section 31). The masked id, the last message and the blocked mark came on 15 October 2026; the web app treats them as optional, so it also works with a server from before.

Example: Rahul's Telegram chat shows "@rahul", "•••• 3645", "Last message 2h ago". He blocks the bot in Telegram; the next message Tex sends him fails, and the chat now shows "Blocked the bot". He unblocks the bot and writes to it again, and the mark goes away.

An admin can remove a link for the user (section 31). It goes the same way and writes the same activity log entry, marked as done by an admin.

## 8. Channels

A channel is one way to talk to the agent. Four are built. One setting decides which are switched on.

| Channel | By default | How the user is known | Buttons |
|---|---|---|---|
| Telegram | On | A linked chat | Yes |
| Web chat | On | The Clerk session | Not needed |
| WhatsApp | Off | A linked phone number | Up to 3 |
| iMessage, through Sendblue | Off | A linked phone number | No. The user types yes or no |

### The switch

The setting is `ENABLED_CHANNELS`: a list of channel names with commas between them. The default is `telegram,web`. The api and the worker read it when they start. An unknown name stops the process with a clear error. Example: to switch WhatsApp on, the value becomes `telegram,web,whatsapp`. WhatsApp's own keys must be set too. Then both processes are restarted.

### What "off" means

| Area | What happens while the channel is off |
|---|---|
| Linking | No code is made. The api answers 403 `channel_disabled` |
| Its webhook | Answers 200 and does nothing. WhatsApp's setup call answers 403 |
| A message already in the queue | The worker ignores it. No reply |
| Sending | Nothing is sent. The message is marked `failed` |
| The agent | Its send tool refuses that chat and points to web chat |
| Old links | They stay listed, so the user can remove them |

With web chat off, sending from the web app is refused with 403 `channel_disabled`. The rest of the web app works. `GET /v1/channels` returns the channels that are on, as `available`. The web app offers only those.

### Conversations

A chat is one place to talk: web chat is one chat, and each linked Telegram chat is another. A conversation is one stretch of a chat between two "New chat" actions. The web app shows them as a list, like a chat history. Each conversation has its own context: in one conversation the agent does not see what was said in another. The saved memories are the same in all of them, because they belong to the user, not to a chat (section 22).

| A conversation has | What it is |
|---|---|
| A channel | Web chat or Telegram |
| A kind | A conversation of a chat, or the Automations chat: the one place where every automation answers (section 18) |
| A number | Its place in its chat: 0 for the first, then 1, 2 and so on. The code calls it the epoch |
| A title | The first message the user wrote in it, cut to 60 characters at a word. "New chat" while it has none. The user can rename it. The Automations chat is called "Automations" and keeps that name |
| A start time and a last-message time | The list is sorted by the last message, newest first |
| Active or not | The active one is where the chat's next message goes. Each chat has one |

The rules:

- **Every message belongs to one conversation.** A new message is saved in its chat's active conversation. A chat's first message starts conversation 0.
- **Web chat:** the user can start a new conversation, open any earlier web conversation and keep writing in it. Writing in an earlier one makes it the active one. The agent then continues that conversation's own context, not the latest one's.
- **Telegram:** a message always goes into the chat's latest conversation. `/new` starts the next one. In the web app, Telegram conversations are listed for reading only. The api answers 409 when the web app tries to open one or write in it.
- **A reply stays where its question was asked.** What the agent sends during a turn is saved in that turn's conversation, also when the user has opened another conversation meanwhile. An approval's answer goes back to the conversation that asked for it.
- **Every automation answers in the Automations chat.** Each user has one, in web chat beside the other conversations. It is never the active one: a run never makes it active, and neither does the user writing in it. So the user's next message never goes into it unless they write there. An automation made on Telegram also sends a copy of each answer to that Telegram chat (section 18).
- **Renaming:** the user can give any conversation a name of 1 to 80 characters. A later message does not change it back. The Automations chat keeps its name: the api answers 409.
- **Deleting:** the conversation goes, with its messages and their files. They are the user's own data. A file that a message in another conversation still shows is kept. The activity log gets "Deleted a conversation in web chat" or "on Telegram". It never holds the title or the text of a message. The Automations chat cannot be deleted: the api answers 409. It stays for as long as the account does, and goes with the account.
- **After the active web conversation is deleted,** the newest remaining web conversation becomes the active one, never the Automations chat. When none is left, an empty one is started. After a Telegram chat's current conversation is deleted, the chat's next message starts a new one.
- **A number is never used twice.** The table `chat_epochs` keeps, for each chat, the highest number given out. It only goes up, also after a delete. The reason: the engine may still hold the deleted conversation's context under its old number, and a new conversation must not pick that up.

How the context stays separate:

1. Every message the agent gets carries the number of the conversation it belongs to.
2. The Bridge, our small program in the container, keeps one engine conversation for each chat and number. A message continues the engine conversation of its number. A number the Bridge has not seen starts a new one.
3. When the user goes back to an earlier conversation, the message carries a lower number than the chat's highest. The engine picks that conversation up where it stopped.
4. The recap the backend adds when the engine changes holds only the turn's own conversation (section 22). The router also sees only that conversation (section 9).
5. The Bridge is not told when a conversation is deleted. The backend deletes its own copy at once. The engine's own record stays in the container, unused, because the number never comes back. It goes when the account is deleted.

What the web app calls:

| Call | What it does |
|---|---|
| `GET /v1/conversations` | Lists the user's conversations, the one with the newest message first. `channel` narrows it to web or Telegram. `kind=automations` gives only the Automations chat, `kind=chat` everything else, so the web app can pin it apart. Pages of 30 |
| `POST /v1/conversations` | Starts a new web conversation and makes it the active one |
| `PATCH /v1/conversations/{conversationId}` | Renames it, or makes a web conversation the active one. Both answer 409 for the Automations chat |
| `DELETE /v1/conversations/{conversationId}` | Deletes it with its messages and files. 409 for the Automations chat |
| `GET /v1/messages` | With a conversation's id: its messages. With `channel=web` only: the active web conversation's messages. With nothing: every message |
| `POST /v1/messages` | Sends a message. With a conversation's id it goes into that web conversation, which becomes the active one first. The Automations chat is written in where it is: it stays not active |

Example: Rahul plans a trip to Goa in web chat. He clicks "New chat" and asks "what is a good laptop?". The agent answers about laptops and says nothing about Goa. The next day he opens the Goa conversation in the list and asks "and the hotel?". The agent answers with the trip in mind, and knows nothing of the laptop. In both it still knows he is vegetarian, because that is a saved memory.

### Starting a new chat

| Where | How the user starts one | What they see |
|---|---|---|
| Web chat | The "New chat" button | A new, empty conversation at the top of the list, named "New chat" |
| Telegram | The message `/new`. `/clear` and `/reset` work too | The bot answers: "Started a new chat. I won't use what we talked about before here. Your saved memories stay." |

- **No turn and no charge.** Starting a new chat wakes no container and costs no credits. It works at zero credits too.
- **Its number:** the new conversation gets the chat's next number. Other chats keep theirs.
- **Web chat:** at most 30 new chats an hour per user. The earlier conversations stay in the list. The older address `POST /v1/chats/new` still works and does the same.
- **Telegram:** the command must be the whole message. "/new please" goes to the agent as a normal message. The command and the bot's answer are not saved as chat messages. A Telegram message that arrives twice starts only one new chat and gets one answer.
- **A chat that is not linked** and sends `/new` only gets the "please link" reply.
- **The activity log** gets "Started a new chat on Telegram" or "Started a new chat in web chat". It never holds the text of a message.

### Messages stored before conversations existed

Conversations were added on 9 October. The messages stored before that day were put into conversations once, when the database was updated:

- A chat that never had a new chat became one conversation, number 0, with all its messages.
- A chat that had a new chat became two. The messages since its latest start are the current conversation, with the chat's current number. Everything before is one conversation, with the number before it. Earlier starts had not been recorded, so they could not be told apart.
- Each conversation got its title and its last-message time from its messages. The record of which engine last ran went to the conversation it ran in.

## 9. One message from start to end

This section follows one message through the whole system. Example: Rahul texts "email Priya the notes" on Telegram.

### Before the agent

1. Telegram sends a webhook to the api.
2. The api checks the secret and finds the user the chat is linked to.
3. The api saves the event, adds a `process-message` job to inbound and answers 200.
4. The worker takes the job and Rahul's lock.
5. It reads the event and turns Telegram's format into one common message shape.
6. It checks the special cases, in this order. Each one ends the job.
   - The chat is not linked: the link flow runs.
   - A button was tapped: it is an approval answer.
   - The text is a link code: the reply says the chat is already linked, to this account or to another one. The code is not used (section 7).
   - The text is `/new`, `/clear` or `/reset` on Telegram: a new conversation starts in this chat (section 8).
   - The text is "yes" or "no" and an approval waits in this chat: it is an approval answer.
   - The text is a coupon code: it is redeemed, and the reply shows the new balance.
7. It downloads any files and turns voice into text.
8. It saves the message in `messages`, once per event, in the chat's active conversation (section 8). The web app gets a live update. From step 7 on, the Telegram chat shows "typing…" (see "\"typing…\" in the chat" below).
9. It checks the credits. At zero, Rahul gets an "out of credits" reply and the job ends. No container is woken.

### The routing decision

10. The worker decides who answers.

| Decision | When | What happens |
|---|---|---|
| Connect an AI first | `AI_ACCESS_MODE` is `own_only` and the user has no AI of their own | A reply with the settings page. No container |
| Simple | The router is at least 70% sure | A cheap model answers through LiteLLM. No container |
| Spam | The router is at least 90% sure | The message is dropped. No reply |
| Task | Everything else | The message goes to the agent |

The router is an outside service named Jev. It judges only plain text of up to 1,000 characters, with no files. It sees the new message, the last six messages of the same conversation and the user's connected apps. It can also name the apps a task likely needs, as a hint for the agent.

Every message is a task when the router has no key (`JEV_API_KEY` is empty), is too slow or fails. The same holds when the user's own Claude plan pays for the AI. It also holds when the cheap model says it cannot answer alone. So routing can save work, and it can never lose a message.

The cheap model is told where its answer will be read. In web chat it may use formatting where that helps, such as a list for steps. In a chat app it is asked for plain text only. Section 10 says why. It is also told to pass the message on (ESCALATE) when it answers or continues something said earlier in the chat: a yes, a no, a choice, a follow-up.

Three things run side by side, so a quick answer does not wait for each step in turn:

- **The quick reply is written while Jev decides.** For a message of up to 200 characters, the worker asks the cheap model for its reply at the same moment it asks Jev. The reply is used only if Jev says "simple" and the model did not pass it on. Otherwise the request to the model is stopped and the reply is dropped. A longer message is rarely simple, so its quick reply is asked for only after Jev says "simple". Example: Rahul writes "hlo". Before, he waited for Jev, then for the model. Now he waits for whichever of the two is slower.
- **The container starts waking while Jev decides.** As soon as the message is one Jev will judge, the worker starts the wake of steps 11 and 12. A task then waits for the slower of the routing and the wake, not for both. A message that turns out simple or spam leaves the container awake but idle, and the idle check stops it after 3 minutes. That awake time is charged as usual (section 24), about a third of a credit. The setting `WAKE_WHILE_ROUTING` switches this off.
- **What the turn needs is read at once.** At the start of the turn the worker reads the conversation, whether the user has credits, the user's agent settings and whether the user's container exists, all together, and reads the settings only once per turn. Once the message is known to be a task, it reads what the agent has saved about the user and which engine had the conversation (for the recap of step 13), so both come in while the container wakes. Only reads move earlier: each decision is still made at its place in the steps.
- **A chat app's message is saved with fewer waits.** The chat's last-message time (which also clears its "blocked" mark, section 10) is written beside the next steps, not before them; the turn starts only once it is saved. Saving the message looks up "already saved?" and the chat's active conversation at once.

A user whose Claude plan pays never reaches Jev: the turn goes straight to the wake.

### Waking and delivering

11. The worker makes sure the container exists. Then it asks the vm-manager to wake it, with the plan's priority.
12. It checks the container against the account: which engine runs, and if the browser is on. The engine is the agent program, Hermes or Claude Code.
13. It builds the text: what the agent has saved about the user, a short recap if the engine changed, then the message. The recap holds only the message's own conversation.
14. It sends the delivery to the vm-manager and keeps the connection open. The delivery carries the event id, the chat it came from, the text and signed links to the files. It also carries the number of the message's conversation (section 8). After the user went back to an earlier conversation, that number is lower than the chat's highest. On Claude Code it also carries the Claude model and the thinking effort the user chose (section 30). When the answer goes to web chat, it asks for the answer as it is written (section 12).
15. The vm-manager reports back while the turn runs:
    - **Accepted.** The message becomes `processing`. The web app shows the agent as busy.
    - **Working.** A progress line. It is shown live in the web app only.
    - **Draft.** The answer so far, while the agent writes it. Only for web chat, where the web app shows it word by word. It is never saved (section 12).
    - **Done.** The message becomes `delivered`.
    - **Error on our side.** Rahul is told at once that he was not charged, and the message becomes `failed`. A separate refund job gives the turn's credits back about 30 seconds later (section 25).
    - **Other error.** Rahul gets "I couldn't finish that" with the reason.
16. In the container, the agent does the work. It calls the tool server at `/mcp` to use Gmail.
17. The Bridge is our small program in the container. It sends the final answer through the tool server's send tool. The tool saves the reply in the turn's conversation and adds an outbound job.
18. After the turn, the worker adds a billing job for it to the system queue. That is a note in Redis: no trip to the database. Then it saves what Rahul's next message depends on: the message's last state and which engine now has the conversation. The event is marked `done` and the lock is given back. Rahul's next message can start now.
19. The billing job runs on its own, a moment later. It counts what the turn used and charges Rahul's credits (section 25). The web app then gets the new balance.

### "typing…" in the chat

On Telegram the chat shows "typing…" under the bot's name while the agent works, so Rahul sees within about a second that his message is being handled.

1. The worker sends it as soon as the message is known to be for the agent: after the special cases of step 6, before any file is downloaded.
2. Telegram shows it for about 5 seconds, or until the bot's next message. So the worker sends it again every 4 seconds until the turn is over.
3. Just before any message goes to the chat (section 10), the sender notes it in Redis. "typing…" then waits 6 seconds. The answer clears "typing…" in the app and the turn ends a moment later (1 to 2 seconds), so it never comes back under the answer. If the turn goes on after a message, it comes back.
4. The agent's answer to an approval asked in a Telegram chat gets it too.
5. It never holds up or fails a turn. A failed call is written to the log, and the next one is tried at the usual time.

The setting `TELEGRAM_TYPING` turns it off (section 42). Web chat has its own signs (the agent shown as busy, the answer as it is written, section 12). WhatsApp and iMessage get no "typing…".

### What is recorded

The `events` table keeps the webhook and its state: received, queued, then done, ignored or failed. Every way the job ends sets the last state, also the special cases of step 6. A quick job can end before the api has written "queued". The api then leaves the final state alone, so the next worker start does not queue the event again. The `messages` table keeps Rahul's message and the reply, each with a status and its conversation. Files are in `attachments`. The activity log keeps the tool calls the agent made. The credit ledger keeps the charges of the turn. The `turn_timings` table keeps where the turn's time went (next part).

### Where a turn's time goes

Every turn writes one row in `turn_timings` when it ends, whatever the outcome. The row holds the moment of each stage, counted from the moment the message was queued, and a few facts: the route, the engine, how the wake went, the outcome and the try. It never holds the message, the answer or anything else the user or the agent wrote. Rows are kept 30 days and are removed with the account. Writing the row never fails a turn.

| Stage | From and to | What it is |
|---|---|---|
| queue | Queued to taken by the worker | The worker was busy, or another turn of the same user held the lock |
| prepare | Taken to the turn's start | Reading the message, downloading files, turning voice into text, saving it |
| route | The turn's start to the route | The credit check, Jev, and the quick reply. Jev's time and the quick reply's time are noted apart |
| reply | The route to the quick reply saved | A simple message only: the reply is saved and sent |
| wake | The route to the container ready | Only what is left of the wake once the route is known. Noted: warm (it was awake), cold (it was asleep), room made under the awake cap, or made again from a new image, with the vm-manager's own parts |
| context | The container ready to the delivery sent | The engine check, the memory block and the recap |
| handover | The delivery sent to "accepted" | The vm-manager and the Bridge take the message |
| engine start | "Accepted" to the engine ready | The Bridge starts Claude Code, which connects its tool servers, or starts the Hermes run |
| first output | The engine ready to the model's first words or tool call | On web chat also the model's first response and its thinking time, and, on Claude Code, the prompt cache |
| work | The first output to the engine done | The model's later rounds, the tools and the crew. The time in tools and in the crew is noted, with the number of model rounds |
| send answer | The engine done to the answer sent | `send_message` saves the answer and it reaches the user |
| wrap up | The answer sent to the turn's end | The Bridge and the vm-manager end the turn |

The stages up to "accepted" are measured by the worker. The ones after it come from the Bridge, which reports them with the turn's last event (section 34); they are placed after the moment the worker heard "accepted". After the answer, the worker still saves the turn's last state before it gives the lock back; that time is shown apart, because the user already has the answer. The billing is not in it: it runs afterwards, as a job of its own.

To see them on the server:

```bash
cd /opt/textcrew && ./dc --profile app exec -T api node --import tsx scripts/dev-user.ts timings --email <your email> --last 10
```

It prints each turn, newest first: what it was (route, engine, wake, outcome), each stage with its time and what it was, how long the user waited for the answer, and a line on the biggest stage. A last line gives the middle answer time of those turns and the stage most often the biggest. Example: "biggest: first output (58% of 9.4 s): the model's first answer: thinking before its first words or tool call".

### A message from web chat

A web message skips the webhook. The web app calls `POST /v1/messages`. The api checks that web chat is on, the 30 a minute limit and the credits. At zero it answers 402. Then it saves the message once and adds the job. The rest is the same. The reply arrives through the live updates.

The web app can name the conversation to write in. Without a name, the message goes into web chat's active conversation. A named conversation that is not active becomes the active one first. The Automations chat is the exception: the message goes into it, and the active conversation stays the one it was. The api answers 404 for a conversation that is not the user's, and 409 for a Telegram conversation. The turn then runs in the message's own conversation, also when the user opens another one before the worker gets to it. The same message sent twice is saved once and does not change which conversation is active.

### What can go wrong

- **The server is full, or the vm-manager cannot be reached.** The job fails and is retried with the usual waits.
- **The connection ends with no result.** The job is retried. If the agent had not yet taken the message, it is delivered again. The container remembers the event id, so the turn does not run twice. If the agent had taken it, the retry stops and the user gets nothing (section 43).
- **The turn runs too long.** The container cuts it off at 15 minutes.
- **The Claude sign-in stopped working.** The account goes back to the standard agent, and the user is told.

## 10. Sending replies

Every outgoing message takes the same path, whoever wrote it: the agent, the cheap model or the platform itself. Example: the agent's answer "Done, I emailed Priya the notes" goes to Rahul's Telegram chat.

### The path

1. The message is saved in `messages` as outgoing, with the status `queued`. It goes into a conversation: the turn's own while a turn runs in that chat, else the chat's active one. A message written during a turn is saved with the turn's id, so the turn's reply can be found afterwards. The web app gets a live update.
2. A `send-message` job is added to outbound at once. Its id holds the message id. Then the conversation's last-message time is noted, for the order of the chat list. A failure there is only written to the log: the message is already on its way, and an error would make the agent send it again.
3. The worker takes the job. If the message is no longer `queued`, it stops: the message was already sent.
4. If the channel is switched off, the message becomes `failed` and the job ends.
5. For a chat app, the worker first makes the text a plain message (see "Plain text for chat apps" below).
6. The worker sends the text through the channel. On success the message becomes `sent`. The channel's own message id is saved with it. Just before a Telegram send it notes the send, so "typing…" pauses in that chat (section 9).
7. On failure the job is retried, 5 tries in total. After the last one the message becomes `failed`.

The agent names the chat to answer in. Without a name, the reply goes to the chat the user last wrote from. An agent can write only to its own user's chats. The check that the chat is the user's and the read of the turn's conversation go to the database at the same time, so the agent's answer waits for one trip there instead of two.

A copy of an automation's answer for Telegram takes the same path. It is marked with the message it copies, and is saved and sent once per message (section 18).

### Per channel

| Channel | How it is sent | Limits |
|---|---|---|
| Telegram | Through the bot, as plain text. Buttons sit under the last part | Split at about 4,096 characters, at a paragraph, line or space |
| Web chat | Nothing is sent. The saved message and the live update are the delivery. The web app shows the formatting | None |
| WhatsApp | As plain text. Free text within 24 hours of the user's last message. Later, an approved template | 4,096 characters, 3 buttons. A template holds about 700 characters |
| iMessage | Through Sendblue, as plain text. No buttons: the text asks for YES or NO | Split at 4,096 characters |

One message from the agent can hold up to 8,000 characters. WhatsApp and iMessage also report receipts. A receipt only moves a status forward: sent, delivered, read.

### Plain text for chat apps

The agent writes its answers in Markdown. Markdown is a way to write formatting with symbols: two stars around a word make it bold, a `#` starts a heading, rows of `|` make a table. The web app turns the symbols into real formatting. A chat app does not. Telegram, WhatsApp and iMessage show a text exactly as it was typed, symbols included. So every text is made plain before it goes to a chat app.

Example: the agent writes `**Done.** See [the notes](https://docs.example.com/notes)`. Rahul's Telegram shows "Done. See the notes (https://docs.example.com/notes)".

1. The agent's instructions ask for plain text in a chat app. Models still write Markdown at times, so the worker does not rely on that.
2. Right before sending, the worker passes the text through one function. This is the same for every chat app and for every writer: the agent, the cheap model and the platform itself.
3. The function changes only what is clearly Markdown. The first table below shows what.
4. Everything else stays exactly as it was. A text with no Markdown is not changed at all, so the platform's own messages go out as written.
5. After that, the channel's own steps run on the plain text: the purchase-link check on Telegram, then the split into parts.
6. Only what is sent changes. The saved message keeps the agent's original text. So the web app shows a Telegram conversation with its formatting.

| The agent wrote | The chat app gets |
|---|---|
| `**bold**`, `*italic*`, `~~struck out~~` | The words, without the symbols |
| `# A heading` | The heading's text, on its own line |
| Code between backticks, or a block of code | The code as written, without the backticks and without the name of the language |
| `[the notes](https://docs.example.com/notes)` | the notes (https://docs.example.com/notes). Only the address, when the text is the address |
| A picture | Its description and its address. No picture is sent |
| `> a quoted line` | The line, without the `>` |
| A line of `---` | Nothing. The line is dropped |
| `* item` or `+ item` | `- item`. Numbered items stay as they are |
| `- [ ] call the bank` and `- [x] call the bank` | `- call the bank` and `- ✓ call the bank` |
| `\*`, a star the agent marked as "not formatting" | `*` |
| A table | One line per row, see the next table |

A chat app has no columns, and a phone screen is narrow. So each row of a table becomes one line, with no `|`.

| The table has | Each row becomes | Example |
|---|---|---|
| Two columns | "first: second". The header row is written the same way and comes first | "Day: Plan", then "Mon: Gym" |
| Three or more columns | Each value after the name of its column, with "; " between them | "Plan: Pro; Price: $20; Credits: 2,000" |
| One column | The text of the cell | "Mon" |

With three or more columns the names are repeated in every line, so a row still makes sense when it wraps on a phone. The sign between the values is "; " and not ", " because a value often holds a comma, as in "2,000".

Some ordinary text looks like Markdown. The function leaves it alone:

- Names with underscores, such as `snake_case_name` or `MAX_RETRIES`.
- Web addresses, whatever symbols they hold.
- Sums, such as "2 * 3 * 4" or "2*3*4".
- File patterns such as `*.ts`, and schedule lines such as `0 9 * * 1`.
- Well-known code names such as `__init__`.
- HTML tags. They are not removed and not changed.

The message is sent as simple text. Telegram can show bold text when a bot asks for it, and the bot does not ask.

### No purchase links on Telegram

Telegram wants digital goods sold inside the app to be paid with its own currency, Stars. Textcrew takes payments on its website only. So the bot never sends a link to a page where something is bought.

1. On Telegram, the "out of credits" reply names the Textcrew web app and has no link. On other channels it ends with the billing page link.
2. As a safety net, the Telegram sender checks every text before it goes out. It replaces each purchase link with the words "the Textcrew web app". This covers the agent's own messages too.
3. A purchase link is any Polar address. It is also a web app address that starts with `/billing`, `/pricing`, `/checkout`, `/upgrade`, `/plans`, `/topup` or `/subscribe`.
4. Other links stay, such as the AI settings page. The saved message keeps the original text.

### What can go wrong

- **The user blocked the bot.** The message becomes `failed` with no retry. The link is marked blocked, and the agent is told to use web chat. The mark is cleared when the user writes again.
- **WhatsApp says the 24 hours are over.** The message is sent again as a template.
- **The job runs twice.** The second run sees the message is not `queued` and sends nothing.
- **The agent used a rare form of Markdown.** A few forms stay as typed, for example bold in the middle of a word. The text can still be read, with a stray symbol in it.
- **Ordinary text that is also Markdown.** A line that starts with "# " is read as a heading and loses the "#". A name written as `__word__` loses its underscores, unless it is a well-known code name. The web app reads both the same way.

## 11. Voice, images and documents

A chat app sends a file as an id, not as the file itself. This section says how the file reaches the agent. From Telegram the worker takes voice notes, audio files, photos and documents. Example: Rahul sends a voice note that says "remind me to call the bank at five".

### From a chat app

1. The webhook holds only the file's id. It is saved with the event.
2. The worker fetches each file before it saves the message. For Telegram, it asks Telegram where the file is, then downloads it. A file may be 25 MB at most (`MEDIA_MAX_BYTES`).
3. The file is written to the server's attachments folder, one folder per user. A row is added to `attachments`.
4. If the file is audio, the worker sends it to the speech-to-text model through LiteLLM. The text is added to the message: "[Voice message] remind me to call the bank at five".
5. The message is saved with its text and its list of files. A caption becomes the message text.
6. A message with a file always goes to the agent as a task. The router is skipped.
7. At delivery, each file gets a signed link that works for one hour. The container downloads the file through it. The link works only inside the server.

### From the web app

1. The web app uploads the file first, with `POST /v1/attachments`. The limit is 10 MB.
2. The api stores it and returns its id.
3. The web app sends the message with that id. The api checks that the file belongs to the user.

Voice is turned into text only for chat app messages. A file from the web app is handed over as it is.

### What can go wrong

- **A download fails, or the file is too large.** A note is added to the text and says which. The message still goes to the agent.
- **Voice to text fails.** A note says so. The audio file is still attached.
- **The job runs again.** A message that was already saved is used again. A file fetched again replaces the same file, so no copies pile up.

## 12. Live updates in the web app

The web app shows new messages and the agent's state without a reload. It keeps one open connection to the api, the event stream. The api pushes small events through it. Example: while the agent works on Rahul's email, the web chat shows "Scout: reading 4 pages".

### How it works

1. The web app opens `GET /v1/stream`. It puts the session token in the address, because a browser cannot add headers to this kind of connection.
2. The api checks the session like any request. Then it sends a `ready` event.
3. When something happens, the worker or the api publishes an event to Redis under the user's id.
4. Each api process listens in Redis. It forwards the event to that user's open connections.
5. After 25 quiet seconds the api sends a `ping`, so the connection stays open.

### When the stream stops getting through

The connection runs from the browser to the web app's host (Vercel), which passes it on to the api. Two things about that path were seen on the server on 16 October:

- **The host cuts every connection after 5 minutes.** The browser opens a new one at once, and the web app asks again for what it shows, because the stream replays nothing it missed.
- **The browser's side can break while the host's side stays open.** At 11:12:26 AM the browser opened a new connection while the old one was still being read from the api, its pings going out every 25 seconds, until the host's 5 minutes were up two minutes later. Everything the api wrote to the old one in those two minutes reached nobody, and the api could not tell.

So the web app checks for itself. A connection with nothing at all for 70 seconds (no event and no ping) is taken to be dead and replaced. And 10 seconds after the agent's answer, a thread that still shows the agent at work asks the api again whether the turn ended (on 16 October at 10:32 AM a turn's last two events never reached the page, and "Tex is working…" stayed under the answer).

The api writes one line to its log when a connection closes: how long it was open, how many events and pings it wrote, the last event and how long before the close it went, how long the connection had been quiet, and how many events were still waiting. A write that waits 5 seconds or more, because nothing downstream reads the connection, is logged as a warning. The lines say nothing of what the events hold. A connection the api wrote to until the end (quiet for less than 25 seconds) that the page still didn't hear from was lost after the api: on the host's side or the browser's.

### The events

| Event | Sent when |
|---|---|
| `message.created` | A message is saved, incoming or outgoing, on any channel |
| `message.status` | A message's status changes |
| `message.draft` | The agent writes its answer in a web chat turn: the whole text so far |
| `approval.created` | The agent asks for permission |
| `approval.resolved` | An approval is answered or runs out |
| `agent.status` | The container is waking, busy or awake |
| `agent.progress` | The agent reports a progress line |
| `credits.updated` | A turn's billing job has run (a moment after the turn), or credits are added or run out |
| `automation.updated` | An automation changes |
| `conversation.updated` | A conversation starts, gets a message, is renamed, or becomes or stops being the active one |
| `conversation.deleted` | A conversation is deleted. The event holds only its id |

A message event holds the whole message, with the id of its conversation. So the web app knows which conversation to show it in. Its text is the text as it was written. A reply that went to Telegram as plain text still has its Markdown here (section 10). A conversation event holds the whole conversation: its title, its kind, its times and if it is the active one.

### Progress lines are live only

- A progress line says what the agent is doing right now. It is cut at 300 characters.
- It goes only to the web app's event stream. It is never sent to Telegram or any other chat app.
- It is not saved as a message. A web app that is not connected at that moment does not see it later.
- One exception: a line that names a crew member, such as Scout, is also written to the activity log. At most 30 are saved per turn.
- A line that cannot be published is dropped. The turn goes on.

### The answer as it is written

In web chat the answer appears a few words at a time while the agent writes it, the way a person types. Before, the web app showed "Tex is working…" and then the whole answer at once. Example: Rahul asks in web chat "what's on my calendar today?". The bubble shows "You have", then "You have two meetings", and so on, and then the finished message takes its place.

1. The worker asks for it in the delivery: `stream_text` is true when the turn's answer goes to web chat, false for every other channel. A turn's own data cannot change it.
2. In the container, the Bridge passes on what the agent writes, about four times a second. Each piece holds the whole text so far, not only the new words. So a piece that gets lost does no harm: the next one has everything.
3. The agent can start over. It writes "Let me check your calendar.", then calls a tool, then writes the answer. When it goes on to a tool, the Bridge sends an empty text, and the web app shows "Tex is working…" with its progress line again.
4. The worker publishes each piece as `message.draft`, with the turn's conversation, the turn's id and the message it answers. Nothing is saved, and nothing goes to Telegram or another chat app. A piece is cut at 16,000 characters.
5. The answer itself arrives as always: the Bridge sends it through the tool server (section 10), and the web app gets `message.created`. The web app puts it in the draft's place.
6. If the turn fails after a draft was shown, the worker first sends an empty draft, then the apology. So the half-written answer goes away before the user is told.

The web app follows four rules:

| Event | What the web app does |
|---|---|
| `message.draft` | Shows the latest text of the turn in its conversation, in place of "Tex is working…". An empty text brings "Tex is working…" back |
| `message.created` from the agent | The message takes the draft's place. A later draft of the same turn is dropped. An approval card does not count: the agent may still be writing after it. What the turn showed before the card folds into the card |
| `agent.status` other than busy, or the incoming message `delivered` or `failed` | The turn is over: the draft goes |
| The stream reconnects | The draft goes. If the turn still runs, its next piece brings the whole text back |

Why the web app has to drop late drafts: the drafts come from the worker, but the answer comes from the api, where the tool server runs. Two senders, so the answer can arrive a moment before the last draft. The drafts and the end of the turn come from the same worker, in order, so no draft comes after the end of its turn.

A slow connection does not fall behind on drafts. Each open stream keeps at most one waiting draft per turn: a newer one takes the older one's place.

### What can go wrong

- **The connection drops.** Events sent in the meantime are not sent again, because Redis does not keep them. Messages, approvals and credits are saved in the database, so normal requests still return them.
- **A draft is lost or the stream reconnects mid-answer.** The next draft has the whole text, so the bubble catches up. If the last ones are lost, the finished answer still arrives as a message.
- **An older container, or an older vm-manager.** It sends no drafts, or drops them. The web chat then shows the answer at the end, as before.
- **The agent writes something it later drops.** The words before a tool call show for a moment and then go. Only the finished answer is saved.

---

# Part B. What the agent can do

## 13. The agent's tools (Platform MCP)

The Platform MCP is the platform's tool server. MCP is a standard way for an AI agent to call tools on a server. This server is the only way an agent inside a container can act on the platform or on the user's apps.

- The tool server is part of the api process. It answers at the path `/mcp`.
- Only containers can reach it. From the public internet, `/mcp` answers "not found".
- It offers the same 15 tools to every container. It keeps nothing between two calls.

### How a container proves who it is

1. The vm-manager creates a user's container. It also creates a token: a long random secret, placed inside that container.
2. The backend gets only a hash of the token. A hash is a one-way fingerprint: nobody can turn it back into the token.
3. The backend saves the hash next to the user id, in the table `sandbox_tokens`.
4. On every call, the container sends its token. The api makes its hash and looks it up. Which user a hash belongs to is kept in Redis for 10 minutes, so the agent's tool calls don't each wait for the database. When the user's container record is removed, that copy goes with it, and the token stops working at once.
5. Found: the call runs as that user. Not found: the call is refused. Found, but an admin suspended the account: the call is refused too (section 31).
6. The user id always comes from this lookup. No tool has an input for a user id. So an agent cannot act as another user, whatever a web page tells it.

### The tools

| Tool | What it does |
|---|---|
| `send_message` | Sends a text to one of the user's own chats |
| `get_profile` | Returns the user's name, time zone, plan, connected apps, and the apps that are not ready yet with what to tell the user |
| `list_app_actions` | Lists the user's apps with their status, and the actions the agent may run in the connected ones |
| `run_app_action` | Runs one app action, for example "send an email" |
| `request_approval` | Asks the user to approve a risky action, with its exact inputs, checked against the action first. Answers "pending" at once |
| `schedule_reminder` | Saves a reminder for one moment in time |
| `create_automation` | Saves an automation: once, repeating, or on an app event. Its answer says where the runs will answer, so the agent can tell the user |
| `list_automations` | Lists the user's reminders and automations |
| `cancel_automation` | Deletes one reminder or automation |
| `web_search` | Searches the web through the platform. Max plan, 1 credit a search |
| `read_page` | Reads one public web page and returns its text and links. Free |
| `remember` | Saves one short fact about the user |
| `recall` | Finds saved facts about the user |
| `forget` | Removes or corrects a saved fact |
| `start_crew_job` | Gives Patch a review or Byte a coding job, with a brief (section 20) |

**Example.** Rahul texts "email Priya the notes". The agent finds Gmail's send action with `list_app_actions`. It asks for a yes with `request_approval`. After the yes it calls `run_app_action`. The reply "Sent" leaves the container through `send_message`.

### The activity log and the rate limits

- The activity log is the record of what the agent did. The user sees it in the web app. It is the table `audit_log`.
- Every tool call that succeeds adds one entry: the tool's name, a one-line summary, the inputs and the credits charged.
- An input whose name looks like a secret (key, token, password) is blanked. `read_page` keeps the address without the part after the question mark. The memory tools never keep a memory's text.
- A failed call adds no entry. Three refusals are still logged: a refused search, a refused page and a refused memory.
- The log is kept for as long as the account exists. Deleting the account removes it, inputs and all. The one row that stays is an admin's record that they deleted the account (section 31).
- A rate limit is a cap on calls in a period. Per user: 240 calls a minute to `/mcp`, 20 searches a minute, 30 pages a minute, 60 memory changes an hour.

### What can go wrong

- **Unknown token.** The call is refused. Nothing runs.
- **A tool refuses** (wrong input, plan, limit). The agent gets a plain message it can read. The turn goes on.
- **A tool breaks inside.** The agent sees only "Internal error". The details go to the server log.

## 14. Apps through Composio

Composio is an outside service. It keeps the user's sign-ins to apps such as Gmail and GitHub, and it runs actions in those apps.

### The app catalog and the plan limits

- The catalog is a fixed list of 25 apps in the code. Pro and Max may connect all 25.
- Free may connect 10 of them: Gmail, Google Calendar, Drive, Docs, Sheets, Notion, Todoist, Slack, GitHub and Exa Search.
- For each app the catalog also says whose sign-in page comes next (`provider`, for example Google for Gmail) and, in one sentence, what the agent can do with it (`description`). The web app's connect screen shows both.
- An app also needs a Composio setup ("auth config") before it can be connected. The api looks for one in this order:
  0. for a user named in `COMPOSIO_TRIAL_USERS` only: the setting `COMPOSIO_TRIAL_AUTH_CONFIGS`, which names a second setup per app. It is for trying our own sign-in app at a provider with a few people, while the provider reviews it (below);
  1. the setting `COMPOSIO_AUTH_CONFIGS`, which names a setup per app. Our own sign-in app at a provider goes here;
  2. the table `composio_auth_configs`, which keeps the setups the server made itself;
  3. the setting `COMPOSIO_MANAGED_APPS`. It names the apps the server may set up by itself, or says `all`. Then the server makes the setup on the first connect, with Composio's shared sign-in, and keeps its id in the table. If the Composio project already has an enabled shared setup for that app, the server uses that one instead of making another.
- With none of the three, the api answers that the app is not configured yet.
- When the server reuses a shared setup already in the Composio project, it takes only one that Composio says is for that same app.
- Exa Search signs in with an API key, not with a sign-in page, so the server never sets it up by itself.
- The app list says for each app if it can be connected on this server, by this user. The field is called `connectable`. It is true when one of the ways above gives a setup, or would. The web app shows an app that cannot be connected as "Not available yet", with no Connect button. The test server has setups named for Gmail and GitHub, and since 13 October `COMPOSIO_MANAGED_APPS` is `all`: the server made Google Calendar's setup itself.

### Trying our own sign-in app with a few users

A provider such as Google reviews our own sign-in app before everyone may use it. Until then, at most 100 people can ever allow it, and each sees a warning first. So it is tried with a few people, with two settings:

- `COMPOSIO_TRIAL_AUTH_CONFIGS` names a second setup per app, for example `{"googlecalendar":"ac_…"}`.
- `COMPOSIO_TRIAL_USERS` names who gets it: user ids, or email addresses, separated by commas. An email counts only once it is verified, so nobody gets in by signing up with someone else's address.
- For those users the trial setup comes before every other setup of that app. Plan limits still come first. Everyone else gets the app's usual setup.
- Both settings are checked when the api and the worker start. A damaged value stops the start and says what is wrong. (A damaged `COMPOSIO_AUTH_CONFIGS` instead quietly turns every app off.)

### How a user connects an app

1. The user presses Connect in the web app. The web app first shows its own connect screen: the app, what Tex can do with it, the rules for every app, and "Continue to Google" (or the app's own provider). Cancel there changes nothing.
2. On Continue the web app calls `POST /v1/apps/{appSlug}/connect`, with the page to come back to.
3. The api checks the plan. A Free user who picks a paid app gets a "plan limit" error. The plan is checked before any setup is made.
4. The api finds the app's setup, or makes it (see above).
5. The api asks Composio which kind of setup it is, once per setup, and remembers the answer while it runs:
   - **Our own sign-in app** (Composio calls it a custom auth config, with OAuth). The api asks Composio for a link that goes straight to the provider's own page. Composio's word for this is `initiate()` with "long redirect URL". The user sees no Composio page and no Composio address on the way out.
   - **Composio's shared sign-in**, or a setup that asks for an API key. The api asks for a Composio Connect Link. Composio's page comes first, then the provider's. Composio no longer allows the first way for its shared sign-in, since 3 July 2026.
   - If Composio cannot say which kind it is, or the direct link fails, the api uses a Connect Link. It works for every kind.
6. The api gives Composio our own user id and the page to come back to. That page must be on our web app's own address. Anything else, also an address that only starts the same way, is replaced by the Apps tab of the Integrations page (`/integrations/apps`). The web app sends its old `/apps` address there too.
7. The api saves the connection as `pending` in the table `connections`, and returns the link.
8. The user signs in on the provider's page and allows access. The platform never sees the password. Composio sends the browser back to the web app and adds `status=success` or `status=failed` to the address. The web app says "Gmail is connected" or "Gmail didn't connect". That message comes from Composio's address only: our own record may still say `pending` for a few seconds, until the platform has checked (next part).
9. A user may connect a second account of the same app ("Add account"). Connecting the same account again replaces the older connection (below).

**The way back through our own address.** With our own sign-in app, the provider sends the browser back to Composio's address after the user allows access. To keep our own address there too, the sign-in app's redirect address can be `https://api.textcrew.in/oauth/callback`. The api answers that address with a redirect to Composio's own, with the same query. It saves nothing, adds no job and never writes the query to a log, because it holds a one-time code. `docs/composio.md`, section 9, has the steps.

### How the platform checks that the connection became active

A connection becomes `active`, `expired` or `error` in one of four ways. The first one to happen wins.

- **Composio's webhook.** A webhook is a message a service sends to our server when something happens. Composio sends one when the status changes. The only one Composio documents is "expired".
- **The app list.** When the web app lists the apps and a connection is still pending, the api asks Composio. With nothing pending it does not ask. So a connection that expires later is learned from Composio's webhook only.
- **The agent's own look.** When the agent calls `get_profile` or `list_app_actions`, or runs an action of an app that is not active, the api asks Composio about the pending connections first. So an app that just finished connecting can be used in the same turn.
- **The check job.** The worker asks Composio by itself. The first check runs 15 seconds after the link is made. The next ones come 30 seconds, then 1, 2, 4 and 8 minutes later.
- That is six checks in about 16 minutes. They stop as soon as the connection is no longer pending. After the last one, the other ways can still finish it.

Each way asks Composio about each pending connection by its own account id, the ten newest at most. It used to read the user's whole list of accounts at Composio. Composio gives that list in pages, so for a user with many accounts the new one could be on a later page, and it stayed pending for good.

Each connection keeps the time the platform last heard from Composio about it: a check that got an answer, Composio's webhook, or an admin's recheck. Only admins see it. An admin can also ask Composio again about any connection, whatever its state, and disconnect one for the user (section 31).

### Connecting the same account again

A user connects an app again with the same account: to move to our own sign-in app, or after the connection expired (Reconnect). The older connection must then go, and what was made on it must follow.

1. Whenever a connection becomes active, in any of the four ways above, the api or the worker adds a job named `settle-connection` to the system queue. One job per connection.
2. The job looks for the user's older connections of the same app to the same account. "The same account" means the same account label: the email Composio gives for the account, in any letter case. A label we don't have yet is asked of Composio and kept.
3. For each one, the user's app-event automations of that app move to the new connection. The automations module makes a new trigger on the new connection, points the automation at it, then removes the old trigger. Which automations watch the old connection is asked of Composio.
4. Then the old connection is removed at Composio, and in our table.

It never removes a connection to another account of the app ("Add account"), nor any connection when neither side has a label: it could be a second account. A newer connection, one still being set up, and another app's are left alone too.

It is safe to run twice. A second run finds nothing to do. A run that stopped after making a new trigger but before saving it leaves that trigger on the new connection; the next run uses it instead of making another. An old account that Composio no longer has counts as removed. Runs for the same user wait for each other, with a short lock of their own.

**Example.** Rahul's Gmail is on Composio's shared sign-in, with "when my boss emails me, tell me". He connects Gmail again through our own sign-in app. A few seconds later Integrations → Apps shows one Gmail connection, the new one, and the automation watches the new one.

### How the agent finds and runs an action

1. The agent calls `list_app_actions`. It can filter by app or by a search word.
2. The answer has two parts. `apps` gives every app the user has a connection for, with its status:
   - **connected**: active and on the user's plan. Its actions are listed.
   - **connecting**: a sign-in started less than 20 minutes ago and not finished. The note says "Google Calendar is still connecting", and asks the agent to tell the user it may still be finishing.
   - **not finished**: a sign-in started longer ago and never finished. The note asks the agent to tell the user to connect it again on the Integrations page.
   - **needs reconnecting**: the connection expired or failed. Same advice.
   - **not on plan**: connected, but the app is not on the user's plan any more.
   An active connection of an app wins over any other of the same app. Of two active connections of one app, the agent uses the newest; new automations and the git gateway use the same one. The notes carry the address of the Integrations page's Apps tab (`/integrations/apps`), so the agent sends the user there and nowhere else. Until 15 October 2026 they said "the Apps page" and `/apps`.
3. `actions` lists the actions of the connected apps, at most 100. The api asks Composio once per app. It used to ask once for all of them, with one limit of 200 tools in all. GitHub alone has more than 200, so it left no room for the next app. That is the most likely reason why, on 13 October, the agent saw only GitHub after the founder connected Google Calendar (not confirmed on the server). Now the 100 places are shared fairly: an app with few actions gets them all, and the rest goes to the big ones. An app that is cut short gets a note: "Showing 97 of its 200 actions", and to ask again with that app and a search word. An app's actions are the same for every user, so the api keeps each app's listing for 10 minutes and serves every call from it, for every user. Before, every call asked Composio again for every connected app, and the lead calls `list_app_actions` on many turns. A listing that failed is not kept.
4. Each action carries two marks: whether it needs approval, and whether it costs a credit.
5. The agent calls `run_app_action` with the action's name and its inputs. For an app that is not ready, the answer is the same note as above, for example "Google Calendar is still connecting".
6. The api checks the app, the credits and the approval (next section).
7. The api calls Composio with the user id from the container token. The result goes back to the agent.

**Example.** Rahul texts "what is on my calendar tomorrow". The agent runs a Google Calendar list action. It only reads, so it needs no approval and costs nothing.

### The cost, and where the keys stay

- An action that changes something costs 1 credit when it succeeds. Reading is free. A failed action costs nothing.
- At zero credits, a changing action is refused before it reaches Composio. Reading still works.
- The platform decides by the words in the action's name. CREATE or SEND means a change. GET or LIST means reading. An action it cannot place counts as a change.
- **Composio's keys stay on the server.** The Composio key is a setting of the api and the worker only. No container gets it.
- The app sign-ins are kept by Composio. Our `connections` table holds only Composio's account id, the status and a label.

### What can go wrong

- **The app is not connected or not on the plan.** The tool says so. Nothing runs.
- **Composio or the app is down.** The agent is told to try later. Nothing is charged.
- **Composio is down while a user connects, or will not make a setup** (for example, the Composio key may not make setups). The api answers 503: "Gmail can't be connected right now". Nothing is saved, and the next try asks again.
- **Composio cannot remove a connected account.** On Disconnect, by the user or an admin, the failure is only written to the server log, and our row is deleted anyway. The account then stays at Composio, with the app's sign-in, and nothing tries again. On account deletion it is different: the row stays and the deletion job fails, so it tries again (section 33).
- **Two users connect a new app at the same moment.** Each may make a setup at Composio. The first one saved is used by everyone. The other stays unused at Composio, with no connections on it.
- **Two connections of the same app stay after connecting again.** Composio gave no email for the account, so the server can't tell it from a second account. The agent uses the newer one; the user can remove the old one with Disconnect.
- **A trial setting is damaged.** The api and the worker don't start after the restart, and the log says which value is wrong.
- **Which permissions does an app's sign-in ask for?** Our server sets none; each app uses Composio's default set, which Composio does not publish. The dev-user script's `scopes` command prints it: the setup's own scopes, the ones Composio's sign-in always asks for, Composio's narrowest and smallest sets for the app's actions, and for a Google app each scope's class at Google (basic, non-sensitive, sensitive or restricted). It only reads, and of a setup it reads the scopes only, never the client id or secret beside them. `docs/composio.md`, section 9.
- **The user says an app is connected, but the agent can't see it.** The agent says it may still be finishing, or that it needs connecting again on the Integrations page. To see why, run the dev-user script's `apps` command on the server (`docs/composio.md`, section 11). It prints each connection with our status, its Composio account id, what Composio says about it, the setup it was made with, and what the agent sees.

## 15. Approvals

An approval is the user's yes before the agent does something that other people will see or that cannot be undone.

### Which actions need a yes first

| Kind of action | Words that mark it |
|---|---|
| Sending to others | SEND, REPLY, FORWARD, POST, PUBLISH, TWEET, SHARE, INVITE |
| Deleting | DELETE, REMOVE, TRASH, ARCHIVE |
| Paying | PAY, PAYMENT, TRANSFER, CHARGE, REFUND |
| Changing what exists | UPDATE, MOVE, MERGE, CLOSE, CANCEL, ACCEPT, DECLINE |
| Putting an event in a calendar | CREATE_EVENT (other people may be invited) |
| GitHub comments and reviews | COMMENT or REVIEW, in a GitHub action that writes |

The platform decides by these words in the action's name. There are two exceptions. Pull-request review is one (section 19). A crew job whose brief says "post it on the pull request" is the other (section 20).

### The life of an approval

1. The agent calls `request_approval` with a short summary, the action's name and its exact inputs. The tool asks for the summary as what the agent will do, starting with the verb: "Send the notes to priya@example.com".
2. For an app's action, the api first checks the inputs against the action's own list of inputs, which Composio gives (next part). Inputs that don't fit are refused at once, and the user sees nothing.
3. The api saves it in the table `approvals` as `pending`, with its inputs. It expires after 24 hours.
4. The api sends Tex's question to the chat the request came from. It is made from the summary, so it is there at once and costs nothing: no model is asked. "I'd like to " goes before the summary, its first word in small letters, and the way to answer goes after it: "I'd like to send the notes to priya@example.com. Approve or Deny below." In web chat the message carries the approval, and the web app shows the Approve and Deny card right under it, with the inputs under the action's own names. Telegram and WhatsApp show two buttons, Approve and Deny. iMessage has no buttons, so the line "Reply YES to approve or NO to deny." is added instead of "Approve or Deny below.". A summary that does not start with a common verb ("send", "delete", "pay", "create" and about 50 more) is kept as written: "I'd like your OK for this: ...".
5. The tool answers "pending" at once, with the question the user now sees. It tells the agent to end its turn and not to repeat the question or say it is waiting: the user already sees both. The agent never waits inside a turn. In the web app the turn has paused: the "working" sign stops and a line under the card says "Waiting for your OK".
6. The user taps a button, types "yes" or "no", or decides in the web app. A typed answer goes to the newest waiting approval in that chat.
7. The api records the answer in the activity log ("Approved: ..." or "Denied: ..."). A job then wakes the agent with a new message: "The user APPROVED ..." or "The user REJECTED ... Don't do it. Tell them in one short sentence that you won't." It goes to the conversation the approval was asked in, not to the one that is open now. In the web app Tex shows as working again from the tap until it answers.
8. After a yes, the agent calls `run_app_action` with the action's name and the approval's id. The inputs saved with the approval run; the agent does not send them again. The agent says how it went.

**Example.** Rahul texts "email Priya the notes". He gets "I'd like to send the notes to priya@example.com. Approve or Deny below.", with the two buttons. He taps Approve. The agent wakes up, sends the email and says so. 1 credit is charged.

### The inputs are checked when the agent asks

The user should only ever approve something that can run exactly as they saw it. So when the agent asks about an app's action, the api compares the inputs with the action's list of inputs. Composio describes each action: the name of each input, what kind of value it takes (text, a number, a yes or no, a list), and which ones must be given. A request is refused when:

- an input has a name the action does not have;
- an input the action marks as required is missing;
- a value is of the wrong kind, for example one address where the action wants a list.

An empty value is left to the app. The refusal goes back to the agent with the action's real inputs, so it can ask again at once, correctly. The user sees nothing until then.

Where the list comes from: the app's list of actions, which the api keeps for 10 minutes. That list holds at most 200 actions, and GitHub has more, so an action that isn't on it is asked of Composio by its name, and kept for 10 minutes too. An action Composio doesn't have is refused. When Composio can't be asked, the request is refused with "try again in a moment", rather than letting an unchecked one through. An action whose list of inputs Composio left empty is not checked.

The approval always holds the inputs that will run. If the agent asked about an app's action without any inputs, the approval holds none, and the action runs with none.

A request that is not about an app's action (no action, or one that is no app's) is saved as it was asked, without a check. A crew job's request has its own exact check (section 20).

**Example.** On 15 October Tex asked to approve sending an email with an input called `to`. Gmail's send action has no `to`: the address goes in `recipient_email`. Rahul approved, and Composio refused the email. Tex then tried `recipient_email`, which our check refused because it was not what Rahul had approved, so Tex asked a second time. Now the first request is refused before Rahul sees it, with Gmail's real inputs, and Tex asks once, correctly.

### Single use and exact match

`run_app_action` runs a risky action only when all of this is true:

- the approval belongs to this user and names the same action;
- it is approved, and the yes is less than 24 hours old;
- it has not been used before;
- the inputs are the ones saved with the approval. The saved inputs are what runs. If the agent sends inputs too, they must be exactly the saved ones.

"Used" is marked in the same step as the check. So two calls at the same moment cannot both use one approval. An approval saved before 15 October without inputs still compares only the action's name; those are all gone after 24 hours.

### Asking again: "replaced"

Sometimes the app refuses an approved action, for example because a value it needs is wrong. Nothing has happened then, and the approval stays usable for one more try, in case the problem passes. The agent is told so. It is also told how to ask again when the inputs must change: with `request_approval`, the corrected inputs and `replaces_approval_id`, the id of the earlier request.

The earlier request then becomes `replaced`, if it is still waiting, or approved and not used:

- it can no longer run, and it can no longer be answered;
- the web app shows "Replaced by a newer request" under its card, not "You denied this": the user did not say no;
- a late tap on its Telegram button gets "That request was replaced by a newer one. Please answer the newest request.";
- the activity log gets "Asked again with corrected details: ...", from the agent.

The agent must name an earlier request of the same user for the same action; anything else is refused. A request that was already denied, expired or used is left as it is, and the new one is asked anyway. The agent is told to say in plain words why it asks again: the first request could not run as approved, so nothing was done yet.

### What can go wrong

- **Denied.** The agent is woken, told not to do it and to say so in one sentence. That approval can never run an action. (Its state in the API is still called `rejected`.)
- **The agent writes after asking anyway.** Its text arrives as a message after the question. Nothing breaks; the user reads the same thing twice.
- **Never answered.** After 24 hours an hourly job marks it `expired`. The agent is not woken. Nothing runs.
- **A late tap on an old button.** The user gets "That approval was already answered or has expired.", or for a replaced one "That request was replaced by a newer one. Please answer the newest request."
- **A risky action with no approval.** Refused. The message tells the agent to use the approval's id if the user already said yes, and otherwise to ask first.
- **The agent changes the email after the yes.** Refused, because the inputs differ. The approval still works: with no inputs sent, the approved ones run.
- **The agent asks with inputs the action doesn't have.** Refused before the user sees anything, with the action's real inputs (above).
- **The app refuses the approved action.** Nothing happens and nothing is charged. The agent may try once more, or ask again with the corrected inputs; the earlier request is then replaced (above).
- **The account is deleted.** Every approval of the user goes, in any state, with the inputs saved with it. A job that still holds one of their ids finds nothing and does nothing.

## 16. The user's own MCP servers

A user on the Max plan can add tool servers of their own. The agent then has those tools next to the platform's tools.

### What the user gives

- Four things: a name, the server's address, an optional header name and an optional secret.
- The address must start with `https` and use a public host name. The header name is `Authorization` if left empty.
- Refused: an IP address (a number in place of a name), `localhost` and a name with no dot. Also names ending in `.local` or `.internal`, the platform's own service names, and an address with a password in it.
- Adding a server needs the Max plan. On Free and Pro the api answers with a "plan limit" error. A server can be switched off or deleted.

### How secrets are stored

- The secret is encrypted before it is saved in the table `user_mcp_servers`. Encrypted means scrambled with a key that only the server holds.
- The api never returns the secret. It only says whether one is set. The secret is decrypted only when it is sent to that user's container.

### How the container is allowed to reach that server

A container has no direct internet. All its traffic passes the egress proxy, the one guarded way out. Every container may reach the model gateway, the platform's tool server and the git gateway. A user's own server is not on that list until it is added.

1. The user adds, switches or deletes a server in the web app.
2. The api saves the change and queues a job named `sync-allowlist`.
3. The worker builds the full list again from the database: the user's enabled servers and their host names.
4. The worker sends the host names and the servers, with their secrets, to the vm-manager.
5. The vm-manager writes a rule for the egress proxy. The rule lets that one container reach those host names. This list is the allowlist.
6. The proxy reloads. For an awake container the rule applies at once. The agent uses the new server list from its next wake.

**Example.** Rahul is on Max. He adds his company's tool server at `https://tools.acme.com/mcp` with a key. After the job runs, his container may reach `tools.acme.com`. No other user's container may.

### What can go wrong

- **The address is not allowed.** The api refuses it with a plain message. Nothing is saved.
- **The vm-manager cannot be reached.** The job fails and is tried again.

## 17. Git through the git gateway

The git gateway lets the agent use normal git on the user's GitHub repositories. The user's GitHub access never enters the container.

### Why no GitHub token enters a container

- A container runs code and reads text written by other people. A secret inside it could be misused.
- A GitHub token can push anywhere and delete branches. With the gateway, the platform decides what a push may do.

### How it works, and how it knows the user

1. Inside the container, git is set up to send every `github.com` address to the gateway, at `/git` on the api.
2. Git adds the container token to each request. The agent runs a normal clone and needs no password.
3. The api turns the container token into the user id, exactly as the tool server does. An unknown token is refused, and so is the token of a suspended account.
4. The api takes that user's GitHub access from their GitHub connection at Composio. It is never logged and never saved.
5. The api passes the request on to GitHub and streams the answer back.

### What the gateway allows and refuses

| Request | Result |
|---|---|
| Clone or fetch | Allowed |
| Push to a branch | Allowed |
| Push to the default branch | Refused |
| Delete a branch | Refused |
| Push or delete a tag | Refused |

- The default branch is the main line of the code, often named `main`. The api asks GitHub which branch it is. If GitHub cannot be asked, the push is refused.
- A change reaches the default branch only through a pull request: a proposed change that waits for review. Merging one needs the user's approval.
- Every clone, fetch and push is written to the activity log. The limit is 300 requests a minute per user.

**Example.** Rahul texts "fix the typo in the README of acme/website". Byte clones the repository, makes the branch `fix-typo`, pushes it and opens a pull request. A push to `main` would come back with "Pushing to the default branch (main) is not allowed."

### What can go wrong

- **GitHub is not connected.** Git prints "GitHub is not connected. Ask the user to connect GitHub first."
- **Composio does not hand over the GitHub access.** Git prints a refusal. It says to use the GitHub app actions instead.
- **The account cannot see the repository, or GitHub is down.** Git prints the reason. Nothing was changed.

## 18. Reminders and automations

An automation is a saved instruction that the agent runs later, without the user texting. A reminder is the simplest automation.

### The three kinds

| Kind | Example | What starts it |
|---|---|---|
| Once | "Remind me Friday at 10 to call the bank" | A timer for that moment |
| Repeating | "Every Monday at 9, send me this week's meetings" | A schedule in the user's time zone |
| On an app event | "When my boss emails me, tell me on Telegram" | Composio watches the app and calls our server |

### Creating one

1. The user asks in chat. The agent calls `schedule_reminder` with a text and a time. For the other kinds it calls `create_automation`.
2. The api checks the request (the list below) and saves it in the table `automations`. The database is the source of truth.
3. It also saves the chat the request was made in, web chat or a Telegram chat. That decides only where a copy of each answer goes (below). The answers themselves always go to the Automations chat. If the user has no Automations chat yet, it is started now, so the web app can show where the results will be.
4. The api sets the timer. For an app event, Composio starts a watch on the app, called a trigger. It watches the connection the agent uses for that app, the newest. When the user connects the same account again, the trigger moves to the new connection (section 14, "Connecting the same account again"). The agent then confirms to the user. The tool's answer tells the agent where the runs will answer, so it can say so.

- **The plan limit.** Free 1, Pro 5, Max 50. Reminders count, and paused automations count. A finished one-time reminder does not.
- **The 15-minute minimum.** For a schedule, the next 50 runs must each be at least 15 minutes apart.
- **The time zone.** It must be a real one. If none is given, the user's own is used. "Every Monday at 9" means 9 where the user lives.
- **Other checks.** A one-time moment must not be in the past. An app event needs that app to be connected.

**Where the user's own time zone comes from.** Every account starts on UTC. While nobody has set a time zone, the web app sets the one the browser is in, once: on the first page of the app or of the setup steps. After that the account says the time zone was set (`timezoneSet` in `GET /v1/me`), and the web app never changes it again. So a time zone the user chose in Settings is never replaced, also when they open the app in another country. The database update that added this marks every account whose time zone is not UTC as set. An account still on UTC gets the browser's time zone the next time its user opens the web app. A user who chose UTC in Settings before that cannot be told apart, and gets the browser's time zone once too.

Example: Priya in Bengaluru signs up. Her account starts on UTC. The setup page sets it to Asia/Kolkata. "Every morning at 9" then runs at 9 in India, not at 2:30 PM.

The user's container keeps the time zone it was made with, which is usually UTC: it is made at sign-up, before the web app sets one. The agent reads the user's time zone with `get_profile`, and an automation uses the account's time zone, not the container's.

### What happens when one fires

1. The timer fires. For an app event, Composio's webhook arrives and is verified.
2. The worker checks that the automation still exists and is on. For an app event, it also checks the owner.
3. It puts a job in the same queue as the user's messages. So messages and automations run one at a time, in order.
4. The agent gets a normal turn. A turn is one run of the agent, from input to answer.
5. The input is the automation's title and instruction. For an app event, the event's data is added. A timer run that starts late gets a line about that first (below).
6. The agent answers in the user's Automations chat (the next part). When the automation was made in a Telegram chat, a copy of the answer also goes there. A one-time automation is then marked finished.

**Example.** Rahul texts on Telegram "every Monday at 9, send me this week's meetings". Each Monday at 9 his time, the agent wakes, reads his calendar and posts the list in his Automations chat, and his Telegram gets a copy.

**The cost.** The automation itself has no price. Each run is a normal turn and costs what a turn costs. That is the AI when Textcrew AI is used, and the time the container is awake. An app action that changes something costs 1 credit. A risky action still needs the user's approval.

### Which conversation a run answers in: the Automations chat

Every run of every automation answers in one place, the user's Automations chat. It does not matter where the automation was made: in web chat, on Telegram, or from the web app (pull-request review). Automation results never mix into the user's own conversations.

| The Automations chat | What it is |
|---|---|
| One per user | A conversation of its own kind, in web chat, called "Automations" |
| When it starts | When the user makes an automation and has none yet, or else at the next run |
| Its number | Web chat's next number, like a new chat. So the agent keeps a context of its own for it: each run sees the runs before it |
| Never the active one | A run never makes it active. The user's next message goes where it went before |
| Writing in it | The user can open it in the web app and write there. The agent answers there, with the runs in mind. Writing there does not make it active either |
| Its name | It keeps it. A rename is refused |
| Deleting it | Not possible. The api answers 409, and the web app offers no Delete for it. It goes only when the account is deleted, with everything else. The yearly clean-up of old, empty conversations leaves it too |
| If it is missing all the same | A safety net: the next run starts a new one, with a number never used before, so the agent starts afresh there. It never falls back to the conversation the user has open |

What answers there:

- Timer runs, once and repeating.
- App-event runs.
- Pull-request review verdicts (section 19).
- The notices: "out of credits" when a run is due at zero credits, and "paused after 3 failures in a row".

The web app shows it pinned at the top of the chat list, apart from the dated list, with a mark when a new run arrived since the user last opened it.

**A copy on Telegram.** An automation made in a Telegram chat still runs in the Automations chat. A copy of its answer also goes to that Telegram chat:

1. After the run, the worker finds the run's reply: the last message saved with the run's id that is not an approval's question. That is the agent's answer, or what the platform said instead (out of credits, the run failed).
2. The copy is plain text, like everything sent to Telegram (section 10). Its first line names the automation, with ⏰ for a timer and ⚡ for an app event: "⏰ Daily open PRs and issues". Its last line says "To follow up, open the Automations chat in the Textcrew web app", with the address that opens it. While web chat is switched off, that line is left out.
3. The copy is saved in the Telegram chat's current conversation, so the web app shows it there too. It is marked as a copy of the message in the Automations chat.
4. A copy is never part of the Telegram conversation's context. The router does not see it, and the recap a new engine gets leaves it out. The engine itself never had it: it only knows the turns it ran. So a later Telegram message is answered without the run in mind; the follow-up belongs in the Automations chat.
5. Once per message: a message can be copied once. A job that runs again after the copy was made sends nothing more.
6. No copy goes to a chat that is no longer linked to the user, that blocked the bot, or whose channel is switched off.

The notice "paused after 3 failures" is copied the same way. What the agent says after the user answers an approval that a run asked for stays in the Automations chat only: the user answered in the web app, where the follow-up is.

Starting the Automations chat is safe to repeat: two runs at the same moment start one between them.

**Example.** Rahul asks on Telegram "every morning at 9, list my open pull requests and issues". Each morning at 9 the list appears in his Automations chat. His Telegram gets "⏰ Daily open PRs and issues", the list, and "To follow up, open the Automations chat in the Textcrew web app". At lunch he opens the web app and asks in the Automations chat "which one is oldest?". The agent has the list in mind. Meanwhile his Telegram chat with Tex is untouched: if he writes "hi" there, the agent answers without the list.

**Before this change.** Until 13 October a run in web chat answered in the conversation the automation was made in, or else in a conversation named after it, and a Telegram run answered in the chat's current conversation. Those conversations stay as they are, as ordinary chats. The column that remembered them is no longer used.

### A run that starts late

A timer run can start late. The worker may have been stopped when it was due, for an update or after a crash. The user's own turns may also have kept it waiting.

- **It still runs.** A late run is never skipped. When the worker starts again, a run that came due meanwhile runs then. A repeating automation that missed several slots runs once, then goes on with its next slot.
- **It says so.** If it starts more than 10 minutes after it was due, the agent is told when it was due, in the automation's time zone, and how late it is. It is asked to say so at the start of its reply. Up to 10 minutes late, nothing is said.
- **When it was due.** For a one-time reminder, its own moment. For a repeating one, the slot the timer was set for.
- **App events are never late.** They have no due time.

Example: the server is off from 8:50 to 9:31 on Tuesday. Rahul's 9:00 summary runs at 9:31. The agent starts its reply by saying that it is 31 minutes late and was due at 9:00 AM.

The worker's start used to drop such a run at times. On start the worker sets every automation's timer again, and for a repeating one that replaced the missed run with the next one. Now a timer that is already set with the same schedule is left as it is.

### Auto-pause and recovery

- **Zero credits.** All the user's automations are paused. When credits are added, these are switched on again by themselves.
- **Three failures in a row.** That automation is paused. The user is told in chat and can resume it in the web app. A paused automation has no timer, and app events for it are ignored.
- **An admin suspends the account.** Every automation that is on, or paused for lack of credits, is paused with the reason "suspended". When the suspension is lifted they come back, or wait for credits if the balance is zero. A run that fires during a suspension does nothing and is paused the same way (section 31).
- **Paused by Textcrew support.** An admin can pause any automation (section 31). Its paused reason is then `admin`, so the web app can say who paused it. Adding credits does not switch it on again. The user can resume it, or an admin can.
- **After a restart.** The timers live in the job queue, which can lose its data. So every time the worker starts, it sets the timer of every enabled automation again. A timer that is still there is left as it is, so a run that came due while the worker was stopped is not lost. It runs late and says so (above).
- **The job queue lost its jobs.** A run whose job was lost is put back from the saved event. It still knows its automation and when it was due.

### What can go wrong

- **The plan limit is reached.** The tool says how many the plan allows. Nothing is saved.
- **No credits when it fires.** No turn runs. The user gets the out-of-credits message in the Automations chat, with a copy on Telegram when the automation was made there, and the automation is paused. The copy names the web app instead of the purchase link (section 10).
- **The user tries to delete the Automations chat.** The api answers 409 and nothing changes. The web app does not offer it.
- **The automation is deleted while it runs.** The run stops before the agent gets it. The job is tried again, finds no automation and ends.

## 19. Pull-request review

The user can switch on automatic code review for chosen GitHub repositories. When a pull request opens or changes, the crew member Patch reviews it and posts one review on GitHub. The user gets a short verdict in the Automations chat.

### Turning it on per repo

1. The user switches it on for one repository in the web app. The web app calls `PUT /v1/pr-reviews/{owner}/{repo}`.
2. The api checks that GitHub is connected and that the plan has a free automation.
3. The api asks Composio to watch that repository. Composio puts a webhook on it, so the GitHub account needs admin access there.
4. The api saves an app-event automation with the mark `pr_review`. It shows in the automations list.
5. The verdict always goes to the Automations chat (section 18). If the user has a linked Telegram chat now, a copy of each verdict goes there too.

Only the user can switch it on, from the web app. No agent tool can set this mark. Switching it off deletes the automation and Composio's watch.

### When a pull request opens or gets new commits

1. GitHub tells Composio. Composio calls our webhook. The api verifies it, saves the event and queues a job.
2. The worker finds the automation and checks its owner. Only three events count: opened, reopened, new commits.
3. The worker asks GitHub for the pull request's head commit, which is its newest commit. A closed pull request is ignored.
4. The worker saves a row in the table `pr_reviews` for this commit. If the row is already there, it stops. Otherwise the agent gets a turn with the review instruction.
5. Patch clones the code through the git gateway. It looks for bugs, security problems and missing or failing tests.
6. Patch posts one review on the pull request, with all its comments in it. That costs 1 credit.
7. The lead sends the user a short verdict. The row is marked done or failed.

- **One review per commit.** The row is unique per user, repository, pull request number and head commit. A webhook that arrives twice, or a reopen with no new commits, gives no second review. Two quick pushes give one review, of the newer commit.
- A failed review is not repeated for that commit, because it may already have posted. A new commit gets a new review.

**Example.** Rahul turns review on for `acme/website`. A teammate opens pull request 42. His Automations chat gets "PR 42: one bug in the date check, tests pass. Fix first.", and his Telegram a copy headed "⚡ Review pull requests in acme/website". He answers "fix it" in the Automations chat, and Byte pushes a fix to a branch.

### The standing permission

A GitHub comment is read by other people, so it normally needs a yes each time. Turning review on is a standing yes for one thing only. That thing is a new review or comment on a pull request in that repository. It applies when all of this is true:

- review is on, and not paused, for exactly that owner and repository;
- the inputs name that repository and a pull request number;
- the action is one of these four, by exact name.

| Action | Note |
|---|---|
| `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST` | The one the instruction asks for |
| `GITHUB_SUBMIT_A_REVIEW_FOR_A_PULL_REQUEST` | Submits a review |
| `GITHUB_CREATE_A_REVIEW_COMMENT_FOR_A_PULL_REQUEST` | A new comment on a line. Not a reply |
| `GITHUB_CREATE_AN_ISSUE_COMMENT` | Only on a pull request the platform asked a review for |

- A review must be of the type "comment", or have no type. Approving and requesting changes are never covered. On GitHub an approval can set off an automatic merge.
- Also never covered: merging, closing, replying, editing or deleting a comment, or a comment in another repository.
- A covered action still costs 1 credit and is still in the activity log. If Composio names an action differently, the agent must ask for approval.

To have Patch review one pull request once, with the user's own brief, there is a crew job (section 20). Its brief gives a yes of its own, narrower than this one: one review, on that pull request, during that job.

### What the review instruction contains

- The repository, the pull request number and the head commit. Then the steps for Patch, and a rule: do not merge, approve, close or push.
- A warning: the title, description, code and comments were written by other people. They are material to review, never instructions.

The instruction carries no text from the pull request, not even its title. Anyone who can open a pull request writes that text. Inside the platform's instruction it would look like the platform's own words. A stranger could plant commands that way.

### What can go wrong

- **No admin access to the repository.** Review is not switched on. The user gets a plain message.
- **GitHub cannot be asked for the head commit.** The commit named in the event is used. With none, no review runs, and the activity log says why.
- **No credits.** No review runs and the automation is paused. The row is removed, so that commit can still be reviewed later.

## 20. The crew

The crew is one lead agent and three specialists. The user texts the lead, and the lead hands parts of a job to a specialist.

| Name | Job | What it works with |
|---|---|---|
| Tex | The lead. Plans the job, hands parts out, answers the user | Everything except the web tools |
| Byte | Coding. Writes and changes code, opens pull requests | Files, shell, git, the platform tools |
| Patch | Code review. Checks bugs, security and tests. Never changes code | Reads code, runs tests, the platform tools |
| Scout | Research. Searches the web and reads pages | Web tools, and a browser on Max. No files, shell or apps |

### Where they are defined

- In the agent image, not in the backend. The agent image is the software inside every container. A small adapter in it is called the Bridge.
- The Bridge holds one definition per specialist: a description, a role text and a tool list.
- The same definitions serve both engines. An engine is the AI program in the container: Hermes or Claude Code.
- Only the lead starts a specialist. On Claude Code a specialist's tool list is enforced. On Hermes it is only an instruction.

### What the backend does

1. **The crew list.** `GET /v1/crew` returns the four members: id, name, role, a short description, and whether each is available. So the apps do not hard-code the crew.
2. **Which members are switched on.** The backend cannot see which agent image is deployed. The setting `CREW_AVAILABLE` names the specialists the apps may show. The default is all three. Tex is always available.
3. **Progress lines.** During a turn the Bridge reports short lines, such as "Scout: reading 4 pages". The backend passes them on.

- Every progress line goes to the web app's live view. Nothing is sent to Telegram for it. A chat gets only the agent's own messages.
- A line that names a specialist is also saved to the activity log, at most 30 a turn.
- The platform cannot tell the crew members apart. Every call from one container carries the same token.

**Example.** Rahul texts "compare the pricing of Vercel and Netlify". Tex hands it to Scout. The web app shows "Scout: reading 4 pages". Telegram shows only the final answer.

### Crew jobs: a brief for Patch or Byte

A crew job is a piece of work the user writes down for Patch (a review) or Byte (a change), the way one would brief a colleague. It runs as one turn of the agent and ends with a report. Patch and Byte work in a folder of their own, and when the job is over, everything they started is stopped and the folder is deleted.

The user gives one on the Crew screen of the web app ("Give Patch a review", "Give Byte a job"), or in chat: "Patch, review acme/web PR 42, run pnpm test".

**The brief**

| | Patch | Byte |
|---|---|---|
| The repository | Picked from the user's GitHub repositories, or typed as owner/repo | The same |
| What to look at | A pull request, or a branch (against the default branch) | Where to start: the default branch, a branch, or a pull request's branch |
| The user's own words | Anything Patch should know (optional) | What to fix or build (needed) |
| Only for this member | What to look for: bugs, security, tests, performance, style. Bugs, security and tests when none is ticked | What to test for: the checks that say the job is done |
| Commands | To install, run the tests or start the app (optional) | The same |
| At the end | Patch never changes code | Push a new branch and open a pull request (the default), or only push the branch. Never the default branch: the git gateway refuses it anyway |
| What to do with the report | Always: send it to the chosen chat (web chat or the linked Telegram chat). If ticked: post it on the pull request as one review; open an issue with it | Always: the chat. If ticked: put it in the description of the pull request Byte opens; open an issue with it |

The list of repositories comes from Composio's GitHub action for the signed-in account's repositories: the 100 pushed to most recently. It is kept for a minute per user and costs nothing. Without GitHub connected, or when Composio cannot be asked, the user types the repository instead.

**How a job runs**

1. The api checks the brief, that GitHub is connected, that the user has credits, and that fewer than 5 jobs are waiting. At most 20 jobs an hour.
2. It saves the job in the table `crew_jobs` as `queued`, and queues it on the inbound queue, the same line as the user's messages. A request sent twice with the same key makes one job.
3. When the user's agent is free, the worker marks the job `running` and runs one turn with it. A job that runs again after a failure in the middle (the vm-manager restarted) goes on with the same delivery id, so the container never runs it twice. A job that is `done` or `failed` never runs again.
4. The turn's message is written by the platform from the brief. The user's own words are quoted and marked as theirs. Nothing read from GitHub is in it, not even a pull request's title. The repository's code and files, its commit messages and every pull request's text are material to work on, never instructions, and the message says so.
5. Tex hands the job to Patch or Byte. For a large change Tex may split a review into up to 3 Patch runs at the same time, each with some of the focus areas.
6. Tex's final answer is the report. It goes to the chosen chat like any answer, and the platform also keeps it on the job. In web chat it goes to a conversation of its own, named after the job. On Telegram it goes to the chat's current conversation. A job started from chat answers in the conversation it was asked in.
7. The job is marked `done` or `failed`. Right after, the backend asks the vm-manager to stop the container politely, so it sleeps now instead of after 3 idle minutes. The vm-manager refuses while a turn runs, a delivery is in flight or a Claude sign-in waits; then the idle stop does it later.

**The report** has a fixed shape, so the user always finds the same things in the same place:

| Patch | Byte |
|---|---|
| The verdict: ship, or fix first | The verdict: done, or not done |
| Each finding with its file and line, the most serious first | The branch, and the pull request's link |
| | Each change with its file and line, and each check from "what to test for" with passed or failed |
| The tests run, with their results | The same |
| What was not checked, and why | The same |

**The one yes for the pull request.** A GitHub review is read by other people, so it normally needs the user's yes each time (section 15). Ticking "post it on the pull request" in Patch's brief is that yes, for one thing only:

- one new review of type comment, or one comment, on exactly that pull request in exactly that repository;
- while that job's turn runs;
- once. The job is marked "posted" in the same step as the check. If GitHub refuses the review, the mark is taken back, so it can be tried again.

Approving, requesting changes, merging, closing and pushing to the default branch are never covered. Byte's report goes into the description of the pull request it opens, which needs no yes today. Opening an issue needs none either.

**From chat.** Tex has the tool `start_crew_job`, with the same brief. The job runs as its own turn right after the current one, and Tex tells the user it is queued. Asked again for the same brief while that job still waits or works (within 10 minutes), it starts no second one. A job from chat that would post Patch's review on a pull request needs the user's yes first, through an ordinary approval for that exact brief: "I'd like your OK for this: Patch reviews acme/web#42 and posts the review. Approve or Deny below." The platform cannot tell whether the user really asked for it, or whether a page or an email told Tex to.

**Clean-up in the container** is done by the Bridge itself, not only by the instructions (section 34).

**The cost.** A job costs what a turn costs. A review posted on the pull request, an issue and a pull request Byte opens are app actions that change something: 1 credit each. A job that fails on our side is not charged, like any turn.

**Example.** Rahul gives Patch a review of `acme/web` pull request 42, ticks bugs and security, types `pnpm install && pnpm test`, and ticks "post it on the pull request". The Crew screen shows the job as waiting, then working. Four minutes later it is done. The report is in a web conversation called "Review acme/web#42", on the pull request as one review, and on the Crew screen. The container went to sleep right after.

### What can go wrong

- **`CREW_AVAILABLE` does not match the deployed image.** The apps then show a member that is missing. Or they hide one that is there.
- **A job fails.** It is marked `failed` with a reason in plain words. The user is told in the job's chat, and a failure on our side is given back, like any turn. Out of credits, or no AI connected, the job fails before the container wakes.
- **GitHub was disconnected after the job was given.** The job fails at its start and says so.
- **The agent cannot be reached after 5 tries** (the server is full for long). The job is marked failed, and the user is told to give it again.
- **The report is longer than a message may be** (8,000 characters). The answer cannot be sent and the turn fails. Tex is asked to keep the report under 6,000 characters.

## 21. Web research: search and reading pages

This section says how the agent gets information from the web. Only Scout searches. The platform's two web tools run on the server, and no search key enters a container.

### Which search is used when

| The user's engine | Search that Scout uses | Cost | Plan |
|---|---|---|---|
| Claude Code, on the user's own Claude plan | Claude Code's built-in search | No credits | Any |
| Hermes | The platform's `web_search` | 1 credit a search | Max only |

- The agent image sets "only Scout" and chooses Scout's search. The platform does not check either. The built-in search does not pass through the platform at all.
- **Free and Pro with Claude Code:** the built-in search, at no credits.
- **Free and Pro with Hermes:** no web search. `web_search` refuses and says that it needs the Max plan. Nothing is charged. `read_page` still works: it is free on every plan.

### What `web_search` does, in order

1. It counts the call against the limit of 20 a minute. Refused calls count too.
2. It reads the user's plan. Not Max: refused, and the refusal is written to the activity log.
3. It checks that a search provider is set up. The provider is Brave Search, with the key `BRAVE_SEARCH_API_KEY`. With no key, the tool answers that search is not set up.
4. It checks the credits. At zero: refused. Otherwise it runs the search from the server. It returns up to 10 results, 5 by default: a title, a link and a short text each.
5. It charges 1 credit, only after a successful search. The result links become "seen" addresses for `read_page`.

### `read_page` and its rules

`read_page` fetches one public web page from the server. It returns the page's text and its first 50 links. It reads HTML, plain text, JSON and XML. It sends a plain request: no cookies, and nothing about the user.

| Rule | Value |
|---|---|
| Kind of address | Only `http` and `https`, on the standard web ports |
| Sign-in | None. An address with a user name or password is refused |
| Private and internal addresses | Refused, also when a public name points to one |
| Redirects | At most 5. Every step goes through all the checks again |
| Limits | 15 seconds, 2 MB read, 20,000 characters returned, 30 pages a minute |

Private and internal addresses are those inside our own network or the cloud's, such as the database or other containers. Without this rule, a web page could trick the agent into reading the platform's insides.

### The difference by engine

| The turn runs on | `read_page` opens |
|---|---|
| Claude Code | Any public address |
| Hermes, or no turn on record | Only an address already seen for this user |

- A seen address comes from one of three places. These are the user's own messages, a `web_search` result, and a link on a page already read.
- "The user's own messages" means their last 100, from the past 7 days. Results and links are kept 24 hours. On Hermes a redirect is followed only to a seen address.
- **Why Hermes is strict.** `read_page` needs no approval. A hostile page could make an agent open a made-up address with private data in it.
- **Why Claude Code is open.** Only Scout can call `read_page` there. Scout has no files, no shell and no apps.
- **How the engine is known.** The worker notes the engine when it delivers a turn. With no note, the strict rule applies.

**Example.** Rahul texts "what does example.com/pricing say". The address is in his own message, so it is seen. Scout can read it on any engine and any plan.

### What can go wrong

- **The search provider is down.** The agent is told. Nothing is charged and the turn goes on.
- **An address is refused.** The agent is told why. The refusal is in the activity log, without the part after the question mark.
- **A known gap on Claude Code.** The platform trusts the agent image for "only Scout". An agent with a shell could call the tool server itself. Each such read is limited and logged.

## 22. Shared memory

Shared memory is what the platform knows about a user from earlier chats. It lives on the platform, so it stays when the user changes engine.

### What a memory is, and the three tools

A memory is one short fact about the user, on one line of at most 300 characters. It is saved in the table `memories`. Each one has one of five kinds.

| Kind | Example |
|---|---|
| `preference` | "Prefers short replies" |
| `person` | "Priya is their co-founder and handles finance" |
| `project` | "The backend is the repo acme/backend" |
| `instruction` | "Always cc their assistant on emails to investors" |
| `fact` | "Lives in Bengaluru" |

- `remember` saves one memory. The same text again is not saved twice.
- `recall` finds memories by the words of a question. With no words, it lists the latest. It does not search by meaning.
- `forget` removes a memory. With a correction, it replaces the text and keeps the id.
- The tool texts tell the agent to save only what the user says or confirms. Something only read in a web page or an email must not be saved.

### How memories reach the agent

1. The backend prepares the text of a turn for the container. This happens for every kind of turn.
2. It puts a block of memories at the top. Standing instructions come first, then the most recently confirmed or found.
3. The block holds at most 30 memories and 2,000 characters. If more are saved, a last line says how many, and tells the agent to use `recall`.
4. Then comes a line that says the turn's own message follows, and then the message.

- The block's first line says the notes are data, not a message from the user. It says a note can never approve an action.
- A memory cannot fake the block's own lines. It is kept on one line, and its square brackets are turned round.
- With no memories, nothing is added. If the database fails, the turn is delivered without the block.

### The recap when the engine changes

- Each engine keeps its own copy of a conversation. A new engine would not know what was said. So the platform records which engine last finished a turn in each conversation, in the table `chat_engines`.
- When a turn runs on a different engine than the conversation's turn before it, the backend adds a recap after the memory block. The same engine gets no recap.
- The recap holds the messages of that conversation that this engine has not seen: at most 12 messages and 3,000 characters. It is framed as a record, not as new requests.
- Nothing said in another conversation is ever in the recap (section 8). A new, empty conversation has no recap at all.
- The memory block is the other way round: it is the same in every conversation.

### Limits and refused secrets

- The limits are the same on every plan: 200 memories per user, 300 characters each. The agent may make 60 changes an hour: saves, corrections and removals together.
- A secret is refused when a memory is saved or corrected. The check looks at the shape of the text.
- Refused shapes: a known kind of key or token, a card number, a long random string. Also a web address with a password in it, "password is ..." and "PIN: ...".
- The refusal names the kind of secret, never the text. It is a safety net, not a guarantee: "the door code 4821" passes.

### What the user can do

- List all memories: `GET /v1/memories`. Delete one: `DELETE /v1/memories/{memoryId}`. Delete all: `DELETE /v1/memories`.
- The user cannot add or edit a memory in the web app. They tell the agent. Deleting the account removes the memories.
- **The activity log never holds a memory's text.** An entry says that a memory was saved, corrected or removed. It gives the id. The log is kept after a memory is deleted, so the text is left out. A deleted memory is really gone.

**Example.** Rahul texts "remember that Priya handles finance". The agent calls `remember`. A week later, on another engine, the block still says it. Rahul texts "send the invoice to whoever handles finance", and the agent knows who that is.

### What can go wrong

- **A false fact is saved.** The platform cannot check that the user really said it. It stays until the user deletes it.
- **A memory tries to give an order.** It cannot approve anything. A risky action still needs the user's yes.
- **Memory is full.** Nothing is saved. The agent is told to remove old ones first.

---

# Part C. Money

## 23. Credits: the idea

Credits are what a user pays with. This section says what a credit is, where credits are kept, and why no balance number is ever stored.

### What a credit is

1 credit is $0.01 of price. Prices are about 2.5 times the real cost, so 1 credit pays for $0.004 of real cost. Credits are whole numbers. Example: an AI call costs Textcrew $0.04. The user pays 10 credits, which is $0.10.

### Grants and the ledger

A grant is one batch of credits given to one user. It is one row in the table `credit_grants`. It holds the amount it started with, what is left, where it came from, and the date it expires.

| Source | Amount | How long it lasts |
|---|---|---|
| Sign-up | 100, once per account | 90 days |
| Monthly plan | 1,500 (Pro) or 4,500 (Max) | 90 days |
| Top-up | 800 for $10 | 90 days |
| Coupon | Set by the coupon | Set by the coupon |
| Admin adjustment | Any | 90 days, another date, or never |
| Refund or chargeback | A negative amount | Never expires |

The ledger is the list of every change to a user's credits. It is the table `credit_ledger`. Rows are only added, and the database refuses to edit one. Each row says which user, which grant, how many credits went in or out, the reason and a short text. The user sees this list as their credit history.

**The 90-day life.** Every credit lasts 90 days from the day it is granted. Only a coupon or an admin can set another length. Unused monthly credits carry over: they do not end at renewal, and they do not end when the plan ends. An expired grant stops counting in the balance at once. A job runs every hour, sets what is left of expired grants to zero, and writes a ledger row "Credits expired".

### Why no balance number is stored

A single stored balance goes wrong easily. Two jobs change it at the same moment, and one change is lost. A job runs twice and changes it twice. The number looks wrong, and nothing shows how it got there.

So the system stores only grants and ledger rows, and works the balance out each time. Every credit change for one user runs alone: the database holds a lock for that user until the change is saved. The total of a user's ledger rows always equals the total left in their grants.

The balance the web app shows is worked out the same way, in a single read of the user's grants, together with what it needs beside it (when the next credits expire, or the grants themselves). It is never kept in Redis or anywhere else. A charge does not use it: it reads the grants again, under the user's lock.

### The balance and the order of spending

The balance is what is left in every grant that has not expired, plus any debt (see "Going below zero"). Credits are taken from the grant that expires soonest. Grants that never expire go last. If two grants expire at the same time, the older one goes first.

Example: a sign-up grant has 40 left and expires in 10 days. A monthly grant has 1,500 left and expires in 85 days. The balance is 1,540. A charge of 50 takes 40 from the sign-up grant and 10 from the monthly grant. The ledger gets two rows, one per grant. This way the user loses as few credits as possible to expiry.

### The "cheap model only" mark

A grant can carry this mark. Coupon grants carry it by default. All other grants are normal grants. The mark keeps free credits away from expensive models.

- A marked grant can pay for: Textcrew AI on the cheap model, awake time, app actions.
- A marked grant cannot pay for: Textcrew AI on other models, browser time, web search, other paid tools.
- In one charge, the usage that needs a normal grant is taken first. Marked credits are kept for what they may pay.
- App actions are allowed because they are a fixed 1-credit charge on every plan. Without that, a user with only coupon credits would build a debt with every action.

### Going below zero

A charge can be bigger than what is left. The rest is written down as a debt, and the balance goes below zero. A debt never expires. The next credits the user gets pay it first. A debt from cheap-model AI, awake time or app actions can be paid from any grant. A debt from other usage can be paid only from normal grants.

Example: the balance is 3 and a charge of 5 arrives. The balance is now -2. The user buys a top-up of 800. The balance is 798.

### Idempotency keys

An idempotency key is a unique name for one change. The ledger refuses a second row with the same key. This matters because jobs are retried when they fail. A job can save a charge, crash, and run again. The second run finds the key and does nothing. Without the key the user would pay twice. So every charge and every grant has one.

| Change | The key is built from |
|---|---|
| Sign-up credits | The user |
| Monthly credits | The subscription and the start of the paid period |
| Top-up, refund, chargeback | The order id or refund id from Polar, the payment company |
| Coupon | The coupon and the user |
| Usage charge | The user and the start of the usage period |
| App action, web search | The user's approval, or an id made for that one run |
| Admin adjustment | The user and a key the admin sends |
| Refund of a failed turn | The turn |

## 24. What costs credits

This section lists everything that is charged, its price, and how it is measured. It also lists what is free. A turn is one run of the agent: a message comes in, and the agent works until it has answered.

| Thing | Price | How it is measured |
|---|---|---|
| Textcrew AI | Real cost × 2.5, rounded up | LiteLLM's cost for the user's key |
| Awake time | 1 credit per 10 minutes | Seconds the container was awake |
| App action that changes something | 1 credit per successful action | Counted when the action runs |
| Browser time (Max only) | 2 credits per minute | Seconds the browser was in use |
| Web search through Textcrew (Max only) | 1 credit per successful search | Counted when the search runs |
| Other paid tools | Their set cost × 2.5 | Counted when the tool runs. None exist yet |

- **Textcrew AI** is the AI that Textcrew rents and sells on. LiteLLM is the gateway all model calls go through. Example: a turn uses $0.031 of AI. That is 7.75 credits, charged as 8.
- **Awake time** counts every second the user's container runs. The container is the closed-off computer the agent lives in. The idle minutes after a turn, before it is stopped, count too.
- **An app action** is one thing the agent does in a connected app, such as sending an email.
- **Browser time** is charged on top of awake time. Both run while the browser is open.
- **Quick replies.** A simple message can be answered by the cheap model without the container. Its cost is part of the AI cost.

### What is free

- App actions that only read: get, list, search.
- Reading a web page.
- The web search built into the user's own engine. The engine is the agent program in the container. At present this means Claude Code on the user's Claude plan. The platform is not involved.
- An app action or a search that failed or was refused. A turn that failed because of a fault on our side: its charges are given back.

### How "changes something" is decided

The platform looks at the action's name, in this order:

1. The action needs the user's approval (send, reply, delete, pay, share, post, merge, update and similar). It changes something.
2. The name has a write word (create, add, set, edit, mark, upload and similar). It changes something.
3. The name has a read word (get, list, search, find, fetch, read, download and similar) and no write word. It only reads. Free.
4. The name has neither. Composio is the service that connects the apps. If Composio tags the action as read-only, it is free.
5. Anything else changes something. An unknown action is charged.

Only a successful action is charged. Every user pays it, also a user on their own AI.

### How a web search is priced

A web search follows the general rule for paid tools: a set cost × 2.5.

- The setting `WEB_SEARCH_COST_USD` is 0.004. Times 2.5 that is $0.01, exactly 1 credit. The setting is what the price is worked out from. It is not the provider's bill. Brave, the search provider, bills about $0.005 a search.
- If the setting were 0.005, a search would be 1.25 credits. Fractions carry over, so four searches would cost 1, 1, 1 and 2 credits.
- A paid tool call never costs less than 1 credit. A setting of 0 makes search free. Only normal grants pay for paid tools.
- Three cases are not charged. The search was refused because the user is not on Max. The provider failed. No provider key is set on the server.

### With the user's own AI

A user can bring their own AI: an API key or their Claude plan. Then only the AI part is free. Awake time, app actions, browser time and web search through Textcrew are charged as for everyone. A turn needs a balance above zero in every case.

## 25. How charging happens

A charge is made in one of two ways. The usage sync charges AI, awake time and browser time after the fact. App actions and searches are charged at the moment they run.

### The usage sync

The usage sync is a job in the worker, the process that does the slow work. It runs every 5 minutes for every user who has a LiteLLM key, and every user gets one at sign-up. It also runs after each turn, for that one user, as the turn's billing job (next part). For one user it does this:

1. It takes the user's credit lock.
2. It finds the period to charge: from the end of the last charged period until now.
3. It asks the vm-manager, the service that starts and stops containers, for two numbers. One is the seconds the container was awake in that period. The other is the seconds the browser was in use.
4. It asks LiteLLM for the total cost on the user's key so far. It subtracts the total it saved last time. The rest is the new AI cost.
5. If there is no new cost and there are no seconds, it writes nothing and goes to step 8. The next sync covers a longer period.
6. It turns the numbers into credits (next sub-section). If the user's LiteLLM key pointed at their own API key, the AI credits are 0.
7. It writes one row in `usage_periods` for this period, makes one charge for the total, and saves LiteLLM's new total. These three are one database transaction: all of them are saved, or none.
8. It brings the user's LiteLLM key up to date: the budget, and whether it points at the user's own key (section 30). This also fixes a switch that failed earlier. If the balance is zero or below, it pauses the user's automations. An automation is a job the agent runs on a schedule or on an event.

After a turn on the user's Claude plan, steps 4 and 8 are left out: LiteLLM is not asked at all (next part).

### The billing of a turn

A turn does not charge its own credits. Once the reply is out, the worker adds a job named `bill-turn` to the system queue, saves the turn's last state and gives the user's lock back. The user's next message can start at once. The job runs a moment later, on its own: it is the usage sync above, for that one user. Then the web app gets the new balance.

- **One job per turn.** The job's id is built from the turn's event, so adding it twice queues it once.
- **Safe to run twice.** Usage is charged by period, not by turn. A second run finds its period charged and covers only what came after it.
- **Tried again when it fails.** If the vm-manager or LiteLLM does not answer, the job fails and is tried again, 5 tries in all, like every job. After the last one an alert is raised. The usage is then charged by the next 5-minute sync.
- **Never lost.** The job is added before the lock is given back. If the worker stops after the reply and before the job runs, or Redis loses the job, the 5-minute sync charges the same usage. Nothing is lost and nothing is charged twice.
- **If the job cannot even be added**, because Redis is down, the worker charges the turn itself, as it did before 15 October.

What the job asks depends on who pays for the AI (section 30):

| Who pays for the AI | What the turn can cost | What the job asks |
|---|---|---|
| Textcrew AI | AI, awake time, browser time | LiteLLM (the AI so far) and the vm-manager (the seconds) |
| The user's own API key | Awake time, browser time. The AI is free | LiteLLM, to keep its running total and the key's budget, and the vm-manager |
| The user's Claude plan | Awake time, browser time. The AI is free | Only the vm-manager |

App actions and web searches are not in this job: they are charged at the moment they run (below), for every user.

On the user's Claude plan, Claude Code does not use LiteLLM, so the turn has no AI on our side to charge. The job does not ask LiteLLM for anything, and it leaves the LiteLLM key's budget to the 5-minute sync. The refund of a failed Claude-plan turn does not ask LiteLLM either. Leaving LiteLLM out can never lose an AI charge: AI is charged as the difference from the total saved last time, so any AI on the key is charged by the next sync that asks.

Example: Rahul, on Textcrew AI, asks "email Priya the notes". The reply arrives, and about a second and a half later his lock is free. He sends "and cc Asha", and that turn starts at once. Meanwhile the first turn's billing job charges 9 credits, "Usage: AI 8, awake time 1". His balance in the web app drops by 9 a moment after the first reply. On his Claude plan the same turn would cost only the awake time, 1 credit, and LiteLLM would not be asked.

### Whole blocks and carried-over remainders

Awake time is charged in blocks of 10 minutes (600 seconds). The system adds up all awake seconds ever recorded for the user. Each time the total passes another 600, one credit is charged. A remainder is never lost and never rounded up.

| Sync | Awake in this period | Total so far | Blocks reached | Charged now |
|---|---|---|---|---|
| 1 | 4 minutes (240 s) | 240 s | 0 | 0 |
| 2 | 7 minutes (420 s) | 660 s | 1 | 1 |
| 3 | 25 minutes (1,500 s) | 2,160 s | 3 | 2 |

In sync 1 a turn kept the container awake for 4 minutes. Nothing is charged yet. The 240 seconds wait for the next sync. Browser time works the same way, with blocks of 30 seconds. Example: the browser was in use for 33 seconds. 1 credit is charged and 3 seconds are carried over. AI cost has no blocks. It is rounded up at each sync that has AI cost.

Full example: a Pro user on Textcrew AI sends a message. The AI costs $0.031, which is 7.75 credits, charged as 8. The container is awake for 5 minutes, and 400 awake seconds were carried over from before. 400 + 300 = 700 seconds, so one block is reached: 1 credit, and 100 seconds are carried over. The charge is 9 credits. The credit history shows "Usage: AI 8, awake time 1".

### Why a re-run cannot charge twice

- `usage_periods` allows one row per user and period start. A second sync for the same period cannot write its row, so it stops. The charge's idempotency key is built from the same two things.
- The 5-minute sync, the billing job of each turn and the billing before a turn (section 26) all take the user's credit lock. The second one starts where the first one ended.
- AI is charged as the difference from the saved LiteLLM total. The same cost is never counted again.

### Charges made at the moment

An app action is charged like this:

1. The agent asks the platform to run an app action.
2. The platform decides whether it changes something. If it does and the balance is zero or below, the action is refused.
3. Composio runs the action. If it fails, nothing is charged.
4. On success, 1 credit is charged at once. The ledger row reads "App action:" and the action's name.
5. The key is the approval's id when the user approved the action. An approval can be used once. Otherwise the key is an id made for that run.

Any grant can pay for an app action, also a marked one. A web search is charged the same way, with the ledger text "Web search". The user sees these charges in the credit history, in the activity log and in the usage report. The usage report has five parts: AI, awake time, app actions, browser time and paid tools.

### When a turn fails because of us

1. The container reports the failure as a fault of the platform, for example a crash or a timeout.
2. The worker tells the user at once: "Sorry, something went wrong on our side and I couldn't finish that. You weren't charged for it. Please try again." The message is marked `failed`. Neither step waits for the refund.
3. The worker adds a refund job, `refund-turn`, to the system queue. There is one job per turn: its id is built from the event. It runs 30 seconds later, so LiteLLM has written the turn's calls to its log by then.
4. The job runs a sync first, so the turn's usage is charged.
5. It works out what the turn cost. AI comes from LiteLLM's spend log for the turn's time. Awake and browser time come from the vm-manager. A turn on the user's Claude plan has no AI to give back, and LiteLLM is not asked.
6. It gives that back to the grants it came from, and never more than was charged. It also gives back the app-action and paid-tool credits charged during the turn. All of it is one database transaction with idempotency keys, so it is given once, however often the job runs.
7. If a step fails, nothing is given and the job is tried again: 5 tries over about 13 minutes. On the last try, if LiteLLM still cannot say what the AI cost, the job gives back everything else. The AI is then not refunded, and the log says so. If the last try fails anyway, an alert is raised.

Example: Rahul's turn on Textcrew AI fails as our fault after 2 minutes. He gets the apology right away. During the turn the agent saved an email draft, an app action of 1 credit. Half a minute later the job finds $0.02 of AI in the log, which is 5 credits. It gives back the 6 credits. If the job runs again, it gives nothing more.

A failure that is not our fault is not refunded. Examples: the user's Claude plan reached its limit, or the agent hit its own step limit.

### How the turn's AI cost is read

LiteLLM keeps one row per model call, with the key, the time and the cost. It writes these rows in batches, every 10 to 15 seconds. The job asks `/spend/logs/v2` for the rows of the user's key in the turn's time. LiteLLM stores a key only as its SHA-256, so the job sends that, never the key. The times are sent to the second, rounded outward. The job then keeps only the rows inside the turn, to the millisecond, and adds up their cost.

The older `/spend/logs` is not used. It takes dates only, and it answers 500 to a time of day. It is also marked as replaced. Asking it with full times was why a refund failed on the test server on 8 October 2026. That turn's user got no reply and no refund.

### What can go wrong

- **The vm-manager or LiteLLM does not answer during a sync, or the worker crashes in the middle.** Nothing is written for that user. The next sync covers the longer period. Other users are not affected.
- **A turn's billing job fails on every try.** An alert is raised. The next 5-minute sync charges the usage. Until then the user's balance shows a little too much.
- **LiteLLM's spend log cannot be read when a failed turn is refunded.** The user has already been told. The refund job is tried again. On its last try it gives back everything except the AI.
- **The refund job cannot even be added**, for example because Redis is down. The user is still told, and the message still ends. An alert names the turn, so it can be refunded by hand.
- **The budget update in LiteLLM fails.** It is logged. The next sync sets it.
- **The charge for an app action fails after the action ran.** The action stays done and is not charged. The error is logged. The action is not run again, so it cannot happen twice.

## 26. When credits run out

"Out of credits" means the balance is zero or below. This section says what is stopped, what keeps running, and what the user is told.

### The check before a turn

When a message arrives or an automation fires, the worker first checks that the balance is above zero. If it is not, the user gets the out-of-credits reply. The container is not woken, and no AI is called.

- **On Telegram** the reply is: "You're out of credits, so I can't work on that right now. Open the Textcrew web app to top up, upgrade or redeem a coupon."
- **In web chat** the message is refused at once with the error `out_of_credits`, and the web app shows its own text.

On Telegram, a coupon code sent as a message is still redeemed at zero credits. That check comes before the credit check.

**The turn before may not be billed yet.** A turn's credits are charged by its billing job, a moment after the turn (section 25). So the check can come before the last turn's charge is in. One turn that waits for its billing is allowed: that is the usual case, a second message sent right after a reply. Two are not. If two earlier turns still wait for their billing when a turn starts, the worker bills them itself first, then checks the balance. So a user is never more than one turn ahead of their charges, also when the system queue is slow or stopped. What that one turn cost beyond the balance becomes a small debt (section 23), as awake time already could.

- In web chat the api's own check does not see an unbilled turn. When it lets a message through that the worker then refuses, the out-of-credits reply comes in the chat.
- The look at the waiting turns is one read in Redis: it adds no trip to the database to a turn.

Example: Asha has 1 credit, and each of her turns keeps the container awake 10 minutes, which is 1 credit. Her first message runs. Her second, sent right after, runs too: the first turn is not billed yet, and the balance still shows 1. Before her third message the worker bills the first two turns itself: 2 credits. Her balance is -1, and she gets the out-of-credits reply. The two billing jobs run later and charge nothing more.

### A turn that is already running

The platform does not stop a running turn. What happens depends on who pays for the AI.

- **Textcrew AI.** The user's key in LiteLLM has a budget equal to the balance, in real dollars. When the AI cost reaches it, LiteLLM refuses the next model call. The agent cannot go on.
- **The user's own AI.** There is no AI budget. The turn runs to its end. A turn lasts 15 minutes at most.
- **Awake and browser time** of the turn are charged at the next sync. If that takes the balance below zero, the rest becomes a small debt.
- **The browser** has no check of its own. It runs only inside a turn, and a turn does not start at zero.

### Paid tools and app actions at zero

Each call is checked when it is made. At zero or below:

- An app action that changes something is refused before it runs. Reading still works.
- A web search through Textcrew is refused before it runs. Reading a web page still works.
- The tool tells the agent that the user is out of credits. It tells the agent to name the web app and to send no link.

### Automations

- When a charge takes the balance to zero or below, all the user's automations that are on are paused. The saved reason is "out of credits".
- An automation that fires at zero gets the out-of-credits reply in the Automations chat, with a copy on Telegram when it was made there, and is paused.
- When credits are added and the balance is above zero, these automations are switched on again. The AI budget in LiteLLM is raised, and the web app gets the new balance live.
- Automations that the user paused, or that were paused after failures, stay paused.

### No purchase link on Telegram

Plans and top-ups are bought in the web app only. Telegram requires its own payment system for digital goods sold inside a bot. So the bot never sends a link to a page where something is bought. The out-of-credits reply on Telegram names "the Textcrew web app" and carries no address.

As a safety net, every text sent to Telegram is checked first. A purchase link in it is replaced with "the Textcrew web app". This covers the agent's own messages too. A purchase link is any Polar address, or a web app address under billing, pricing, checkout, upgrade, plans, topup or subscribe. Other links stay, for example a link to settings.

### What can go wrong

- **The budget in LiteLLM was not updated in time.** The user can use a little more AI than they have. The next sync charges it, writes the rest as debt, and sets the budget.
- **A user on their own AI runs out in the middle of a long turn.** The turn finishes. The overrun is paid from the next credits.

## 27. Plans

A plan decides how many credits a user gets each month and what they may use. There are three plans. Coupon codes and the user's own AI work on all three.

| | Free | Pro | Max |
|---|---|---|---|
| Price | $0 | $12 a month | $30 a month |
| Credits | 100 once, at sign-up | 1,500 every month | 4,500 every month |
| Apps | 10, a fixed list | All 25 | All 25 |
| Automations | 1 | 5 | 50 |
| Own MCP servers | No | No | Yes |
| Top-ups | No | Yes | Yes |
| Browser | No | No | Yes |
| Web search through Textcrew | No | No | Yes |
| Queue priority | Last | Middle | First |
| Textcrew AI models | Cheap model only | All models | All models |

- **Sign-up credits.** Every new account gets 100 credits once. They last 90 days. They are given when the account is set up, together with the user's LiteLLM key. If the monthly cap on free credits is reached, they are not given (see "Coupon codes").
- **Automations:** a repo with pull-request review switched on counts as one.
- **An own MCP server** is a tool server the user adds to their agent.
- **Queue priority** works in two places. Incoming messages of Max users are handled first, then Pro, then Free. When the server has no room for another awake container, the vm-manager stops an idle one, Free first and Max last.
- **Browser:** the server must also have it switched on, with the setting `BROWSER_AVAILABLE`.

### Moving between plans

A plan changes when Polar's webhook arrives. A webhook is a call that Polar makes to our server (next section). For tests there is one other way, by hand (the last point below). Then this follows:

| Thing | What happens |
|---|---|
| Models | The user's LiteLLM key is changed: cheap model on Free, all models on paid plans |
| Browser | On for Max, off for others, from the container's next wake |
| Web search | Checked at every search, so it follows the plan at once |
| Apps | On Free the agent can use only the 10 Free apps. Other connections are kept |
| Automations | The limit is checked only when a new one is created |
| Own MCP servers | Adding one needs Max |
| Priority | Follows the plan from the next message |
| Credits | Credits already granted keep their own 90 days |

The ways to move:

- **Free to Pro or Max:** a checkout. The first month's credits arrive with the plan.
- **Pro to Max, or Max to Pro:** the checkout refuses a second plan while one is set to renew. The user cancels first and then buys the other plan. If the plan is changed on Polar's side instead, it applies at once. The new amount of credits comes with the next paid month.
- **Paid to Free:** the user cancels. The plan stays until the paid month ends. Then the user is on Free.
- **By hand:** an admin moves a user to any plan, from the admin panel ("Change plan", section 31) or with the founder's command-line script inside the api container. Both use the same function and take the same steps as a paid change: the plan, the LiteLLM key's models and budget, and the browser switch. The priority follows by itself. There is no payment and no credits are given. The activity log says the plan was set by hand, with the admin's id and, from the panel, the reason. A Polar subscription that still runs can set its own plan again at its next event. Example: to test Scout's browser, the founder moves his test user to Max, and the browser is on from the agent's next start.

## 28. Payments with Polar

Polar is the payment company. It shows the payment page, charges the card, runs the monthly subscription and tells the backend what happened. This section follows a payment from the click to the credits.

The backend needs these settings: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_SERVER`, one product id each for Pro, Max and the top-up, and `POLAR_WAITLIST_DISCOUNT_ID`. `POLAR_SERVER` is "sandbox" by default, which is Polar's test system. Without the product ids a checkout fails. Without the webhook secret every webhook is refused.

### Checkout

1. In the web app the user picks Pro, Max or a top-up.
2. The web app asks the api for a checkout (`/v1/billing/checkout`). The api is the process that answers the web app.
3. The api checks the rules. Free needs no checkout. A user whose plan is set to renew cannot buy a plan, and is told to cancel first. A top-up needs a paid plan, and a Free user is told to upgrade or redeem a coupon.
4. For a plan, the api checks the waitlist offer (below).
5. The api asks Polar for a checkout. It sends the product, our user id, the user's email and name, and the discount if there is one. Typing a discount code on Polar's page is switched off.
6. Polar answers with the address of its payment page. The web app sends the user there.
7. The user pays. Polar sends them back to the web app's billing page.

At this point nothing has changed in our database. Only Polar's webhook changes a plan or adds credits. The web app can never do it.

**Top-ups.** A top-up is $10 for 800 credits. There is one pack. Only Pro and Max users can buy it. The credits last 90 days and are normal credits, with no mark.

### The webhook

1. Polar calls `/webhooks/polar`.
2. The api checks the signature with the webhook secret. A wrong signature is refused.
3. The api saves the event in the events table. Polar's webhook id is the unique key.
4. The api adds a job to the system queue and answers 200. It does no other work.
5. The worker runs the job. It finds the user from our user id, which Polar sends back, and acts by the type of event.

| Event | What the backend does |
|---|---|
| `subscription.active` | Sets the plan, grants the month's credits, raises the AI budget |
| `order.paid` for a plan | Saves the order. Grants that month's credits if not yet granted |
| `order.paid` for a top-up | Saves the order. Adds 800 credits for 90 days |
| `subscription.updated` | Updates status and dates. A change between Pro and Max applies at once |
| `subscription.canceled` | Marks the plan as ending at the period end. The plan stays |
| `subscription.uncanceled` | Marks the plan as active again |
| `subscription.past_due` | Marks the payment as late. The plan stays |
| `subscription.revoked` | Ends the plan now. The user goes to Free |
| `refund.created`, `refund.updated` | Once the refund has succeeded, takes credits back |
| Any other event | Saved and ignored |

### Renewals and cancelling

Polar charges the card each month. When the payment went through, it sends `order.paid`. The backend grants the month's credits, for 90 days from that day. Older monthly credits keep their own date. Example: a Pro user has 300 credits left. The renewal adds 1,500. The balance is 1,800, and the 300 are spent first. Polar also sends an event when a new period starts, before the payment. The backend ignores it on purpose, so a renewal that was not paid gives no credits.

Cancelling goes like this:

1. The user cancels in the web app. The api asks Polar to cancel at the end of the paid period.
2. The plan stays until then. It does not renew.
3. At the period end Polar sends `subscription.revoked`. The user goes to Free. As a safety net, the hourly job ends any cancelled plan whose period is over.

Credits already granted keep their 90 days. Deleting an account also cancels the plan at the period end.

### Refunds and chargebacks

A refund is made in Polar. The backend acts when the refund has succeeded.

1. It finds the saved order: the amount paid and the credits bought.
2. It works out the share: credits bought × refunded amount ÷ amount paid, rounded up.
3. It writes a negative grant for that many credits. It is paid from the grants of that order first.
4. If the user already spent the credits, the rest stays as a debt.

Example: a user bought a top-up of 800 credits for $10. $5 is refunded. 400 credits are taken back. A full refund takes back 800. Amounts are compared without tax and after discounts. A refund does not change the plan.

A chargeback is a payment the cardholder disputes with their bank. Polar sends no event for a dispute. Often Polar refunds a disputed payment itself and marks that refund as dispute prevention. Then the backend takes back all credits bought with that order and flags the account. The flag is a mark on the user's record. Nothing else reads it yet. A dispute that Polar does not refund shows only in Polar's dashboard. Then an admin takes the credits back by hand.

### The waitlist offer

Waitlist members get 50% off the first month: Pro for $6, or Max for $15. The api adds the discount to a checkout only when all of this is true:

1. The discount is set up (`POLAR_WAITLIST_DISCOUNT_ID`).
2. The checkout is for a plan, not a top-up.
3. The user's email is verified.
4. The email is on the waitlist. Capital letters, "+tags" and the dots in Gmail names are ignored when comparing.
5. The waitlist entry is not rejected and not flagged for abuse.
6. The offer was not used before.

The offer is marked as used when the subscription becomes active, not at checkout. A user who opens the checkout and does not pay keeps the offer. The 50% itself is defined in Polar, as a discount that applies once.

### Exactly-once handling

- **Polar sends the same webhook twice.** The webhook id is unique in the events table, so it is saved once.
- **The job runs twice.** Every grant has a key built from Polar's ids, and each order id is unique in `payments`.
- **`subscription.active` and the first `order.paid` both arrive.** Both use one key, the subscription and the period start. The month is granted once.
- **A late event arrives for a plan that has ended.** It is ignored.

### What can go wrong

- **The webhook does not arrive.** The user has paid and sees no change. Nothing changes until it arrives. Handling the same event late, or twice, is safe.
- **The job fails.** It is retried, 5 tries in all. Then it shows on the failed jobs board.
- **Polar does not answer at checkout or at cancel.** The user gets an error. Nothing was changed.
- **The user or the product cannot be matched.** The event is logged as a warning and ignored.

## 29. Coupon codes

A coupon gives free credits to people the founder chooses: testers, friends, a launch promotion. Every limit below exists so that free credits cannot be collected in bulk.

### What a coupon is

A coupon is a campaign with one or more codes. An admin creates it and sets:

| Field | Meaning | Limit or default |
|---|---|---|
| Campaign name | A label for the admin | Up to 80 characters |
| Credits | Credits per redemption | 1 to 10,000 |
| Max redemptions | Total uses of the whole campaign | At least 1 |
| Expiry date | After it the codes stop working | Must be in the future |
| Credit life | Days the credits last after redemption | 1 to 365. 30 if not given |
| Cheap model only | The mark from the first section | On by default |
| New users only | The account must be newer than the campaign | Off by default |
| Plans | Which plans may redeem | Empty means all |
| Number of codes | 1 shared code, or many single-use codes | 1 to 500 |

With one shared code, many users can use it, up to the max. With many codes, each code works once, and the max still limits the total. A code looks like AGT-7KQ2-M9XP-4RWD-ABCD: "AGT" and 16 random characters. The letters O and I and the digits 0 and 1 are not used, so a code can be read aloud. The admin sees the codes once, when the campaign is created. The database keeps only a hash of each code (a one-way fingerprint) and its first characters. Capital letters, spaces and dashes do not matter when a user types a code.

### Redeeming a code

A user redeems in the web app (`/v1/coupons/redeem`) or by sending the code as a chat message.

1. **Rate limit.** At most 5 tries per user per hour. In the web app also at most 20 per IP address per hour. Wrong codes count. Over the limit, the user is told to try again later.
2. **The user is checked.** The email must be verified. At least one chat app must be linked. This stops fake accounts.
3. **The code is checked.** It must exist. The campaign must be active and not expired. The "new users only" and "plans" rules must fit.
4. **One database transaction** does the rest. If any step fails, all of it is undone.
   1. The code's use count goes up by one, only if it is below its max.
   2. The campaign's use count goes up by one, only if it is below its max.
   3. The monthly cap on free credits is checked.
   4. The grant and its ledger row are written. The key is the coupon and the user.
   5. The redemption is saved, with the IP address. The database allows one per coupon and user.
   6. An entry goes to the audit log, the record of who did what: user, coupon, IP address, time.
5. The AI budget is raised. Automations paused for credits resume.
6. The user sees the credits added, their expiry date and the new balance.

### More rules

- **One redemption per user per campaign,** whichever code they use.
- **One failure message.** Every failure except the rate limit gives the same answer: "Invalid or expired code". That covers a wrong code, an expired one, a used-up one and a disabled one. It also covers a user who does not qualify, and a reached cap. Nobody can find out which codes exist.
- **Parallel redemptions are safe.** The use counts are raised inside the database, with their limit in the same step. If one use is left and two requests arrive together, one wins. The same user redeeming twice at once gets credits once.
- **An admin can disable a campaign at once,** and enable it again. Credits already given stay. The admin can choose to revoke the unspent ones: what is left of those grants is set to zero.
- **Abuse flags.** When 3 or more accounts redeem from one IP address in a calendar month, the admin sees that address and the accounts. Nothing is blocked automatically. Codes sent in chat have no IP address and are not counted here.

### The monthly cap on free credits

Free credits are sign-up credits plus coupon credits. Their real cost is credits ÷ 250, in dollars.

- The setting `FREE_CREDITS_MONTHLY_CAP` is a number of credits. Empty means no cap.
- The system adds up all sign-up and coupon credits granted from the first day of the month. A new free grant is allowed only if that total plus the new grant stays within the cap.
- When the cap is reached, new accounts get no sign-up credits, and coupon redemptions fail with the usual message. Such a new user starts with zero credits and cannot run a turn until they get some.
- A lock stops two grants at the same moment from passing the cap together.

Example: a cap of 2,500 credits means at most $10 of real cost a month. That is 25 sign-ups, or 12 redemptions of a 200-credit coupon.

## 30. AI, three ways

A user chooses who provides the AI for their agent. This section explains the three choices, what runs in each, and who pays. There are two engines: Hermes, which can use any model through LiteLLM, and Claude Code, Anthropic's own program.

| Way | Engine | Who pays for the AI | AI charged in credits |
|---|---|---|---|
| The user's own API key | Hermes | The user, on their key | No |
| The user's Claude plan | Claude Code | The user, on their Claude plan | No |
| Textcrew AI | Hermes | Textcrew; the user pays in credits | Yes, real cost × 2.5 |

### The user's own API key

1. The user pastes a key in the web app. Three providers are accepted: Anthropic, OpenAI and OpenRouter. One key per provider. The user may also name a model. Without one, the provider's default is used (table below).
2. The api makes a small test call to the provider with the key.
3. If the provider refuses the key, the user gets an error and nothing is saved.
4. Otherwise the key is saved encrypted. Only its last 4 characters are ever shown.
5. The api charges the usage so far, as it ran. Then it switches the user's AI to the key in LiteLLM, the AI gateway on our server (next part).
6. If the switch fails, the key is taken out again. The user gets an error that says the key was not saved, and tries again.
7. From now on the user's AI is not charged in credits. Awake time and app actions still are.

How the key is used through LiteLLM:

- LiteLLM gets one extra model for this user. That model holds the user's key. LiteLLM stores the key encrypted and never shows it.
- The user's LiteLLM key may call only that model. The fixed name the container asks for means that model. So does the name the quick replies use.
- So every model call goes to the user's provider, with the user's key. A call to one of our models is refused, so our provider keys are never used for this user.
- The container still holds only its LiteLLM key. The user's provider key never enters it.
- The AI budget is removed while the balance is above zero. At zero it is closed, as for everyone, because awake time is still paid in credits.
- The extra model's name does not show whose it is.

Example: Asha saves an Anthropic key and names no model. LiteLLM gets a model that calls `claude-sonnet-5-5` with her key. Her agent asks for the fixed name as always, and the call goes to Anthropic on her key.

| Provider | Default model |
|---|---|
| Anthropic | `claude-sonnet-5-5` |
| OpenAI | `gpt-6.1-sol` |
| OpenRouter | `anthropic/claude-sonnet-5.5` |

Each default is the provider's current mid-priced model that can use tools. They were checked on 8 October 2026. OpenAI's newest models take tool calls only through OpenAI's newer interface; LiteLLM switches to it on its own.

- **Several keys.** The key saved last pays. Deleting it hands over to the other one.
- **When the key stops paying.** The user deletes the key, chooses Textcrew AI, or connects a Claude plan that takes over. The usage so far is charged as it ran. Then the LiteLLM key goes back to the plan's models and budget, and the model that holds the user's key is deleted from LiteLLM.
- **Charging follows what really ran.** A period is free of AI credits only if the LiteLLM key pointed at the user's own key.
- **Deleting while LiteLLM is down.** The key is not removed and stays in use. The user gets an error and tries again. If only the last step fails, deleting LiteLLM's copy, the key is no longer used and the next 5-minute sync deletes the copy.
- **A change of AI choice while LiteLLM is down.** The choice is saved, and the switch happens at the next 5-minute sync. Until then the web app shows the key that is really in use.
- **Deleting the account** deletes LiteLLM's copy and the saved keys.
- **One server rule.** LiteLLM encrypts the stored keys with its master key. If `LITELLM_MASTER_KEY` changes later, those keys can no longer be read, and these users' turns fail.
- **Not run for real yet.** It was checked against a real LiteLLM of the same version, with a stand-in for the provider. No call has gone to a real provider, because there is no key with balance.

### The user's Claude plan

The sign-in happens inside the user's container, in the unchanged Claude Code program, on Anthropic's own page.

1. The user starts the connection in the web app. At most 10 starts per hour.
2. The api makes sure the user has a container and asks the vm-manager to start the sign-in. The container is woken.
3. Claude Code in the container starts its own sign-in. It gives back an address on Anthropic's site.
4. The api returns that address. The sign-in stays open for 10 minutes.
5. The user opens the address, signs in with Anthropic, gets a code, and pastes it in the web app.
6. The api hands the code to the vm-manager, which hands it to Claude Code. The code is not logged and not stored.
7. Claude Code saves its own sign-in file.
8. The api saves the time of the connection and sets the engine to Claude Code.

Where the sign-in lives: only in the user's own volume, the container's disk that survives restarts. The backend stores no Claude password, token or code. It stores only that a plan is connected, and from when.

- **The switch between the two engines.** The setting `runtime` holds the user's choice: Hermes or Claude Code. Claude Code can be chosen only with a connected plan. The api tells the vm-manager at once, and the container needs no restart. If the vm-manager is down, the switch is sent again after the next wake.
- **Disconnecting** signs Claude Code out in the container and sets the engine back to Hermes.
- **A lost sign-in:** when a Claude Code turn fails and the sign-in is gone, the connection is cleared. The next turn runs on Hermes. The user is told to reconnect.
- **No AI charge:** Claude Code does not call LiteLLM, so there is no AI cost to charge. The billing after such a turn does not ask LiteLLM at all (section 25).
- **No quick replies:** every message goes to Claude Code.

### The Claude model and the thinking effort

With a Claude plan, the user also picks which Claude model Claude Code uses, and how hard it thinks. How hard it thinks is called the effort: a higher effort thinks longer before it answers.

| Setting | Choices | "Default" means |
|---|---|---|
| Model | Every Claude model Claude Code can use: see the list below | Claude Code's own choice |
| Thinking effort | low, medium, high, xhigh, max | Claude Code's own choice |

The model list, in the order the web app shows it. The current models come first, then the older models Claude still offers. In each part the newest version comes first.

| Group | Model | Effort levels it takes |
|---|---|---|
| Current | Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 | all five |
| Older | Fable 5, Opus 5, Sonnet 5, Opus 4.8, Opus 4.7 | all five |
| Older | Opus 4.6, Sonnet 4.6 | low, medium, high, max (no xhigh) |
| Older | Opus 4.5, Haiku 4.5 | none: the effort does not apply to them |

1. The user picks them in the web app's AI settings, in the Claude plan's part. They can do this whatever engine runs now.
2. The backend saves them with the other agent settings. A model that is not in the list is refused.
3. Every turn that runs on Claude Code carries both to the container. A choice left at "Default" is left out. A turn on Hermes carries neither.
4. The Bridge starts Claude Code with that model and effort for the turn.

- **What the list says about each model.** Its group (current or older), the effort levels it takes, and for some a short note. The web app uses these to group the models, to offer only the levels the chosen model takes, and to show the note.
- **An effort the model does not take.** The effort stays saved: it is the user's, and it applies again on another model. Claude Code runs the model at the nearest lower level it takes. Example: xhigh on Sonnet 4.6 runs at high. On Opus 4.5 and Haiku 4.5 the effort is left out altogether.
- **Fable costs extra on some plans.** On Pro, Fable 5.1 and Fable 5 are paid only with usage credits, from the first message. On Max, they may use up to half of the weekly limit, then usage credits. The list carries this as a note on both Fable models. It is Anthropic's rule, and Claude Code applies it; we only say it.
- **No credits change.** The Claude plan pays for the AI, so the choice changes no price.
- **The plan refuses the model or the effort.** The turn ends with Claude Code's own message. It is not our fault, so there is no refund. The choice is kept, and the user changes it in the settings.
- **A model taken off the list later** counts as "Default" until the user picks again.
- **Where the list comes from.** Claude has no way to ask which models a plan may use, so the list is kept by hand, in one place in the backend. It was checked on 13 October 2026 against Anthropic's model pages and the model table inside Claude Code 2.1.296, the version the container image installs: each model name and each effort level is one it takes. Haiku 5.5 needs Claude Code 2.1.293 or later. When Anthropic adds or retires a model, the list is changed by hand, and the container image's Claude Code version is raised if the new model needs it.

Example: Rahul picks Opus 5.5 and the effort xhigh. His next Telegram message runs on Claude Code with Opus 5.5, thinking at xhigh. He switches to Hermes for a day, and the choice waits for his return.

### Textcrew AI

- **One key per user.** At sign-up each user gets their own key in LiteLLM. It is stored encrypted. It is the only AI key their container gets. The provider keys stay on the server.
- **Models by plan.** LiteLLM offers three chat models, named cheap, claude and gpt. The container always asks for one fixed name. The user's key decides what that name means: the cheap model on Free, the premium model (claude) on Pro and Max. A Free key may call only the cheap model. A Pro or Max key may call all three.
- **The budget follows the balance.** LiteLLM compares a key's budget with all the key ever spent. So the budget is set to: spent so far, plus the balance ÷ 250 in dollars. Example: the key has spent $3.10 and the balance is 500 credits. 500 credits buy $2.00 of real cost. The budget is $5.10. At zero the budget equals what was spent, and no further call passes.
- **The budget is set again** after every sync, and when credits are added or removed. It is also set again when an own key is saved or deleted, when the AI choice changes, and when a Claude plan is connected or goes.
- **A provider key is needed.** Textcrew AI works only if LiteLLM holds a provider key that can pay. Without one these turns fail.

### Switching Textcrew AI off for the whole server

The setting `AI_ACCESS_MODE` has two values:

- `platform` (the default): Textcrew AI is on offer. A user who brought nothing runs Hermes on credits.
- `own_only`: Textcrew AI is off. Every user must bring a key or a Claude plan.

In `own_only`, a user with no AI of their own gets a fixed reply. It says: "Connect your own AI first: add an API key or connect your Claude plan". It ends with the address of the web app's AI settings. The container is not woken. The credit check still comes first.

### The user's choice and the effective engine

The setting `aiPreference` has two values:

- `auto` (the default): the rules below pick.
- `platform`: the user wants Textcrew AI although they have a key or a Claude plan. Hermes runs and the AI is charged in credits. The key and the Claude connection are kept, so going back needs no new sign-in.

Choosing `platform` works only while the server offers Textcrew AI. The api tells the web app whether it does. In `own_only` the choice is refused, and an older choice is ignored. Connecting a Claude plan sets the choice back to `auto`.

The effective engine is the one that really runs. It can differ from the `runtime` the user chose. The first row that fits wins:

| # | The user has | Engine that runs | Who pays for the AI |
|---|---|---|---|
| 1 | Chosen Textcrew AI, and the server offers it | Hermes | Credits |
| 2 | A connected Claude plan, and chose Claude Code | Claude Code | The Claude plan |
| 3 | An own API key | Hermes | The own key: no credits |
| 4 | Nothing, and the server offers Textcrew AI | Hermes | Credits |
| 5 | A connected Claude plan, chose Hermes, no key, `own_only` | Claude Code | The Claude plan |
| 6 | Nothing, `own_only` | Nothing runs | Nobody |

Example: a user has a connected Claude plan and a saved OpenAI key. With Claude Code chosen, row 2 applies. They switch to Hermes, and row 3 applies. They choose Textcrew AI, and row 1 applies: the AI now costs credits.

### What can go wrong

- **The sign-in code is wrong or too old, the server is full, or the vm-manager is down.** The user gets an error and starts again.
- **The Claude plan reaches its own usage limit.** The turn ends with a message that says so. It is not our fault, and nothing is refunded.

## 31. Admin tools

Admin tools are for the founder and trusted staff. They hand out free credits, correct balances, show what failed and show how the running system is doing. They act on accounts: the role, a suspension, a deletion, signing a user out, showing the welcome steps again. They also let support look at one user's agent and container and put it right.

Only a user with the role admin may use them. The role is set in Clerk, the sign-in service, in the user's public metadata. The backend copies it when Clerk sends the user's data. Anyone else gets "Admins only".

Every admin action that changes something goes to the audit log with the admin's id. Retrying or removing a job also needs a reason, written there too. No admin answer ever holds a secret.

The admin panel is where admins use these tools: a web app of its own, apart from the user's web app, for example at `admin.textcrew.in` (the repo `personal-agent-admin-panel`). It signs in with the same Clerk application and reaches only these admin calls and "who is signed in" (last part of this section).

| Tool | What it does | Where |
|---|---|---|
| Overview | The platform's numbers at a glance, counts only | `/v1/admin/overview` |
| Users | Every account, newest first, with search by email, name or id | `/v1/admin/users` |
| One user | One user's details: plan, credits, apps, automations, crew jobs, turn timings, activity, container | `/v1/admin/users/{id}` |
| Set a plan by hand | Moves a user to Free, Pro or Max, with no payment | `/v1/admin/users/{id}` |
| List coupons | Shows all campaigns with their use counts | `/v1/admin/coupons` |
| Create a coupon | Makes a campaign and returns its codes once | `/v1/admin/coupons` |
| Disable or enable a coupon | Switches a campaign off or on; can revoke unspent credits | `/v1/admin/coupons/{id}` |
| Adjust credits | Adds or removes credits for one user | `/v1/admin/users/{id}/credits` |
| Free-credit numbers | Shows this month's free credits, the cap and abuse flags | `/v1/admin/stats/free-credits` |
| Change the role | Makes a user an admin, or takes the role away | `/v1/admin/users/{id}/role` |
| Suspend, unsuspend | Puts an account on hold, or lifts the hold | `/v1/admin/users/{id}/suspend`, `/unsuspend` |
| Delete an account | Deletes the account, as the user's own deletion does | `/v1/admin/users/{id}` |
| Sign out everywhere | Ends every sign-in session of the user | `/v1/admin/users/{id}/sessions/revoke` |
| Show the welcome steps again | Clears the user's two first-run marks, so the web app shows the welcome steps and the "Getting started" checklist again | `/v1/admin/users/{id}/onboarding/reset` |
| One user's apps | Lists each connection; disconnects one, or asks Composio about it again | `/v1/admin/users/{id}/apps` |
| One user's chats | Lists the linked chats, with the chat id masked; unlinks one | `/v1/admin/users/{id}/channels` |
| One user's automations | Lists every automation; pauses, resumes or deletes any one | `/v1/admin/users/{id}/automations`, `/v1/admin/automations/{id}` |
| Apps in numbers | For each app: how many users connected it, its connections by state, and whether it can be connected here | `/v1/admin/apps/summary` |
| Failed jobs board | Shows the four job queues and their failed jobs | `/admin/queues` |
| Jobs | Lists the jobs of a queue in one state, newest first | `/v1/admin/jobs` |
| Job counts | How many jobs each queue holds, by state | `/v1/admin/jobs/counts` |
| Retry a job | Runs a failed job once more, with a reason | `/v1/admin/jobs/{queue}/{jobId}/retry` |
| Remove a job | Removes a failed or finished job, with a reason | `/v1/admin/jobs/{queue}/{jobId}` |
| Audit log | Every user's activity log, with filters | `/v1/admin/audit` |
| Turn timings | Where turns spent their time over the last days | `/v1/admin/timings/summary` |
| Response times | How long the api's requests took per route: p50, p95, p99 and the slowest | `/v1/admin/timings/requests` |
| Settings | The settings that shape behaviour, read-only | `/v1/admin/config` |
| Health | Whether each service the backend needs answers | `/v1/admin/health` |
| One user's agent | Shows the container, the engine, the AI and today's usage | `/v1/admin/users/{id}/agent` |
| Stop or wake a container | Stops a user's container (politely, or by force) or wakes it | `/v1/admin/users/{id}/container/stop` and `/wake` |
| Reset agent settings | Puts the engine, the Claude model, the effort or the browser switch back to the default | `/v1/admin/users/{id}/agent/reset` |
| A user's approvals | Lists them; cancels a waiting one | `/v1/admin/users/{id}/approvals`, `/v1/admin/approvals/{id}/cancel` |
| A user's crew jobs | Lists them; cancels one that has not started | `/v1/admin/users/{id}/crew-jobs`, `/v1/admin/crew-jobs/{id}/cancel` |

### Credit adjustments

- The admin sends an amount, a reason and an idempotency key. Sending the same key twice changes nothing the second time.
- **A positive amount** makes a new grant. It lasts 90 days, or until a date the admin gives, or forever if the admin says so. It pays any debt first.
- **A negative amount** is taken from the user's grants in the usual order. If the user has less, the rest becomes a debt.
- An amount of zero is refused. The reason shows in the user's credit history. Each adjustment goes to the audit log with the admin's id.
- Afterwards the AI budget is updated, and automations pause or resume as needed.
- This is the tool for goodwill credits, and for taking credits back after a dispute that Polar did not refund.

### Free-credit spend, abuse flags and failed jobs

- **Free-credit numbers.** One call shows the current month's numbers: sign-up credits granted and coupon credits granted. It also shows the cap, if one is set, and whether it is reached.
- **Abuse flags** come with the same call. A flag is one IP address from which 3 or more accounts redeemed coupons that month. Up to 50 addresses are listed.
- **Failed jobs.** A job that fails is retried, 5 tries in all, with waits of 5 seconds, 30 seconds, 2 minutes and 10 minutes. After the last try it is marked failed and an alert is logged. If `ALERT_WEBHOOK_URL` is set, the alert is also sent there. The board at `/admin/queues` shows the failed jobs. It opens in a browser for a signed-in admin.

### One user's apps, chats and automations

These tools are for support: a user writes in that an app won't connect, a chat should be unlinked, or an automation keeps failing. Each action works exactly like the user's own button, so nothing is left half done.

The rules for all of them:

- **A reason is required.** Every action asks for a short reason, up to 200 characters. A blank one is refused.
- **Every action is audited.** It writes one row in the activity log with the admin's id and the reason. The user sees the entry in their own activity log, for example "Textcrew support paused "Daily summary"". The admin's id and the reason are kept in the row but not shown to the user.
- **No secrets.** No Composio account id, token or secret is ever shown. A chat id or phone number is shown only masked: a Telegram chat keeps its last 4 digits ("•••• 3645"), a phone number its country code and last 4 digits. An automation's instruction text, its trigger settings and the chat it was made in are left out.

**Apps.**

- **The list** shows each of the user's connections in any state: the app, the state (active, pending, expired or failed), the account's label (usually its email), where the app's Composio setup comes from on this server, whether the app can be connected here, when the user started connecting it, and when the platform last heard from Composio about it. It reads our own table only; Composio is not asked.
- **Where the setup comes from:** `settings` means it is named in `COMPOSIO_AUTH_CONFIGS`; `server_made` means the server made it itself; `none` means there is none yet. With `none`, "can be connected" is still true when `COMPOSIO_MANAGED_APPS` lets the server make one on the first connect (section 14).
- **Disconnect** is the user's own disconnect: the account is removed at Composio and the connection is deleted. Like the user's own, it leaves the user's app-event automations as they are.
- **Recheck** asks Composio about that one connection now, whatever its state, and copies the answer: active, expired or failed. An account that Composio no longer has becomes failed, unless it was still pending. One still being set up stays pending and gets a fresh series of checks, as after a new connect. If Composio can't be asked, the api answers 503 and nothing changes.

**Chats.** The list shows each linked chat: the channel, what the user sees for it in Integrations → Chat apps, the masked chat id, when it was linked, whether the channel is switched on here, whether the user blocked the bot, and when the chat last wrote. Unlink is the user's own unlink, with the same activity log entry (section 7). The chat then gets the "not linked yet" reply.

**Automations.**

- **The list** shows every automation of the user, also the one-time reminders that already ran: the title, the kind, the moment or the schedule or the app event, the time zone, on or paused and why, the failures in a row, the last and next run, and for pull-request review the repo.
- **Pause** is the user's own pause: the timer is removed and app events for it are ignored. The paused reason is `admin`, so the user can see that Textcrew paused it. Adding credits does not switch it on again; the user or an admin can.
- **Resume** is the user's own resume: the timer is set again and the failure count goes back to 0.
- **Delete** is the user's own delete: the timer goes, and the Composio trigger with it. For pull-request review that is the watch on the repo, and with it the standing permission to post reviews there (section 19).
- A one-time reminder that already ran cannot be paused or resumed: the api answers 409.

**Apps in numbers.** For each app in the catalog: where its setup comes from, whether it can be connected here, how many users have a connection of it in any state, and its connections by state: active, pending, expired and failed. Numbers only, no user.

Example: Rahul writes that his Gmail shows "connecting" for an hour. The admin opens his apps, sees Gmail pending and last checked an hour ago, and presses recheck with the reason "ticket 41". Composio says it is active, so Gmail becomes active and the agent can use it. Rahul's activity log shows "Textcrew support checked the Gmail connection: active".

### One user's agent and container

These tools look at one user's agent and change a few things about it. They work only through the vm-manager's existing calls (section 32) and the backend's own functions, the same ones a turn or the user's own settings use. They never talk to Docker or to a container.

**The rules for all of them**

- Every change needs a reason. It goes to the audit log with the admin's id and the reason.
- The user's activity log shows a short line, such as "Textcrew support stopped the agent's container". It never shows the reason.
- A change that is refused writes nothing.
- No answer ever holds a container token, a Bridge secret, a LiteLLM key or an API key. For own keys, only the names of the providers are shown.
- An approval is shown without its inputs: only the action's name, its app and the short summary the user was shown. A crew job is shown without the brief's text, and without its report unless the admin asks for it (`?withReport=1`).

**The view** shows, for one user:

| What | Where it comes from |
|---|---|
| The container's state (none, stopped, waking, awake, busy, broken), busy or not, last active, the image, the memory in use | The vm-manager's `GetSandbox` |
| The engine and the browser switch the vm-manager has on record, and whether Claude Code has its sign-in | The same |
| The engine chosen and the one that really runs (section 30) | The backend |
| Claude plan connected, and since when. Never the sign-in | The backend |
| Claude Code's model and effort ("Default" shows as empty) | The backend |
| Scout's browser: on this server, wanted by the plan, on record | The backend and the vm-manager |
| What pays for the AI, the user's choice, the server's `AI_ACCESS_MODE`, and which providers have a key | The backend |
| Awake seconds, browser seconds and credits charged since midnight UTC | The 5-minute usage syncs (the last few minutes may be missing) |

The vm-manager does not report when a container woke, so there is no "awake since". If the vm-manager cannot be asked, the rest is still shown, and the container is marked "unknown".

**Stopping a container**

- By default the stop is polite, like the idle stop: Hermes saves to the user's folder first. The vm-manager refuses it while a turn runs, a message is being delivered or a Claude sign-in waits for its code. The admin gets "in use" and can try again later.
- **A stop by force is dangerous.** It ends the container at once, even in the middle of a turn, and Hermes does not save first. That turn fails as our fault: the user gets "Sorry, something went wrong on our side" and the turn's credits back. A crew job in that turn fails. Use it only for a turn that is stuck. The vm-manager's own 15-minute timer does the same to a stuck turn.

**Waking a container** is the same wake a turn makes. The container is made first if the user has none. Afterwards the engine and the browser switch are set again if they differ. The awake time is charged to the user, 1 credit per 10 minutes. So the user must have credits, and a container woken and left alone costs about a third of a credit before the idle stop. When the server is at its awake limit with nothing to stop, the admin is told to try again shortly.

**Resetting settings.** The admin picks any of four:

| Setting | Goes back to |
|---|---|
| The engine | Hermes. A connected Claude plan stays connected, and the user can choose Claude Code again |
| Claude Code's model | Default: Claude Code's own choice |
| The thinking effort | Default: Claude Code's own choice |
| Scout's browser switch | What the user's plan and the server say, as after a change of plan |

The same functions as the user's own settings make the change, so the vm-manager is told in the same way. If the browser switch cannot be sent, the other settings are still reset, and the admin is told to try again.

**Cancelling an approval.** Only a waiting one. It ends the way the 24-hour expiry ends one (section 15): it becomes "expired", the agent is not woken, and nothing can run with it. A late tap on its button gets "That approval was already answered or has expired."

**Cancelling a crew job.** Only one that waits (section 20). It is marked failed with "Cancelled by Textcrew support." and never runs. The user is told in the job's chat. A job that already runs cannot be stopped on its own: the Bridge has no way to stop one job. The admin is refused, and the job ends by itself within 15 minutes. A stop by force ends it now, as a failure on our side.

**Example.** Rahul writes to support that his agent "keeps using the wrong model". The admin opens his agent: Claude Code, Sonnet 4.6, effort max, the container busy. The admin resets the model and the effort with the reason "user report: wrong model". Rahul's next turn runs on Claude Code's own choice. His activity log shows "Textcrew support reset the agent's Claude model (back to Default), thinking effort (back to Default)".

### Jobs

The jobs list shows one state at a time: failed (the default), waiting, running, delayed or finished. It can show one queue, or the four queues one after the other. It comes in pages of 30, newest first within a queue.

For each job it shows its id, queue, name and state, the tries made, when it was added, started and finished, when a delayed job is due, and the user it is for. A failed job also shows the first line of its last error. Anything in that line that looks like a secret is replaced by "[redacted]".

A job's data is shown as ids only: the user, the event, the message, the automation, and so on. Every other field is left out, and only its name is listed. So the list never shows the text of a message, a button, a token or a key.

"Waiting" includes the jobs waiting with a priority. These are the inbound jobs of paying users, which go first.

- **Retry** works only on a failed job. The job goes back in line and runs once more, with no new tries after it. This is what the retry button of the board does. The job keeps its count of tries, so its own "last try" rules apply to this run. Every job checks "already done?" first (section 3), so a retry never does work twice. Example: a reply that was marked failed after its last try is not sent by a retry, because the job finds it is no longer waiting to go. A failed refund of a turn, retried, works the refund out again and gives back what it can.
- **Remove** works only on a failed or a finished job. A job that is waiting, delayed or running is never removed: the answer is "conflict", and nothing changes. A removed job's event keeps its status in the database.
- **Reason.** Both need a reason of up to 200 characters. The audit log gets the admin's id, the queue, the job's id and name, and the reason.

Removing a finished job has one effect to know about. A finished job is kept 7 days so that the same job cannot be added twice (section 3). Once removed, that guard is gone for it. The job's own "already done?" check still stops any double work.

### The audit log

The audit log is the activity log of every user in one list, newest first, in pages of 30. It can be narrowed to one user, one actor (user, agent, admin or system), one action, and a time window.

Each entry's details are shown with every field that holds a secret replaced by "[redacted]": passwords, tokens, keys, sign-in codes and cookies, at any depth. Text that looks like a secret is replaced too, for example a bearer token or a key in an address.

### Turn timings

The timings summary reads only the turn timings (section 9), for the last 7 days or up to 30. For each stage it gives how many turns had it, the median and the 90th percentile, in milliseconds. A stage counts only as long as it kept the user waiting.

The stages are the queue, preparing the message, the route, the quick reply, the wake (warm, cold, room made on the server, or the container made again, each apart), building the turn, the hand-over, the engine's start, the model's first output, the work, sending the answer and the wrap-up. "Total" is the time from the message being queued to the answer.

It also counts the turns per route, engine and outcome, and lists the 20 slowest turns: the user, when, the total and the biggest stage.

The median is the middle value, read between the two middle ones when the count is even. Example: four turns waited 100, 200, 300 and 400 ms in the queue. The median is 250 ms and the 90th percentile 370 ms.

### Response times

This page shows how long the api's own requests took, per route (section 4, "Response times", says how they are counted). It does not cover turns: those are in the turn timings above.

The admin picks the last hour, the last 24 hours (the default) or the last 7 days. The last hour is read from the 5-minute counts, the others from the hourly ones. The current 5 minutes or hour is included, so the window can reach up to one more back; the answer says where it starts.

For each route, and for all requests together, it gives:

- how many requests there were, and how many answered with a 4xx and with a 5xx;
- p50, p95 and p99: the time that half, 95 in 100 and 99 in 100 requests stayed under;
- the slowest request, exactly.

The routes are sorted by p95, slowest first. The percentiles are worked out from the buckets, so they are accurate to one bucket: off by at most a third, usually much less. The page never shows a user, an address with its ids, or a query.

Example: over the last 24 hours, `GET /v1/conversations` had 1,240 requests, 2 of them 5xx, p50 180 ms, p95 640 ms, p99 1,100 ms and the slowest 2,300 ms. Half the lists came back in under 0.2 seconds, and 1 in 20 took more than 0.6 seconds.

### Settings

The settings page shows the settings that shape what the backend does: the channels that are on, the crew, the browser, the waking during routing, the models, the apps the server may set up at Composio, the plan products, the limits and the addresses. An address is shown without any user name or password in it.

It is built from a fixed list, never by reading the whole environment. A setting that is not on the list is not shown. For each secret it says only whether it is set. For `COMPOSIO_AUTH_CONFIGS` it shows the app names, not the setup ids.

It also lists every app of the catalog with whether it can be connected on this server, and how: named in the settings, set up by the server earlier, allowed to be set up on the first connect, or not at all.

`AWAKE_CAP` is the vm-manager's own setting. The backend cannot read it, so the page shows it empty.

### Health

The health page asks Postgres, Redis, the vm-manager, LiteLLM and Composio, each with a limit of 3 seconds. For each it says ok, error or off, with a short message. Off means the service is not set up on this server, for example Composio without its key. For the vm-manager it also says how many containers there are and how many are awake. For Composio it checks that the key is accepted.

It also shows the backend's version and the deployed commit. The commit is there when the server was updated with `deploy.sh`, which passes it on as `GIT_COMMIT`.

Example: Composio's key was replaced and the old one is still in the settings. The health page says "composio: error, reachable, but the key was refused (401)".

### The account tools: the rules they share

- **A reason is required.** Each call carries a short reason. A blank one is refused.
- **Each is in the activity log.** One row for the user, with the admin's id and the reason. The user's own activity list shows only a plain line, such as "An admin suspended this account". The reason stays out of it.
- **Not on yourself, not on an admin.** An admin cannot remove their own admin role, suspend themselves or delete themselves. Another admin can be suspended or deleted only after their admin role is taken away. These answer "conflict" and change nothing. Showing the welcome steps again is the exception: it is harmless, so it works on any account, an admin's own too.
- **Twice is safe.** Setting the role a user already has, suspending a suspended account, lifting a suspension that is not there, or showing the welcome steps again to a user whose two marks are already empty changes nothing and writes no second row.

### Changing the role

1. The admin sends the new role (user or admin) and a reason.
2. The backend sets the role in Clerk first, in the user's public metadata, through Clerk's Backend API. If Clerk cannot be reached, or `CLERK_SECRET_KEY` is not set, the answer is "unavailable" and nothing changes.
3. Then it sets the role on our own row at once. The user's next request already has it.
4. Clerk then sends its usual "user updated" webhook. It carries the same role, so the two agree.

A suspended account cannot be made an admin: the suspension must be lifted first.

Example: Asha joins the support team. The founder makes her an admin with the reason "joins support". Her next page load shows the admin screens.

### Suspending an account

A suspension puts an account on hold until an admin lifts it. Nothing is deleted.

| What | While suspended |
|---|---|
| The web app | Every signed-in call answers 403 with the code `account_suspended`, the live stream too. The web app can say so plainly |
| Telegram and the other chat apps | Messages are saved but not answered. The chat gets one short notice at most once a day: "Your Textcrew account is suspended, so I can't answer messages right now." Files are not downloaded and voice notes are not transcribed. Link codes, `/new`, coupon codes and approval buttons do nothing |
| Web messages sent just before | Saved, never answered. The turn sees the suspension and stops |
| Automations | Those that are on, or paused because credits ran out, are paused with the reason "admin". Ones the user paused, or that were paused after failures, stay as they are |
| The container | Stopped politely through the vm-manager. If a turn is running, the vm-manager refuses; the turn finishes, its tool calls are refused, and the idle check stops the container 3 minutes later. It is never woken while the account is suspended |
| The container's own calls | The platform's tools and the git gateway refuse them |
| Crew jobs | One that was waiting fails with "The account was suspended when the job was due to start" |
| Credits and the plan | Unchanged. A paid subscription keeps renewing; cancel it apart if needed |

**Lifting it.** The account works again at once. The automations the suspension paused come back: switched on if the user has credits, or else paused for lack of credits, so they come back with the next credits like any other. The container wakes with the user's next message. Messages held during the suspension stay unanswered. The agent may see them in the chat's history, marked as earlier messages and not as requests.

Example: three people report spam from Ravi's agent. The founder suspends his account with the reason "spam reports". Ravi's Telegram messages get one notice that day and no answers. His daily summary does not run. A week later the founder lifts it. His summary runs again the next morning.

### Deleting an account

1. The admin sends a reason and the user's email, typed out as a check. If the email does not match, nothing happens. Letter case and spaces around it don't matter.
2. The backend deletes the user in Clerk, through its Backend API. If Clerk cannot be reached, nothing changes. If Clerk no longer has the user, the backend goes on.
3. It marks the account deleted at once, so every sign-in is refused, and adds the same delete job a user's own deletion adds (section 6): the container and the user's folder through the vm-manager's `DeleteSandbox`, the LiteLLM key, app connections, automations, linked chats, conversations, messages, files, memories, approvals and the activity log. A renewing subscription is set to not renew. Section 33 has the steps.
4. Clerk's "user deleted" webhook arrives later, finds the account deleted already, and adds nothing.

The activity-log row keeps the admin's id, the deleted user's id and the reason. Never the email or the name. It is the one row of the user's activity log that the delete job leaves, so there is a record of who deleted the account and why. A second delete of the same account answers "not found".

### Signing a user out everywhere

The backend asks Clerk to end every active session of the user. The answer says how many were ended. A session token the browser already holds still works until it expires, about one minute, because the api checks tokens without asking Clerk each time. After that the user must sign in again. This does not suspend the account.

### Showing the welcome steps again

The admin sends a reason. The backend clears the user's two first-run marks (section 6, "The first visit to the web app"). On the user's next visit the web app shows the welcome steps, then the "Getting started" checklist while any of its steps is left. Nothing else changes: not the plan, the credits, the chats or the apps.

- The activity log gets one row: "An admin set this account to show the welcome steps again". Its details keep the admin's id, the reason and the two times that were cleared. The user's own activity list shows only that line.
- When both marks are already empty, nothing changes and no row is written. The answer says `changed: false`.
- A deleted account answers "not found".

Example: Ravi skipped the welcome steps and later asks support for a tour of the app. The founder shows him the welcome steps again with the reason "asked for the tour". His next visit starts with them.

### The overview

One call gives the platform's numbers, and only numbers: no name, email, id or text.

| Number | What it counts |
|---|---|
| Accounts | Accounts that are not deleted; the deleted ones apart |
| New today, new in 7 days | Sign-ups since midnight UTC, and in the last 7 × 24 hours. An account deleted since still counts: it signed up |
| Active in 7 days | Accounts that sent at least one message in the last 7 days, on any channel. The agent's answers don't count |
| Plans | Accounts that are not deleted, on Free, Pro and Max |
| Turns today, in 7 days, and the failed ones | From the turn timings (section 9, kept 30 days). Failed means the turn ended in an error or failed |
| Awake containers | Containers waking, awake or busy now, as the vm-manager lists them. Empty when it can't be asked |
| Credits this month | Granted: every grant made since the first of the month (UTC), from any source; refunds and chargebacks are left out. Spent: credits charged since then, less the charges of failed turns given back |
| Open approvals | Approvals still waiting for an answer and not expired |
| Failed jobs | Failed jobs in the four queues, kept 30 days. Empty when the queues can't be read |
| Waitlist | Everyone on it, and those still pending |

Each number is asked of the module that owns its table (section 2). When the vm-manager or Redis does not answer, its number is empty and the rest still come.

### Users and one user's page

**The list** shows every account, newest first, in pages of 30, deleted and suspended ones too. Search looks for part of an email or a name, in any letter case, or a whole user id. A `%` or `_` typed in the search is a letter, not a wildcard. For each user: the email, the name, the time zone, the plan, the role, active, suspended or deleted, the chargeback mark, when they joined, when they last sent a message, the balance, the engine they chose, the kinds of chat linked (never a chat id or number) and how many app connections are active.

The list and one user's page also show the two first-run marks, with the same meaning as in `GET /v1/me` (section 6): when the welcome steps were finished or skipped, and when the "Getting started" checklist was closed, each empty when not yet. "Showing the welcome steps again" above clears both.

The balance is worked out from the grants, the same way as everywhere else (section 23). No balance number is stored for it.

**One user's page** adds, in one call:

- the Polar subscription, with its own plan when there is one;
- the grants that make up the balance, and the last 20 changes in the credit history;
- the app connections: the app, the state and when it was connected, never a token or the account's name;
- the automations that are not finished: the title, the kind, on or paused and why, the next and last run, never the instruction;
- the last 20 crew jobs: the member, the repo, the state, when given and finished, never the brief or the report;
- the last 20 turn timings: the stages and their milliseconds only (section 9);
- the last 20 activity-log entries: the one-line summary the user sees, never the details behind it;
- the engine chosen, the one that runs and what pays for the AI;
- the container's state from the vm-manager, empty when it can't be asked.

It never holds a message, a memory, a key, a token or a coupon code. The tools above (one user's apps, chats, automations, agent and container) give more of each part, and the actions on it.

### A plan set by hand

The admin picks Free, Pro or Max and may give a reason. The backend takes the same steps as the founder's script (section 27): the plan, the LiteLLM key's models and budget, Scout's browser switch, and the priority from the next message. There is no payment and no credits are given.

- The activity log gets one entry: "Plan set to Max by hand (no payment)", with the reason after it, and the admin's id, the old and the new plan in its details.
- Setting the plan the user already has changes nothing and writes nothing.
- A deleted account is refused (conflict).
- The answer says the old plan, the new one, whether it changed, and the Polar subscription. A subscription that still runs keeps its own plan: its next event from Polar can set the plan again. The panel warns about it.

Example: the founder moves Priya from Pro to Max for a week to test Scout's browser, with the reason "testing Scout". Her browser is on from the agent's next start. Her Pro subscription renews as Pro, so at the renewal she is on Pro again.

### The admin panel

The panel is a Next.js app of its own (`personal-agent-admin-panel`), deployed apart from the web app, for example at `admin.textcrew.in`. Its README says how to put it live.

- **Who gets in.** Anyone can reach the sign-in page. After sign-in the panel asks the api who is signed in. Someone without the admin role sees "Admins only". Every admin call checks the role again in the backend.
- **What it can reach.** The panel's pages call its own server, which adds the Clerk session token and forwards only two kinds of call: "who is signed in" and the admin calls. Nothing else of the api, and no webhook.
- **The backend must know it.** Its address goes in `CLERK_AUTHORIZED_PARTIES`, next to the web app's. Without it every call answers "unauthorized".
- **Every action asks first.** Each one opens a dialog that says what will happen and asks for the reason that goes to the audit log. Adjusting credits makes one idempotency key per adjustment, kept while the form stays the same, so sending again after a lost answer can't apply it twice.
- **Coupon codes** are shown once, on the screen that made them, with a button to copy them all.
- **On a phone** it works with four tabs and a "More" page.
- **With nothing set** it runs on made-up users and needs no backend, for trying it out.

---

# Part D. Containers and operations

## 32. Containers: what the backend asks for

This section lists every request the backend can send about a user's container. A container is a closed box on the server that runs one user's agent.

The backend never talks to Docker, the program that runs containers, and never to a container itself. It asks the vm-manager, which does the work. Every request carries a shared secret, the setting `VM_INTERNAL_SECRET`. A request without the right secret is refused. A "turn" below means one piece of work by the agent: one message in, one answer out.

| Call | What it does | When the backend makes it |
|---|---|---|
| `CreateSandbox` | Makes the container and the user's folder. Leaves it stopped | At sign-up, and before a turn if none exists |
| `WakeSandbox` | Starts the container and waits until it is ready. Says where its time went: a wait for another operation on the container, making room under the awake cap, a container made again, the start, and the Bridge's ready check | At the start of every turn, from the moment the message is one Jev will judge (section 9) |
| `Deliver` | Hands one message in and streams events back | Once per turn, right after the wake |
| `Touch` | Notes that the user was active just now | On every tool call and git call from the container |
| `StopSandbox` | Stops a container, politely or by force | Politely, right after a crew job, so the container sleeps at once (section 20). Otherwise the vm-manager stops containers by its own rules |
| `DeleteSandbox` | Removes the container and the user's folder | When an account is deleted |
| `GetSandbox` | Reports one container's state | For the agent status in the web app, and for checks |
| `ListSandboxes` | Lists all containers | Nightly backup, and the health check every 5 minutes |
| `GetUsage` | Reports awake seconds and browser seconds per user | Every 5 minutes, and in each turn's billing job |
| `SetEgressAllowlist` | Replaces the user's allowed domains and own MCP servers (tool servers the user adds) | When the user changes their own MCP servers |
| `SnapshotVolume` | Packs the user's folder into one archive file | Nightly backup, once per user |
| `SetAgentRuntime` | Chooses the engine: Hermes or Claude Code | When the user's AI settings change |
| `SetBrowser` | Switches Scout's browser on or off | After a plan change, or after a wake if it differs |
| `StartClaudeLogin` | Starts the Claude sign-in in the container. Returns a link | The user asks to connect a Claude plan |
| `CompleteClaudeLogin` | Passes the user's code to the waiting sign-in | The user pastes the code from Anthropic's page |
| `ClaudeLogout` | Signs Claude Code out in the container | The user disconnects their Claude plan |

Example: a user texts "What is on my calendar?". The backend sends `WakeSandbox`, then `Deliver`. Each tool call the agent makes sends a `Touch`. After the turn, its billing job sends `GetUsage` to charge the awake time.

## 33. The life of a container

This section follows one container from the day it is made to the day it is deleted. It also says who decides when a container starts and stops.

Each user has one container, named `pa-sbx-` plus the user id. Each user also has one folder, a Docker volume named `pa-data-` plus the user id. The container is made once and started and stopped many times. The folder holds everything the agent keeps for the user.

### The states

| State | Meaning |
|---|---|
| none | The user has no container yet |
| stopped | Not running. It uses no memory. The user's files are kept |
| waking | Starting. A place on the server is already reserved |
| awake | Running and ready. No turn is in progress |
| busy | In the middle of a turn |
| broken | It would not start, or it stopped answering. It is stopped, and an alert is written |

### Creating a container

1. A new user signs up. The worker gives the sign-up credits and makes the user's key for the model gateway. The gateway is LiteLLM, the service that all AI model calls pass through. Then the worker sends `CreateSandbox`.
2. The vm-manager makes the user's folder, the container, and two random secrets: the container's token for the platform's tools, and the Bridge secret. The Bridge is the small program inside the container that takes messages in. The container stays stopped.
3. It writes a small settings file into the user's folder: the secrets, the gateway key, the time zone, the user's own MCP servers, the engine and the browser switch.
4. It keeps only a hash of each secret, and returns the token's hash. A hash is a one-way fingerprint: the secret cannot be read back from it.
5. The backend saves that hash in the table `sandbox_tokens`. This is how it later knows which user a container's call belongs to.

### Waking, in steps

1. The backend checks that the user has credits. At zero credits nothing is woken, and the user is told. A suspended account's container is never woken, and nothing is said in the turn (section 31).
2. The backend sends `WakeSandbox` with the user's plan priority. The vm-manager locks this user, so two operations never overlap.
3. If the container is already running, the vm-manager answers at once.
4. It checks the limit on awake containers and reserves a place. The state is "waking".
5. It makes the container again if the agent image is new, the container is missing, or the browser switch changed. The user's folder is kept.
6. It starts the container and asks the Bridge "are you ready?" again and again, for up to 90 seconds.
7. It writes this container's rule for the egress proxy, the only way out of a container. The state is "awake", and an awake period opens for credits. "Awake" and the time of last activity are written in one statement, one trip to the vm-manager's database.

If the start or the ready check fails, the vm-manager makes the container again from the image and tries once more. If that fails too, the state is "broken". After a good wake, the backend checks the engine and the browser switch, and sends the right value if one differs.

Support can also wake a container from the admin tools (section 31). It is the same wake, and the user must have credits for it.

### Delivering a message

The backend sends `Deliver` with the message text, the chat it came from and a delivery id. The vm-manager counts the delivery as "in flight" and passes it to the Bridge. From then on nothing may stop the container. The turn's start is written as activity at the same time, and the Bridge does not wait for that write: the delivery in flight already keeps the container awake, and the turn's end writes the activity again. Events come back as a stream:

| Event | Meaning | What the backend does |
|---|---|---|
| accepted | The Bridge took the message | Marks the message "processing". The web app shows "busy" |
| working | A progress line, such as "Scout: reading 4 pages" | Shows it in the web chat. Crew lines also go to the activity log |
| turn done | The turn finished | Marks the message "delivered" and charges the usage |
| error | The turn failed. It says whether the fault is ours | Tells the user. If the fault is ours, gives the credits back |

The answer itself is not in this stream. The Bridge sends it through the platform's `send_message` tool, and the backend passes it to Telegram or the web app. If the same delivery id arrives twice, the Bridge does not run the turn twice.

### Stopping

| Who stops it | When | How |
|---|---|---|
| The idle check, every minute | Awake, quiet for 3 minutes, no turn, no delivery in flight | Politely |
| The backend, after a crew job | The job's turn has ended | Politely. Refused while a turn runs, a delivery is in flight or a Claude sign-in waits; the idle check then does it later |
| The backend, when an admin suspends the account | At once | Politely, refused in the same cases. The idle check then does it, and nothing wakes it again until the suspension is lifted |
| The limit on awake containers | Another user needs the place | Politely |
| The stuck-turn timer | A turn runs longer than 15 minutes | By force |
| The health check | The container does not answer, even after restarts | By force, then "broken" |
| Support, with the admin tools (section 31) | An admin asks, with a reason | Politely, refused like the backend's own stop. By force only when the admin says so |

A container is never stopped in the middle of a turn, unless the turn is stuck or support stops it by force. "Quiet" means no delivered message, no tool call and no git call. Each of those resets the clock. A Claude sign-in that waits for its code also keeps the container awake. A polite stop goes like this:

1. The vm-manager tells the Bridge to shut down. Hermes saves its memory to the user's folder, within 20 seconds.
2. Docker stops the container. A stop by force skips step 1 and ends it at once.
3. The container's proxy rule is removed, because its network address can be given to another user next.
4. The awake period is closed, so billing has the exact awake seconds. The state is "stopped", and the memory is free.

A stuck turn ends like this. After 15 minutes the vm-manager ends the container by force and reports an error marked "our fault". The backend gives the credits of that turn back and tells the user to try again. The next message wakes the container again, with its files.

### The limit on awake containers

The vm-manager's setting `AWAKE_CAP` is the most containers that may be waking, awake or busy at once. It counts containers, not memory. The plan also sets the place in the message queue: Max first, then Pro, then Free. When a wake arrives and the server is at the limit:

1. The vm-manager looks for a container it may stop: awake, not in a turn, nothing in flight, no Claude sign-in waiting.
2. It picks the lowest plan first: Free, then Pro, then Max. Among equals it picks the one quiet the longest.
3. It stops that container politely and wakes the new one.
4. If no container may be stopped, it answers "full". The backend's job tries again after 5 seconds, 30 seconds, 2 minutes and 10 minutes.
5. If the fifth try fails too, the job fails and an alert is raised. The user gets no message about it.

Example: the limit is 3 and three containers are awake. A Free user was quiet for 2 minutes and a Pro user for 1 minute. A Max user is in a turn. A fourth user texts. The Free user's container is stopped, and the fourth one wakes.

### What is kept and what is deleted

A stop keeps everything in the user's folder: the engines' memory and chat sessions, the Claude sign-in, the workspace with files and cloned code, and the browser's profile. A new agent image keeps the folder too. Only deleting the account removes it:

1. `DeleteSandbox` removes the container, the user's folder, the proxy rule and the vm-manager's record. Awake periods stay for billing history.
2. The backend removes the token record, the agent settings, the shared memories, the record of which engine ran each chat, the turn timings, the approvals (with the exact inputs each was asked for, such as an email's recipient), the chat links, the conversations, the messages and the uploaded files.
3. The user's gateway key is revoked, and a paid subscription is set to not renew. The user's own AI keys, their own MCP servers, automations (with their Composio triggers) and crew jobs are removed.
4. App connections are removed, at Composio first, which drops the app's sign-in.
5. Last, the activity log, with the inputs of every action. The one row that stays is an admin's record that they deleted the account (section 31). It goes last so that a row written by an earlier step does not stay behind.

Each module deletes its own tables. Every step is safe to run again, so a job that stopped half-way is simply run again. The steps that ask outside services (LiteLLM, Polar, Composio) come after the user's own data, so a failure there holds back as little as possible.

**When Composio cannot remove an app.** That connection keeps its row and the job fails. It is tried again like any job: 5 tries, with waits of 5 seconds, 30 seconds, 2 minutes and 10 minutes, then an alert. An admin can then run it once more from the Jobs page (section 31). An app that Composio no longer has counts as removed. Example: Composio is down for a minute when Priya deletes her account. Her messages, approvals and memories go at once. Her GitHub connection waits; the next try, a few seconds later, removes it at Composio and then her activity log.

**What stays after a deletion.**

| What | Why |
|---|---|
| The `users` row, marked deleted, with the email and the name still in it | The admin list shows deleted accounts. Nothing removes the email and the name yet |
| Credit grants, the credit ledger, usage periods, payments and subscriptions | Money records. The ledger is never edited (Part C) |
| Coupon redemptions, with the IP address | One redemption per coupon and user, and the abuse flags (section 29) |
| An admin's record that they deleted the account | Who deleted it and why (section 31) |
| Saved webhooks in `events`, such as a Telegram message as it came in | The daily clean-up removes finished ones after 30 days. A failed one stays |
| The vm-manager's awake periods | Billing history |
| The nightly backups | A dump folder goes after `BACKUP_KEEP_DAYS` days, 7 by default. The archives of users' folders are never deleted (section 37) |

### The health check and the reconciler

The health check runs every 30 seconds on each awake container that is not in a turn. After 2 failed answers in a row it restarts the container. After more than 3 restarts with no good answer, it stops the container and marks it "broken".

The reconciler compares the vm-manager's table with what Docker really runs. It runs when the vm-manager starts and every 5 minutes.

- The table says running but Docker does not run it: it is marked stopped, and the awake period is closed.
- Docker runs it but the table says stopped: it is stopped politely.
- A "waking" or "busy" state is left over from a vm-manager restart: it becomes "awake" if the Bridge answers, else "stopped".
- A container has no record, or a proxy rule belongs to a user who is not awake: it is removed. A user's folder is never removed here.

### What can go wrong

- The container will not start: one retry, then it is made again from the image, then "broken". The next message tries again.
- The vm-manager restarts during a turn: the stream breaks and the backend's job tries again. The Bridge knows the delivery id and does not run the turn twice.

## 34. Inside the container

This section says what runs inside each user's container, what it may use, and which secrets it holds. The agent image has four things in it: the Bridge, the Hermes agent, Claude Code, and Chromium for the browser.

### The Bridge

The Bridge is a small program that is the only door into the container. Only the vm-manager calls it, and every request but the ready check needs the Bridge secret. It takes four kinds of request: a ready check, a message to deliver, a shut-down, and the Claude sign-in. When the container starts, the Bridge does this:

1. It reads the settings file the vm-manager wrote.
2. It writes Hermes's own settings from it: the model gateway with this user's key, and the platform's tool server with this container's token. The tool server is where the agent calls the platform's tools, such as sending a message or running an app action.
3. It starts Hermes, sets up Claude Code, and prepares the browser if the browser is switched on.
4. It opens its door for the vm-manager.

One turn goes like this:

1. The Bridge reads which engine to use. It reads this for every message, so a switch needs no restart.
2. It hands the message to that engine in the chat's own session. Each chat keeps its own conversation.
3. The engine works: model, tool call, result, and so on, until it has a final answer.
4. The Bridge sends the final answer through the platform's `send_message` tool and reports "turn done". The agents cannot call that tool themselves.

When the delivery asks for it (web chat, section 12), the Bridge also reports the answer while it is being written: the whole text so far, at most four times a second. It takes only the lead's own words. Claude Code gives them when it is started with its "partial messages" switch, which the Bridge adds only for such a turn; Hermes gives them in its run's event stream. The text starts over when the lead starts a new message or calls a tool.

Risky actions never wait inside a turn. The agent asks the platform for approval, gets "pending", and ends its turn. The user's yes or no arrives later as a new message.

**Where the turn's time went.** The Bridge times each turn from the moment it takes the delivery, and reports the times with the turn's last event: when the engine started, when it was ready (for Claude Code: the program is up and has asked its tool servers for their tools), the model's first response and the start of its thinking (web chat turns only, where the Bridge sees the model's own stream), the lead's first words and first tool call, the time spent in the lead's own tools and in specialists, when the engine finished, and when the answer was sent. Claude Code also gives its own numbers: its total time, the time in calls to the model, the number of model rounds, and the token counts with the prompt cache. Only names and numbers: no text the user or the agent wrote. The worker stores them with its own (section 9, "Where a turn's time goes").

**Fewer waits around a turn.** The Bridge sends each answer through the platform's tool server, which answers every request on its own. So it introduces itself to that server once per container start, then sends each answer in one request. Before, every answer took three round trips through the egress proxy. Claude Code's two settings files, its tool servers and the hook that keeps the lead off the web, are written only when what they hold changes, not before every turn. On Hermes, after the first check that no specialist is still at work, the second check comes after half a second instead of 2 seconds, so the answer's last round starts sooner.

### The two engines

| | Hermes | Claude Code |
|---|---|---|
| What it is | An open-source agent | Anthropic's own program, not changed |
| Whose AI it uses | The platform's models through the gateway, or the user's own API key | The user's own Claude plan |
| Who pays for the AI | Credits, or the user's own key | The user's Claude plan |

Both engines get the same instructions for the lead each turn, and they open with who the lead is. Each engine has an identity of its own in its own system prompt: Claude Code's says "You are Claude Code". So the lead once sent the founder to "your Claude settings" to connect Google Calendar. The opening now says:

- Tex is the user's own agent in Textcrew.
- The user connects apps on Textcrew's Apps page, `https://app.textcrew.in/apps`.
- To see what is connected, use `get_profile` and `list_app_actions`. If an app the user calls connected is missing, it may still be finishing, or it needs connecting again on the Apps page.
- Never send the user to the settings of Claude or any other product. Never present itself as Claude or Claude Code, and name the engine behind it only when the user asks.

Claude Code runs when the user has connected a Claude plan and chosen it. Hermes runs in the other cases: on the user's own API key, or on credits if the server offers Textcrew AI. A user who chose Textcrew AI gets Hermes on credits, as long as the server offers it. If a Claude plan is the user's only AI, Claude Code runs even when Hermes was chosen. With no AI at all, nothing runs, and the user is told to connect one.

The Claude sign-in happens inside the container. Claude Code shows a link, the user signs in on Anthropic's page, and pastes a code back in the web app. Claude Code keeps the sign-in in the user's folder. The platform stores only the time of connection, never the code or the sign-in.

### The crew, as defined in the container

The crew is defined once, inside the Bridge, and given to both engines. Tex is the lead. Byte, Patch and Scout are the specialists.

| Member | Job | Tools |
|---|---|---|
| Tex (lead) | The one the user texts. Plans, hands out work, writes the answer | Files, the shell, platform tools, the user's own MCP servers. No web |
| Byte | Writes or fixes code on a new branch and opens the pull request | Files (read and write), search, the shell, platform tools. No web |
| Patch | Reviews a pull request and posts one review. Never changes code | Files (read only), search, the shell, platform tools. No web |
| Scout | Researches on the web and returns a short answer with links | Web search, the page reader, the browser when it is on. Nothing else |

- Only Tex may start a specialist, and a specialist cannot start another one. At most 3 work on one job.
- Only Scout uses the web. Scout has no files, so a web page cannot make it read a secret and send it out.
- When a specialist starts and ends, a progress line goes out: "Scout: researching flight options", then "Scout: done".

On Claude Code the tool lists are locks: a tool that is not on a member's list cannot be called. Tex's own calls to a web tool are refused by a small check that runs before each call. On Hermes the tool lists are only instructions, because Hermes cannot give each member its own tools.

Example: the user asks to fix a typo in a repository and have it checked. Tex hands the fix to Byte, who opens a pull request. Tex then hands the pull request to Patch, who posts one review. Tex writes the answer.

### Crew jobs in the container

A crew job (section 20) arrives as one delivery, marked as a job with its id and its member. The Bridge makes sure it leaves nothing behind, whatever the agent does:

1. **Before the turn** the Bridge makes an empty folder for the job, `workspace/jobs/<the job's id>` in the user's folder. Tex is told the folder, and that all the job's work happens in it: clone there, and start every program the job needs from inside it (an install, the app, a test runner), in the background when it keeps running.
2. **During the turn** Claude Code runs with the job's mark in its environment. Every program it starts carries the mark too, also one that went into the background or into another folder.
3. **After the turn**, whether it ended with an answer, a failure or a crash, the Bridge stops every program of the job. A program is the job's when it runs from inside the job's folder or carries the job's mark. It gets a polite stop, and a forced one after 5 seconds if it is still there. Then the Bridge deletes the folder. A progress line says so: "Patch: stopped 2 programs and deleted the job folder".
4. **When the container starts**, no job can be running, so any job folder still there is from a turn that never finished. The Bridge deletes them all.

Two jobs at the same moment keep out of each other's way: each has its own folder and its own mark. Another turn's programs, the Bridge itself and the Hermes program are never stopped. The Bridge never follows a link out of the jobs folder: it removes the link itself.

Patch and Byte have role text for a job too: work only in the job folder, stop every program you started before the report, and report in the job's shape. Patch posts nothing in a job; Tex posts the one review when the brief asks for it. What must be kept is pushed or is in the report: the folder is gone after the turn. The user's own folder, with the engines' memory and chat sessions, is not touched.

### The limits of each container

| Limit | Value | Why |
|---|---|---|
| Isolation | gVisor, a layer that stands between the container and the server's own system | Code inside cannot reach the server directly |
| Memory | 600 MB, with no overflow to disk. 2,048 MB with the browser | Many containers fit on one server |
| CPU and processes | 1 CPU, 256 processes. 1,024 processes with the browser | One user cannot slow down the others |
| Files | System files are read-only. Only the user's own folder can be written | Nothing can change the agent's own programs |
| Privileges | All removed, none can be gained, and the agent is not the root user | Least power |
| Network | The sandbox network only. No port is open to the outside | The only way out is the egress proxy |
| Restart and disk | It never restarts by itself. The user's folder has no size limit by default | The vm-manager decides when a container runs |

### The secrets a container holds

A container holds only its own secrets. They sit in the settings file in the user's folder, which only the agent's own user can read.

| A container holds | A container never holds |
|---|---|
| Its token for the platform's tool server | Composio's key, which opens the users' apps |
| Its Bridge secret | The model providers' keys |
| The user's key for the model gateway | The database password |
| The secrets of the user's own MCP servers (Max plan) | A GitHub token. The platform's git gateway keeps it |
| The Claude sign-in, when one is connected | Anything that belongs to another user |

The container's environment holds no secrets, only the user id, addresses and the proxy settings. The agent can read its own secrets file, but that affects only its own container.

### What can go wrong

- The Claude sign-in stopped working: the turn ends with "Connect your Claude plan again". The backend switches the user back to Hermes and says so.
- The container goes over its memory limit: it is ended, and the turn fails.
- The Bridge cannot send the answer: the turn ends as "our fault", and the credits are given back.

## 35. The way out: the egress proxy

This section says what a container can reach on the network. A container has no internet of its own. Everything it sends goes through one proxy, a program that passes requests on and may refuse them.

| Network | Who is on it | Reachable from the internet |
|---|---|---|
| edge | Caddy (the web server at the front) and the api | Only Caddy, on ports 80 and 443 |
| platform | The api, the worker, the vm-manager, the database, Redis, the model gateway, the proxy | No. These services can call out |
| sandbox | User containers, the proxy, the vm-manager | No, and it has no line out either |

### What a container may reach

Every container may reach three things: the model gateway, the platform's tool server at `/mcp`, and the platform's git gateway at `/git`. The git gateway passes git commands on to GitHub, so GitHub itself is not on the list. Anything else is refused, unless the user's own list allows it.

The vm-manager writes that list as one small rule file for each awake container. The rule names the container's own network address, so it helps no other container.

- It adds the domains of the user's own MCP servers. Only real host names are accepted, at most 200 per user.
- It adds Anthropic's addresses while Claude Code is the engine, or while a Claude sign-in is running.
- It is written at every wake and removed at every stop. After each change the proxy loads its rules again.

### The open rule for a container with Scout's browser

A browser must be able to reach any site. So a container that was started with the browser gets a different rule, checked in this order:

1. Refuse names without a dot, such as the platform's own service names, and private name endings.
2. Refuse private, internal and reserved addresses, also when a public name points to one. This covers the metadata address, an address inside a cloud server that hands out the server's own keys.
3. Allow the user's own domains.
4. Allow any other address on ports 80 and 443.

The rule belongs to the container, not to the browser. Every program in that container can use it. Example: a container without the browser asks for a news site and is refused. A Max user's container with the browser gets the page. The same container asking for the database by its service name is refused.

### What can go wrong

- The proxy is down: no container can reach the model gateway or the tools, so turns fail.
- The proxy does not load a new rule: the vm-manager writes an alert line. The user's own MCP servers or Claude stay out of reach.

## 36. Scout's browser

This section explains the real browser that Scout can drive. It is for pages that need JavaScript, clicks or a form, which the plain page reader cannot read.

The browser is Chromium, running without a window inside the user's own container. Only Scout drives it: a lock on Claude Code, an instruction on Hermes. A user has the browser when both of these hold:

1. The user is on the Max plan.
2. The server's setting `BROWSER_AVAILABLE` is on. It says that the deployed agent image contains the browser. It is off by default.

### How the backend switches it on and off

The backend always sends the wanted state, on or off, never "flip it". So sending it twice does no harm.

| When | What the backend does |
|---|---|
| A container is created | `CreateSandbox` carries on or off |
| The plan changes | A job named `sync-browser` reads the plan again and sends `SetBrowser` if the record differs |
| After every wake | It compares again and sends `SetBrowser` if the record differs |

The switch takes effect at the container's next wake. At that wake the vm-manager does three things. It makes the container again with the larger limits: 2,048 MB of memory and 1,024 processes. It tells the Bridge to offer the browser. It writes the open proxy rule. A running container never changes. Every switch is written to the activity log.

Example: a user upgrades to Max at 10:00 while their container is awake. The container stops after 3 quiet minutes, and the next message wakes it with the browser. A user who leaves Max while awake keeps the browser until the container stops, and pays for those minutes.

### How browser time is measured and charged

1. The Bridge looks once a second whether a browser process exists. The clock runs while one does.
2. The browser is closed by Scout, after 2 minutes without a browser call, or when the turn ends.
3. With the last event of the turn, the Bridge reports the whole seconds since its last report.
4. The vm-manager stores each report once, then passes the event on.
5. The backend's usage sync reads the seconds with `GetUsage` and turns them into credits.

- The price is 2 credits a minute, which is 1 credit for every 30 seconds. Part minutes carry over: 20 seconds now and 10 seconds later make 1 credit.
- Awake time is charged on top, at 1 credit per 10 minutes. The AI is charged apart.
- At zero credits the container is not woken, so no browser runs. Inside a turn the browser is not cut off.
- A turn given back as "our fault" gives its browser credits back too.

### What the browser refuses

A small guard program stands between the agent and the browser. It refuses:

- Any address that is not a normal web address. File addresses are refused, so the browser cannot read a file in the container.
- Every tool outside its list of 14. Uploading files, running code and taking screenshots are not on the list.
- File names in a call. They are dropped, so nothing is written into the user's workspace.

The proxy refuses internal addresses, as said above. Signing in to sites is not part of this version: Scout is told never to type a password or a code, and to report that a sign-in is needed. The user also has no view of the browser.

### What can go wrong

- The vm-manager is down when a plan changes: the job tries again. If it runs out of tries, the check after the next wake sends the switch.
- A heavy page pushes the container over its memory limit: the container is ended, and the turn fails.
- The time is measured inside the user's own container, where the agent could disturb it. It can never charge another user.

## 37. Operations

This section says how the running system is watched, backed up and brought back after a failure.

### Health checks

| Check | How often | What it looks at |
|---|---|---|
| The api's `/healthz` | When asked | Answers "ok" when the api is up |
| The worker's health check job | Every 5 minutes | Over 50 failed jobs in a queue, over 1,000 waiting, or the vm-manager out of reach |
| The vm-manager's container check | Every 30 seconds | The Bridge of each awake container |
| The admin health page, `/v1/admin/health` | When an admin opens it | Postgres, Redis, the vm-manager, LiteLLM and Composio, each within 3 seconds, and the deployed version and commit (section 31) |

### Logs, metrics and alerts

The api and the worker write one log line per request and per job. The request line has the request id, the route, the address without its query, the status, the time, the user and the IP (section 4). Every line written during a request carries its id. Fields that look like a secret are replaced by "[redacted]": passwords, tokens, keys, sign-in codes, login headers and cookies. Request contents, headers and queries are never logged. `aws-setup.md` section 13 shows how to read them on the server.

Each request's time is also counted in Redis per route, for the admins' response-time page (section 31).

The api serves numbers at `/metrics`: requests by path and result, and for each queue the jobs waiting, running, delayed, failed and finished. The page needs the secret in `METRICS_TOKEN`. Without that setting it answers "not found".

Admins can also look from the api, without a server login (section 31): the jobs of each queue with their errors, the count per queue and state, the audit log of every user, where turns spent their time over the last days, and the settings in use. A failed job can be run once more or removed there, with a reason that goes to the audit log.

An alert is an error line in the log, marked as an alert. If `ALERT_WEBHOOK_URL` is set, the same text is also posted there, for example to a Slack channel. The backend raises an alert in three cases: a job failed after all its tries, the backup failed, or the health check found a problem. The vm-manager writes its alerts only to its own log.

### The nightly backup and the restore test

The backup job runs every night at 02:00 on the worker's clock.

1. It dumps the whole backend database into one file, in a folder named by the date. The dump tool must be at least as new as the database; the image has version 18, the same as Neon. It uses the database address's encryption settings, and the password is passed in a way that never shows in the list of running programs.
2. It asks the vm-manager for all containers and has each user's folder packed into an archive file.
3. If `BACKUP_UPLOAD_CMD` is set, it runs that command to copy the backup off the server.
4. It deletes dump folders older than `BACKUP_KEEP_DAYS`, which is 7 by default.

The restore test is a script that is run by hand. It restores the newest dump into a scratch database and checks that the main tables and some users are there. It also checks that every archive opens.

### After a worker crash or a restart

Every job is safe to run again, so a job that did not finish is simply run again. When the worker starts, it also does this:

1. It puts saved events of the last 7 days that never finished back in the queue.
2. It registers the timer of every enabled automation again.
3. It registers the repeating jobs again: usage sync, credit expiry, approval expiry, clean-up, backup and health check.

A failing job is tried 5 times, with waits of 5 seconds, 30 seconds, 2 minutes and 10 minutes. After the last failure its event is marked "failed" and an alert is raised. A daily clean-up removes finished events older than 30 days, turn timings older than 30 days, and messages older than 365 days. A conversation that has had no message for 365 days, has none left and is not the active one is removed too, except the Automations chat.

### Rate limits on public endpoints

| What | Limit |
|---|---|
| Every endpoint, per visitor address | 600 a minute (`RATE_LIMIT_PER_IP_PER_MIN`) |
| Messages from the web app, per user | 30 a minute |
| New web chats, per user | 30 an hour |
| Link codes, per user | 10 an hour |
| Link code tries from one chat, linked or not | 10 an hour |
| Waitlist | 10 an hour per address, 5 an hour per email |
| Coupon codes | 5 an hour per user, 20 an hour per address |
| Starting a Claude sign-in, per user | 10 an hour |

Example: a person sends 11 link codes from one unlinked Telegram chat within an hour. The eleventh gets "Too many attempts. Please try again in an hour."

### What can go wrong

- The users' files are not copied off the server. With the default settings their archives go to a separate "volumes" folder, and the upload command is given only the dump folder. The command must name the volumes folder too.
- Old archives of users' files pile up: step 4 of the backup deletes only the dump folders. So a deleted user's files also stay in the archives made before the deletion, with no end date. Their database rows stay in the dumps for `BACKUP_KEEP_DAYS` days.
- One user's folder cannot be packed: the others still are, and one alert names the users that failed.
- `ALERT_WEBHOOK_URL` is empty: alerts are only in the logs.

## 38. The security rules

These are the rules that must never be broken. Each one closes a way in that would be costly to leave open.

| Rule | Why |
|---|---|
| Only Caddy is public | Every other service sits on a private network. From outside, `/mcp` and `/git` answer "not found" |
| A webhook is verified before anything else | A forged call from outside is refused before its content is read. A repeat is ignored |
| The Docker socket is only in the vm-manager | Whoever holds it controls every container on the server |
| The user id comes from the container's token | An agent cannot act as another user by naming another id |
| No platform keys in a container | A leaked container cannot act in users' apps or read the database |
| Secrets are encrypted, tokens and codes are stored as hashes | A stolen copy of the database gives no usable secret |
| Approvals before risky actions | Sending to others, deleting and paying need the user's yes. One approval fits one exact action, once |
| Every user query is filtered by user id | One user can never read another user's rows |
| Every action is in the activity log | The user can see what the agent did, and when |
| Every admin action on an account needs a reason and is logged | The admin's id and the reason are kept. An admin cannot demote, suspend or delete their own account, and must take another admin's role away before suspending or deleting them |
| A suspended account can do nothing | Its signed-in calls, its container's tool and git calls and its turns are all refused, and its container is not woken |
| Containers are locked down | gVisor, hard limits, read-only system files, no privileges, no internet of their own |
| No secrets in logs | A secret written to a log would sit there in plain text |

A webhook is a call that another service makes to the api when something happens there. Encrypted in the database are the secrets of users' own MCP servers, users' own AI keys, and the gateway keys. Stored as hashes are container tokens, link codes and coupon codes.

Example: an agent calls a platform tool and writes another user's id in its request. The platform ignores that id. It takes the user from the container's token, so the call acts for the container's own user.

Two things are left open on purpose. A Max user's container with the browser on can reach any public website. On Hermes, the crew's tool lists are instructions and not locks.

## 39. When something fails

This table says what the system does when one part stops working.

| What fails | What the system does |
|---|---|
| The router (Jev, which decides whether a message needs the agent) | Every message goes to the agent. Nothing is lost |
| One model provider | The gateway falls back from the stronger models to the cheap model |
| The model gateway itself | A Hermes turn that cannot reach its model fails as "our fault". Credits are given back |
| Composio | The tool tells the agent the app is unavailable. Nothing is charged, and a used approval is freed again |
| Polar (payments) | A checkout cannot be opened. A late webhook adds the credits when it arrives |
| Redis (it holds the job queues) | Jobs in the queue are lost. The worker rebuilds them from saved events when it starts |
| The vm-manager | Turns wait and retry for about 13 minutes, then fail with an alert. The rest of the api keeps working |
| A container that will not start or stops answering | Retried, restarted or made again from the image. If nothing helps, it is marked "broken" |
| A turn over 15 minutes | Stopped by force. Credits are given back and the user is told |
| Telegram | Sending is tried 5 times, then the message is marked "failed" |
| The worker | Unfinished jobs run again when it is back |

Example: Composio is down while the agent tries to send an email the user approved. The agent tells the user that Gmail is unavailable right now. When Composio is back, the same approval still works.

## 40. What the database holds

This section lists every table of the backend's database, grouped by the module that owns it. A module reads another module's tables only through that module's own code.

### Where the database lives

There are three databases: the backend's, the vm-manager's and LiteLLM's. Each program has its own and none reads another's.

- **On the laptop** they are in one `postgres` container, which starts only when Docker Compose is given the `localdb` profile.
- **On the server** they moved to Neon, a managed Postgres, on 14 October 2026. The Neon project is in Ohio while the server is in Mumbai, so each query takes about 260 ms there and back. You chose Ohio knowing this. Opening a new connection takes longer, about 1.5 to 2.5 seconds, so the api and the worker each keep 10 connections open at all times and check them every minute (section 4, "Keeping reads fast").
- The server's addresses come from three settings in `compose.env`: `BACKEND_DATABASE_URL`, `VM_MANAGER_DATABASE_URL` and `LITELLM_DATABASE_URL`. All three use Neon's direct address, not its pooled one: LiteLLM's table set-up and the vm-manager's migration lock do not work through the pooler, and the nightly copy needs the direct address too.
- The backend's database on Neon is called `agent`, like today. Neon's ready-made `neondb` belongs to the landing page's waitlist.
- The connection is encrypted and the server's certificate is checked. The admin settings page says only whether the database address is set, never the address itself.

| Module | Table | What it holds |
|---|---|---|
| auth | `users` | One row per person: email, name, time zone and whether anyone set it, plan, role, whether an admin suspended the account (and since when), and the web app's two first-run marks: when the welcome steps were done and when the "Getting started" checklist was closed (section 6) |
| auth | `link_codes` | One-time codes to link a chat app, stored as hashes, with an expiry |
| auth | `channel_links` | Which chat belongs to which user |
| auth | `waitlist_entries` | People waiting for access, with request details for abuse checks |
| auth | `waitlist_attempts` | Every waitlist try, also repeats and blocked ones |
| events | `events` | Everything that came in, saved once, with its status |
| channels | `messages` | Every message in and out, with its channel, its conversation and its status. A message written during a turn keeps the turn's id. A copy sent to Telegram keeps the id of the message it copies |
| channels | `conversations` | One row per conversation: its chat, its kind (a chat, or the user's one Automations chat), its number in that chat, its title, its start and last-message times, and if it is the active one |
| channels | `chat_epochs` | Each chat's counter: the highest conversation number given out in it. It only goes up, so a number is never used twice |
| channels | `attachments` | Files uploaded in the web app or received in a chat |
| orchestrator | `sandbox_tokens` | The hash of each container's token and the user it belongs to |
| orchestrator | `agent_settings` | The chosen engine, the AI choice, when Claude was connected, and Claude Code's model and thinking effort |
| orchestrator | `approvals` | Risky actions waiting for a yes or no, with their exact details |
| orchestrator | `memories` | Short facts about the user that every engine gets |
| orchestrator | `chat_engines` | Which engine last finished a turn in each conversation |
| orchestrator | `turn_timings` | Where each turn's time went, stage by stage, for 30 days. Never any text (section 9) |
| integrations | `connections` | A user's connected app accounts, their status, and when Composio last answered about each |
| integrations | `composio_auth_configs` | The Composio setups the server made itself, one per app. Not per user |
| integrations | `user_mcp_servers` | The user's own MCP servers, with the secret encrypted |
| integrations | `composio_triggers` | Made for app triggers. No code reads or writes it today |
| integrations | `byok_keys` | The user's own AI keys, encrypted, plus the last 4 characters |
| automations | `automations` | Reminders, repeating tasks and app-event tasks, each with the chat it was made in. Its runs answer in the Automations chat. A column that held a conversation per automation until 13 October is no longer used |
| automations | `pr_reviews` | One row per reviewed pull-request commit, so none is reviewed twice |
| automations | `crew_jobs` | One row per crew job: the brief, where the report goes, its state, and the report itself |
| billing | `subscriptions` | Each paid plan: user, Polar id, status, period |
| billing | `payments` | Polar orders seen, to trace refunds back to a user |
| billing | `credit_grants` | Each batch of credits: source, amount, what is left, expiry |
| billing | `credit_ledger` | Every change to credits. Rows are only added, never changed |
| billing | `usage_periods` | One row per charged period: AI cost, awake time, browser time, credits |
| billing | `litellm_keys` | Each user's gateway key, encrypted, the spend seen so far, and the LiteLLM model that holds their own API key, if any |
| billing | `coupons` | Coupon campaigns: credits, limits, expiry |
| billing | `coupon_codes` | The codes of a campaign, stored as hashes |
| billing | `coupon_redemptions` | Who redeemed which campaign, once per user |
| admin | `audit_log` | The activity log: who did what, when, and credits charged. An admin's action also keeps the admin's id and reason |

No table holds a "balance" number: the balance is the sum of what is left in a user's grants. The vm-manager has its own small database with three tables: `sandboxes`, `awake_periods` and `browser_usage`. The backend never reads it directly. Example: one Telegram message adds one row in `events` and two rows in `messages`: the message and the answer. The first message of a chat also adds one row in `conversations` and one in `chat_epochs`. It also adds entries in `audit_log`, and one row each in `usage_periods` and `credit_ledger` for the charge.

## 41. The API in words

This section says what the web app can do through the api, group by group. Almost every call needs a signed-in user. The plan list, the waitlist and the health check are public. Admin calls need the admin role.

| Group | What it lets the app do |
|---|---|
| Profile | Read the user's name, plan and credit summary, whether a time zone was ever set, and the two first-run marks (welcome steps done, checklist closed). Change the name and time zone, and set or clear the marks. The app sets the time zone from the browser once, while nobody has set one |
| Channels and linking | See linked chat apps and which channels are on. Get a one-time code to link Telegram. Unlink a chat |
| Chat and the live stream | List the conversations, with the Automations chat apart if asked. Start a new web conversation, open an earlier one, rename or delete one (the Automations chat keeps its name and cannot be deleted). Read the messages of one conversation, or of all. Send a message into the active web conversation or into one the app names. Upload a file up to 10 MB. Keep a live stream open |
| Approvals | List approvals, the waiting ones by default. Approve or reject one |
| Apps | See the app list with status and plan, and which apps can be connected on this server. Start connecting an app. Disconnect one |
| MCP servers | List the user's own MCP servers. Add one (Max plan), rename it, switch it on or off, remove it |
| Own AI keys | See which providers have a key and which one is in use, never the key itself. Set, replace or remove one |
| Automations | List reminders and automations, with why one is paused (by the user, after failures, out of credits, or by Textcrew support). Pause, resume or delete one |
| Pull-request review | List the repositories with review on. Turn review on or off for one |
| Agent settings and the Claude sign-in | See the container's state and which engine runs. Choose the engine, and Claude Code's model and thinking effort. Start, finish or undo the Claude sign-in |
| The crew | See the four members, which are available, and the state of Scout's browser |
| Crew jobs | Give Patch a review or Byte a job with a brief. List the jobs, and read one with its report. List the connected GitHub account's repositories, to pick one |
| Memory | See what the agent saved about the user. Delete one memory or all. Nothing can be added by hand |
| Billing | See plans and top-up packs and the current subscription. Open a Polar checkout. Cancel at the period's end |
| Credits and usage | See the balance and its grants, the credit history, and usage between two dates |
| Coupons | Redeem a coupon code |
| Activity | Read the log of what the agent did |
| Waitlist | Join the waitlist. The answer is always the same, so nobody can test an email |
| Admin | See the platform's numbers at a glance. List and search users, and open one user's details (counts and metadata, never their messages). Set a user's plan by hand. Manage coupons, adjust a user's credits, see free-credit totals, and handle the waitlist. For one user: see their app connections, linked chats and automations; disconnect or recheck an app, unlink a chat, pause, resume or delete an automation, each with a reason. See each app in numbers. See one user's agent and container, stop or wake it, reset its settings, and list or cancel the user's approvals and crew jobs. See the jobs in each queue, run a failed one once more or remove a failed or finished one, with a reason. Read the audit log of every user. See where turns spend their time. Read the settings in use (secrets only as set or not) and check that each service answers. Change a user's role, suspend an account or lift the suspension, delete an account, sign a user out everywhere, and show a user the welcome steps again |

The live stream pushes new messages, message status, conversation changes, approvals, the agent's state, progress lines and credit changes. Long lists come in pages of 30 by default, and 100 at most. Every error has the same shape: a code, a message, and sometimes details. While an admin has suspended an account, every signed-in call of that user answers 403 with the code `account_suspended`. Some addresses are not for the web app. Webhooks are for outside services. `/oauth/callback` is the way back from an app's sign-in, for a provider to send the browser to. `/mcp` and `/git` are for containers only. `/metrics` is for monitoring. Admins also have a page that shows the job queues. The admin panel, a web app of its own, uses only the admin calls and "who is signed in" (section 31).

Example: linking Telegram takes three steps. The app asks for a link code and shows it. The user sends the code to the bot. The app reads the channel list again and shows the new chat.

## 42. Settings

This section lists the backend's settings by group. They are environment settings, read when the api and the worker start. A missing or wrong required setting stops the start with a clear error.

| Group | Setting | What it does | When it is empty |
|---|---|---|---|
| Addresses | `PUBLIC_API_URL`, `WEB_APP_URL` | The public addresses of the api and the web app, used in links sent to users | Local test addresses |
| | `TRUST_PROXY` | Trusts the visitor address that Caddy passes on | All visitors count as one address for rate limits |
| Database and queue | `DATABASE_URL`, `REDIS_URL` | Where the database and Redis are | The backend does not start |
| | `DB_POOL_MIN` | Database connections the api and the worker each keep open even when idle (at most 20) | 10. With 0, none are kept |
| | `DB_PING_SECONDS` | How often those idle connections are checked with a tiny query, and any that died replaced | 60. With 0, never |
| | `ENCRYPTION_KEY` | Encrypts the secret columns. 32 random bytes | The backend does not start |
| Sign-in | `CLERK_SECRET_KEY` | Checks the web app's sessions with Clerk, the sign-in service | No signed-in call works, unless `CLERK_JWT_KEY` is set |
| | `CLERK_WEBHOOK_SECRET` | Checks Clerk's webhooks | Every Clerk webhook is refused |
| The vm-manager | `VM_MANAGER_URL`, `VM_INTERNAL_SECRET` | Where the vm-manager is, and the secret both sides share | Without the secret the backend does not start |
| Models | `LITELLM_MASTER_KEY` | Lets the backend make each user's gateway key | No keys can be made, so new users get no container |
| | `LITELLM_CHEAP_MODEL`, `LITELLM_PREMIUM_MODEL` | The model for Free users, and the model for paid plans | The names "cheap" and "claude" |
| | Provider keys | Read by the gateway itself, not by the backend | The gateway has no model, so Textcrew AI turns fail |
| Channels | `ENABLED_CHANNELS` | Which channels are on | Telegram and the web app |
| | `TELEGRAM_BOT_TOKEN` | Sends messages as the bot | Nothing can be sent to Telegram |
| | `TELEGRAM_WEBHOOK_SECRET` | Checks Telegram's webhooks | Every Telegram message is refused |
| | `TELEGRAM_TYPING` | Shows "typing…" in a Telegram chat while the agent works on a message (section 9). `false` turns it off | On |
| Apps | `COMPOSIO_API_KEY` | Connects apps and runs app actions | Apps cannot be connected or used |
| | `COMPOSIO_WEBHOOK_SECRET` | Checks Composio's webhooks | App events do not arrive |
| | `COMPOSIO_AUTH_CONFIGS` | Maps each app to its Composio setup. Our own sign-in app for an app goes here | An app without an entry can be connected only if the next setting allows it |
| | `COMPOSIO_MANAGED_APPS` | `all`, or app names such as `googlecalendar,notion`: apps the server may set up at Composio by itself, with Composio's shared sign-in, on the first connect | None |
| | `COMPOSIO_TRIAL_AUTH_CONFIGS` | A second setup per app, written like `COMPOSIO_AUTH_CONFIGS`, for the trial users only (section 14) | No trial |
| | `COMPOSIO_TRIAL_USERS` | Who gets the trial setups: user ids, or verified emails, separated by commas | Nobody |
| | `COMPOSIO_API_URL` | Composio's address. `/oauth/callback` sends the browser on to it | `https://backend.composio.dev` |
| Routing | `JEV_API_KEY` | Turns the router on | Every message goes to the agent |
| | `WAKE_WHILE_ROUTING` | Starts waking the container while Jev decides (section 9). `false` wakes it only for a task | On |
| Payments | `POLAR_ACCESS_TOKEN` | Opens checkouts and cancels subscriptions | No checkout can be opened |
| | `POLAR_WEBHOOK_SECRET` | Checks Polar's webhooks | No payment reaches the system |
| | `POLAR_SERVER` | Test mode or real money | Test mode |
| | `POLAR_PRODUCT_PRO`, `_MAX`, `_TOPUP_10` | The Polar products behind each plan and top-up | That plan or top-up cannot be bought |
| | `FREE_CREDITS_MONTHLY_CAP` | A monthly ceiling on free credits | No ceiling |
| AI access | `AI_ACCESS_MODE` | `platform`: users without their own AI run on credits. `own_only`: they must bring their own | `platform` |
| The crew and the browser | `CREW_AVAILABLE` | Which specialists the apps show as available | All three |
| | `BROWSER_AVAILABLE` | Says the deployed agent image has the browser | No container's browser is switched on |
| Web search | `BRAVE_SEARCH_API_KEY` | The key of the search provider | The search tool says search is not set up |
| | `WEB_SEARCH_COST_USD` | The cost a search is charged from | 0.004, which makes one search 1 credit |
| Backups and alerts | `BACKUP_UPLOAD_CMD` | The command that copies a backup off the server | Backups stay on the same disk as the data |
| | `ALERT_WEBHOOK_URL` | Where alerts are posted | Alerts are only in the logs |
| | `METRICS_TOKEN` | The secret for `/metrics` | `/metrics` answers "not found" |
| | `GIT_COMMIT` | The deployed commit, shown on the admin health page. `deploy.sh` sets it | The health page shows no commit |

The vm-manager has its own settings. The main ones are `AWAKE_CAP`, `IDLE_TIMEOUT` (3 minutes) and `DELIVER_TIMEOUT` (15 minutes). `AWAKE_CAP` is 20 if not set. The compose file's default is 15. The AWS test server sets 3. A new value of `AGENT_IMAGE_VERSION` makes each container again at its next wake.

Example: `ALERT_WEBHOOK_URL` is empty on a server and the nightly backup fails. The failure is written to the worker's log, and nobody is told until someone reads that log.

---

# Part E. Where it stands

## 43. The known risks, said plainly

Two decisions give up a check the platform had. This section says what each one leaves open, so nobody is surprised later.

### A container with Scout's browser can reach any public website

A normal container can reach only the addresses on its list. A Max user's container with the browser turned on can reach any public website. The open way out belongs to the whole container, not only to the browser.

That container holds:

- the user's files and any code it cloned;
- the engine's own notes and chat history;
- access to the user's GitHub repos through the git gateway;
- the user's Claude sign-in, when they connected a Claude plan;
- the container's own tokens, and on Max the secrets of the user's own MCP servers.

So one planted instruction is enough to send any of that out. It could sit in a web page Scout reads, in an email, or in a pull request's code.

What still limits the damage:

- It is one user's data only. No other user's data is in that container.
- The keys that matter most never enter a container: the keys for apps, for models, for the database, and the GitHub token.
- Approvals still hold. An agent cannot approve its own request.
- The container's own tokens work only from inside our networks.
- Addresses inside our own network stay refused.
- It is on only for Max users, and only while the server's setting `BROWSER_AVAILABLE` is on.
- On Claude Code only Scout can drive the browser, and Scout has no files, no shell and no app tools.

What does not limit it:

- Nothing checks where the container connects. The platform does not see the browser's traffic.
- Tex and Byte have a shell, and a shell command reaches the same websites.
- On Hermes the limits on each crew member are instructions, not locks.
- A copied Claude sign-in works from anywhere until the user signs that session out.

What follows: the landing page says the sandbox reaches only approved services. For a Max user with the browser on that is not true, so the wording has to change before the browser is offered.

### On Claude Code, the page reader opens any public address

On Hermes, the page reader opens only an address already seen for that user. On Claude Code it opens any public address, because there only Scout may call it.

- What is given up: a planted page can tell Scout to fetch an address that carries data in it.
- What Scout has to give away: only its task text and what it read on the web.
- What still limits it: public addresses only, a plain read with no sign-in, 30 pages a minute, and every read in the activity log.
- The weak point: the platform cannot tell Scout from Tex or Byte. Every call from a container carries the same token. An agent with a shell can read that token and call the page reader itself. So a planted instruction that reaches Tex, Byte or Patch can send data out, one read at a time.
- What would close it: a token for Scout's tools that the shell cannot read. Not built.

### Found on the first server run of the browser

- In a container that has the browser, Hermes downloads its own tools from the internet: about 0.5 GB per user, once. This is code our image does not pin.
- Asked to "remember this", the agent on Claude Code saves to Claude Code's own memory, not the platform's. The platform's memory stays empty unless the tool is named.
- The browser contacts Google when it starts.
- Once, a container stayed awake about 6 minutes after a browser turn. The most expected is 4. The cause was not found.

### Where the code does less than was intended

These were found by reading the code while this report was written. Each is described in its own section too.

- **A Telegram user who answers a run's copy on Telegram.** The copy says to follow up in the Automations chat. If the user replies on Telegram instead ("do it"), the agent there does not have the run in mind: the copy is kept out of that chat's context on purpose (section 18). The agent may ask what is meant.
- **The user's own API key has not run against a real provider.** It is built: every model call of the user goes to their provider with their key, through LiteLLM. It was checked only with a stand-in provider, because there is no key with balance (section 30).
- **The AI of a failed turn's last seconds may stay charged.** LiteLLM writes a key's total in batches, every 10 to 15 seconds. The billing job right after the turn can miss the newest cost. A later sync charges it, in a period that starts after the turn. The refund gives back only what was charged in periods that overlap the turn, so that part is not given back. This was not seen on the server: no AI goes through LiteLLM there yet (section 25).
- **When LiteLLM cannot say what a failed turn's AI cost on any of 5 tries, the AI is not refunded,** although the user was told they were not charged. Awake time, browser time, app actions and paid tools are still given back (section 25).
- **A turn that breaks after the agent took the message is not run again.** The message is then `processing`. A retried job sees that it is no longer `queued` and stops, and the event is marked `done`. So the user gets no reply, and the message stays `processing`. This is what made the failed refund of 8 October silent (sections 9 and 25).
- **LiteLLM no longer reports a key's spend per model** (checked on version 1.104.2). So on Pro and Max all Textcrew AI counts as "other models", and credits with the "cheap model only" mark never pay for it, even on the cheap model (sections 23 and 25).
- **When the server is full, the user is told nothing.** The job tries 5 times over about 13 minutes, then fails with an alert (section 33).
- **Users' files are not copied off the server by the nightly backup.** The upload command gets only the database dump. Old file archives are also never cleaned up (section 37).
- **Coupon credits last 30 days when the admin gives no length,** not 90 (section 29).
- **An approval's details are compared only if the agent gave details when it asked.** Without them, only the action's name is checked (section 15).
- **A plan's limits are checked only when something is added.** After a move to a lower plan, extra automations and the user's own MCP servers stay (section 27).
- **A user can buy a second plan right after cancelling the first,** before the first one ends (section 27).
- **The activity log holds only tool calls that succeeded,** plus three kinds of refusal (section 13).
- **The chargeback mark on an account is never shown anywhere** (section 28).
- **Scout's instructions in the agent image are out of date.** They still say the page reader refuses the built-in search's results. On Claude Code it no longer does (section 21).
- **What a user is told when Textcrew AI credits run out in the middle of a turn is not settled.** The turn may be treated as our fault and given back (section 26).
- **Disconnect does not try again when Composio cannot remove the account.** The failure is only logged and our row is deleted, so the app's sign-in can stay at Composio with nothing pointing to it. Account deletion does try again (sections 14 and 33).
- **A deleted account keeps its email and name** in its `users` row, and its data stays in backups for a while: 7 days in the database dumps by default, and with no end in the archives of users' files (sections 33 and 37).

### Crew jobs

- **The clean-up finds a job's programs by their folder and by the mark in their environment.** A program that leaves the job folder and also clears its own environment is not found. It still ends when the container stops, which now happens right after the job unless something else is running. Finding programs this way reads the container's own process list; it was tested with real programs on Linux, not yet inside gVisor.
- **On Hermes the mark is not set,** because Hermes runs every turn inside one long-lived program. There only the folder finds a job's programs, so a program started from outside the job folder is not stopped.
- **A job's report is the lead's final answer.** If Tex sends no answer, the job is done with no report. A report over 8,000 characters cannot be sent, and the turn fails.

### Other gaps

- A user's files have no size limit on the server.
- When a user deletes a conversation, the backend deletes its messages and files at once. The engine's own record of it stays in the container until the account is deleted, because the Bridge is not told. Nothing reads it again: the conversation's number is never used twice.
- Backups stay on the same disk as the data until an outside store is set.
- With no alert channel set, failures are only in the logs.
- A saved memory cannot be checked against what the user really said. A planted "fact" stays until the user sees and deletes it.
- **The account tools have not run against the real Clerk.** Setting the role, deleting a user in Clerk and ending sessions were checked with a stand-in for Clerk only (section 31).
- **A live stream that is open when an account is suspended stays open.** New calls are refused, but the web app's open stream keeps receiving that user's own updates until it reconnects.
- **Signing a user out takes up to a minute.** A session token the browser already holds is checked without asking Clerk, so it works until it expires.
- **A suspension does not stop a turn that is running.** The turn finishes; its calls to the platform's tools are refused, so it can do little. The container stops at the idle check after it.
- Any LiteLLM key can list the names of the models in LiteLLM and the provider model each one calls. With own keys, that shows that some user uses a given model, under a name that does not say who. The keys themselves are never shown.

## 44. What has run for real

The backend has 739 automated tests. They use a real database and real queues, and stand-ins for outside services. "Run for real" below means it ran on the AWS test server against the real outside service.

| Area | Run for real |
|---|---|
| A Telegram message to the agent and back | Yes |
| Linking Telegram with a code | Yes |
| The Claude plan engine (Claude Code) | Yes |
| Gmail and GitHub through Composio | Yes |
| Approvals | Yes |
| Tex handing work to Scout; progress lines | Yes |
| Scout's browser and its charge | Yes |
| Containers stopping and waking | Yes |
| The isolation tests (no way out except the proxy) | Yes, 5 of 5 |
| The agent's tool paths closed from the internet | Yes |
| The memory save tool | Partly: works when named, not used by default |
| A real sign-up through Clerk | Yes |
| The web app against this backend | Partly: sign-up, connecting a Claude plan and web chat. Not yet: apps, billing, the other screens |
| Textcrew AI on the Hermes engine | No. There is no working model key |
| The user's own API key | No. Built; there is no provider key with balance to test it |
| Payments through Polar, coupons | No |
| Pull-request review; Byte through the git gateway | No |
| Crew jobs: a brief for Patch or Byte, the clean-up in the container, the repo list | No. Built on 13 October, with the automated tests, stand-ins for GitHub, Composio and the container, real processes for the Bridge's clean-up, and the web app's demo mode |
| Reminders and automations | Yes: a one-time reminder, a daily automation, the 15-minute limit |
| Conversations: the list, going back to an earlier one, rename, delete | No. Built on 9 October, with the automated tests only |
| The Automations chat: every run answering there, and the copy on Telegram | No. Built on 13 October, with the automated tests only, and the web app's part in its demo mode |
| The Automations chat cannot be deleted | No. Built on 14 October, with the automated tests only, and the web app's part in its demo mode |
| A late run saying so; the time zone set from the browser | No. Built on 13 October, with the automated tests only, and the web app's part in its demo mode |
| Replies to a chat app as plain text, with the formatting kept for the web app | No. Built on 9 October, with the automated tests only |
| Connecting straight to the provider with our own sign-in app, apps the server sets up at Composio by itself, `/oauth/callback` | No. Built on 13 October, with the automated tests only and a stand-in for Composio. No own sign-in app exists yet, and `COMPOSIO_MANAGED_APPS` is not set on the server. The way back answers on the server (15 October) |
| The trial switch, the `scopes` command, and connecting the same account again | No. Built on 15 October on a branch, with the automated tests only and a stand-in for Composio |
| Web search through Brave | No. The key answers a direct call |
| The page reader on Claude Code | Yes |
| Voice, images and documents | No |
| The nightly backup and a restore | No |
| More than one user awake at once | No |

## 45. For developers: where the old section numbers went

Comments in the code still name sections of the old design doc, such as "HLD 7.2". That doc is gone. This table says where each topic lives now.

| Old reference | Where it is now |
|---|---|
| HLD 0.1 (auth) | "A request inside the api", "The agent's tools (Platform MCP)" |
| HLD 0.2 (jobs) | "Jobs and queues" |
| HLD 0.3 (channels) | "Channels", "Sending replies" |
| HLD 0.4 (automations) | "Reminders and automations" |
| HLD 0.5, 0.6 (Hermes in a container, closing containers) | "Inside the container", "The life of a container" |
| HLD 0.7 (the crew) | "The crew" |
| HLD 0.8 (pull-request review) | "Pull-request review" |
| HLD 0.9 (shared memory) | "Shared memory" |
| HLD 1 to 3 (services, folders, tools) | "What the backend is", "How the code is divided" |
| HLD 4 (networks) | "The way out: the egress proxy" |
| HLD 5.1 (the api, the web tools) | "A request inside the api", "Web research: search and reading pages" |
| HLD 5.2 (worker jobs) | "Jobs and queues", "One message from start to end" |
| HLD 6 (vm-manager) | "Containers: what the backend asks for", "The life of a container" |
| HLD 7.1 (plans) | "Plans" |
| HLD 7.2 (what costs credits) | "What costs credits" |
| HLD 7.3 (grants and expiry) | "Credits: the idea" |
| HLD 7.4 (charging) | "How charging happens" |
| HLD 7.5 (enforcing the balance) | "When credits run out" |
| HLD 7.6 (Polar) | "Payments with Polar" |
| HLD 7.7, 7.8 (coupons, the free budget) | "Coupon codes" |
| HLD 8 (data model) | "What the database holds" |
| HLD 9 (build phases) | Removed. Every phase is built |
| HLD 10.1 (failures) | "When something fails" |
| HLD 10.2 (security checklist) | "The security rules" |
| HLD 10.3 (what is open) | "The known risks, said plainly" |
| HLD 11 (Scout's browser) | "Scout's browser" |
| `docs/launch-plan.md` | `docs/hld-mvp.md`, sections 9, 12 and 13 |
| `docs/build-report.md`, `docs/system-design.md` | This report |
| `docs/deployment.md` | `docs/hld-mvp.md` section 13, and `docs/aws-setup.md` |
