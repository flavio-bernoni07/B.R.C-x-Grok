# Dispute

**Owner:**
**Boxes on the map:** Claim email, Read the claim, Pull the facts, Verdict + sources, Credit note or reply

## Starting points

- Claim emails are generated with Grok (the brief gives no real ones). The brief's minimum demo names partial delivery, price difference and contested goods; a short payment (the retailer pays less than the invoice) is the other common case.
- [CUAD](https://github.com/TheAtticusProject/cuad): about 510 real US commercial contracts, annotated by lawyers in 41 clause types. Use it to write one synthetic supply contract between Riso Scotti and a retailer: complaint deadline, delivery tolerance, penalties, promo pricing. The contracts are American and not about food, so adapt them.
- Credit note: FatturaPA document type `TD04`. The EDI version is an INVOIC with `BGM` code 381.
- Evidence for a verdict: the order, the DESADV, the invoice, the threeway result, the signed DDT, the contract clause.
- The jury checks that disputes are resolved "with the right evidence" and that every action traces back to a source document, so every point of a verdict needs a citation.

## What I found

## What I decided

## What I need from others

- Order, DESADV, invoice, threeway result and signed DDT for any order, from the Mini ERP (core, Shipping and invoicing)
- The contract (core or me)

## What I hand to others

- A verdict per claim: accept, partial or reject, with the amount and a source for every point
- A credit note or a reply to the retailer, saved in the Mini ERP

## Open questions
