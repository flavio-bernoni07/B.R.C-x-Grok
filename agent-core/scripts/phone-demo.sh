#!/usr/bin/env bash
# One-shot laptop demo for phone → Disputes (Path 1: Voice Agent Builder → /api/telephony/simulate).
# Starts (or reuses) the dashboard, opens a public tunnel, prints the Builder paste + call script.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
URL="http://127.0.0.1:3000"
TUNNEL_LOG="${TMPDIR:-/tmp}/brc-phone-tunnel.log"
TUNNEL_PID_FILE="${TMPDIR:-/tmp}/brc-phone-tunnel.pid"
WEB_LOG="${TMPDIR:-/tmp}/brc-phone-web.log"
WEB_PID_FILE="${TMPDIR:-/tmp}/brc-phone-web.pid"

# Progress goes to stderr so $(start_tunnel) only captures the public HTTPS URL.
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*" >&2; }
bold() { printf '\033[1m%s\033[0m\n' "$*" >&2; }

load_dotenv() {
  if [ -f .env.local ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env.local
    set +a
  fi
}

ensure_env() {
  load_dotenv
  if [ -z "${XAI_API_KEY:-}" ]; then
    if [ -f .env.example ] && [ ! -f .env.local ]; then
      cp .env.example .env.local
      red "Created .env.local from .env.example — put your XAI_API_KEY in it, then re-run."
      exit 1
    fi
    red "XAI_API_KEY is missing. Add it to agent-core/.env.local (from grok.com or console.x.ai)."
    exit 1
  fi
}

ensure_deps() {
  if [ ! -d node_modules/next ]; then
    bold "Installing pnpm dependencies…"
    pnpm install
  fi
}

ready() { curl -sf --max-time 3 "$URL/api/shell" >/dev/null; }

start_web() {
  if ready; then
    green "Dashboard already running at $URL"
    return 0
  fi
  bold "Resetting Mini ERP (demo orders ORD-3001 / ORD-3003)…"
  pnpm db:reset
  bold "Starting dashboard on $URL…"
  : >"$WEB_LOG"
  nohup pnpm exec next dev apps/web >"$WEB_LOG" 2>&1 &
  echo $! >"$WEB_PID_FILE"
  for _ in $(seq 1 90); do
    if ready; then
      green "Dashboard ready at $URL"
      return 0
    fi
    sleep 1
  done
  red "Dashboard did not become ready. Last log lines:"
  tail -n 40 "$WEB_LOG" >&2 || true
  exit 1
}

ensure_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    return 0
  fi
  bold "Installing cloudflared (user local)…"
  local bin="$ROOT/.bin"
  mkdir -p "$bin"
  local os arch asset
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) red "Unsupported arch: $arch"; exit 1 ;;
  esac
  case "$os" in
    darwin) asset="cloudflared-$os-$arch.tgz" ;;
    linux) asset="cloudflared-linux-$arch" ;;
    *) red "Unsupported OS: $os"; exit 1 ;;
  esac
  local url="https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
  if [ "$os" = "darwin" ]; then
    curl -fsSL "$url" -o "$bin/cloudflared.tgz"
    tar -xzf "$bin/cloudflared.tgz" -C "$bin"
    rm -f "$bin/cloudflared.tgz"
  else
    curl -fsSL "$url" -o "$bin/cloudflared"
    chmod +x "$bin/cloudflared"
  fi
  export PATH="$bin:$PATH"
}

stop_old_tunnel() {
  if [ -f "$TUNNEL_PID_FILE" ]; then
    local old
    old="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
    if [ -n "${old:-}" ] && kill -0 "$old" 2>/dev/null; then
      kill "$old" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$TUNNEL_PID_FILE"
  fi
}

start_tunnel() {
  ensure_cloudflared
  stop_old_tunnel
  : >"$TUNNEL_LOG"
  bold "Opening public tunnel to $URL…"
  nohup cloudflared tunnel --url "$URL" --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
  echo $! >"$TUNNEL_PID_FILE"
  local public=""
  for _ in $(seq 1 60); do
    public="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1 || true)"
    if [ -n "$public" ]; then
      echo "$public"
      return 0
    fi
    sleep 1
  done
  red "Tunnel URL not found. Log:"
  cat "$TUNNEL_LOG" >&2 || true
  exit 1
}

