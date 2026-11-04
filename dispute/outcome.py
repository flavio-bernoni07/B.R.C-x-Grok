"""Dispute outcome — TD04 credit note (accept/partial) or evidence reply (reject).

Credit notes are built with the `a38` package (Truelite/python-a38 on PyPI).
Amounts and document refs are taken only from the verdict / facts / claim —
this module never invents euro totals.

EDI: also emits a minimal INVOIC with BGM 381 as a credit hint alongside TD04.

Sign-off: there is no euro threshold. When a verdict is ambiguous (needs_sign_off),
nothing is written for the retailer until a person approves it: pass approved_by
(CLI: --approved-by NAME). Until then the outcome is awaiting_sign_off.

Usage:
  python -m dispute.outcome --verdict data/disputes/verdicts/01_shortage_accept.json
  python -m dispute.outcome --verdict ... --out-dir data/disputes/outcomes
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from io import StringIO
from pathlib import Path
from typing import Any

import a38

from dispute.pull_facts import pull_facts
from dispute.verdict import VerdictDecision, parse_verdict_payload

DEFAULT_OUT_DIR = (
    Path(__file__).resolve().parents[1] / "data" / "disputes" / "outcomes"
)
DEFAULT_VERDICTS = (
    Path(__file__).resolve().parents[1] / "data" / "disputes" / "verdicts"
)

# Demo master data for FatturaPA (synthetic).
SELLER = {
    "id_paese": "IT",
    "id_codice": "01652220180",
    "denominazione": "Riso Scotti S.p.A.",
    "indirizzo": "Via Angelo Scotti 2",
    "cap": "27100",
    "comune": "Pavia",
    "provincia": "PV",
    "nazione": "IT",
    "regime_fiscale": "RF01",
}
BUYER_DEFAULT = {
    "id_paese": "IT",
    "id_codice": "09876543210",
    "denominazione": "Retailer GDO S.p.A.",
    "indirizzo": "Via Demo 1",
    "cap": "20100",
    "comune": "Milano",
    "provincia": "MI",
    "nazione": "IT",
    "codice_destinatario": "XXXXXXX",
}

# Food staple / rice often uses reduced VAT in demos; keep explicit and documented.
DEMO_ALIQUOTA_IVA = Decimal("4.00")


@dataclass
class DisputeOutcome:
    kind: str  # credit_note | reject_reply | awaiting_sign_off
    decision: str
    amount: float | None
    order_ref: str | None
    invoice_ref: str | None
    credit_note_number: str | None
    paths: dict[str, str] = field(default_factory=dict)
    evidence_refs: list[dict[str, str]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    sign_off_reasons: list[str] = field(default_factory=list)
    approved_by: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def load_verdict_json(path: Path | str) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Verdict JSON must be an object: {path}")
    return payload


def _money(value: float | Decimal | None) -> Decimal:
    if value is None:
        raise ValueError("amount is required for credit note")
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _slug(value: str | None, fallback: str = "case") -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "-", (value or fallback)).strip("-")
    return text[:48] or fallback


def _buyer_from_facts(facts: dict[str, Any] | None) -> dict[str, str]:
    buyer = dict(BUYER_DEFAULT)
    if not facts:
        return buyer
    order = facts.get("order") or {}
    customer = order.get("customer")
    if customer:
        buyer["denominazione"] = str(customer)
    return buyer


def _credit_note_number(order_ref: str | None, issue_date: date) -> str:
    stem = _slug(order_ref, "DISP").upper().replace("-", "")[:12]
    return f"NC-{issue_date.strftime('%Y%m%d')}-{stem}"


def _line_description(verdict: dict[str, Any], facts: dict[str, Any] | None) -> str:
    claim = verdict.get("claim") or {}
    product = claim.get("product") or (((facts or {}).get("order") or {}).get("lines") or [{}])[0].get(
        "product"
    )
    summary = verdict.get("summary") or "Dispute credit"
    qty = claim.get("quantity")
    amount = verdict.get("amount")
    bits = ["Credit note"]
    if product:
        bits.append(str(product))
    if qty is not None:
        bits.append(f"qty {qty}")
    if amount is not None:
        bits.append(f"€ {amount}")
    bits.append(str(summary))
    return " — ".join(bits)[:200]


def build_td04_xml(
    *,
    amount: Decimal,
    invoice_ref: str | None,
    invoice_date: str | None,
    order_ref: str | None,
    credit_note_number: str,
    issue_date: date,
    description: str,
    causale: list[str],
    buyer: dict[str, str],
) -> str:
    """Build a FatturaPA TD04 (nota di credito) XML via a38."""
    cedente = a38.CedentePrestatore(
        a38.DatiAnagraficiCedentePrestatore(
            a38.IdFiscaleIVA(SELLER["id_paese"], SELLER["id_codice"]),
            anagrafica=a38.Anagrafica(denominazione=SELLER["denominazione"]),
            regime_fiscale=SELLER["regime_fiscale"],
        ),
        a38.Sede(
            indirizzo=SELLER["indirizzo"],
            cap=SELLER["cap"],
            comune=SELLER["comune"],
            provincia=SELLER["provincia"],
            nazione=SELLER["nazione"],
        ),
    )
    cessionario = a38.CessionarioCommittente(
        a38.DatiAnagraficiCessionarioCommittente(
            a38.IdFiscaleIVA(buyer["id_paese"], buyer["id_codice"]),
            anagrafica=a38.Anagrafica(denominazione=buyer["denominazione"]),
        ),
        a38.Sede(
            indirizzo=buyer["indirizzo"],
            cap=buyer["cap"],
            comune=buyer["comune"],
            provincia=buyer["provincia"],
            nazione=buyer["nazione"],
        ),
    )

    # Net the credit so document total equals verdict amount (demo VAT inclusive split).
    # imponibile + IVA = amount; IVA = amount * 4/104 for 4% food demo rate.
    gross = amount
    aliquota = DEMO_ALIQUOTA_IVA
    imponibile = (gross * Decimal("100") / (Decimal("100") + aliquota)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    # Single line at imponibile with qty 1 so line total matches imponibile.
    f = a38.FatturaPrivati12()
    f.fattura_elettronica_header.dati_trasmissione.update(
        a38.IdTrasmittente(SELLER["id_paese"], SELLER["id_codice"]),
        codice_destinatario=buyer.get("codice_destinatario") or "XXXXXXX",
    )
    f.fattura_elettronica_header.cedente_prestatore = cedente
    f.fattura_elettronica_header.cessionario_committente = cessionario

    body = f.fattura_elettronica_body[0]
    body.dati_generali.dati_generali_documento = a38.DatiGeneraliDocumento(
        tipo_documento="TD04",
        divisa="EUR",
        data=issue_date,
        numero=credit_note_number,
        causale=causale[:10] or ["Dispute credit note"],
    )
    if invoice_ref:
        linked = a38.DatiFattureCollegate(
            id_documento=str(invoice_ref)[:20],
        )
        if invoice_date:
            try:
                y, m, d = (int(x) for x in invoice_date[:10].split("-"))
                linked.data = date(y, m, d)
            except ValueError:
                pass
        if order_ref:
            linked.codice_commessa_convenzione = str(order_ref)[:100]
        body.dati_generali.dati_fatture_collegate = [linked]

    body.dati_beni_servizi.add_dettaglio_linee(
        descrizione=description[:1000],
        quantita=1,
        unita_misura="NR",
        prezzo_unitario=str(imponibile),
        aliquota_iva=str(aliquota),
    )
    body.dati_beni_servizi.build_dati_riepilogo()
    body.build_importo_totale_documento()

    tree = f.build_etree()
    # Stick a demo comment in via string wrap after serialize.
    buf = StringIO()
    tree.write(buf, encoding="unicode", xml_declaration=True)
    xml = buf.getvalue()
    banner = (
        "<!-- DEMO FatturaPA TD04 nota di credito generated by dispute.outcome "
        f"(a38); credit {gross} EUR; not for SDI transmission -->\n"
    )
    if xml.startswith("<?xml"):
        end = xml.find("?>") + 2
        return xml[:end] + "\n" + banner + xml[end:].lstrip("\n")
    return banner + xml


def build_edi_invoic_381(
    *,
    amount: Decimal,
    invoice_ref: str | None,
    order_ref: str | None,
    credit_note_number: str,
    issue_date: date,
) -> str:
    """Minimal EDIFACT INVOIC credit hint (BGM 381). Demo stub, not a full UNA/UNB envelope."""
    lines = [
        "UNA:+.? '",
        f"UNH+1+INVOIC:D:96A:UN'",
        f"BGM+381+{credit_note_number}+9'",
        f"DTM+137:{issue_date.strftime('%Y%m%d')}:102'",
        f"MOA+86:{amount}:EUR'",
    ]
    if invoice_ref:
        lines.append(f"RFF+IV:{invoice_ref}'")
    if order_ref:
        lines.append(f"RFF+ON:{order_ref}'")
    lines.append("UNT+{n}+1'".format(n=len(lines)))
    return "\n".join(lines) + "\n"


_SOURCE_LABELS = {
    "order": "Purchase order",
    "desadv": "Despatch advice (DESADV)",
    "invoice": "Invoice",
    "ddt": "Delivery note (DDT)",
    "pod": "Proof of delivery",
    "warehouse_event": "Warehouse / gate event",
    "contract": "Contract / promo clause",
    "threeway": "Order–ship–invoice match",
    "damage_photo": "Damage photo / portal",
    "other": "Supporting document",
}


def _evidence_label(kind: str | None) -> str:
    key = (kind or "other").strip().lower()
    if key.startswith("proof:"):
        key = key.split(":", 1)[1]
    return _SOURCE_LABELS.get(key, "Supporting document")


def build_reject_reply(
    *,
    verdict: dict[str, Any],
    facts: dict[str, Any] | None,
) -> str:
    """Retailer-facing evidence reply; refs/amounts filled from verdict/facts by code."""
    claim = verdict.get("claim") or {}
    order_ref = claim.get("order_ref") or ((facts or {}).get("order") or {}).get("order_ref")
    invoice_ref = claim.get("invoice_ref") or ((facts or {}).get("invoice") or {}).get(
        "invoice_ref"
    )
    customer = ((facts or {}).get("order") or {}).get("customer") or "Customer"
    summary = verdict.get("summary") or ""

    # Collect unique evidence by document ref (retailer-facing; skip internal playbook rules).
    entries: list[tuple[str, str, str]] = []  # (dedupe_key, label, body)

    def add_entry(kind: str | None, ref: str | None, body: str) -> None:
        if (kind or "").lower() == "playbook":
            return
        ref_s = (ref or "").strip() or "n/a"
        text = body.strip()
        if not text:
            return
        key = f"{(kind or '').lower()}|{ref_s.lower()}"
        entries.append((key, _evidence_label(kind), f"{ref_s} — {text}"))

    for point in verdict.get("points") or []:
        if not isinstance(point, dict):
            continue
        src = point.get("source") or {}
        amt = point.get("amount")
        parts = [str(point.get("text") or "").strip()]
        if src.get("detail"):
            parts.append(str(src["detail"]).strip())
        if amt is not None:
            parts.append(f"amount € {amt}")
        add_entry(src.get("kind"), src.get("ref"), "; ".join(p for p in parts if p))

    if facts:
        for proof in facts.get("proofs") or []:
            add_entry(proof.get("kind"), proof.get("ref"), str(proof.get("summary") or ""))
        desadv = facts.get("desadv") or {}
        if desadv.get("desadv_ref"):
            add_entry(
                "desadv",
                desadv.get("desadv_ref"),
                f"linked to order {desadv.get('order_ref')}",
            )
        threeway = facts.get("threeway") or {}
        for line in threeway.get("lines") or []:
            if not line.get("reason"):
                continue
            add_entry(
                "threeway",
                str(line.get("item_code") or "line"),
                f"{line.get('reason')} "
                f"(ordered {line.get('ordered')}, shipped/received {line.get('received')}, "
                f"invoiced {line.get('invoiced')})",
            )

    seen_keys: set[str] = set()
    unique_lines: list[str] = []
    for key, label, body in entries:
        if key in seen_keys:
            continue
        seen_keys.add(key)
        unique_lines.append(f"- {label}: {body}")

    invoice_bit = f" / invoice {invoice_ref}" if invoice_ref else ""
    body = f"""Subject: Your claim — decision REJECT — order {order_ref or 'n/a'}{invoice_bit}

