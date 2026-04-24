# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

SST v3 app that provisions a persistent **Hermes Agent** host on AWS EC2 plus a minimal Next.js dashboard. The core engineering goal is that `~/.hermes/` on the EC2 instance survives spot interruptions — `deleteOnTermination: false` on the root EBS volume is the single most important line in the repo (`infra/instance.ts:71`).

## Commands

```bash
# Install dependencies
pnpm install

# Deploy
pnpm run deploy        # dev stage (sst deploy --stage dev)
pnpm run deploy:prod   # production stage (protected from accidental destroy)
pnpm run destroy       # tear down dev stage only

# SST console / dev mode
pnpm run console
pnpm run dev

# Dashboard local dev only (not needed for SST deploy)
cd web && pnpm dev
```

## Environment

Copy `.env.example` → `.env`. Required vars:

| Var | Purpose |
|-----|---------|
| `AWS_REGION` | Target region (default `us-east-1`) |
| `KEY_NAME` | Name of an **existing** EC2 key pair in that region |
| `MY_IP` | Your public IP in CIDR form (`x.x.x.x/32`) — SSH ingress allowlist |
| `AUTH_SECRET` | NextAuth secret (`openssl rand -base64 32`) |
| `AUTH_GOOGLE_ID` | Google OAuth client ID (dashboard login) |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `AUTH_ALLOWED_EMAIL` | Single email address allowed to log in to the dashboard |

Optional: `INSTANCE_TYPE` (default `t4g.medium`), `ROOT_VOLUME_GB` (default `40`).

`MY_IP` must be kept current — change networks → update `.env` → redeploy `infra/network.ts`.

## Architecture

SST v3 uses Pulumi under the hood. `sst.config.ts` imports four modules evaluated in dependency order:

```
sst.config.ts
├── infra/network.ts   → Security group (SSH from MY_IP only, all egress)
├── infra/instance.ts  → Spot EC2 + EBS + EIP + IAM/SSM role (depends on network)
├── infra/backup.ts    → DLM lifecycle policy targeting tag Name=hermes-root
└── infra/web.ts       → SST Nextjs on Lambda+CloudFront (depends on instance)
```

**Spot instance design:** `spotType=persistent` + `instanceInterruptionBehavior=stop` means AWS pauses on capacity loss rather than terminating. The EIP detaches on interruption but the EBS volume (and its data) remains. The dashboard's "Re-associate Elastic IP" button handles recovery.

**Dashboard (`web/app/page.tsx`):** Single Next.js 15 React Server Component. All data fetching is server-side via AWS SDK (EC2, CloudWatch, SSM, Cost Explorer). Three server actions: re-associate EIP, restart the hermes-gateway service via SSM, and sign out. Auth is Google OAuth via NextAuth (`web/auth.ts`) — only the email in `AUTH_ALLOWED_EMAIL` can log in. Cost Explorer is hardcoded to `us-east-1` (AWS requirement) and filters by tag `Project=hermes`.

**SSM dependency:** The dashboard's "Restart service" button and status checks use SSM `AWS-RunShellScript`. The instance needs the SSM agent running and the IAM role attached (`infra/instance.ts` provisions both). If SSM commands return "unavailable", the agent is likely not running or the instance profile isn't attached.

**`scripts/user-data.sh`:** Cloud-init that runs once as root on first boot — installs Node 20, Claude Code, creates the `hermes` user, adds 4 GB swap, configures UFW, and installs Hermes Agent. Interactive Hermes config (API keys, gateway) happens manually over SSH after deploy.

## Repository layout (non-obvious parts)

| Path | Purpose |
|------|---------|
| `docs/hermes-family-assistant.md` | Full ops manual for multi-user setup (hermes + alice + future family members) |
| `docs/alice-config.yaml` | Hermes config for the `alice` user — Telegram-only, vault-scoped, no shell/delegation |
| `skills/` | Version-controlled Hermes skill files. Deploy with `scp skills/<name>.md hermes:~/.hermes/skills/` |
| `scripts/user-data.sh` | Cloud-init for first boot — edit this to change what gets installed on the instance |
| `Sync Quickstart.md` | Syncthing + Obsidian vault setup guide (EC2 ↔ Windows ↔ Android) |

## Stage behavior

| Stage | `removal` | `protect` |
|-------|-----------|-----------|
| `dev` | `"remove"` | false — `sst destroy` wipes everything |
| `production` | `"retain"` | true — resources protected from stack deletion |

SST state is stored in AWS (SSM + S3) under `home: "aws"`.
