#!/usr/bin/env bash
# Open the hosted dashboard. It stays up when this Mac is off.
#   open https://brc-x-grok.vercel.app
#   curl -fsSL https://raw.githubusercontent.com/flavio-bernoni07/B.R.C-x-Grok/main/scripts/get-dashboard.sh | bash
#   scripts/get-dashboard.sh --app-only   # the local Mac app, used by pnpm dev:web
#   FORCE=1 scripts/get-dashboard.sh --local   # install the repo and the Mac app on this machine
set -euo pipefail

# Keep PATH ASCII-only and never fail the script if nvm is missing.
NVM_BIN=""
if [ -d "${HOME}/.nvm/versions/node" ]; then
  NVM_LATEST="$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | tail -1 || true)"
  if [ -n "${NVM_LATEST}" ]; then
    NVM_BIN="${HOME}/.nvm/versions/node/${NVM_LATEST}/bin"
  fi
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/share/pnpm:${NVM_BIN}:${PATH}"

FORCE="${FORCE:-0}"
APP="/Applications/B.R.C x Grok.app"
ZIP_URL="https://github.com/flavio-bernoni07/B.R.C-x-Grok/releases/latest/download/BRC-x-Grok-mac.zip"
URL="http://127.0.0.1:3000"
LOG="${HOME}/Library/Logs/brc-grok.log"
ROOT=""

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "-> $*"; }

pick_root() {
  if [ -n "${BRC_REPO:-}" ]; then
    ROOT="${BRC_REPO}"
  elif [ -d "${HOME}/Developer/BRC-redesign/agent-core" ]; then
    ROOT="${HOME}/Developer/BRC-redesign"
  elif [ -d "${HOME}/Developer/B.R.C-x-Grok/agent-core" ]; then
    ROOT="${HOME}/Developer/B.R.C-x-Grok"
  else
    ROOT="${HOME}/Developer/B.R.C-x-Grok"
  fi
}

ensure_repo() {
  pick_root
  if [ ! -d "${ROOT}/agent-core" ]; then
    say "Cloning the dashboard into ${ROOT}..."
    mkdir -p "$(dirname "${ROOT}")"
    git clone --depth 1 https://github.com/flavio-bernoni07/B.R.C-x-Grok.git "${ROOT}"
  else
    say "Updating ${ROOT}..."
    git -C "${ROOT}" remote get-url origin >/dev/null 2>&1 || git -C "${ROOT}" remote add origin https://github.com/flavio-bernoni07/B.R.C-x-Grok.git
    git -C "${ROOT}" fetch --depth 1 origin main || true
    git -C "${ROOT}" checkout -f main 2>/dev/null || git -C "${ROOT}" checkout -B main origin/main
    git -C "${ROOT}" reset --hard origin/main || true
  fi
  [ -d "${ROOT}/agent-core" ] || die "Repo missing at ${ROOT}/agent-core"
}

node_major() {
  # Always print only digits; never trust a dirty PATH without checking.
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null | tr -d '[:space:]'
}

ensure_node24() {
  local major
  major="$(node_major || true)"
  if [ "${major}" = "24" ]; then
    say "Node $(node -v) OK"
    return 0
  fi
  say "Need Node 24 (have $(command -v node >/dev/null && node -v || echo none)). Trying to install it..."
  if ! command -v brew >/dev/null 2>&1; then
    die "Homebrew missing. Install Node 24 from https://nodejs.org (24.x), then re-run."
  fi
  brew install node@24 || die "brew install node@24 failed"
  brew link --overwrite --force node@24 || true
  # Prefer the keg binary even if link is noisy.
  if [ -x /opt/homebrew/opt/node@24/bin/node ]; then
    export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:${PATH}"
  elif [ -x /usr/local/opt/node@24/bin/node ]; then
    export PATH="/usr/local/opt/node@24/bin:/usr/local/bin:${PATH}"
  fi
  hash -r 2>/dev/null || true
  major="$(node_major || true)"
  if [ "${major}" != "24" ]; then
    die "Still not on Node 24 (have $(node -v 2>/dev/null || echo none), major=${major:-?}). Run manually: brew install node@24 && brew link --overwrite --force node@24 && hash -r && node -v"
  fi
  say "Node $(node -v) OK"
}

ensure_node_pnpm() {
  ensure_node24
  # Pin pnpm to the repo packageManager when possible.
  if command -v corepack >/dev/null 2>&1; then
    say "Activating pnpm 10.33.0 via corepack..."
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.33.0 --activate || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      brew install pnpm || die "Install pnpm: brew install pnpm"
    else
      die "pnpm missing. Install pnpm, then re-run."
    fi
  fi
  say "pnpm $(pnpm -v) (node $(node -v))"
}

