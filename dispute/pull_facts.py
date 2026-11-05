"""Pull the facts — resolve Mini ERP docs for a claim and run matching.

Runs two matchers side by side:
- baseline threeway (vendored https://github.com/Bhavya-Dhoot/threeway in
  `dispute/_threeway_core.py`, MIT — see `dispute/THREEWAY_LICENSE.txt`)
- Shipping's improved reconciler (`shipping.reconcile.reconcile_documents`),
  which names every cause (the same code `bench.score` measures)

Join key is order_ref + item_code; DESADV lines are treated as goods received.

Usage:
  python -m dispute.pull_facts data/disputes/extractions/01_shortage.json
  python -m dispute.pull_facts --claim-json path/to/extraction.json
  python -m dispute.pull_facts --from-claim-email data/disputes/claims/01_....txt
      # needs XAI_API_KEY / GROK_API_KEY (runs claim_reader first)
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

from dispute._threeway_core import RawLine, ReconcileResult, reconcile
from dispute.claim_reader import ClaimExtraction, ClaimType, parse_extraction
from dispute.mini_erp import LookupMiss, MiniErpStore
from shipping.reconcile import explain, reconcile_documents

DEFAULT_EXTRACTIONS = (
    Path(__file__).resolve().parents[1] / "data" / "disputes" / "extractions"
)
DEFAULT_PRODUCTS = (
    Path(__file__).resolve().parents[1] / "data" / "world" / "products.json"
)


@dataclass
class ThreeWayLineView:
    po_number: str
    item_code: str
    ordered: float
    received: float
    invoiced: float
    po_price: float
    invoice_price: float
    qty_variance: float
    value_variance: float
    status: str
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ThreeWayView:
    """Serializable three-way result for the facts object."""

    lines: list[ThreeWayLineView]
    warnings: list[str]
    summary: dict[str, int]
    source: str = "vendored Bhavya-Dhoot/threeway (dispute/_threeway_core.py)"

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "summary": self.summary,
            "warnings": self.warnings,
            "lines": [line.to_dict() for line in self.lines],
        }


@dataclass
class ReconcileCauseView:
    code: str
    qty: float
    eur: float
    text: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ReconcileLineView:
    order_ref: str
    item_code: str
    ordered: float
    received: float
    invoiced: float
    po_price: float | None
    invoice_price: float | None
    status: str
    causes: list[ReconcileCauseView]

    def to_dict(self) -> dict[str, Any]:
        return {
            "order_ref": self.order_ref,
            "item_code": self.item_code,
            "ordered": self.ordered,
            "received": self.received,
            "invoiced": self.invoiced,
            "po_price": self.po_price,
            "invoice_price": self.invoice_price,
            "status": self.status,
            "causes": [c.to_dict() for c in self.causes],
        }


@dataclass
class ReconcileView:
    """Serializable shipping.reconcile result for the facts object."""

    status: str
    causes: list[str]
    notes: list[str]
    lines: list[ReconcileLineView]
    explanation: str
    source: str = "shipping.reconcile.reconcile_documents"

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "status": self.status,
            "causes": list(self.causes),
            "notes": list(self.notes),
            "explanation": self.explanation,
            "lines": [line.to_dict() for line in self.lines],
        }


@dataclass
class DisputeFacts:
    """Linked documents + baseline threeway + improved reconcile + proofs + misses."""

    claim: dict[str, Any]
    order: dict[str, Any] | None
    desadv: dict[str, Any] | None
    invoice: dict[str, Any] | None
    proofs: list[dict[str, Any]]
    threeway: ThreeWayView | None
    reconcile: ReconcileView | None = None
    misses: list[LookupMiss] = field(default_factory=list)
    catalog_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "claim": self.claim,
            "order": self.order,
            "desadv": self.desadv,
            "invoice": self.invoice,
            "proofs": self.proofs,
            "threeway": self.threeway.to_dict() if self.threeway else None,
            "reconcile": self.reconcile.to_dict() if self.reconcile else None,
            "misses": [m.to_dict() for m in self.misses],
            "catalog_path": self.catalog_path,
        }


def claim_from_mapping(data: dict[str, Any]) -> ClaimExtraction:
    return parse_extraction(data)


def load_claim_json(path: Path | str) -> ClaimExtraction:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Claim JSON must be an object: {path}")
    return claim_from_mapping(payload)


def _doc_lines_to_raw(
    doc: dict[str, Any] | None,
    *,
    order_ref: str,
    include_price: bool,
) -> list[RawLine]:
    if not doc:
        return []
    rows: list[RawLine] = []
    for line in doc.get("lines") or []:
        item = str(line.get("item_code") or "").strip()
        if not item:
            continue
        qty = Decimal(str(line.get("quantity", 0)))
        price = None
        if include_price and line.get("unit_price") is not None:
            price = Decimal(str(line["unit_price"]))
        rows.append(
            RawLine(
                po_number=order_ref,
                item_code=item,
                quantity=qty,
                price=price,
                uom=line.get("uom"),
            )
        )
    return rows


def run_threeway(
    order: dict[str, Any] | None,
    desadv: dict[str, Any] | None,
    invoice: dict[str, Any] | None,
) -> ThreeWayView | None:
    if not order:
        return None
    order_ref = str(order.get("order_ref") or "")
    po_rows = _doc_lines_to_raw(order, order_ref=order_ref, include_price=True)
    grn_rows = _doc_lines_to_raw(desadv, order_ref=order_ref, include_price=False)
    inv_rows = _doc_lines_to_raw(invoice, order_ref=order_ref, include_price=True)
    if not po_rows and not grn_rows and not inv_rows:
        return None

    result: ReconcileResult = reconcile(po_rows, grn_rows, inv_rows)
    lines = [
        ThreeWayLineView(
            po_number=line.po_number,
            item_code=line.item_code,
            ordered=float(line.ordered),
            received=float(line.received),
            invoiced=float(line.invoiced),
            po_price=float(line.po_price),
            invoice_price=float(line.invoice_price),
            qty_variance=float(line.qty_variance),
            value_variance=float(line.value_variance),
            status=line.status,
            reason=line.reason,
        )
        for line in result.lines
    ]
    summary: dict[str, int] = {}
    for line in lines:
        summary[line.status] = summary.get(line.status, 0) + 1
    return ThreeWayView(lines=lines, warnings=list(result.warnings), summary=summary)


def _load_products(path: Path | str | None = None) -> list[dict[str, Any]]:
    products_path = Path(path) if path else DEFAULT_PRODUCTS
    if not products_path.is_file():
        return []
    data = json.loads(products_path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        return list(data.get("products") or [])
    return list(data) if isinstance(data, list) else []


def _doc_to_reconcile_lines(
    doc: dict[str, Any] | None,
    *,
    order_ref: str,
    include_price: bool,
) -> list[dict[str, Any]]:
    if not doc:
        return []
    rows: list[dict[str, Any]] = []
    for line in doc.get("lines") or []:
        item = str(line.get("item_code") or "").strip()
        if not item:
            continue
        row: dict[str, Any] = {
            "order_ref": order_ref,
            "item_code": item,
            "quantity": float(line.get("quantity") or 0),
            "uom": line.get("uom"),
        }
        if include_price and line.get("unit_price") is not None:
            row["unit_price"] = float(line["unit_price"])
        rows.append(row)
    return rows


def run_shipping_reconcile(
    order: dict[str, Any] | None,
    desadv: dict[str, Any] | None,
    invoice: dict[str, Any] | None,
    *,
    products: list[dict[str, Any]] | None = None,
) -> ReconcileView | None:
    """Run Shipping's improved reconciler on the same docs as baseline threeway."""
    if not order:
        return None
    order_ref = str(order.get("order_ref") or "")
    po_lines = _doc_to_reconcile_lines(order, order_ref=order_ref, include_price=True)
    received = _doc_to_reconcile_lines(desadv, order_ref=order_ref, include_price=False)
    invoiced = _doc_to_reconcile_lines(invoice, order_ref=order_ref, include_price=True)
    if not po_lines and not received and not invoiced:
        return None

    report = reconcile_documents(
        po_lines,
        received,
        invoiced,
        products=products if products is not None else _load_products(),
    )

    lines = [
        ReconcileLineView(
            order_ref=line.order_ref,
            item_code=line.item_code,
            ordered=line.ordered,
            received=line.received,
            invoiced=line.invoiced,
            po_price=line.po_price,
            invoice_price=line.invoice_price,
            status=line.status,
            causes=[
                ReconcileCauseView(code=c.code, qty=c.qty, eur=c.eur, text=c.text)
                for c in line.causes
            ],
        )
        for line in report.lines
    ]
    return ReconcileView(
        status=report.status,
        causes=sorted(report.causes),
        notes=list(report.notes),
        lines=lines,
        explanation=explain(report),
    )


