"""Order row on the shared Mini ERP: ORDERS in, sign-off, ORDRSP and hand-over out.

    receive_order()      parse -> stock -> price, with Grokbot loops; stops at a person
    confirm_order()      the person approves: ORDRSP is written, the hand-over is returned
    resolve_price_case() the person types a manual EDI (back to Parse) or parks the order

The order-dec.md rules hold: Grok's fixes go back through the code checks, a
wrong price never reaches the confirm step, and a person confirms every order.
"""

from __future__ import annotations

from typing import Any

from core import signoff
from core.erp import Erp
from core.stock import available_to_promise, next_ready_date
from order import grokbot
from order.availability import ErpAvailabilityProvider
from order.contract import SupplyContract, load_contract
from order.ordrsp import build_ordrsp
from order.parser import OrderLine, ParsedOrder
from order.pipeline import PipelineStatus, run_order_pipeline

MAX_ROUNDS = 3


def order_to_edi(order: ParsedOrder, qty_overrides: dict[int, float] | None = None) -> str:
    """Write a clean ORDERS message from a parsed order (used after a Grokbot change)."""
    overrides = qty_overrides or {}
    seg = ["UNH+1+ORDERS:D:96A:UN'", f"BGM+220+{order.order_number}+9'"]
    if order.order_date:
        seg.append(f"DTM+137:{order.order_date}:102'")
    if order.buyer_gln:
        seg.append(f"NAD+BY+{order.buyer_gln}::9'")
    if order.supplier_gln:
        seg.append(f"NAD+SU+{order.supplier_gln}::9'")
    for idx, line in enumerate(order.lines, start=1):
        n = line.line_no or idx
        qty = overrides.get(n, line.quantity)
        seg.append(f"LIN+{n}++{line.gtin}:EN'")
        seg.append(f"QTY+21:{int(qty) if qty is not None and float(qty).is_integer() else qty}'")
        if line.unit_price is not None:
            seg.append(f"PRI+AAA:{line.unit_price}:CT'")
    seg.append("UNS+S'")
    seg.append(f"UNT+{len(seg) + 1}+1'")
    return "\n".join(seg)


def _parsed_from_erp(order: dict[str, Any]) -> ParsedOrder:
    lines = [
        OrderLine(
            line_no=line["line_no"],
            gtin=line["gtin"],
            quantity=line["qty_confirmed"] if line["qty_confirmed"] is not None else line["qty_ordered"],
            quantity_raw=None,
            unit_price=line["unit_price"],
            unit_price_raw=None,
        )
        for line in order["lines"]
    ]
    return ParsedOrder(
        order_number=order["order_ref"],
        order_date=(order["order_date"] or "").replace("-", "") or None,
        buyer_gln=order["buyer_gln"],
        supplier_gln=order["supplier_gln"],
        lines=lines,
    )


