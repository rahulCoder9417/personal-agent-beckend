# The Textcrew backend: how it works

This report explains every piece of logic in the backend, in words. It has no code. It says what each part does, in what order things happen, what the rules are, and what happens when something fails.

Read `hld-mvp.md` first. It gives the short version and explains the words. This report is the long version: come here when you want to know exactly how one thing works.

| | |
|---|---|
| **What the backend is** | One program, started as two processes: the api and the worker |
| **What it does** | Receives messages, runs each user's agent through the vm-manager, charges credits, sends replies |
| **What it does not do** | It does not run the AI itself. Each user's agent runs in its own container |
| **Where it runs** | On the AWS test server (see `aws-setup.md`) |
| **How it is tested** | 457 automated tests, with a real database and real queues |
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
| Postgres | The database. Keeps what must last: users, messages, events, credits. |
| Redis | A fast store in memory. Holds the job queues, locks, counters and live updates. |
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
| channels | Talks to the chat apps. Stores messages and files. Carries live updates | `messages`, `attachments` |
| events | Saves everything that comes in. Owns the queues | `events` |
| orchestrator | Runs one agent turn. Also approvals, agent settings and memory | `sandbox_tokens`, `approvals`, `agent_settings`, `memories`, `chat_engines` |
| platform-mcp | The tool server that agents call | None. It keeps short-lived data in Redis |
| integrations | Composio apps, the user's own tool servers and API keys, the git gateway, web search | `connections`, `user_mcp_servers`, `composio_triggers`, `byok_keys` |
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
| system | Sign-up, account deletion, payments, usage sync, refunds of failed turns, cleanup, backup | 5 |

There are four so slow work never blocks fast work. A long agent turn in inbound does not hold back a reply in outbound. Some system jobs repeat on their own. Usage sync and the health check run every 5 minutes. Credit expiry and approval expiry run every hour. Cleanup and backup run once a day.

### Why every job is safe to run twice

A job can run a second time, for example after a crash. Three things stop double work.

1. Each thing that comes in is one row in `events`. The row is unique for the sender plus the sender's own id.
2. The job id is the event id. BullMQ refuses a second job with the same id. Finished jobs are kept 7 days for this.
3. Every job first checks if its work is already done. A message is saved once per event. A reply that is no longer `queued` is not sent again. Sign-up credits are given once per user.

### Retries

A job that fails is tried again, 5 tries in total. The waits are 5 seconds, 30 seconds, 2 minutes and 10 minutes. After the last try the event is marked `failed`, with the error text. An alert is raised: an error line in the log. If `ALERT_WEBHOOK_URL` is set, the alert is also posted there. The failed job stays on the admin page for 30 days.

### The per-user lock

Only one inbound job per user runs at a time. Two turns at once would mix up the conversation. Before an inbound job starts, the worker takes a lock for that user in Redis. If the lock is taken, the job goes back in line for 2 seconds. When the job ends, the worker gives the lock back.

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
2. The api gives the request an id. The answer carries the same id in the `X-Request-Id` header.
3. The api reads the caller's IP address and counts the request against the IP limit. With `TRUST_PROXY` on, it uses the address Caddy wrote, which a caller cannot fake.
4. The api finds the route. Each route's address, method and rules come from the API contract, one file that lists every address the api answers.
5. If the route needs a signed-in user, the api checks the session (below). Admin routes also need the role `admin`.
6. The api checks the address, the query and the body against the contract.
7. The route's own code runs. Every database query is filtered by the user's id.
8. The api writes one log line.

### The sign-in check

The web app signs the user in with Clerk. Clerk gives the browser a session token, a signed text that proves who the user is. The web app sends it with every request.

1. The api checks the token's signature with Clerk's key. A missing, old or forged token is refused.
2. The token holds Clerk's id of the user. The api finds the matching row in `users`. A deleted account is refused.
3. If there is no row yet, the api reads the user from Clerk and creates the account. This covers a user who arrives before Clerk's sign-up webhook.

### The error shape

Every error looks the same: an `error` object with a `code`, a `message` and sometimes `details`.

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | The input does not match the contract |
| 401 | `unauthorized` | No session, or a bad one |
| 402 | `out_of_credits` | The balance is zero |
| 403 | `forbidden`, `plan_limit`, `channel_disabled` | Not allowed, not in the plan, or the channel is off |
| 404 | `not_found` | Unknown address or item |
| 409 | `conflict` | The action does not fit the current state |
| 429 | `rate_limited` | Too many requests. `Retry-After` says how long to wait |
| 500 | `internal` | An unexpected error. The details stay in the log |

### Rate limits

A rate limit is a cap on how often something may be done. The counters live in Redis and start again when their time window ends. Any request: 600 a minute per IP address (`RATE_LIMIT_PER_IP_PER_MIN`). Web chat messages: 30 a minute per user. New link codes: 10 an hour per user. Tool calls from one user's container: 240 a minute.

### Logging without secrets

Each request writes one line: method, route, status, time taken and request id. The health check is not logged. The log never holds request bodies or sign-in headers. Fields named like password, token, secret, API key, authorization or code are replaced with "[redacted]".

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
3. The worker creates her row in `users`: email, name and role. She starts on the Free plan.
4. Because the row is new, the worker adds one onboarding job. Its id holds her user id, so there is only one.
5. The onboarding job gives her 100 sign-up credits. They are given once, ever.
6. It asks LiteLLM for her own key. The key's spending limit follows her credit balance. The key is stored encrypted.
7. It asks the vm-manager to create her container. It passes her key, her plan's priority and her timezone.
8. The vm-manager creates the container and its storage, and leaves it stopped. It makes a secret token for the container. It returns only the token's hash, a one-way fingerprint.
9. The worker saves the hash in `sandbox_tokens`. From now on, a call that carries this token is known to come from Priya's container. The container is started later, when she sends her first task.

