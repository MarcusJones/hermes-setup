# Obsidian + Hermes: Quickstart

End-to-end setup for a filesystem-native Obsidian vault shared between Hermes
(on EC2), a Windows desktop, and an Android phone. Backup layer is deferred —
that's a separate TODO.

## Architecture

```
┌──────────────────────────────┐
│  EC2 (Ubuntu, Hermes)        │
│  ~/vaults/                   │
│  ├── personal/               │
│  └── CES/                    │
│  markdown-vault-mcp × 2      │
└───────────────┬──────────────┘
                │ Syncthing (TCP/UDP 22000)
       ┌────────┴────────┐
       ↓                 ↓
┌──────────────┐  ┌──────────────┐
│  Windows     │  │  Android     │
│  Obsidian +  │  │  Obsidian +  │
│  Syncthing   │  │  Syncthing-  │
│  Tray (v2)   │  │  Fork        │
└──────────────┘  └──────────────┘
```

One vault per scope (personal, work), all plain markdown, kept identical across
devices by Syncthing. Hermes reads/writes the files via MCP.

---

## Component versions (April 2026)

| Component            | Version / Source                                                     |
| -------------------- | -------------------------------------------------------------------- |
| Syncthing core       | **v2.0.16+** — official apt repo on EC2, bundled on Windows/Android  |
| Windows tray app     | **Syncthing Tray (Martchus) v2.0.10** — `syncthingtray-2.0.10-x86_64-w64-mingw32.exe.zip` |
| Android app          | **Syncthing-Fork** (F-Droid) — official app discontinued Dec 2024    |
| Desktop Obsidian     | latest from obsidian.md                                              |
| Mobile Obsidian      | Play Store                                                           |
| MCP server           | `pvliesdonk/markdown-vault-mcp` via `uvx`                            |

> ⚠️ **Do not use SyncTrayzor.** It's unmaintained and incompatible with
> Syncthing v2 — it invokes the binary with removed flags (`-n`) and crashes
> on startup.

---

## 1. EC2 — vault + Syncthing + Hermes MCP

### Install Syncthing v2 (official apt repo, not Ubuntu's)

```bash
sudo mkdir -p /etc/apt/keyrings
sudo curl -o /etc/apt/keyrings/syncthing-archive-keyring.gpg \
    https://syncthing.net/release-key.gpg
echo "deb [signed-by=/etc/apt/keyrings/syncthing-archive-keyring.gpg] \
    https://apt.syncthing.net/ syncthing stable" | \
    sudo tee /etc/apt/sources.list.d/syncthing.list
sudo apt update
sudo apt install syncthing

syncthing --version   # expect v2.0.x
```

### Create the vault layout

```bash
mkdir -p ~/vaults/{personal,CES}/{inbox,daily,notes,attachments}
```

### Run Syncthing as a systemd user service

```bash
systemctl --user enable --now syncthing
systemctl --user status syncthing
```

`loginctl enable-linger hermes` (already done in your user-data script) keeps
it alive across SSH logout.

### Open firewalls — AWS security group + ufw

**AWS console** → EC2 → Instances → select `hermes-agent` → Security tab →
security group → Edit inbound rules → add two:

| Type       | Protocol | Port  | Source |
| ---------- | -------- | ----- | ------ |
| Custom TCP | TCP      | 22000 | My IP  |
| Custom UDP | UDP      | 22000 | My IP  |

(Web UI port **8384 stays closed** — reach it via SSH tunnel.)

**On EC2:**

```bash
sudo ufw allow 22000/tcp comment 'Syncthing TCP'
sudo ufw allow 22000/udp comment 'Syncthing QUIC'
sudo ufw status
```

### Configure Hermes MCP (two vaults = two servers)

Edit `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  vault_personal:
    command: "uvx"
    args: ["markdown-vault-mcp", "serve", "--transport", "stdio"]
    env:
      MARKDOWN_VAULT_MCP_SOURCE_DIR: "/home/hermes/vaults/personal"
      MARKDOWN_VAULT_MCP_INDEX_PATH: "/home/hermes/.cache/mdvault/personal.sqlite"
      MARKDOWN_VAULT_MCP_EXCLUDE: ".obsidian/**,.trash/**,.stversions/**"
    timeout: 120

  vault_ces:
    command: "uvx"
    args: ["markdown-vault-mcp", "serve", "--transport", "stdio"]
    env:
      MARKDOWN_VAULT_MCP_SOURCE_DIR: "/home/hermes/vaults/CES"
      MARKDOWN_VAULT_MCP_INDEX_PATH: "/home/hermes/.cache/mdvault/ces.sqlite"
      MARKDOWN_VAULT_MCP_EXCLUDE: ".obsidian/**,.trash/**,.stversions/**"
    timeout: 120
```

> Hermes's config.yaml needs **absolute paths** — `~` isn't expanded inside
> env values. `/home/hermes/vaults/...` is the canonical form.

Restart the gateway:

```bash
systemctl --user restart hermes-gateway
```

Verify from Telegram: *"what tools do you have?"* — look for
`vault_personal_*` and `vault_ces_*` tools.

### Drop an `AGENTS.md` in each vault root

`~/vaults/personal/AGENTS.md`:

```markdown
# Personal vault
Scope: journal, family, finances, side projects, learning.
Never write CES / company content here.

## Structure
- /inbox/       — Hermes writes new notes here; user promotes to /notes/
- /daily/       — YYYY-MM-DD.md
- /notes/       — curated notes (edit, don't overwrite)
- /attachments/ — images/PDFs

## Rules
- New captures → /inbox/ unless specified otherwise
- Wikilinks [[like this]] — quote in YAML: - "[[Note]]"
- Prefer edit tools over whole-file overwrites
- Never touch .obsidian/ or .stversions/
```

