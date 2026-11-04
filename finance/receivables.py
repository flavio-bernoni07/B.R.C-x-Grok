"""Receivables: what each retailer paid, what it deducted, and what is still open.

Italian retailers often pay less than the invoice and explain why in a remittance
advice (EANCOM REMADV). Each deduction is one of two things:

- a credit note we already issued (a dispute we accepted): it is matched and closed;
- anything else (a promo contribution, a penalty, a shortage we never agreed): it
  becomes a Dispute claim on its own, with the remittance as its source document,
  so Grok proposes a verdict and a person decides when it is unclear.

Payment terms: 60 days from the invoice date, the legal maximum for non-perishable
agri-food products (D.Lgs. 198/2021). Adjustment codes here are demo codes.

    python -m finance.receivables data/demo.sqlite      # aging and open deductions
"""

from __future__ import annotations

import argparse
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

from core.erp import Erp, now_iso

PAYMENT_TERMS_DAYS = 60
EPS = 0.01
# Demo adjustment codes -> Dispute claim types. Anything else (a promo contribution PC,
# a listing fee, an unexplained short payment) is "other": not in the Playbook, so a person decides.
CLAIM_TYPE_BY_CODE = {"PR": "pricing", "SH": "shortage", "DM": "damage", "LT": "late_delivery"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS payments (payment_id TEXT PRIMARY KEY, remittance_ref TEXT, payer_gln TEXT,
    value_date TEXT, total REAL, source_doc TEXT);
CREATE TABLE IF NOT EXISTS payment_lines (payment_id TEXT NOT NULL, invoice_ref TEXT NOT NULL, amount_due REAL,
    amount_paid REAL NOT NULL);
CREATE TABLE IF NOT EXISTS deductions (deduction_id TEXT PRIMARY KEY, payment_id TEXT, invoice_ref TEXT NOT NULL,
    amount REAL NOT NULL, reason_code TEXT, note TEXT, status TEXT NOT NULL, credit_ref TEXT, claim_id TEXT,
    created_at TEXT);
"""


def ensure_schema(erp: Erp) -> None:
    erp.db.executescript(SCHEMA)
    erp.db.commit()


def parse_remadv(text: str) -> dict[str, Any]:
    """BGM (remittance number), DTM+209 (value date), NAD+PR (payer), MOA+9 (total paid);
    per invoice DOC+380 with MOA+12 (due) and MOA+9 (paid); AJT (adjustment) + MOA+5 + FTX."""
    out: dict[str, Any] = {"remittance_ref": None, "value_date": None, "payer_gln": None, "total": None, "docs": []}
    doc: dict[str, Any] | None = None
    adj: dict[str, Any] | None = None
    for raw in text.replace("\n", "").split("'"):
        seg = raw.strip()
        if not seg:
            continue
        parts = seg.split("+")
        tag = parts[0]
        if tag == "BGM" and len(parts) > 2:
            out["remittance_ref"] = parts[2]
        elif tag == "DTM" and len(parts) > 1 and parts[1].split(":")[0] in {"209", "137"}:
            d = parts[1].split(":")[1]
            iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            if parts[1].startswith("209") or not out["value_date"]:
                out["value_date"] = iso
        elif tag == "NAD" and len(parts) > 2 and parts[1] == "PR":
            out["payer_gln"] = parts[2].split(":")[0]
        elif tag == "DOC" and len(parts) > 2:
            doc = {"doc_type": parts[1], "invoice_ref": parts[2], "due": None, "paid": None, "adjustments": []}
            adj = None
            out["docs"].append(doc)
        elif tag == "AJT" and doc is not None and len(parts) > 1:
            adj = {"code": parts[1], "amount": None, "note": ""}
            doc["adjustments"].append(adj)
        elif tag == "FTX" and adj is not None:
            adj["note"] = (adj["note"] + " " + parts[-1].replace(":", " ")).strip()
        elif tag == "MOA" and len(parts) > 1:
            qual, _, value = parts[1].partition(":")
            amount = float(value.split(":")[0])
            if adj is not None and qual == "5":
                adj["amount"] = amount
            elif doc is not None and qual == "12":
                doc["due"] = amount
            elif doc is not None and qual == "9":
                doc["paid"] = amount
            elif doc is None and qual == "9":
                out["total"] = amount
    if not out["remittance_ref"] or not out["docs"]:
        raise ValueError("REMADV without a number or documents")
    for d in out["docs"]:
        if d["paid"] is None:
            raise ValueError(f"REMADV {out['remittance_ref']}: no paid amount for {d['invoice_ref']}")
    return out


def issued_credits(erp: Erp, invoice_ref: str) -> list[dict[str, Any]]:
    """Credit notes we wrote against this invoice (accepted or partial disputes)."""
    out = []
    for claim in erp.claims():
        outcome = claim.get("outcome") or {}
        if claim["invoice_ref"] == invoice_ref and outcome.get("kind") == "credit_note":
            out.append({"claim_id": claim["claim_id"], "credit_ref": outcome.get("credit_note_number"),
                        "amount": float(outcome.get("amount") or 0)})
    return out


def _applied_credit_refs(erp: Erp, invoice_ref: str) -> set[str]:
    rows = erp._all("SELECT credit_ref FROM deductions WHERE invoice_ref = ? AND status = 'matched_credit'", (invoice_ref,))
    return {r["credit_ref"] for r in rows}


def balance(erp: Erp, invoice_ref: str) -> dict[str, Any]:
    ensure_schema(erp)
    inv = erp.invoice(invoice_ref)
    if not inv:
        raise KeyError(invoice_ref)
    paid = erp._one("SELECT COALESCE(SUM(amount_paid), 0) AS s FROM payment_lines WHERE invoice_ref = ?", (invoice_ref,))["s"]
    ded = erp._all("SELECT status, SUM(amount) AS s FROM deductions WHERE invoice_ref = ? GROUP BY status", (invoice_ref,))
    by = {r["status"]: r["s"] for r in ded}
    settled = by.get("matched_credit", 0) + by.get("accepted", 0)
    open_balance = round(inv["total"] - paid - settled, 2)
    due = (date.fromisoformat(inv["invoice_date"]) + timedelta(days=PAYMENT_TERMS_DAYS)).isoformat()
    return {"invoice_ref": invoice_ref, "total": inv["total"], "paid": round(paid, 2), "credits": by.get("matched_credit", 0),
            "deductions_accepted": by.get("accepted", 0), "deductions_disputed": round(by.get("disputed", 0) + by.get("claim_opened", 0), 2),
            "open": open_balance, "due_date": due}


def record_remittance(
    erp: Erp,
    text: str,
    *,
    out_dir: Path | str,
    verdict_caller: Callable[[list[dict[str, str]]], dict[str, Any]] | None = None,
    received_on: date | None = None,
) -> dict[str, Any]:
    """Apply a REMADV: post the payments, match deductions to our credit notes, and
    turn every other deduction into a Dispute claim."""
    from agent import grok
    from dispute.service import handle_claim

    ensure_schema(erp)
    advice = parse_remadv(text)
    doc_id = erp.add_document("REMADV", advice["remittance_ref"], text)
    return apply_remittance(erp, advice, doc_id, out_dir=out_dir, verdict_caller=verdict_caller,
                            received_on=received_on)


def apply_remittance(
    erp: Erp,
    advice: dict[str, Any],
    doc_id: str,
    *,
    out_dir: Path | str,
    verdict_caller: Callable[[list[dict[str, str]]], dict[str, Any]] | None = None,
    received_on: date | None = None,
) -> dict[str, Any]:
    """Post a parsed remittance (from REMADV, or read from an email by Grok and checked by code)."""
    from agent import grok
    from dispute.service import handle_claim

    ensure_schema(erp)
    payment_id = erp.next_id("payment", "PAY-")
    erp.db.execute("INSERT INTO payments(payment_id, remittance_ref, payer_gln, value_date, total, source_doc) "
                   "VALUES(?,?,?,?,?,?)", (payment_id, advice["remittance_ref"], advice["payer_gln"],
                                           advice["value_date"], advice["total"], doc_id))
    erp.log("retailer", "finance.remittance_received", advice["remittance_ref"], source_doc=doc_id, detail=advice)
    results: list[dict[str, Any]] = []
    for d in advice["docs"]:
        inv = erp.invoice(d["invoice_ref"])
        if not inv:
            results.append({"invoice_ref": d["invoice_ref"], "problem": "unknown invoice"})
            erp.log("code", "finance.unknown_invoice", advice["remittance_ref"], source_doc=doc_id, detail=d)
            continue
        erp.db.execute("INSERT INTO payment_lines(payment_id, invoice_ref, amount_due, amount_paid) VALUES(?,?,?,?)",
                       (payment_id, inv["invoice_ref"], d["due"], d["paid"]))
        erp.db.commit()
        erp.log("retailer", "finance.payment_posted", inv["order_ref"], source_doc=doc_id,
                detail={"invoice": inv["invoice_ref"], "paid": d["paid"]})
        short = round((d["due"] if d["due"] is not None else inv["total"]) - d["paid"], 2)
        adjustments = list(d["adjustments"])
        explained = round(sum(a["amount"] or 0 for a in adjustments), 2)
        if short - explained > EPS:
            adjustments.append({"code": "UNEXPLAINED", "amount": round(short - explained, 2),
                                "note": "short payment with no reason given"})
        credits = [c for c in issued_credits(erp, inv["invoice_ref"])
                   if c["credit_ref"] not in _applied_credit_refs(erp, inv["invoice_ref"])]
        line = {"invoice_ref": inv["invoice_ref"], "paid": d["paid"], "deductions": []}
        for a in adjustments:
            if not a["amount"]:
                continue
            ded_id = erp.next_id("deduction", "DED-")
            match = next((c for c in credits if abs(c["amount"] - a["amount"]) <= EPS), None)
            if match:
                credits.remove(match)
                erp.db.execute("INSERT INTO deductions VALUES(?,?,?,?,?,?,?,?,?,?)",
                               (ded_id, payment_id, inv["invoice_ref"], a["amount"], a["code"], a["note"],
                                "matched_credit", match["credit_ref"], match["claim_id"], now_iso()))
                erp.db.commit()
                erp.log("code", "finance.credit_matched", inv["order_ref"], source_doc=doc_id,
                        detail={"deduction": ded_id, "credit_note": match["credit_ref"], "amount": a["amount"]})
                line["deductions"].append({"deduction_id": ded_id, "amount": a["amount"], "status": "matched_credit",
                                           "credit_note": match["credit_ref"]})
                continue
            extraction = {"order_ref": inv["order_ref"], "invoice_ref": inv["invoice_ref"], "product": None,
                          "quantity": None, "amount": a["amount"],
                          "claim_type": CLAIM_TYPE_BY_CODE.get(a["code"], "other"),
                          "confidence": 1.0,
                          "raw_notes": f"Deduction {a['code']} on remittance {advice['remittance_ref']}: {a['note']}"}
            caller = verdict_caller
            if caller is None and not grok.has_key():
                caller = lambda _m: {"decision": "reject", "amount": None, "confidence": 0.0, "needs_sign_off": True,  # noqa: E731
                                     "summary": "Grok is not available: a person decides this deduction.", "points": []}
            claim = handle_claim(
                erp, f"Remittance {advice['remittance_ref']} deducts €{a['amount']:.2f} from invoice "
                f"{inv['invoice_ref']} (order {inv['order_ref']}). Reason given: {a['code']} {a['note']}",
                out_dir=out_dir, source_name=f"REMADV {advice['remittance_ref']}",
                extraction=extraction, verdict_caller=caller, received_on=received_on)
            erp.db.execute("INSERT INTO deductions VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (ded_id, payment_id, inv["invoice_ref"], a["amount"], a["code"], a["note"],
                            "claim_opened", None, claim["claim_id"], now_iso()))
            erp.db.commit()
            erp.log("code", "finance.deduction_to_dispute", inv["order_ref"], source_doc=doc_id,
                    detail={"deduction": ded_id, "claim": claim["claim_id"], "amount": a["amount"]})
            if claim["status"] == "closed":  # decided at once: settle the deduction now that it exists
                settle_deduction(erp, claim["claim_id"], accepted=claim["verdict"]["decision"] in {"accept", "partial"})
            line["deductions"].append({"deduction_id": ded_id, "amount": a["amount"], "status": "claim_opened",
                                       "claim_id": claim["claim_id"], "claim_status": claim["status"],
                                       "case_id": claim.get("case_id")})
        line["balance"] = balance(erp, inv["invoice_ref"])
        results.append(line)
    return {"payment_id": payment_id, "remittance_ref": advice["remittance_ref"], "doc_id": doc_id, "lines": results}


def settle_deduction(erp: Erp, claim_id: str, *, accepted: bool) -> None:
    """After the Dispute decision: an accepted deduction closes the gap, a rejected one stays to recover."""
    erp.db.execute("UPDATE deductions SET status = ? WHERE claim_id = ? AND status = 'claim_opened'",
                   ("accepted" if accepted else "disputed", claim_id))
    erp.db.commit()
    erp.log("code", "finance.deduction_" + ("accepted" if accepted else "disputed"), claim_id)


def aging(erp: Erp, as_of: date) -> dict[str, Any]:
    ensure_schema(erp)
    buckets = {"not due": 0.0, "1-30": 0.0, "31-60": 0.0, "61-90": 0.0, "90+": 0.0}
    rows = []
    for inv in erp.invoices():
        if inv["status"] != "sent":
            continue
        b = balance(erp, inv["invoice_ref"])
        if b["open"] <= EPS:
            continue
        late = (as_of - date.fromisoformat(b["due_date"])).days
        key = "not due" if late <= 0 else "1-30" if late <= 30 else "31-60" if late <= 60 else "61-90" if late <= 90 else "90+"
        buckets[key] += b["open"]
        rows.append(b | {"days_late": max(late, 0)})
    open_deductions = erp._all("SELECT * FROM deductions WHERE status IN ('claim_opened', 'disputed') ORDER BY deduction_id")
    return {"as_of": as_of.isoformat(), "buckets": {k: round(v, 2) for k, v in buckets.items()},
            "open_total": round(sum(buckets.values()), 2), "invoices": rows, "open_deductions": open_deductions}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Receivables aging and open deductions")
    parser.add_argument("db")
    parser.add_argument("--as-of", default=date.today().isoformat())
    args = parser.parse_args(argv)
    a = aging(Erp(args.db), date.fromisoformat(args.as_of))
    sys.stdout.write(f"Open receivables on {a['as_of']}: €{a['open_total']:,.2f}\n")
    for k, v in a["buckets"].items():
        sys.stdout.write(f"  {k:>8}: €{v:,.2f}\n")
    for d in a["open_deductions"]:
        sys.stdout.write(f"  deduction {d['deduction_id']} on {d['invoice_ref']}: €{d['amount']:,.2f} "
                         f"{d['reason_code']} {d['note']} ({d['status']}, claim {d['claim_id']})\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def on_claim_closed(erp: Erp, claim_id: str, decision: str) -> None:
    """Called by Dispute when a claim closes; settles the deduction it came from, if any."""
    ensure_schema(erp)
    if erp._one("SELECT 1 AS x FROM deductions WHERE claim_id = ? AND status = 'claim_opened'", (claim_id,)):
        settle_deduction(erp, claim_id, accepted=decision in {"accept", "partial"})


def read_remittance_email(erp: Erp, text: str, *, caller: Any = None) -> dict[str, Any] | None:
    """Grok reads a messy remittance email into the REMADV shape. Code checks that every
    invoice exists and every amount is written in the email; otherwise None (a person reads it)."""
    from agent import grok
    from agent.checks import amount_in_text

    if caller is None and not grok.has_key():
        return None
    messages = [
        {"role": "system", "content": (
            "You read remittance advices that retailers send to Riso Scotti. Return one JSON object: "
            "{\"remittance_ref\": string or null, \"value_date\": \"YYYY-MM-DD\" or null, \"docs\": [{\"invoice_ref\": string, "
            "\"due\": number or null, \"paid\": number, \"adjustments\": [{\"code\": \"CN|PR|SH|DM|LT|PC|OTHER\", "
            "\"amount\": number, \"note\": string}]}]}. Copy references and amounts exactly as written; never compute new ones.")},
        {"role": "user", "content": text},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        problems = []
        docs = payload.get("docs")
        if not isinstance(docs, list) or not docs:
            return ["docs must be a non-empty list"]
        for d in docs:
            if not erp.invoice(str(d.get("invoice_ref"))):
                problems.append(f"invoice {d.get('invoice_ref')} does not exist")
            figures = [d.get("due"), d.get("paid")] + [a.get("amount") for a in d.get("adjustments") or []]
            missing = [x for x in figures if x is not None and not amount_in_text(float(x), text)]
            if missing:
                problems.append(f"amounts not written in the email: {missing}")
        return problems

    try:
        payload = grok.chat_json(messages, task="finance.read_remittance", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        return None
    return {"remittance_ref": payload.get("remittance_ref") or "EMAIL", "value_date": payload.get("value_date"),
            "payer_gln": None, "total": None,
            "docs": [{"doc_type": "380", "invoice_ref": d["invoice_ref"], "due": d.get("due"), "paid": float(d["paid"]),
                      "adjustments": [{"code": a.get("code") or "OTHER", "amount": float(a["amount"]),
                                       "note": a.get("note") or ""} for a in d.get("adjustments") or []]}
                     for d in payload["docs"]]}
