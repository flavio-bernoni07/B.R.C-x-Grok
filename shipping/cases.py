"""Exception cases for the Shipping row: Grok proposes, Python validates, an employee
approves, the action runs once, a recheck says whether it worked.

Rebuilt from Nicola's v0.5.0 write-up. There is no euro threshold: every proposed
resolution is approved by an employee in the case's role. A validated proposal also
appears in the shared sign-off queue (core/signoff.py), so one desk lists all rows.

Never allowed, whoever proposes it: releasing a quality hold, unblocking dispatch,
issuing an invoice or a credit note, sending a message, editing an amount, ignoring
truck capacity or a delivery window.
"""

from __future__ import annotations

import json
from typing import Any

from agent import grok
from core import signoff
from core.erp import Erp, now_iso
from core.stock import batches
from shipping import warehouse as wh

FORBIDDEN = {"RELEASE_QUALITY_HOLD", "UNBLOCK_DISPATCH", "ISSUE_INVOICE", "ISSUE_CREDIT_NOTE", "SEND_MESSAGE",
             "EDIT_AMOUNT", "IGNORE_CAPACITY", "IGNORE_DELIVERY_WINDOW"}

# type -> (department, role, candidate actions)
TEMPLATES: dict[str, tuple[str, str, list[str]]] = {
    "TRUCK_CAPACITY_EXCEEDED": ("logistics", "transport_planner", ["PLAN_ON_TRUCK"]),
    "TRUCK_WEIGHT_EXCEEDED": ("logistics", "transport_planner", ["PLAN_ON_TRUCK"]),
    "DELIVERY_WINDOW": ("logistics", "transport_planner", ["PLAN_ON_TRUCK"]),
    "DESTINATION_MISMATCH": ("logistics", "transport_planner", ["PLAN_ON_TRUCK"]),
    "TRUCK_UNAVAILABLE": ("logistics", "transport_planner", ["PLAN_ON_TRUCK"]),
    "NO_TRUCK": ("logistics", "transport_planner", ["PLAN_ON_TRUCK"]),
    "PLAN_MISSING_PRODUCT_DATA": ("master_data", "master_data_clerk", []),
    "WRONG_TRUCK": ("warehouse", "warehouse_lead", ["RESCAN_PALLET"]),
    "DUPLICATE_SCAN": ("warehouse", "warehouse_operator", ["IGNORE_DUPLICATE"]),
    "MISSING_PALLET": ("warehouse", "warehouse_lead", ["RESCAN_PALLET", "SHIP_WITHOUT_PALLET"]),
    "WRONG_PRODUCT": ("warehouse", "warehouse_lead", ["RESCAN_PALLET", "SHIP_WITHOUT_PALLET"]),
    "WRONG_BATCH": ("warehouse", "warehouse_lead", ["RESCAN_PALLET", "SHIP_WITHOUT_PALLET"]),
    "BAD_QUANTITY": ("warehouse", "warehouse_lead", ["RESCAN_PALLET", "SHIP_WITHOUT_PALLET"]),
    "UNKNOWN_PALLET": ("warehouse", "warehouse_lead", []),
    "QUALITY_HOLD": ("quality", "quality_manager", ["REPLACE_BATCH", "SHIP_WITHOUT_PALLET"]),
    "SHORT_SHIPMENT": ("customer_service", "account_manager", ["BACKORDER", "CONFIRM_SHORT_SHIPMENT"]),
    "INVOICE_QUANTITY": ("finance", "billing_clerk", ["HOLD_INVOICE"]),
    "INVOICE_PRICE": ("finance", "billing_clerk", ["HOLD_INVOICE"]),
    "RECEIVING_GAP": ("customer_service", "account_manager", ["REQUEST_POD"]),
    "ORDER_NOT_READY": ("customer_service", "account_manager", []),
}


def ensure_schema(erp: Erp) -> None:
    wh.ensure_schema(erp)
    erp.db.executescript(
        "CREATE TABLE IF NOT EXISTS si_exception_cases (case_id TEXT PRIMARY KEY, data TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS si_proposals (proposal_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, data TEXT NOT NULL);"
    )
    erp.db.commit()


def _save(erp: Erp, case: dict[str, Any]) -> None:
    erp.db.execute("INSERT OR REPLACE INTO si_exception_cases(case_id, data) VALUES(?, ?)",
                   (case["case_id"], json.dumps(case, default=str)))
    erp.db.commit()


def _history(case: dict[str, Any], actor: str, event: str, detail: Any = None) -> None:
    case["history"].append({"at": now_iso(), "actor": actor, "event": event, "detail": detail})


