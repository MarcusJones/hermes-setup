# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

SST v3 app that provisions a persistent **Hermes Agent** host on AWS EC2 plus a minimal Next.js dashboard. The core engineering goal is that `~/.hermes/` on the EC2 instance survives spot interruptions — `deleteOnTermination: false` on the root EBS volume is the single most important line in the repo.

## Commands

```bash
# Install dependencies
pnpm install           # or npm install

# Deploy
pnpm run deploy        # dev stage (sst deploy --stage dev)
pnpm run deploy:prod   # production stage (protected from accidental destroy)
pnpm run destroy       # tear down dev stage only

# SST console / dev mode
pnpm run console
pnpm run dev

# Dashboard (web/ workspace) — local dev only, not needed for SST deploy
cd web && pnpm dev
```

## Environment

Copy `.env.example` → `.env` and fill in three required vars before any deploy:

| Var | Purpose |
|-----|---------|
| `AWS_REGION` | Target region (default `us-east-1`) |
| `KEY_NAME` | Name of an **existing** EC2 key pair in that region |
| `MY_IP` | Your public IP in CIDR form (`x.x.x.x/32`) — SSH ingress allowlist |

Optional: `INSTANCE_TYPE` (default `t4g.medium`) and `ROOT_VOLUME_GB` (default `40`).

`MY_IP` must be kept current — change networks → update `.env` → redeploy `infra/network.ts`.

## Architecture

SST v3 uses Pulumi under the hood. `sst.config.ts` imports four modules that are evaluated in dependency order at deploy time:

```
sst.config.ts
├── infra/network.ts   → Security group (SSH from MY_IP only, all egress)
├── infra/instance.ts  → Spot EC2 + EBS + EIP (depends on network)
├── infra/backup.ts    → DLM lifecycle policy targeting tag Name=hermes-root
└── infra/web.ts       → SST Nextjs component on Lambda+CloudFront (depends on instance)
```

**Spot instance design:** `spotType=persistent` + `instanceInterruptionBehavior=stop` means AWS pauses the instance on capacity loss rather than terminating it. The Elastic IP detaches on interruption but the EBS volume (and its data) remains. The dashboard's "Re-associate Elastic IP" button handles recovery.

**Dashboard (`web/`):** Single Next.js 15 React Server Component page. Uses AWS SDK server-side to call EC2 describe APIs; the reassociation is a Next.js server action. No client-side JS beyond the form submit. Deployed via `sst.aws.Nextjs` which provisions Lambda + CloudFront. IAM permissions are scoped to the four EC2 APIs it needs.

**`scripts/user-data.sh`:** Cloud-init that runs once as root on first boot — installs Node 20, Claude Code, creates a `hermes` user, adds 4 GB swap, configures UFW, and installs Hermes Agent. Interactive Hermes config (API keys, gateway) happens manually over SSH after deploy.

## Stage behavior

| Stage | `removal` | `protect` |
|-------|-----------|-----------|
| `dev` | `"remove"` | false — `sst remove` wipes everything |
| `production` | `"retain"` | true — resources protected from stack deletion |

SST state is stored in AWS (SSM + S3) under `home: "aws"`.
