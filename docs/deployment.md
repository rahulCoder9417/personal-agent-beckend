# Deployment (MVP)

Hosting and server setup for the system in `mvp-hld.md`. **Not needed for writing the code.** Use this when putting it on a server.

## Server

- **Contabo Cloud VPS 6:** 6 shared vCPU, 12 GB RAM, 200 GB SSD, 300 Mbit/s port, 1-month term (~$10.62 + 18% GST ≈ $12.5/month).
- **Region:** Singapore or Mumbai (check the price at checkout).
- **OS:** Ubuntu 24.04.
- The web app is hosted separately on Vercel.

## Host hardening

- SSH with a key only; password login off; root login off.
- Firewall: allow only **22, 80, 443**.
- Automatic security updates (`unattended-upgrades`).
- Docker + the **gVisor** runtime (`runsc`) installed and registered with Docker.
- Contabo's 2 included snapshots turned on, **plus** off-server backups (below).

## Services (Docker Compose)

| Service | Networks | Notes |
|---|---|---|
| caddy | edge | Only public service (80/443); HTTPS for `api.` domain |
| api | edge, platform | 1–2 processes |
| worker | platform | Job concurrency ~20 |
| vm-manager | platform, sandbox | Docker socket mounted; restart always |
| postgres | platform | Nightly dump |
| redis | platform | Append-only persistence on |
| litellm | platform | Own database in Postgres |
| egress-proxy | platform, sandbox | Allowlists written by the vm-manager |
| user containers | sandbox | Created on demand by the vm-manager, not in the compose file |

## Deploying (from GitHub `main`)

The server runs git clones of `main`, never copied files. Layout under `/opt/textcrew`:

| Path | What |
|---|---|
| `beckend/` | clone of `personal-agent-beckend` (`git@gh-beckend:…`); its `.env` holds the api/worker secrets (mode 600, gitignored) |
| `vm-manager/` | clone of `personal-agent-vm-manager` (`git@gh-vmm:…`); must stay a sibling of `beckend/` (compose builds `../../vm-manager`) |
| `compose.env` | compose variables: `POSTGRES_PASSWORD`, `LITELLM_MASTER_KEY`, `VM_INTERNAL_SECRET` (same as in `beckend/.env`), `API_DOMAIN`, `API_UPSTREAM=api:8080`, `AWAKE_CAP`, `BACKUP_HOST_DIR`, `SANDBOX_RUNTIME` |
| `dc` | `docker compose --env-file compose.env -f beckend/infra/docker-compose.yml "$@"` |
| `deploy.sh` | runs `beckend/infra/deploy/deploy.sh` |
| `backups/` | `BACKUP_HOST_DIR` (owned by uid 1000, the api/worker user) |

Each repo has its own read-only GitHub **deploy key** on the server (`~/.ssh/deploy_beckend`, `~/.ssh/deploy_vmm`; GitHub won't take one key on two repos), selected by the `gh-beckend` / `gh-vmm` host aliases in `~/.ssh/config`.

**To deploy:** push to `main`, then on the server run `/opt/textcrew/deploy.sh`. It:

1. `git fetch` + `git reset --hard origin/main` in both repos (untracked runtime files such as `.env` and the per-user Squid allowlists are kept);
2. builds the images (unchanged layers are cached) and sets `AGENT_IMAGE_VERSION` to the agent image id, so stopped user containers are re-created from a new image on their next wake (their `/data` is kept);
3. runs the migrations (`pnpm db:migrate` in a one-off api container);
4. `docker compose --profile app up -d`, and force-recreates Caddy / LiteLLM / Squid + vm-manager when their bind-mounted config changed;
5. checks `https://$API_DOMAIN/healthz` and that every service is running; exits non-zero otherwise.

Other checks: `./dc --profile egress-test run --rm egress-test` (egress isolation).

## Sizing on 12 GB RAM

- About **3 GB** for the OS + the services above.
- About **9 GB** for user containers. At ~400 MB each, that's **~15–20 awake at once ≈ 150–250 total users**.
- Set the vm-manager's **awake cap** from the RAM measured in Phase 2.
- At most 2 browser sessions at once.
- CPU is shared (it can slow at busy times). That's fine, because containers mostly wait on external APIs.

## Backups

- Nightly: Postgres dump + every user's `/data` snapshot → off-server storage (e.g. Backblaze B2), encrypted.
- Test a restore once a month.

## DNS and secrets

- DNS: `api.<domain>` → the VPS IP. The web app's domain → Vercel.
- Secrets (Clerk, Meta, Telegram, Sendblue, Composio, Polar, Jev, OpenRouter, Anthropic/OpenAI, internal gRPC secret, encryption key) go in a `.env` file on the server, readable only by the deploy user, and **never committed**.

## Monthly cost

| Item | Cost |
|---|---|
| VPS | ~$12.5 |
| Domain | ~$1 |
| Free-plan AI budget | ~$10 |
| Clerk, Vercel, Composio, Telegram, WhatsApp test number | $0 |
| **Total** | **~$24** |

## When to move

Move to a steadier host (Hetzner, DigitalOcean) or full VMs (Boat or similar) when paying users grow, when more than ~20 containers need to be awake at once, or when users need heavy browser use.
