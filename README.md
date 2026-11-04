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
