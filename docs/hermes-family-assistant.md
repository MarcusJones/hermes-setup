# Hermes Family Assistant — Ops Manual

A single-EC2 deployment of Hermes Agent serving multiple family members over
Telegram, with per-user tool scopes and a shared Obsidian vault as long-term
memory. Starts as **you + your girlfriend + a shared group chat**; designed to
scale into a full household assistant without re-architecting.

---

## 1. What this is

One EC2 `t4g.medium` instance runs:

- **Your Hermes** — full tool scope (Claude Code, terminal, delegation, full vault).
- **Her Hermes** — notes-only scope (vault subtree, no shell, no CC).
- **Shared Obsidian vault** — the long-term memory layer. Plain markdown files,
  syncthing'd to phones and laptops, git-versioned.
- **Two Telegram bots** — one per Hermes instance. A shared group chat hosts
  her bot so both humans can talk to it with the same shared memory.

Everything is **procedural memory in markdown + per-user Linux isolation + per-bot
Telegram allow-lists**. No SaaS, no new servers, no Docker. Nightly EBS snapshots
are the safety net.

---

## 2. Use cases

### Day 1 — you + partner

| Context | Participants | Bot | Scope |
|---|---|---|---|
| Your DM | you | your bot | full vault + all tools |
| Her DM | her | her bot | `/vaults/shared/` only, notes-only |
| Group chat | you + her + her bot | her bot | `/vaults/shared/` only |

Concrete things this unlocks immediately:

- **Shared trip planning.** Group chat: "add to `/shared/trips/kyoto.md`: flights
  land April 12, 14:30 KIX". Either of you can query it later from anywhere.
- **Shared todo queue.** One file, two writers, one agent. "add renewing passports
  by March to our shared todos".
- **Joint research notes.** Restaurant shortlists, gift ideas, house-hunting
  criteria — whatever's genuinely two-person.
- **Async status nudges.** Her bot posts into the group: "Alice added 3 items to
  the Kyoto packing list today." Cheap shared awareness.
- **Your private agentic work.** Your DM keeps CC, terminal, repo orchestration.
  She never sees it, can't trigger it, can't access it.

### Year 1 — full family scope

The same pattern extends to anyone you want to add:

- **Kids** — own bot, heavily locked: tutoring skill only, no vault, time-boxed
  usage, age-appropriate model. Parent can audit transcripts.
- **Parents / in-laws** — own bot, simple assistant scope: reminders,
  medications, appointment log, emergency contacts. Large-text replies.
- **Whole-family group chat** — shared calendar, meal planning, grocery list,
  birthday reminders, travel logistics. Driven by a "family" bot with
  read/write on `/vaults/family/`.
- **Per-topic group chats** — "Trip to Greece" group with just the travellers;
  that bot only sees `/vaults/trips/greece/`.

The model is: **one Linux user per human, one Hermes instance per human, one
Telegram bot per instance, vault subtrees for shared scopes, group chats wire
multiple humans to one instance.**

---

## 3. Architecture

```
┌───────────────────────────── EC2 t4g.medium (Ubuntu 24.04 ARM) ─────────────────────────────┐
│                                                                                              │
│  user: hermes                              user: alice                    user: kid (later)  │
│  ~/.hermes/       (sacred)                 ~/.hermes/                     ~/.hermes/         │
│  systemd user svc: hermes-gateway          systemd user svc: hermes-…     (locked model)     │
│  tools: CC, terminal, delegation           tools: vault only              tools: tutor only  │
│  vault: /home/hermes/vaults/ (full)         vault: /shared (via perms)     vault: none        │
│                                                                                              │
│  /home/hermes/vaults/                                                                         │
│    ├── private/       0700 hermes:hermes         ← yours only                               │
│    ├── shared/        2770 hermes:vault-shared   ← you + alice read/write                   │
│    └── family/        2770 hermes:family         ← added later when kids/parents join       │
│                                                                                              │
│  Syncthing (under hermes)                                                                   │
│    └── folder "vault"  ↔ your devices  (full)                                               │
│    └── folder "shared" ↔ her devices  (subset)                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
            │                      │                              │
            ↓                      ↓                              ↓
      @your_bot DM          @her_bot DM          Group: you + alice + @her_bot
         (you)                 (alice)                  (shared scope)
```

