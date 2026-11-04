"""One inbox for every retailer message (grok-agent-dec.md, CRM use 1).

Grok reads the message and says which lane it belongs to and which references it
names; code checks that each reference is written in the message and exists in
the Mini ERP. A clear message goes straight to its lane; anything unclear goes to
the sign-off desk, where a person picks the lane. Without a key, a keyword reader
written in code does the sorting, and is less sure.

Lanes: dispute (claims), order (changes to an order), shipping (delivery slots),
payment (remittances), promo (promo notices for the demand calendar), other.
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from typing import Any

from agent import grok
from core import signoff
from core.erp import Erp

LANES = ("dispute", "order", "shipping", "payment", "promo", "other")
CLEAR = 0.7
KEYWORDS = {
    "dispute": ["reclamo", "contestazione", "mancan", "danneggiat", "rott", "nota di credito", "claim", "missing",
                "damaged", "shortage", "differenza"],
    "order": ["modifica ordine", "variazione", "annull", "aggiungere", "ridurre", "cambio quantit", "change the order",
              "cancel"],
    "shipping": ["slot", "appuntamento", "spostare la consegna", "anticipare", "posticipare", "booking", "reschedule",
                 "finestra di consegna"],
    "payment": ["pagamento", "bonifico", "distinta", "remittance", "abbiamo pagato", "trattenut", "saldo"],
    "promo": ["volantino", "promozione", "promo ", "listino", "in offerta", "campagna"],
}
REF_PATTERNS = {
    "orders": re.compile(r"\b(?:ESS|RS|PO|ORD)[-/ ]?[A-Z0-9][A-Z0-9/-]{2,}\b", re.I),
    "invoices": re.compile(r"\bFT[-/ ]?\d{4}[-/ ]?\d{1,6}\b", re.I),
    "desadv": re.compile(r"\bDESADV-[A-Z0-9-]+\b", re.I),
}


def _norm(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def find_refs(erp: Erp, text: str) -> dict[str, list[str]]:
    """References written in the message that exist in the Mini ERP, in their canonical form."""
    known = {
        "orders": {_norm(o["order_ref"]): o["order_ref"] for o in erp.orders()},
        "invoices": {_norm(i["invoice_ref"]): i["invoice_ref"] for i in erp.invoices()},
        "desadv": {_norm(s["desadv_ref"]): s["desadv_ref"] for o in erp.orders() for s in erp.shipments(o["order_ref"])},
    }
    found: dict[str, list[str]] = {k: [] for k in REF_PATTERNS}
    for kind, pattern in REF_PATTERNS.items():
        for match in pattern.findall(text):
            ref = known[kind].get(_norm(match))
            if ref and ref not in found[kind]:
                found[kind].append(ref)
    return found


def classify_by_code(text: str) -> tuple[str, float]:
    low = text.lower()
    scores = {lane: sum(low.count(k) for k in words) for lane, words in KEYWORDS.items()}
    best = max(scores, key=lambda k: scores[k])
    total = sum(scores.values())
    if not total:
        return "other", 0.0
    return best, round(min(0.65, scores[best] / total * 0.65), 2)  # code alone is never "clear"


def classify(erp: Erp, text: str, *, caller: Any = None) -> dict[str, Any]:
    refs = find_refs(erp, text)
    if caller is None and not grok.has_key():
        lane, conf = classify_by_code(text)
        return {"lane": lane, "confidence": conf, "summary": text.strip().splitlines()[0][:140] if text.strip() else "",
                "refs": refs, "by": "code"}
    messages = [
        {"role": "system", "content": (
            "You sort messages that retailers send to the Riso Scotti back office. Lanes: dispute (a claim about "
            "goods, prices or an invoice), order (a change to an order), shipping (delivery slot or date), payment "
            "(a remittance or payment advice), promo (a promotion notice), other. Return one JSON object: "
            '{"lane": one lane, "refs": [references exactly as written], "summary": one sentence, "confidence": 0..1}.')},
        {"role": "user", "content": text},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        problems = []
        if payload.get("lane") not in LANES:
            problems.append(f"lane must be one of {LANES}")
        for ref in payload.get("refs") or []:
            if _norm(str(ref)) not in _norm(text):
                problems.append(f"reference {ref} is not written in the message")
        return problems

    try:
        payload = grok.chat_json(messages, task="crm.inbox", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        lane, conf = classify_by_code(text)
        return {"lane": lane, "confidence": conf, "summary": "", "refs": refs, "by": "code"}
    return {"lane": payload["lane"], "confidence": float(payload.get("confidence") or 0),
            "summary": payload.get("summary") or "", "refs": refs, "by": "grok"}


def route(erp: Erp, text: str, *, source_name: str = "email", caller: Any = None,
          out_dir: Path | str | None = None) -> dict[str, Any]:
    doc_id = erp.add_document("inbox message", None, text, path=source_name)
    erp.log("retailer", "inbox.received", None, source_doc=doc_id)
    c = classify(erp, text, caller=caller)
    has_ref = any(c["refs"].values())
    reasons = []
    if c["lane"] == "other":
        reasons.append("the message fits no lane")
    if c["confidence"] < CLEAR:
        reasons.append(f"{'the keyword reader' if c['by'] == 'code' else 'Grok'} is not sure of the lane "
                       f"({c['confidence']:.2f})")
    if c["lane"] in {"dispute", "order", "shipping", "payment"} and not has_ref:
        reasons.append("no order, invoice or DESADV named in the message exists in the Mini ERP")
    erp.log(c["by"], "inbox.classified", None, source_doc=doc_id, detail=c)
    if reasons:
        case_id = signoff.request(erp, row="inbox", kind="route", subject_ref=doc_id,
                                  title=f"Which lane for this message? ({c['summary'] or source_name})",
                                  proposal={"message": text, "lane": c["lane"], "refs": c["refs"], "by": c["by"],
                                            "lanes": list(LANES)},
                                  reasons=reasons)
        return {"status": "awaiting_person", "case_id": case_id, **c}
    return {"status": "routed", **c, "result": dispatch(erp, text, c["lane"], refs=c["refs"], out_dir=out_dir,
                                                        caller=caller)}


def dispatch(erp: Erp, text: str, lane: str, *, refs: dict[str, list[str]], out_dir: Path | str | None = None,
             caller: Any = None) -> dict[str, Any]:
    """Hand the message to its lane. Every lane keeps its own checks and its own sign-off rules."""
    out = Path(out_dir or tempfile.mkdtemp(prefix="brc-inbox-"))
    order_ref = (refs.get("orders") or [None])[0]
    if lane == "dispute":
        from dispute.service import handle_claim

        try:
            return handle_claim(erp, text, out_dir=out, source_name="inbox")
        except grok.MissingApiKeyError:
            return {"status": "needs Grok to read the claim"}
    if lane == "payment":
        from finance.receivables import apply_remittance, read_remittance_email

        advice = read_remittance_email(erp, text, caller=caller)
        if not advice:
            return {"status": "a person reads this remittance"}
        doc_id = erp.add_document("remittance email", advice["remittance_ref"], text)
        return apply_remittance(erp, advice, doc_id, out_dir=out)
    if lane in {"order", "shipping"} and order_ref:
        order = erp.order(order_ref)
        notes = dict(order["notes"] or {})
        key = "change_requests" if lane == "order" else "slot_requests"
        notes.setdefault(key, []).append(text.strip()[:500])
        erp.set_order(order_ref, notes=notes)
        if lane == "shipping":
            from shipping.warehouse import record_exception

            record_exception(erp, type="SLOT_CHANGE", severity="medium", order_ref=order_ref,
                             explanation=f"{order_ref}: the retailer asks to move the delivery slot",
                             evidence={"message": text.strip()[:500]})
        erp.log("code", f"inbox.{key}", order_ref)
        return {"status": f"noted on {order_ref} for the {'order desk' if lane == 'order' else 'transport planner'}"}
    if lane == "promo":
        erp.add_document("promo notice", None, text)
        erp.log("code", "inbox.promo_noted", None)
        return {"status": "added to the demand calendar"}
    return {"status": "filed"}
