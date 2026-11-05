# Routes

How the Shipping screen compares today's trucks with the planned day. The figures in the approved 6 Nov plan are the ones on the screen. Code: `agent-core/agent/lib/shipping/routes.ts`. Roads, fuel and the diesel price: `data/world/logistics.json`, built by `scripts/build_logistics.py`.

The route does not read a price forecast or a demand forecast. Those answer other questions (when to buy paddy, what to pack). A truck is planned from the orders already handed to Shipping.

## Today's way

Two descriptions live in the repo.

The desk that books trucks, `planTruckLoads` in `agent-core/agent/lib/shipping/warehouse.ts`, gives each whole order the first truck that fits its destination, its window, its pallets and its weight. One manifest per order. A truck has one destination: an order for a different CeDi is refused (`DESTINATION_MISMATCH`). The truck drives plant, that CeDi, plant. `data/world/dispatch/README.md` says the same thing in one line: today each order would get its own truck. The golden order and the replayed history use this path.

The comparison stored on the approved 6 Nov plan is that same shape. Seven orders, seven round trips:

| Order | CeDi | Round trip |
|---|---|---|
| AUC-DSP-001 | Auchan, Rozzano | 58.0 km |
| CON-DSP-001 | Conad, Ancona | 852.4 km |
| COO-DSP-001 | Coop, Casalecchio di Reno | 406.7 km |
| CRF-DSP-001 | Carrefour, Milano | 92.4 km |
| CRF-SPL-002 | Carrefour, Milano | 92.4 km |
| ESS-DSP-001 | Esselunga, Melzo | 91.1 km |
| ESS-DSP-002 | Esselunga, Melzo | 91.1 km |

Together: 7 trucks, 1,684.1 km, 1,403 minutes of driving, 8 driver days, 549 litres, €1,228.93 of diesel. Km are the OSRM matrix, there and back.

`planRoutes` as it stands now builds the baseline one step later. Orders for the same CeDi that fit on one truck are already one stop, and each stop is one round trip. On the original six-order fixture the two Esselunga orders share that stop, so the baseline is 5 trucks. `agent-core/tests/routes.test.ts` still expects 6, and that test fails. The comment above the baseline names a 2020 Politecnico di Milano thesis on Riso Scotti's logistics for "trucks leave full, one destination each". The thesis is not in the repo. The approved plan on screen was saved before this merge, and it is still one trip per order.

## What the plan is built from

Orders whose status is `ready_to_ship`, plus any order a person is previewing (`awaiting_confirmation` or `confirmed`). The 6 Nov set is the six EDI files in `data/world/dispatch/` and the Carrefour split `CRF-SPL-002`. Pallet count and weight are the order lines times `units_per_pallet` and the unit weight in `data/world/products.json`. An order with no pallet size, no road distance, or more than one truck's worth of goods is left unplanned, with a reason.

The road matrix, the fleet and the fuel price are the offline file `data/world/logistics.json` (built 2026-11-04):

| Figure | Value | Source |
|---|---|---|
| Places | Plant at Via Angelo Scotti, Pavia. Each CeDi at the centre of its comune | OpenStreetMap Nominatim. The CeDi names are the demo world's |
| Road km and minutes | Car profile, stored in the file | OSRM table service on OpenStreetMap |
| Truck speed floor | 80 km/h | Codice della Strada, art. 142, goods vehicles over 12 t. Drive time is the slower of OSRM and this floor |
| Daily driving | 9 h | Regulation (EC) No 561/2006, art. 6(1) |
| Truck | 33 EUR pallets, 24,000 kg | Demo fleet, a 13.6 m semi-trailer, same limits as the golden order's trucks. Four plates in the file; a fifth route would be a carrier |
| Fuel use | 32.6 l/100 km | ICCT 2018, typical EU tractor-trailer, Long Haul cycle |
| Diesel | €2.23842/l, week of 2 Nov 2026 | MASE weekly national average, gasolio auto, taxes included |
| CO2 | 2.65 kg/l | An estimate, labelled as such in the file |

Litres are km times 32.6 / 100. Euros are litres times the MASE price. CO2 is litres times 2.65.

## How the route is chosen

Code does this. Grok writes the briefing afterwards, and only with figures that already appear in the plan.

1. Orders for one delivery point that fit together become one stop.
2. For up to 12 stops, every stop order is scored (Held-Karp from the plant, closed by the drive back). Every way of splitting the stops across trucks is scored. The split with the least km wins, then the one with fewer trucks.
3. A truck is kept only if it holds at most 33 pallets and 24 t, the drive to the last stop is within 9 hours, and sharing the truck does not add a driver day against the longest single trip it replaces.
4. A person approves the plan (`dispatch_plan`, transport planner). Until then nothing is booked. Approval writes one manifest per route, and that manifest can carry several orders.

## The approved 6 Nov plan

Read back from the sign-off record the Shipping page shows (`/api/shipping/routes`, status approved):

| | Today's trips | Plan |
|---|---|---|
| Trucks | 7 | 3 |
| Road km | 1,684.1 | 1,041.1 |
| Driving | 1,403 min | 851 min |
| Driver days | 8 | 4 |
| Diesel | 549 l, €1,228.93 | 339.4 l, €759.72 |
| CO2 (estimate) | 1,455 kg | 899 kg |

The saving on that record is 4 trucks, 643 km (38%), 4 driver days, 209.6 litres and €469.21.

The three trucks:

- TRUCK-PV-03, Coop (Casalecchio di Reno) then Conad (Ancona), 862.7 km, 18 pallets. One loop instead of the Ancona round trip plus the Coop round trip.
- TRUCK-PV-04, both Esselunga orders to Melzo, 91.1 km, 13 pallets. One round trip instead of two.
- TRUCK-PV-05, Auchan (Rozzano) and both Carrefour orders (Milano), 87.3 km, 19 pallets.

The six-order fixture in the README (1,591.7 km down to 1,006.7, €1,161.50 down to €734.61, 6 trucks and 7 driver days down to 2 trucks and 3 days) is the earlier day, without `CRF-SPL-002`. The recorded briefing for that fixture still says "2 trucks instead of 6".