### Other paths

- **The web app arrives first.** If a request comes before Clerk's webhook, the api creates the account from Clerk's data. The same onboarding job is added once.
- **Clerk reports a change.** The email, its verified state and the role are updated. An admin is a user whose role is set to admin in Clerk.
- **Clerk reports a deletion.** The account is marked deleted and a delete job runs. It removes the container and its data, the LiteLLM key, app connections, automations, linked chats, messages, files and memories. It also stops the subscription from renewing.

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
| No code | The chat is not linked yet. Get a code in the web app |
| A wrong or expired code | The code is invalid or expired |
| A code, after too many tries | Too many attempts. Try again in an hour |
| A code, but the chat belongs to another account | The chat is linked to another Textcrew account. Unlink it there first |

### A code from a chat that is already linked

A code never moves a linked chat to another account. The user unlinks the chat first, in the web app. So the worker only looks the code up. It does not use it, and the code still works after the unlink.

| The code is | The reply says |
|---|---|
| A valid code of another account | The chat is linked to another Textcrew account. Sign in there, unlink it in Settings → Channels, then send the code again |
| A code of the same account, or a wrong or expired one | This chat is already linked to your account |
| Any code, after too many tries | Too many attempts. Try again in an hour |

The reply says nothing about the other account: no name, no email. It goes out once per event, even if the job runs twice. A code that comes through the bot's link, after the word /start, counts as a code too. It never reaches the agent.

Example: Rahul's Telegram is linked to his first account. He signs in to a second account and sends its code from the same chat. The bot says the chat is linked to another Textcrew account. The chat stays with the first account until he unlinks it there.

### Unlinking

The user removes a link in the web app, in Settings → Channels. The activity log records it, like the link: the channel and the name shown when it was linked, never the chat id. From then on the chat gets the "not linked yet" reply.

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
   - The text is "yes" or "no" and an approval waits in this chat: it is an approval answer.
   - The text is a coupon code: it is redeemed, and the reply shows the new balance.
7. It downloads any files and turns voice into text.
8. It saves the message in `messages`, once per event. The web app gets a live update.
9. It checks the credits. At zero, Rahul gets an "out of credits" reply and the job ends. No container is woken.

### The routing decision

10. The worker decides who answers.

| Decision | When | What happens |
|---|---|---|
| Connect an AI first | `AI_ACCESS_MODE` is `own_only` and the user has no AI of their own | A reply with the settings page. No container |
| Simple | The router is at least 70% sure | A cheap model answers through LiteLLM. No container |
| Spam | The router is at least 90% sure | The message is dropped. No reply |
| Task | Everything else | The message goes to the agent |

The router is an outside service named Jev. It judges only plain text of up to 1,000 characters, with no files. It sees the new message, the last six messages of the chat and the user's connected apps. It can also name the apps a task likely needs, as a hint for the agent.

Every message is a task when the router has no key (`JEV_API_KEY` is empty), is too slow or fails. The same holds when the user's own Claude plan pays for the AI. It also holds when the cheap model says it cannot answer alone. So routing can save work, and it can never lose a message.

### Waking and delivering

11. The worker makes sure the container exists. Then it asks the vm-manager to wake it, with the plan's priority.
12. It checks the container against the account: which engine runs, and if the browser is on. The engine is the agent program, Hermes or Claude Code.
13. It builds the text: what the agent has saved about the user, a short recap if the engine changed, then the message.
14. It sends the delivery to the vm-manager and keeps the connection open. The delivery carries the event id, the chat it came from, the text and signed links to the files.
15. The vm-manager reports back while the turn runs:
    - **Accepted.** The message becomes `processing`. The web app shows the agent as busy.
    - **Working.** A progress line. It is shown live in the web app only.
    - **Done.** The message becomes `delivered`.
    - **Error on our side.** Rahul is told at once that he was not charged, and the message becomes `failed`. A separate refund job gives the turn's credits back about 30 seconds later (section 25).
    - **Other error.** Rahul gets "I couldn't finish that" with the reason.
16. In the container, the agent does the work. It calls the tool server at `/mcp` to use Gmail.
17. The Bridge is our small program in the container. It sends the final answer through the tool server's send tool. The tool saves the reply and adds an outbound job.
18. After the turn, the worker syncs Rahul's usage, which charges his credits. The web app gets the new balance. The event is marked `done` and the lock is given back.

### What is recorded

The `events` table keeps the webhook and its state: received, queued, then done, ignored or failed. Every way the job ends sets the last state, also the special cases of step 6. A quick job can end before the api has written "queued". The api then leaves the final state alone, so the next worker start does not queue the event again. The `messages` table keeps Rahul's message and the reply, each with a status. Files are in `attachments`. The activity log keeps the tool calls the agent made. The credit ledger keeps the charges of the turn.

### A message from web chat

A web message skips the webhook. The web app calls `POST /v1/messages`. The api checks that web chat is on, the 30 a minute limit and the credits. At zero it answers 402. Then it saves the message once and adds the job. The rest is the same. The reply arrives through the live updates.

