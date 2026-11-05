#!/usr/bin/env bash
# Download the B.R.C x Grok Mac app, install it in /Applications, start the
# local dashboard if needed, and open the window.
#   curl -fsSL https://raw.githubusercontent.com/flavio-bernoni07/B.R.C-x-Grok/main/scripts/get-dashboard.sh | bash
#   scripts/get-dashboard.sh --app-only    # app only (no clone / deps); still starts the server
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/pnpm:$PATH"

APP_ONLY=0
[ "${1:-}" = "--app-only" ] && APP_ONLY=1

APP="/Applications/B.R.C x Grok.app"
ZIP_URL="https://github.com/flavio-bernoni07/B.R.C-x-Grok/releases/latest/download/BRC-x-Grok-mac.zip"
URL="http://127.0.0.1:3000"
LOG="${HOME}/Library/Logs/brc-grok.log"
ROOT=""

die() { echo "$*" >&2; exit 1; }

pick_root() {
  if [ -n "${BRC_REPO:-}" ]; then
    ROOT="$BRC_REPO"
  elif [ -d "$HOME/Developer/BRC-redesign/agent-core" ]; then
    ROOT="$HOME/Developer/BRC-redesign"
  elif [ -d "$HOME/Developer/B.R.C-x-Grok/agent-core" ]; then
    ROOT="$HOME/Developer/B.R.C-x-Grok"
  else
    ROOT="$HOME/Developer/B.R.C-x-Grok"
  fi
}

ensure_repo() {
  pick_root
  if [ ! -d "$ROOT/agent-core" ]; then
    echo "Downloading the dashboard…"
    mkdir -p "$(dirname "$ROOT")"
    git clone --depth 1 https://github.com/flavio-bernoni07/B.R.C-x-Grok.git "$ROOT"
  else
    echo "Updating the dashboard…"
    git -C "$ROOT" fetch --depth 1 origin main 2>/dev/null || true
    git -C "$ROOT" checkout -q main 2>/dev/null || true
    git -C "$ROOT" pull --ff-only origin main 2>/dev/null || true
  fi
  [ -d "$ROOT/agent-core" ] || die "Cannot find the repo at $ROOT/agent-core."
}

ensure_node_pnpm() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node is not installed. Install Node 24 (brew install node@24), then run this again."
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" != "24" ]; then
    die "Need Node 24 (you have $(node -v)). brew install node@24 && brew link --overwrite --force node@24"
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
      echo "Enabling pnpm via corepack…"
      corepack enable >/dev/null 2>&1 || true
      corepack prepare pnpm@10.33.0 --activate
    else
      die "pnpm is not installed. Install pnpm (brew install pnpm), then run this again."
    fi
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm is still not on PATH."
}

ensure_deps() {
  if [ ! -d "$ROOT/agent-core/node_modules" ]; then
    echo "Installing dependencies…"
    (cd "$ROOT/agent-core" && pnpm install --frozen-lockfile)
  fi
}

install_app() {
  echo "Downloading the B.R.C x Grok app…"
  local tmp
  tmp="$(mktemp -d)"
  curl -fL --retry 3 -o "$tmp/app.zip" "$ZIP_URL"
  ditto -x -k "$tmp/app.zip" "$tmp/out"
  [ -d "$tmp/out/B.R.C x Grok.app" ] || die "The Mac app zip did not contain B.R.C x Grok.app."
  rm -rf "$APP"
  ditto "$tmp/out/B.R.C x Grok.app" "$APP"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  rm -rf "$tmp"
  [ -d "$APP" ] || die "Failed to install $APP."
}

ensure_app() {
  if [ ! -d "$APP" ]; then
    install_app
  fi
}

dashboard_up() { curl -sf --max-time 3 "$URL/api/shell" >/dev/null; }

ensure_server() {
  if dashboard_up; then
    echo "Dashboard already running at $URL"
    return 0
  fi
  mkdir -p "$(dirname "$LOG")"
  echo "Starting the dashboard server (log: $LOG)…"
  (
    cd "$ROOT/agent-core"
    nohup pnpm exec next dev apps/web -H 127.0.0.1 -p 3000 >>"$LOG" 2>&1 &
  )
  local i
  for i in $(seq 1 90); do
    if dashboard_up; then
      echo "Dashboard is ready."
      return 0
    fi
    sleep 1
  done
  die "The server did not start on $URL. See $LOG"
}

# --- main ---
if [ "$APP_ONLY" != 1 ]; then
  ensure_repo
  ensure_node_pnpm
  ensure_deps
else
  pick_root
  [ -d "$ROOT/agent-core" ] || die "Cannot find the repo at $ROOT/agent-core. Run without --app-only once."
fi

ensure_app
ensure_server

echo "Opening B.R.C x Grok."
open "$APP" || die "macOS could not open $APP."
