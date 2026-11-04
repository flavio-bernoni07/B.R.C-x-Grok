# Grok agent

Design for the **Grok decides** column of the process map, shared by all three rows. Parent index: [DECISIONS.md](DECISIONS.md). Owner: Flavio.

## TL;DR

- **One agent for every lane.** Today each lane calls Grok on its own. Dispute has two copies of `call_grok`, Order has its Grokbot steps, and Shipping has a case package nobody sends. They become one client, one contract and one Playbook.
- **Grok proposes, code checks, a person decides when it is unclear.** Grok never writes an amount or a document. Every number it uses must come from the facts it was given.
- **It learns from every human decision.** Each sign-off is saved with its reason. Similar cases then reuse it as a precedent. When the same decision repeats, it becomes a Playbook rule, after a person approves the rule.
- **The case curve.** Week after week, a smaller share of cases needs a person. The curve flattens at a floor: some cases always need sign-off, such as every Order confirmation and every Shipping exception resolution.
- **Efficiency on top of the loop:**
  - cases that match an approved rule exactly skip the Grok call
  - similar open questions go to a person together
  - the confidence threshold is tuned on real agreement data
  - past cases are replayed before any rule goes live
- **More uses in the CRM**, after the core:
  - first: one inbox that sorts every retailer message, matching payments that arrive with deductions, a short briefing on each case waiting for sign-off, and plain-language questions to the CRM
  - later: the weekly digest, explaining jumps on the dashboard, briefings on retailers, reading new contracts, tidying master data, and "why did it decide that?"

## Where Grok is called

These are the white boxes in the **Grok decides** column of the map, plus the two Grok steps already designed in the lanes.

| Row | Box on the map | Grok gets | Grok proposes | Code checks before anything happens |
|---|---|---|---|---|
| Order | Fix the hard ones: unclear EDI (`parse_flags`) | The EDI segment that failed and the parser's flag | A corrected field, sent back to the parser | The parser must read it cleanly on the second pass |
| Order | Fix the hard ones: stock short (`qty_short`) | The order line, the stock available to promise, the delivery date | A split delivery, a later date, or a negotiation email | Stock covers the split, and the date is in the window |
| Order | Fix the hard ones: price mismatch | The order price, the contract price list, the promo sheet | A draft email to the retailer | No price is changed by Grok |
| Shipping | Explain the flags, and the exception cases | `grok_case_package` (threeway result, shipment, scans, the failed check) | One cause per line with its € share, or a resolution from the allowed actions | `submit_resolution_proposal`: stock, batch, truck, window and approval rules |
| Dispute | Read the claim | The claim email text | Order ref, invoice ref, product, quantity, amount, claim type, confidence | The refs exist in the Mini ERP, or they stay empty |
| Dispute | Verdict + sources | The claim, the facts, the contract excerpt, the Playbook | Accept, partial or reject, with a source for every point | Amounts match the facts and threeway |
| Forecast and quality | Weekly purchasing memo | The buy-or-wait decision and the signals behind it, each with its source | The memo for the buyer | Every number in the memo is one of the facts, otherwise a memo written by code is used |
| Forecast and quality | Lot quality report | Defect percentages, the yield shortfall, the contract price cut, where the lot goes | The lot report | Same number check; the price cut and the allocation are computed by code |

The sign-off rules stay as each lane decided them:
- **Order:** a person always signs before ORDRSP (`order-dec.md`).
- **Shipping:** an employee in the case's role approves every exception resolution.
- **Dispute:** a person signs whenever the case is ambiguous: Grok is unsure, a point has no source, the claim type is not in the Playbook, or a document is missing. There is no euro threshold (DECISIONS.md, 4 Nov).

## One contract for every call

Every lane sends the same kind of request and gets the same kind of answer. The only things that change between lanes are the task name, the facts and the allowed actions.

**Request**, built by code:

```json
{
  "task": "dispute.verdict",
  "case_id": "CASE-00042",
  "facts": [
    {"id": "F1", "kind": "invoice_line", "value": {"qty": 40, "unit_price": 15.5}, "source": "INV-FT-2026-1187"},
    {"id": "F2", "kind": "desadv_line", "value": {"qty": 28}, "source": "DESADV-2026-00481"}
  ],
  "rules": ["R-DSP-007"],
  "precedents": ["CASE-00017", "CASE-00031"],
  "allowed_actions": ["accept", "partial", "reject"],
  "sign_off": "when anything is ambiguous"
}
```

**Answer**, from Grok as JSON:

```json
{
  "action": "partial",
  "params": {"amount_eur": 186.0},
  "citations": ["F1", "F2", "R-DSP-007"],
  "confidence": 0.82,
  "open_questions": [],
  "precedents_used": ["CASE-00017"]
}
```

**Code checks every answer.** The answer is rejected when:
- the JSON does not match the schema
- a number is not in the facts
- a citation does not exist
- the action is not allowed

A rejected answer is sent back to Grok once, with the reason. If it fails again, the case goes to a person.

## When it asks a person

