# Order

**Owner:**
**Boxes on the map:** ORDERS, Parse the EDI, Run the checks, Fix the hard ones, ORDRSP

## Starting points

- Sample order: `Files/EDIFACT/PurchaseOrder.txt` in [EdiFabric/EDIFACT.NET](https://github.com/EdiFabric/EDIFACT.NET/tree/master/Files). It is a generic EDIFACT D96A order; the repo has no EANCOM ORDERS sample.
- Sample order response: `Files/EANCOM/PurchaseOrderResponse.txt` in the same repo.
- Segments that matter in ORDERS: `BGM` order number, `DTM` dates, `NAD+BY` buyer and `NAD+SU` supplier (GLN codes), `LIN` product barcode (GTIN), `QTY+21` ordered quantity, `PRI` price, `LOC+7` delivery location (one order can be split across several stores), `FTX` free-text notes.
- The easy/hard rules are in [process-map.md](process-map.md#rules-to-agree-before-coding).

## What I found

## What I decided

- Detail in [order-dec.md](../order-dec.md). On stock short: **operator** chooses **split** (ORDRSP for available qty only) or **mail** (pending, **no ORDRSP** until reactivated).

## What I need from others

- Stock, price list and order history per store, from the Mini ERP (core)

## What I hand to others

- Confirmed order lines, to Shipping and invoicing
- The ORDRSP sent back to the retailer, saved in the Mini ERP

## Open questions
