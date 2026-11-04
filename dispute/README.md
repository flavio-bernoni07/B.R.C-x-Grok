# Dispute

Dispute-owned code for the Riso Scotti zero-touch back office (hackathon Track B).

## Claim reader

`claim_reader.py` turns a messy retailer claim email (or short-payment remittance text) into a structured object via Grok / xAI.

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `XAI_API_KEY` or `GROK_API_KEY` | yes for live runs | xAI API key |
| `XAI_BASE_URL` | no | default `https://api.x.ai/v1` |
| `XAI_MODEL` | no | default `grok-2-latest` |

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

### Out of scope (later PRs)

Verdict + sources, facts puller, TD04 / credit note, Mini ERP wiring.