Dear {customer},

Thank you for your claim. We compared it with our purchase order, despatch advice (DESADV),
invoice, and warehouse / delivery evidence.

Our decision: we are not issuing a credit note on this claim.
No credit amount applies.

Why:
{summary}

Evidence we relied on:
{chr(10).join(unique_lines) if unique_lines else '- (no document refs available)'}

If you can provide a clearer order/invoice reference, a formal receiving count, or additional
proof, please reply and we will re-open the review.

Kind regards,
Riso Scotti — Supplier dispute desk
"""
    return body


def resolve_facts(
    verdict: dict[str, Any],
    *,
    facts: dict[str, Any] | None = None,
    facts_path: Path | str | None = None,
    catalog_path: Path | str | None = None,
) -> dict[str, Any] | None:
    if facts is not None:
        return facts
    if facts_path:
        return json.loads(Path(facts_path).read_text(encoding="utf-8"))
    claim = verdict.get("claim")
    if isinstance(claim, dict) and (claim.get("order_ref") or claim.get("invoice_ref")):
        from dispute.claim_reader import parse_extraction

        extraction = parse_extraction(claim)
        return pull_facts(extraction, catalog_path=catalog_path).to_dict()
    return None


def emit_outcome(
    verdict: dict[str, Any],
    *,
    facts: dict[str, Any] | None = None,
    out_dir: Path | str | None = None,
    issue_date: date | None = None,
    approved_by: str | None = None,
) -> DisputeOutcome:
    """Write TD04 (+ EDI) or reject reply under out_dir; return structured result.

    An ambiguous verdict (needs_sign_off) writes nothing for the retailer until
    approved_by names the person who signed it off.
    """
    known = list(verdict.get("known_amounts") or [])
    claim_for_checks = verdict.get("claim") if isinstance(verdict.get("claim"), dict) else None
    parsed = parse_verdict_payload(
        verdict,
        known_amounts=[float(x) for x in known],
        claim=claim_for_checks,
        facts=facts,
    )
    decision = parsed.decision
    out = Path(out_dir) if out_dir else DEFAULT_OUT_DIR
    out.mkdir(parents=True, exist_ok=True)

    claim = verdict.get("claim") or {}
    order_ref = claim.get("order_ref") or ((facts or {}).get("order") or {}).get("order_ref")
    invoice_ref = claim.get("invoice_ref") or ((facts or {}).get("invoice") or {}).get("invoice_ref")
    invoice_date = ((facts or {}).get("invoice") or {}).get("invoice_date")
    issue = issue_date or date.today()
    stem = _slug(order_ref or invoice_ref, decision.value)

    evidence_refs = []
    for point in parsed.points:
        evidence_refs.append(
            {
                "kind": point.source.kind,
                "ref": point.source.ref,
                "detail": point.source.detail,
                "text": point.text,
            }
        )

    reasons: list[str] = []
    for reason in list(verdict.get("sign_off_reasons") or []) + parsed.sign_off_reasons:
        if reason not in reasons:
            reasons.append(reason)
    if verdict.get("needs_sign_off") is True and not reasons:
        reasons.append("the verdict was marked as needing sign-off")
    approver = (approved_by or "").strip() or None

    if reasons and approver is None:
        meta_path = out / f"{stem}_outcome.json"
        result = DisputeOutcome(
            kind="awaiting_sign_off",
            decision=decision.value,
            amount=parsed.amount,
            order_ref=order_ref,
            invoice_ref=invoice_ref,
            credit_note_number=None,
            paths={},
            evidence_refs=evidence_refs,
            notes=["Nothing sent to the retailer: a person must approve this verdict first."],
            sign_off_reasons=reasons,
        )
        meta_path.write_text(
            json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        result.paths["outcome_json"] = str(meta_path)
        return result

    notes: list[str] = []
    if approver:
        notes.append(f"Signed off by {approver}.")
    if decision is VerdictDecision.REJECT:
        reply = build_reject_reply(verdict=verdict, facts=facts)
        reply_path = out / f"{stem}_reject_reply.txt"
        reply_path.write_text(reply, encoding="utf-8")
        meta_path = out / f"{stem}_outcome.json"
        result = DisputeOutcome(
            kind="reject_reply",
            decision=decision.value,
            amount=parsed.amount,
            order_ref=order_ref,
            invoice_ref=invoice_ref,
            credit_note_number=None,
            paths={"reject_reply": str(reply_path)},
            evidence_refs=evidence_refs,
            notes=notes,
            sign_off_reasons=reasons,
            approved_by=approver,
        )
        meta_path.write_text(
            json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        result.paths["outcome_json"] = str(meta_path)
        return result

    # accept | partial → credit note
    if parsed.amount is None:
        raise ValueError(
            f"Cannot emit TD04 for decision={decision.value}: verdict.amount is null"
        )
    amount = _money(parsed.amount)
    cn_number = _credit_note_number(order_ref, issue)
    causale = [
        f"Dispute {decision.value} order {order_ref or 'n/a'}",
        (parsed.summary or "")[:200],
    ]
    buyer = _buyer_from_facts(facts)
    xml = build_td04_xml(
        amount=amount,
        invoice_ref=invoice_ref,
        invoice_date=invoice_date,
        order_ref=order_ref,
        credit_note_number=cn_number,
        issue_date=issue,
        description=_line_description(verdict, facts),
        causale=causale,
        buyer=buyer,
    )
    # Ensure TD04 marker present
    if "TD04" not in xml:
        raise RuntimeError("Generated XML missing TipoDocumento TD04")

    xml_path = out / f"{stem}_TD04.xml"
    xml_path.write_text(xml, encoding="utf-8")
    edi = build_edi_invoic_381(
        amount=amount,
        invoice_ref=invoice_ref,
        order_ref=order_ref,
        credit_note_number=cn_number,
        issue_date=issue,
    )
    edi_path = out / f"{stem}_INVOIC_381.edi"
    edi_path.write_text(edi, encoding="utf-8")
    notes.append("Generated with a38 (PyPI package name for Truelite/python-a38).")
    notes.append(f"Demo VAT rate {DEMO_ALIQUOTA_IVA}% applied so net+IVA ≈ verdict amount.")

    result = DisputeOutcome(
        kind="credit_note",
        decision=decision.value,
        amount=float(amount),
        order_ref=order_ref,
        invoice_ref=invoice_ref,
        credit_note_number=cn_number,
        paths={"td04_xml": str(xml_path), "edi_invoic_381": str(edi_path)},
        evidence_refs=evidence_refs,
        notes=notes,
        sign_off_reasons=reasons,
        approved_by=approver,
    )
    meta_path = out / f"{stem}_outcome.json"
    meta_path.write_text(
        json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    result.paths["outcome_json"] = str(meta_path)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Emit Dispute TD04 credit note or reject evidence reply from a verdict JSON."
    )
    parser.add_argument(
        "--verdict",
        type=Path,
        required=True,
        help="Path to verdict JSON (sample under data/disputes/verdicts/)",
    )
    parser.add_argument(
        "--facts",
        type=Path,
        default=None,
        help="Optional facts JSON; if omitted, pull_facts runs from embedded claim when present",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help="Directory for generated TD04 / reply / outcome JSON",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=None,
        help="Mini ERP catalog when pulling facts locally",
    )
    parser.add_argument(
        "--issue-date",
        type=str,
        default=None,
        help="Credit note issue date YYYY-MM-DD (default: today)",
    )
    parser.add_argument(
        "--approved-by",
        type=str,
        default=None,
        help="Name of the person who signed off an ambiguous verdict",
    )
    args = parser.parse_args(argv)

    try:
        verdict = load_verdict_json(args.verdict)
        facts = resolve_facts(
            verdict,
            facts_path=args.facts,
            catalog_path=args.catalog,
        )
        issue = None
        if args.issue_date:
            y, m, d = (int(x) for x in args.issue_date.split("-"))
            issue = date(y, m, d)
        outcome = emit_outcome(
            verdict,
            facts=facts,
            out_dir=args.out_dir,
            issue_date=issue,
            approved_by=args.approved_by,
        )
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(outcome.to_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
