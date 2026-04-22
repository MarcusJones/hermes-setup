#!/usr/bin/env bash
set -e

WORKSPACE="${1:?Error: containerWorkspaceFolder not provided as argument}"
echo Workspace folder: "${WORKSPACE}"
# ============================================================================
# Validate agentic-central mount before anything else touches it.
# Fails early with a clear message if the host repo isn't where we expect.
# See .devcontainer/README.md for the full flow.
# ============================================================================
AC_MOUNT=/agentic-central
AC_REQUIRED_FILES=(
    ".env"
    "claude.json"
    "claude.home.settings.json"
)

fail_ac() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════════════╗"
    echo "║  ❌ agentic-central integration is broken                          ║"
    echo "╚════════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "$1"
    echo ""
    echo "How to fix:"
    echo "  1. Clone agentic-central on the host (e.g. ~/git/agentic-central)."
    echo "  2. Set AGENTIC_CENTRAL_PATH in .devcontainer/.env to that host path."
    echo "     (Copy .devcontainer/.env.example if .env doesn't exist yet.)"
    echo "  3. Rebuild the devcontainer:  Dev Containers: Rebuild Container"
    echo ""
    echo "See .devcontainer/README.md for the full integration flow."
    echo ""
    exit 1
}

if [ ! -d "$AC_MOUNT" ]; then
    fail_ac "Expected bind mount at ${AC_MOUNT} but the directory does not exist.
This usually means AGENTIC_CENTRAL_PATH in .devcontainer/.env points
to a host path that doesn't exist, or the container was started outside
the VS Code devcontainer workflow."
fi

if [ -z "$(ls -A "$AC_MOUNT" 2>/dev/null)" ]; then
    fail_ac "${AC_MOUNT} is mounted but empty.
AGENTIC_CENTRAL_PATH in .devcontainer/.env probably points to an empty
or wrong directory on the host."
fi

missing=()
for f in "${AC_REQUIRED_FILES[@]}"; do
    [ -e "${AC_MOUNT}/${f}" ] || missing+=("${f}")
done
if [ ${#missing[@]} -gt 0 ]; then
    fail_ac "${AC_MOUNT} is mounted but is missing required files:
$(printf '    - %s\n' "${missing[@]}")
The host repo at AGENTIC_CENTRAL_PATH doesn't look like agentic-central.
Make sure you cloned the correct repo and it's up to date (git pull)."
fi

echo "✅ agentic-central mount validated at ${AC_MOUNT}"

# Link shared agentic-central directory into the project's .claude folder
sudo ln -sfn /agentic-central "${WORKSPACE}/.claude"
echo "✅ Linked ${AC_MOUNT} to ${WORKSPACE}/.claude"

# Ensure user-level Claude config directory exists
mkdir -p ~/.claude

# Copy Claude Code project config to user home (ignore if source missing)
cp /agentic-central/claude.json ~/.claude.json 2>/dev/null || true

# Copy Claude Code home-level settings (e.g. permissions, defaults)
cp /agentic-central/claude.home.settings.json ~/.claude/settings.json

# Source agentic-central .env so AWS_* and other vars are available below.
# (The bashrc/profile lines further down handle future terminal sessions;
#  this set -a here makes them available in *this* script run.)
set -a
# shellcheck disable=SC1091
source /agentic-central/.env
set +a

# Install Node dependencies
pnpm install

# Persist env vars for all future terminal sessions (e.g. Claude Code auth)
echo 'set -a; source /agentic-central/.env; set +a' >> ~/.bashrc
echo 'set -a; source /agentic-central/.env; set +a' >> ~/.profile

echo 'export CLAUDE_TRUST_PROMPT=true' >> ~/.bashrc
echo 'export CLAUDE_TRUST_PROMPT=true' >> ~/.profile

# Configure AWS CLI with credentials from .env
# (AWS CLI itself is installed in the Dockerfile.)
# This creates ~/.aws/credentials and ~/.aws/config files
if [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ]; then
    echo "=================================="
    echo "🔐 Configuring AWS credentials..."
    echo "=================================="
    mkdir -p ~/.aws

    cat > ~/.aws/credentials <<EOF
[default]
aws_access_key_id = ${AWS_ACCESS_KEY_ID}
aws_secret_access_key = ${AWS_SECRET_ACCESS_KEY}
EOF

    cat > ~/.aws/config <<EOF
[default]
region = ${AWS_REGION:-eu-central-1}
output = json
EOF

    echo "✅ AWS CLI configured for region: ${AWS_REGION:-eu-central-1}"
else
    echo "⚠️  WARNING: AWS credentials not found in .env file"
    echo "   Add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to /agentic-central/.env"
fi

echo "Mount screenshot folder"
if [ -n "${WORKSPACE}" ]; then
    ln -sfn /screenshots "${WORKSPACE}/.screenshots"
else
    echo "WARNING: WORKSPACE not set, skipping .screenshots symlink"
fi