# Order

**Owner:** morganvilla / Order  
**Boxes on the map:** ORDERS, Parse the EDI, Run the checks, Fix the hard ones, ORDRSP  
**Design:** [order-dec.md](../order-dec.md) · **Code:** [order/README.md](../order/README.md)

## Starting points

- Sample order: `Files/EDIFACT/PurchaseOrder.txt` in [EdiFabric/EDIFACT.NET](https://github.com/EdiFabric/EDIFACT.NET/tree/master/Files). Demo fixtures live under `data/orders/edi/`.
- Segments that matter in ORDERS: `BGM` order number, `DTM` dates, `NAD+BY` buyer and `NAD+SU` supplier (GLN codes), `LIN` product barcode (GTIN), `QTY+21` ordered quantity, `PRI` price (checked only if present), `LOC+7` delivery location (later), `FTX` free-text notes (later).
- Easy/hard rules for the shared map: [process-map.md](process-map.md#rules-to-agree-before-coding). **Order-specific:** no €500 gate; human confirm sign-off always before ORDRSP; no usual-qty check — see order-dec.md.

## What I found

## What I decided

- Detail in [order-dec.md](../order-dec.md). On stock short: **operator** chooses **split** (ORDRSP for available qty only) or **mail** (pending, **no ORDRSP** until reactivated).
- First Order slice is code in `order/` and the TypeScript port in `agent-core/`: deterministic EDI parse with `parse_flags`, Mini ERP available-to-promise, contract price check + draft mail, pipeline statuses that match order-dec.md.
- Contract demo: `data/orders/contract_scotti_esselunga.json` (list price + volume discounts).
- Non-blocking feed: `data/orders/feed.json` + golden ORDERS run through Sign-off Pending without stopping the batch.

## What I need from others

- Stock / `available_to_promise` from Core (Forecast handoff) to replace the stub
- Shared Mini ERP schema for saving ORDRSP + handoff to Shipping

## What I hand to others

- Confirmed order lines + ORDRSP body + handoff dict (after confirm sign-off)
- Draft price-mismatch mail for humans to send
- Pipeline status for pending / Grok gates

## Open questions
