# Integration notes (customer dispute portal)

There is no separate INTEGRATION.md at the repo root; contracts live in `PORTING.md`, `DECISIONS.md` and `dispute-dec.md`. This file documents the **customer-facing dispute chat** added for the hackathon.

## What it reuses

| Existing piece | How the portal uses it |
|---|---|
| Mini ERP `claims` + `signoffs` | Portal disputes are `claims` with id `DSP-…`; Actions cases are `signoffs` with `row=dispute`, `kind=customer_dispute` |
| `pullFacts` / threeway | Read-only evidence for the employee workspace |
| `chatJson` / Grok client | Intake classification when `XAI_API_KEY` is set; otherwise deterministic offline intake |
| Retailers master data | Simulated session binds to a retailer GLN (`BUYER001` = Esselunga) |
| Actions page | New **Disputes** tab + dispute workspace |

## What is new (same SQLite file)

- `portal_conversations`, `portal_messages`, `notifications`
- Routes under `/api/portal/*` and `/api/actions/disputes`
- UI at `/portal` (customer) and Actions → Disputes (employee)

## Auth

**Simulated only.** Cookie `brc_portal_retailer` + banner label. Not a production customer portal.

## Safety

The portal **never** emits TD04, refunds or invoice changes. Employees investigate / ask for evidence / close without credit from the Disputes workspace.
