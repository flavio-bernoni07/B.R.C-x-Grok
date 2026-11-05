"""Claim reader — extract structured fields from a retailer claim email via Grok.

Required environment (production / live extraction):
  XAI_API_KEY or GROK_API_KEY — xAI API key for chat completions.
  Optional: XAI_BASE_URL (default https://api.x.ai/v1),
  XAI_MODEL or GROK_MODEL (default grok-4-latest).

Usage:
  python -m dispute.claim_reader path/to/claim.txt
  python -m dispute.claim_reader --dry-run path/to/claim.txt   # load fixture only
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from agent import grok
from agent.grok import MissingApiKeyError


class ClaimType(str, Enum):
    SHORTAGE = "shortage"
    PRICING = "pricing"
    DAMAGE = "damage"
    LATE_DELIVERY = "late_delivery"
    OTHER = "other"


CLAIM_TYPES = {c.value for c in ClaimType}

EXTRACTION_SCHEMA_HINT = """
Return a single JSON object only (no markdown), with these keys:
  order_ref: string or null — purchase order / ORDERS reference as written or normalized if clear
  invoice_ref: string or null — invoice / FatturaPA / INVOIC number
  confidence: number from 0 to 1 — how sure you are of the extraction
  raw_notes: short string — typos, missing refs, ambiguity, or other useful notes
  issues: array of objects (one or more), each with:
    claim_type: one of "shortage" | "pricing" | "damage" | "late_delivery" | "other"
    product: string or null — product name or SKU for this issue
    quantity: number or null — disputed quantity for this issue
    amount: number or null — disputed euro amount for this issue
    notes: short string — optional detail for this issue only

Legacy single-issue shape is also accepted (product, quantity, amount, claim_type at the
top level instead of issues). Prefer issues when the email raises more than one problem.

Rules:
- Do not invent order_ref or invoice_ref. If missing or unreadable, use null.
- Prefer null over guessing when a field is absent.
- claim_type must be exactly one of the allowed values.
- One issue per distinct problem type (or distinct qty/amount line). If the retailer is
  unsure which type applies to the same facts (e.g. shortage vs late), use one "other"
  issue — do not invent duplicate issues for the same ambiguity.
- Remittance / short-payment texts with price reason codes (PRI, PRI/UNK) or
  unit-price / promo variance → claim_type "pricing" (not "other") on that issue.
