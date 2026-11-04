# Order

Order-owned code for the Riso Scotti zero-touch back office (hackathon Track B).

Design: [`order-dec.md`](../order-dec.md).

## Pipeline

1. **Parse EDI** (`parser.py`) — `BGM`, `DTM`, `NAD+BY`, `NAD+SU`, `LIN`, `QTY`, optional `PRI`. Raises `parse_flags` on ambiguity (e.g. `20.000`).
2. **Availability** (`availability.py`) — `getAvailability` hook; default reads `data/orders/availability_stub.json` until Core wires Mini ERP / stock projection.
3. **Price** (`contract.py`) — fictional Scotti↔Esselunga contract with volume discounts; mismatch → draft mail (not auto-sent) → human **manual EDI / pending** path.
4. **Confirm sign-off** — always required when checks pass; then `ordrsp.py` builds ORDRSP + shipping handoff.

Grokbot loops (parse correction → re-parse; qty split/mail → re-check stock) are status gates today: `await_grok_parse`, `await_grok_qty`. Live Grok wiring comes next.

## Run

```bash
# from repo root
python3 -m order.pipeline data/orders/edi/ordine_ess_001.edi
python3 -m order.pipeline data/orders/edi/ordine_ess_001.edi --confirm
python3 -m order.pipeline data/orders/edi/ordine_ess_messy.edi
python3 -m order.pipeline data/orders/edi/ordine_ess_short.edi
python3 -m order.pipeline data/orders/edi/ordine_ess_bad_price.edi
```

## Tests

```bash
pip install -r requirements.txt
python3 -m pytest tests/test_order_parser.py tests/test_order_pipeline.py -q
```

## Fixtures

| Path | Role |
|---|---|
| `data/orders/edi/ordine_ess_001.edi` | Clean order (checks pass → confirm) |
| `data/orders/edi/ordine_ess_messy.edi` | Ambiguous qty / date → `await_grok_parse` |
| `data/orders/edi/ordine_ess_short.edi` | Qty above stub stock → `await_grok_qty` |
| `data/orders/edi/ordine_ess_bad_price.edi` | Wrong PRI → draft mail + `await_price_human` |
| `data/orders/contract_scotti_esselunga.json` | Demo contract |
| `data/orders/availability_stub.json` | Stock stub for Core to replace |
