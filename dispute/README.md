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

`pull_facts.py` takes claim-reader output (or a hand-written extraction JSON), looks up order / DESADV / invoice / proofs in the mock Mini ERP catalog (`data/disputes/erp/catalog.json`), and runs three-way matching.

**Three-way:** vendored copy of [Bhavya-Dhoot/threeway](https://github.com/Bhavya-Dhoot/threeway) core in `dispute/_threeway_core.py` (MIT, see `THREEWAY_LICENSE.txt`). Same idea as the track baseline: join on order + item, tolerate tiny qty/€ diffs, one reason per flagged line. DESADV lines are treated as goods received.

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
python3 -m dispute.outcome --verdict data/disputes/verdicts/05_ambiguous_reject.json
python3 -m pytest tests/test_outcome.py -q
```

Outputs land in `data/disputes/outcomes/` (override with `--out-dir`).

### Out of scope

Sign-off web UI (Playbook threshold only), real Mini ERP / SQLite persistence beyond writing outcome files.
