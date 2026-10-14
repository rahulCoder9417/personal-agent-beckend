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

### 14 October 2026: the databases move from the server to Neon

- **Where it is:** on `main` (once merged), not yet on the server. The move needs a script run on the server by hand (`aws-setup.md`, section 8, "Moving the databases to Neon").
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
  - Not run on the server.
- **Still open:**
  - Run the move on the server (the steps are in `aws-setup.md`, section 8). Watch how long replies take afterwards.
  - If replies are too slow, the fix is a Neon project in Singapore or Mumbai; that is a new project and a second move.
  - Neon keeps its own history of the databases. The nightly copy stays as a second, independent one; dropping it is your call.
  - After a few good days, the old database's volume on the server (`personal-agent_pgdata`) can be deleted.
- **Docs updated:** `aws-setup.md` sections 1, 3, 6, 7, 8 (new part "Moving the databases to Neon") and 14; `hld-mvp.md` section 4 ("What runs on the server") and section 12 ("Built, never run for real"); `backend-report.md` "The services it talks to", section 40 (new part "Where the database lives") and "The nightly backup and the restore test". The README's and `CLAUDE.md`'s local start command now names the `localdb` profile.
- **Commits:** backend `f295947`, `a24ab58`, and the docs commit after them.
