# Decisions

Write here what you find from the research on your part and how it can be implemented

Subdocuments: [order-dec.md](order-dec.md) (Order) · [dispute-dec.md](dispute-dec.md) (Dispute) · [grok-agent-dec.md](grok-agent-dec.md) (Grok agent, all lanes)

## Order

Detail: [order-dec.md](order-dec.md)

| When | Decision | Why | Who |
|---|---|---|---|
| Wed 4 Nov | Order row: parse flags → stock hook → PRI vs contract → Grok on exceptions; human sign-off always before ORDRSP; no euro threshold on Order; no usual-qty check | Order team design from discussion | order |
| Wed 4 Nov | After Grokbot on parse_flags, re-enter Parse EDI on the corrected message; after Grokbot on qty_short, re-enter availability check — no skip to sign-off | Corrections must pass code checks again | order |
| Wed 4 Nov | Price mismatch: after draft mail, separate human step (manual EDI or park pending + assign new ORDERS later) — not the always-confirm sign-off; re-enters Parse when data arrives | Wrong price needs retailer correction path, not silent confirm | order |
| Wed 4 Nov | Dispute row detail in dispute-dec.md: claim_reader → pull_facts/threeway → verdict+sources → optional sign-off → TD04/INVOIC 381 or evidence reply | Same schemino style as Order for the team | dispute |
| Wed 4 Nov | No euro threshold anywhere. A person signs off whenever a case is ambiguous: Grok unsure or confidence under 0.55, a point with no source, a claim type not in the Playbook, a document not found, an amount not in the documents. A clear case goes out whatever the amount. In Dispute, code blocks the credit note or reply until a person approves | The amount does not make a case unclear, the facts do | Flavio, all rows |
| Wed 4 Nov | One Mini ERP for every row: `core/erp.py` (SQLite), stock from production events (`core/stock.py`), one sign-off queue (`core/signoff.py`) where the person must write why | The rows could not hand anything to each other; every record keeps its source document | Flavio, core |
| Wed 4 Nov | Order code back on main (reverted commit 68fe04a), now reading stock from the Mini ERP, with the three Grokbot cases wired and the person confirming every order | The design was approved; the revert left Order with no code | Flavio, order |
| Wed 4 Nov | `shipping/` rebuilt from the v0.5.0 write-up below (trucks, scans, dispatch, cases), plus TD01 + INVOIC 380 and reconciliation that names every cause. No euro threshold: an employee in the case role approves every exception resolution | Nicola's code is not in the repo; the demo needs one order end to end | Flavio, shipping |
| Wed 4 Nov | One Grok client, `agent/grok.py`, used by every row (Dispute moved onto it) | grok-agent-dec.md step 1 | Flavio, all rows |
| Wed 4 Nov | Benchmark: 21 labelled cases, ours 21/21 against threeway 13/21 on whether to act, 21/21 against 10/21 on causes (`python -m bench.score`) | The track's first criterion | Flavio, shipping |
| Wed 4 Nov | **Final app:** `agent-core/` (Next.js 16 + eve, TypeScript). The rows are ported from Python one to one onto one Mini ERP in SQLite (Drizzle, same tables and columns as `core/erp.py`); every feature is one lib function exposed as an agent tool, an API route and a card component shared by the pages and the chat. Overview is the agent's chat thread with the state of things as its first message; one Sign-off page for every row. The design is the HeyHandy UI kit (`HeyHandy/brand/UI.md`). The Python rows stay as the reference and their tests still run; changes to a row go into both, or into TS first and are noted here | One app for the demo: the jury sees one window, Grok can use and show every feature | Ari, all rows |
| Wed 4 Nov | **Logistics agent** (`agent-core/agent/lib/shipping/routes.ts`, TypeScript first, no Python port yet): orders for the same delivery point share a stop; code tries every grouping and stop order on real road km (`data/world/logistics.json`: OSRM, ICCT fuel use, MASE diesel price) within 33 pallets, 24 t, 9 h driving to the last stop and no extra driver day, against one truck per order. Grok writes the briefing (figures checked by code). New sign-off kind `dispatch_plan` (row shipping, transport planner): approving books the trucks and writes one manifest per route with several orders. Demo day 6 Nov (`data/world/dispatch/`): 2 trucks instead of 6, 1,006.7 km instead of 1,591.7 | Agents on every step, and fuel saved as a number with a source | Flavio, shipping |
| Wed 4 Nov | Receivables: REMADV payments are posted, a deduction that equals our credit note is matched, any other deduction opens a Dispute claim with the remittance as source; 60-day terms (D.Lgs. 198/2021) | Short payments are the other way a dispute starts, and cash is what the company watches | Flavio, finance |
| Wed 4 Nov | Learning loop (grok-agent-dec.md): an approved rule decides with no Grok call; a rule is drafted after the same decision three times, none overturned; "no precedent yet" alone does not send a case to a person | Fewer people and fewer Grok calls over time, without loosening the ambiguity rule | Flavio, all rows |
| Wed 4 Nov | CRM backend: one `crm.actions.decide()` for the sign-off desk, three-line briefings, the inbox router, plain-language questions on fixed read-only views, a JSON API (`python -m crm.api`) | The screen can be designed on top of it | Flavio, core |
| Wed 4 Nov | Forecast and quality built in `forecast_quality/` on real EU, ECB and World Bank data; the buy-or-wait backtest shows no proven saving (+0.38%, 32 of 64), so it is pitched as signals for the buyer | Honest result beats a promise we cannot back | Flavio, forecast |
| Wed 4 Nov | Two paddy price outlooks now exist: the Rice Agent (`agent-core/`, Prophet in `planning/rice_forecast/`, prices from 2021 in `data/raw/`) and the buy-or-wait advisor (`forecast_quality/`, gradient-boosted trees, prices from 2015 in `data/market/`, served at `/api/advice`). To agree as a team: show one in the pitch, or let the Rice Agent's tool call `/api/advice` | Same question answered twice; the jury should see one answer with its backtest | Flavio |

## Dispute

Detail: [dispute-dec.md](dispute-dec.md). Owner: carlojolly. Handoff decisions only (full pipeline in the subdocument).

