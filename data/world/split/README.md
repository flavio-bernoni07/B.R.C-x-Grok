# A split delivery (demo data)

Carrefour Italia orders 7,000 packs of Riso Scotti Carnaroli 1 kg (CRF-SPL-002) for the 6 Nov dispatch. Batch
LOT-C-0420 has just finished with 4,200 packs; ESS-GOLD-001 still holds its 12,000 at the dock (the case study stops
it at loading), so 3,000 are free. Batch LOT-C-0419 (4,000 packs) is planned for 9 Nov.

Code computes the only allowed answers from stock (split, or ask the retailer), Grok picks the split and writes the
message to Carrefour (`grok_recorded.json` offline, live with a key), code checks every figure in it, and the order desk
confirms. 3,000 packs ride the 6 Nov truck with Carrefour's other order to the same CeDi; 4,000 follow from 9 Nov.
Arborio is left alone, so the 6,840 packs free after the dispatch day still cover the ambiguous-order scenario.
Seeded by `agent-core/agent/lib/demo/split.ts`.
