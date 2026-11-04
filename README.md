# B.R.C-x-Grok
Grok Hackathon Pavia 2026, Track B (Riso Scotti): zero-touch back office for orders, invoices and disputes

## The process, end to end

![Process map: three rows (Order, Shipping and invoicing, Dispute) through the same six columns](docs/img/process-map.png)

How to read it:

- **Columns** are the kind of work, the same in every row: In, Prepare, Check, Grok decides, Sign-off, Out.
- **Rows** are moments in an order's life: the order arrives, it is shipped and invoiced, and sometimes it comes back as a dispute.
- **Colours** show who does the work: grey is the retailer, blue outline is code, white is Grok, amber is a person, dashed is a stretch goal.
- **Green lines** are the zero-touch paths: clean cases skip Grok, and Grok decisions with nothing ambiguous skip the person. There is no euro threshold: whenever something is ambiguous, a person decides.

The full walkthrough, box by box, is in [docs/process-map.md](docs/process-map.md). The interactive version of the map is [here](https://claude.ai/artifact/T91ncru9B4aTf8kup8AvE7).

## Run it

```bash
./test.sh                  # the whole test suite (creates .venv, installs requirements, runs pytest)
python demo.py             # the golden order through every row, offline with recorded Grok answers
python demo.py --live      # the same, calling Grok (needs XAI_API_KEY or GROK_API_KEY)
python -m bench.score      # our reconciliation against the threeway baseline
python -m core.digest data/demo.sqlite   # weekly digest, after: python demo.py --db data/demo.sqlite
```

Nothing needs a key or the network except `--live`. Without a key, every Grok step falls back to what code can do on its own, or stops at a person.

## Result against the baseline

On 22 labelled cases (`data/bench/cases.json`, full table in [docs/results.md](docs/results.md)):

| | threeway | ours |
|---|---|---|
| Right call on whether someone must act | 14/22 | 21/22 |
| Every cause named, nothing extra | 10/22 | 21/22 |

The gains come from the blind spots we found in threeway's code: a short delivery invoiced correctly ("matched" for threeway), a second cause on the same line, a one-character typo in a reference, item codes written without dashes, and cartons invoiced as packs. We wrote the cases and their answers ourselves, so this shows those blind spots are handled; the jury's test set is the real test.

## Where the code is

| Folder | What it does |
|---|---|
| `core/` | Mini ERP (one SQLite file for every row, every record linked to its document, an audit log of every action), stock and production events, the sign-off queue for all rows, the weekly digest |
| `agent/` | The one Grok client every row uses: JSON answers, one retry with the checks' reasons, a model per task |
| `order/` | ORDERS parser, stock and contract price checks, Grokbot (EDI fix, short stock, price mail), ORDRSP and the hand-over (`order/service.py`) |
| `shipping/` | Hand-over in, trucks, picking, pallet scans, dispatch, DESADV and DDT, invoice (FatturaPA TD01 + INVOIC 380), reconciliation, exception cases, hand-over to Dispute |
| `dispute/` | Claim reader, pull the facts, verdict with sources, credit note (TD04 + INVOIC 381) or evidence reply (`dispute/service.py` runs it on the Mini ERP) |
| `bench/` | The comparison with threeway |
| `data/world/` | The one fake world: products (GTIN and item code), retailers, starting stock, the golden order and its claim |
| `demo.py` | The golden order end to end |

## Known limitations

- All data is synthetic, and every document is a demo document: nothing is sent to a retailer or to SdI.
- `shipping/` is rebuilt from Nicola's v0.5.0 write-up because his code is not in this repo. When it arrives, his version of a function replaces ours.
- Grok's live calls are tested with recorded answers only. The default model in code is `grok-2-latest`; set `XAI_MODEL` (or `XAI_MODEL_<TASK>`) to the model the hackathon key gives.
- The sign-off queue has no screen yet: the CRM will list `core.signoff.pending()` and call `decide()`.
- Forecast and quality (buy-or-wait, lot photo check) is a plan in DECISIONS.md, with no code yet.

## Who owns what

| Area | Boxes on the map | File |
|---|---|---|
| Order | ORDERS, Parse the EDI, Run the checks, Fix the hard ones, ORDRSP | [docs/order.md](docs/order.md) |
| Shipping and invoicing | Slot is due, Load and ship, Invoice then match, Explain the flags, INVOIC + FatturaPA | [docs/shipping.md](docs/shipping.md) |
| Dispute | Claim email, Read the claim, Pull the facts, Verdict + sources, Credit note or reply | [docs/dispute.md](docs/dispute.md) |
| Shared core | Mini ERP, Playbook, Sign-off, Production events, synthetic data, golden order | [docs/core.md](docs/core.md) |

## How we share what we find

- Each owner keeps their findings file up to date, using the sections already in it. Short facts with a source link, not pasted articles.
- Anything that changes what another area receives goes in [DECISIONS.md](DECISIONS.md) first, one line, with who and when.
- Questions for the Riso Scotti mentor go in [MENTOR.md](MENTOR.md), so we ask them once, together, and write the answers there.
- Everyone uses the same fake world in `data/`, and the same golden order that goes through every row.
- Sync every 3 hours, 10 minutes: what changed in what you receive or hand over, what blocks you, one finding the others need.
- WhatsApp is for pings. If it matters to someone else, it goes in the repo.

## What we have to deliver

From the brief: this repo with a README, the data we used, at least one result measured against the baseline (threeway), and the known limitations. The minimum demo runs on Thursday by 16:00, on a new case chosen by the jury:

- one new order handled end to end, from receipt to reconciliation
- a proposed resolution, with evidence, for at least one dispute
- human sign-off for any decision above a set threshold
