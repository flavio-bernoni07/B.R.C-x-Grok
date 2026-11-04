# Dispute decisions (subdocument of [DECISIONS.md](DECISIONS.md))

Design / procedere della riga **Dispute**, allineato a [dispute/README.md](dispute/README.md), [docs/dispute.md](docs/dispute.md) e al codice in `dispute/`.

Parent index: [DECISIONS.md](DECISIONS.md). Stile schemino: come [order-dec.md](order-dec.md).

## Scope

Solo la riga **Dispute**: Claim email → Read the claim → Pull the facts → Verdict + sources → (sign-off se serve) → Credit note **oppure** evidence reply.

**Pipeline: done.** Fuori scope ancora: Sign-off **web** UI condivisa (c’è il desk CLI `python -m dispute.desk`); nuova fattura di ricarico (vietata). La mappa HTML “>€500” è **obsoleta** — nessuna soglia in euro (4 Nov).

## Pipeline (come Order)

```mermaid
flowchart TD
  inClaim[Claim_email_or_short_payment] --> reader[Grok_claim_reader]
  reader -->|ClaimExtraction_JSON| facts[Pull_facts_code]
  facts --> erp[Mini_ERP_lookup]
  erp --> threeway[Baseline_threeway]
  erp --> reconcile[Shipping_reconcile]
  threeway --> factsOut[DisputeFacts]
  reconcile --> factsOut
  factsOut --> verdict[Grok_verdict_plus_Playbook]
  verdict -->|accept_partial_reject_plus_sources| gate{needs_sign_off}
  gate -->|no_auto| outcome[Outcome_code]
  gate -->|yes_person| signoff[Human_signoff_desk]
  signoff --> outcome
  outcome -->|accept_or_partial| credit[TD04_plus_INVOIC_381]
  outcome -->|reject| reply[Evidence_reply]
  credit --> saved[Saved_in_outcomes_MiniERP]
  reply --> saved
```

## Step by step

### 1. In — Claim email

- Arriva una mail/contestazione retailer (o testo di short payment).
- Tipi demo: shortage, pricing/promo, damage, short payment, late/OTIF, ambiguous.
- Fixture: `data/disputes/claims/`.

### 2. Read the claim — `claim_reader.py` (Grok)

- Estrae JSON strutturato: `order_ref`, `invoice_ref`, `product`, `quantity`, `amount`, `claim_type`, `confidence`, `raw_notes`.
- **Non inventa** ref mancanti → `null`.
- Live: `XAI_API_KEY` / `GROK_API_KEY`. Dry-run / extraction JSON a mano per test senza API.
- Output salvabile sotto `data/disputes/extractions/`.

### 3. Pull the facts — `pull_facts.py` + `mini_erp.py` (codice)

- Risolve ordine / DESADV / invoice / proofs dal Mini ERP esportato da Shipping e/o dal catalog mock (`data/disputes/erp/catalog.json`).
- Esegue **baseline threeway** (vendored `dispute/_threeway_core.py`) **e** `shipping.reconcile.reconcile_documents` (stesso codice del bench).
- Produce `DisputeFacts`: claim + docs + `threeway` + `reconcile` (status, causes, explanation) + `misses`.
- Path jury: `handle_claim(..., include_fixtures=False)` / `python -m dispute.service --db …` / `run_dispute_claim.sh --erp-db …`.

### 4. Verdict + sources — `verdict.py` (Grok)

- Legge **Playbook** + **contract excerpt** + claim + facts.
- Decide `accept` | `partial` | `reject` con `points[]` ciascuno con **source** (preferire `reconcile` + cause code quando presente).
- Importi solo da claim / docs / threeway / reconcile eur — codice clampa/droppa euro inventati.
- `needs_sign_off`: **nessuna soglia in euro**. True se qualcosa è ambiguo: Grok unsure o confidence < **0.55**, un punto senza source, tipo fuori Playbook (`other`), claim letto con confidence < 0.55, documento non trovato, importo non presente nei documenti.

### 5. Sign-off (condizionale) + learning

- Se `needs_sign_off` → persona approva/modifica; caso approvato entra nel Playbook “past cases”.
- **`approve_verdict` attiva una regola** sul fingerprint (`activate_from_person`) **e salva il perché** come condizioni di applicabilità. Il prossimo claim dello stesso tipo chiude da solo **solo se quel perché vale ancora** sui nuovi fatti; altrimenti la regola si salta e si chiede di nuovo una persona (demo: RS26112 → Sara → RS26113).
- Desk CLI: `python -m dispute.desk --db data/demo.sqlite list|show|approve|reject`.
- Finché una persona non approva, niente TD04/reply (`awaiting_sign_off`). Web UI CRM: ancora da fare; il desk usa la stessa coda.

### 6. Out — `outcome.py` (codice)

- **accept / partial** → FatturaPA **TD04** (`a38`) + EDI INVOIC hint `BGM+381`.
- **reject** → reply con evidenze (incluso `reconcile` causes).
- Mai una nuova invoice di addebito.
- Output: `data/disputes/outcomes/` + Mini ERP documents.

## Lavoro corrente (dopo la pipeline)

1. Citare Shipping reconcile nei verdict live (i facts già lo espongono).
2. Desk CLI come superficie persona fino al CRM condiviso.
3. Path `--erp-db` senza fixtures per claim scelti dalla giuria.

## Regole fissate

- Grok decide e spiega; **il codice scrive** i documenti e gli importi finali.
- Ogni punto del verdict ha una **source** tracciabile.
- Threeway baseline + Shipping reconcile girano dentro Dispute.
- Fine disputa = TD04/credit **o** evidence reply.

## Cosa Dispute chiede / dà agli altri

| Direzione | Cosa |
|---|---|
| Da Core / Shipping | Order, DESADV, invoice, DDT/POD, stock events nel Mini ERP |
| Da Forecast/quality | record qualità lotto come prova “contested goods” (non ancora cablato) |
| A Core / retailer | verdict + credit note o reply salvati |
| Interno Order | nessun handoff diretto; Dispute parte dal claim post-fattura |

## Non in questo documento

- UI web di sign-off (CRM).
- Handoff qualità lotto / Forecast.