### What can go wrong

- **The server is full, or the vm-manager cannot be reached.** The job fails and is retried with the usual waits.
- **The connection ends with no result.** The job is retried. If the agent had not yet taken the message, it is delivered again. The container remembers the event id, so the turn does not run twice. If the agent had taken it, the retry stops and the user gets nothing (section 43).
- **The turn runs too long.** The container cuts it off at 15 minutes.
- **The Claude sign-in stopped working.** The account goes back to the standard agent, and the user is told.

## 10. Sending replies

Every outgoing message takes the same path, whoever wrote it: the agent, the cheap model or the platform itself. Example: the agent's answer "Done, I emailed Priya the notes" goes to Rahul's Telegram chat.

### The path

1. The message is saved in `messages` as outgoing, with the status `queued`. The web app gets a live update.
2. A `send-message` job is added to outbound. Its id holds the message id.
3. The worker takes the job. If the message is no longer `queued`, it stops: the message was already sent.
4. If the channel is switched off, the message becomes `failed` and the job ends.
5. The worker sends the text through the channel. On success the message becomes `sent`. The channel's own message id is saved with it.
6. On failure the job is retried, 5 tries in total. After the last one the message becomes `failed`.

The agent names the chat to answer in. Without a name, the reply goes to the chat the user last wrote from. An agent can write only to its own user's chats.

### Per channel

| Channel | How it is sent | Limits |
|---|---|---|
| Telegram | Through the bot. Buttons sit under the last part | Split at about 4,096 characters, at a paragraph, line or space |
| Web chat | Nothing is sent. The saved message and the live update are the delivery | None |
| WhatsApp | Free text within 24 hours of the user's last message. Later, an approved template | 4,096 characters, 3 buttons. A template holds about 700 characters |
| iMessage | Through Sendblue. No buttons: the text asks for YES or NO | Split at 4,096 characters |

One message from the agent can hold up to 8,000 characters. WhatsApp and iMessage also report receipts. A receipt only moves a status forward: sent, delivered, read.

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

### The events

| Event | Sent when |
|---|---|
| `message.created` | A message is saved, incoming or outgoing, on any channel |
| `message.status` | A message's status changes |
| `approval.created` | The agent asks for permission |
| `approval.resolved` | An approval is answered or runs out |
| `agent.status` | The container is waking, busy or awake |
| `agent.progress` | The agent reports a progress line |
| `credits.updated` | A turn ends, or credits are added or run out |
| `automation.updated` | An automation changes |

### Progress lines are live only

- A progress line says what the agent is doing right now. It is cut at 300 characters.
- It goes only to the web app's event stream. It is never sent to Telegram or any other chat app.
- It is not saved as a message. A web app that is not connected at that moment does not see it later.
- One exception: a line that names a crew member, such as Scout, is also written to the activity log. At most 30 are saved per turn.
- A line that cannot be published is dropped. The turn goes on.

### What can go wrong

- **The connection drops.** Events sent in the meantime are not sent again, because Redis does not keep them. Messages, approvals and credits are saved in the database, so normal requests still return them.

---

# Part B. What the agent can do

## 13. The agent's tools (Platform MCP)

The Platform MCP is the platform's tool server. MCP is a standard way for an AI agent to call tools on a server. This server is the only way an agent inside a container can act on the platform or on the user's apps.

- The tool server is part of the api process. It answers at the path `/mcp`.
- Only containers can reach it. From the public internet, `/mcp` answers "not found".
- It offers the same 14 tools to every container. It keeps nothing between two calls.

### How a container proves who it is

1. The vm-manager creates a user's container. It also creates a token: a long random secret, placed inside that container.
2. The backend gets only a hash of the token. A hash is a one-way fingerprint: nobody can turn it back into the token.
3. The backend saves the hash next to the user id, in the table `sandbox_tokens`.
4. On every call, the container sends its token. The api makes its hash and looks it up.
5. Found: the call runs as that user. Not found: the call is refused.
6. The user id always comes from this lookup. No tool has an input for a user id. So an agent cannot act as another user, whatever a web page tells it.

### The tools

| Tool | What it does |
|---|---|
| `send_message` | Sends a text to one of the user's own chats |
| `get_profile` | Returns the user's name, time zone, plan and connected apps |
| `list_app_actions` | Lists the actions the agent may run in the user's connected apps |
| `run_app_action` | Runs one app action, for example "send an email" |
| `request_approval` | Asks the user to approve a risky action. Answers "pending" at once |
| `schedule_reminder` | Saves a reminder for one moment in time |
| `create_automation` | Saves an automation: once, repeating, or on an app event |
| `list_automations` | Lists the user's reminders and automations |
| `cancel_automation` | Deletes one reminder or automation |
| `web_search` | Searches the web through the platform. Max plan, 1 credit a search |
| `read_page` | Reads one public web page and returns its text and links. Free |
| `remember` | Saves one short fact about the user |
| `recall` | Finds saved facts about the user |
| `forget` | Removes or corrects a saved fact |

**Example.** Rahul texts "email Priya the notes". The agent finds Gmail's send action with `list_app_actions`. It asks for a yes with `request_approval`. After the yes it calls `run_app_action`. The reply "Sent" leaves the container through `send_message`.

### The activity log and the rate limits