def view_exception_case(erp: Erp, case_id: str) -> dict[str, Any] | None:
    ensure_schema(erp)
    row = erp._one("SELECT data FROM si_exception_cases WHERE case_id = ?", (case_id,))
    return json.loads(row["data"]) if row else None


def open_exception_cases(erp: Erp, exceptions: list[dict[str, Any]]) -> list[str]:
    """One case per exception, from its template. Candidates start unselected."""
    ensure_schema(erp)
    ids = []
    for exc in exceptions:
        department, role, actions = TEMPLATES.get(exc["type"], ("operations", "operations_lead", []))
        case = {
            "case_id": erp.next_id("si_case", "CASE-"), "exception_id": exc["exception_id"], "type": exc["type"],
            "severity": exc["severity"], "order_ref": exc.get("order_ref"), "truck_id": exc.get("truck_id"),
            "pallet_id": exc.get("pallet_id"), "shipment_ref": exc.get("shipment_ref"),
            "invoice_ref": exc.get("invoice_ref"), "explanation": exc["explanation"], "evidence": exc.get("evidence"),
            "financial_impact_eur": exc.get("financial_impact_eur"), "department": department, "role": role,
            "possible_actions": [{"action": a, "selected": False} for a in actions + ["REQUEST_CLARIFICATION"]],
            "approval_required": f"an employee with role {role}", "assigned_to": None, "status": "open",
            "proposals": [], "approved_proposal": None, "signoff_case": None, "executed": False, "history": [],
        }
        _history(case, "code", "opened", exc["explanation"])
        _save(erp, case)
        erp.log("code", "shipping.case_opened", exc.get("order_ref"), source_doc=case["case_id"], detail=exc["type"])
        ids.append(case["case_id"])
    return ids


def assign_exception(erp: Erp, case_id: str, *, employee_id: str, role: str) -> dict[str, Any]:
    case = view_exception_case(erp, case_id)
    if role != case["role"]:
        raise ValueError(f"{case_id} needs role {case['role']}, not {role}")
    case["assigned_to"] = {"employee_id": employee_id, "role": role}
    _history(case, "code", "assigned", employee_id)
    _save(erp, case)
    return case


def grok_case_package(erp: Erp, case_id: str) -> dict[str, Any]:
    """Read-only facts for Grok: the case, what may be proposed, and the data to check it against."""
    case = view_exception_case(erp, case_id)
    order = erp.order(case["order_ref"]) if case.get("order_ref") else None
    facts: dict[str, Any] = {"order": order}
    if case["type"] in {"TRUCK_CAPACITY_EXCEEDED", "TRUCK_WEIGHT_EXCEEDED", "DELIVERY_WINDOW", "DESTINATION_MISMATCH",
                        "TRUCK_UNAVAILABLE", "NO_TRUCK"} and order:
        facts["load"] = wh.order_load(erp, case["order_ref"])
        facts["trucks"] = wh.trucks(erp)
    if case.get("pallet_id"):
        facts["pallet"] = erp._one("SELECT * FROM si_pallets WHERE pallet_id = ?", (case["pallet_id"],))
        if facts["pallet"]:
            facts["released_batches"] = batches(erp, facts["pallet"]["gtin"], "released")
    return {
        "task": "shipping.case_resolution",
        "case": {k: case[k] for k in ("case_id", "type", "severity", "order_ref", "truck_id", "pallet_id",
                                      "explanation", "evidence", "financial_impact_eur", "role")},
        "allowed_actions": [a["action"] for a in case["possible_actions"]],
        "never_allowed": sorted(FORBIDDEN),
        "facts": facts,
        "answer_format": {"actions": [{"action": "one of allowed_actions", "params": {}}],
                          "rationale": "string", "confidence": "0..1"},
        "params_by_action": {"PLAN_ON_TRUCK": {"truck_id": "string"},
                             "REPLACE_BATCH": {"batch": "a released batch of the same product"},
                             "RESCAN_PALLET": {}, "SHIP_WITHOUT_PALLET": {}, "IGNORE_DUPLICATE": {},
                             "BACKORDER": {"date": "YYYY-MM-DD"}, "CONFIRM_SHORT_SHIPMENT": {},
                             "HOLD_INVOICE": {}, "REQUEST_POD": {}, "REQUEST_CLARIFICATION": {"question": "string"}},
    }


