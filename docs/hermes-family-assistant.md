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

| Context    | Participants        | Bot      | Scope                              |
| ---------- | ------------------- | -------- | ---------------------------------- |
| Your DM    | you                 | your bot | full vault + all tools             |
| Her DM     | her                 | her bot  | `/vaults/shared/` only, notes-only |
| Group chat | you + her + her bot | her bot  | `/vaults/shared/` only             |

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
# snapshot the entire vault to a timestamped tarball before we touch anything
sudo tar czf /tmp/vault-pre-multiuser-$(date +%F).tgz /home/hermes/vaults
# push it to S3 as a manual out-of-band backup (separate from the nightly AWS Backup snapshots)
aws s3 cp /tmp/vault-pre-multiuser-*.tgz s3://<your-backup-bucket>/
# or trigger an on-demand AWS Backup recovery point via the console
```

Every step below that modifies `~/.hermes/`, `/home/hermes/vaults/`, `/etc/`, or
systemd state is flagged **⚠ persistent**.

### 4.2 Carve out the shared vault subtree — ⚠ persistent

```bash
sudo groupadd vault-shared                          # new OS group — membership = read/write on shared/
sudo usermod -aG vault-shared hermes               # add hermes to her own group so she can write shared files
sudo apt install -y acl                             # needed for setfacl commands below

sudo -u hermes mkdir -p /home/hermes/vaults/shared /home/hermes/vaults/private
# move any existing notes you want shared into shared/, everything else into private/

sudo chown -R hermes:vault-shared /home/hermes/vaults/shared      # group owns shared/ (not root)
sudo chmod -R 2770 /home/hermes/vaults/shared      # 2=setgid so new files inherit vault-shared group; 770=owner+group rwx, others nothing
sudo setfacl -R -d -m g:vault-shared:rwX /home/hermes/vaults/shared   # default ACL: files created here automatically get group rw
sudo setfacl -R    -m g:vault-shared:rwX /home/hermes/vaults/shared   # apply the same ACL to files that already exist

sudo chmod 0700 /home/hermes/vaults/private        # only the hermes user can enter private/
sudo chmod 0711 /home/hermes/vaults                # others can traverse (cd) into vaults/ but cannot list it
sudo chmod 0711 /home/hermes                       # Ubuntu sets home dirs to 750 by default — others need execute to traverse into it
```

### 4.3 Create her user — ⚠ persistent

Telegram-only access means no SSH, no password, no shell login:

```bash
sudo adduser --disabled-password --gecos "" alice   # create the account: no password = no SSH login, no GECOS = no name/phone prompts
sudo usermod -aG vault-shared alice                 # give her read/write on /vaults/shared/
sudo loginctl enable-linger alice                   # keep her systemd session alive after she logs out, so her bot stays running — ⚠ /var/lib/systemd/linger/alice
```

### 4.4 Install her Hermes

Open a shell as alice without needing her password:

```bash
sudo apt install -y systemd-container   # provides machinectl; not installed by default on Ubuntu
sudo machinectl shell alice@            # drops you into alice's shell with her environment and home dir
```

#### Install the Hermes binary

Same install script as your own user — puts the `hermes` binary in `~/.local/bin/`:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc    # reload PATH so hermes is immediately available
hermes --version    # confirm it installed
```

**Do not** run `npm install -g @anthropic-ai/claude-code` here. If `which claude`
returns nothing in alice's shell, the delegation system has no binary to invoke
even if the config ever re-enables it — that's the intent.

#### Install uv (required for the vault MCP server)

The vault MCP server (`markdown-vault-mcp`) runs via `uvx`, which ships with `uv`.
Install it for alice's user:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # installs uv + uvx to ~/.local/bin/
source ~/.bashrc                                    # add ~/.local/bin to PATH
uvx --version                                       # expect something like uv 0.x.y
```

#### Configure API keys and pick a model

```bash
hermes setup   # interactive prompt — enter her API key; use a separate key from yours for per-user billing
hermes model   # pick a cheap model: google/gemini-2.0-flash on OpenRouter is a good default (large context, low cost)
```

#### Write her config

The full config is at [`docs/alice-config.yaml`](alice-config.yaml) — annotated and based on the real Hermes config structure. Deploy it:

```bash
mkdir -p ~/.hermes ~/.cache/mdvault
cp /workspaces/hermes-setup/docs/alice-config.yaml ~/.hermes/config.yaml
```

Then create `~/.hermes/.env` with her three secrets (token and API keys are env vars, not in config.yaml):

```bash
cat > ~/.hermes/.env << 'EOF'
TELEGRAM_BOT_TOKEN=<token from @BotFather — do step 4.6 first>
TELEGRAM_ALLOWED_USERS=<her_tg_id>,<your_tg_id>
OPENROUTER_API_KEY=<her_openrouter_key>
EOF
chmod 600 ~/.hermes/.env   # readable by alice only
```

Verify Hermes picks it up:

```bash
hermes config show | grep -iE 'toolset|delegat|telegram|model'
```

When done, exit back to your own user:

```bash
exit   # leave alice's machinectl shell, return to hermes
```

### 4.5 Her systemd user service — ⚠ persistent

The Hermes install created a service file at `~/.config/systemd/user/hermes-gateway.service` under your (`hermes`) user. Alice needs the same file under her own user — systemd user services are per-user, so you can't share one.

Do this **as hermes** (not inside alice's shell):

```bash
# create the systemd user service directory for alice
sudo mkdir -p /home/alice/.config/systemd/user

