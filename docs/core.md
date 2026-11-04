# Shared core

**Owner:**
**Boxes on the map:** Mini ERP, Playbook (.md), Sign-off, Production events, Predictive planning (stretch), weekly digest
**Also owns:** the fake world in `data/`, the golden order, the test set

## Starting points

- Mini ERP: one database, SQLite is enough. Every record keeps the id of the document it came from; that is the "every action traceable to its source document" criterion.
- Fake world in `data/`: products with barcode (GTIN) and case size, two or three fictional retailers with store and warehouse codes (GLN), a contract price list, stock, one supply contract.
- Golden order: one order that goes through every row. Each owner adds what their step produces for it. It is our integration test and our demo.
- Test set: cases with the right answer written down, including the ones threeway gets wrong (see [shipping.md](shipping.md)), so we can score ourselves against the baseline.
- Sign-off rule and Playbook format: see [process-map.md](process-map.md#rules-to-agree-before-coding).
- Production enters as events, as the brief asks: batch finished, quality hold, line stopped.

## What I found

## What I decided

## What I need from others

- From every owner: the exact format of what their step writes to the Mini ERP

## What I hand to others

- The database schema, the fake world and the golden order
- The sign-off page and the Playbook file

## Open questions
