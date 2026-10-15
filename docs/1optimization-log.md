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

### 15 October 2026: request logs and response times per route

- **Where it is:** on `main`, not yet on the server.
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