- The activity log is the record of what the agent did. The user sees it in the web app. It is the table `audit_log`.
- Every tool call that succeeds adds one entry: the tool's name, a one-line summary, the inputs and the credits charged.
- An input whose name looks like a secret (key, token, password) is blanked. `read_page` keeps the address without the part after the question mark. The memory tools never keep a memory's text.
- A failed call adds no entry. Three refusals are still logged: a refused search, a refused page and a refused memory.
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
- An app also needs a Composio setup on the server, named in the setting `COMPOSIO_AUTH_CONFIGS`. Without one, the api answers that the app is not configured yet.

### How a user connects an app

1. The user picks an app in the web app. The web app calls `POST /v1/apps/{appSlug}/connect`.
2. The api checks the plan. A Free user who picks a paid app gets a "plan limit" error.
3. The api asks Composio for a connect link, and gives Composio our own user id.
4. The api saves the connection as `pending` in the table `connections`, and returns the link.
5. The user's browser opens the app's own sign-in page. The user signs in and allows access. The platform never sees the password. Then the browser returns to the web app.

### How the platform checks that the connection became active

A connection becomes `active`, `expired` or `error` in one of three ways. The first one to happen wins.

- **Composio's webhook.** A webhook is a message a service sends to our server when something happens. Composio sends one when the status changes.
- **The app list.** Each time the web app lists the apps, the api asks Composio.
- **The check job.** The worker asks Composio by itself. The first check runs 15 seconds after the link is made. The next ones come 30 seconds, then 1, 2, 4 and 8 minutes later.
- That is six checks in about 16 minutes. They stop as soon as the connection is no longer pending. After the last one, the other two ways can still finish it.

### How the agent finds and runs an action

1. The agent calls `list_app_actions`. It can filter by app or by a search word.
2. The api lists only apps that are connected, active and allowed on the user's plan. Each action carries two marks: whether it needs approval, and whether it costs a credit.
3. The agent calls `run_app_action` with the action's name and its inputs.
4. The api checks the app, the credits and the approval (next section).
5. The api calls Composio with the user id from the container token. The result goes back to the agent.

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

## 15. Approvals

An approval is the user's yes before the agent does something that other people will see or that cannot be undone.

### Which actions need a yes first

| Kind of action | Words that mark it |
|---|---|
| Sending to others | SEND, REPLY, FORWARD, POST, PUBLISH, SHARE, INVITE |
| Deleting | DELETE, REMOVE, TRASH, ARCHIVE |
| Paying | PAY, PAYMENT, TRANSFER, CHARGE, REFUND |
| Changing what exists | UPDATE, MOVE, MERGE, CLOSE, CANCEL, ACCEPT, DECLINE |
| GitHub comments and reviews | COMMENT or REVIEW, in a GitHub action that writes |

The platform decides by these words in the action's name. There is one exception, for pull-request review. It is described in that section.

### The life of an approval

1. The agent calls `request_approval` with a short summary, the action's name and its exact inputs.
2. The api saves it in the table `approvals` as `pending`. It expires after 24 hours.
3. The api sends "Approval needed: ..." to the chat the request came from. Telegram shows two buttons, Approve and Reject.
4. The tool answers "pending" at once. The agent ends its turn and says it is waiting. It never waits inside a turn.
5. The user taps a button, types "yes" or "no", or decides in the web app. A typed answer goes to the newest waiting approval in that chat.
6. The api records the answer in the activity log. A job then wakes the agent with a new message: "The user APPROVED ..." or "The user REJECTED ...".
7. After a yes, the agent calls `run_app_action` with the approval's id. The action runs.

**Example.** Rahul texts "email Priya the notes". He gets "Approval needed: Send the notes to priya@example.com". He taps Approve. The agent wakes up and sends the email. 1 credit is charged.

### Single use and exact match

`run_app_action` runs a risky action only when all of this is true:

- the approval belongs to this user and names the same action;
- it is approved, and the yes is less than 24 hours old;
- it has not been used before;
- the inputs are exactly the ones saved with the approval.

"Used" is marked in the same step as the check. So two calls at the same moment cannot both use one approval. If the agent asked without giving any inputs, only the action's name is compared.

### What can go wrong

- **Rejected.** The agent is woken and told not to do it. That approval can never run an action.
- **Never answered.** After 24 hours an hourly job marks it `expired`. The agent is not woken. Nothing runs.
- **A late tap on an old button.** The user gets "That approval was already answered or has expired."
- **A risky action with no approval.** Refused, with a message that tells the agent to ask first.
- **The agent changes the email after the yes.** Refused, because the inputs differ. The approval still works with the right inputs.

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
3. The api turns the container token into the user id, exactly as the tool server does. An unknown token is refused.
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
3. The api sets the timer. For an app event, Composio starts a watch on the app, called a trigger. The agent then confirms to the user.

- **The plan limit.** Free 1, Pro 5, Max 50. Reminders count, and paused automations count. A finished one-time reminder does not.
- **The 15-minute minimum.** For a schedule, the next 50 runs must each be at least 15 minutes apart.
- **The time zone.** It must be a real one. If none is given, the user's own is used. "Every Monday at 9" means 9 where the user lives.
- **Other checks.** A one-time moment must not be in the past. An app event needs that app to be connected.

### What happens when one fires

1. The timer fires. For an app event, Composio's webhook arrives and is verified.
2. The worker checks that the automation still exists and is on. For an app event, it also checks the owner.
3. It puts a job in the same queue as the user's messages. So messages and automations run one at a time, in order.
4. The agent gets a normal turn. A turn is one run of the agent, from input to answer.
5. The input is the automation's title and instruction. For an app event, the event's data is added.
6. The agent answers in the chat where the automation was created. A one-time automation is then marked finished.