A case goes to the sign-off desk when any of these is true:
- the lane's own rule says so (Order: always; Shipping: every exception resolution). There is no euro threshold
- Grok's confidence is under the threshold for that task (starting at 0.7, then tuned, see below)
- Grok listed an open question
- facts are missing or conflict, for example two invoices match one claim
- there is no rule and no close precedent for this kind of case
- the code rejected Grok's answer twice

The person sees the case, Grok's proposal with its sources, and **the one question that blocks it**. They approve, edit or reject, and **must write one line on why**. That line is what the agent learns from.

## The learning loop

```mermaid
flowchart LR
  newCase[New case] --> rule{Active rule matches exactly?}
  rule -->|yes| apply[Apply the rule, no Grok call]
  rule -->|no| grok[Grok with rules + 3 closest precedents]
  grok --> check[Code checks the answer]
  apply --> gate{Ambiguous, or the lane always asks?}
  check --> gate
  gate -->|no| run[Code runs the action]
  gate -->|yes| human[Person approves, edits or rejects, with a reason]
  human --> run
  run --> closed[Ticket closed, outcome recorded]
  closed --> log[(Case log)]
  human --> log
  log --> promote{Same decision 3 times, never overturned?}
  promote -->|yes| draft[Grok drafts a rule, a person approves it]
  draft --> playbook[(Playbook)]
  playbook --> rule
  playbook --> grok
```

How it works:

1. **Before deciding**, the agent loads:
   - the active Playbook rules for the task
   - the three most similar past cases, matched on task, case type, retailer, product, threeway reason, amount band and which documents exist
2. **Grok decides** and cites the rules and precedents it used.
3. **A person resolves** the unclear cases. The decision and its reason go into the case log.
4. **The ticket closes**, and the outcome is recorded:
   - credit note accepted
   - claim not reopened within 30 days
   - payment received in full

   So the log knows whether the decision held, not only whether a person liked it.
5. **Promotion.** When the same kind of case got the same decision three times and was never overturned, Grok drafts a rule. A person approves it before it goes live; Playbook changes always need a person. From then on that kind of case is decided by the rule.
6. **Demotion.** If a rule's decision is later edited by a person, or its outcome goes bad (the claim is reopened), the rule goes back to draft. Its cases go to a person again until it is fixed.

**The case curve.** Two numbers per week, drawn as a chart:
- **share of cases that needed a person:** falls, then flattens at the floor of cases that always need sign-off
- **share of Grok proposals the person approved without edits:** rises

On Order every case is signed, so there the second number is the one that shows learning.

## Making it more efficient

Beyond the loop itself:

1. **Skip Grok when a rule matches.** An exact match on an active rule is decided by code, with the rule as the citation. It is faster, costs nothing and gives the same answer every time.
2. **Tune the threshold per task from the log.** For each task, set the confidence threshold so that decisions taken without a person agree with people at least 95% of the time. Extraction and verdicts get different thresholds.
3. **Group similar questions.** "These 6 Esselunga short-payment claims under €50 all lack a DDT: accept all?" One answer from a person teaches the agent six cases.
4. **Ask the most useful question first.** The sign-off queue is ordered by how many open cases share the pattern, not by arrival time.
5. **Replay before a rule goes live.** Every new or changed rule is run against all past cases first. If it would flip a decision a person approved, it is flagged instead of activated. The same replay produces the case curve for the demo.
6. **Learn from outcomes, not only from people.** Reopened claims, rejected credit notes and short payments count against the decision that caused them.
7. **One client, used everywhere:**
   - JSON output with a schema
   - one retry that carries the code's error message
   - a model per task (a fast one for reading claims, the strongest for verdicts), set by `XAI_MODEL_<TASK>`
   - the Playbook as a fixed prompt prefix, so repeated calls can be cached

## More uses in the CRM

These go beyond the boxes on the map, with the same contract and checks.

**First, after the core build:**

1. **One inbox that sorts everything.** Retailers send claims, order changes, delivery-slot moves, promo notices, payment advices and questions. Grok reads each incoming email or PDF and routes it:
   - claims to Dispute
   - order changes to Order
   - slot changes to Shipping
   - promos to the demand calendar

   Code checks that the references exist, and anything unclear goes to a person. Today only claims have a reader.
2. **Payments with deductions.** Supermarkets often pay less than the invoice and send a messy remittance advice ("−€186 shortage, −€90 promo contribution").
   - Grok extracts each line: invoice reference, amount, reason code.
   - Code matches the lines to open invoices.
   - A deduction nobody can explain opens a dispute on its own.

   This joins the Shipping and Dispute rows.
3. **Case briefing on the sign-off desk.** Each waiting case gets three lines: what happened, what Grok proposes, and the one question that blocks it, with links to the documents. People decide faster, which speeds up the case curve.
4. **Ask the CRM in plain words.** For example: "Which Esselunga orders for next week are at risk?" or "Show every claim on lot 17." Grok writes a read-only query on a fixed set of views. Code runs it, and the answer links to the records.

**Later, if there is time:**

