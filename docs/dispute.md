# Dispute

**Owner:** carlojolly / Dispute
**Boxes on the map:** Claim email, Read the claim, Pull the facts, Verdict + sources, Credit note or reply

## Starting points

- Claim emails are generated with Grok (the brief gives no real ones). The brief's minimum demo names partial delivery, price difference and contested goods; a short payment (the retailer pays less than the invoice) is the other common case.
- [CUAD](https://github.com/TheAtticusProject/cuad): about 510 real US commercial contracts, annotated by lawyers in 41 clause types. Use it to write one synthetic supply contract between Riso Scotti and a retailer: complaint deadline, delivery tolerance, penalties, promo pricing. The contracts are American and not about food, so adapt them.
- Credit note: FatturaPA document type `TD04`. The EDI version is an INVOIC with `BGM` code 381.
- Evidence for a verdict: the order, the DESADV, the invoice, the threeway result, the signed DDT, the contract clause.
- The jury checks that disputes are resolved "with the right evidence" and that every action traces back to a source document, so every point of a verdict needs a citation.

## What I found

## What I decided

- First dispute-owned slice is the **claim reader** (`dispute/claim_reader.py`): Grok extracts `order_ref`, `invoice_ref`, `product`, `quantity`, `amount`, `claim_type`, `confidence`, `raw_notes` from plain-text claim emails. Missing refs stay `null`/`None` (never invented). Live calls need `XAI_API_KEY` or `GROK_API_KEY`; see `dispute/README.md`.
- Demo claim emails live under `data/disputes/claims/` (shortage, pricing, damage, incomplete short payment, one ambiguous OTIF/shortage).
- Second slice is **Pull the facts** (`dispute/pull_facts.py` + `dispute/mini_erp.py`): resolve order / DESADV / invoice / proof stubs from mock Mini ERP fixtures (`data/disputes/erp/catalog.json`), then run three-way matching. Matcher is **vendored** from [Bhavya-Dhoot/threeway](https://github.com/Bhavya-Dhoot/threeway) (`dispute/_threeway_core.py`, MIT) — join on order+item, tolerate tiny qty/€ diffs, one reason per flagged line. Hand-written extraction JSON under `data/disputes/extractions/` lets you run without Grok.
- Third slice is **Verdict + sources** (`dispute/verdict.py`): Grok reads the Playbook (`data/disputes/playbook.md`) plus claim + facts + contract excerpt (`data/disputes/contract_excerpt.md`) and proposes `accept` | `partial` | `reject` with per-point citations. Code validates amounts against claim/facts/threeway (no invented totals). TD04 / credit-note generation and the sign-off UI are still out of scope.

## What I need from others

- Order, DESADV, invoice, threeway result and signed DDT for any order, from the Mini ERP (core, Shipping and invoicing)
- The contract (core or me) — dispute-local excerpt is in `data/disputes/contract_excerpt.md` until shared core lands

## What I hand to others

- A verdict per claim: accept, partial or reject, with the amount and a source for every point
- A credit note or a reply to the retailer, saved in the Mini ERP
- Structured claim extraction from the claim reader (input for Pull the facts)
- A facts object per claim: linked order/DESADV/invoice, threeway lines+reasons, proof refs, lookup misses (input for Verdict)

## Open questions