**Example.** Rahul texts "every Monday at 9, send me this week's meetings". Each Monday at 9 his time, the agent wakes, reads his calendar and sends the list on Telegram.

**The cost.** The automation itself has no price. Each run is a normal turn and costs what a turn costs. That is the AI when Textcrew AI is used, and the time the container is awake. An app action that changes something costs 1 credit. A risky action still needs the user's approval.

### Auto-pause and recovery

- **Zero credits.** All the user's automations are paused. When credits are added, these are switched on again by themselves.
- **Three failures in a row.** That automation is paused. The user is told in chat and can resume it in the web app. A paused automation has no timer, and app events for it are ignored.
- **After a restart.** The timers live in the job queue, which can lose its data. So every time the worker starts, it sets the timer of every enabled automation again. Setting one twice is harmless.

### What can go wrong

- **The plan limit is reached.** The tool says how many the plan allows. Nothing is saved.
- **No credits when it fires.** No turn runs. The user gets the out-of-credits message and the automation is paused.

## 19. Pull-request review

The user can switch on automatic code review for chosen GitHub repositories. When a pull request opens or changes, the crew member Patch reviews it and posts one review on GitHub. The user gets a short verdict in chat.

### Turning it on per repo

1. The user switches it on for one repository in the web app. The web app calls `PUT /v1/pr-reviews/{owner}/{repo}`.
2. The api checks that GitHub is connected and that the plan has a free automation.
3. The api asks Composio to watch that repository. Composio puts a webhook on it, so the GitHub account needs admin access there.
4. The api saves an app-event automation with the mark `pr_review`. It shows in the automations list.
5. The verdict chat is chosen now: the user's linked Telegram chat, or else the web chat.

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

**Example.** Rahul turns review on for `acme/website`. A teammate opens pull request 42. Rahul gets on Telegram: "PR 42: one bug in the date check, tests pass. Fix first." He answers "fix it", and Byte pushes a fix to a branch.

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

### What can go wrong

- **`CREW_AVAILABLE` does not match the deployed image.** The apps then show a member that is missing. Or they hide one that is there.

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

- Each engine keeps its own copy of a chat. A new engine would not know what was said. So the platform records which engine last finished a turn in each chat, in the table `chat_engines`.
- When a turn runs on a different engine, the backend adds a recap after the memory block. The same engine gets no recap.
- The recap holds the messages this engine has not seen: at most 12 messages and 3,000 characters. It is framed as a record, not as new requests.

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

The usage sync is a job in the worker, the process that does the slow work. It runs every 5 minutes for every user who has a LiteLLM key, and every user gets one at sign-up. It also runs right after each turn, for that one user. For one user it does this:

1. It takes the user's credit lock.
2. It finds the period to charge: from the end of the last charged period until now.
3. It asks the vm-manager, the service that starts and stops containers, for two numbers. One is the seconds the container was awake in that period. The other is the seconds the browser was in use.
4. It asks LiteLLM for the total cost on the user's key so far. It subtracts the total it saved last time. The rest is the new AI cost.
5. If there is no new cost and there are no seconds, it writes nothing and goes to step 8. The next sync covers a longer period.
6. It turns the numbers into credits (next sub-section). If the user's LiteLLM key pointed at their own API key, the AI credits are 0.
7. It writes one row in `usage_periods` for this period, makes one charge for the total, and saves LiteLLM's new total. These three are one database transaction: all of them are saved, or none.
8. It brings the user's LiteLLM key up to date: the budget, and whether it points at the user's own key (section 30). This also fixes a switch that failed earlier. If the balance is zero or below, it pauses the user's automations. An automation is a job the agent runs on a schedule or on an event.

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
- The 5-minute sync and the after-turn sync both take the user's lock. The second one starts where the first one ended.
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
5. It works out what the turn cost. AI comes from LiteLLM's spend log for the turn's time. Awake and browser time come from the vm-manager.
6. It gives that back to the grants it came from, and never more than was charged. It also gives back the app-action and paid-tool credits charged during the turn. All of it is one database transaction with idempotency keys, so it is given once, however often the job runs.
7. If a step fails, nothing is given and the job is tried again: 5 tries over about 13 minutes. On the last try, if LiteLLM still cannot say what the AI cost, the job gives back everything else. The AI is then not refunded, and the log says so. If the last try fails anyway, an alert is raised.

Example: Rahul's turn on Textcrew AI fails as our fault after 2 minutes. He gets the apology right away. During the turn the agent saved an email draft, an app action of 1 credit. Half a minute later the job finds $0.02 of AI in the log, which is 5 credits. It gives back the 6 credits. If the job runs again, it gives nothing more.

A failure that is not our fault is not refunded. Examples: the user's Claude plan reached its limit, or the agent hit its own step limit.

### How the turn's AI cost is read

LiteLLM keeps one row per model call, with the key, the time and the cost. It writes these rows in batches, every 10 to 15 seconds. The job asks `/spend/logs/v2` for the rows of the user's key in the turn's time. LiteLLM stores a key only as its SHA-256, so the job sends that, never the key. The times are sent to the second, rounded outward. The job then keeps only the rows inside the turn, to the millisecond, and adds up their cost.