def receive_order(
    erp: Erp,
    raw_edi: str,
    *,
    source_name: str = "ORDERS",
    contract: SupplyContract | None = None,
    caller: Any = None,
) -> dict[str, Any]:
    """Run one ORDERS message until it needs a person. Returns what happened."""
    active_contract = contract or load_contract()
    doc_id = erp.add_document("ORDERS", None, raw_edi, path=source_name)
    erp.log("retailer", "orders.received", None, source_doc=doc_id)
    provider = ErpAvailabilityProvider(erp)

    edi = raw_edi
    notes: list[str] = []
    person_reasons: list[str] = []
    backorders: list[dict[str, Any]] = []
    original_qty: dict[int, float] = {}
    last_flags: list[dict[str, Any]] = []

    for _round in range(MAX_ROUNDS + 1):
        result = run_order_pipeline(edi, availability=provider, contract=active_contract)
        parsed = result.parse.order if result.parse else None
        ref = parsed.order_number if parsed and parsed.order_number else None
        if parsed and not original_qty:
            original_qty = {(l.line_no or i): l.quantity for i, l in enumerate(parsed.lines, 1) if l.quantity is not None}

        if result.status is PipelineStatus.AWAIT_GROK_PARSE:
            last_flags = [f.to_dict() for f in result.parse.flags] if result.parse else []
            fix = grokbot.propose_parse_fix(edi, last_flags, caller=caller)
            if fix and _round < MAX_ROUNDS:
                erp.log("grok", "order.parse_fix", ref, source_doc=doc_id, detail=fix.get("changes"))
                changed = ", ".join(f"{c.get('segment')}: {c.get('before')} -> {c.get('after')}" for c in fix.get("changes") or [])
                notes.append(f"Grok corrected the EDI ({changed}); the parser read it again.")
                person_reasons.append(f"Grok corrected the EDI: {changed or 'see changes'}")
                edi = fix["corrected_edi"]
                continue
            case_id = signoff.request(
                erp, row="order", kind="manual_edi", subject_ref=ref or doc_id,
                title=f"Order {ref or '(no number)'}: the EDI cannot be read safely",
                proposal={"flags": last_flags, "edi": edi, "options": ["manual_edi", "park_pending"]},
                reasons=["the parser could not read the EDI and Grok had no safe fix: "
                         + "; ".join(f["message"] for f in last_flags)],
            )
            if ref:
                erp.save_order(order_ref=ref, buyer_gln=parsed.buyer_gln, supplier_gln=parsed.supplier_gln,
                               order_date=parsed.order_date, lines=[l.to_dict() for l in parsed.lines],
                               status="pending_manual_edi", source_doc=doc_id, contract_id=active_contract.id,
                               notes={"flags": last_flags})
            return {"status": "awaiting_person", "case_id": case_id, "order_ref": ref, "step": "manual_edi"}

        if result.status is PipelineStatus.AWAIT_GROK_QTY:
            overrides: dict[int, float] = {}
            for idx, (line, check) in enumerate(zip(parsed.lines, result.availability), start=1):
                if check.ok:
                    continue
                product = erp.product(gtin=line.gtin) or {}
                buyer = (erp.retailer(parsed.buyer_gln) or {}).get("name") or parsed.buyer_gln or "cliente"
                next_date = next_ready_date(erp, line.gtin) if line.gtin else None
                later = available_to_promise(erp, line.gtin, next_date)["atp"] if next_date else 0.0
                proposal = grokbot.propose_qty_resolution(
                    order_ref=ref or "", gtin=line.gtin or "", product=product.get("name") or line.gtin or "",
                    buyer=buyer, ordered=line.quantity or 0, available=check.available_qty or 0,
                    next_date=next_date, later_available=later - (check.available_qty or 0), caller=caller,
                )
                if not proposal:
                    continue
                n = line.line_no or idx
                overrides[n] = proposal["now_qty"]
                if proposal["later_qty"]:
                    backorders.append({"line_no": n, "gtin": line.gtin, "qty": proposal["later_qty"],
                                       "date": proposal["later_date"]})
                erp.log(proposal["source"], "order.qty_short", ref, source_doc=doc_id, detail=proposal)
                notes.append(f"Line {n}: {proposal['action']} - {proposal['message']}")
                person_reasons.append(
                    f"stock was short on line {n}: {proposal['action']} proposed by {proposal['source']}"
                )
            if not overrides or _round >= MAX_ROUNDS:
                case_id = signoff.request(
                    erp, row="order", kind="stock_short", subject_ref=ref or doc_id,
                    title=f"Order {ref}: not enough stock and no split is possible",
                    proposal={"availability": [a.to_dict() for a in result.availability]},
                    reasons=["stock is short and code found no split or partial delivery"],
                )
                return {"status": "awaiting_person", "case_id": case_id, "order_ref": ref, "step": "stock_short"}
            edi = order_to_edi(parsed, overrides)
            continue

        if result.status is PipelineStatus.AWAIT_PRICE_HUMAN:
            mail, source = grokbot.polish_price_mail(result.draft_mail or "", caller=caller)
            erp.save_order(order_ref=ref, buyer_gln=parsed.buyer_gln, supplier_gln=parsed.supplier_gln,
                           order_date=parsed.order_date, lines=[l.to_dict() for l in parsed.lines],
                           status="pending_price", source_doc=doc_id, contract_id=active_contract.id,
                           notes={"draft_mail": mail})
            bad = [l for l in result.price_check.lines if not l.ok] if result.price_check else []
            case_id = signoff.request(
                erp, row="order", kind="price_fix", subject_ref=ref,
                title=f"Order {ref}: the price does not match contract {active_contract.id}",
                proposal={"draft_mail": mail, "mail_by": source, "grokbot": notes,
                          "price_check": result.price_check.to_dict() if result.price_check else None,
                          "options": ["manual_edi", "park_pending"]},
                reasons=[f"GTIN {l.gtin}: ordered at €{l.order_price}, contract €{l.expected_price}" for l in bad]
                or ["the price check failed"],
            )
            erp.log("code", "order.price_mismatch", ref, source_doc=doc_id, detail={"case": case_id})
            return {"status": "awaiting_person", "case_id": case_id, "order_ref": ref, "step": "price_fix"}

        if result.status is PipelineStatus.AWAIT_CONFIRM_SIGNOFF:
            lines = []
            for idx, line in enumerate(parsed.lines, start=1):
                n = line.line_no or idx
                lines.append({"line_no": n, "gtin": line.gtin, "quantity": original_qty.get(n, line.quantity),
                              "qty_confirmed": line.quantity, "unit_price": line.unit_price})
            erp.save_order(order_ref=ref, buyer_gln=parsed.buyer_gln, supplier_gln=parsed.supplier_gln,
                           order_date=parsed.order_date, lines=lines, status="awaiting_confirmation",
                           source_doc=doc_id, contract_id=active_contract.id,
                           notes={"backorders": backorders, "grokbot": notes})
            draft = build_ordrsp(parsed)
            case_id = signoff.request(
                erp, row="order", kind="confirm", subject_ref=ref,
                title=f"Confirm order {ref} before the ORDRSP goes out",
                proposal={"lines": lines, "availability": [a.to_dict() for a in result.availability],
                          "price_check": result.price_check.to_dict() if result.price_check else None,
                          "backorders": backorders, "grokbot": notes, "draft_ordrsp": draft.body},
                reasons=["Order rule: a person confirms every order before ORDRSP"] + person_reasons,
            )
            erp.log("code", "order.checks_passed", ref, source_doc=doc_id, detail={"case": case_id})
            return {"status": "awaiting_person", "case_id": case_id, "order_ref": ref, "step": "confirm"}

        raise RuntimeError(f"order pipeline error: {result.notes}")

    raise RuntimeError("order pipeline did not settle")


