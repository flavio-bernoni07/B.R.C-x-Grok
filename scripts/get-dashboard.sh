#!/usr/bin/env bash
# Download the B.R.C x Grok Mac app, install it in /Applications, and open it.
# The app is a window on the local dashboard, so this also clones the repo and
# installs its dependencies when this Mac does not already have them.
#   curl -fsSL https://raw.githubusercontent.com/flavio-bernoni07/B.R.C-x-Grok/main/scripts/get-dashboard.sh | bash
#   scripts/get-dashboard.sh --app-only    # app only, from a checkout you already have
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

APP_ONLY=0
[ "${1:-}" = "--app-only" ] && APP_ONLY=1

APP="/Applications/B.R.C x Grok.app"
ZIP_URL="https://github.com/flavio-bernoni07/B.R.C-x-Grok/releases/latest/download/BRC-x-Grok-mac.zip"
ROOT=""

if [ "$APP_ONLY" != 1 ]; then
  if [ -d "$HOME/Developer/BRC-redesign/agent-core" ]; then
    ROOT="$HOME/Developer/BRC-redesign"
  elif [ -d "$HOME/Developer/B.R.C-x-Grok/agent-core" ]; then
    ROOT="$HOME/Developer/B.R.C-x-Grok"
  else
    ROOT="$HOME/Developer/B.R.C-x-Grok"
    echo "Downloading the dashboard…"
    git clone --depth 1 https://github.com/flavio-bernoni07/B.R.C-x-Grok.git "$ROOT"
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is not installed. Install Node and pnpm, then run this again." >&2
    exit 1
  fi
  if [ ! -d "$ROOT/agent-core/node_modules" ]; then
    echo "Installing dependencies…"
    (cd "$ROOT/agent-core" && pnpm install --frozen-lockfile)
  fi
fi

if [ ! -d "$APP" ]; then
  echo "Downloading the B.R.C x Grok app…"
  tmp="$(mktemp -d)"
  curl -fL --retry 3 -o "$tmp/app.zip" "$ZIP_URL"
  ditto -x -k "$tmp/app.zip" "$tmp/out"
  rm -rf "$APP"
  ditto "$tmp/out/B.R.C x Grok.app" "$APP"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  rm -rf "$tmp"
fi

echo "Opening B.R.C x Grok."
open "$APP"
