# Dispatch day, 6 Nov 2026 (demo data)

Six ORDERS for Riso Scotti Arborio 1 kg that ship from Pavia on the same day, to five delivery points:
two Esselunga orders for CeDi Melzo, then Carrefour (Milano), Auchan (Rozzano), Coop (Casalecchio di Reno)
and Conad (Ancona). 44,160 packs, 46 pallets of 960. They are received, confirmed by the order desk and handed
to Shipping by `agent-core/agent/lib/demo/dispatch.ts`, after batch LOT-A-0312 (20,000 packs) is finished.

Today each order would get its own truck. The logistics agent (`agent-core/agent/lib/shipping/routes.ts`) plans
the day on the road distances in `data/world/logistics.json`.
