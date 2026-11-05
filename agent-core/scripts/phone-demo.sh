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

# .env.local is dotenv, not bash — never `source` it (comments/values often contain `(`).
load_dotenv() {
  [ -f .env.local ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    # strip CR, leading spaces, and full-line comments
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    case "$key" in
      XAI_API_KEY|XAI_VOICE_WEBHOOK_SECRET|XAI_WEBHOOK_SECRET|BRC_PUBLIC_BASE_URL|BRC_PHONE_ALLOWLIST|BRC_PHONE_DEMO_OPEN|XAI_SPEECH_VOICE) ;;
      *) continue ;;
    esac
    val="${line#*=}"
    # trim surrounding single/double quotes only
    if [[ "$val" == \"*\" && "$val" == *\" ]]; then val="${val:1:${#val}-2}"; fi
    if [[ "$val" == \'*\' && "$val" == *\' ]]; then val="${val:1:${#val}-2}"; fi
    export "$key=$val"
  done < .env.local
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
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" != "24" ]; then
    bold "Note: Node $major detected (engines want 24.x). Prefer: nvm use 24"
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

have_cloudflared() {
  command -v cloudflared >/dev/null 2>&1
}

ensure_cloudflared() {
  if have_cloudflared; then
    green "cloudflared: $(command -v cloudflared)"
    return 0
  fi

  # Homebrew is the reliable path on macOS (GitHub tarball often hits curl 23 in sandboxes).
  if command -v brew >/dev/null 2>&1; then
    bold "Installing cloudflared via Homebrew…"
    if brew install cloudflared; then
      if have_cloudflared; then
        green "cloudflared: $(command -v cloudflared)"
        return 0
      fi
    fi
  fi

  bold "Downloading cloudflared into agent-core/.bin…"
  local bin="$ROOT/.bin"
  mkdir -p "$bin"
  local os arch asset url tmp
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) red "Unsupported arch: $arch"; exit 1 ;;
  esac
  case "$os" in
    darwin) asset="cloudflared-darwin-${arch}.tgz" ;;
    linux) asset="cloudflared-linux-${arch}" ;;
    *) red "Unsupported OS: $os"; exit 1 ;;
  esac
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
  tmp="$(mktemp "${TMPDIR:-/tmp}/cloudflared.XXXXXX")"
  if ! curl -fL --retry 3 --retry-delay 1 --connect-timeout 20 --max-time 120 -o "$tmp" "$url"; then
    rm -f "$tmp"
    red "Could not download cloudflared."
    red "Install it yourself, then re-run:  brew install cloudflared"
    exit 1
  fi
  if [ "$os" = "darwin" ]; then
    if ! tar -xzf "$tmp" -C "$bin"; then
      rm -f "$tmp"
      red "cloudflared archive extract failed. Try: brew install cloudflared"
      exit 1
    fi
    rm -f "$tmp"
    # tarball usually contains a bare "cloudflared" binary
    if [ ! -x "$bin/cloudflared" ]; then
      local found
      found="$(find "$bin" -type f -name cloudflared 2>/dev/null | head -n1 || true)"
      if [ -n "$found" ]; then
        mv "$found" "$bin/cloudflared"
        chmod +x "$bin/cloudflared"
      fi
    fi
  else
    mv "$tmp" "$bin/cloudflared"
    chmod +x "$bin/cloudflared"
  fi
  export PATH="$bin:$PATH"
  if ! have_cloudflared; then
    red "cloudflared still missing after install. Try: brew install cloudflared"
    exit 1
  fi
  green "cloudflared: $(command -v cloudflared)"
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

# Writes the public HTTPS origin to the path in $1 (avoids bash 3.2 set -e issues inside $()).
start_tunnel() {
  local out_file="$1"
  if ! have_cloudflared; then
    red "cloudflared not on PATH"; exit 1
  fi
  stop_old_tunnel
  : >"$TUNNEL_LOG"
  bold "Opening public tunnel to $URL…"
  nohup cloudflared tunnel --url "$URL" --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
  echo $! >"$TUNNEL_PID_FILE"
  local public="" i
  for i in $(seq 1 60); do
    if ! kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
      red "cloudflared exited early. Log:"
      cat "$TUNNEL_LOG" >&2 || true
      exit 1
    fi
    public="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n1 || true)"
    if [ -n "$public" ]; then
      printf '%s\n' "$public" >"$out_file"
      green "Tunnel: $public"
      return 0
    fi
    sleep 1
  done
  red "Tunnel URL not found after 60s. Log:"
  cat "$TUNNEL_LOG" >&2 || true
  red "If cloudflared is blocked, install via brew and re-run: brew install cloudflared"
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
  local res status
  # First hit can be slow (Next compile + optional Grok). Give it time; show progress.
  status="$(curl -sS -o /tmp/brc-phone-simulate.json -w '%{http_code}' --connect-timeout 5 --max-time 120 \
    -X POST "$URL/api/telephony/simulate" \
    -H 'content-type: application/json' \
    -d '{"retailer":"Esselunga","order_ref":"ORD-3001","category":"shortage","claimed_quantity":1100,"customer_description":"Phone demo rehearsal — received only 1100 of 1200 Carnaroli","language":"en"}" || true)"
  res="$(cat /tmp/brc-phone-simulate.json 2>/dev/null || true)"
  if [ "$status" != "200" ] || ! printf '%s' "$res" | grep -q '"ok":true'; then
    red "Simulate failed (HTTP $status): $res"
    red "If the dashboard was already running on an old build, stop it and re-run so routes refresh."
    exit 1
  fi
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
  ensure_cloudflared
  start_web
  local public_file public
  public_file="$(mktemp "${TMPDIR:-/tmp}/brc-phone-url.XXXXXX")"
  start_tunnel "$public_file"
  public="$(cat "$public_file")"
  rm -f "$public_file"
  if [ -z "$public" ]; then
    red "Empty tunnel URL"; exit 1
  fi
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