**Why this shape:**

- POSIX groups enforce scope at the OS layer — a prompt injection that convinces
  her Hermes to `rm -rf /home/hermes/` gets stopped by the kernel, not by a
  policy the LLM can be talked out of.
- Markdown in a git-versioned vault is portable, human-auditable, and survives
  Hermes going away. The memory is yours, not locked in an agent.
- One bot per instance keeps the Telegram surface honest — a user messaging a
  bot can only reach that bot's scope.

---

## 4. Setup guide

Assumes your Hermes is already running under the `hermes` user as per the
project baseline (systemd user service, lingering enabled, Elastic IP, nightly
AWS Backup snapshots, 4 GB swap).

### 4.1 Pre-flight — back up before touching persistent state

```bash
sudo tar czf /tmp/vault-pre-multiuser-$(date +%F).tgz /home/hermes/vaults
aws s3 cp /tmp/vault-pre-multiuser-*.tgz s3://<your-backup-bucket>/
# or trigger an on-demand AWS Backup recovery point via the console
```

Every step below that modifies `~/.hermes/`, `/home/hermes/vaults/`, `/etc/`, or
systemd state is flagged **⚠ persistent**.

### 4.2 Carve out the shared vault subtree — ⚠ persistent

```bash
sudo groupadd vault-shared
sudo usermod -aG vault-shared hermes
sudo apt install -y acl

sudo -u hermes mkdir -p /home/hermes/vaults/shared /home/hermes/vaults/private
# move any existing notes you want shared into shared/, everything else into private/

sudo chown -R hermes:vault-shared /home/hermes/vaults/shared
sudo chmod -R 2770 /home/hermes/vaults/shared              # 2 = setgid
sudo setfacl -R -d -m g:vault-shared:rwX /home/hermes/vaults/shared
sudo setfacl -R    -m g:vault-shared:rwX /home/hermes/vaults/shared

sudo chmod 0700 /home/hermes/vaults/private
sudo chmod 0711 /home/hermes/vaults                        # others: traverse only
```

### 4.3 Create her user — ⚠ persistent

Telegram-only access means no SSH, no password, no shell login:

```bash
sudo adduser --disabled-password --gecos "" alice
sudo usermod -aG vault-shared alice
sudo loginctl enable-linger alice                         # ⚠ /var/lib/systemd/linger/alice
```

### 4.4 Install her Hermes

Become her without needing a password:

```bash
sudo machinectl shell alice@
```

Inside her shell, install Hermes the same way you installed yours. Then:

```bash
hermes setup       # her API keys — use her own OpenRouter/Anthropic keys for cost attribution
hermes model       # pick a cheap 64k+ model (Gemini Flash 2.0 on OpenRouter is ideal)
```

Write `/home/alice/.hermes/config.yaml`:

```yaml
mcp_servers:
  vault:
    command: "uvx"
    args: ["markdown-vault-mcp", "serve", "--transport", "stdio"]
    env:
      MARKDOWN_VAULT_MCP_SOURCE_DIR: "/home/hermes/vaults/shared"
      MARKDOWN_VAULT_MCP_INDEX_PATH: "/home/alice/.cache/mdvault/index.sqlite"
      MARKDOWN_VAULT_MCP_EXCLUDE: ".obsidian/**,.trash/**,.stversions/**"
    timeout: 120

delegation:
  enabled: false

tools:
  terminal: { enabled: false }
  shell:    { enabled: false }

telegram:
  token: <HER_BOT_TOKEN>
  allowed_users: "<HER_TG_ID>,<YOUR_TG_ID>"
  allowed_chats: "<HER_DM_CHAT_ID>,<SHARED_GROUP_CHAT_ID>"
```