| When | Decision | Why | Who |
|---|---|---|---|
| Wed 4 Nov | Grok decides and cites sources; **code** writes TD04 / EDI INVOIC 381 / amounts / evidence reply | Jury needs every euro from a document; no invented totals | dispute |
| Wed 4 Nov | **threeway** runs inside every dispute (`pull_facts`); DESADV lines count as goods received (GRN) | Same match idea as the track baseline; Shipping also reconciles earlier | dispute |
| Wed 4 Nov | No euro threshold. Sign-off only when the case is ambiguous (unsure / no source / missing doc / off-Playbook). Demo runner defaults `--approved-by demo` so mentor demos still emit TD04 or reject reply | Amount alone does not make a case unclear; Flavio all-rows rule | dispute (+ Flavio) |
| Wed 4 Nov | Remittance reason `PRI` / `PRI/UNK` (and short-pay price text) → `claim_type: pricing` | Portal often labels short pays as other; pricing Playbook must apply | dispute |
| Wed 4 Nov | Dispute ends in **credit note (TD04)** or **evidence reply** — never a new invoice | Retailer claim path; no rebound debit | dispute |
| Wed 4 Nov | Facts from shared Mini ERP when Shipping exported them; else mock catalog fixtures (`data/disputes/erp/catalog.json`) until live docs cover the claim | Rows must hand off; fixtures keep Dispute demoable alone | dispute (+ core / shipping) |

## Forecast and quality (Flavio)

### TL;DR

- **What:**
  - FORCAST: a weekly "buy now or wait" advice for paddy
  - QUALITY CHECK: a photo check of a sample rice delivery -> inference adapting to the whole delivery
  - a stock projection the Order row reads
- **Why:** Italian paddy fell 27% to 40% last campaign because Asian rice got cheap. World prices are now up 43% in euros. When to buy is worth about €1M a year for every 1% saved, and a wrong stock figure turns into short deliveries and disputes.
- **Data:** public and free: weekly EU paddy prices since 2015, World Bank world prices, ECB exchange rates, Ente Risi farmer stocks. All tested on 4 Nov.
- **On stage:** about 20 seconds (we have 2 minutes in the demo video) and one screen with three panels.
- **Cost:** about 15 hours: 12 of backend, 3 for the screen. Everything else is a nice-to-have.

### Built (4 Nov evening)

Code in `forecast_quality/`, data in `data/market/`, results in [docs/forecast-results.md](docs/forecast-results.md). Tests: `tests/test_forecast_quality.py`.

- **Data** (`python -m forecast_quality.data`): EU weekly Italian rice prices since Sep 2015 (15,400 rows), ECB USD per EUR, World Bank Pink Sheet Thai and Viet Nam 5%. Checks against the research: Carnaroli €672/t on 19 Oct 2026; Thai 5% €306/t (Oct 2025) to €437/t (Oct 2026) in euros.
- **Buy or wait** (`python -m forecast_quality.advisor`): gradient-boosted trees predict the 8-week price change; the rule buys 1.5, 1 or 0.5 weeks of use within 8 to 16 weeks of cover. **Backtest 2017/18 to 2025/26, 64 variety-campaigns: +0.38% against even buying, better in 32 of 64; direction right 57% of the time when the price moved more than 2%.** That is no proven saving yet: say "signals for the buyer", not "€1M a year". This week every variety reads BUY MORE (expected +3% to +6% in 8 weeks). The weekly memo (`forecast_quality/memo.py`) is written by code, or by Grok with every figure checked.
- **Lot quality** (`forecast_quality/quality.py`): grains found in the photo, broken (shorter than 3/4 of a whole grain) and chalky (3/4 opaque white) counted, touching grains left out; broken grains become a whole-grain yield shortfall, priced at 10 kg x (milled − broken price) per point beyond the 1-point tolerance, refusable at 6 points; the lot goes to premium packs, standard packs, or rice drinks and cakes; anything doubtful goes to the lab on the sign-off desk, with a hold on the linked batch. Contract yields per variety are demo values.
- **Demand and stock** (`forecast_quality/demand.py`): forecast on an invented 2-year order history beats "same week last year" (11.3% against 16.5% weighted error, last 12 weeks); the weekly stock projection (stock + production due − confirmed − expected) flags the first short week and suggests a batch size. In the demo Carnaroli goes short in W46.

### How it shows in the pitch

About 20 seconds. One screen, three panels:

1. *Before the screen:* "Last year Italian paddy fell up to 40% because Asian rice got cheap. This year world prices are up 43% in euros. For Riso Scotti, every 1% saved on paddy is about a million euros."
2. *Buy or wait:* "Every Monday Grok proposes what to buy, and every number links to its source.
3. *How it works:* "A model trained on eleven years of weekly paddy prices predicts the price in eight weeks, and a simple rule turns that into tonnes to buy."
   - **Data:** EU weekly paddy prices since 2015, World Bank world rice prices, ECB euro/dollar rate, our silo stock. All free APIs (addresses in the data table below).
   - **Method:** gradient-boosted trees predict the price change over the next 8 weeks. We buy more when prices should rise and less when they should fall, always keeping 8 to 16 weeks of stock.
   - **Proof:** we replay 2016 to 2026 week by week, learning only from the past, against buying the same amount every week. Result: € saved per tonne.
   - **Grok:** writes the weekly memo from those numbers only, and a person signs every purchase.
4. *Lot check:* "A delivery arrives. A photo of the lab sample counts broken and chalky grains, adapt it (inference) to the whole delivery, applies the contract price cut if needed and must require further checks by human to confirm quality (good to show in the demo)."

### The screen

One web page (Streamlit) on the laptop. It reads the CSV tables and the Mini ERP, so it works offline. Only the Grok memo needs the network, and it falls back to text written by code.

```
+---------------------------------------------------------------------------------+
|  Buy or wait                                        week of 19 Oct 2026         |
|  Long B    BUY 600 t   up 12% this week, Thai rice +43% in euros in a year [1][2] |
|  Selenio   WAIT        31% below a year ago, farmers hold more than usual  [3]   |
|  [price line 2015-2026: dots where the advisor bought, dots for even buying]     |
|  Last 10 campaigns: the advisor paid X €/t less than buying evenly               |
+----------------------------------------+----------------------------------------+
|  Lot check            Carnaroli, lot 17 |  Stock we can promise   Carnaroli 1 kg |
|  [photo, grains outlined: green whole,  |  [bars for weeks 45 to 52, a drop of   |
|   red broken, white chalky]             |   300 in week 46, a line at the order  |
|  Broken 9%, chalky 4%                   |   waiting for week 47]                 |
|  Yield 2.5 points under contract        |  Order 1047 for week 47 is now hard:   |
|  Price cut 21 €/t (contract clause)     |  partial delivery offered              |
|  Goes to rice drinks                    |                                        |
+----------------------------------------+----------------------------------------+
```

