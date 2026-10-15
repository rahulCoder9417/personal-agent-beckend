# AWS test deployment: what was done

This is the record of everything set up in AWS for the test deployment of the Personal Agent platform, on 2026-09-30 and 2026-10-01. It covers the AWS account, the server, what is installed on it, how code gets there, what broke and how it was fixed, and what is still open.

This file describes the test server that exists today. The plan for the later move to a VPS is in `docs/hld-mvp.md`, section 13.

No secret values are written here. Secrets live in two files on the server (`compose.env` and `beckend/.env`) and in the gitignored `.env.deploy` on the laptop.

## Contents

1. [In short](#1-in-short)
2. [The AWS account](#2-the-aws-account)
3. [What was created in AWS](#3-what-was-created-in-aws)
4. [The budget alert](#4-the-budget-alert)
5. [What is installed on the server](#5-what-is-installed-on-the-server)
6. [Files and folders on the server](#6-files-and-folders-on-the-server)
7. [The running services](#7-the-running-services)
8. [How code gets to the server](#8-how-code-gets-to-the-server)
9. [The test user and the outside services](#9-the-test-user-and-the-outside-services)
10. [Problems found on the server and their fixes](#10-problems-found-on-the-server-and-their-fixes)
11. [Stopping and starting the server](#11-stopping-and-starting-the-server)
12. [What it costs](#12-what-it-costs)
13. [Everyday commands](#13-everyday-commands)
14. [What is still open](#14-what-is-still-open)
15. [Timeline](#15-timeline)

---

## 1. In short

| | |
|---|---|
| **Where** | AWS, Mumbai (`ap-south-1`), one EC2 server |
| **Server** | `m7i-flex.large`: 2 vCPU, 7.6 GB RAM, 30 GB disk, Ubuntu 24.04 |
| **Address** | Fixed IP `3.111.132.222`, reached as `https://api.textcrew.in` since 2026-10-08. Before that it was `https://3-111-132-222.sslip.io`, which no longer answers |
| **What runs** | The whole platform in Docker Compose: api, worker, vm-manager, Postgres, Redis, LiteLLM, Caddy, the egress proxy, and one sandboxed container per user |
| **Databases** | Today in the `postgres` container on the server. The code on `main` since 14 October 2026 expects them on Neon (managed Postgres, in Ohio); the move is a script still to be run (section 8, "Moving the databases to Neon") |
| **Code source** | GitHub `main` of both repos, pulled with read-only deploy keys |
| **Deploy** | One command on the server: `/opt/textcrew/deploy.sh` |
| **Paid from** | AWS credits (about $82 left on 2026-09-30) |
| **Cost guard** | A $1 monthly budget that emails `rahulkum94l94@gmail.com` when real spend passes $0.01 |
| **Proven** | A Telegram message → the agent (Claude Code on the user's Claude plan) → a GitHub pull request → an email |

---

## 2. The AWS account

- **Account id:** `152160819518`.
- **Plan:** the AWS free plan, with credits. On 2026-09-30 the console showed **$81.98** of credits left and the free plan ending on **2027-01-11**.
- **Sign-in used:** the **root user** (`rahulkum94l94@gmail.com`). No IAM user exists yet. See section 14.
- **How commands were run:** in **AWS CloudShell**, the terminal inside the AWS console, in the Mumbai region. CloudShell is already signed in as whoever is logged in to the console, so no access keys were created and none exist on the laptop or on the server.
- **Who did what:** you signed in to AWS. Claude drove the browser (Claude in Chrome) to type the commands into CloudShell. Claude never entered a password.

---

## 3. What was created in AWS

All of it was created with one CloudShell command chain on 2026-09-30 at about 16:00 UTC.

| Resource | Value | Notes |
|---|---|---|
| **SSH key pair** | `textcrew-aws` | Only the **public** half was imported into AWS. The private half was generated on the laptop and stays there: `~/.ssh/textcrew_aws` (ed25519) |
| **Security group** | `textcrew-test`, `sg-0a41006d88aefe928`, in the default VPC | The firewall. Rules below |
| **Server (EC2 instance)** | `i-0283ac551a5204d47`, name tag `textcrew-test`, type `m7i-flex.large` | Ubuntu 24.04, image `ami-007b1f3fdea0383d9` (the current official Canonical image, looked up from AWS's own parameter store) |
| **Disk (EBS volume)** | 30 GB `gp3`, root disk | Deleted together with the server if the server is ever *terminated* |
| **Fixed IP (Elastic IP)** | `3.111.132.222` | Attached to the server. It stays the same across stop and start |

**Firewall rules (inbound):**

| Port | From | Why |
|---|---|---|
| 22 (SSH) | One address only: your home IP at the time, as a `/32` | Server administration |
| 80 (HTTP) | Anywhere | Let's Encrypt certificate checks and the redirect to HTTPS |
| 443 (HTTPS) | Anywhere | The api and the webhooks |

Everything else is closed. If your home IP changes, SSH stops working until the port 22 rule is updated (section 13).

**The commands, as run** (your IP replaced by a placeholder):

```sh
# Import the public key
aws ec2 import-key-pair --key-name textcrew-aws --public-key-material "$(echo -n "$KEY" | base64 -w0)"

# Firewall in the default VPC
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 create-security-group --group-name textcrew-test --description textcrew-test --vpc-id $VPC --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $SG --ip-permissions \
  'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=<your IP>/32}]' \
  'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
  'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]'

# Latest Ubuntu 24.04 image, then the server
AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
IID=$(aws ec2 run-instances --image-id $AMI --instance-type m7i-flex.large --key-name textcrew-aws \
  --security-group-ids $SG \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=textcrew-test}]' \
  --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids $IID

# Fixed IP
EIP=$(aws ec2 allocate-address --query '[AllocationId,PublicIp]' --output text)
aws ec2 associate-address --instance-id $IID --allocation-id <allocation id>
```

**Why these choices:**

- **Mumbai:** your choice, closest to you.
- **`m7i-flex.large`:** 8 GB RAM is enough for the platform services (about 0.85 GB) plus a few awake agent containers (about 325 MB each when idle). It costs about $2.50 a day, so the credits cover roughly a month of running non-stop.
- **`sslip.io` host name:** free and needs no DNS setup. `3-111-132-222.sslip.io` simply resolves to `3.111.132.222`, which is enough for a real Let's Encrypt certificate. You own `textcrew.in` and can switch to it later.
- **Shutdown behaviour:** left at the AWS default, **stop**. So shutting the server down from inside stops it and keeps the disk. It does not delete anything.

**Not created:** no IAM users or access keys, no load balancer, no managed database in AWS (Postgres runs in Docker on the server until it moves to Neon, which is outside AWS: section 8), no S3 bucket, no DNS records, no CloudWatch alarms.

---

## 4. The budget alert

You created the budget yourself: **`cloud-editor-zero-spend`**, $1 a month, with one alert, "actual cost greater than $0.01". It counts real cost after credits, so while credits pay for everything it stays at $0.00.

What Claude changed:

1. **The recipient.** The alert was going to a different address (a work mailbox that should not be used for this project). It was changed to the root account address, `rahulkum94l94@gmail.com`:
   ```sh
   aws budgets update-subscriber --account-id 152160819518 --budget-name cloud-editor-zero-spend \
     --notification NotificationType=ACTUAL,ComparisonOperator=GREATER_THAN,Threshold=0.01,ThresholdType=ABSOLUTE_VALUE \
     --old-subscriber SubscriptionType=EMAIL,Address=<old address> \
     --new-subscriber SubscriptionType=EMAIL,Address=rahulkum94l94@gmail.com
   ```
2. **Verification.** AWS sent a "Verify email" message to the Gmail address. It landed in **Spam**. You marked it "not spam" and clicked the link.
3. **Check.** The budget page shows **1/1 email verified**, and `aws notificationscontacts list-email-contacts` lists the Gmail address as `active`. The old address is still listed there as `inactive`; it is no longer on the alert.

The budget page and the verify page often loaded blank under browser automation, which is why the change was made from CloudShell.

---

## 5. What is installed on the server

Measured on the server on 2026-10-01:

| | |
|---|---|
| **OS** | Ubuntu 24.04.5 LTS, kernel `7.0.0-1013-aws` |
| **CPU / RAM** | 2 vCPU, 7.6 GB RAM |
| **Swap** | 4 GB swap file (`/swapfile`), as a safety net when several agent containers are awake |
| **Disk** | 29 GB, 63% used (18 GB), mostly Docker images |
| **Docker** | Docker 29.8.1 with Docker Compose v5.5.1, started at boot |
| **gVisor** | `runsc` release-20260921.0, registered in `/etc/docker/daemon.json` as the `runsc` runtime. User containers run under it |
| **Git** | Used by the deploy script to pull the two repos |

Nothing else was installed on the host. Node, Go, Postgres, Redis and the rest all run inside containers.

**Ports open on the host:** 22, 80 and 443 to the outside. Postgres (5432), Redis (6379), LiteLLM (4000) and the vm-manager's gRPC (9090) listen on `127.0.0.1` only, so they can't be reached from the internet even if the firewall were opened.

---

## 6. Files and folders on the server

Everything is under `/opt/textcrew`, owned by the `ubuntu` user.

| Path | What it is |
|---|---|
| `beckend/` | Git clone of `personal-agent-beckend`, branch `main` |
| `beckend/.env` | The api and worker settings and secrets (mode 600, not in git) |
| `vm-manager/` | Git clone of `personal-agent-vm-manager`, branch `main` |
| `compose.env` | Docker Compose variables (mode 600, not in git) |
| `dc` | Shortcut for `sudo docker compose --env-file compose.env -f beckend/infra/docker-compose.yml …` |
| `deploy.sh` | Shortcut for `beckend/infra/deploy/deploy.sh` |
| `backups/` | Where the nightly backup job writes |
| `old/` | The first copies of the code, from before the switch to git (`beckend.rsync`, `vm-manager.rsync`). Safe to delete |
| `it.sh` | Runner used once for the vm-manager integration tests. Holds no secrets. Safe to delete |

**What `compose.env` sets** (names only): `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `LITELLM_MASTER_KEY`, `VM_INTERNAL_SECRET`, `API_DOMAIN`, `API_UPSTREAM`, `AWAKE_CAP` (3), `PLATFORM_MCP_URL`, `BACKUP_HOST_DIR`, `SANDBOX_RUNTIME` (`runsc`).

**Added for the move to Neon** (section 8): `BACKEND_DATABASE_URL`, `VM_MANAGER_DATABASE_URL` and `LITELLM_DATABASE_URL`, the three Neon addresses. Their values are in `.env.deploy` on the laptop. With them set, the api, worker, vm-manager and LiteLLM use Neon, and `beckend/.env`'s own `DATABASE_URL` is no longer read. The `POSTGRES_*` lines stay: they are what the move script uses to read the old copy.

**What `beckend/.env` sets:** every variable from `.env.example`, checked on 2026-10-01 (names only):

- **Set:** the database and Redis URLs, `PUBLIC_API_URL` and `WEB_APP_URL` (both `https://3-111-132-222.sslip.io`), the encryption key, `CLERK_SECRET_KEY`, the vm-manager URL and shared secret, the LiteLLM URL, master key and model names, the Telegram bot token, bot name and webhook secret, `COMPOSIO_API_KEY` and `COMPOSIO_AUTH_CONFIGS`, `METRICS_TOKEN`, `NODE_ENV=production`, `TRUST_PROXY=true`, `AI_ACCESS_MODE=platform`.
- **Empty:** the model provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), `COMPOSIO_WEBHOOK_SECRET`, `CLERK_WEBHOOK_SECRET`, `CLERK_JWT_KEY`, everything for WhatsApp, Sendblue, Jev and Polar, `BACKUP_UPLOAD_CMD`, `ALERT_WEBHOOK_URL`.
- **Changed on 2026-10-05:** `CLERK_WEBHOOK_SECRET`, `COMPOSIO_WEBHOOK_SECRET` and `BRAVE_SEARCH_API_KEY` are set (supplied by you that day; the laptop's copies are in `.env.deploy` and in a local `.env`), and `BROWSER_AVAILABLE=true` was added once the agent image with the browser was deployed. `beckend/.env.bak` on the server is the file as it was before. Still empty: the three model provider keys (the MiniMax key you supplied has no balance and nothing reads it), `CLERK_JWT_KEY`, Polar, `ALERT_WEBHOOK_URL`. `WEB_APP_URL` and `CLERK_AUTHORIZED_PARTIES` still name the server itself; they wait for the web app's Vercel address.
- **Changed on 2026-10-08, for the beta:** in `compose.env`, `API_DOMAIN=api.textcrew.in` and `AWAKE_CAP=8`. In `beckend/.env`, `PUBLIC_API_URL=https://api.textcrew.in`, `WEB_APP_URL` and `CLERK_AUTHORIZED_PARTIES` are `https://app.textcrew.in` (the web app on Vercel), and `AI_ACCESS_MODE=own_only`, so a user who has not connected their own AI is told to connect it. The files as they were before are `compose.env.bak-2026-10-08` and `beckend/.env.bak-2026-10-08`.

**SSH on the server** (`~/.ssh/`): two deploy keys, `deploy_beckend` and `deploy_vmm`, and a config with two host aliases, `gh-beckend` and `gh-vmm`, that point at `github.com` with the matching key.

**Docker volumes** (the data that must survive): `personal-agent_pgdata` (Postgres; after the move to Neon it is kept, untouched, as the way back), `personal-agent_redisdata` (Redis), `personal-agent_caddydata` (the TLS certificate), and one `pa-data-<user id>` volume per user (the agent's memory, workspace and Claude sign-in).

---

## 7. The running services

Started with `./dc --profile app up -d`. All long-running services restart on their own after a reboot.

| Service | Image | Job |
|---|---|---|
| `caddy` | `caddy:2` | The only public entry. Gets the Let's Encrypt certificate for `api.textcrew.in` and forwards to the api |
| `api` | built from `beckend/infra/Dockerfile` | REST, webhooks, the Platform MCP (`/mcp`) and the git gateway (`/git`) |
| `worker` | same image as the api | Runs the BullMQ jobs: messages, replies, schedules, backups |
| `vm-manager` | built from `vm-manager/` | Creates, wakes and stops the user containers. The only service with the Docker socket |
| `postgres` | `postgres:16` | The three databases (backend, vm-manager, LiteLLM). After the move to Neon it is stopped and no longer started: it is behind the `localdb` profile, which only the laptop uses |
| `redis` | `redis:7` | Queues, locks, rate limits |
| `litellm` | `ghcr.io/berriai/litellm:main-stable` | Model gateway and per-user keys |
| `egress-proxy` | `ubuntu/squid` | The only way out of user containers |
| `agent-image` | `personal-agent/agent:dev` | Build-only: it builds the agent image and exits. "Exited (0)" is normal |
| `pa-sbx-<user id>` | `personal-agent/agent:dev`, under gVisor | One per user, started by the vm-manager, stopped after 3 idle minutes |

**Networks:** `personal-agent_edge` (Caddy and the api), `personal-agent_platform` (the services), `personal-agent_sandbox` (user containers and the egress proxy, with no internet). The egress proxy has the fixed address `172.30.0.2`; user containers get addresses from `172.30.128.0/17`.

**Checks that passed on the server:**

- `https://api.textcrew.in/healthz` (first `https://3-111-132-222.sslip.io/healthz`) returns `{"status":"ok"}` with a real Let's Encrypt certificate.
- The egress test, 5 of 5: no direct internet from a container, no direct LiteLLM, the proxy refuses a domain that isn't allowed, and allows LiteLLM.
- gVisor works: a test container reports the kernel `4.19.0-gvisor`.
- vm-manager integration tests against real Docker and gVisor: idle stop and wake with memory kept, the awake cap, and egress only through the allowlist all pass. One test fails as expected: a Hermes turn with no platform model key (section 14).
- RAM: about 325 MB for one awake container that isn't in a turn, about 0.85 GB for the platform services.

---

## 8. How code gets to the server

**First version (2026-09-30, a few hours):** the code was copied from the laptop with `rsync`. The server had no link to GitHub.

**Now:** the server pulls from GitHub `main`.

1. Both GitHub repos are private, so the server has two **read-only deploy keys**, one per repo (GitHub doesn't allow one key on two repos). They were generated on the server. The public halves were added in GitHub under each repo's Settings → Deploy keys, titled `textcrew-server`, with write access off.
2. `/opt/textcrew/beckend` and `/opt/textcrew/vm-manager` are clones of `main`, through the `gh-beckend` and `gh-vmm` SSH aliases.
3. `/opt/textcrew/deploy.sh` does a deploy:
   1. fetch both repos and hard-reset them to `origin/main`
   2. build the images (cached layers are reused)
   3. record the new agent image id, so user containers are re-created from it on their next wake
   4. check that `compose.env` has the three Neon database addresses (it stops here if not), then run the backend's database migrations on Neon
   5. `up -d`, and recreate Caddy, LiteLLM or the egress proxy if their config file changed
   6. check `/healthz` and that every service is running; exit with an error otherwise

**To ship a change:** push to `main`, then run `ssh -i ~/.ssh/textcrew_aws ubuntu@3.111.132.222 /opt/textcrew/deploy.sh`. A push alone does not update the server; there is no GitHub Actions workflow.

A deploy restarts the api and worker for a few seconds. A Telegram message that arrives in that window is saved and retried.

### Moving the databases to Neon

Decided on 14 October 2026: the three databases leave the server's `postgres` container for Neon, a managed Postgres. The Neon project is in Ohio (`us-east-2`), not Mumbai, and you chose that knowing each database query from the server then takes about 260 ms instead of under 1 ms.

| On the server today | On Neon |
|---|---|
| `agent` (the backend) | `agent` |
| `vm_manager` | `vm_manager` |
| `litellm` | `litellm` |

Neon's own `neondb` database is not used by the backend: the landing page's waitlist already lives there, with its own migration records in the same place the backend keeps its own. Sharing it would make the backend skip some of its migrations.

All three services connect to Neon's **direct** address (the host name without `-pooler`), not the pooled one. LiteLLM sets up its tables at start in a way that does not work through Neon's pooler, the vm-manager's migrations hold a lock for the whole connection, and the nightly backup's `pg_dump` also needs the direct address. The backend works through the pooler too (tested), but one rule for all three is simpler, and the server keeps few long-lived connections, well under Neon's limit of 901.

**What runs the move:** `beckend/infra/deploy/move-to-neon.sh`. It checks everything first and changes nothing until every check passes: the three addresses are in `compose.env`, the old copy answers, and each Neon database is empty or missing (a missing one is created). Then it stops the api, worker, vm-manager and LiteLLM, copies each database with the Postgres 18 tools, compares the number of rows in every table on both sides, stops the old `postgres` (its volume is kept) and runs `deploy.sh`, which starts everything on Neon. It refuses to copy into a Neon database that already has tables, unless it is run with `--force`. The copies and the row counts stay in `backups/neon-move-<time>/`.

**Steps, on the server, from `/opt/textcrew`:**

1. `./deploy.sh`, before touching `compose.env`. It pulls the new code, then stops on purpose with "compose.env has no ...". Nothing is rebuilt or restarted; the services keep running on the old copy. Do not add the lines first: a deploy with them in place would start everything on the empty Neon databases.
2. Keep a copy of `compose.env`, then add the three lines from `.env.deploy` (`BACKEND_DATABASE_URL`, `VM_MANAGER_DATABASE_URL`, `LITELLM_DATABASE_URL`).
3. `beckend/infra/deploy/move-to-neon.sh --dry-run`. It prints each database, its table count here, and whether it is missing or empty on Neon. Nothing is changed.
4. `beckend/infra/deploy/move-to-neon.sh`. Expect a few minutes: the bot does not answer while it runs. It ends with the deploy's health check.
5. Send the bot a message, and open the web app.

**To go back** (if the move fails part way, or something is wrong after it): remove the three lines from `compose.env`, then `./dc --profile localdb --profile app up -d`. The old copy is exactly as it was when the services stopped. Anything written on Neon after the move would be lost by going back.

---

## 9. The test user and the outside services

There is no web app yet, so the test user was made with `scripts/dev-user.ts`, run inside the api container.

| | |
|---|---|
| **User** | `usr_01m3sk0g2wwgm7wj60822scjtp`, `rahul.test@textcrew.dev`, plan `max`, 2,100 credits (100 sign-up + 2,000 granted for testing) |
| **Telegram** | Bot `@TestingtexBot`. Webhook set to `https://api.textcrew.in/webhooks/telegram` with a secret token (moved there on 2026-10-08). Linked to your Telegram with a one-time link code |
| **AI** | Your Claude plan, through Claude Code in the container. You opened the sign-in link, approved it, and gave back the code. The sign-in is stored only in the user's own volume |
| **Composio** | GitHub (`ac_b8PkSZuqwhjX`) and Gmail (`ac_eWrMykXPOfRE`) auth configs. You approved both connect links. Both are `active` |
| **Clerk** | Test keys are set. Not used by the Telegram flow |
| **Polar, WhatsApp, Sendblue, Jev** | Not set up. Skipped for this test |

**The end-to-end test (2026-09-30):** a Telegram message asked the agent to look at `rahulCoder9417/personal-agent-beckend`, add a file on a new branch, open a pull request and email the link. It worked. That run used the GitHub API through Composio.

**Added on 2026-10-01:** the git gateway, so the agent can use real `git clone` and `git push` without a GitHub token in its container (HLD section 5.1). It is deployed. It has not yet done a real clone or push.

---

## 10. Problems found on the server and their fixes

All of these only showed up on a real server. Each fix is committed and on `main`.

| # | Problem | Cause | Fix |
|---|---|---|---|
| 1 | The api and worker would not start | `FREE_CREDITS_MONTHLY_CAP=` (empty, as in `.env.example`) was read as 0 | Empty env values are treated as unset (`a113934`) |
| 2 | The egress proxy exited at once | Squid runs as the `proxy` user and couldn't open `/dev/stdout` | Squid logs to `/var/log/squid`, and the container tails those files (`5cd0644`) |
| 3 | "Address already in use" when starting the egress proxy | The vm-manager's container was given the proxy's fixed IP `172.30.0.2` | The sandbox network hands out dynamic addresses only from `172.30.128.0/17` (`05365bb`) |
| 4 | The egress test reported a false failure | It printed two status codes joined together ("000403") | The test reads the CONNECT status on its own (`ddec320`) |
| 5 | Per-user allowlists were never applied, so Claude Code couldn't reach Anthropic | The image's shell script was PID 1 and dropped the reload signal | Squid runs as PID 1 (`51d78d0`) |
| 6 | A new agent image didn't reach existing user containers | The image id wasn't passed to the vm-manager (and `sudo` dropped it) | `AGENT_IMAGE_VERSION` is passed through (`dc5fdfd`, `fef61a2`) |
| 7 | The agent image didn't build | Hermes no longer builds as a wheel | Hermes is installed from a pinned source checkout (vm-manager `e031df1`) |
| 8 | GitHub and Gmail stayed "pending" after you approved them | Only the web app's app list refreshed the status, and there is no web app | Set to active by hand on the server. **The code fix is still open** (section 14) |
| 9 | After the first stop and start, the bot didn't answer | A hard stop left Squid's PID file behind. It said "PID 1", which is Squid's own PID on the next start, so Squid refused to start | The stale file is removed at start (`2998ad4`). Tested by killing and restarting the container |
| 10 | The nightly backup failed | `pg_dump` wasn't in the api/worker image | `pg_dump` 16 is installed in the image (`73e76b0`). The backup job has not run since, so it is not yet proven |
| 11 | After the second stop and start (2026-10-04), the egress proxy again did not come back, so the agent could reach nothing | The vm-manager reloads Squid with `docker kill -s HUP`. Docker marks a container that was sent any signal that way as stopped by hand (`HasBeenManuallyStopped` was `true` on the proxy and `false` on every other container), and a container with `restart: unless-stopped` that was stopped by hand is not started when Docker starts | The proxy uses `restart: always` and an explicit `stop_signal`. To prove: stop and start the server once more and check the proxy is up without help |
| 12 | After the stop and start of 2026-10-05 the site did not answer (ports 80 and 443 refused), though AWS showed the server as healthy | The deploy of 2026-10-04 13:02 UTC was cut off when its SSH session ended: it had pulled the new code and built three images, but not the agent image, and it never recreated the containers. Caddy kept running with its old settings until the restart, then read the new `Caddyfile`, which has a block for `{$WEB_DOMAIN}`; its container had no such variable, so the block had no name and Caddy stopped with "server block without any key is global configuration" in a restart loop | A complete deploy recreates Caddy with the variable. **A deploy is now started in the background on the server** (section 13), so a lost connection can't cut it off |
| 13 | The first build of the agent image with the browser failed at its last step, the browser's self-check: `Browser "chromium" is not installed` | The image has only the full Chromium, and the Bridge's settings made Playwright look for its separate headless shell | One setting in the Bridge, `launchOptions.channel: chromium` (`vm-manager` `530b67c`). Tried first on the server in an image built without the self-check; then the deploy passed |

---

## 11. Stopping and starting the server

**Stopped on 2026-09-30 at about 17:09 UTC** with `sudo shutdown -h now` from inside the server. With the default shutdown behaviour this *stops* the instance. The disk, the fixed IP and all data are kept.

**Started on 2026-10-01 at about 04:41 UTC** by you, from the EC2 console. The AWS console session had expired overnight, and Claude can't enter your password.

**Stopped on 2026-10-01 at about 15:45 UTC** the same way, and left off for three days.

**Started on 2026-10-04 at about 06:22 UTC** from CloudShell, after you signed in to AWS: `aws ec2 start-instances --instance-ids i-0283ac551a5204d47`. Your home internet address had changed since the firewall rule was made, so SSH timed out until the port 22 rule was replaced with the new address (you ran the two commands in section 13 yourself; Claude doesn't change firewall rules). The website itself answered straight away, because ports 80 and 443 are open to everyone.

**To stop it:** EC2 console → Instances → `textcrew-test` → Instance state → **Stop instance**. Never choose **Terminate**: that deletes the server and its disk.

**To start it:** the same menu → **Start instance**, or in CloudShell (Mumbai) `aws ec2 start-instances --instance-ids i-0283ac551a5204d47`. The services come back on their own in about a minute, at the same address. Then check SSH: if it times out, your home address changed and the port 22 rule needs replacing (section 13).

While it is stopped the bot does not answer, and Telegram messages sent then are not delivered later with any guarantee.

---

## 12. What it costs

Approximate, paid from credits:

| State | Cost |
|---|---|
| Running | About $2.50 a day (the server), plus the items below |
| Stopped | About $0.20 a day: the 30 GB disk and the fixed IP are still charged |

With about $82 of credits that is roughly a month of running non-stop, or much longer if the server is stopped when not in use. The budget alert in section 4 emails you as soon as real money would be charged.

---

## 13. Everyday commands

From the laptop:

```sh
# Log in
ssh -i ~/.ssh/textcrew_aws ubuntu@3.111.132.222

# Deploy the latest main. In the background on the server, so a lost connection can't cut it off
# (problem 12); the output goes to deploy.log and the exit code to deploy.exit
ssh -i ~/.ssh/textcrew_aws ubuntu@3.111.132.222 'cd /opt/textcrew && rm -f deploy.exit && (nohup sh -c "./deploy.sh > deploy.log 2>&1; echo \$? > deploy.exit" > /dev/null 2>&1 < /dev/null &)'
ssh -i ~/.ssh/textcrew_aws ubuntu@3.111.132.222 'cat /opt/textcrew/deploy.exit; tail -n 20 /opt/textcrew/deploy.log'
```

On the server, from `/opt/textcrew`:

```sh
./dc --profile app ps -a                       # what is running
./dc --profile app logs --since 10m api worker # recent logs
./dc --profile app logs -f vm-manager          # follow the container manager
sudo docker ps --filter name=pa-sbx            # awake user containers

# The request log: one line per api request (backend-report.md, section 4). The id of one request
# is in its answer's X-Request-Id header, and in `details.requestId` of a 500 answer
./dc --profile app logs --since 1h api | grep '"msg":"request"'   # every request of the last hour
./dc --profile app logs --since 1h api | grep '"level":50'        # errors only: a 5xx, or a failure in a route
./dc --profile app logs --since 24h api | grep req_01m5a2b3c4d5e6  # every line of one request, by its id

# The test user (create, link-code, claude-login, claude-complete, connect-app, status, browser,
# send, messages, activity, approve, pr-review, memories)
./dc --profile app exec -T api node --import tsx scripts/dev-user.ts status --user usr_01m3sk0g2wwgm7wj60822scjtp
```

**If SSH stops working because your IP changed,** in CloudShell (Mumbai). Your home address changes from time to time, so expect this after the server has been off for a few days. The first command shows the address the rule allows now; your current one is at https://checkip.amazonaws.com:

```sh
aws ec2 describe-security-groups --group-ids sg-0a41006d88aefe928 --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp' --output text
```

Then replace it:

```sh
aws ec2 revoke-security-group-ingress    --group-id sg-0a41006d88aefe928 --protocol tcp --port 22 --cidr <old IP>/32
aws ec2 authorize-security-group-ingress --group-id sg-0a41006d88aefe928 --protocol tcp --port 22 --cidr <new IP>/32
```

---

## 14. What is still open

**Security**

- **The root user is used for everything.** Create an IAM user with MFA for daily work and turn on MFA for root.
- **`/mcp` and `/git` are reachable from the internet.** Both require the container token, but only the user containers need them. They can be blocked at Caddy. **Fixed in code on 2026-10-03** (Caddy answers 404 for both) **and seen on the server on 2026-10-05:** from outside, `/mcp` and `/git/…` both answer 404, while the containers still reach them through the egress proxy.
- **No off-server backups.** `BACKUP_UPLOAD_CMD` is empty, so backups stay on the same disk as the data. There is also no EBS snapshot.

**Not proven yet**

- **The git gateway against real GitHub:** a real clone, a branch push, and the refusal of a push to the default branch. It also depends on Composio returning the GitHub token to the api, which has not been confirmed.
- **The nightly backup** after the `pg_dump` fix, and a restore from it. Since 14 October the image has `pg_dump` 18, to match Neon. Neon also keeps its own history of the databases, so the nightly copy is a second, independent one.
- **The move to Neon** (section 8) is written and was tried from the laptop into scratch Neon databases, but has not been run on the server.
- **RAM with several users awake.** One user's container with the browser used 625 to 661 MiB of its 2 GiB limit after a turn (2026-10-05); the peak with a heavy page open was not measured.
- **Composio's webhook reaching the server.** The secret is set (2026-10-05); no delivery from Composio has been seen yet, so pull-request review's trigger is unproven.
- **Clerk's webhook reaching the server.** The secret is set (2026-10-05); it is used once the web app has an address and someone signs in there.

**Known gaps**

- **App connections stay "pending" without the web app** (problem 8). Two things would update them and neither is in place: the web app's app list, and Composio's webhook (`COMPOSIO_WEBHOOK_SECRET` is empty, so no webhook is set up). The server should also ask Composio itself. **Fixed in code on 2026-10-03** (the `check-connection` job); it takes effect at the next deploy.
- **No platform model key, but the server is in `platform` mode.** `AI_ACCESS_MODE=platform` means a user who brings no AI of their own is served by Hermes on platform credits. There is no OpenRouter, Anthropic or OpenAI key on the server, so that turn fails (and one integration test fails for the same reason). Only a user who connects their Claude plan gets answers. Either add a provider key, or set `AI_ACCESS_MODE=own_only` so such users are told to connect their own AI instead of getting an error.
- **No alert channel.** `ALERT_WEBHOOK_URL` is empty, so failures such as the nightly backup are only in the logs.
- **No web app, no Polar,** and no WhatsApp or iMessage.
- **Leftovers on the server:** `/opt/textcrew/old/`, `/opt/textcrew/it.sh`, and a few LiteLLM test keys with a $1 budget.
- **Disk is 63% full** (18 of 29 GB on 2026-10-05, with the 2.78 GB agent image). Image rebuilds add to it; prune the Docker build cache when it grows. A user whose container has the browser adds about 0.5 GB to their volume, because Hermes downloads its own tools there (the vm-manager's build report, section 9), and there is no `/data` quota.
- **The domain** moved from `sslip.io` to `api.textcrew.in` on 2026-10-08 (`docs/domain-setup.md` explains the DNS). The webhooks at Clerk and Composio must name the new address; that edit is yours.
- **No automatic deploy.** A push to `main` needs `deploy.sh` to be run by hand.

---

## 15. Timeline

All times UTC.

| When | What |
|---|---|
| 2026-09-30 15:59 | Checked the account and that no servers existed, in CloudShell |
| 16:00 | Imported the SSH key, created the firewall, the server and the fixed IP |
| 16:03–16:30 | Installed Docker and gVisor, copied the code, built and started the stack, fixed problems 1–7, ran the egress and integration tests |
| 16:22 | Changed the budget alert's recipient to the Gmail address |
| 16:30–16:40 | Pushed both repos to `main`, added the deploy keys, switched the server to git, added `deploy.sh` |
| 16:40 | Budget email verified |
| 16:43–16:55 | Test user: Telegram linked, Claude plan connected, GitHub and Gmail connected |
| about 17:00 | End-to-end test passed: Telegram → pull request → email |
| 17:09 | Server stopped for the night |
| 2026-10-01 04:41 | Server started |
| 04:43 | Egress proxy found down (problem 9), restarted by hand |
| about 04:50 | Fixes for problems 9 and 10 pushed and deployed |
| about 05:00 | Git gateway built, pushed and deployed |
| 15:45 | Server stopped |
| 2026-10-04 06:22 | Server started from CloudShell. SSH rule replaced by the founder (home address had changed). Egress proxy found down again (problem 11) |
| 2026-10-05 06:36 | Server stopped from CloudShell (`aws ec2 stop-instances`), at your request; SSH was locked out by a changed home address |
| 10:47 | Server started from CloudShell. The site did not answer (problem 12) |
| about 11:00 | SSH rule replaced by you. The two webhook secrets put into `beckend/.env` |
| 11:10 | Deploy: the agent image's browser self-check failed (problem 13) |
| 11:21–11:26 | Fix pushed, deploy passed: the site answers, `/mcp` and `/git` are closed from outside, migrations applied, the agent image has the browser (2.78 GB) |
| 11:27 | `BROWSER_AVAILABLE=true`, the browser switched on for the test user; the proxy rule checked on Squid 6.13 before the first wake |
| 11:28–11:34 | The browser's self-check passed inside the user's container; three turns in which Scout used the browser; browser time charged (1 credit at 33 seconds) |
| 11:30–11:46 | The lead refuses to use the browser itself; the platform's `remember` works when named, but the lead prefers Claude Code's own memory; idle stop after 3 min 58 s; a second start downloads nothing again |
| 12:05 | Server stopped (`sudo shutdown -h now`), at your request |
| 2026-10-08 about 12:45 | Server started from CloudShell. DNS record `api.textcrew.in` created at Vercel |
| 12:57 | Deploy passed on the new address: Caddy got the certificate for `api.textcrew.in`, the awake limit is 8, Textcrew AI is off. The Telegram webhook was moved. A test turn answered in 11 seconds |
| about 13:00 | The web app went live on Vercel at `https://app.textcrew.in` (project `textcrew-app`) |
| 14:35 | Deploy of the day's fixes: the agent image's memory and Hermes fixes, the own API key through LiteLLM, the Telegram linking fixes, `CLERK_JWT_KEY` on the api |
| 15:44 | Deploy of the failed-turn fixes (the apology always sent, the refund as a job, failed turns not kept in the session, the idle stop). Checked on the server |
| 15:48 | Server stopped (`sudo shutdown -h now`), at your request |
| about 16:05 | Server started by you |
| 16:36 | Deploy: a new chat, Claude Code's model and effort, the Telegram `/new` command. Your account `user7867575@gmail.com` moved to Max with 9,999,999 extra credits (`dev-user.ts plan` and `credits`) |
