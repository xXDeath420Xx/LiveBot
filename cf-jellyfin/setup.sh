#!/usr/bin/env bash
# ============================================================================
# CertiFried Discord bot — Jellyfin federation module setup
# ----------------------------------------------------------------------------
# One-shot setup for the bot-side federation module on the remote bot server
# (death@server.certifriedmultitool.com).
#
# Usage:
#   1. scp -r bot-side/ death@server.certifriedmultitool.com:~/cf-jellyfin/
#   2. ssh death@server.certifriedmultitool.com
#   3. cd ~/cf-jellyfin && bash setup.sh
#
# This script installs deps, generates a fresh shared token, populates .env,
# and prints the registry entry to paste into auth-app/bots.json on the
# Jellyfin host. It does NOT start the bot — your existing bot process owner
# (systemd, pm2, etc.) handles that.
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")"

# --- Sanity checks -------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo >&2 "node is required"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo >&2 "Node.js >=18 required (have $(node -v))"
    exit 1
fi

# --- Install deps --------------------------------------------------------
if [ ! -d node_modules ]; then
    echo "Installing npm dependencies..."
    npm install --omit=dev
fi

# --- Generate / preserve shared token ------------------------------------
ENV_FILE=.env
if [ ! -f "$ENV_FILE" ]; then
    cp .env.example "$ENV_FILE"
    echo "Created .env from .env.example"
fi

# Read current token if any
CURRENT_TOKEN=$(grep -E '^CF_FED_TOKEN=' "$ENV_FILE" | sed 's/^CF_FED_TOKEN=//' || echo '')
if [ -z "$CURRENT_TOKEN" ] || [ "$CURRENT_TOKEN" = "replace-with-long-random-hex" ]; then
    NEW_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    sed -i.bak "s|^CF_FED_TOKEN=.*|CF_FED_TOKEN=${NEW_TOKEN}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
    CURRENT_TOKEN="$NEW_TOKEN"
    echo "Generated new CF_FED_TOKEN."
else
    echo "Reusing existing CF_FED_TOKEN."
fi

# Ensure CF_BOT_NAME is set (default to certifried-default)
if ! grep -qE '^CF_BOT_NAME=.+' "$ENV_FILE"; then
    sed -i.bak "s|^CF_BOT_NAME=.*|CF_BOT_NAME=certifried-default|" "$ENV_FILE" 2>/dev/null || true
    rm -f "${ENV_FILE}.bak"
fi

BOT_NAME=$(grep -E '^CF_BOT_NAME=' "$ENV_FILE" | sed 's/^CF_BOT_NAME=//')
WEBHOOK_SECRET_PRESENT=$(grep -E '^CF_WEBHOOK_SECRET=.+' "$ENV_FILE" | wc -l)

if [ "$WEBHOOK_SECRET_PRESENT" -eq 0 ] || [ "$(grep -E '^CF_WEBHOOK_SECRET=' "$ENV_FILE" | sed 's/^CF_WEBHOOK_SECRET=//')" = "" ]; then
    NEW_WHS=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
    sed -i.bak "s|^CF_WEBHOOK_SECRET=.*|CF_WEBHOOK_SECRET=${NEW_WHS}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
    echo "Generated new CF_WEBHOOK_SECRET."
fi

WEBHOOK_SECRET=$(grep -E '^CF_WEBHOOK_SECRET=' "$ENV_FILE" | sed 's/^CF_WEBHOOK_SECRET=//')
FED_PORT=$(grep -E '^FEDERATION_PORT=' "$ENV_FILE" | sed 's/^FEDERATION_PORT=//')

# --- Print the registry entry the auth-app needs -------------------------
cat <<EOF

===============================================================================
NEXT STEP — paste this into B:\\JellyFin Server\\auth-app\\bots.json on the
Jellyfin host (replace [] with [{...}], or append to existing array):

  {
    "name": "${BOT_NAME}",
    "api_base": "https://server.certifriedmultitool.com/bot",
    "shared_token": "${CURRENT_TOKEN}"
  }

(Adjust api_base if the bot's federation port :${FED_PORT:-8080} is reverse-
proxied at a different path.)

Then on the Jellyfin host:
  1. Save bots.json
  2. Restart the auth-app (the registry hot-reloads every 5 min, but a
     restart picks it up immediately)

Webhook setup (in Jellyfin admin UI, after Jellyfin restart):
  Plugins -> Webhook -> Add Generic Destination
    Webhook URL: https://server.certifriedmultitool.com/bot/webhook/jellyfin
    Add Header:  X-Webhook-Secret = ${WEBHOOK_SECRET}
    Notifications: ItemAdded, PlaybackStart, PlaybackStop, UserCreated,
                   UserDeleted, SubtitleDownloadFailure, PluginInstallationFailed

Bot side: integrate example-integration.js patterns into your existing bot,
or run example-integration.js directly with your DISCORD_BOT_TOKEN set.
===============================================================================

EOF
