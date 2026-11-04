# Dispute Playbook — Riso Scotti (demo)

Grok **must read this Playbook before proposing a verdict**. Rules below are the
working set for the hackathon demo. Amounts always come from documents / threeway /
the claim — never invent euro totals.

## When a person signs off

There is **no euro threshold**. A clear case goes out on its own, whatever the amount.
If anything is ambiguous, a person always decides. Set `needs_sign_off` to true when:

- you are unsure, or your confidence is under 0.55
- a point has **no source**
- the claim type is **not covered below** (`other`)
- the claim was hard to read, or an order, DESADV or invoice could not be found
- an amount cannot be tied to the claim, the documents or threeway
- the documents disagree in a way these rules do not settle

Code checks the same list and sends the case to a person even if you say false.

## Claim-type rules

### Shortage / OSD
- Prefer DESADV shipped qty + signed DDT/POD + warehouse pick events over retailer
  receiving counts alone.
- If threeway shows invoiced > received (DESADV/POD) → lean **accept** (or partial)
  for the over-billed qty × PO unit price, citing threeway + DESADV/DDT.
- If order = DESADV = invoice = POD and retailer claims shortage → lean **reject**
  with evidence pack (likely retailer receiving error).

### Pricing / promo
- Compare invoice unit price to PO / contract / promo sheet.
- If invoice price > contracted promo price and qty matches → **accept** credit for
  `(invoice_price − promo_price) × qty`, citing contract excerpt + invoice + PO.
- Do not invent promo prices; only use figures present in facts / contract fixture.

### Damage
- Qty/price threeway may be **matched**; damage is proven by DDT annotation, photos,
  warehouse notes.
- **Accept** (or partial) only for damaged qty × PO unit price when a signed DDT /
  photo / portal ref supports damage. Cite those proofs.

### Late delivery / OTIF
- Use booked slot vs gate-in / DESADV arrival. Cite warehouse/gate events.
- Commercial penalty amounts only if present in contract excerpt; otherwise propose
  decision text without inventing a euro figure (`amount` null on that point).

### Other / ambiguous
- If claim type is unclear or docs are missing → always escalate to a person
  (`needs_sign_off` true). Propose reject or ask for clearer refs, list the lookup
  misses. Do not invent order/invoice numbers.

## Hard constraints

1. Decision is one of: `accept` | `partial` | `reject`.
2. Every verdict **point** needs a **source** (document id, DESADV, DDT/POD,
   threeway flag, contract clause, warehouse event, or Playbook rule id).
3. Credit note / TD04 is out of band — this Playbook only decides; code emits docs later.
4. Dispute ends in credit note **or** evidence reply — never a new invoice.

## Past cases (sign-off → Playbook)

<!-- Human-approved cases land here after sign-off. Empty for now. -->

| Date | Order | Type | Decision | Amount € | Notes |
|------|-------|------|----------|----------|-------|
| 2026-11-04 | ESS-AMB-001 | damage | accept (approved) | 444.00 | Sara, credit desk: Crushed pallet is on the signed DDT and the RECADV |