5. **Weekly digest.** This is the "Accountant, managers" box on the map. Code computes the totals, open problems and credit notes issued; Grok writes the summary, citing them.
6. **Explaining a jump on the dashboard.** Code spots a jump, for example claims at Coop up 30%. Grok looks at the linked records for the likely cause (one batch, one truck, a new price list) and shows it as a hint with its sources, never as a fact.
7. **Retailer briefing for the sales team.** One page before a call: on-time deliveries, open claims, deductions, trend. Numbers from code, text from Grok.
8. **Reading new contracts and promo sheets.** Grok turns clauses and prices into draft rules. A person approves them, and Order's price check and Dispute's verdict then use them.
9. **Tidying master data.** Grok matches messy store names, store codes and reference variants to the right records, and a person confirms each match.
10. **"Why did it decide that?"** For any decision, the trail of facts, rule, precedent and who signed. The same view answers new staff questions straight from the Playbook ("how do we handle a damaged pallet?").

**Never:** Grok does not send anything to a retailer by itself, change a price or an amount, or close a case without code checking it.

## Where things live

| Thing | Where | Notes |
|---|---|---|
| Grok client | `agent/grok.py` | Replaces the two `call_grok` copies in `dispute/`. Reads `XAI_API_KEY` or `GROK_API_KEY`, plus `XAI_BASE_URL` and `XAI_MODEL`, as they work today |
| Contract and checks | `agent/contract.py` | The request and answer schemas, the number check, the citation check |
| Case log | `agent_cases` table in the Mini ERP SQLite | Case, facts, proposal, confidence, why a person was asked, their decision, their reason, outcome, rules and precedents used |
| Rules | `playbook_rules` table | Pattern, action, status (`draft`, `active`, `retired`), how many cases support it, who approved it, last time overturned |
| Playbook for people and for Grok | `data/playbook/<lane>.md`, generated from the rules table | Same layout as today's `data/disputes/playbook.md`, which moves there with the Dispute owner's OK |
| Replay and case curve | `agent/replay.py` | Runs past cases in order, with a scripted "person", and draws the weekly chart |

## Demo, about 20 seconds

1. **The chart.** Replay 60 invented cases over 6 weeks. The share needing a person drops, for example from about 70% to about 20% (the real numbers come from the replay).
2. **One live case.** An unclear claim goes to the sign-off desk, and the person decides with a reason. The next claim of the same kind is resolved on its own, citing that case as its precedent.

## Build plan, about 10 hours

| # | Step | Done when | Hours |
|---|---|---|---|
| 1 | Shared client and contract, and move `dispute/claim_reader.py` and `dispute/verdict.py` onto it | Dispute tests still pass with one client | 1.5 |
| 2 | Case log and rules tables, and the Playbook generator | A sign-off writes a case, and the Playbook file updates | 1.5 |
| 3 | Rule match and precedent search | An exact match skips Grok; otherwise the 3 closest cases go into the prompt | 1.5 |
| 4 | The ask-a-person gate, with a mandatory reason | Every trigger above sends the case to the desk | 1 |
| 5 | Promotion and demotion | 3 matching decisions give a draft rule; an overturned rule goes back to draft | 1 |
| 6 | Replay and case curve | The chart for 60 cases over 6 weeks | 2 |
| 7 | Wire in the call sites, one call per lane owner: Order (3), Shipping (1), Dispute (2) | Every white box on the map goes through the agent | 2 |

**CRM uses, after the core, about 7 hours:**

| # | Step | Done when | Hours |
|---|---|---|---|
| 8 | Inbox router | Ten sample messages of different kinds each land in the right lane, and unclear ones go to a person | 2 |
| 9 | Payments with deductions | A remittance advice is matched to open invoices, and an unexplained deduction opens a dispute | 2.5 |
| 10 | Case briefing | Every case on the sign-off desk shows its three lines with links | 1 |
| 11 | Ask the CRM | Five demo questions answered from read-only views, each answer linking to its records | 1.5 |

## Built (4 Nov evening)

- `agent/grok.py`: the one client (step 1). Dispute uses it; Order's Grokbot, Shipping's case proposals and flag explanations use it too.
- `agent/learning.py`: case log, precedents, rules, promotion and demotion (steps 2, 3 and 5). The Dispute row logs every decision; an active rule decides with no Grok call; otherwise the three closest past cases go into Grok's prompt. A rule is drafted after the same decision three times on the same kind of case, none overturned, and decides nothing until a person approves it. Overturning a rule's decision sends it back to draft.
- The ask-a-person gate (step 4) is the no-euro-threshold rule from DECISIONS.md: a person decides when anything is ambiguous. "No rule and no close precedent yet" does not send a case to a person on its own; precedents and rules make Grok faster and surer instead.
- `agent/replay.py`: the case curve (step 6). Average of 20 replays of 60 invented claims, with a scripted Grok and a scripted person, through the real loop: a person decided 80% of cases in week 1 and 16% in week 6; learned rules decided 8 of 10 cases by week 4, with no Grok call. Chart: `docs/img/case-curve.svg`.

![Case curve](docs/img/case-curve.svg)

## Open questions

- Which Grok models and keys the hackathon gives us, and the rate limits
- Who builds the sign-off page that all lanes share
- The starting confidence threshold for each task (0.7 until we have data)
