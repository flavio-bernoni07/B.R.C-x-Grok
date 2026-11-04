"""An ambiguous order, end to end, with Grok at every step it is meant to take.

    python -m scenarios.ambiguous_order                 # recorded Grok answers, a scripted person
    python -m scenarios.ambiguous_order --live          # real Grok (XAI_API_KEY, or .env.local)
    python -m scenarios.ambiguous_order --live --me     # real Grok, and YOU approve each person step

1. Esselunga sends ORDERS ESS-AMB-001 with a date in the wrong format and "QTY 6.000":
   six packs or six thousand? The parser will not guess and flags both.
2. Grok proposes a corrected EDI. The parser reads it again; it must come out clean.
3. A person sees the order with Grok's changes and confirms it (or types the EDI).
4. ORDRSP, then Shipping: truck plan, picking, pallet scans, loading, dispatch,
   DESADV, DDT, invoice (FatturaPA TD01 + INVOIC 380), reconciliation.
5. At the dock the last pallet is crushed: the DDT is signed with a reservation and
   the RECADV refuses 240 packs.
6. Esselunga emails a claim, writing the order as "ESS AMB 001".
7. Grok reads the claim; code pulls the facts from the Mini ERP; Grok proposes a verdict
   with a source on every point; code checks every figure. If nothing is unclear, the
   credit note goes out with no person; otherwise a person decides.

Recorded answers pass through exactly the same checks as live ones. In live mode,
whatever Grok answers is what happens next, and the run says so.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from datetime import date
from pathlib import Path
from typing import Any, Callable

from agent import grok
from core.stock import record_event  # noqa: F401  (kept for experiments: add a hold before shipping)
from core.trace import chain, gaps, render
from core.world import fresh_erp
from crm.actions import decide
from crm.briefing import brief
from dispute.claim_reader import call_grok as live_read_claim
from dispute.service import handle_claim
from dispute.verdict import call_grok_verdict as live_verdict
from order.service import receive_order
from shipping import warehouse
from shipping.receiving import record_receiving_advice
from shipping.service import invoice_shipment, reconcile_and_send, record_delivery

HERE = Path(__file__).resolve().parents[1] / "data" / "world" / "scenarios" / "ambiguous_order"


class GrokTap:
    """Hands each Grok step either the recorded answer or a live call, and keeps a log of both."""

    def __init__(self, live: bool, recorded: dict[str, Any] | None = None) -> None:
        self.live = live
        self.recorded = recorded or json.loads((HERE / "grok_recorded.json").read_text(encoding="utf-8"))
        self.calls: list[dict[str, Any]] = []

    def messages(self, step: str) -> Callable[[list[dict[str, str]]], Any]:
        def call(messages: list[dict[str, str]]) -> Any:
            answer = grok.post_chat(messages, task=f"scenario.{step}") if self.live else json.dumps(self.recorded[step])
            self.calls.append({"step": step, "live": self.live, "answer": answer})
            return answer
        return call

    def verdict(self) -> Callable[[list[dict[str, str]]], dict[str, Any]]:
        def call(messages: list[dict[str, str]]) -> dict[str, Any]:
            answer = (live_verdict(messages, api_key=grok.api_key()) if self.live
                      else json.loads(json.dumps(self.recorded["verdict"])))
            self.calls.append({"step": "verdict", "live": self.live, "answer": answer})
            return answer
        return call

    def read_claim(self) -> Callable[[str], dict[str, Any]]:
        def call(text: str) -> dict[str, Any]:
            answer = live_read_claim(text, api_key=grok.api_key()) if self.live else dict(self.recorded["read_claim"])
            self.calls.append({"step": "read_claim", "live": self.live, "answer": answer})
            return answer
        return call


def run(*, live: bool = False, me: bool = False, out_dir: Path | None = None, quiet: bool = False,
        db: str = ":memory:", recorded: dict[str, Any] | None = None) -> dict[str, Any]:
    """`recorded` replaces the recorded Grok answers (tests use it to make Grok wrong)."""
    say = (lambda *a: None) if quiet else print
    if live and not grok.has_key():
        raise SystemExit("--live needs XAI_API_KEY or GROK_API_KEY (environment or .env.local)")
    tap = GrokTap(live, recorded)
    out = Path(out_dir or tempfile.mkdtemp(prefix="brc-scenario-"))
    out.mkdir(parents=True, exist_ok=True)
    erp = fresh_erp(db)
    people: list[dict[str, Any]] = []
    label = "live Grok" if live else "recorded Grok answer"

    def person(case_id: str, who: str, why: str, **extra: Any) -> dict[str, Any]:
        b = brief(erp, case_id)
        say(f"  PERSON NEEDED ({case_id}): {b['what_happened']}")
        say(f"    proposal: {b['proposal']}")
        say(f"    question: {b['question']}")
        say(f"    why a person: {'; '.join(b['reasons'])}")
        approve, reason = True, why
        if me:
            approve = input("    approve? [y/n] ").strip().lower().startswith("y")
            reason = input("    one line on why: ").strip() or why
            who = input("    your name: ").strip() or "you"
        result = decide(erp, case_id, approve=approve, by=who, reason=reason, **extra)
        people.append({"case_id": case_id, "by": who, "approve": approve, "reason": reason, "done": result["done"]})
        say(f"    {who}: {'approved' if approve else 'rejected'} ({reason}) -> {result['done']}")
        return result

    say("== 1. Esselunga's ORDERS arrives")
    raw = (HERE / "ORDERS_ESS-AMB-001.edi").read_text(encoding="utf-8")
    say("  DTM+137:04/11/2026 and QTY+21:6.000 (six packs or six thousand?)")
    step = receive_order(erp, raw, source_name="ORDERS_ESS-AMB-001.edi", caller=tap.messages("fix_parse"))
    fix = next((c for c in tap.calls if c["step"] == "fix_parse"), None)
    say(f"== 2. Grok proposes a fix ({label})")
    if fix:
        try:
            changes = json.loads(fix["answer"]).get("changes") if isinstance(fix["answer"], str) else fix["answer"].get("changes")
        except (ValueError, AttributeError):
            changes = None
        for c in changes or []:
            say(f"  {c.get('segment')}: {c.get('before')} -> {c.get('after')} ({c.get('why')})")
    if step["step"] == "manual_edi":
        say("  Grok's fix was not safe enough: a person types the EDI")
        clean = json.loads((HERE / "grok_recorded.json").read_text())["fix_parse"]["corrected_edi"]
        step = person(step["case_id"], "Giulia, order desk", "Called Esselunga: 6,000 packs, ordered on 4 Nov",
                      manual_edi=clean)["result"]
    say("== 3. A person confirms the order")
    confirmed = person(step["case_id"], "Giulia, order desk", "Grok read 6.000 as six thousand: matches Esselunga's usual size")
    order = erp.order("ESS-AMB-001")
    qty = order["lines"][0]["qty_confirmed"] if order else None
    say(f"  ORDRSP {confirmed.get('ordrsp')} sent: {qty:g} packs of Arborio 1 kg" if qty else "  order not confirmed")
    if not order or order["status"] != "ready_to_ship":
        return {"stopped_at": "order", "grok_calls": tap.calls, "people": people}

    say("== 4. Shipping")
    warehouse.register_trucks(erp, [{"truck_id": "TRUCK-PV-07", "plate": "GH732KL", "destination": "CeDi Melzo",
                                     "pallet_capacity": 33, "max_payload_kg": 24000}])
    plan = warehouse.plan_truck_loads(erp, ["ESS-AMB-001"])
    pallets = warehouse.create_picking_list(erp, "ESS-AMB-001")
    warehouse.verify_scans(erp, "ESS-AMB-001", [{"pallet_id": p["pallet_id"], "gtin": p["gtin"], "batch": p["batch"],
                                                 "qty": p["qty"], "truck_id": "TRUCK-PV-07"} for p in pallets])
    warehouse.confirm_loading(erp, "ESS-AMB-001")
    sent = warehouse.authorize_dispatch(erp, "ESS-AMB-001", ship_date="2026-11-05")
    inv = invoice_shipment(erp, sent["desadv_ref"], invoice_date="2026-11-05")
    rec = reconcile_and_send(erp, "ESS-AMB-001", caller=tap.messages("explain_flags"))
    say(f"  {len(pallets)} pallets on {plan['planned'][0]['truck_id']}, {sent['desadv_ref']}, invoice {inv['invoice_ref']} "
        f"€{inv['total']:,.2f}: reconciliation {rec['report']['status']}, invoice {rec['status']}")

    say("== 5. At the dock")
    record_delivery(erp, sent["desadv_ref"], signed_by="Esselunga CeDi Melzo", when="2026-11-06",
                    note="ultimo bancale schiacciato: 240 pz danneggiati")
    gap = record_receiving_advice(erp, (HERE / "RECADV_ESS-AMB-001.edi").read_text(encoding="utf-8"))
    say(f"  DDT signed with a reservation; RECADV: {gap['exceptions'][0]['explanation'] if gap['exceptions'] else 'all accepted'}")

    say(f"== 6. Esselunga's claim, and Grok's verdict ({label})")
    claim = handle_claim(erp, (HERE / "claim_email.txt").read_text(encoding="utf-8"), out_dir=out,
                         source_name="claim_email.txt", read_caller=tap.read_claim(),
                         verdict_caller=tap.verdict(), received_on=date(2026, 11, 7),
                         issue_date=date(2026, 11, 7))
    v = claim["verdict"]
    say(f"  Grok read: order {v['claim']['order_ref']}, {v['claim']['claim_type']}, "
        f"{v['claim']['quantity']} packs, €{v['claim']['amount']}")
    say(f"  Grok proposes: {v['decision']} €{v['amount']}; sources: "
        f"{', '.join(p['source']['ref'] for p in v['points'])}")
    if v.get("amount_notes"):
        say(f"  code corrected Grok's figures: {'; '.join(v['amount_notes'])}")
    if claim["status"] == "awaiting_person":
        person(claim["case_id"], "Sara, credit desk", "Crushed pallet is on the signed DDT and the RECADV")
    else:
        say("  nothing unclear: no person needed")
    final = erp.claim(claim["claim_id"])
    outcome = final.get("outcome") or {}
    say(f"  outcome: {outcome.get('kind')} {outcome.get('credit_note_number') or ''} €{outcome.get('amount')}")

    say("== 7. The trace")
    c = chain(erp, "ESS-AMB-001")
    say(render(c))
    problems = gaps(erp)
    say("  every output links back to its source" if not problems else f"  untraceable: {problems}")
    return {"order_qty": qty, "invoice_total": inv["total"], "claim_status": final["status"],
            "outcome": outcome.get("kind"), "credit": outcome.get("amount"), "people": people,
            "grok_calls": [{"step": x["step"], "live": x["live"]} for x in tap.calls], "trace_gaps": problems,
            "out_dir": str(out)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="An ambiguous order through Grok, a person, shipping and a claim")
    parser.add_argument("--live", action="store_true", help="call Grok for real")
    parser.add_argument("--me", action="store_true", help="you approve each person step at the terminal")
    parser.add_argument("--db", default=":memory:")
    args = parser.parse_args(argv)
    res = run(live=args.live, me=args.me, db=args.db)
    print(f"\nGrok calls: {len(res['grok_calls'])} ({'live' if args.live else 'recorded'}); "
          f"person decisions: {len(res['people'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