Run `hermes config show | grep -iE 'tool|delegat|chat'` to verify the exact
key names match your Hermes version.

**Do not** run `claude mcp add -s user hermes …` as alice. Extra belt-and-braces:
don't install `@anthropic-ai/claude-code` under her user — if `which claude` is
empty in her shell, `delegate_task` has no worker binary to invoke even if it
ever re-enables itself.

### 4.5 Her systemd user service — ⚠ persistent

Copy your `~/.config/systemd/user/hermes-gateway.service` into
`~alice/.config/systemd/user/hermes-gateway.service`, then:

```bash
sudo machinectl shell alice@
systemctl --user daemon-reload
systemctl --user enable --now hermes-gateway
journalctl --user -u hermes-gateway -f      # sanity-check it starts cleanly
```

### 4.6 Create her Telegram bot

- In Telegram, DM `@BotFather` → `/newbot` → name it (e.g. `Alice Hermes`) → get token.
- `/setprivacy` → **Disable** (so it can see all group messages, not just
  @-mentions).
- `/setjoingroups` → Enable.
- Add the bot to a new group chat that contains you, her, and the bot.
- Get her user ID and the group chat ID from
  `https://api.telegram.org/bot<HER_TOKEN>/getUpdates` after sending a message.

Plug those into the config in 4.4 and restart her gateway.

### 4.7 Lock your own bot so she can't reach it

```bash
# as hermes (you)
hermes config set telegram.allowed_users "<YOUR_TG_ID>"
systemctl --user restart hermes-gateway
```

### 4.8 Add a skill for group-chat etiquette

Create `/home/alice/.hermes/skills/group-chat.md`:

```markdown
# Skill: group-chat behaviour

This bot operates in a shared Telegram group with multiple humans. Rules:

- If a message is directly addressed to me (name mention, @-mention, or
  replying to one of my messages), respond.
- If a message is human-to-human chatter, stay silent. Don't interject.
- When writing to the vault, record who asked in frontmatter: `requested_by:`.
- When uncertain which human to direct an answer at, name them: "Alice, your
  flight lands at 14:30; Stefan, the hotel confirmation is in `/shared/trips/`."
- Never expose paths outside /home/hermes/vaults/shared/. If asked about
  other files or directories, say you don't have access.
```

Hermes auto-loads skills from `~/.hermes/skills/*.md`. This one shapes the
bot's behaviour in the group without code changes.

### 4.9 Verify

```bash
# from your user
sudo -u alice ls /home/hermes/vaults/private     # Permission denied  ✓
sudo -u alice ls /home/hermes/vaults/shared      # lists shared files ✓
sudo -u alice touch /home/hermes/vaults/shared/_test.md
ls -l /home/hermes/vaults/shared/_test.md        # group: vault-shared ✓
rm /home/hermes/vaults/shared/_test.md

# from Telegram
# - DM your bot → responds
# - DM her bot → responds
# - Group chat, @-mention her bot → responds
# - Her bot, ask "read /home/hermes/vaults/private/..." → refuses / can't see it
```

---

## 5. Operating the assistant

### 5.1 Where memory lives

Hermes has three memory layers. Understand which is which:

| Layer | Path | What it holds | Lifetime |
|---|---|---|---|
| Conversation history | `~/.hermes/sessions/` | Per-chat transcripts, short-term working memory | Per-session, until compaction |
| Skills | `~/.hermes/skills/*.md` | Procedural memory — "how to do X" | Permanent until you delete |
| Vault | `/home/hermes/vaults/` | Durable facts, notes, decisions | Permanent, git-versioned |

**Rule of thumb**: if a fact matters beyond one conversation, it goes in the
vault. Skills are for *patterns* ("how to add a grocery item"), vault is for
*content* ("we're going to Kyoto April 12"). Don't let important facts live only
in session history — sessions get compacted and details drop.