### Build budget

**Must have**, in this order:

| # | Step | Done when | Hours |
|---|---|---|---|
| 1 | Download EU paddy prices, world prices and exchange rates | `data/raw/` holds 11 years of weekly prices | 1.5 |
| 2 | Purchasing advisor, 10-campaign backtest, Grok's weekly memo | One table per variety with € per tonne saved against even buying, and the 19 Oct memo citing every number | 5 |
| 3 | Stock projection with production events | The Order row can read `available_to_promise` per product and week | 2.5 |
| 4 | Quality check, demo version: broken and chalky, price cut, where the lot goes, quality hold | A real photo of Carnaroli gives a lot report | 2 |
| 5 | Simple demand forecast on the invented order history | It beats "same week last year" and feeds step 3 | 1 |
| 6 | The screen | It runs on the laptop with the network off | 3 |

**Nice to have**, only after the must-haves:
- the trained quality model on GrainSet, which needs the mentor's OK on the licence (4 h)
- reading the Ente Risi PDFs automatically (1.5 h)
- a weather and satellite chart for the Romanian fields (1.5 h)
- Grok reading promotions from retailer emails (1 h)

### What this part does

Riso Scotti buys paddy (risone: raw rice still in its husk) from farmers, mills it into white rice, packs it and sells it to supermarkets. This part answers four questions for them:

| Question | Tool | Who uses the answer |
|---|---|---|
| Should we buy paddy this week, or wait for a lower price? | Purchasing advisor | The buyer, who signs every purchase |
| How much of each product can we promise to supermarkets each week? | Stock projection | The Order row, to call an order easy or hard |
| Is this delivery of paddy good or bad, and what is it worth? | Quality check | The lab, the buyer and the stock projection |
| How much will each supermarket order in the coming weeks? | Demand forecast | The stock projection |

### What I found

