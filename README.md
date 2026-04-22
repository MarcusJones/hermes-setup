# hermes-infra

SST app that provisions a persistent **Hermes Agent** host on AWS EC2 plus a small
Next.js dashboard for monitoring it.

What you get after `sst deploy`:

- `t4g.medium` spot instance, Ubuntu 24.04 ARM64, bootstrapped with Hermes + Claude Code
- 40 GB gp3 root volume with **`DeleteOnTermination = false`** (so `~/.hermes/` survives
  spot interruptions — this is the whole point of the repo)
- Elastic IP associated with the instance
- Nightly EBS snapshots via DLM, 7-day retention
- Next.js dashboard (on Lambda + CloudFront) showing instance state + a button to
  re-associate the EIP after an interruption

---

## Prereqs

1. AWS account with credentials set up (`~/.aws/credentials` or env vars).
2. Node 20+ and pnpm or npm.
3. An **existing EC2 key pair** in your target region — create it via
   `EC2 → Key Pairs → Create key pair`, download the `.pem`, and `chmod 600` it.
4. Your current IP: `curl ifconfig.me`.

## Configure

```bash
cp .env.example .env
# edit .env: set AWS_REGION, KEY_NAME, MY_IP
```

## Install & deploy

```bash
npm install
npm run deploy            # dev stage
# or
npm run deploy:prod       # production stage (state retained on destroy)
```

First deploy takes ~5 minutes (spot fulfillment + cloud-init). Outputs include the
SSH command and dashboard URL.

## First-time Hermes setup

SSH in and finish the interactive bits (the user-data script installs Hermes but
doesn't configure API keys or messaging, since those are interactive):

```bash
ssh -i ~/.ssh/<KEY_NAME>.pem hermes@<publicIp>
hermes setup             # pick provider, paste API key
hermes model             # confirm a 64K+ context model
hermes gateway setup     # wire up Telegram/Discord/Slack
hermes gateway install   # register systemd user service
hermes gateway start
```

Done. Hermes now runs 24/7 and survives crashes, reboots, and spot pauses.

---

## Repo layout

```
hermes-infra/
├── sst.config.ts              # SST entry point
├── infra/
│   ├── network.ts             # Security group (SSH from MY_IP only)
│   ├── instance.ts            # Spot EC2 + EBS + EIP
│   ├── backup.ts              # DLM nightly snapshot policy
│   └── web.ts                 # Next.js dashboard wiring
├── scripts/
│   └── user-data.sh           # Cloud-init: installs Hermes + Claude Code
├── web/                       # Next.js 15 dashboard app
│   ├── app/page.tsx
│   ├── app/layout.tsx
│   ├── next.config.mjs
│   └── package.json
├── .env.example
├── package.json               # SST at root, Next.js via workspace
└── README.md
```

## What the dashboard does

Minimal by design. One page that:

- Shows current instance state (`running` / `stopped` / `pending` / ...)
- Shows the EIP and whether it's associated with the instance
- Exposes one server action: **re-associate the Elastic IP**

The re-associate button matters because after a spot interruption with `stop`
behavior, AWS restarts the same instance when capacity returns — but the EIP detaches.
Click the button and you're back.

Extend it from there: add buttons for `hermes update` via SSM, a log tail, a skill
browser that queries Hermes's SQLite over an SSH tunnel, etc.

## Cost breakdown (us-east-1, approximate)

| Thing                                          | Monthly |
| ---------------------------------------------- | ------- |
| `t4g.medium` spot (~$0.01/hr)                  | ~$7     |
| 40 GB gp3 EBS                                  | ~$3.20  |
| Elastic IP (while attached to running)         | $0      |
| Snapshot storage (incremental, 7-day)          | <$2     |
| Next.js on Lambda + CloudFront (idle dashboard)| <$1     |
| **Total**                                      | **~$12–14** |

If spot gets interrupted and the instance is in `stopped` state, you pay EBS only
(~$5/mo) until capacity returns.

## What this repo is NOT

- Not HA. It's a single instance. If your use case needs multi-AZ failover, use
  an ASG and either rebuild state-from-snapshot on each restart or use EFS.
- Not a multi-tenant deployment. One Hermes per stack.
- Not a complete security posture. It assumes the operator (you) is the only
  SSH user and that MY_IP reasonably restricts access.

## Tearing down

```bash
npm run destroy
```

On the `dev` stage this removes everything. On `production` the stack is marked
with `removal: "retain"` and `protect: ["production"]` — you'll need to manually
edit `sst.config.ts` or delete resources out-of-band. This is intentional: it
prevents `sst remove --stage production` from nuking your Hermes memory.
