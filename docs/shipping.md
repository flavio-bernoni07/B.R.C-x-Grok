# Shipping and invoicing

**Owner:**
**Boxes on the map:** Slot is due, Load and ship, Invoice then match, Explain the flags, INVOIC + FatturaPA

## Starting points

- Sample despatch advice: `Files/EANCOM/DespatchAdvice.txt` in [EdiFabric/EDIFACT.NET](https://github.com/EdiFabric/EDIFACT.NET/tree/master/Files). `RFF+ON` is the order it refers to, `CPS`/`PAC` the pallet structure, `GIN+BJ` the SSCC pallet code, `LIN` + `QTY+12` the quantity shipped.
- Sample invoice: `Files/EANCOM/Invoice.txt`. `RFF+ON` order, `RFF+DQ` delivery note, `ALC` discounts and charges (where price disputes usually start), `MOA` totals.
- The three samples come from unrelated fake companies, so they do not reference each other. Use them as format templates only.
- [threeway](https://github.com/Bhavya-Dhoot/threeway) is the baseline we have to beat. It joins on order number + item code (exact text, ignoring spaces and capitals), sums split deliveries, forgives gaps up to 2 units or €1.00, and gives one reason per line, first match wins. Blind spots found by reading its code:
  - a typo in an order number turns into two false exceptions
  - a price error behind a quantity problem is never named
  - a short delivery that was invoiced correctly comes out as matched
- [python-a38](https://github.com/Truelite/python-a38) builds, validates and parses FatturaPA XML, and parses the official samples on fatturapa.gov.it.
- The invoice is made from what was shipped, not from what was ordered.

## What I decided

- `shipping/` covers trucks, picking, pallet scans, dispatch, the DDT and DESADV, the invoice (INVOIC 380 + FatturaPA TD01) and the line-by-line reconcile. The rules are the 4 Nov shipping row in [DECISIONS.md](../DECISIONS.md). A scan on the wrong truck, a held batch or a bad quantity stays off the shipment.

## What I need from others

- Confirmed order lines (Order)
- Products, prices and retailer data from the Mini ERP (core)

## What I hand to others

- DESADV and DDT for every shipment
- Invoice (EDI INVOIC + FatturaPA) and the threeway result per line, saved in the Mini ERP, which Dispute reads

## Open questions

- The truck scan is in `shipping/warehouse.py` (plate, pallet, result). A second scan at the retailer's dock, to prove the pallet arrived, is still open.