def confirm_order(erp: Erp, case_id: str, *, by: str, reason: str) -> dict[str, Any]:
    """The person approves the confirm sign-off: write ORDRSP, return the hand-over for Shipping."""
    case = erp.signoff(case_id)
    if not case or case["kind"] != "confirm":
        raise ValueError(f"{case_id} is not an order confirmation")
    order = erp.order(case["subject_ref"])
    for line in order["lines"]:  # another order may have been confirmed since the checks ran
        want = line["qty_confirmed"] if line["qty_confirmed"] is not None else line["qty_ordered"]
        atp = available_to_promise(erp, line["gtin"], order["order_date"])["atp"]
        if want and want > atp:
            raise ValueError(f"order {order['order_ref']}: only {atp:g} of {line['gtin']} left since the checks; "
                             "run the order again before confirming")
    signoff.decide(erp, case_id, approve=True, by=by, reason=reason)
    parsed = _parsed_from_erp(order)
    ordrsp = build_ordrsp(parsed, response_date=(order["order_date"] or None))
    doc_id = erp.add_document("ORDRSP", order["order_ref"], ordrsp.body)
    erp.set_order(order["order_ref"], status="confirmed", ordrsp_ref=doc_id)
    erp.log("code", "order.ordrsp_sent", order["order_ref"], source_doc=doc_id)
    handoff = dict(ordrsp.handoff)
    handoff.update({"ordrsp_ref": doc_id, "backorders": (order["notes"] or {}).get("backorders") or [],
                    "signoff_case": case_id})
    return handoff


def reject_order(erp: Erp, case_id: str, *, by: str, reason: str) -> None:
    case = erp.signoff(case_id)
    signoff.decide(erp, case_id, approve=False, by=by, reason=reason)
    if case and erp.order(case["subject_ref"]):
        erp.set_order(case["subject_ref"], status="rejected")


def resolve_price_case(
    erp: Erp,
    case_id: str,
    *,
    by: str,
    reason: str,
    manual_edi: str | None = None,
    caller: Any = None,
) -> dict[str, Any]:
    """Manual EDI goes back to Parse; no EDI parks the order as pending."""
    case = erp.signoff(case_id)
    if not case or case["kind"] not in {"price_fix", "manual_edi"}:
        raise ValueError(f"{case_id} is not a price or EDI case")
    if manual_edi:
        signoff.decide(erp, case_id, approve=True, by=by, reason=reason, edits={"manual_edi": True})
        return receive_order(erp, manual_edi, source_name=f"manual EDI for {case['subject_ref']}", caller=caller)
    signoff.decide(erp, case_id, approve=True, by=by, reason=reason, edits={"parked": True})
    if erp.order(case["subject_ref"]):
        erp.set_order(case["subject_ref"], status="pending")
    return {"status": "parked", "order_ref": case["subject_ref"]}
