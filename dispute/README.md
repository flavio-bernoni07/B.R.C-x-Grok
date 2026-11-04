# Dispute

Dispute-owned code for the Riso Scotti zero-touch back office (hackathon Track B).

## Claim reader

`claim_reader.py` turns a messy retailer claim email (or short-payment remittance text) into a structured object via Grok / xAI.

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `XAI_API_KEY` or `GROK_API_KEY` | yes for live runs | xAI API key |
| `XAI_BASE_URL` | no | default `https://api.x.ai/v1` |
| `XAI_MODEL` or `GROK_MODEL` | no | default `grok-4-latest` (`XAI_MODEL` wins if both set) |

Without a key, live extraction fails clearly (no silent fake output). `--dry-run` only checks that a fixture file loads.

### Run

```bash
# from repo root
python -m dispute.claim_reader --dry-run data/disputes/claims/01_shortage_messy_it.txt
python -m dispute.claim_reader data/disputes/claims/01_shortage_messy_it.txt
```

### Tests (no API key)

```bash
pip install -r requirements.txt
python -m pytest tests/test_claim_reader.py -q
```

## Pull the facts

`pull_facts.py` takes claim-reader output (or a hand-written extraction JSON), looks up order / DESADV / invoice / proofs in the mock Mini ERP catalog (`data/disputes/erp/catalog.json`) or a live export, and runs **two** matchers:

- **Baseline threeway:** vendored [Bhavya-Dhoot/threeway](https://github.com/Bhavya-Dhoot/threeway) in `dispute/_threeway_core.py` (MIT, see `THREEWAY_LICENSE.txt`) — one reason per flagged line.
- **Shipping reconcile:** `shipping.reconcile.reconcile_documents` — names every cause (same code as `bench.score`). Exposed on `facts.reconcile`; verdicts should cite `kind: reconcile`.

### Run (no Grok needed)

```bash
python3 -m dispute.pull_facts data/disputes/extractions/01_shortage.json
python3 -m pytest tests/test_pull_facts.py -q
```

Optional live path (needs API key):  
`python3 -m dispute.pull_facts --from-claim-email data/disputes/claims/01_shortage_messy_it.txt`

## Verdict + sources

`verdict.py` takes claim-reader output + pull_facts (or a saved facts JSON), loads the
Playbook and contract excerpt, and asks Grok for `accept` | `partial` | `reject`
with a source on every point. Code normalizes amounts to figures present in
claim / docs / threeway — invented euros are dropped or clamped.

### Run

```bash
# dry-run: load claim + facts + playbook, no API key
python3 -m dispute.verdict --extraction data/disputes/extractions/01_shortage.json --dry-run

# live (needs XAI_API_KEY or GROK_API_KEY)
python3 -m dispute.verdict --extraction data/disputes/extractions/01_shortage.json

python3 -m pytest tests/test_verdict.py -q
```

Playbook: `data/disputes/playbook.md`  
Contract excerpt: `data/disputes/contract_excerpt.md`

## Credit note / reject reply

`outcome.py` turns a verdict into documents (code writes amounts — never invents):

- **accept / partial** → FatturaPA **TD04** XML via [`a38`](https://github.com/Truelite/python-a38) + EDI INVOIC credit hint (`BGM+381`)
- **reject** → evidence reply listing DESADV / DDT / threeway / contract / warehouse refs from the verdict (+ facts when available)

```bash
pip install -r requirements.txt
python3 -m dispute.outcome --verdict data/disputes/verdicts/01_shortage_accept.json --issue-date 2026-11-04
python3 -m dispute.outcome --verdict data/disputes/verdicts/05_ambiguous_reject.json --approved-by EMP-DISPUTE-01
python3 -m pytest tests/test_outcome.py -q
```

Outputs land in `data/disputes/outcomes/` (override with `--out-dir`).

There is no euro threshold. An ambiguous verdict (`needs_sign_off`, with the reasons in
`sign_off_reasons`) writes nothing for the retailer: the outcome stays `awaiting_sign_off`
until a person approves it with `--approved-by NAME`.

## One-shot demo runner

```bash
./scripts/run_dispute_claim.sh data/disputes/claims/01_shortage_messy_it.txt
# No API key → offline fixtures (extraction+verdict); with key → live claim_reader+verdict.
# Writes JSON under data/disputes/runs/<claim-stem>/ (or OUT_DIR=… / --out-dir).
# Passes --approved-by demo by default so needs_sign_off verdicts still emit TD04/reject reply.

# Jury / Mini ERP only (no catalog.json merge) after: python3 demo.py --db data/demo.sqlite
./scripts/run_dispute_claim.sh data/world/golden/claim_email.txt --erp-db data/demo.sqlite --offline
python3 -m dispute.service --db data/demo.sqlite data/world/golden/claim_email.txt \
  --out-dir /tmp/jury --offline data/world/golden/grok_offline.json
```

Remittance `PRI/UNK` / short-pay text is post-processed to `claim_type: pricing` in `claim_reader` (and via threeway / reconcile price-gap safety nets in `pull_facts`).

## On the Mini ERP

`dispute/service.py` runs the whole row on the shared Mini ERP: `handle_claim()` reads the claim, pulls the facts from what Shipping exported (plus fixtures unless `include_fixtures=False`), asks for the verdict, and either writes the outcome or opens a sign-off. `approve_verdict()` / `reject_verdict()` close the loop. Tests: `tests/test_dispute_service.py`, `tests/test_dispute_desk.py`.

## Sign-off desk (case pack)

When a claim is handed off, the desk puts everything in one place so the person
does not hunt for documents:

```bash
python3 -m dispute.desk --db data/demo.sqlite list
# each row: why_handed_off, blocking_question, decision, evidence_count

python3 -m dispute.desk --db data/demo.sqlite show SO-0001
# briefing + why handed off + evidence index (order, DESADV, invoice, DDT, reconcile…)

python3 -m dispute.desk --db data/demo.sqlite show SO-0001 --pack-dir /tmp/SO-0001
# writes README.md, briefing.json, evidence.json, verdict.json, facts.json

python3 -m dispute.desk --db data/demo.sqlite approve SO-0001 --by Sara --reason "Late gate-in"
# also activates a learned rule so the next same-kind claim can close alone
```

### Out of scope

Shared CRM **web** UI (desk CLI + `crm/` API cover the same queue for now).