The older `/spend/logs` is not used. It takes dates only, and it answers 500 to a time of day. It is also marked as replaced. Asking it with full times was why a refund failed on the test server on 8 October 2026. That turn's user got no reply and no refund.

### What can go wrong

- **The vm-manager or LiteLLM does not answer during a sync, or the worker crashes in the middle.** Nothing is written for that user. The next sync covers the longer period. Other users are not affected.
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
- An automation that fires at zero gets the out-of-credits reply in its chat and is paused.
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

A plan changes only when Polar's webhook arrives. A webhook is a call that Polar makes to our server (next section). Then this follows:

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
- **No AI charge:** Claude Code does not call LiteLLM, so there is no AI cost to charge.
- **No quick replies:** every message goes to Claude Code.

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

Admin tools are for the founder and trusted staff. They hand out free credits, correct balances and show what failed.

Only a user with the role admin may use them. The role is set in Clerk, the sign-in service, in the user's public metadata. The backend copies it when Clerk sends the user's data. Anyone else gets "Admins only".

| Tool | What it does | Where |
|---|---|---|
| List coupons | Shows all campaigns with their use counts | `/v1/admin/coupons` |
| Create a coupon | Makes a campaign and returns its codes once | `/v1/admin/coupons` |
| Disable or enable a coupon | Switches a campaign off or on; can revoke unspent credits | `/v1/admin/coupons/{id}` |
| Adjust credits | Adds or removes credits for one user | `/v1/admin/users/{id}/credits` |
| Free-credit numbers | Shows this month's free credits, the cap and abuse flags | `/v1/admin/stats/free-credits` |
| Failed jobs board | Shows the four job queues and their failed jobs | `/admin/queues` |

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

---

# Part D. Containers and operations

## 32. Containers: what the backend asks for

This section lists every request the backend can send about a user's container. A container is a closed box on the server that runs one user's agent.

The backend never talks to Docker, the program that runs containers, and never to a container itself. It asks the vm-manager, which does the work. Every request carries a shared secret, the setting `VM_INTERNAL_SECRET`. A request without the right secret is refused. A "turn" below means one piece of work by the agent: one message in, one answer out.

| Call | What it does | When the backend makes it |
|---|---|---|
| `CreateSandbox` | Makes the container and the user's folder. Leaves it stopped | At sign-up, and before a turn if none exists |
| `WakeSandbox` | Starts the container and waits until it is ready | At the start of every turn |
| `Deliver` | Hands one message in and streams events back | Once per turn, right after the wake |
| `Touch` | Notes that the user was active just now | On every tool call and git call from the container |
| `StopSandbox` | Stops a container, politely or by force | Never today. The vm-manager stops containers by its own rules |
| `DeleteSandbox` | Removes the container and the user's folder | When an account is deleted |
| `GetSandbox` | Reports one container's state | For the agent status in the web app, and for checks |
| `ListSandboxes` | Lists all containers | Nightly backup, and the health check every 5 minutes |
| `GetUsage` | Reports awake seconds and browser seconds per user | Every 5 minutes, and after each turn |
| `SetEgressAllowlist` | Replaces the user's allowed domains and own MCP servers (tool servers the user adds) | When the user changes their own MCP servers |
| `SnapshotVolume` | Packs the user's folder into one archive file | Nightly backup, once per user |
| `SetAgentRuntime` | Chooses the engine: Hermes or Claude Code | When the user's AI settings change |
| `SetBrowser` | Switches Scout's browser on or off | After a plan change, or after a wake if it differs |
| `StartClaudeLogin` | Starts the Claude sign-in in the container. Returns a link | The user asks to connect a Claude plan |
| `CompleteClaudeLogin` | Passes the user's code to the waiting sign-in | The user pastes the code from Anthropic's page |
| `ClaudeLogout` | Signs Claude Code out in the container | The user disconnects their Claude plan |

Example: a user texts "What is on my calendar?". The backend sends `WakeSandbox`, then `Deliver`. Each tool call the agent makes sends a `Touch`. After the turn, the backend sends `GetUsage` to charge the awake time.

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

1. The backend checks that the user has credits. At zero credits nothing is woken, and the user is told.
2. The backend sends `WakeSandbox` with the user's plan priority. The vm-manager locks this user, so two operations never overlap.
3. If the container is already running, the vm-manager answers at once.
4. It checks the limit on awake containers and reserves a place. The state is "waking".
5. It makes the container again if the agent image is new, the container is missing, or the browser switch changed. The user's folder is kept.
6. It starts the container and asks the Bridge "are you ready?" again and again, for up to 90 seconds.
7. It writes this container's rule for the egress proxy, the only way out of a container. The state is "awake", and an awake period opens for credits.

If the start or the ready check fails, the vm-manager makes the container again from the image and tries once more. If that fails too, the state is "broken". After a good wake, the backend checks the engine and the browser switch, and sends the right value if one differs.

### Delivering a message

The backend sends `Deliver` with the message text, the chat it came from and a delivery id. The vm-manager counts the delivery as "in flight" and passes it to the Bridge. From then on nothing may stop the container. Events come back as a stream:

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
| The limit on awake containers | Another user needs the place | Politely |
| The stuck-turn timer | A turn runs longer than 15 minutes | By force |
| The health check | The container does not answer, even after restarts | By force, then "broken" |

