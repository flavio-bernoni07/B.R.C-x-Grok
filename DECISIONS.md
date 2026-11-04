# Decisions

Write here what you find from the research on your part and how it can be implemented

## Order

Detail: [order-dec.md](order-dec.md)

| When | Decision | Why | Who |
|---|---|---|---|
| Wed 4 Nov | Order row: parse flags → stock hook → PRI vs contract → Grok on exceptions; human sign-off always before ORDRSP; no €500 gate on Order; no usual-qty check | Order team design from discussion | order |
| Wed 4 Nov | After Grokbot on parse_flags, re-enter Parse EDI on the corrected message; after Grokbot on qty_short, re-enter availability check — no skip to sign-off | Corrections must pass code checks again | order |

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

### How it shows in the pitch

About 20 seconds. One screen, three panels:

1. *Before the screen:* "Last year Italian paddy fell up to 40% because Asian rice got cheap. This year world prices are up 43% in euros. For Riso Scotti, every 1% saved on paddy is about a million euros."
2. *Buy or wait:* "Every Monday Grok proposes what to buy, and every number links to its source.
3. *How it works:* 
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

The backtest checks whether the advisor is any good. We pretend it is September 2016 and let it decide week by week until 2026, seeing only the data that existed in that week. Then we compare it with the simple rule "buy the same amount every week". The result is one number: euros saved per tonne. This is our result against a baseline for the jury, on real prices. Grok writes the weekly memo from these numbers. Every purchase is above €500, so a person signs every one.

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
