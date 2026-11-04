# Reconciliation against the threeway baseline

21 labelled cases in `data/bench/cases.json`. Run `python -m bench.score` to reproduce.

| | threeway | ours |
|---|---|---|
| Right call on whether someone must act | 13/21 | 21/21 |
| Every cause named, nothing extra | 10/21 | 21/21 |

| Case | What happened | Right answer | threeway | ours |
|---|---|---|---|---|
| C01 | 40 cartons ordered, shipped and invoiced at the order price | ok | ok | ok |
| C02 | two lines, both shipped and invoiced as ordered | ok | ok | ok |
| C03 | 12,000 packs at the volume price | ok | ok | ok |
| C04 | 80 cartons in two despatches of 50 and 30, one invoice | ok | ok | ok |
| C05 | two despatches and two invoices that add up | ok | ok | ok |
| C06 | 28 of 40 cartons shipped, 28 invoiced: Riso Scotti still owes 12 | act: short_delivery | ok ✗ | act: short_delivery |
| C07 | 10,800 of 12,000 packs shipped after a quality hold, 10,800 invoiced | act: short_delivery | ok ✗ | act: short_delivery |
| C08 | one of two lines short, invoiced as shipped | act: short_delivery | ok ✗ | act: short_delivery |
| C09 | 40 shipped, 45 invoiced | act: overbilled | act: overbilled | act: overbilled |
| C10 | 28 of 40 shipped but the invoice bills the 40 ordered (like RS-2026-00481) | act: overbilled, short_delivery | act: overbilled ✗ | act: overbilled, short_delivery |
| C11 | promo price 1.49 on the order, list price 1.85 on the invoice (like PO77821) | act: price_difference | act: price_difference | act: price_difference |
| C12 | carton price 15.50 ordered, 16.20 invoiced | act: price_difference | act: price_difference | act: price_difference |
| C13 | 10 packs too many invoiced, and at the list price instead of the promo | act: overbilled, price_difference | act: overbilled ✗ | act: overbilled, price_difference |
| C14 | short shipment invoiced for the right quantity but at the wrong price | act: price_difference, short_delivery | act: short_delivery ✗ | act: price_difference, short_delivery |
| C15 | DESADV and invoice carry RS-2026-0O481 (letter O) for order RS-2026-00481 | ok | act: not_shipped, orphan_invoice ✗ | ok |
| C16 | the invoice writes RS2026 00482 for RS-2026-00482 | ok | act: orphan_invoice, price_difference ✗ | ok |
| C17 | the invoice writes CAR1KGCTN12 for CAR-1KG-CTN12 | ok | act: orphan_invoice, price_difference ✗ | ok |
| C18 | ordered and shipped as 40 cartons, invoiced as 480 packs at the per-pack price | ok | act: uom_unknown ✗ | ok |
| C19 | an invoice line for an order that does not exist | act: orphan_invoice | act: orphan_invoice | act: orphan_invoice |
| C20 | 46 cartons shipped and invoiced against 40 ordered | act: over_delivery | ok ✗ | act: over_delivery |
| C21 | 39 of 40 shipped and invoiced: inside the contract's 2-unit tolerance | ok | ok | ok |

How to read this: we wrote these cases and their answers ourselves, before running either matcher, to cover the blind spots we found in threeway's code. A full score on our own set shows those blind spots are handled; it is not a measure of accuracy on documents we have not seen. threeway runs with its default settings: it can convert units if it is given a conversion map, which the baseline does not have.
