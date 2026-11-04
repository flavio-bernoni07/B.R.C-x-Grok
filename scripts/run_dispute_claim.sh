#!/usr/bin/env bash
# Run Dispute pipeline for one claim email (or remittance text).
# Live: claim_reader → pull_facts → verdict → outcome (needs XAI_API_KEY or GROK_API_KEY).
# Offline (default when no key, or --offline): use saved extraction + verdict fixtures.
# Jury / Mini ERP: pass --erp-db PATH (after demo.py --db …) to run handle_claim with
# include_fixtures=False — no catalog.json merge; misses are reported.
#
# Usage (from repo root):
#   ./scripts/run_dispute_claim.sh data/disputes/claims/01_shortage_messy_it.txt
#   ./scripts/run_dispute_claim.sh data/disputes/claims/04_short_payment_incomplete.txt --offline
#   ./scripts/run_dispute_claim.sh data/world/golden/claim_email.txt --erp-db data/demo.sqlite --offline
#   OUT_DIR=/tmp/dispute-run ./scripts/run_dispute_claim.sh path/to/claim.txt
#
# JSON only on stdout of each step is redirected to OUT_DIR; errors go to stderr.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <claim.txt> [--offline] [--out-dir DIR] [--approved-by NAME] [--erp-db PATH] [--with-fixtures]" >&2
  exit 2
fi

CLAIM=""
OFFLINE=0
OUT_DIR="${OUT_DIR:-}"
ISSUE_DATE="${ISSUE_DATE:-2026-11-04}"
# Demo default: auto-approve ambiguous verdicts so reject replies / TD04 emit.
APPROVED_BY="${APPROVED_BY:-demo}"
ERP_DB="${ERP_DB:-}"
WITH_FIXTURES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline) OFFLINE=1; shift ;;
    --with-fixtures) WITH_FIXTURES=1; shift ;;
    --erp-db)
      ERP_DB="$2"
      shift 2
      ;;
    --erp-db=*)
      ERP_DB="${1#*=}"
      shift
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --out-dir=*)
      OUT_DIR="${1#*=}"
      shift
      ;;
    --approved-by)
      APPROVED_BY="$2"
      shift 2
      ;;
    --approved-by=*)
      APPROVED_BY="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "usage: $0 <claim.txt> [--offline] [--out-dir DIR] [--approved-by NAME] [--erp-db PATH] [--with-fixtures]"
      exit 0
      ;;
    *)
      if [[ -z "$CLAIM" ]]; then
        CLAIM="$1"
        shift
      else
        echo "error: unexpected arg: $1" >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$CLAIM" || ! -f "$CLAIM" ]]; then
  echo "error: claim file not found: ${CLAIM:-<missing>}" >&2
  exit 2
fi

CLAIM_ABS="$(cd "$(dirname "$CLAIM")" && pwd)/$(basename "$CLAIM")"
STEM="$(basename "$CLAIM" .txt)"
PREFIX="$(echo "$STEM" | sed -n 's/^\([0-9][0-9]\).*/\1/p')"

# Map claim stem → fixture basenames under data/disputes/
case "$PREFIX" in
  01) EXT_NAME="01_shortage"; VERD_NAME="01_shortage_accept" ;;
  02) EXT_NAME="02_pricing"; VERD_NAME="02_pricing_accept" ;;
  03) EXT_NAME="03_damage"; VERD_NAME="03_damage_accept" ;;
  04) EXT_NAME="04_short_payment"; VERD_NAME="04_short_payment_accept" ;;
  05) EXT_NAME="05_ambiguous"; VERD_NAME="05_ambiguous_reject" ;;
  *)
    EXT_NAME=""
    VERD_NAME=""
    ;;
esac

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="data/disputes/runs/${STEM}"
fi
mkdir -p "$OUT_DIR"

has_key=0
if [[ -n "${XAI_API_KEY:-}" || -n "${GROK_API_KEY:-}" ]]; then
  has_key=1
fi

