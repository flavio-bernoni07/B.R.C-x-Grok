#!/usr/bin/env bash
# The whole test suite in one command: ./test.sh   (extra arguments go to pytest, e.g. ./test.sh -k shipping)
# Creates .venv the first time, installs requirements.txt, runs every test. No API key or network needed.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
.venv/bin/python -m pip install -q -r requirements.txt
env -u XAI_API_KEY -u GROK_API_KEY BRC_OFFLINE=1 .venv/bin/python -m pytest -q "$@"
