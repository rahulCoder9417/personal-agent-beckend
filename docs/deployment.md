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
- Secrets (Clerk, Meta, Telegram, Sendblue, Composio, Dodo, Jev, OpenRouter, Anthropic/OpenAI, internal gRPC secret, encryption key) go in a `.env` file on the server, readable only by the deploy user, and **never committed**.

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