def pull_facts(
    claim: ClaimExtraction | dict[str, Any],
    *,
    store: MiniErpStore | None = None,
    catalog_path: Path | str | None = None,
    products: list[dict[str, Any]] | None = None,
) -> DisputeFacts:
    """Look up linked docs for a structured claim; run baseline threeway + Shipping reconcile."""
    if isinstance(claim, dict):
        extraction = claim_from_mapping(claim)
    else:
        extraction = claim

    erp = store or MiniErpStore.load(catalog_path)
    misses: list[LookupMiss] = []

    order, order_miss = erp.find_order(extraction.order_ref)
    if order_miss:
        misses.append(order_miss)

    # Prefer canonical order_ref from the matched order for downstream joins.
    resolved_order_ref = (
        str(order.get("order_ref")) if order else extraction.order_ref
    )

    desadv, desadv_miss = erp.find_desadv(resolved_order_ref or extraction.order_ref)
    if desadv_miss:
        misses.append(desadv_miss)

    invoice, invoice_miss = erp.find_invoice(
        extraction.invoice_ref,
        order_ref=resolved_order_ref or extraction.order_ref,
    )
    if invoice_miss:
        misses.append(invoice_miss)

    proofs = erp.find_proofs(resolved_order_ref or extraction.order_ref)
    threeway = run_threeway(order, desadv, invoice)
    shipping_reconcile = run_shipping_reconcile(
        order, desadv, invoice, products=products
    )

    claim_dict = extraction.to_dict()

    def _upgrade_other_issues(suffix: str) -> None:
        """Map top-level and per-issue ``other`` → pricing when docs show a price gap."""
        note = (claim_dict.get("raw_notes") or "").strip()
        claim_dict["raw_notes"] = f"{note}; {suffix}" if note else suffix
        if claim_dict.get("claim_type") == ClaimType.OTHER.value:
            claim_dict["claim_type"] = ClaimType.PRICING.value
        issues = claim_dict.get("issues")
        if isinstance(issues, list):
            for issue in issues:
                if isinstance(issue, dict) and issue.get("claim_type") == ClaimType.OTHER.value:
                    issue["claim_type"] = ClaimType.PRICING.value

    # Safety net: portal "other" + threeway invoice/PO price gap → pricing for Playbook.
    price_gap = False
    if threeway is not None:
        price_gap = any(
            "price differs" in (line.reason or "").lower() for line in threeway.lines
        )
    has_other = extraction.claim_type is ClaimType.OTHER or any(
        i.claim_type is ClaimType.OTHER for i in extraction.issues
    )
    if has_other and price_gap:
        _upgrade_other_issues("mapped to pricing via threeway price gap")
    # Same mapping when Shipping reconcile names a price_difference and baseline is quiet.
    elif (
        has_other
        and shipping_reconcile is not None
        and "price_difference" in shipping_reconcile.causes
    ):
        _upgrade_other_issues("mapped to pricing via shipping reconcile price_difference")

    return DisputeFacts(
        claim=claim_dict,
        order=order,
        desadv=desadv,
        invoice=invoice,
        proofs=proofs,
        threeway=threeway,
        reconcile=shipping_reconcile,
        misses=misses,
        catalog_path=str(erp.source_path) if erp.source_path else None,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Pull Dispute facts: Mini ERP lookup + baseline threeway + Shipping reconcile."
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "extraction_json",
        nargs="?",
        type=Path,
        help="Path to claim-reader JSON (hand-written fixture or live extraction)",
    )
    src.add_argument(
        "--claim-json",
        type=Path,
        help="Same as positional extraction_json",
    )
    src.add_argument(
        "--from-claim-email",
        type=Path,
        help="Run claim_reader on a plain-text email first (needs API key)",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=None,
        help="Override Mini ERP catalog JSON (default: data/disputes/erp/catalog.json)",
    )
    args = parser.parse_args(argv)

    try:
        if args.from_claim_email:
            from dispute.claim_reader import load_claim_file, read_claim

            text = load_claim_file(args.from_claim_email)
            claim = read_claim(text)
        else:
            path = args.claim_json or args.extraction_json
            if path is None:
                parser.error("Provide extraction_json or --claim-json or --from-claim-email")
            claim = load_claim_json(path)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 — CLI surface
        print(f"error: {exc}", file=sys.stderr)
        return 1

    facts = pull_facts(claim, catalog_path=args.catalog)
    print(json.dumps(facts.to_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
