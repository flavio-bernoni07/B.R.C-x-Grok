You are the coding agent working on the B.R.C x Grok repository (Grok Hackathon Pavia 2026, Track B, Riso Scotti), in the `agent-core` Next.js app. Your job is to turn the app into an autonomous operations workspace where Grok agents do the work at every step and a person approves only what needs a person. Read this whole prompt before starting, then build it. Do not stop at a plan or a mockup.

# Why

Today the app reads like a normal CRM: tables of orders, shipments and claims. For the pitch, the jury has to see what is new:

- Grok agents run the workflow at every step, and deterministic code checks everything they do.
- People step in only when it matters, with one clear approval and a written reason. Their decision becomes an example Grok learns from.
- It is faster, cheaper and makes fewer errors, and every claim to that comes with a number, a source and a baseline.

A non-technical employee should understand it in minutes. Build every screen around three questions: What is happening? Is anything wrong? Do I need to do anything?

# Ground rules

- Inspect first. Read AGENTS.md, `agent-core/PORTING.md`, `agent/lib/` and the Python reference (`core/`, `shipping/`, `finance/`, `crm/`, `forecast_quality/`, `agent/learning.py`). There is no INTEGRATION.md in this repo; these files are the contracts.
- One source of truth. Reuse the existing libs and the one SQLite Mini ERP. Do not rebuild working parts, do not add a second stock ledger or database, do not overwrite teammates' code. Port missing Python pieces one to one, with a parity test, as PORTING.md says.
- Every number has a source (order, invoice, shipment, batch, document or audit event). Forecasts, suggestions and estimates are labelled as such, with their assumptions. Never invent data; if the backend has no record, say so.
- Honest states. Never show "AI active" unless a call is actually running. If Grok is unavailable, say so and keep working with the deterministic checks. Simulated data (demo fixtures, recorded answers) is visibly marked.
- Grok never writes to the database or writes SQL. It reads through tools, proposes, and acts only through validated, audited backend commands. Code checks every figure it uses against the data.
- A person signs every paddy purchase and every ORDRSP (unless the team switches the policy below). Nothing is sent, bought or dispatched without the required approval.
- Plain-language labels and messages, no error codes, no em dashes. Minimal colour, used only for status. Lots of white space, compact tables and cards, expandable details instead of crowded screens, no decorative charts or animations. Desktop first.
- Write each feature once in `agent/lib/` and expose it three ways: agent tool, API route and component.

# 1. Navigation: four sections only

1. Home: the AI command center, chat first.
2. Orders: an email-style inbox, with one workspace per order.
3. Operations, with three tabs: Inventory & Forecast, Warehouse & Shipping, Finance & Documents.
4. Actions: the AI resolution inbox (the sign-off desk).

Move today's pages into these: Overview into Home; Sign-off and Disputes cases into Actions (and into each order's history); Stock and Paddy prices into Inventory & Forecast; Shipping into Warehouse & Shipping. Search by order, retailer, invoice or truck is available everywhere.

# 2. Home: AI command center

The chat is the most prominent thing on the page.

- Title "Ask anything about your operations", one large input with the placeholder "Ask about orders, stock, shipments, invoices, or what needs attention...".
- Four example questions that fill and send on click: "Which orders need attention today?", "Will we have enough Carnaroli stock next week?", "Why is order ESS-AMB-001 delayed?", "Which invoices have discrepancies?".
- Answers are short and plain. Every operational claim links to its order, invoice, shipment or case. Keep confirmed facts, forecasts, suggestions and missing information apart. Ask for clarification when a reference is ambiguous. Say "unknown" instead of inventing, for example a production date.
- The chat can also act: "prepare a truck assignment", "what if we move these pallets to Truck 03?", "prepare a reply to this claim". It inspects records, prepares a proposal and shows a before/after preview. Any change of state goes through the same validated command and the same approval rules as the pages, with the user's role checked, and the answer shows the real execution result. The chat never bypasses inventory, quality, finance or dispatch controls.

Below the chat:

- Four numbers, all from records: active orders, orders running automatically, orders needing a person, deliveries at risk.
- One line on what Grok did this week (steps handled by agents against steps by people, fuel saved, errors caught, rules learned), linking to the impact detail (section 7).
- "Needs your attention": only real decisions. Each card shows the problem in one line, the order, the business impact, the proposed next step, the responsible role, and one button "Review action".
- "Recently completed": a short, quiet list of finished automatic work ("ESS-GOLD-001 dispatched on TRUCK-PV-01", "FT-2026/0001 reconciled"). Only real or clearly simulated events, never a wall of logs.

# 3. Orders: email-style inbox

List. Each row reads like an email:

- retailer and order ID;
- a one-line description ("Carnaroli 1 kg · 12,000 units");
- a plain status line written by code, or by Grok with checked figures ("1,200 units on quality hold, shipped 10,800");
- the delivery date;
- a status pill: Needs attention, On track, Waiting for retailer, Completed;
- small badges for the agents that worked on it.

Filters: All, Needs attention, In progress, Completed, plus search. Attention items come first, but nothing is hidden.

Order workspace, opened on click, with an email-like reading experience:

- Top: retailer, order ID, delivery target, status in plain words, the most important next step, and the counter "Grok did 14 steps, you approved 1" (counted from the audit log by actor).
- Journey: Received → Confirmed → Reserved → Planned → Picked → Loaded → Dispatched → Invoiced → Received by retailer → Paid, plus Claim when there is one. Each step shows who did it (an agent, code, or a named person), when, and its document. Partial and multiple shipments, and receipt or payment arriving out of order, must work. This is `core/trace.py`, drawn.
- Summary: confirmed, reserved, shipped and remaining quantity, money at stake, next expected event.
- Collapsible sections:
  - Order details: original and approved versions, anything Grok changed (before → after, with the reason), prices, delivery commitments.
  - Inventory: availability, reservation, batches, quality holds.
  - Shipping: truck, other stops, manifest, scans, dispatch, DDT, DESADV.
  - Finance: invoice, FatturaPA XML, INVOIC, RECADV, payments, deductions, reconciliation.
  - History: events, discrepancies, agent proposals, approvals with reasons, audit.
- Exceptions show a short highlighted explanation and one button "Review proposed resolution".
- "Ask about this order" opens the Home chat with the order ID as context.

# 4. Actions: AI resolution inbox

Same inbox style. Only cases that need investigation, correction or approval. Each row shows the problem, order, role, urgency, money at stake where it can be calculated, and status.

An opened case shows, in this order:

1. What happened.
2. Why it matters.
3. Supporting evidence, with links.
4. Grok's proposed solution, shown first.
5. Alternatives.
6. The feasibility check results from code.
7. A before/after preview.
8. The decision needed: Approve, Reject or Request clarification, with a one-line reason.
9. Execution and audit history.

Approving calls the validated backend command and shows the real result. Never assume that pressing Approve means it worked.

The "Ready to ship" card is the heart of the demo. For each order the agents do everything up to the truck: parse and fix the order, check stock, price and quality, reserve the stock, plan the truck and route (section 5B), and draft the ORDRSP, pallet list and documents. Then one card shows all of it: what Grok changed and why, the checks passed, the draft ORDRSP, the truck and its stops with km, fuel € and CO2 against "one truck per order", and the one open question if there is one. One approval sends the ORDRSP and locks the plan; DESADV and DDT follow at dispatch.