`~/vaults/CES/AGENTS.md` — same structure, scope reframed around company
projects, clients, strategy. Add: "Contains confidential information. Do not
cross-reference personal notes."

---

## 2. Transferring an existing vault to EC2

If you have notes on Windows already, seed EC2 before adding sync:

```powershell
# PowerShell on Windows — uses your SSH config alias
scp -r C:\Users\you\vaults\personal hermes:vaults/
scp -r C:\Users\you\vaults\CES      hermes:vaults/
```

Large vaults — use rsync via WSL:

```bash
wsl rsync -avz --progress /mnt/c/Users/you/vaults/personal/ hermes:vaults/personal/
```

Fix ownership after:

```bash
sudo chown -R hermes:hermes ~/vaults
```

Strip any existing `.obsidian/` — Obsidian recreates it on first open:

```bash
rm -rf ~/vaults/*/.obsidian
```

---

## 3. Windows — Syncthing Tray + Obsidian

### Install Syncthing Tray (Martchus v2.0.10)

Download from [github.com/Martchus/syncthingtray/releases](https://github.com/Martchus/syncthingtray/releases):

> **`syncthingtray-2.0.10-x86_64-w64-mingw32.exe.zip`**

Not the `qt5`, `aarch64`, `i686`, `linux`, `android`, or `syncthingctl` builds.

Unzip to `C:\Program Files\SyncthingTray\`, run `syncthingtray.exe`, enable
**Launch at login** in settings.

### Install Obsidian

From obsidian.md → "Open folder as vault" → point at `C:\Users\you\vaults\personal`.
Repeat for `CES`. Obsidian's vault switcher handles jumping between them.

---

## 4. Android — Syncthing-Fork + Obsidian

- **Syncthing-Fork** from F-Droid (not the Play Store original — it's
  discontinued).
- **Obsidian** from Play Store.

Open Obsidian → "Open folder as vault" → pick
`/storage/emulated/0/vaults/personal` (or wherever you place the sync folder).

---

## 5. Pair the devices

### Get device IDs

**EC2** (via SSH):
```bash
syncthing cli show system | grep -i myID
# or via web UI through a tunnel:
ssh -L 8384:localhost:8384 hermes
# browser: http://localhost:8384 → Actions → Show ID
```

**Windows**: Syncthing Tray → Actions → Show ID
**Android**: hamburger menu → Show device ID

### Pair from the terminal (EC2 side)

```bash
export STGUIAPIKEY=$(grep -oP '(?<=<apikey>)[^<]+' ~/.config/syncthing/config.xml)

# see pending device requests
syncthing cli show pending

# add Windows (and Android) devices
syncthing cli config devices add \
    --device-id <WINDOWS-DEVICE-ID> --name windows-desktop
syncthing cli config devices add \
    --device-id <ANDROID-DEVICE-ID> --name android-phone
```

### Share the folders

On EC2, create Syncthing folders for each vault and share with your devices.
The cleanest path is the web UI through the SSH tunnel — two folders, two
shares each. Use folder IDs `vault-personal` and `vault-ces` so they're
obvious in logs.

Mirror on Windows and Android: accept the incoming folder share, set the local
path (`C:\Users\you\vaults\personal`, `/storage/.../vaults/personal`).

### Verify

```bash
syncthing cli show connections
```

Each paired device should show `connected: true`. Writes on one device appear
on the others within seconds.

---

## 6. Per-folder settings that matter

On **every** Syncthing folder, on **every** device:

- **Ignore Permissions: ON** (Linux/Android mix causes phantom conflicts).
- **Watcher Delay: 30s** on EC2 (coalesces Hermes's bursty writes).
- **Staggered file versioning: ON** on EC2 (safety net against bad agent writes).

Create `.stignore` at each vault root:

```
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash
.stversions
.DS_Store
```

Without this, you'll get `workspace.json` conflict-file spam every time you
switch Obsidian windows.

---

## Troubleshooting cheat sheet

**"Disconnected" despite open ports** → bidirectional pairing not complete.
Each device must accept the other. Check `syncthing cli show pending` on EC2
and the "New Device" banner on Windows/Android.

**Test network path from WSL**:
```bash
nc -zv <EIP> 22000
```
`succeeded` = path open. `timed out` = AWS SG or ufw still blocking.

**`i/o timeout` in logs** → security group or ufw. The `172.31.x.x` addresses
in Syncthing logs are the instance's internal VPC IP — ignore, they're not
reachable from your house.

**Syncthing CLI says 401** → `$STGUIAPIKEY` not exported. Re-run the `grep`
command.

**SyncTrayzor crashes with `unknown flag -n`** → you're on Syncthing v2 with a
v1-era tray. Switch to Syncthing Tray (Martchus).

**Web UI from laptop** → always via SSH tunnel, never by opening 8384 publicly:
```bash
ssh -L 8384:localhost:8384 hermes
# then http://localhost:8384 in a local browser
```

---

## What's next (not covered here)

- **Backups** — dual git remotes + restic to B2 + R2. Deferred TODO.
- **Semantic search in `markdown-vault-mcp`** — requires swap or a separate
  embeddings host; enable later if FTS5 proves insufficient.
- **Hermes auto-refile cron** — nightly job that reorganizes `/inbox/`.
- **Git as a second sync channel** — adds version history for free; add
  alongside Syncthing when backup phase starts.