# copy your service file into it
sudo cp ~/.config/systemd/user/hermes-gateway.service \
        /home/alice/.config/systemd/user/hermes-gateway.service

# IMPORTANT: the service file contains hardcoded paths to /home/hermes/.hermes/
# Replace them with alice's own install path — otherwise the service fails with status=203/EXEC
sudo sed -i 's|/home/hermes/.hermes|/home/alice/.hermes|g' \
        /home/alice/.config/systemd/user/hermes-gateway.service

# confirm the ExecStart line now points at alice's install
sudo grep ExecStart /home/alice/.config/systemd/user/hermes-gateway.service

# fix ownership — alice's systemd won't load files it doesn't own
sudo chown -R alice:alice /home/alice/.config
```

Quick sanity check before continuing — confirm the file landed and looks right:

```bash
sudo cat /home/alice/.config/systemd/user/hermes-gateway.service
```

Now enter alice's shell and start the service:

```bash
sudo machinectl shell alice@               # open a shell as alice
systemctl --user daemon-reload             # tell systemd to scan for the new service file
systemctl --user enable --now hermes-gateway   # start it now and auto-start on every boot
journalctl --user -u hermes-gateway -f     # tail logs — wait for a "listening" or "connected" line, then Ctrl+C
```

Confirm it's running:

```bash
systemctl --user status hermes-gateway    # should show: active (running)
exit                                       # back to hermes
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
hermes config set telegram.allowed_users "<YOUR_TG_ID>"   # whitelist only your Telegram numeric ID — her ID is not in this list
systemctl --user restart hermes-gateway                    # reload config; bot won't respect the change until restarted
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

Work through these in order. Fix any failure before moving to the next block — Telegram tests are last because they depend on everything below being correct.

#### Users and groups

```bash
# run as hermes
id alice | grep vault-shared          # must show vault-shared in the groups list  ✓
getent group vault-shared             # shows: vault-shared:x:NNNN:hermes,alice    ✓
```

#### Filesystem permissions

```bash
# confirm hermes home is traversable by others (750 breaks everything)
stat -c "%a %U %G %n" /home/hermes   # must show 711 hermes hermes               ✓

# confirm alice cannot list the vault root (0711 = traverse only for others)
sudo -u alice ls /home/hermes/vaults             # must fail: Permission denied    ✓

# confirm alice cannot enter private/
sudo -u alice ls /home/hermes/vaults/private     # must fail: Permission denied    ✓

# confirm alice can enter and write shared/
sudo -u alice ls /home/hermes/vaults/shared      # must succeed: lists files       ✓
sudo -u alice touch /home/hermes/vaults/shared/_test.md
ls -l /home/hermes/vaults/shared/_test.md        # group column must say vault-shared (setgid working) ✓
rm /home/hermes/vaults/shared/_test.md
```

#### Alice's Hermes service

```bash
# confirm the service is running
sudo -u alice XDG_RUNTIME_DIR=/run/user/$(id -u alice) systemctl --user status hermes-gateway
# must show: active (running)                                                      ✓

# confirm the process is running as alice (not root, not hermes)
ps aux | grep hermes-gateway | grep -v grep      # user column must say alice      ✓

# tail logs for startup errors
sudo machinectl shell alice@
journalctl --user -u hermes-gateway --since "5 minutes ago" | grep -iE 'error|warn|fail|vault|telegram'
exit
```

#### Config and secrets

