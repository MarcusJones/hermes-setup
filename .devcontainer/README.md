# Devcontainer — how the `agentic-central` integration works

## What `agentic-central` is

Use this configuration as a template for each new project. Projects will necessarily
have difference configuration requirements, languages, extensions, tools.

This devcontainer layers a separate host repo (`agentic-central`) on top of the
project so that Claude Code settings, shared commands, shell env vars, and
credentials are reused across every project on this machine without being
copied into each repo.


A standalone git repo on the host (typically `/home/<user>/git/agentic-central`)
containing **shared config** that isn't project-specific:

- `settings.json`, `claude.json`, `claude.home.settings.json` — Claude Code config
- `commands/` — custom slash commands
- `CLAUDE.md` — global guidance for Claude
- `.env` — shared auth tokens (AWS creds, API keys, etc.)

It lives outside any one project so it can be:

- **Shared across many projects** — every devcontainer on this machine mounts
  the same repo and picks up the same Claude config + env.
- **Shared across devs** — commits to `agentic-central` propagate improvements
  (new slash commands, updated settings, team conventions) to everyone who
  pulls it.
- **Versioned independently** — its git history is separate from any project's.

## Per-machine configuration

The host path to `agentic-central` differs per machine (and Windows username
differs per dev), so both are set in **`.devcontainer/.env`** (gitignored):

```bash
WINDOWS_USER=m.jones
AGENTIC_CENTRAL_PATH=/home/ubuntu/git/agentic-central
```

Additionally, if a developer is working on many projects, they may wish to centrally store credentials for other
APIs in agentic-central.

Copy `.env.example` → `.env` on first clone. `docker-compose.yml` fails loudly
via `${VAR:?...}` if either is missing.

> **Why `.devcontainer/.env` and not VS Code?** Docker Compose interpolates
> `${VAR}` only from the shell env where it's invoked or from a `.env` file
> next to the compose file. VS Code's `${localWorkspaceFolder}` etc. are
> **not** forwarded into compose — they only work inside `devcontainer.json`.

## The three-stage integration flow

```
┌─────────────────────────────────────┐
│ HOST (WSL / Linux filesystem)       │
│                                     │
│  /home/ubuntu/git/agentic-central/  │  ← its own git repo
│       ├── settings.json             │
│       ├── claude.json               │
│       ├── commands/                 │
│       └── .env                      │
│                                     │
│  /home/ubuntu/git/climatevis-       │
│           dashboard/                │  ← this project
└─────────────────┬───────────────────┘
                  │ (1) bind mount + (2) env_file
                  ▼
┌─────────────────────────────────────┐
│ CONTAINER                           │
│                                     │
│  /agentic-central/ ────────────────────┐  (1) live bind mount
│  /workspaces/climatevis-dashboard/  │  │
│       └── .claude ─────────────────────┘  (3) symlink at post-start
│                                     │
│  ~/.claude.json                     │  (4) copy at post-start
│  ~/.claude/settings.json            │  (4) copy at post-start
│  ~/.bashrc  (sources .env)          │  (5) env sourcing
└─────────────────────────────────────┘
```

### Stage 1 — mount (at container start, `docker-compose.yml`)

```yaml
volumes:
  - ${AGENTIC_CENTRAL_PATH}:/agentic-central:cached
env_file:
  - ${AGENTIC_CENTRAL_PATH}/.env
```

- Bind-mounts the entire `agentic-central` repo at `/agentic-central` inside
  the container. `cached` is a macOS/Windows hint; on Linux it's a no-op.
- Loads `agentic-central/.env` into the **container's process env** (visible
  to `docker exec` sessions and the uvicorn/pnpm processes compose starts).

### Stage 2 — symlink (at first start, `post-start.sh`)

```bash
sudo ln -sfn /agentic-central /workspaces/climatevis-dashboard/.claude
```

Makes the project's `.claude/` folder resolve to the shared repo, so Claude
Code reads **project-level** settings (slash commands, project CLAUDE.md, etc.)
from the shared source.

**Host-side side effect:** because `/workspaces/<project-name>/` is
itself a bind mount of the host's project folder, this symlink is written
back to the host filesystem. On the host it appears as a **dangling** symlink
(`/agentic-central` doesn't exist there). It's already in `.gitignore` so it
won't be committed.

### Stage 3 — copy (at first start, `post-start.sh`)

```bash
cp /agentic-central/claude.json           ~/.claude.json
cp /agentic-central/claude.home.settings.json  ~/.claude/settings.json
```

These files are **user-level** Claude Code config and must live in `~/` —
Claude Code doesn't follow symlinks for them. Copies are snapshots taken when
the container starts.

### Shell env persistence (`post-start.sh`)

```bash
echo 'set -a; source /agentic-central/.env; set +a' >> ~/.bashrc
echo 'set -a; source /agentic-central/.env; set +a' >> ~/.profile
```

Every new terminal re-sources `.env` fresh, so credential rotations in
`agentic-central/.env` reach new shells without a container rebuild.

## What propagates, and what doesn't

| Change                                  | Visible in container?                 | Visible on host?           |
|-----------------------------------------|---------------------------------------|----------------------------|
| Edit a file under `/agentic-central/`   | ✅ immediately (bind mount)           | ✅ immediately             |
| Edit inside `.claude/` in the project   | ✅ (it's the symlink)                 | ✅ — writes into agentic-central on host |
| Edit `agentic-central/settings.json`    | ✅ via `.claude/` symlink             | ✅                         |
| Edit `agentic-central/claude.json`      | ⚠️ stale — `~/.claude.json` is a copy | N/A                        |
| Edit `agentic-central/claude.home.settings.json` | ⚠️ stale — copy at `~/.claude/settings.json` | N/A |
| Edit `agentic-central/.env`             | ⚠️ existing processes unchanged; new terminals pick it up via `.bashrc` |  ✅ |
| `git pull` inside `/agentic-central/`   | ✅ live (bind mount picks it up)      | ✅                         |

**Rule of thumb:** anything *referenced via the mount or symlink* is live;
anything *copied at post-start* is a snapshot until the container restarts or
you re-run `post-start.sh` manually.

## Editing shared config from inside the container

Because the mount is read/write, editing `/agentic-central/commands/foo.md`
from a container shell is a **direct edit of the agentic-central repo on the
host**. Commit and push it like any other repo:

```bash
cd /agentic-central
git status
git add commands/foo.md
git commit -m "add foo command"
git push
```

Other devs (and your other projects' containers) pick up the change on their
next pull.

## Onboarding a new dev

1. Clone `agentic-central` somewhere on the host (e.g. `~/git/agentic-central`).
2. Clone this project.
3. `cp .devcontainer/.env.example .devcontainer/.env` and set
   `AGENTIC_CENTRAL_PATH` + `WINDOWS_USER`.
4. Reopen in devcontainer — mount, symlink, copies, and env sourcing all
   happen automatically.