upsert_public_base() {
  local public="$1"
  touch .env.local
  if grep -q '^BRC_PUBLIC_BASE_URL=' .env.local; then
    # portable in-place replace
    local tmp
    tmp="$(mktemp)"
    awk -v v="$public" 'BEGIN{done=0} /^BRC_PUBLIC_BASE_URL=/{print "BRC_PUBLIC_BASE_URL=" v; done=1; next} {print} END{if(!done) print "BRC_PUBLIC_BASE_URL=" v}' .env.local >"$tmp"
    mv "$tmp" .env.local
  else
    printf '\nBRC_PUBLIC_BASE_URL=%s\n' "$public" >>.env.local
  fi
}

smoke_simulate() {
  bold "Smoke-testing simulate → Disputes…"
  local res
  res="$(curl -sf -X POST "$URL/api/telephony/simulate" \
    -H 'content-type: application/json' \
    -d '{"retailer":"Esselunga","order_ref":"ORD-3001","category":"shortage","claimed_quantity":1100,"customer_description":"Phone demo rehearsal — received only 1100 of 1200 Carnaroli","language":"en"}')"
  echo "$res" | grep -q '"ok":true' || {
    red "Simulate failed: $res"
    exit 1
  }
  local id
  id="$(printf '%s' "$res" | sed -n 's/.*"dispute_id":"\([^"]*\)".*/\1/p')"
  green "Wrote $id into local Disputes (open $URL/disputes)."
}

print_builder() {
  local public="$1"
  local tool_url="$public/api/telephony/simulate"
  echo >&2
  bold "=== Voice Agent Builder (do this once / when the tunnel URL changes) ==="
  cat >&2 <<EOF
1. Open https://console.x.ai → team grok hackathon → Voice Agents (Beta)
2. Open (or create) your Customer Support agent
3. Welcome message (exact):
   Hey, how's it going — how can I help you?
4. Instructions: paste agent-core/docs/phone-builder-instructions.txt
5. API Request tool name: submit_dispute
   Method: POST
   URL: $tool_url
   Body fields (Generated, not System):
     retailer (string, required)
     order_ref (string, required)
     category (string: shortage | pricing | damage | late_delivery | other)
     claimed_quantity (number, optional)
     claimed_amount (number, optional)
     customer_description (string, required)
     language (en | it)
6. Claim the free US phone number on the agent → Publish / Live
7. Keep this terminal running (dashboard + tunnel).
EOF
  echo >&2
  bold "=== Demo call script ==="
  cat >&2 <<EOF
Say (English): "Hi, this is Esselunga — order ORD-3001, we received only 1100 of 1200 Carnaroli, shortage."
Or damage: "Carrefour, order ORD-3003, 60 Arborio packs crushed on arrival."
Expect a spoken DSP-… then open $URL/disputes (Phone badge).
EOF
  echo >&2
  bold "=== Keep alive ==="
  cat >&2 <<EOF
Dashboard: $URL
Tunnel:    $public
Tool URL:  $tool_url
Logs:      $WEB_LOG  |  $TUNNEL_LOG
Stop tunnel: kill \$(cat $TUNNEL_PID_FILE)
EOF
  echo >&2
}

main() {
  ensure_env
  ensure_deps
  start_web
  local public
  public="$(start_tunnel)"
  upsert_public_base "$public"
  smoke_simulate
  print_builder "$public"
  bold "Ready. Leave this process's tunnel running while you demo."
  # Keep foreground if launched interactively so Ctrl-C stops the tunnel.
  if [ -t 1 ] && [ "${BRC_PHONE_DEMO_DETACH:-0}" != "1" ]; then
    bold "Press Ctrl-C to stop the tunnel (dashboard stays up)."
    trap 'stop_old_tunnel; exit 0' INT TERM
    while kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; do sleep 2; done
  fi
}

main "$@"