def _check_action(erp: Erp, case: dict[str, Any], action: dict[str, Any]) -> str | None:
    """None if the action is valid; otherwise why not."""
    code, params = action.get("action"), action.get("params") or {}
    if code in FORBIDDEN:
        return f"{code} is never allowed"
    if code not in {a["action"] for a in case["possible_actions"]}:
        return f"{code} is not an option for a {case['type']} case"
    if code == "PLAN_ON_TRUCK":
        t = wh.truck(erp, params.get("truck_id") or "")
        if not t:
            return f"truck {params.get('truck_id')!r} does not exist"
        problems = wh.truck_fits(erp, t, wh.order_load(erp, case["order_ref"]))
        if problems:
            return f"truck {t['truck_id']} does not fit: {', '.join(problems)}"
    if code == "REPLACE_BATCH":
        pallet = erp._one("SELECT * FROM si_pallets WHERE pallet_id = ?", (case.get("pallet_id"),))
        b = erp._one("SELECT * FROM batches WHERE batch = ?", (params.get("batch"),))
        if not pallet or not b:
            return "pallet or batch not found"
        if b["status"] != "released" or b["gtin"] != pallet["gtin"]:
            return f"batch {b['batch']} is {b['status']} or another product"
        if b["qty"] - wh._reserved(erp, b["batch"]) < pallet["qty"]:
            return f"batch {b['batch']} has not enough free stock for {pallet['qty']:g}"
    if code == "BACKORDER" and not params.get("date"):
        return "BACKORDER needs a date"
    return None


def submit_resolution_proposal(erp: Erp, case_id: str, proposal: dict[str, Any], *, by: str = "grok") -> dict[str, Any]:
    """Validate every action. One failing action rejects the whole proposal."""
    case = view_exception_case(erp, case_id)
    actions = proposal.get("actions") or []
    problems = [p for p in (_check_action(erp, case, a) for a in actions) if p] if actions else ["no actions"]
    pid = erp.next_id("si_proposal", "PRP-")
    record = {"proposal_id": pid, "case_id": case_id, "by": by, "actions": actions,
              "rationale": proposal.get("rationale"), "confidence": proposal.get("confidence"),
              "status": "rejected" if problems else "validated", "problems": problems, "at": now_iso()}
    erp.db.execute("INSERT INTO si_proposals(proposal_id, case_id, data) VALUES(?,?,?)", (pid, case_id, json.dumps(record)))
    case["proposals"].append(pid)
    _history(case, by, f"proposal_{record['status']}", problems or actions)
    if not problems:
        for opt in case["possible_actions"]:
            opt["selected"] = opt["action"] in {a["action"] for a in actions}
        case["status"] = "awaiting_approval"
        case["signoff_case"] = signoff.request(
            erp, row="shipping", kind="exception_case", subject_ref=case_id,
            title=f"{case['type'].replace('_', ' ').capitalize()} on {case['order_ref']}: approve {', '.join(a['action'] for a in actions)}?",
            proposal={"exception_case": case_id, "proposal_id": pid, "actions": actions, "rationale": record["rationale"]},
            reasons=[f"Shipping rule: an employee with role {case['role']} approves every exception resolution"],
        )
    _save(erp, case)
    return record


def proposal(erp: Erp, proposal_id: str) -> dict[str, Any] | None:
    row = erp._one("SELECT data FROM si_proposals WHERE proposal_id = ?", (proposal_id,))
    return json.loads(row["data"]) if row else None