Add a policy setting `order_confirmation: always_person | auto_when_clean`. The default is `always_person` (the Order team's rule); with `auto_when_clean`, a clean order goes through with no person and only unclear ones get the card.

# 5. Operations

## A. Inventory & Forecast

Show stock by product and batch: physical on hand, quality held, reserved (confirmed and not shipped), available to promise, dispatched or in transit, planned production.

Stock rules. Check that the port follows them, and test them:

- Receiving an order deducts nothing.
- An approved order reserves stock: available-to-promise goes down, physical stock does not.
- Planning, picking and loading deduct nothing.
- A verified dispatch consumes the reservation, lowers physical stock and moves the goods to in transit.
- Cancelling before dispatch releases the reservation.
- Held stock never becomes available automatically.
- Every movement records product, batch, order, time and source event.

Forecast: historical demand, confirmed future orders and estimated future demand, kept apart and never double-counted; planned production; projected availability per week; shortage risks. Port the demand forecast from `forecast_quality/demand.py` (labelled as an estimate, built on invented history) with a parity test. A projected shortage creates a proposed action ("review production", "evaluate a partial delivery"), never a production change.

Purchasing agent, "Paddy to buy": per paddy variety, buy now or wait, and how many tonnes to buy from farmers, based on confirmed orders, the demand forecast, the Prophet price forecast and supply.

- New, demo data: `data/world/paddy.json`, per variety: tonnes in silos, tonnes contracted but not delivered, `as_of`.
- New, demo data: product to variety and net rice kg per unit:
  - ARB-1KG and ARB-VAC-1KG: Arborio, 1.0
  - ARB-1KG-CTN12: Arborio, 12.0
  - CAR-1KG: Carnaroli, 1.0
  - CAR-1KG-CTN12: Carnaroli, 12.0
  - RSP-FUNGHI-210: Arborio, 0.18
  - BAS-500G: Basmati, imported, so it is excluded and shown as such.
- Price: `getPriceForecast(variety, 8)`, using `last_price`, `forecast_end`, `backtest.prophet_beats_naive`, the MAPEs and the sources.
- Two different 70% figures; do not mix them up: `FARMER_SHARE = 0.70` is the share of paddy bought from farmers (from Flavio, to confirm with the mentor); `MILLING_YIELD = 0.70` is tonnes of milled rice per tonne of paddy (demo value).

Calculation, horizon H = 8 weeks:

    need_milled_t = max(0, confirmed_not_shipped_t + forecast_t − finished_released_t − finished_planned_t)
    need_paddy_t  = need_milled_t / MILLING_YIELD
    weekly_use_t  = need_paddy_t / H
    on_hand_t     = silo_t + contracted_not_delivered_t
    cover_weeks   = on_hand_t / weekly_use_t
    target_weeks  = 16 if BUY NOW, 8 if WAIT, 12 otherwise
    suggested_t   = FARMER_SHARE × max(0, target_weeks × weekly_use_t − on_hand_t)
    spend_eur     = suggested_t × last_price

The call:

- If the model does not beat naive in its backtest: BUY AS USUAL, labelled "low confidence: the model does not beat 'price stays the same'".
- Otherwise: change above +2% means BUY NOW; change below −2% means WAIT; anything else means BUY AS USUAL.
- Weekly use of 0 means nothing to buy.

Worked example for the unit test: need_milled 70 t, so need_paddy 100 t and weekly use 12.5 t; on hand 60 t; last price €672/t. BUY NOW gives 98 t (€65,856), BUY AS USUAL 63 t, WAIT 28 t, low confidence 63 t.

UI: one row per variety with cover now (weeks), need for 8 weeks (paddy t), suggested from farmers (t and €), the call as a pill, last price → forecast price with the 80% band, and a confidence pill with both MAPEs. Each row expands into "How we got this number", one line per step with its source. "Prepare purchase proposal" opens a `purchase` case in Actions; a person approves with a reason. Nothing is ever bought automatically.

## B. Warehouse & Shipping

Trucks and their orders, pallet and weight capacity, planned against verified pallets, picking progress, loading checks, dispatch, upcoming deliveries, as a simple table or list. Normal verified operations go ahead automatically; real problems become cases.

Logistics agent, shared trucks and shorter routes:

- Inputs: confirmed orders ready to ship, the retailer's delivery point and delivery date, pallets and weight per order (the existing order-load function), trucks of 33 pallets and 24 t. Add approximate coordinates for the plant (Riso Scotti, Pavia) and each delivery point (Melzo, Milano, Ancona, Casalecchio di Reno, Rozzano), marked as demo data.
- Consolidation: group orders by delivery date and fill trucks largest order first (first-fit decreasing on pallets, then weight). One truck may serve several delivery points that are close (for example within 40 km of each other) when their windows overlap. Never split an order without a person's approval.
- Route: nearest neighbour, then 2-opt, starting and ending in Pavia. Distance is straight-line × 1.3, labelled as an estimate. Show it as a stop list with km, not a map.
- Cost: litres = km × 30 L/100 km (demo value); € = litres × one Italian diesel price stored with its source and date; CO2 = litres × 2.65 kg.
- Baseline: one truck per order, each a straight round trip. Show trucks, km, litres, € and CO2 saved.
- Grok explains the plan in two sentences. It handles exceptions through the existing shipping cases (no truck fits, windows clash, too heavy) by proposing another truck or a swap. Code checks every proposal with the existing truck-fit rules, and the person approves it in the Ready-to-ship card.

## C. Finance & Documents

Invoices and amounts linked to orders and shipments; DDT, DESADV (simulated), FatturaPA XML, INVOIC; retailer receipts (RECADV); payments and deductions (REMADV); reconciliation results. Port `shipping/receiving.py` and `finance/receivables.py` if they are not in the app yet. Show missing fiscal data and validation errors. Never say a FatturaPA was submitted to SdI: there is no submission. If there is no invoice PDF renderer, show the XML and EDI and say the PDF is missing; do not fake it.

# 6. Agents on every step, and how much they may do alone

Show each as a named agent in the UI: an icon, a name, one line on its job. They can be one eve agent with role-specific tools.

| Agent | Job | Code | Status |
|---|---|---|---|
| Inbox agent | Sorts every retailer email into the right lane, references checked | `crm/inbox.py` | port from Python |
| Order agent | Parses EDI, fixes unclear fields (parsed again), checks stock and contract price, proposes splits | `lib/order` | done |
| Purchasing agent | Paddy to buy now or later, per variety (section 5A) | new | build |
| Quality agent | Lot photo check: broken and chalky grains, contract price cut, where the lot goes | `forecast_quality/quality.py` | port if time |
| Logistics agent | Shared trucks, stop order, fuel saved (section 5B) | new | build |
| Documents and reconciliation agent | DESADV, DDT, invoice, order vs DESADV vs invoice, explains every gap | `lib/shipping` | done |
| Dispute agent | Reads claims, pulls documents, verdict with a source per point | `lib/dispute` | done |
| Cash agent | Reads remittances, matches deductions to our credit notes, turns the rest into claims | `finance/receivables.py` | port from Python |
| Learning | Past decisions become examples; three alike draft a rule a person approves | `agent/learning.py` | port from Python |

Deterministic code owns stock, reservations, capacity, quantities, prices, VAT, document consistency and state. Grok owns unclear evidence, investigation, explanation and proposals.

Autonomy levels, shown as the status of every case:

- Auto: evidence complete, checks pass, policy allows it.
- Needs correction: a routine physical or data issue to fix.
- Approval required: a commercial, quality, financial or protected decision.
- Blocked: evidence missing or conflicting, or a mandatory check failed.

Policies live in one config file the team can read. An agent failure never corrupts records. Actions are idempotent and safe to retry. Every tool call, proposal, approval and result is logged.

Plain language for every code, for example:

- TRUCK_CAPACITY_EXCEEDED: "Truck 02 cannot fit the remaining four pallets. Another available truck may be suitable."
- RECEIVING_GAP: "The retailer accepted 10,560 units, but 10,800 were dispatched. Delivery evidence needs review."
- Missing VAT: "This product's tax setup is incomplete. Finance must check it before the invoice XML can be made."

# 7. Show the impact

Every number is computed from the Mini ERP and the audit log, or labelled as an estimate with editable assumptions.

- People's time: steps by agents against steps by people; share of cases handled with no person; estimated hours saved = automated tasks × minutes per manual task, with the assumptions listed.
- Cost: fuel saved by the Logistics agent; € of billing errors caught before an invoice went out; € of price mismatches caught on orders; € of deductions matched or disputed; Grok cost per case (tokens per call from the client, € from the console price entered as a setting).
- Fewer errors: our reconciliation against threeway, read live from `/api/bench` and never typed in; wrong-truck scans and quality holds caught; Grok figures rejected by code.
- Grok and the person: the case curve (share needing a person falling as rules are learned); approvals with their reasons; "this decision is now an example for the next similar case".

# 8. Three demo scenarios

Use the real backend logic, with simulated data marked as such.

- A. Automatic order. A correct order arrives, every check passes, stock is reserved, the Logistics agent plans the truck, scans are verified, dispatch is authorized, DDT and invoice are made. The only touch is the one Ready-to-ship approval, or none with `auto_when_clean`. It shows in the Orders inbox and in "Recently completed".
- B. Shipping exception. A pallet on the wrong truck, or a truck over capacity. A case appears in Actions; Grok investigates and proposes; code validates the alternatives; a person approves; the action runs; reconciliation reruns; the order updates.
- C. Forecast shortage. Several orders reserve Carnaroli, so available-to-promise falls while physical stock stays the same, and the projection shows a shortage. "Will we have enough Carnaroli next week?" gets an answer with links to the orders, stock, production and forecast. A proposed action appears; no production commitment is made.

The existing Python scenarios show the same flows: `python demo.py`, `python -m scenarios.ambiguous_order --live`, `python -m scenarios.learning --live`.

# 9. Tests

- The chat answers from real records, with source links; unknown and ambiguous questions; chat actions need the right approval and show the real result.
- Inbox filters and statuses; order workspace consistency.
- Reservation and dispatch, no double deduction, several orders competing for stock, held stock blocked.
- A Grok failure falls back safely; approvals; duplicate actions.
- Invoice and DDT consistency; missing receipt or payment evidence.
- Forecast maths; the Paddy to buy and Logistics worked examples.
- The step counter matches the audit log; every impact number has a source or an estimate label.
- Empty, loading and error states.

Run the existing tests and all new ones. Report only what was actually run.

# 10. Build order (we pitch Thursday at 16:00)

1. The four-section shell, the Home chat, the Orders inbox and the order workspace with its journey.
2. The Actions inbox with the Ready-to-ship card and real approvals.
3. The Operations tabs with the stock rules and the forecast, then Scenario C.
4. The Logistics agent, then Scenario B with a truck swap.
5. The impact line and detail, and Paddy to buy.
6. If there is time, the ports: Cash agent, Inbox agent, learning, Quality agent.

# 11. When you finish, report

- The commands to launch the app.
- The working pages and API routes.
- The team modules that are connected.
- What Grok really does.
- Which actions really execute on their own.
- What is simulated.
- The test results.
- The remaining gaps.