# --- Jury path: shared Mini ERP only (no catalog.json unless --with-fixtures) ---
if [[ -n "$ERP_DB" ]]; then
  if [[ ! -f "$ERP_DB" ]]; then
    echo "error: Mini ERP db not found: $ERP_DB (run: python3 demo.py --db $ERP_DB)" >&2
    exit 2
  fi
  ARGS=(--db "$ERP_DB" "$CLAIM_ABS" --out-dir "$OUT_DIR" --issue-date "$ISSUE_DATE")
  if [[ "$WITH_FIXTURES" -eq 1 ]]; then
    ARGS+=(--with-fixtures)
  fi
  if [[ "$OFFLINE" -eq 1 || "$has_key" -eq 0 ]]; then
    if [[ -f "data/world/golden/grok_offline.json" && "$STEM" == "claim_email" ]]; then
      ARGS+=(--offline data/world/golden/grok_offline.json)
    elif [[ -n "$EXT_NAME" && -n "$VERD_NAME" ]]; then
      ARGS+=(--extraction "data/disputes/extractions/${EXT_NAME}.json")
      ARGS+=(--verdict "data/disputes/verdicts/${VERD_NAME}.json")
    else
      echo "error: --erp-db offline needs golden claim_email or a numbered 01–05 claim" >&2
      exit 2
    fi
  fi
  echo "mode=erp-db db=$ERP_DB fixtures=$WITH_FIXTURES claim=$CLAIM_ABS out=$OUT_DIR" >&2
  cp "$CLAIM_ABS" "$OUT_DIR/claim.txt"
  python3 -m dispute.service "${ARGS[@]}" | tee "$OUT_DIR/summary.json"
  exit 0
fi

if [[ "$OFFLINE" -eq 1 || "$has_key" -eq 0 ]]; then
  MODE="offline"
  if [[ -z "$EXT_NAME" || -z "$VERD_NAME" ]]; then
    echo "error: offline mode needs a numbered demo claim (01–05); got: $STEM" >&2
    exit 2
  fi
  EXTRACTION="data/disputes/extractions/${EXT_NAME}.json"
  VERDICT="data/disputes/verdicts/${VERD_NAME}.json"
  if [[ ! -f "$EXTRACTION" || ! -f "$VERDICT" ]]; then
    echo "error: missing fixtures for $STEM ($EXTRACTION / $VERDICT)" >&2
    exit 2
  fi
  echo "mode=offline claim=$CLAIM_ABS out=$OUT_DIR" >&2
  # Still record the claim path for the run folder.
  cp "$CLAIM_ABS" "$OUT_DIR/claim.txt"
  cp "$EXTRACTION" "$OUT_DIR/01_extraction.json"
else
  MODE="live"
  echo "mode=live claim=$CLAIM_ABS out=$OUT_DIR model=${XAI_MODEL:-${GROK_MODEL:-grok-4-latest}}" >&2
  cp "$CLAIM_ABS" "$OUT_DIR/claim.txt"
  python3 -m dispute.claim_reader "$CLAIM_ABS" >"$OUT_DIR/01_extraction.json"
  EXTRACTION="$OUT_DIR/01_extraction.json"
fi

python3 -m dispute.pull_facts "$EXTRACTION" >"$OUT_DIR/02_facts.json"

if [[ "$MODE" == "live" ]]; then
  python3 -m dispute.verdict --extraction "$EXTRACTION" --facts "$OUT_DIR/02_facts.json" \
    >"$OUT_DIR/03_verdict.json"
  VERDICT="$OUT_DIR/03_verdict.json"
else
  cp "$VERDICT" "$OUT_DIR/03_verdict.json"
  VERDICT="$OUT_DIR/03_verdict.json"
fi

# Always pass --approved-by for mentor demos: verdicts with needs_sign_off
# (e.g. claim 05 ambiguous reject) otherwise stop at awaiting_sign_off.
OUTCOME_ARGS=(
  --verdict "$VERDICT"
  --facts "$OUT_DIR/02_facts.json"
  --out-dir "$OUT_DIR/outcome"
  --issue-date "$ISSUE_DATE"
)
if [[ -n "$APPROVED_BY" ]]; then
  OUTCOME_ARGS+=(--approved-by "$APPROVED_BY")
fi
python3 -m dispute.outcome "${OUTCOME_ARGS[@]}" >"$OUT_DIR/04_outcome.json"

python3 - <<PY
import json
from pathlib import Path
out = Path("$OUT_DIR")
ext = json.loads((out / "01_extraction.json").read_text())
facts = json.loads((out / "02_facts.json").read_text())
verd = json.loads((out / "03_verdict.json").read_text())
oc = json.loads((out / "04_outcome.json").read_text())
summary = {
    "mode": "$MODE",
    "claim": "$CLAIM_ABS",
    "out_dir": str(out.resolve()),
    "claim_type": ext.get("claim_type"),
    "order_ref": ext.get("order_ref") or (facts.get("order") or {}).get("order_ref"),
    "threeway": (facts.get("threeway") or {}).get("summary"),
    "reconcile": (facts.get("reconcile") or {}).get("causes"),
    "verdict": verd.get("decision"),
    "verdict_amount": verd.get("amount"),
    "outcome_kind": oc.get("kind"),
    "outcome_paths": oc.get("paths"),
}
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
PY