ensure_deps() {
  local need=0
  if [ "${FORCE}" = 1 ] || [ ! -d "${ROOT}/agent-core/node_modules" ]; then need=1; fi
  if [ ! -e "${ROOT}/agent-core/node_modules/next/package.json" ]; then need=1; fi
  if [ ! -e "${ROOT}/agent-core/node_modules/better-sqlite3/package.json" ]; then need=1; fi
  if [ "${need}" = 1 ]; then
    say "Installing dependencies with $(node -v) / pnpm $(pnpm -v)..."
    rm -rf "${ROOT}/agent-core/node_modules"
    if ! (cd "${ROOT}/agent-core" && pnpm install --frozen-lockfile); then
      echo "---- tip ----" >&2
      echo "If better-sqlite3 failed, install Apple build tools:" >&2
      echo "  xcode-select --install" >&2
      echo "Then re-run with FORCE=1." >&2
      die "pnpm install failed. See errors above."
    fi
  else
    say "Dependencies already installed."
  fi
  if [ ! -f "${ROOT}/data/app.sqlite" ]; then
    say "Seeding the Mini ERP..."
    (cd "${ROOT}/agent-core" && pnpm db:reset) || true
  fi
}

install_app() {
  say "Installing Mac app into /Applications..."
  local tmp
  tmp="$(mktemp -d)"
  curl -fL --retry 3 -o "${tmp}/app.zip" "${ZIP_URL}" || die "Could not download ${ZIP_URL}"
  ditto -x -k "${tmp}/app.zip" "${tmp}/out"
  [ -d "${tmp}/out/B.R.C x Grok.app" ] || die "Zip did not contain B.R.C x Grok.app"
  rm -rf "${APP}"
  ditto "${tmp}/out/B.R.C x Grok.app" "${APP}"
  xattr -dr com.apple.quarantine "${APP}" 2>/dev/null || true
  chmod +x "${APP}/Contents/MacOS/"* 2>/dev/null || true
  rm -rf "${tmp}"
  [ -d "${APP}" ] || die "Failed to install ${APP}"
}

ensure_app() {
  if [ "${FORCE}" = 1 ] || [ ! -d "${APP}" ] || [ ! -x "${APP}/Contents/MacOS/brc-window" ]; then
    install_app
  else
    say "Mac app already in /Applications."
    xattr -dr com.apple.quarantine "${APP}" 2>/dev/null || true
  fi
}

dashboard_up() { curl -sf --max-time 3 "${URL}/api/shell" >/dev/null 2>&1; }

free_port_3000_if_wrong() {
  if dashboard_up; then return 0; fi
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
    say "Port 3000 is busy with something that is not the dashboard - freeing it..."
    lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | xargs -n1 kill 2>/dev/null || true
    sleep 1
  fi
}

ensure_server() {
  mkdir -p "$(dirname "${LOG}")"
  free_port_3000_if_wrong
  if dashboard_up; then
    say "Dashboard already running at ${URL}"
    return 0
  fi
  say "Starting dashboard server (log: ${LOG})..."
  : >"${LOG}"
  (
    cd "${ROOT}/agent-core"
    nohup pnpm exec next dev apps/web -H 127.0.0.1 -p 3000 >>"${LOG}" 2>&1 &
    echo $! >"${HOME}/Library/Logs/brc-grok.pid"
  )
  local i
  for i in $(seq 1 120); do
    if dashboard_up; then
      say "Dashboard ready at ${URL}"
      return 0
    fi
    if [ "${i}" -eq 15 ] || [ "${i}" -eq 40 ]; then
      say "Still waiting... last log lines:"
      tail -n 15 "${LOG}" 2>/dev/null || true
    fi
    sleep 1
  done
  echo "---- ${LOG} (last 40 lines) ----" >&2
  tail -n 40 "${LOG}" >&2 || true
  die "Server did not become ready on ${URL}"
}

open_ui() {
  say "Opening B.R.C x Grok..."
  if open "${APP}" 2>/dev/null; then
    sleep 2
    if pgrep -f 'brc-window|B.R.C x Grok' >/dev/null 2>&1; then
      say "App launched."
      return 0
    fi
  fi
  say "Mac app did not stay open - opening the browser instead."
  open "${URL}" || die "Could not open ${URL}"
  say "Browser opened at ${URL}"
}

# The hosted dashboard. No install.
DASHBOARD_URL="https://brc-x-grok.vercel.app"

open_target() {
  local target="$1"
  if command -v open >/dev/null 2>&1; then
    open "${target}"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${target}"
  else
    printf '%s\n' "${target}"
  fi
}

# --- main ---
if [ "${1:-}" = "--app-only" ]; then
  if [ -d "${APP}" ]; then
    open "${APP}"
  else
    open_target "${DASHBOARD_URL}"
  fi
  exit 0
fi

if [ "${1:-}" = "--local" ]; then
  say "B.R.C x Grok setup"
  ensure_repo
  ensure_node_pnpm
  ensure_deps
  ensure_app
  ensure_server
  open_ui
  say "Done. If the window is blank, wait a few seconds or open ${URL}"
  exit 0
fi

say "Opening ${DASHBOARD_URL}"
open_target "${DASHBOARD_URL}"