A container is never stopped in the middle of a turn, unless the turn is stuck. "Quiet" means no delivered message, no tool call and no git call. Each of those resets the clock. A Claude sign-in that waits for its code also keeps the container awake. A polite stop goes like this:

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
2. The backend removes the token record, the agent settings, the shared memories, the chat links, the messages and the uploaded files.
3. The user's gateway key is revoked, and a paid subscription is set to not renew.
4. App connections, the user's own MCP servers and automations are removed.

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

Risky actions never wait inside a turn. The agent asks the platform for approval, gets "pending", and ends its turn. The user's yes or no arrives later as a new message.

### The two engines

| | Hermes | Claude Code |
|---|---|---|
| What it is | An open-source agent | Anthropic's own program, not changed |
| Whose AI it uses | The platform's models through the gateway, or the user's own API key | The user's own Claude plan |
| Who pays for the AI | Credits, or the user's own key | The user's Claude plan |

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

### Logs, metrics and alerts

The api and the worker write one log line per request and per job. Fields that look like a secret are replaced by "[redacted]": passwords, tokens, keys, sign-in codes, login headers and cookies. Request contents are never logged.

The api serves numbers at `/metrics`: requests by path and result, and for each queue the jobs waiting, running, delayed, failed and finished. The page needs the secret in `METRICS_TOKEN`. Without that setting it answers "not found".

An alert is an error line in the log, marked as an alert. If `ALERT_WEBHOOK_URL` is set, the same text is also posted there, for example to a Slack channel. The backend raises an alert in three cases: a job failed after all its tries, the backup failed, or the health check found a problem. The vm-manager writes its alerts only to its own log.

### The nightly backup and the restore test

The backup job runs every night at 02:00 on the worker's clock.

1. It dumps the whole backend database into one file, in a folder named by the date.
2. It asks the vm-manager for all containers and has each user's folder packed into an archive file.
3. If `BACKUP_UPLOAD_CMD` is set, it runs that command to copy the backup off the server.
4. It deletes dump folders older than `BACKUP_KEEP_DAYS`, which is 7 by default.

The restore test is a script that is run by hand. It restores the newest dump into a scratch database and checks that the main tables and some users are there. It also checks that every archive opens.

### After a worker crash or a restart

Every job is safe to run again, so a job that did not finish is simply run again. When the worker starts, it also does this:

1. It puts saved events of the last 7 days that never finished back in the queue.
2. It registers the timer of every enabled automation again.
3. It registers the repeating jobs again: usage sync, credit expiry, approval expiry, clean-up, backup and health check.

A failing job is tried 5 times, with waits of 5 seconds, 30 seconds, 2 minutes and 10 minutes. After the last failure its event is marked "failed" and an alert is raised. A daily clean-up removes finished events older than 30 days and messages older than 365 days.

### Rate limits on public endpoints

| What | Limit |
|---|---|
| Every endpoint, per visitor address | 600 a minute (`RATE_LIMIT_PER_IP_PER_MIN`) |
| Messages from the web app, per user | 30 a minute |
| Link codes, per user | 10 an hour |
| Link code tries from one chat, linked or not | 10 an hour |
| Waitlist | 10 an hour per address, 5 an hour per email |
| Coupon codes | 5 an hour per user, 20 an hour per address |
| Starting a Claude sign-in, per user | 10 an hour |

Example: a person sends 11 link codes from one unlinked Telegram chat within an hour. The eleventh gets "Too many attempts. Please try again in an hour."

### What can go wrong

- The users' files are not copied off the server. With the default settings their archives go to a separate "volumes" folder, and the upload command is given only the dump folder. The command must name the volumes folder too.
- Old archives of users' files pile up: step 4 of the backup deletes only the dump folders.
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

| Module | Table | What it holds |
|---|---|---|
| auth | `users` | One row per person: email, name, time zone, plan, role |
| auth | `link_codes` | One-time codes to link a chat app, stored as hashes, with an expiry |
| auth | `channel_links` | Which chat belongs to which user |
| auth | `waitlist_entries` | People waiting for access, with request details for abuse checks |
| auth | `waitlist_attempts` | Every waitlist try, also repeats and blocked ones |
| events | `events` | Everything that came in, saved once, with its status |
| channels | `messages` | Every message in and out, with its channel and status |
| channels | `attachments` | Files uploaded in the web app or received in a chat |
| orchestrator | `sandbox_tokens` | The hash of each container's token and the user it belongs to |
| orchestrator | `agent_settings` | The chosen engine, the AI choice, and when Claude was connected |
| orchestrator | `approvals` | Risky actions waiting for a yes or no, with their exact details |
| orchestrator | `memories` | Short facts about the user that every engine gets |
| orchestrator | `chat_engines` | Which engine last finished a turn in each chat |
| integrations | `connections` | A user's connected app accounts and their status |
| integrations | `user_mcp_servers` | The user's own MCP servers, with the secret encrypted |
| integrations | `composio_triggers` | Made for app triggers. No code reads or writes it today |
| integrations | `byok_keys` | The user's own AI keys, encrypted, plus the last 4 characters |
| automations | `automations` | Reminders, repeating tasks and app-event tasks |
| automations | `pr_reviews` | One row per reviewed pull-request commit, so none is reviewed twice |
| billing | `subscriptions` | Each paid plan: user, Polar id, status, period |
| billing | `payments` | Polar orders seen, to trace refunds back to a user |
| billing | `credit_grants` | Each batch of credits: source, amount, what is left, expiry |
| billing | `credit_ledger` | Every change to credits. Rows are only added, never changed |
| billing | `usage_periods` | One row per charged period: AI cost, awake time, browser time, credits |
| billing | `litellm_keys` | Each user's gateway key, encrypted, the spend seen so far, and the LiteLLM model that holds their own API key, if any |
| billing | `coupons` | Coupon campaigns: credits, limits, expiry |
| billing | `coupon_codes` | The codes of a campaign, stored as hashes |
| billing | `coupon_redemptions` | Who redeemed which campaign, once per user |
| admin | `audit_log` | The activity log: who did what, when, and credits charged |

