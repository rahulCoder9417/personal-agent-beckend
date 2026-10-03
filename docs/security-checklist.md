# Security checklist (HLD 10.2): status

"Code" means it is implemented and covered by tests. "Deploy" means it can only be verified on a server with Docker (not possible on the dev machine yet).

| # | Item | Where | Status |
|---|---|---|---|
| 1 | Only Caddy is exposed; everything else on private networks; `/mcp` and `/git` answer 404 from outside | `infra/docker-compose.yml` (only Caddy publishes 80/443; dev ports bound to 127.0.0.1; `sandbox` is `internal: true`); `infra/caddy/Caddyfile` (404 for `/mcp*` and `/git/*`) | Code; verify on deploy |
| 2 | Every webhook verified before parsing, and deduplicated | Clerk (svix), Telegram (secret header), WhatsApp (HMAC), Sendblue (secret), Polar (standard webhooks), Composio (SDK verify) → `ingestEvent` (unique source + external id, jobId = event id) | Code + tests |
| 3 | Docker socket mounted only in the vm-manager | `infra/docker-compose.yml` | Code; verify on deploy |
| 4 | Containers: gVisor, limits, read-only, sandbox network, egress allowlist, own secrets only | vm-manager container spec; `infra/egress-proxy/squid.conf`; `infra/tests/egress-test.sh` | Code; run the egress test on deploy |
| 5 | No Composio/provider/DB keys in containers; Platform MCP forces the user id from the token | Containers get only their LiteLLM key, MCP token, Bridge secret; `/mcp` maps sha256(token) → user (`sandbox_tokens`); tools never read a user id from arguments | Code + tests (cross-user tests in phase 3/4) |
| 6 | Secrets encrypted in Postgres; tokens and codes stored as hashes | AES-256-GCM (`src/shared/crypto.ts`) for MCP secrets, BYOK and LiteLLM keys; link codes, coupon codes and MCP tokens are sha256 | Code + tests |
| 7 | Approvals before sending to others, deleting or paying; audit log for every action | `actionNeedsApproval` + single-use, exact-args approvals in `run_app_action`; every MCP tool call is audit-logged | Code + tests |
| 8 | Coupon rules (7.7); rate limits on redeem, link codes and login-linked endpoints | Billing module; link codes 10/h per user, link attempts 10/h per chat, messages 30/min, /mcp 240/min, every endpoint 600/min per IP | Code + tests |
| 9 | Nightly off-server backups with a tested restore | `system/backup` job (pg_dump + SnapshotVolume + `BACKUP_UPLOAD_CMD`), `scripts/restore-test.sh` | Job logic tested with fakes; the real restore must be run on the server |