**The market.** Italian paddy prices fell hard in 2025/26: Carnaroli −27%, Arborio −31%, Long B about −40% ([Il Post, 14 Aug 2026](https://www.ilpost.it/2026/08/14/riso-italiano-mercato-anno-pessimo/)). India resumed exports, world prices dropped about 30% and the dollar lost over 10%. Now the market is turning unevenly: Thai rice is up 43% in euros in a year, Long B paddy rose 12% in one week of October, round rice (Selenio) is still down 31%.

So when to buy is worth real money. Riso Scotti processes about 200,000 t of paddy a year, about €100M at €500/t, so every 1% saved on the price is about €1M a year (our estimate, to check with the mentor).

**The data.** All free, all tested on 4 Nov 2026. Only Sentinel needs an account.

| Source | What it gives | Used for |
|---|---|---|
| EU Agri-food Data Portal API: `https://ec.europa.eu/agrifood/api/rice/prices?memberStateCodes=IT&beginDate=01/09/2025&endDate=31/10/2026` | Italian paddy price per variety (Carnaroli €672/t on 19 to 25 Oct 2026) and broken rice (€460/t), weekly since Nov 2015. A price of €0.00 means a missing week | Advisor, backtest, value of a lot |
| Ente Nazionale Risi, enterisi.it | Weekly PDF: paddy still held by farmers per variety, against past campaigns. Yearly: area sown per variety | Advisor, harvest size |
| World Bank Pink Sheet, `CMO-Historical-Data-Monthly.xlsx` | Thai and Vietnam export rice prices, monthly since 1960 | Pressure from cheap imports |
| ECB: `https://data-api.ecb.europa.eu/service/data/EXR/M.USD.EUR.SP00.A?format=csvdata` | Euro/dollar rate | World prices in € |
| Open-Meteo: `archive-api.open-meteo.com/v1/archive`, `api.open-meteo.com/v1/forecast` | Weather history from 1940, 16-day forecast | Harvest, quality risk, demand |
| MODIS NDVI: `modis.ornl.gov/rst/api/v1/MOD13Q1/subset` | Satellite crop vigour every 16 days since 2000 (max 10 dates per call, multiply by 0.0001) | Harvest size |
| JRC MARS Bulletin | EU yield forecasts, Italian rice included | Harvest size |
| Paddy contract templates, Camere di Commercio Pavia and Vercelli | Price tied to the milling yield (resa) of each delivery: 1 point tolerance, adjusted beyond it, can be refused at 6 points | Quality to € |
| GrainSet (figshare) | 31K labelled images of single rice kernels. Non-commercial licence only | Trained quality model, optional |

Not used: no prediction market covers Italian rice, and the free US rice futures feed (Stooq) blocks scripts.

Rice areas (approximate): Lomellina 45.25, 8.73 · Vercelli 45.32, 8.42 · Novara 45.45, 8.62 · Brăila 45.05, 27.85 · Ialomița 44.60, 27.85 (Riso Scotti's own fields in Romania).

### How it can be implemented: five steps

Hours are in the build budget above. Steps 2 and 3 can swap if the team needs the stock number first.

**1. Download the data.** One small script per source. The must-have ones are EU prices, world prices and exchange rates; weather and satellite come later if time allows. Each downloads its data and saves it as a CSV table in `data/raw/`. Every later step reads these tables, never the internet, so the demo works offline and every number has a file it came from. The Ente Risi PDFs are typed in by hand for the weeks we need.

**2. Purchasing advisor and backtest.** Each week the advisor says "buy 400 t of Carnaroli now" or "wait", with its reasons, each with a number and a source. It looks at:

- today's price against past years at the same week
- whether world rice is getting more expensive in euros
- how much paddy farmers still hold, against normal for the date
- how many weeks of paddy we already have in the silos

The backtest checks whether the advisor is any good. We pretend it is September 2016 and let it decide week by week until 2026, seeing only the data that existed in that week. Then we compare it with the simple rule "buy the same amount every week". The result is one number: euros saved per tonne. This is our result against a baseline for the jury, on real prices. Grok writes the weekly memo from these numbers. A person signs every purchase.

**3. Stock projection.** For each product and each week:

```
available to promise = stock in the warehouse
                     + production planned
                     − orders already confirmed
                     − a safety margin for orders we expect
                     − batches blocked by quality
```

The Order row reads this number. If an order fits inside it, the order is easy and takes the green line. If not, it is hard, and Grok proposes a partial delivery or another date.

**4. Quality check from a photo.** The lab photographs a sample of milled rice from each delivery on a black tray. Code cuts the photo into single grains and measures each one:

- **Broken:** shorter than 3/4 of a whole grain
- **Chalky:** white and opaque over at least 3/4 of the grain
- **Other defects** (unripe, damaged, moldy): need a trained model

The percentages decide three things:

- **Price.** Up to 1 point below the contract yield, nothing changes. Beyond that the price drops per point, and at 6 points below the lot can be refused. The adjustment cites the contract clause.
- **Where the lot goes.** Many whole grains: premium 1 kg packs. Many broken grains: rice drinks and rice cakes, which Riso Scotti also makes. One point of yield turns 10 kg of whole rice into broken rice per tonne of paddy, and broken rice sells for €460/t.
- **Stock.** A lot that fails is blocked, which lowers the number in step 3.

Demo version first: broken and chalky only, by length and brightness, no trained model. The trained model on GrainSet only if time is left.

**5. Demand forecast.** Estimates how much each supermarket will order in the coming weeks, from past orders, promotions, holidays and weather. The baseline is "same week last year". It comes last because our order history is invented for the hackathon: it shows the pipeline works, but proves nothing about accuracy.

**6. The screen.** The page in "The screen" above. It only reads what steps 1 to 5 produce, so it can be built in parallel once their outputs exist, and it is what the jury actually sees.

### Files in the repo

```
data/raw/        CSV tables written by step 1 (real public data)
planning/
  data/          step 1: one downloader per source
  purchasing/    step 2: buy-or-wait advisor, backtest, weekly memo
  stock/         step 3: stock projection and production events
  quality/       step 4: photo to grains, lot report, price adjustment, where the lot goes
  demand/        step 5: order forecast
tests/
```

### What I hand to others

- **To Order:** the table `stock_projection(product_gtin, week, available_to_promise, source_ids)` in the Mini ERP. Until it exists, Order uses a fixed stock figure. A batch that fails the quality check becomes a quality hold and lowers `available_to_promise`, so orders for that product can turn hard.
- **To Dispute:** the quality record of each batch (photo and defect percentages), as evidence for "contested goods" claims. The batch number travels on the pallet label.
- **To the pitch:** the backtest result, in € per tonne and € per year.

### What I need from others

- **From core:** the product list (GTIN), confirmed orders, production events (batch finished, quality hold, line stopped) and the synthetic order history, in the Mini ERP.

### Not doing

- Automatic buying, or price forecasts presented as certain
- A real ERP connection
- Any recommendation without its numbers and sources

### Questions for the mentor

1. How much paddy do you buy a year, and how much is contracted at sowing versus bought week by week during the campaign?
2. How many weeks of paddy do you hold at minimum, and what does storage cost per tonne?
3. Who measures the milling yield of each delivery, how long does it take, and are samples photographed?
4. What are your internal quality limits compared with the legal tolerances?
5. How many hectares do you farm in Romania today, which varieties, and can we have past yields per field?
6. Do any retailers send you their sales or warehouse stock data (SLSRPT, INVRPT)?
## Shipping and invoicing

### What we built, step by step

This is the shipping and invoicing lane for the Grok Hackathon Pavia 2026, Track B (Autonomous Company, Riso Scotti). The current version is **0.5.0**.

The module is a Python library with a local SQLite database. Tables start with `si_`. Money and quantities are strings. Every invoice is marked **SIMULATED — NOT A VALID FISCAL DOCUMENT**. The module prepares JSON for a teammate's Grok agent and does not call Grok.

Times below are Europe/Rome.

### Where we started

**4 November 2026, 12:04** — commit `eb40163`, "Initialize project".

The folder was empty. There was no shipping code, no database, and no screen. The CRM dashboard was left for later. This lane only had to receive an approved retailer order and handle shipping and invoicing.

### Step 1 — Ship, write documents, and find mismatches

**4 November 2026, 12:24** — commit `95d6590`, "Add the shipping and invoicing module." Version **0.1.0**.

An approved order goes in. The module looks at released stock and the confirmed quantity, writes a simulated shipment, a delivery note (DDT / DESADV), and a draft invoice, then compares the order, the shipment, the invoice, and an optional retailer receipt.

Functions:

- `simulate_shipping`
- `generate_delivery_note`
- `generate_invoice`
- `reconcile`
- `apply_match_result` and `record_decision` for the invoice status
- `get_case` for the stored file of one order

Rules we locked in:

- A batch on quality hold is never shipped.
- The invoice uses the dispatched quantity at the approved price. The older ordered quantity is history.
- A short shipment with a matching invoice is a fulfillment gap, not a billing error.
- The same shipment cannot be invoiced twice.
- A person reviews billing errors, and any fulfilment gap that is ambiguous. There is no euro threshold (team decision, 4 Nov); v0.5.0 still has a 500 EUR placeholder, to remove when the code moves into `shipping/`.
- Sample VAT is 4% on the rice SKUs and 10% on the ready risotto. An unknown product gets no guessed rate.
- Prices, quantities, VAT, weights, pallet sizes, and GTINs are never invented.

`demo.py` shows a complete order, a partial shipment, an invoice that bills too much, a second click on the same shipment, and stock on hold.

### Step 2 — Pick, scan, load, then dispatch

**4 November 2026, 13:12** — commit `2c33940`, "Add warehouse picking and loading verification before dispatch." Version **0.2.0**.

The first shipping path stayed in place for callers with no scans. A second path was added in front of dispatch.

Functions:

- `create_picking_list`
- `verify_scans`
- `confirm_loading`
- `authorize_dispatch`

A pallet is checked with simulated scans only. There is no barcode hardware. Prepared, loaded, and dispatched quantities stay separate. The invoice on this path uses the quantity that was scanned, loaded, and checked again at dispatch. A wrong product, a wrong batch, a bad quantity, a duplicate scan, or a quality hold keeps that pallet off the shipment. Picking does not deduct stock. Stock is recorded when dispatch is authorized.

After this step the suite was **41 passed**.

### Step 3 — Plan trucks, without loading them

**4 November 2026, 13:38** — commit `f1a397c`, "Add simulated truck planning and loading manifests." Version **0.3.0**.

Functions:

- `register_trucks`
- `plan_truck_loads`

A plan assigns whole orders to simulated trucks. The manifest says `physically_loaded` false and `dispatched` false. Planning does not write a shipment and does not write `si_batch_allocations`. Pallet count and weight come from product data the caller supplies (`unit_weight_kg` and `units_per_pallet`). A missing weight or pallet size stops the plan.

The planner checks, in order: the truck is available, the destination matches, the delivery window overlaps, pallet space remains, and payload weight remains. The first truck that fits is used. An order is not split across trucks.

`demo.py` section 7 plans three orders onto two trucks: ORD-1061 and ORD-1062 on TRUCK-NORD, ORD-1063 on TRUCK-SUD.

After truck planning the suite was **54 passed**.

### Step 4 — Tie the plan to the warehouse

**4 November 2026, 13:57** — commit `ae64466`, "Connect truck manifests to warehouse loading." Version **0.4.0**.

The plan and the warehouse were connected. Nothing from steps 1–3 was replaced.

What changed:

- `create_picking_list` copies pallets from the truck manifest when a plan exists.
- `verify_scans` and `confirm_loading` accept an optional `truck_id`. A pallet must match the assigned truck, product, batch, and expected quantity.
- A pallet from truck A scanned against truck B is `WRONG_TRUCK`.
- `authorize_dispatch` creates a shipment only when the loading record names the same truck and manifest. The shipment, the delivery note, and the invoice gain `truck_id` and `manifest_id` when a plan exists. Older shipments simply omit those fields.
- Two orders share a truck when they go to the same distribution center, or when that truck has an explicit `compatible_routes` entry that covers both centers. Overlapping delivery windows are not enough.
- `cancel_truck_plan` and `revise_truck_plan` release a plan before loading. After a loading record exists, or after dispatch, the assignment stays locked.

`demo.py` section 8 runs two orders on two trucks through planning, scanning, dispatch, a DDT, and an invoice. ORD-1071 on TRUCK-1071 and ORD-1072 on TRUCK-1072 each dispatch 10 bags and invoice **25.00 EUR** net. Planning added no stock allocation for LOT-1071 or LOT-1072.

After this step the suite was **65 passed** (54 previous and 11 new integration tests).

### Step 5 — Turn a failed check into an employee case

**4 November 2026, 14:19** — commit `65e6c38`, "Add exception cases and employee approval." Version **0.5.0**.

When a check fails, the CRM can ask for a case. The original functions still return the same dictionaries. They do not open a case by themselves.

Functions:

- `open_exception_cases`
- `grok_case_package`
- `submit_resolution_proposal`
- `assign_exception`
- `view_exception_case`
- `decide_resolution`
- `execute_resolution`
- `recheck_exception_case`

One new table, `si_exception_cases`, stores the case, the proposals, and the history. `get_case` now includes `exception_cases`. `plan_truck_loads` gained an optional `only_truck_id`. Leave it out and the planner still picks the first truck that fits.

A case keeps the exception id, type, and severity, the affected order, truck, pallet, shipment, and invoice ids, the explanation and evidence, the financial impact already calculated on the exception, the department and role, possible actions, the approval requirement, the status, and the full history. Templates list candidates. `selected` starts false. The module does not pick a winner.

Templates cover a missing pallet, the wrong truck, a duplicate scan, a quality hold, truck capacity, weight, a delivery window, a short shipment, an invoice quantity or price, and a retailer receiving or acceptance gap. Every case also offers `REQUEST_CLARIFICATION`.

The read-only package is for the teammate's Grok agent. A proposal comes back as JSON. Python checks stock, product and batch eligibility, truck capacity, the delivery window, the route, and the approval rules before the proposal is accepted. One failing action rejects the whole proposal. Releasing a quality hold, unblocking dispatch, issuing an invoice or a credit note, sending a message, editing an amount, or ignoring capacity or a window is rejected.

The assigned employee, in the case role, approves, rejects, or asks for clarification. Approval does not run the action. `execute_resolution` runs one approved action. A second call returns `DUPLICATE_EXECUTION`. `recheck_exception_case` sets `resolved` or `unresolved` from the stored facts and does not change stock or documents.

`demo.py` section 9 walks one case from detection to a verified plan:

1. ORD-1081 needs 20 bags, 10 per pallet, so two pallets.
2. The only truck is TRUCK-SMALL, with one pallet space.
3. `plan_truck_loads` returns `TRUCK_CAPACITY_EXCEEDED`.
4. That opens **CASE-00001** for **EXC-00001**, role `transport_planner`.
5. TRUCK-WIDE, with two pallet spaces, is registered after the failure.
6. Proposal **PRP-00001** asks to plan the order on TRUCK-WIDE. The truck rules accept it.
7. Employee **EMP-PLANNER-01** approves, then execution runs the plan.
8. Recheck sets the case to **resolved**. ORD-1081 sits on TRUCK-WIDE with `dispatched` false. No stock row, no shipment, and no invoice were written.

The five new tests also cover a proposal for the too-small truck, a proposal to release a quality hold, execution before approval, a second execution, and a missing pallet that stays unresolved after it is only recorded.

### Where the code stands now

The full path a future CRM can call:

```text
Approved order
  → plan_truck_loads
  → create_picking_list
  → verify_scans
  → confirm_loading
  → authorize_dispatch
  → generate_delivery_note
  → generate_invoice
  → reconcile
  → open_exception_cases    only when a check failed
```

`cancel_truck_plan` and `revise_truck_plan` sit between planning and loading. `simulate_shipping` is still the path with no scans and no truck.

Latest check of this version: **70 passed in 0.21s** (`pytest`), and `python demo.py` completed through section 9.

The contract for the other teammates is `INTEGRATION.md`. How to run the module is `README.md`.

### Left for other lanes

Real EDI, FatturaPA XML, submission to SdI, credit notes, GPS, a route optimizer, hardware scanners, external logistics APIs, a second Grok agent, and the CRM screen stay outside this module. A planned manifest is a plan. A case does not send a message, release a quality hold, unblock dispatch, or issue a financial document.

### In this repo now (Flavio, 4 Nov evening)

The functions above are rebuilt in `shipping/` from this write-up, on the shared Mini ERP: `register_trucks`, `plan_truck_loads`, `cancel_truck_plan`, `revise_truck_plan`, `create_picking_list`, `verify_scans`, `confirm_loading`, `authorize_dispatch` (`shipping/warehouse.py`), `open_exception_cases`, `grok_case_package`, `submit_resolution_proposal`, `assign_exception`, `view_exception_case`, `decide_resolution`, `execute_resolution`, `recheck_exception_case` (`shipping/cases.py`), and `ship_order` as the path with no scans. The same rules hold, with one change: there is no 500 EUR placeholder, an employee in the case role approves every resolution. New on top: `ingest_confirmed_order` and `export_for_dispute` (the two hand-overs), `record_delivery` (proof of delivery), the FatturaPA TD01 and INVOIC 380, and `propose_with_grok`, which sends the case package to Grok. Tests: `tests/test_shipping.py`.

### Review and next steps (Flavio, 4 Nov)

**TL;DR:** the rules and the safety design are right. What is missing is the link to the rest of the team, plus the proof the jury scores:
- the code is not in this repo
- it does not take the Order lane's hand-over or feed the Dispute lane
- it writes no real DESADV, INVOIC or FatturaPA
- `reconcile` has never been scored against threeway

**Keep as it is:**
- the invoice uses the dispatched quantity, never the ordered one
- a batch on quality hold never ships, and a shipment is never invoiced twice
- Grok proposes, Python validates, a person approves, and the action runs once
- scans are tied to the assigned truck (`WRONG_TRUCK`)

**Improve, most important first:**
1. **Bring the code into this repo** as `shipping/` with `tests/shipping/`. Today it lives outside, so it can be neither in the demo nor in the repo we deliver.
2. **Connect the hand-overs.**
   - **In:** the Order lane's payload from `order-dec.md`: confirmed lines, dates, order and ORDRSP references, sent only after the human sign-off.
   - **Out:** the shape the Dispute lane reads in `data/disputes/erp/catalog.json`: `orders`, `desadv`, `invoices` and `proofs`, keyed by `order_ref`, `desadv_ref` and `invoice_ref`, with numeric quantities. Strings inside the module are fine; convert at the hand-over.
3. **Write the real documents.** On the map this row ends with DESADV + INVOIC + FatturaPA, and no other lane owns them. `dispute/outcome.py` already writes a FatturaPA TD04 with `a38` and an EDI INVOIC 381, with the seller's data. Reuse both for:
   - the FatturaPA TD01 invoice
   - an EDI INVOIC 380
   - an EANCOM DESADV
4. **Score `reconcile` against threeway.** It is the track's first judging criterion, and threeway is already in the repo (`dispute/_threeway_core.py`). Some cases show the difference clearly. For example, a short shipment invoiced correctly is a fulfillment gap for us and "matched" for threeway. That difference needs a number.
5. **Call Grok.** `grok_case_package` is ready, but no lane sends it to Grok. A small adapter sends it, passes the answer to `submit_resolution_proposal` (which already validates it), and falls back to code-written text if the network fails.
6. **Add proof of delivery.** The driver scans the pallets off at the retailer's dock, and we store the signed-DDT reference. Both are exported as `proofs` for disputes.
7. **No more logistics features.** Truck planning already goes beyond the brief, and route optimisation was ruled out.
8. **One screen for a case,** showing each step: plan, scan, dispatch, invoice, reconcile, case, Grok's proposal, approval.

**Build plan, about 11 hours:**

| # | Step | Done when | Hours |
|---|---|---|---|
| 1 | Move the code into `shipping/` and `tests/shipping/` | The PR is merged and the 70 tests pass next to the Dispute tests | 0.5 |
| 2 | Hand-overs, written as one line each in this section | `ingest_confirmed_order(payload)` accepts the Order payload; `export_for_dispute(order_ref)` returns the catalog shape | 1.5 |
| 3 | Real documents, reusing `dispute/outcome.py` | Each dispatch writes an EANCOM DESADV and an INVOIC 380, and a FatturaPA TD01 that `a38` validates | 2.5 |
| 4 | Reconciliation scored against threeway | About 25 labelled cases give a table of right status and right reason for both | 2.5 |
| 5 | Grok adapter for exception cases | A live proposal passes the validator, with a fallback when the network is down | 1 |
| 6 | Proof of delivery | The unload scan and the signed-DDT reference appear in `export_for_dispute` | 1 |
| 7 | The case screen | One page shows a case end to end, in the same style as the team's UI | 2 |

Steps 1, 2 and 4 come first. Without them this lane stays a separate project, and the main criterion has no number.

The step 4 cases should cover:
- a clean order
- a short shipment invoiced correctly
- overbilling
- a price gap
- a typo in a reference
- a split delivery
- two causes on one line
- cases against bags (unit of measure)
- an orphan invoice
  ------------

  Automated Dispatch and Risk-Based Employee Approvals
Objective
Automate dispatch by default. Employees intervene only when the system cannot safely authorize the shipment under verified facts and approved company rules.

Principle: Zero-touch for normal operations; human-in-the-loop for genuine exceptions.
Step 8: Dispatch authorization — how it works
1. Collect verified loading evidence. Obtain scans, truck ID, pallet IDs, product SKUs, batches, quantities and quality-release status from the warehouse workflow.
2. Check hard constraints in deterministic code. Confirm the correct truck and route, matching manifest and physical-load records, eligible batches, valid quantities and absence of duplicate dispatch.
3. Automatically authorize standard dispatches. If all mandatory conditions pass and company policy permits it, record the dispatch without requesting an additional employee approval.
4. Generate transaction records. Create the shipment and DDT / simulated DESADV from verified, authorized dispatched quantities, preserving references to the approved order and loading evidence. Invoice using the approved commercial terms and the applicable invoicing policy.
5. Handle exceptions. If a check fails, block the affected operation. Grok may propose corrective options, but deterministic code checks their feasibility and company authorization rules before execution.
6. Escalate only when required. Assign a specific employee role and action when a physical correction, policy exception, customer agreement or regulatory/quality authorization is needed.
7. Revalidate after correction. Check the updated load and commitments again before dispatch; log the decision, action and evidence.
Exception rules
Situation	Automated response	Employee involvement
Correct pallets, truck, batches and quantities; checks complete	Authorize dispatch and generate shipment/DDT	No additional approval if company policy permits
Missing pallet	Look for verified replacement stock or a feasible revised plan	Physical intervention if needed; approval if commitments or rules change
Wrong pallet or wrong truck	Block loading; instruct warehouse to correct and rescan	Physical correction required; not necessarily supervisor approval
Truck over capacity	Find another compatible vehicle or feasible plan	Only where assignment or customer commitments require approval
Quality-held batch	Block that batch entirely	QA must authorize any quality release
Partial delivery	Check retailer agreements and existing authorizations	Approval/customer agreement if the change is not already permitted
Unverified or incomplete loading	Keep dispatch blocked until trustworthy verification is received	Verification or investigation required


Risk-based approval engine
- Low risk — automatic: Routine operations, verified data, standard rules and no exception requiring special authorization.
- Medium risk — automatic investigation, conditional execution: System proposes and validates corrections; executes only if explicitly permitted by predefined rules. Otherwise, route to the relevant employee.
- High risk — mandatory authorization: Quality releases, unapproved partial deliveries, changes to retailer commitments, significant financial corrections, or any other action defined by company policy.
These categories and monetary thresholds must be configurable. Do not assume they are Riso Scotti's actual policies.
Important physical-world safeguard
Software checks cannot prove a truck departed or a sealed package contains what its label claims. The system must use reliable warehouse scans/packing controls and a trusted dispatch or departure event. Grok cannot invent physical confirmations, bypass quality holds, or authorize a shipment by changing a record.
Implementation guidance for the team's CRM / Mini ERP
- Show routine shipments as automatically verified / authorized without creating unnecessary employee tasks.
- For exceptions, show problem → evidence → viable options → responsible role → required approval → recheck.
- Keep separate states for planned, picked, verified loaded, authorized for dispatch, physically dispatched, and retailer received.
- Use deterministic Python to enforce capacity, stock, SKU, batch, quantities, financial and approval constraints; use Grok for evidence interpretation and proposal generation; reserve decisions requiring authorization for employees.
- Preserve an audit trail of evidence, policy checks, automatic decisions, approvals and changes.
- Maintain distinct pre-invoice checks and post-delivery receipt/payment reconciliation.
Target outcome: Fewer manual approvals on clean shipments, fast and auditable responses to exceptions, and consistent shipping and invoicing records.
--------

AI Operations for Food Manufacturers — Positioning Brief
Riso Scotti / Grok Hackathon — Track B | 4 November 2026
Our positioning
One simple interface. Every food-retailer transaction connected. Routine work automated; people involved only when needed.

We do not replace the ERP, WMS or accounting system. We add a food-specific AI operations layer that coordinates the entire order-to-payment process and resolves exceptions across systems.

We are building an AI-powered transaction and exception management layer for food manufacturers supplying supermarkets and large retailers (GDO). It connects a retailer order to approved commercial terms, released inventory, product batches, truck planning, pallet loading, delivery documents, invoices, retailer receipts, payments, and disputes.

What we aim to cover end to end: retailer order intake and validation -> approved commercial terms -> inventory and batch/quality checks -> truck planning -> picking -> verified loading -> dispatch -> DDT/DESADV -> invoice PDF and simulated FatturaPA XML -> retailer receipt -> payment -> reconciliation -> dispute resolution and audit trail. Each step uses the same linked transaction history, rather than isolated copies of documents.

How people use it: a clear, fast, role-specific interface shows only the facts, status, supporting evidence and next action that matter. Clean transactions run automatically under explicit rules. Grok investigates ambiguous exceptions and suggests viable next steps; deterministic code verifies quantities, stock, truck capacity, prices and approvals. Employees intervene only for physical verification, missing evidence, unapproved commitments, quality/safety decisions, material financial changes or other configured exceptions. Fast and near-zero-touch are product goals, not yet measured results.
Why this is relevant to Riso Scotti
Public reporting supports alignment with Riso Scotti's strategic interests, not proof of a current software gap:
1. AI and scenario analysis: In a March 2023 interview, Riso Scotti logistics director Luca Priori described evaluating AI for analyzing alternative scenarios from large datasets, alongside logistics and production automation. iKN Italy.
2. Warehouse modernization: February 2026 reporting described Riso Scotti's automated Pavia logistics hub, with intensive storage, AGVs and System Logistics' Systore software, aimed at reliable and efficient flows. Supply Chain Italy.
3. January 22, 2026 — digital B2B growth and integration: Riso Scotti announced a partnership with Rosso Fine Food to develop international B2B sales through digital platforms and relationships with professional buyers and distributors. Riso Scotti digital specialist Lucia Raina described an international B2B channel intended to be governed, measurable and integrated with commercial strategy, rather than purely a marketing initiative. Our connection: expanding digital commercial channels can make consistent order, fulfillment, delivery and financial records increasingly valuable. What it does not establish: the article is about sales-channel digitalization, not a disclosed project to automate back-office exception handling or evidence that the current back office is inefficient. Foodweb — 22 January 2026.
Why these sources matter together: they show an existing emphasis on AI-enabled scenario analysis, modernized physical logistics, and integrated digital B2B growth. Our platform targets the coordination layer spanning commercial, logistics and financial transactions—an adjacent opportunity, not a confirmed deficiency.

What we must validate with Riso Scotti: Whether employees actually spend significant time tracing and resolving cross-system order, delivery, invoicing or retailer-claim exceptions; which tasks Dynamics 365 and other systems already automate; and whether our interface can genuinely reduce time and clicks. We must not claim their current tools cannot already perform these functions.
Why we could compete with established software
Existing solution	What it already does well	Our proposed differentiation
Microsoft Dynamics 365 (the team's reported ERP context)	Enterprise orders, inventory, logistics and finance processes	A single, intuitive, role-specific workspace, connected order-to-payment evidence, zero-touch routine checks and clear employee actions for exceptional cases.
SAP	Sophisticated ERP, warehouse and manufacturing operations	One-click food-retailer transaction timeline and faster evidence collection for specific exception workflows, if proven in benchmarks.
Oracle	Mature order, supply-chain and financial capabilities, including emerging AI workflows	Simple next-action UI, deterministic validity checks, and selective human intervention instead of blanket manual approvals.
Salesforce	CRM, workflow automation and customer service	Preconfigured food/GDO workflows that coordinate logistics and finance as well as customer interactions.
WMS/TMS and EDI software	Physical warehouse execution, transportation planning and structured document exchange	End-to-end operational orchestration from sales order to invoice and dispute, while leaving physical execution to systems of record.


These are hypotheses to benchmark, not established competitive wins. Major vendors already have powerful automation and AI. We should integrate with them, not try to replicate the full ERP, WMS or TMS.
Why our employee experience could be better
Current pain hypothesis: capable enterprise systems often require users to navigate separate order, warehouse, logistics and finance contexts. The expensive moment is not necessarily a routine transaction—it is an exception that spans several teams and documents. This is a hypothesis from user discussions, not a measured problem at Riso Scotti.

Our proposed one-workspace experience:
- One order page: show approved quantity and terms, batch status, truck, pallet/loading proof, dispatched quantity, DDT, invoice, receipt, payment and open cases together.
- A prioritized action inbox: show who must act, why, what evidence is present or missing, and the deadline or financial exposure.
- Zero-touch happy path: auto-check records, reserve/plan within authorized rules, process valid loading evidence, generate matching documents and reconcile compatible facts without routine approval clicks.
- Exception-first interaction: Grok proposes options with evidence; code rejects infeasible suggestions; authorized staff approve only decisions outside existing policy or requiring judgment.
- Preview before executing: show the consequences for delivery commitments, stock, truck plan, documents and finance, then record a reversible or auditable outcome where supported.
- Minimal training goal: role-specific buttons and plain explanations instead of exposing employees to every technical subsystem.
Hard boundary: software cannot substitute for authentic warehouse scans, actual departure/receipt evidence, QA decisions, customer consent or required fiscal authorizations. Autonomy means eliminating unnecessary administration—not inventing events or bypassing controls.
What 'we take care of everything' actually means
We orchestrate the full business workflow and its exceptions, from approved retailer order through payment reconciliation. We do not claim to replace production machinery, trucks, physical warehouse staff, fiscal authorities or all enterprise systems.
Stage	Our responsibility	Employee involvement
Order and contract	Read approved order, validate terms, identify conflicts	Only unresolved commercial changes
Inventory/production	Use released stock and production/status events; flag shortages	QA or operations for nonstandard decisions
Truck/pallet	Choose feasible truck, create manifest, verify supplied loading scans	Physical scanning and exceptional corrections
Dispatch/DDT	Automatically authorize only with trustworthy completion evidence and policy-compliant checks	Only when exception or mandatory authorization applies
Invoice/FatturaPA	Calculate from authoritative shipment and approved prices; generate PDF and simulated XML	Only missing fiscal info, exceptions, required approvals
Receipt/payment	Match supplied confirmations, payment and claims against records	Only missing/disputed evidence or material discrepancy
Exceptions	Assemble evidence, propose viable solutions, assign ownership, recheck	Approval where justified; routine resolutions may be automated under policy


The prototype currently simulates several stages; actual customer-system integration and legally effective invoice submission remain future work.
Our concrete use case
Example: supermarket orders 1,000 packages; only 900 units are released for dispatch.
1. Detect: Deterministic checks flag a 100-unit fulfillment gap without treating it as an invoice error.
2. Investigate: Grok receives the approved order, usable stock, batch restrictions, delivery commitment, truck capacity and relevant evidence.
3. Recommend: It proposes valid options—such as a policy-permitted partial delivery, a later delivery date, or an alternate released batch—without inventing stock or customer consent.
4. Authorize: Python validates hard constraints. An employee approves only a commercial, quality, safety or financial decision that requires authorization.
5. Execute: The system updates the supported shipment plan and audit trail after approval; warehouse scans verify actual pallets and loading before dispatch is recorded.
6. Document: DDT/DESADV-style data and invoice are derived from the authorized shipment and approved pricing. A human-readable PDF and simulated FatturaPA XML are generated only when required information and checks are available. No SdI submission is implied.
7. Reconcile: Compare approved order, picking, loaded goods, dispatch, DDT, invoice, retailer receipt and payment against the correct source record for each stage. A correct invoice for 900 units can coexist with a 100-unit unfulfilled order; a retailer reporting only 850 received is a separate discrepancy.
8. Resolve: An evidence-linked exception goes to the responsible employee with a feasible action, approval requirements and a subsequent verification step.
Core distinction: Not simply “an alert appeared,” but problem → evidence → feasible options → authorized action → verified outcome.
Why other food manufacturers could benefit
Food manufacturers selling to major retailers may need to coordinate product lots, expiry and quality restrictions, pallet traceability, retailer-specific delivery instructions, promotional prices, EDI/DDT, Italian e-invoicing, shortages, retailer claims and payment deductions. These domain-specific records make a targeted exception workflow more useful than a generic chatbot.

Our potential initial wedge: retailer delivery discrepancies and deductions, because investigation time, resolution speed and preventable financial losses can be measured. Reusable retailer and product rules could support expansion to other food producers—if validated in pilots.
What the prototype already demonstrates vs. what remains unproven
Reported in the team's Cursor development summaries (not independently audited): simulated truck assignment, picking, loading verification, shipment and DDT generation, invoice calculation, retailer receipt/payment records, linked transaction reconciliation, persistent exception cases, employee approvals, and PDF/simulated XML outputs; 77 automated tests reported passing at the last update.

Still to prove: End-to-end integration with teammates' order-management module and Grok agent; actual Dynamics 365 connectivity; official FatturaPA schema validation and required fiscal fields; real EDI/SdI exchange; operational performance under concurrent use; and measured time/cost savings versus the customer's existing workflow.
What we'd measure in a pilot
- Minutes and employee handoffs needed to resolve an exception.
- Time spent finding evidence and number of screens/systems used.
- Percentage of clean transactions processed without manual intervention.
- Correctness of recommendations and of approved downstream record changes.
- Retailer deductions investigated or avoided, with documented financial impact.
The key question for Riso Scotti: “Can you walk us through one recent order, shipment or invoice exception that wasn't resolved automatically—what information did employees need, which systems did they use, and how long did it take?”
Pitch for the judges (about 45 seconds)
Food manufacturers like Riso Scotti are already digitizing commercial channels and automating logistics. But the hardest operational problems can sit between systems: an order changes, a pallet is missing, the truck departs short, or the retailer disputes an invoice.

We are building one simple AI operations workspace for the entire food-retailer transaction—from retailer order and released batches to truck loading, delivery documents, invoice, receipt and payment.

Normal operations run automatically. When an exception appears, Grok gathers the facts, explains the impact, proposes feasible solutions and gives the right employee one clear action when approval is genuinely necessary. Deterministic checks enforce stock, pricing, quality and document consistency.

We are not replacing Microsoft Dynamics 365 or warehouse automation. We are connecting and simplifying the work across them, so food manufacturers can resolve issues faster, reduce unnecessary manual effort and maintain a complete audit trail. Our hackathon prototype demonstrates the workflow; our next step is to measure the time savings against a real process.

Very short pitch (15 seconds)
We connect the entire food-retailer order-to-payment journey in one easy interface. Routine tasks run automatically; Grok investigates exceptions and employees approve only what truly needs human judgment. We integrate with existing ERP and logistics systems instead of replacing them.

One-line message: One transaction. One clear interface. Automatic when possible. Human only when necessary.

Original complementary message: Your systems manage transactions. We help your employees resolve what goes wrong between them.
Sources
- iKN Italy — Riso Scotti logistics director on technology and AI (20 March 2023)
- Supply Chain Italy — Riso Scotti automated Pavia hub (20 February 2026)
- Foodweb — Riso Scotti digital B2B export (22 January 2026)
