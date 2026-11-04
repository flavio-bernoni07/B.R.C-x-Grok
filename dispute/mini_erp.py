"""Mock Mini ERP lookup for Dispute fixtures (until shared `data/` + SQLite land).

Loads `data/disputes/erp/catalog.json` and resolves order / DESADV / invoice / proofs
by order_ref or invoice_ref, including loose aliases (spacing, punctuation).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_CATALOG = (
    Path(__file__).resolve().parents[1] / "data" / "disputes" / "erp" / "catalog.json"
)


def normalize_ref(value: str | None) -> str:
    """Collapse a document reference for fuzzy equality (case, spaces, punctuation)."""
    if not value:
        return ""
    return re.sub(r"[^A-Z0-9]", "", value.upper())


@dataclass
class LookupMiss:
    kind: str
    queried: str | None
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "queried": self.queried, "detail": self.detail}


@dataclass
class MiniErpStore:
    """In-memory catalog of synthetic order / DESADV / invoice / proof documents."""

    orders: list[dict[str, Any]] = field(default_factory=list)
    desadv: list[dict[str, Any]] = field(default_factory=list)
    invoices: list[dict[str, Any]] = field(default_factory=list)
    proofs: list[dict[str, Any]] = field(default_factory=list)
    source_path: Path | None = None

    @classmethod
    def load(cls, path: Path | str | None = None) -> MiniErpStore:
        catalog_path = Path(path) if path else DEFAULT_CATALOG
        data = json.loads(catalog_path.read_text(encoding="utf-8"))
        return cls(
            orders=list(data.get("orders") or []),
            desadv=list(data.get("desadv") or []),
            invoices=list(data.get("invoices") or []),
            proofs=list(data.get("proofs") or []),
            source_path=catalog_path,
        )

    def find_order(self, order_ref: str | None) -> tuple[dict[str, Any] | None, LookupMiss | None]:
        if not order_ref:
            return None, LookupMiss("order", None, "No order_ref on claim")
        hit = self._match_doc(self.orders, order_ref, ref_key="order_ref")
        if hit:
            return hit, None
        return None, LookupMiss("order", order_ref, "No order matched order_ref or aliases")

    def find_invoice(
        self,
        invoice_ref: str | None,
        order_ref: str | None = None,
    ) -> tuple[dict[str, Any] | None, LookupMiss | None]:
        if invoice_ref:
            hit = self._match_doc(self.invoices, invoice_ref, ref_key="invoice_ref")
            if hit:
                return hit, None
            # Remittance stubs often only carry a trailing fragment (e.g. "334").
            frag = normalize_ref(invoice_ref)
            if frag:
                for inv in self.invoices:
                    candidates = [inv.get("invoice_ref") or ""] + list(inv.get("aliases") or [])
                    if any(frag and frag in normalize_ref(c) for c in candidates):
                        return inv, None
            miss = LookupMiss("invoice", invoice_ref, "No invoice matched invoice_ref or aliases")
            if order_ref:
                by_order = self.find_invoice_for_order(order_ref)
                if by_order:
                    return by_order, None
            return None, miss
        if order_ref:
            by_order = self.find_invoice_for_order(order_ref)
            if by_order:
                return by_order, None
            return None, LookupMiss(
                "invoice",
                None,
                f"No invoice_ref on claim and no invoice linked to order {order_ref}",
            )
        return None, LookupMiss("invoice", None, "No invoice_ref or order_ref to look up")

    def find_invoice_for_order(self, order_ref: str) -> dict[str, Any] | None:
        order_doc, _ = self.find_order(order_ref)
        canonical = (
            normalize_ref(str(order_doc.get("order_ref") or ""))
            if order_doc
            else normalize_ref(order_ref)
        )
        if not canonical:
            return None
        for inv in self.invoices:
            if normalize_ref(str(inv.get("order_ref") or "")) == canonical:
                return inv
        return None

    def find_desadv(self, order_ref: str | None) -> tuple[dict[str, Any] | None, LookupMiss | None]:
        if not order_ref:
            return None, LookupMiss("desadv", None, "No order_ref to resolve DESADV")
        order, miss = self.find_order(order_ref)
        if miss or not order:
            return None, LookupMiss("desadv", order_ref, "Cannot resolve DESADV without a matched order")
        canonical = str(order.get("order_ref") or "")
        for doc in self.desadv:
            if normalize_ref(str(doc.get("order_ref") or "")) == normalize_ref(canonical):
                return doc, None
        return None, LookupMiss("desadv", canonical, "No DESADV linked to order")

    def find_proofs(self, order_ref: str | None) -> list[dict[str, Any]]:
        if not order_ref:
            return []
        order, miss = self.find_order(order_ref)
        if miss or not order:
            # Still try raw ref in case proofs use the same messy string.
            target = normalize_ref(order_ref)
            return [p for p in self.proofs if normalize_ref(str(p.get("order_ref") or "")) == target]
        canonical = normalize_ref(str(order.get("order_ref") or ""))
        return [p for p in self.proofs if normalize_ref(str(p.get("order_ref") or "")) == canonical]

    def _match_doc(
        self,
        docs: list[dict[str, Any]],
        query: str,
        *,
        ref_key: str,
    ) -> dict[str, Any] | None:
        target = normalize_ref(query)
        if not target:
            return None
        for doc in docs:
            candidates = [str(doc.get(ref_key) or "")] + [str(a) for a in (doc.get("aliases") or [])]
            for candidate in candidates:
                norm = normalize_ref(candidate)
                if not norm:
                    continue
                if norm == target or target in norm or norm in target:
                    return doc
        return None
