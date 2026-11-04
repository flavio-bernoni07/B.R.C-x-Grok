"""Dispute outcome — TD04 credit note (accept/partial) or evidence reply (reject).

Credit notes are built with the `a38` package (Truelite/python-a38 on PyPI).
Amounts and document refs are taken only from the verdict / facts / claim —
this module never invents euro totals.

EDI: also emits a minimal INVOIC with BGM 381 as a credit hint alongside TD04.

Sign-off web UI is out of scope (shared Playbook threshold only).

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
    kind: str  # credit_note | reject_reply
    decision: str
    amount: float | None
    order_ref: str | None
    invoice_ref: str | None
    credit_note_number: str | None
    paths: dict[str, str] = field(default_factory=dict)
    evidence_refs: list[dict[str, str]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

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
    product = claim.get("product") or (facts or {}).get("order", {}).get("lines", [{}])[0].get(
        "product"
    )
    summary = verdict.get("summary") or "Dispute credit"
    if product:
        return f"Credit note — {product}: {summary}"[:200]
    return f"Credit note — {summary}"[:200]


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


def build_reject_reply(
    *,
    verdict: dict[str, Any],
    facts: dict[str, Any] | None,
) -> str:
    """Evidence reply — prose template; all refs/amounts filled from verdict/facts by code."""
    claim = verdict.get("claim") or {}
    order_ref = claim.get("order_ref") or ((facts or {}).get("order") or {}).get("order_ref")
    invoice_ref = claim.get("invoice_ref") or ((facts or {}).get("invoice") or {}).get(
        "invoice_ref"
    )
    customer = ((facts or {}).get("order") or {}).get("customer") or "Customer"
    decision = verdict.get("decision")
    summary = verdict.get("summary") or ""
    evidence_lines: list[str] = []
    for point in verdict.get("points") or []:
        if not isinstance(point, dict):
            continue
        src = point.get("source") or {}
        amt = point.get("amount")
        amt_bit = f" (€ {amt})" if amt is not None else ""
        evidence_lines.append(
            f"- [{src.get('kind', 'other')}] {src.get('ref', 'n/a')}: "
            f"{point.get('text', '')}{amt_bit}"
            + (f" — {src.get('detail')}" if src.get("detail") else "")
        )
    if facts:
        for proof in facts.get("proofs") or []:
            evidence_lines.append(
                f"- [proof:{proof.get('kind')}] {proof.get('ref')}: {proof.get('summary')}"
            )
        desadv = facts.get("desadv") or {}
        if desadv.get("desadv_ref"):
            evidence_lines.append(
                f"- [desadv] {desadv.get('desadv_ref')}: order {desadv.get('order_ref')}"
            )
        threeway = facts.get("threeway") or {}
        for line in threeway.get("lines") or []:
            if line.get("reason"):
                evidence_lines.append(
                    f"- [threeway] {line.get('item_code')}: {line.get('status')} — {line.get('reason')}"
                    f" (qty_var={line.get('qty_variance')}, val_var={line.get('value_variance')})"
                )

    # De-dupe while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for line in evidence_lines:
        if line in seen:
            continue
        seen.add(line)
        unique.append(line)

    amount = verdict.get("amount")
    amount_line = (
        f"Proposed credit: none (decision={decision})."
        if amount is None
        else f"No credit note issued. Verdict amount field was € {amount} but decision is {decision}."
    )

    body = f"""Subject: Dispute decision — REJECT — order {order_ref or 'n/a'} / invoice {invoice_ref or 'n/a'}

Dear {customer},

We reviewed your claim against our order, DESADV, invoice and warehouse evidence.

Decision: REJECT
{amount_line}

Summary:
{summary}

Evidence cited:
{chr(10).join(unique) if unique else '- (no evidence lines)'}

This reply was assembled by dispute.outcome from verdict + facts document refs.
Document numbers and amounts above are copied from those structures (not invented).
Sign-off desk / Playbook follow-up is out of scope for this module.

Kind regards,
Riso Scotti — Dispute desk (demo)
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
) -> DisputeOutcome:
    """Write TD04 (+ EDI) or reject reply under out_dir; return structured result."""
    known = list(verdict.get("known_amounts") or [])
    parsed = parse_verdict_payload(verdict, known_amounts=[float(x) for x in known])
    decision = parsed.decision
    out = Path(out_dir) if out_dir else DEFAULT_OUT_DIR
    out.mkdir(parents=True, exist_ok=True)

    claim = verdict.get("claim") or {}
    order_ref = claim.get("order_ref") or (facts or {}).get("order", {}).get("order_ref")
    invoice_ref = claim.get("invoice_ref") or (facts or {}).get("invoice", {}).get("invoice_ref")
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

    notes: list[str] = []
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
            notes=["Sign-off UI out of scope; escalate via Playbook if needs_sign_off."],
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
    notes.append("Sign-off UI out of scope.")

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