def propose_with_grok(erp: Erp, case_id: str, *, caller: Any = None) -> dict[str, Any] | None:
    """Send the package to Grok and hand its answer to the validator. None without a key."""
    if caller is None and not grok.has_key():
        return None
    package = grok_case_package(erp, case_id)
    messages = [
        {"role": "system", "content": (
            "You resolve shipping exception cases for the Riso Scotti back office. Choose only from "
            "allowed_actions, never from never_allowed, with the params listed. Use only trucks and batches "
            "present in the facts. Return one JSON object in answer_format.")},
        {"role": "user", "content": json.dumps(package, default=str)},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        if not isinstance(payload.get("actions"), list) or not payload["actions"]:
            return ["actions must be a non-empty list"]
        case = view_exception_case(erp, case_id)
        return [p for p in (_check_action(erp, case, a) for a in payload["actions"]) if p]

    try:
        payload = grok.chat_json(messages, task="shipping.case_resolution", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        return None
    return submit_resolution_proposal(erp, case_id, payload, by="grok")


def decide_resolution(erp: Erp, case_id: str, *, employee_id: str, role: str, decision: str, reason: str) -> dict[str, Any]:
    """approve | reject | clarify, by an employee in the case's role. Approving runs nothing."""
    case = view_exception_case(erp, case_id)
    if role != case["role"]:
        raise ValueError(f"{case_id} needs role {case['role']}, not {role}")
    if decision not in {"approve", "reject", "clarify"}:
        raise ValueError("decision is approve, reject or clarify")
    if decision in {"approve", "reject"} and case["status"] != "awaiting_approval":
        raise ValueError(f"{case_id} has no validated proposal to {decision}")
    last = case["proposals"][-1] if case["proposals"] else None
    if decision == "clarify":
        case["status"] = "clarification_requested"
    elif decision == "approve":
        case["status"] = "approved"
        case["approved_proposal"] = last
    else:
        case["status"] = "open"
    if case.get("signoff_case") and decision in {"approve", "reject"}:
        signoff.decide(erp, case["signoff_case"], approve=decision == "approve", by=employee_id, reason=reason)
    _history(case, f"person:{employee_id}", decision, reason)
    _save(erp, case)
    return case


def execute_resolution(erp: Erp, case_id: str) -> dict[str, Any]:
    """Run the approved actions once. A second call returns DUPLICATE_EXECUTION."""
    case = view_exception_case(erp, case_id)
    if case["executed"]:
        return {"status": "DUPLICATE_EXECUTION", "case_id": case_id}
    if case["status"] != "approved":
        raise ValueError(f"{case_id} is {case['status']}: approve a proposal first")
    record = proposal(erp, case["approved_proposal"])
    done = []
    for action in record["actions"]:
        code, params = action["action"], action.get("params") or {}
        if code == "PLAN_ON_TRUCK":
            done.append(wh.plan_truck_loads(erp, [case["order_ref"]], only_truck_id=params["truck_id"]))
        elif code == "REPLACE_BATCH":
            erp.db.execute("UPDATE si_pallets SET batch = ?, status = 'picked' WHERE pallet_id = ?",
                           (params["batch"], case["pallet_id"]))
            done.append({"pallet": case["pallet_id"], "batch": params["batch"]})
        elif code == "RESCAN_PALLET":
            erp.db.execute("UPDATE si_pallets SET status = 'picked' WHERE pallet_id = ?", (case["pallet_id"],))
            done.append({"pallet": case["pallet_id"], "status": "picked, waiting for a scan"})
        elif code == "SHIP_WITHOUT_PALLET":
            erp.db.execute("UPDATE si_pallets SET status = 'excluded' WHERE pallet_id = ?", (case["pallet_id"],))
            done.append({"pallet": case["pallet_id"], "status": "excluded"})
        elif code == "BACKORDER":
            order = erp.order(case["order_ref"])
            notes = dict(order["notes"] or {})
            notes.setdefault("backorders", []).append({"date": params["date"], "case": case_id})
            erp.set_order(case["order_ref"], notes=notes)
            done.append({"backorder": params["date"]})
        elif code == "HOLD_INVOICE" and case.get("invoice_ref"):
            erp.set_invoice_status(case["invoice_ref"], "held")
            done.append({"invoice": case["invoice_ref"], "status": "held"})
        else:
            done.append({"recorded": code})
    erp.db.commit()
    case["executed"] = True
    case["status"] = "executed"
    _history(case, "code", "executed", done)
    _save(erp, case)
    erp.log("code", "shipping.case_executed", case["order_ref"], source_doc=case_id, detail=done)
    return {"status": "EXECUTED", "case_id": case_id, "results": done}


def recheck_exception_case(erp: Erp, case_id: str) -> dict[str, Any]:
    """Set resolved or unresolved from the stored facts. Changes no stock and no document."""
    case = view_exception_case(erp, case_id)
    resolved = False
    pallet = erp._one("SELECT * FROM si_pallets WHERE pallet_id = ?", (case.get("pallet_id"),)) if case.get("pallet_id") else None
    t = case["type"]
    if t in {"TRUCK_CAPACITY_EXCEEDED", "TRUCK_WEIGHT_EXCEEDED", "DELIVERY_WINDOW", "DESTINATION_MISMATCH",
             "TRUCK_UNAVAILABLE", "NO_TRUCK"}:
        resolved = wh.manifest_for_order(erp, case["order_ref"]) is not None
    elif pallet is not None:
        if t == "QUALITY_HOLD":
            resolved = pallet["status"] == "excluded" or wh._batch_status(erp, pallet["batch"]) == "released" and \
                pallet["status"] in {"picked", "verified", "loaded", "dispatched"}
        else:
            resolved = pallet["status"] in {"verified", "loaded", "dispatched", "excluded"}
    elif t == "DUPLICATE_SCAN":
        resolved = case["executed"]
    case["resolution"] = "resolved" if resolved else "unresolved"
    _history(case, "code", "rechecked", case["resolution"])
    _save(erp, case)
    return {"case_id": case_id, "resolution": case["resolution"]}