- Tolerate Italian and English, typos, and remittance/short-payment style texts.
""".strip()

# Remittance short-pays often arrive as portal "other" / PRI/UNK; map to pricing.
_PRICING_MARKERS = (
    "pri/unk",
    "pri_unk",
    "reason code: pri",
    "reason code on remittance: pri",
    "short-pay",
    "short pay",
    "shortpaid",
    "paid short",
    "invoice paid short",
    "price variance",
    "price hold",
    "unit price",
    "promo price",
    "promo agreement",
    "list price",
    "listino",
)


@dataclass(frozen=True)
class ClaimIssue:
    """One problem raised inside a claim email (shortage, pricing, …)."""

    claim_type: ClaimType
    product: str | None = None
    quantity: float | None = None
    amount: float | None = None
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "claim_type": self.claim_type.value,
            "product": self.product,
            "quantity": self.quantity,
            "amount": self.amount,
            "notes": self.notes,
        }


@dataclass(frozen=True)
class ClaimExtraction:
    """Structured claim fields extracted from retailer email / short payment text.

    Top-level product / quantity / amount / claim_type mirror issues[0] so older
    call sites keep working. Multi-problem emails populate issues with 2+.
    """

    order_ref: str | None
    invoice_ref: str | None
    product: str | None
    quantity: float | None
    amount: float | None
    claim_type: ClaimType
    confidence: float
    raw_notes: str
    issues: tuple[ClaimIssue, ...] = ()

    def __post_init__(self) -> None:
        if self.issues:
            return
        object.__setattr__(
            self,
            "issues",
            (
                ClaimIssue(
                    claim_type=self.claim_type,
                    product=self.product,
                    quantity=self.quantity,
                    amount=self.amount,
                    notes="",
                ),
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "order_ref": self.order_ref,
            "invoice_ref": self.invoice_ref,
            "product": self.product,
            "quantity": self.quantity,
            "amount": self.amount,
            "claim_type": self.claim_type.value,
            "confidence": self.confidence,
            "raw_notes": self.raw_notes,
            "issues": [issue.to_dict() for issue in self.issues],
        }


def _parse_claim_type(raw: Any) -> ClaimType:
    if isinstance(raw, ClaimType):
        return raw
    claim_str = str(raw or "other").strip().lower().replace(" ", "_").replace("-", "_")
    if claim_str not in CLAIM_TYPES:
        claim_str = "other"
    return ClaimType(claim_str)


def scoped_extraction(extraction: ClaimExtraction, issue: ClaimIssue) -> ClaimExtraction:
    """View of the claim as if it only contained this one issue (verdict / signature)."""
    return ClaimExtraction(
        order_ref=extraction.order_ref,
        invoice_ref=extraction.invoice_ref,
        product=issue.product,
        quantity=issue.quantity,
        amount=issue.amount,
        claim_type=issue.claim_type,
        confidence=extraction.confidence,
        raw_notes=extraction.raw_notes,
        issues=(issue,),
    )


def _api_key() -> str | None:
    return grok.api_key()


def _base_url() -> str:
    return grok.base_url()


DEFAULT_XAI_MODEL = grok.DEFAULT_MODEL


def _model() -> str:
    """Resolve chat model: XAI_MODEL_DISPUTE_READ_CLAIM, else XAI_MODEL, else GROK_MODEL, else DEFAULT_XAI_MODEL."""
    return grok.model_for("dispute.read_claim")


def _null_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text or text.lower() in {"null", "none", "n/a", "na", "-"}:
            return None
        return text
    return str(value).strip() or None


def _null_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace(",", ".").replace("€", "").replace("EUR", "").strip()
        if not text or text.lower() in {"null", "none", "n/a", "na", "-"}:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def looks_like_pricing_remittance(*texts: str | None) -> bool:
    """True when remittance / PRI/UNK / short-pay language points at a price dispute."""
    blob = " ".join(t for t in texts if t).lower()
    if not blob:
        return False
    if any(marker in blob for marker in _PRICING_MARKERS):
        return True
    # Remittance feed + price/PRI token (portal often leaves claim type blank).
    if "remittance" in blob and (
        "pri" in blob or "price" in blob or "prezzo" in blob or "€" in blob or "eur" in blob
    ):
        return True
    return False


def refine_claim_type(
    claim_type: ClaimType,
    *,
    raw_notes: str = "",
    claim_text: str = "",
) -> ClaimType:
    """Post-process claim_type: remittance PRI/UNK / short-pay → pricing.

    Leaves shortage / damage / late_delivery / pricing unchanged. Only upgrades
    ``other`` (or unknown→other) when pricing remittance signals are present.
    """
    if claim_type is not ClaimType.OTHER:
        return claim_type
    if looks_like_pricing_remittance(raw_notes, claim_text):
        return ClaimType.PRICING
    return claim_type


def parse_extraction(
    payload: dict[str, Any],
    *,
    claim_text: str = "",
) -> ClaimExtraction:
    """Build a ClaimExtraction from a model JSON object; never invent refs.

    Accepts either ``issues`` (preferred) or the legacy top-level claim_type /
    product / quantity / amount shape (synthesized into a one-element issues list).
    """
    confidence = _null_float(payload.get("confidence"))
    if confidence is None:
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    notes = payload.get("raw_notes")
    raw_notes = notes.strip() if isinstance(notes, str) else (str(notes) if notes else "")

    parsed_issues: list[ClaimIssue] = []
    raw_issues = payload.get("issues")
    if isinstance(raw_issues, list) and raw_issues:
        for item in raw_issues:
            if not isinstance(item, dict):
                continue
            issue_notes = item.get("notes")
            issue_notes_s = (
                issue_notes.strip()
                if isinstance(issue_notes, str)
                else (str(issue_notes) if issue_notes else "")
            )
            claim_type = refine_claim_type(
                _parse_claim_type(item.get("claim_type", "other")),
                raw_notes=issue_notes_s or raw_notes,
                claim_text=claim_text,
            )
            parsed_issues.append(
                ClaimIssue(
                    claim_type=claim_type,
                    product=_null_str(item.get("product")),
                    quantity=_null_float(item.get("quantity")),
                    amount=_null_float(item.get("amount")),
                    notes=issue_notes_s,
                )
            )

    if not parsed_issues:
        claim_type = refine_claim_type(
            _parse_claim_type(payload.get("claim_type", "other")),
            raw_notes=raw_notes,
            claim_text=claim_text,
        )
        parsed_issues.append(
            ClaimIssue(
                claim_type=claim_type,
                product=_null_str(payload.get("product")),
                quantity=_null_float(payload.get("quantity")),
                amount=_null_float(payload.get("amount")),
                notes="",
            )
        )

    primary = parsed_issues[0]
    return ClaimExtraction(
        order_ref=_null_str(payload.get("order_ref")),
        invoice_ref=_null_str(payload.get("invoice_ref")),
        product=primary.product,
        quantity=primary.quantity,
        amount=primary.amount,
        claim_type=primary.claim_type,
        confidence=confidence,
        raw_notes=raw_notes,
        issues=tuple(parsed_issues),
    )


_extract_json_object = grok.extract_json_object


def call_grok(claim_text: str, *, api_key: str) -> dict[str, Any]:
    """Call xAI chat completions and return the parsed JSON object from the model."""
    body = {
        "messages": [
            {
                "role": "system",
                "content": (
                    "You extract structured dispute claim fields for Riso Scotti back office. "
                    + EXTRACTION_SCHEMA_HINT
                ),
            },
            {
                "role": "user",
                "content": "Claim email / remittance text:\n\n" + claim_text,
            },
        ],
    }
    return grok.chat_json(body["messages"], task="dispute.read_claim", api_key_value=api_key)


def read_claim(claim_text: str, *, grok_caller=None) -> ClaimExtraction:
    """Extract a ClaimExtraction from plain-text claim email.

    If grok_caller is provided (tests), it must return a dict matching the schema.
    Otherwise calls the live xAI/Grok API. Missing API key fails clearly —
    this path never silently invents an extraction.
    """
    text = claim_text.strip()
    if not text:
        raise ValueError("claim text is empty")

    if grok_caller is not None:
        payload = grok_caller(text)
        if not isinstance(payload, dict):
            raise TypeError("grok_caller must return a dict")
        return parse_extraction(payload, claim_text=text)

    key = _api_key()
    if not key:
        raise MissingApiKeyError(
            "Missing API key. Set XAI_API_KEY or GROK_API_KEY for live claim extraction. "
            "Use --dry-run to validate fixture loading without calling Grok."
        )
    return parse_extraction(call_grok(text, api_key=key), claim_text=text)


def load_claim_file(path: Path | str) -> str:
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"Claim fixture not found: {file_path}")
    return file_path.read_text(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read a retailer claim email and extract structured fields via Grok."
    )
    parser.add_argument(
        "path",
        type=Path,
        help="Path to a plain-text claim email fixture",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only load and print the fixture; do not call Grok",
    )
    args = parser.parse_args(argv)

    try:
        claim_text = load_claim_file(args.path)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.dry_run:
        print(f"Loaded {args.path} ({len(claim_text)} chars). Dry-run: skipping Grok.")
        print("---")
        print(claim_text.rstrip())
        return 0

    try:
        extraction = read_claim(claim_text)
    except MissingApiKeyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 — CLI surface
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(extraction.to_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