No table holds a "balance" number: the balance is the sum of what is left in a user's grants. The vm-manager has its own small database with three tables: `sandboxes`, `awake_periods` and `browser_usage`. The backend never reads it directly. Example: one Telegram message adds one row in `events` and two rows in `messages`: the message and the answer. It also adds entries in `audit_log`, and one row each in `usage_periods` and `credit_ledger` for the charge.

## 41. The API in words

This section says what the web app can do through the api, group by group. Almost every call needs a signed-in user. The plan list, the waitlist and the health check are public. Admin calls need the admin role.

| Group | What it lets the app do |
|---|---|
| Profile | Read the user's name, plan and credit summary. Change the name and time zone |
| Channels and linking | See linked chat apps and which channels are on. Get a one-time code to link Telegram. Unlink a chat |
| Chat and the live stream | Read the chat history, send a message, upload a file up to 10 MB. Keep a live stream open |
| Approvals | List approvals, the waiting ones by default. Approve or reject one |
| Apps | See the app list with status and plan. Start connecting an app. Disconnect one |
| MCP servers | List the user's own MCP servers. Add one (Max plan), rename it, switch it on or off, remove it |
| Own AI keys | See which providers have a key and which one is in use, never the key itself. Set, replace or remove one |
| Automations | List reminders and automations. Pause, resume or delete one |
| Pull-request review | List the repositories with review on. Turn review on or off for one |
| Agent settings and the Claude sign-in | See the container's state and which engine runs. Choose the engine. Start, finish or undo the Claude sign-in |
| The crew | See the four members, which are available, and the state of Scout's browser |
| Memory | See what the agent saved about the user. Delete one memory or all. Nothing can be added by hand |
| Billing | See plans and top-up packs and the current subscription. Open a Polar checkout. Cancel at the period's end |
| Credits and usage | See the balance and its grants, the credit history, and usage between two dates |
| Coupons | Redeem a coupon code |
| Activity | Read the log of what the agent did |
| Waitlist | Join the waitlist. The answer is always the same, so nobody can test an email |
| Admin | Manage coupons, adjust a user's credits, see free-credit totals, and handle the waitlist |

The live stream pushes new messages, message status, approvals, the agent's state, progress lines and credit changes. Long lists come in pages of 30 by default, and 100 at most. Every error has the same shape: a code, a message, and sometimes details. Some addresses are not for the web app. Webhooks are for outside services. `/mcp` and `/git` are for containers only. `/metrics` is for monitoring. Admins also have a page that shows the job queues.

Example: linking Telegram takes three steps. The app asks for a link code and shows it. The user sends the code to the bot. The app reads the channel list again and shows the new chat.

## 42. Settings

This section lists the backend's settings by group. They are environment settings, read when the api and the worker start. A missing or wrong required setting stops the start with a clear error.

| Group | Setting | What it does | When it is empty |
|---|---|---|---|
| Addresses | `PUBLIC_API_URL`, `WEB_APP_URL` | The public addresses of the api and the web app, used in links sent to users | Local test addresses |
| | `TRUST_PROXY` | Trusts the visitor address that Caddy passes on | All visitors count as one address for rate limits |
| Database and queue | `DATABASE_URL`, `REDIS_URL` | Where the database and Redis are | The backend does not start |
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
| Apps | `COMPOSIO_API_KEY` | Connects apps and runs app actions | Apps cannot be connected or used |
| | `COMPOSIO_WEBHOOK_SECRET` | Checks Composio's webhooks | App events do not arrive |
| | `COMPOSIO_AUTH_CONFIGS` | Maps each app to its Composio setup | An app without an entry cannot be connected |
| Routing | `JEV_API_KEY` | Turns the router on | Every message goes to the agent |
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

- **The user's own API key has not run against a real provider.** It is built: every model call of the user goes to their provider with their key, through LiteLLM. It was checked only with a stand-in provider, because there is no key with balance (section 30).
- **The AI of a failed turn's last seconds may stay charged.** LiteLLM writes a key's total in batches, every 10 to 15 seconds. The sync right after the turn can miss the newest cost. A later sync charges it, in a period that starts after the turn. The refund gives back only what was charged in periods that overlap the turn, so that part is not given back. This was not seen on the server: no AI goes through LiteLLM there yet (section 25).
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

### Other gaps

- A user's files have no size limit on the server.
- Backups stay on the same disk as the data until an outside store is set.
- With no alert channel set, failures are only in the logs.
- A saved memory cannot be checked against what the user really said. A planted "fact" stays until the user sees and deletes it.
- Any LiteLLM key can list the names of the models in LiteLLM and the provider model each one calls. With own keys, that shows that some user uses a given model, under a name that does not say who. The keys themselves are never shown.

## 44. What has run for real

The backend has 457 automated tests. They use a real database and real queues, and stand-ins for outside services. "Run for real" below means it ran on the AWS test server against the real outside service.

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
| Reminders and automations | Yes: a one-time reminder, a daily automation, the 15-minute limit |
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
