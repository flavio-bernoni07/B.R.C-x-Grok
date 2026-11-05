#!/usr/bin/env bash
# Start the dashboard and open it. If it is already running, just open it.
# The Mac app launcher calls this with no terminal and opens its own window, so
# the browser opens only when you run the command yourself.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="http://127.0.0.1:3000"
OPEN=0
[ -t 1 ] && OPEN=1

open_dashboard() {
  [ "$OPEN" = 1 ] || return 0
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
}

ready() { curl -sf --max-time 3 "$URL/api/shell" >/dev/null; }

if ready; then
  echo "Dashboard is already running at $URL"
  open_dashboard
  exit 0
fi

if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 3000; then
  echo "Port 3000 is in use, but it is not the B.R.C dashboard." >&2
  exit 1
fi

(
  for _ in $(seq 1 90); do
    if curl -sf --max-time 3 "$URL/api/shell" >/dev/null; then
      open_dashboard
      exit 0
    fi
    sleep 1
  done
) &
opener=$!

set +e
pnpm exec next dev apps/web
status=$?
set -e
kill "$opener" 2>/dev/null || true
wait "$opener" 2>/dev/null || true
if ready; then
  echo "Dashboard is already running at $URL"
  open_dashboard
  exit 0
fi
exit "$status"
