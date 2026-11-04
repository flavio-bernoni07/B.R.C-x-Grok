"""The golden order through every row, end to end.

    python demo.py                 # offline: recorded Grok answers, no network
    python demo.py --live          # calls Grok (needs XAI_API_KEY or GROK_API_KEY)
    python demo.py --db data/demo.sqlite   # keep the Mini ERP file afterwards

1. Order:     Esselunga's ORDERS for 12,000 Carnaroli 1 kg -> checks -> a person confirms -> ORDRSP
2. Shipping:  a quality hold blocks 1,200 packs -> trucks, picking, scans (one wrong truck,
              fixed through an exception case) -> dispatch 10,800 -> TD01 + INVOIC 380 -> reconcile
3. Dispute:   the retailer reports a missing pallet, the signed DDT backs it -> credit note
              with no person (nothing is ambiguous); then an unclear claim goes to a person
4. Digest:    the weekly summary for the accountant and managers
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from datetime import date
from pathlib import Path

from agent import grok
from core import signoff
from core.digest import build_digest
from core.stock import record_event
from core.world import fresh_erp
from dispute.service import approve_verdict, handle_claim, offline_callers
from order.service import confirm_order, receive_order
from shipping import cases, warehouse
from shipping.receiving import record_receiving_advice
from shipping.service import export_for_dispute, ingest_confirmed_order, invoice_shipment, record_delivery, reconcile_and_send

ROOT = Path(__file__).resolve().parent
GOLDEN = ROOT / "data" / "world" / "golden"
DISPUTES = ROOT / "data" / "disputes"


def step(title: str) -> None:
    print(f"\n== {title}")


def run(*, live: bool = False, db: str = ":memory:", out_dir: Path | None = None, quiet: bool = False) -> dict:
    say = (lambda *a: None) if quiet else print
    if live and not grok.has_key():
        raise SystemExit("--live needs XAI_API_KEY or GROK_API_KEY")
    out = Path(out_dir or tempfile.mkdtemp(prefix="brc-demo-"))
    out.mkdir(parents=True, exist_ok=True)
    playbook = out / "playbook.md"
    shutil.copy(DISPUTES / "playbook.md", playbook)  # the demo never edits the real Playbook
    erp = fresh_erp(db)
    result: dict = {}

    if not quiet:
        step("1. Order")
    r = receive_order(erp, (GOLDEN / "ORDERS_ESS-GOLD-001.edi").read_text(), source_name="ORDERS_ESS-GOLD-001.edi")
    case = erp.signoff(r["case_id"])
    say(f"ORDERS {r['order_ref']} checked: stock {case['proposal']['availability'][0]['source']}, "
        f"price {case['proposal']['price_check']['lines'][0]['reason']}")
    say(f"Sign-off {case['case_id']} waits: {'; '.join(case['reasons'])}")
    handoff = confirm_order(erp, r["case_id"], by="Giulia, order desk", reason="Stock and contract price check out")
    say(f"Giulia confirms. ORDRSP {handoff['ordrsp_ref']} goes to Esselunga; hand-over to Shipping")
    result["order"] = erp.order("ESS-GOLD-001")["status"]

    if not quiet:
        step("2. Shipping and invoicing")
    ingest_confirmed_order(erp, handoff)
    record_event(erp, "quality_hold", batch="LOT-C-0418", qty=1200, note="lab sample: 9% chalky grains")
    say("Production event: quality hold on 1,200 packs of batch LOT-C-0418")
    warehouse.register_trucks(erp, [
        {"truck_id": "TRUCK-PV-01", "plate": "FX482KL", "destination": "CeDi Melzo", "pallet_capacity": 33,
         "max_payload_kg": 24000, "window": ["2026-11-05", "2026-11-06"]},
        {"truck_id": "TRUCK-PV-02", "plate": "GB117RT", "destination": "CeDi Melzo", "pallet_capacity": 33,
         "max_payload_kg": 24000, "window": ["2026-11-05", "2026-11-06"]},
    ])
    plan = warehouse.plan_truck_loads(erp, ["ESS-GOLD-001"])
    say(f"Planned on {plan['planned'][0]['truck_id']} ({plan['planned'][0]['manifest_id']})")
    picks = warehouse.create_picking_list(erp, "ESS-GOLD-001")
    say(f"Picking list: {len(picks)} pallets from released batches only")
    scans = [{"pallet_id": p["pallet_id"], "gtin": p["gtin"], "batch": p["batch"], "qty": p["qty"],
              "truck_id": "TRUCK-PV-01"} for p in picks]
    scans[3]["truck_id"] = "TRUCK-PV-02"  # one pallet scanned onto the wrong truck
    checked = warehouse.verify_scans(erp, "ESS-GOLD-001", scans)
    wrong = [e for e in checked["exceptions"] if e["type"] == "WRONG_TRUCK"]
    say(f"Scans: {sum(1 for s in checked['results'] if s['result'] == 'OK')} OK, {wrong[0]['explanation']}")
    case_id = cases.open_exception_cases(erp, wrong)[0]
    proposal = cases.propose_with_grok(erp, case_id) if live else None
    if not proposal or proposal["status"] != "validated":
        proposal = cases.submit_resolution_proposal(erp, case_id, {"actions": [{"action": "RESCAN_PALLET"}],
                                                                   "rationale": "scan it again on the planned truck"},
                                                    by="grok (recorded)")
    say(f"{case_id}: proposal {proposal['proposal_id']} {proposal['status']} ({proposal['actions'][0]['action']})")
    cases.decide_resolution(erp, case_id, employee_id="Marco, warehouse lead", role="warehouse_lead",
                            decision="approve", reason="Driver loaded it on the next truck by mistake")
    cases.execute_resolution(erp, case_id)
    warehouse.verify_scans(erp, "ESS-GOLD-001", [dict(scans[3], truck_id="TRUCK-PV-01")])
    say(f"Marco approves, the pallet is scanned again: {cases.recheck_exception_case(erp, case_id)['resolution']}")
    loading = warehouse.confirm_loading(erp, "ESS-GOLD-001")
    sent = warehouse.authorize_dispatch(erp, "ESS-GOLD-001", ship_date="2026-11-05")
    say(f"Dispatched {sent['desadv_ref']} on {sent['truck_id']}: {len(loading['pallets'])} pallets. Short: {sent['short']}")
    inv = invoice_shipment(erp, sent["desadv_ref"], invoice_date="2026-11-05")
    say(f"Invoice {inv['invoice_ref']}: net €{inv['net']:,.2f} + VAT €{inv['vat']:,.2f} (FatturaPA TD01 checked by a38)")
    rec = reconcile_and_send(erp, "ESS-GOLD-001")
    say(f"Reconcile: {rec['report']['status']} ({', '.join(rec['report']['causes']) or 'no causes'}). "
        f"Invoice {rec['status']}. threeway would call this line matched.")
    record_delivery(erp, sent["desadv_ref"], signed_by="Esselunga CeDi Melzo", received={"8000000000001": 10560},
                    note="1 pallet mancante (240 pz)", when="2026-11-06")
    say("Delivery: the retailer signs the DDT with a reservation, 10,560 received")
    gap = record_receiving_advice(erp, (GOLDEN / "RECADV_ESS-GOLD-001.edi").read_text())
    say(f"RECADV {gap['recadv_ref']}: {gap['exceptions'][0]['explanation']} (€{gap['exceptions'][0]['financial_impact_eur']:.2f}), "
        "known before any claim email")
    result["shipping"] = rec["status"]

    if not quiet:
        step("3. Dispute")
    read_c, verdict_c = (None, None) if live else offline_callers(GOLDEN / "grok_offline.json")
    claim = handle_claim(erp, (GOLDEN / "claim_email.txt").read_text(), out_dir=out, read_caller=read_c,
                         verdict_caller=verdict_c, issue_date=date(2026, 11, 7), received_on=date(2026, 11, 7))
    v = claim["verdict"]
    say(f"Claim {claim['claim_id']}: Grok proposes {v['decision']} €{v['amount']}, sources "
        f"{', '.join(p['source']['kind'] for p in v['points'])}")
    say(f"Nothing ambiguous, so no person: {claim['status']}, {claim.get('outcome', {}).get('kind')}")
    result["golden_claim"] = claim["status"]

    unclear = json.loads((DISPUTES / "extractions" / "05_ambiguous.json").read_text())
    unclear_verdict = json.loads((DISPUTES / "verdicts" / "05_ambiguous_reject.json").read_text())
    for key in ("claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"):
        unclear_verdict.pop(key, None)
    claim2 = handle_claim(erp, (DISPUTES / "claims" / "05_ambiguous_otif_or_shortage.txt").read_text(), out_dir=out,
                          read_caller=None if live else (lambda _t: dict(unclear)),
                          verdict_caller=None if live else (lambda _m: json.loads(json.dumps(unclear_verdict))))
    if claim2["status"] == "awaiting_person":
        case = erp.signoff(claim2["case_id"])
        say(f"Claim {claim2['claim_id']} is unclear, sign-off {case['case_id']}: {'; '.join(case['reasons'])}")
        done = approve_verdict(erp, case["case_id"], by="Sara, credit desk",
                               reason="Late gate-in, quantities agree: reply with the evidence", playbook_path=playbook,
                               issue_date=date(2026, 11, 7))
        say(f"Sara approves; {done['outcome']['kind']} written; the case is added to the Playbook's past cases")
    result["unclear_claim"] = claim2["status"]

    if not quiet:
        step("4. Weekly digest")
    digest = build_digest(erp, title="Weekly digest, week of 2 Nov 2026")
    say(digest)
    result.update({"pending_signoffs": len(signoff.pending(erp)), "audit_events": len(erp.audit()),
                   "dispute_catalog_orders": len(export_for_dispute(erp)["orders"]), "out_dir": str(out),
                   "digest": digest})
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the golden order through every row")
    parser.add_argument("--live", action="store_true", help="call Grok instead of the recorded answers")
    parser.add_argument("--db", default=":memory:", help="SQLite file to keep, e.g. data/demo.sqlite")
    parser.add_argument("--out-dir", type=Path, default=None, help="where outcome files go")
    args = parser.parse_args(argv)
    result = run(live=args.live, db=args.db, out_dir=args.out_dir)
    print(f"Every step above is in the audit log: {result['audit_events']} events. Files: {result['out_dir']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
