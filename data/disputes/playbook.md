# Dispute Playbook — Riso Scotti (demo)

Grok **must read this Playbook before proposing a verdict**. Rules below are the
working set for the hackathon demo. Amounts always come from documents / threeway /
the claim — never invent euro totals.

## Sign-off thresholds (placeholders)

- Auto-propose without human sign-off when **amount ≤ €500**, confidence is high,
  every point has a source, and the claim type is covered below.
- Escalate to a person when: amount **> €500**, Grok is unsure, a point has **no
  source**, or the case type is **not in this Playbook**.

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
- If claim type is unclear or docs are missing → **reject** or escalate (unsure),
  list lookup misses, ask for clearer refs. Do not invent order/invoice numbers.

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
| — | — | — | — | — | No past cases yet |