Her instance has its own `~/.hermes/` entirely separate from yours — no shared
conversation history. The vault is the only cross-agent memory layer.

### 5.2 Daily hygiene

From Telegram, once a week:

> "summarise this week's activity in /shared/ and write a weekly digest to
> `/shared/digests/YYYY-WW.md`"

From your shell, monthly:

```bash
cd /home/hermes/vaults && git gc --aggressive
du -sh ~/.hermes/sessions/                      # watch session-log growth
```

AWS Backup handles the EBS snapshot; you don't need to touch it unless you
change retention.

### 5.3 When things go wrong

| Symptom | Check |
|---|---|
| Bot silent in group | `journalctl --user -u hermes-gateway -f` (as alice), look for Telegram auth errors |
| "Permission denied" on vault writes | `id alice` — is she in `vault-shared`? Did she re-login after usermod? |
| Hermes OOM'd during CC fanout | `dmesg \| grep -i killed`, reduce concurrent CC subagents, check swap usage |
| Instance stopped (spot interruption) | AWS console → start → re-associate Elastic IP → both systemd services come back via linger |
| Vault file conflicts (Syncthing) | `.sync-conflict-*` files in the vault — resolve manually, Hermes doesn't touch them |

---

## 6. Expanding the assistant

Opinionated order of operations for growing this into a real family assistant.
Do them roughly in order; each one stands on its own.

### 6.1 First 5 skills to add (high ROI)

1. **`vault-conventions.md`** — where different note types live (`/inbox/`,
   `/daily/`, `/people/`, `/trips/`). Teaches Hermes to file things
   consistently instead of dumping everything in one folder.
2. **`daily-note.md`** — append to `/vaults/daily/YYYY-MM-DD.md` under
   timestamped headings. Turns Telegram into a journal input with zero
   ceremony.
3. **`git-vault-commit.md`** — after any vault write, run
   `cd /home/hermes/vaults && git add -A && git commit -m "..." && git push`.
   Every change is versioned, Hermes learns the pattern and stops asking.
4. **`ocr-capture.md`** — when a user sends a photo, run `tesseract` on it,
   extract text, file under `/vaults/shared/scans/YYYY-MM-DD-<slug>.md` with
   the original image attached. Best ROI skill for non-technical family
   members — they just snap and forget.
5. **`recurring-reminders.md`** — teach Hermes to drop reminders into
   `/vaults/reminders/` with frontmatter `due: YYYY-MM-DD`, and define a cron
   under the relevant user that queries this daily and pings via Telegram.

### 6.2 MCP servers to wire in next

- **Google Calendar MCP** — single shared family calendar, both bots read/write.
  Run the MCP under `hermes`, expose to both instances. Instant "what's on
  tomorrow" answers.
- **Gmail or IMAP MCP** — email triage. Dangerous tool; only under your user,
  not hers.
- **Home Assistant MCP** (if you have one) — "turn off the downstairs lights"
  from Telegram.
- **Fetch/HTTP MCP** — recipe import, article summarisation. Safe for both users.

Each MCP is added under the specific user's `config.yaml` `mcp_servers` block.
Do not globally enable powerful ones under her user.

### 6.3 Adding another family member

The pattern is mechanical. For each new human:

1. `adduser`, `loginctl enable-linger`, add to the appropriate group
   (`vault-shared`, or new group `family` for kid-safe content, etc.).
2. Install Hermes under their user.
3. Decide the scope: which vault subtree, which tools, which model tier.
4. Create a Telegram bot for them, lock `allowed_users` / `allowed_chats`.
5. Copy the systemd unit, `enable --now`.
6. For kids: add rate limits at the Hermes config layer (messages/day),
   use a cheaper model, skill file that refuses adult topics, transcript
   archival to a folder you can audit.