```bash
sudo machinectl shell alice@

# confirm secrets are loaded
hermes config show | grep -i telegram            # token line must be non-empty    ✓

# confirm MCP vault server is wired up
hermes config show | grep -i mcp                 # should show vault entry         ✓

# confirm delegation is off
hermes config show | grep -i delegation          # enabled: false                  ✓

# confirm toolset is telegram-only
hermes config show | grep -i toolset             # hermes-telegram, not hermes-cli ✓

exit
```

#### Telegram (only once all above pass)

- DM your bot → responds
- DM her bot → responds
- Her bot: ask *"what files are in the vault?"* → lists shared/ contents, no errors
- Her bot: ask *"read /home/hermes/vaults/private"* → refuses or says it has no access
- Group chat, @-mention her bot → responds

---

## 5. Operating the assistant

### 5.1 Where memory lives

Hermes has three memory layers. Understand which is which:

| Layer                | Path                    | What it holds                                   | Lifetime                      |
| -------------------- | ----------------------- | ----------------------------------------------- | ----------------------------- |
| Conversation history | `~/.hermes/sessions/`   | Per-chat transcripts, short-term working memory | Per-session, until compaction |
| Skills               | `~/.hermes/skills/*.md` | Procedural memory — "how to do X"               | Permanent until you delete    |
| Vault                | `/home/hermes/vaults/`  | Durable facts, notes, decisions                 | Permanent, git-versioned      |

**Rule of thumb**: if a fact matters beyond one conversation, it goes in the
vault. Skills are for _patterns_ ("how to add a grocery item"), vault is for
_content_ ("we're going to Kyoto April 12"). Don't let important facts live only
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

| Symptom                              | Check                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Bot silent in group                  | `journalctl --user -u hermes-gateway -f` (as alice), look for Telegram auth errors         |
| "Permission denied" on vault writes  | `id alice` — is she in `vault-shared`? Did she re-login after usermod?                     |
| MCP can't access vault (bot reports permission error after group was added) | Gateway process inherited stale groups at launch — `sudo machinectl shell alice@` then `systemctl --user restart hermes-gateway` |
| Bot using terminal tool when it shouldn't | `toolsets` config didn't fully lock it — `sudo machinectl shell alice@` then `hermes tools disable terminal && hermes tools disable shell && systemctl --user restart hermes-gateway` |
| Bot suggests wrong restart command (`sudo systemctl restart hermes`) | Add `~/.hermes/skills/self-awareness.md` telling it its actual service name and that it has no sudo |
| Hermes OOM'd during CC fanout        | `dmesg \| grep -i killed`, reduce concurrent CC subagents, check swap usage                |
| Instance stopped (spot interruption) | AWS console → start → re-associate Elastic IP → both systemd services come back via linger |
| Vault file conflicts (Syncthing)     | `.sync-conflict-*` files in the vault — resolve manually, Hermes doesn't touch them        |

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

| Change             | Path                            | How to roll back                |
| ------------------ | ------------------------------- | ------------------------------- |
| New user `alice`   | `/etc/passwd`, `/home/alice/`   | `userdel -r alice`              |
| Group memberships  | `/etc/group`                    | `gpasswd -d <user> <group>`     |
| Vault perms + ACLs | `/home/hermes/vaults/*`         | Restore from pre-change tarball |
| Linger for alice   | `/var/lib/systemd/linger/alice` | `loginctl disable-linger alice` |
| Her systemd unit   | `~alice/.config/systemd/user/`  | Disable + remove                |
| Her `~/.hermes/`   | `/home/alice/.hermes/`          | Delete the directory            |
| Syncthing folders  | hermes's Syncthing config       | Remove folder in Syncthing UI   |

The EBS volume has `DeleteOnTermination=false` and AWS Backup takes nightly
snapshots with 7-day retention — so any of the above is recoverable within 24h
even if you fat-finger `rm -rf`. The vault's own git history gives you
file-level undo on top of that.

---

## 8. Cost envelope

Steady-state for the two-user setup, monthly:

| Line item                                        | Cost            |
| ------------------------------------------------ | --------------- |
| EC2 `t4g.medium` spot                            | ~$8             |
| EBS 40 GB gp3                                    | ~$3             |
| Elastic IP (attached)                            | $0              |
| AWS Backup 7-day                                 | ~$2             |
| Your API (orchestrator Gemini Flash + CC bursts) | $10–40 variable |
| Her API (Gemini Flash, light usage)              | $1–3            |
| Her Telegram bot                                 | $0              |
| **Total baseline**                               | **~$25–60**     |

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
   happen in _group chats_ and _vault subtrees_, not by having multiple
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

_This doc lives in the vault. Update it in place as the setup evolves — that's
the whole point of file-based memory._
