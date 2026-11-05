# Dispute

**Owner:** carlojolly / Dispute
**Boxes on the map:** Claim email, Read the claim, Pull the facts, Verdict + sources, Credit note or reply

## Status

**Pipeline done** on `main`: claim reader → pull facts (baseline threeway **and** Shipping `reconcile`) → verdict + sources → TD04 / evidence reply, with ambiguity-only sign-off (no euro threshold). The HTML process map’s “>€500” rule is **obsolete** — see [DECISIONS.md](../DECISIONS.md) (4 Nov).

## Starting points

- Claim emails are generated with Grok (the brief gives no real ones). The brief's minimum demo names partial delivery, price difference and contested goods; a short payment (the retailer pays less than the invoice) is the other common case.
- [CUAD](https://github.com/TheAtticusProject/cuad): about 510 real US commercial contracts, annotated by lawyers in 41 clause types. Use it to write one synthetic supply contract between Riso Scotti and a retailer: complaint deadline, delivery tolerance, penalties, promo pricing. The contracts are American and not about food, so adapt them.
- Credit note: FatturaPA document type `TD04`. The EDI version is an INVOIC with `BGM` code 381.
- Evidence for a verdict: the order, the DESADV, the invoice, **Shipping reconcile causes** (preferred) / baseline threeway, the signed DDT, the contract clause.
- The jury checks that disputes are resolved "with the right evidence" and that every action traces back to a source document, so every point of a verdict needs a citation.

## What I decided

- **Split of work:** Grok decides and cites sources; **code** writes TD04 / EDI / amounts / evidence reply. Dispute ends in a credit note **or** a reply — never a new invoice.
- **Claim reader** (`dispute/claim_reader.py`): Grok extracts structured fields including **`issues[]`** when one email raises more than one problem; missing refs stay `null`. Legacy single-type JSON still works. Remittance `PRI` / `PRI/UNK` maps to `pricing` per issue.
- **Pull the facts** (`dispute/pull_facts.py`): Mini ERP / fixture lookup **once per claim**, then **both** vendored baseline threeway and `shipping.reconcile.reconcile_documents` (same code `bench.score` measures). Verdicts should cite `reconcile` cause codes when present.
- **Verdict + sources** (`dispute/verdict.py` via `dispute/service.py`): each issue gets accept / partial / reject with sources (confidence gate **0.55**). Clear issues auto-settle; ambiguous leftovers share **one** desk sign-off; then **one** combined outcome (summed credit or one reply). Agent-core port later.
- **Outcome** (`dispute/outcome.py`): TD04 + INVOIC 381, or evidence reply. Nothing goes to the retailer until the whole pack is settled.
- **Sign-off desk** (`python -m dispute.desk --db …`): list / show / approve / reject pending dispute cases on `core.signoff`. Shared CRM can replace this later.
- **Jury Mini-ERP path:** `python -m dispute.service --db data/demo.sqlite claim.txt --out-dir …` (default **no** fixture merge). Same via `./scripts/run_dispute_claim.sh … --erp-db data/demo.sqlite`.

## Learning beat (hand-off → fewer hand-offs)

1. Ambiguous claim A goes to a person (desk / Sara).
2. Their approve **activates a rule** for that fingerprint **and stores their why** as applicability conditions (e.g. quantities agree, late gate-in / OTIF).
3. Claim B of the same kind closes alone **only if that why still holds** on the new facts; otherwise the rule is skipped and a person is asked again.
4. Shown in `demo.py` (RS26112 → Sara → RS26113) and `tests/test_learning.py` (teaches + reason-applicability).

## Current work (after the pipeline)

1. Prefer Shipping reconcile citations in live verdicts (facts already carry them; learning signature uses them).
2. Keep the desk CLI as the person path until the shared CRM screen is the default demo surface.
3. Use `--erp-db` (no fixtures) for any jury-picked claim against an order already in the Mini ERP.

**Case pack on the desk:** `dispute.desk show` leads with why handed off + briefing + evidence index; `--pack-dir` writes one folder (`README.md`, briefing, evidence, verdict, facts).

Still later / not blocking the demo: quality-lot evidence handoff, shared contract file.

## What I need from others

- Order, DESADV, invoice and signed DDT for any order, from the Mini ERP (core, Shipping)
- The contract (core or me) — dispute-local excerpt is in `data/disputes/contract_excerpt.md` until shared core lands

## What I hand to others

- A verdict per claim: accept, partial or reject, with the amount and a source for every point
- A credit note or a reply to the retailer, saved in the Mini ERP
- Facts with baseline threeway **and** Shipping reconcile causes
- Desk / CRM sign-off path for ambiguous cases

## Open questions

See [MENTOR.md](../MENTOR.md): the sign-off practice in production, how they predict stock, and which claims show up most often.
