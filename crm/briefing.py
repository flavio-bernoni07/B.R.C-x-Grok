"""Three lines for each case on the sign-off desk (grok-agent-dec.md, CRM use 3):
what happened, what is proposed, and the one question that blocks it, with links.

Code writes the three lines from the case; with a key, Grok may rewrite them more
plainly, but every figure must already be in the code's version.
"""

from __future__ import annotations

from typing import Any

from agent import grok
from agent.checks import unknown_amounts
from core.erp import Erp


def _code_brief(erp: Erp, case: dict[str, Any]) -> dict[str, Any]:
    p = case["proposal"] or {}
    row, kind, ref = case["row"], case["kind"], case["subject_ref"]
    links: list[str] = []
    if row == "order":
        order = erp.order(ref) or {}
        retailer = (erp.retailer(order.get("buyer_gln")) or {}).get("name") or order.get("buyer_gln")
        lines = ", ".join(f"{(erp.product(gtin=l['gtin']) or {}).get('item_code', l['gtin'])} "
                          f"{(l['qty_confirmed'] if l['qty_confirmed'] is not None else l['qty_ordered']):g} at "
                          f"€{l['unit_price']}" for l in order.get("lines") or [])
        links = [x for x in (order.get("source_doc"),) if x]
        if kind == "confirm":
            happened = f"{retailer} ordered {lines}. Stock and contract price checks passed."
            if p.get("backorders"):
                happened += f" Stock was short: {len(p['backorders'])} line(s) split, rest later."
            return {"what_happened": happened, "proposal": "Send the ORDRSP and hand the order to Shipping.",
                    "question": f"Confirm order {ref} as shown?", "links": links}
        return {"what_happened": f"{retailer} ordered {lines}; {'; '.join(case['reasons'])}.",
                "proposal": "Send the drafted mail, then type the corrected EDI or park the order.",
                "question": f"Which price or EDI do we accept for {ref}?", "links": links}
    if row == "shipping":
        if kind == "exception_case":
            actions = ", ".join(a["action"] for a in p.get("actions") or [])
            return {"what_happened": case["title"], "proposal": f"{actions}: {p.get('rationale') or ''}".strip(" :"),
                    "question": f"Approve {actions}?", "links": [p.get("exception_case", "")]}
        report = p.get("report") or {}
        return {"what_happened": p.get("explanation") or case["title"],
                "proposal": "Hold the invoice until it is corrected.",
                "question": f"Correct the invoice for {ref}, or send it as is? Causes: {', '.join(report.get('causes') or [])}",
                "links": p.get("invoices") or []}
    if row == "dispute":
        v = p.get("verdict") or {}
        claim = v.get("claim") or {}
        sources = ", ".join(pt["source"]["ref"] for pt in v.get("points") or [])
        amount = f" €{v['amount']:.2f}" if v.get("amount") is not None else ""
        return {"what_happened": f"{claim.get('claim_type', 'A')} claim on {claim.get('order_ref') or 'an unknown order'}"
                                 f"{' for €' + format(claim['amount'], '.2f') if claim.get('amount') else ''}.",
                "proposal": f"{v.get('decision', '?').capitalize()}{amount}. Sources: {sources or 'none'}.",
                "question": (case["reasons"] or ["Decide this claim?"])[0].capitalize() + ": agree with Grok?",
                "links": [ref]}
    if row == "inbox":
        return {"what_happened": f"A message arrived; it reads as {p.get('lane')}.",
                "proposal": f"Send it to {p.get('lane')}.",
                "question": f"Which lane? ({'; '.join(case['reasons'])})", "links": [ref]}
    return {"what_happened": case["title"], "proposal": "", "question": "; ".join(case["reasons"]), "links": []}


def brief(erp: Erp, case_id: str, *, caller: Any = None) -> dict[str, Any]:
    case = erp.signoff(case_id)
    if not case:
        raise KeyError(case_id)
    base = _code_brief(erp, case) | {"case_id": case_id, "row": case["row"], "reasons": case["reasons"], "by": "code"}
    if caller is None and not grok.has_key():
        return base
    text = f"What happened: {base['what_happened']}\nProposal: {base['proposal']}\nQuestion: {base['question']}"
    messages = [
        {"role": "system", "content": (
            "Rewrite this sign-off briefing for a busy back-office employee in plain English, three short lines. "
            "Keep every figure and reference exactly; add none. Return one JSON object: "
            '{"what_happened": string, "proposal": string, "question": string}.')},
        {"role": "user", "content": text},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        out = " ".join(str(payload.get(k) or "") for k in ("what_happened", "proposal", "question"))
        extra = unknown_amounts(out, text)
        return [f"figures not in the case: {sorted(extra)}"] if extra else []

    try:
        payload = grok.chat_json(messages, task="crm.briefing", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        return base
    return base | {k: payload[k] for k in ("what_happened", "proposal", "question") if payload.get(k)} | {"by": "grok"}