Budget RAM: each idle Hermes ~200-400 MB. Four idle Hermes instances on
`t4g.medium` is fine; if you plan more than that plus CC fanout, move to
`t4g.large` (~$14/mo spot).

### 6.4 New shared scopes

Same pattern as `vault-shared`, new group per scope:

```bash
sudo groupadd trips-greece
sudo usermod -aG trips-greece hermes alice stefan uncle-bob
sudo mkdir -p /home/hermes/vaults/trips/greece
sudo chown -R hermes:trips-greece /home/hermes/vaults/trips/greece
sudo chmod -R 2770 /home/hermes/vaults/trips/greece
sudo setfacl -R -d -m g:trips-greece:rwX /home/hermes/vaults/trips/greece
```

Then create a group chat, add the appropriate people's bots, point those bots
at the scope via a per-chat config override (Hermes supports per-chat skill
profiles — put a `greece-trip.md` skill that restricts the MCP to
`/trips/greece/` for that chat ID).

---

## 7. Persistent-state reference

Everything that persists across reboots / spot interruptions, in one place.
Check this list any time something feels broken after a restart.

| Change | Path | How to roll back |
|---|---|---|
| New user `alice` | `/etc/passwd`, `/home/alice/` | `userdel -r alice` |
| Group memberships | `/etc/group` | `gpasswd -d <user> <group>` |
| Vault perms + ACLs | `/home/hermes/vaults/*` | Restore from pre-change tarball |
| Linger for alice | `/var/lib/systemd/linger/alice` | `loginctl disable-linger alice` |
| Her systemd unit | `~alice/.config/systemd/user/` | Disable + remove |
| Her `~/.hermes/` | `/home/alice/.hermes/` | Delete the directory |
| Syncthing folders | hermes's Syncthing config | Remove folder in Syncthing UI |

The EBS volume has `DeleteOnTermination=false` and AWS Backup takes nightly
snapshots with 7-day retention — so any of the above is recoverable within 24h
even if you fat-finger `rm -rf`. The vault's own git history gives you
file-level undo on top of that.

---

## 8. Cost envelope

Steady-state for the two-user setup, monthly:

| Line item | Cost |
|---|---|
| EC2 `t4g.medium` spot | ~$8 |
| EBS 40 GB gp3 | ~$3 |
| Elastic IP (attached) | $0 |
| AWS Backup 7-day | ~$2 |
| Your API (orchestrator Gemini Flash + CC bursts) | $10–40 variable |
| Her API (Gemini Flash, light usage) | $1–3 |
| Her Telegram bot | $0 |
| **Total baseline** | **~$25–60** |

When scaling to more family members, the EC2/EBS numbers don't move until you
cross ~4 concurrent active agents and upgrade to `t4g.large` (+$6/mo). API cost
per additional family member is typically <$3/mo for casual use on Flash-tier
models.

---

## 9. Design principles to preserve

When in doubt, these are the load-bearing invariants. Breaking any of them
means redesigning, not patching.

1. **Vault is markdown + git**, never a proprietary store. The memory survives
   Hermes going away.
2. **One human → one Linux user → one Hermes → one bot.** Shared scopes
   happen in *group chats* and *vault subtrees*, not by having multiple
   humans share a single Hermes instance.
3. **Scope is enforced at the OS + Telegram layer**, not by asking the LLM
   to behave. POSIX groups and `allowed_users` are the firewall; skills are
   etiquette, not security.
4. **`~/.hermes/` is sacred** per user. AWS Backup + `DeleteOnTermination=false`
   protect it. Never rm-rf it without a snapshot in hand.
5. **Cheap model for orchestration, expensive only for hard reasoning or CC.**
   Compounding API cost is the failure mode that ends projects like this.
6. **Plain systemd user services, single host.** No Docker for the main
   deployment, no Kubernetes, no HA. Snapshots are the DR plan.

---

*This doc lives in the vault. Update it in place as the setup evolves — that's
the whole point of file-based memory.*
