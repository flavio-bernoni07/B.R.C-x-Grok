"""Verdict + sources — Grok proposes accept | partial | reject with citations.

Required environment (live path):
  XAI_API_KEY or GROK_API_KEY — same as claim_reader.
  Optional: XAI_BASE_URL, XAI_MODEL or GROK_MODEL (default grok-4-latest).

Usage:
  python -m dispute.verdict --extraction data/disputes/extractions/01_shortage.json
  python -m dispute.verdict --extraction ... --facts path/to/facts.json
  python -m dispute.verdict --extraction ... --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from dispute.claim_reader import (
    ClaimExtraction,
    MissingApiKeyError,
    _api_key,
    _base_url,
    _extract_json_object,
    _model,
    _null_float,
    _null_str,
    parse_extraction,
)
from dispute.pull_facts import DisputeFacts, load_claim_json, pull_facts

DEFAULT_PLAYBOOK = (
    Path(__file__).resolve().parents[1] / "data" / "disputes" / "playbook.md"
)
DEFAULT_CONTRACT = (
    Path(__file__).resolve().parents[1] / "data" / "disputes" / "contract_excerpt.md"
)

AMOUNT_EPS = 0.05  # euro tolerance when matching proposed amounts to known figures


class VerdictDecision(str, Enum):
    ACCEPT = "accept"
    PARTIAL = "partial"
    REJECT = "reject"


DECISIONS = {d.value for d in VerdictDecision}


VERDICT_SCHEMA_HINT = """
Return a single JSON object only (no markdown), with these keys:
  decision: "accept" | "partial" | "reject"
  amount: number or null — total credit € to propose (null if reject with €0 or unknown)
  confidence: number from 0 to 1
  needs_sign_off: boolean — true if amount > 500, unsure, missing source, or off-playbook
  summary: short string — one-paragraph rationale
  points: array of objects, each with:
    text: string — the finding
    amount: number or null — € for this point only
    source: object with:
      kind: one of "order" | "desadv" | "invoice" | "ddt" | "pod" | "warehouse_event"
            | "contract" | "threeway" | "playbook" | "damage_photo" | "other"
      ref: string — document id, clause, threeway reason, or playbook rule id
      detail: string — brief why this source supports the point

Rules:
- Read the Playbook first and follow it.
- NEVER invent euro amounts. Every amount must equal a figure present in the claim,
  threeway value_variance, invoice/PO line math, or contract promo prices × qty
  already shown in the facts. If you cannot tie an amount to those numbers, use null.
- Every point MUST have a source. Prefer concrete document ids from facts.
- Dispute ends in credit note or evidence reply later — you only decide.
""".strip()


@dataclass(frozen=True)
class VerdictSource:
    kind: str
    ref: str
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class VerdictPoint:
    text: str
    amount: float | None
    source: VerdictSource

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "amount": self.amount,
            "source": self.source.to_dict(),
        }


@dataclass
class DisputeVerdict:
    decision: VerdictDecision
    amount: float | None
    confidence: float
    needs_sign_off: bool
    summary: str
    points: list[VerdictPoint]
    playbook_path: str | None = None
    contract_path: str | None = None
    amount_notes: list[str] = field(default_factory=list)
    known_amounts: list[float] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision.value,
            "amount": self.amount,
            "confidence": self.confidence,
            "needs_sign_off": self.needs_sign_off,
            "summary": self.summary,
            "points": [p.to_dict() for p in self.points],
            "playbook_path": self.playbook_path,
            "contract_path": self.contract_path,
            "amount_notes": self.amount_notes,
            "known_amounts": self.known_amounts,
        }


def load_text(path: Path | str) -> str:
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"File not found: {file_path}")
    return file_path.read_text(encoding="utf-8")


def facts_from_mapping(data: dict[str, Any]) -> dict[str, Any]:
    """Accept a facts dict (from pull_facts.to_dict() or a saved JSON fixture)."""
    if not isinstance(data, dict):
        raise TypeError("facts JSON must be an object")
    return data


def load_facts_json(path: Path | str) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return facts_from_mapping(payload)


def dispute_facts_to_mapping(facts: DisputeFacts) -> dict[str, Any]:
    return facts.to_dict()


def collect_known_amounts(claim: ClaimExtraction, facts: dict[str, Any]) -> list[float]:
    """Euro figures grounded in claim / docs / threeway — Grok must not invent outside these."""
    known: list[float] = []

    def add(value: Any) -> None:
        number = _null_float(value)
        if number is None:
            return
        # Keep absolute magnitudes for matching credit sizes.
        known.append(round(abs(float(number)), 2))

    add(claim.amount)
    if claim.quantity is not None:
        order = facts.get("order") or {}
        for line in order.get("lines") or []:
            if line.get("unit_price") is not None:
                add(claim.quantity * float(line["unit_price"]))
        invoice = facts.get("invoice") or {}
        for line in invoice.get("lines") or []:
            if line.get("unit_price") is not None:
                add(claim.quantity * float(line["unit_price"]))

    for doc_key in ("order", "invoice", "desadv"):
        doc = facts.get(doc_key) or {}
        add(doc.get("total"))
        for line in doc.get("lines") or []:
            add(line.get("unit_price"))
            qty = _null_float(line.get("quantity"))
            price = _null_float(line.get("unit_price"))
            if qty is not None and price is not None:
                add(qty * price)

    threeway = facts.get("threeway") or {}
    for line in threeway.get("lines") or []:
        add(line.get("value_variance"))
        add(line.get("po_price"))
        add(line.get("invoice_price"))
        ordered = _null_float(line.get("ordered"))
        received = _null_float(line.get("received"))
        invoiced = _null_float(line.get("invoiced"))
        po_price = _null_float(line.get("po_price"))
        inv_price = _null_float(line.get("invoice_price"))
        if ordered is not None and received is not None and po_price is not None:
            add((ordered - received) * po_price)
        if invoiced is not None and received is not None and po_price is not None:
            add((invoiced - received) * po_price)
        if invoiced is not None and inv_price is not None and po_price is not None:
            add((inv_price - po_price) * invoiced)

    # Deduplicate while preserving order.
    seen: set[float] = set()
    out: list[float] = []
    for value in known:
        if value == 0:
            continue
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _amount_is_known(amount: float | None, known: list[float]) -> bool:
    if amount is None:
        return True
    target = abs(float(amount))
    return any(abs(target - k) <= AMOUNT_EPS for k in known)


def _nearest_known(amount: float, known: list[float]) -> float | None:
    if not known:
        return None
    target = abs(amount)
    best = min(known, key=lambda k: abs(k - target))
    if abs(best - target) <= max(AMOUNT_EPS, 0.02 * max(target, best)):
        return best
    return None


def normalize_amounts(
    decision: VerdictDecision,
    amount: float | None,
    points: list[VerdictPoint],
    known: list[float],
) -> tuple[float | None, list[VerdictPoint], list[str]]:
    """Clamp / null-out invented amounts; prefer figures present in claim/facts."""
    notes: list[str] = []
    fixed_points: list[VerdictPoint] = []
    for point in points:
        if point.amount is None or _amount_is_known(point.amount, known):
            fixed_points.append(point)
            continue
        nearest = _nearest_known(point.amount, known)
        if nearest is not None:
            notes.append(
                f"Point amount {point.amount} normalized to known {nearest} from docs/facts"
            )
            fixed_points.append(
                VerdictPoint(text=point.text, amount=nearest, source=point.source)
            )
        else:
            notes.append(
                f"Point amount {point.amount} dropped (not grounded in claim/facts/threeway)"
            )
            fixed_points.append(
                VerdictPoint(text=point.text, amount=None, source=point.source)
            )

    if amount is not None and not _amount_is_known(amount, known):
        nearest = _nearest_known(amount, known)
        if nearest is not None:
            notes.append(f"Overall amount {amount} normalized to known {nearest}")
            amount = nearest
        else:
            notes.append(f"Overall amount {amount} cleared (not grounded in claim/facts)")
            amount = None

    if decision is VerdictDecision.REJECT and amount is None:
        # Reject with no credit is fine.
        pass
    elif amount is None:
        # Prefer sum of grounded point amounts when overall missing.
        point_sum = sum(p.amount for p in fixed_points if p.amount is not None)
        if point_sum > 0:
            amount = round(point_sum, 2)
            notes.append(f"Overall amount set from sum of grounded point amounts: {amount}")

    return amount, fixed_points, notes


def parse_verdict_payload(
    payload: dict[str, Any],
    *,
    known_amounts: list[float],
    playbook_path: str | None = None,
    contract_path: str | None = None,
) -> DisputeVerdict:
    raw_decision = str(payload.get("decision") or "reject").strip().lower()
    if raw_decision not in DECISIONS:
        raw_decision = "reject"
    decision = VerdictDecision(raw_decision)

    confidence = _null_float(payload.get("confidence"))
    if confidence is None:
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    points_raw = payload.get("points") or []
    points: list[VerdictPoint] = []
    if isinstance(points_raw, list):
        for item in points_raw:
            if not isinstance(item, dict):
                continue
            source_raw = item.get("source") or {}
            if not isinstance(source_raw, dict):
                source_raw = {}
            kind = _null_str(source_raw.get("kind")) or "other"
            ref = _null_str(source_raw.get("ref")) or "unspecified"
            detail = _null_str(source_raw.get("detail")) or ""
            text = _null_str(item.get("text")) or ""
            if not text:
                continue
            points.append(
                VerdictPoint(
                    text=text,
                    amount=_null_float(item.get("amount")),
                    source=VerdictSource(kind=kind, ref=ref, detail=detail),
                )
            )

    amount, points, amount_notes = normalize_amounts(
        decision,
        _null_float(payload.get("amount")),
        points,
        known_amounts,
    )

    needs = payload.get("needs_sign_off")
    if isinstance(needs, bool):
        needs_sign_off = needs
    else:
        needs_sign_off = False
    if amount is not None and amount > 500:
        needs_sign_off = True
    if confidence < 0.55:
        needs_sign_off = True
    if any(p.source.ref == "unspecified" for p in points):
        needs_sign_off = True
    if not points:
        needs_sign_off = True

    summary = _null_str(payload.get("summary")) or ""

    return DisputeVerdict(
        decision=decision,
        amount=amount,
        confidence=confidence,
        needs_sign_off=needs_sign_off,
        summary=summary,
        points=points,
        playbook_path=playbook_path,
        contract_path=contract_path,
        amount_notes=amount_notes,
        known_amounts=known_amounts,
    )


def build_verdict_prompt(
    *,
    playbook: str,
    contract: str,
    claim: ClaimExtraction,
    facts: dict[str, Any],
    known_amounts: list[float],
) -> list[dict[str, str]]:
    bundle = {
        "claim": claim.to_dict(),
        "facts": facts,
        "known_amounts_eur": known_amounts,
        "contract_excerpt": contract,
    }
    return [
        {
            "role": "system",
            "content": (
                "You are the Dispute verdict agent for Riso Scotti zero-touch back office. "
                "Decide accept, partial, or reject with sources. "
                + VERDICT_SCHEMA_HINT
                + "\n\n=== PLAYBOOK (read first) ===\n"
                + playbook
            ),
        },
        {
            "role": "user",
            "content": (
                "Claim extraction + pulled facts + contract excerpt follow as JSON. "
                "Use only known_amounts_eur (and exact arithmetic from those docs) for euros.\n\n"
                + json.dumps(bundle, ensure_ascii=False, indent=2)
            ),
        },
    ]


def call_grok_verdict(messages: list[dict[str, str]], *, api_key: str) -> dict[str, Any]:
    url = f"{_base_url()}/chat/completions"
    body = {
        "model": _model(),
        "temperature": 0,
        "messages": messages,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"xAI API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"xAI API request failed: {exc}") from exc

    envelope = json.loads(raw)
    try:
        content = envelope["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected xAI response shape: {envelope!r}") from exc
    if not isinstance(content, str):
        raise RuntimeError("xAI message content is not a string")
    return _extract_json_object(content)


def decide_verdict(
    claim: ClaimExtraction | dict[str, Any],
    facts: DisputeFacts | dict[str, Any],
    *,
    playbook_path: Path | str | None = None,
    contract_path: Path | str | None = None,
    grok_caller: Callable[[list[dict[str, str]]], dict[str, Any]] | None = None,
) -> DisputeVerdict:
    """Propose a verdict from claim + facts. Live path requires API key unless grok_caller set."""
    extraction = parse_extraction(claim) if isinstance(claim, dict) else claim
    facts_map = (
        dispute_facts_to_mapping(facts) if isinstance(facts, DisputeFacts) else facts_from_mapping(facts)
    )

    pb_path = Path(playbook_path) if playbook_path else DEFAULT_PLAYBOOK
    ct_path = Path(contract_path) if contract_path else DEFAULT_CONTRACT
    playbook = load_text(pb_path)
    contract = load_text(ct_path)
    known = collect_known_amounts(extraction, facts_map)
    messages = build_verdict_prompt(
        playbook=playbook,
        contract=contract,
        claim=extraction,
        facts=facts_map,
        known_amounts=known,
    )

    if grok_caller is not None:
        payload = grok_caller(messages)
    else:
        key = _api_key()
        if not key:
            raise MissingApiKeyError(
                "Missing API key. Set XAI_API_KEY or GROK_API_KEY for live verdict. "
                "Use --dry-run to load claim/facts/playbook without calling Grok."
            )
        payload = call_grok_verdict(messages, api_key=key)

    if not isinstance(payload, dict):
        raise TypeError("verdict Grok response must be a dict")

    return parse_verdict_payload(
        payload,
        known_amounts=known,
        playbook_path=str(pb_path),
        contract_path=str(ct_path),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Propose a Dispute verdict with sources from claim + facts via Grok."
    )
    parser.add_argument(
        "--extraction",
        type=Path,
        required=True,
        help="Claim-reader JSON (hand-written fixture or live extraction)",
    )
    parser.add_argument(
        "--facts",
        type=Path,
        default=None,
        help="Optional facts JSON from pull_facts; if omitted, pull_facts runs locally",
    )
    parser.add_argument(
        "--playbook",
        type=Path,
        default=None,
        help="Override Playbook markdown path",
    )
    parser.add_argument(
        "--contract",
        type=Path,
        default=None,
        help="Override contract excerpt markdown path",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=None,
        help="Mini ERP catalog when facts are pulled locally",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Load claim, facts, playbook, contract and print known amounts; skip Grok",
    )
    args = parser.parse_args(argv)

    try:
        claim = load_claim_json(args.extraction)
        if args.facts:
            facts_map = load_facts_json(args.facts)
        else:
            facts_map = pull_facts(claim, catalog_path=args.catalog).to_dict()
        playbook_path = args.playbook or DEFAULT_PLAYBOOK
        contract_path = args.contract or DEFAULT_CONTRACT
        playbook = load_text(playbook_path)
        contract = load_text(contract_path)
        known = collect_known_amounts(claim, facts_map)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 — CLI surface
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        preview = {
            "dry_run": True,
            "extraction": claim.to_dict(),
            "facts_order_ref": (facts_map.get("order") or {}).get("order_ref"),
            "facts_invoice_ref": (facts_map.get("invoice") or {}).get("invoice_ref"),
            "threeway_summary": (facts_map.get("threeway") or {}).get("summary"),
            "proof_count": len(facts_map.get("proofs") or []),
            "playbook_path": str(playbook_path),
            "playbook_chars": len(playbook),
            "contract_path": str(contract_path),
            "contract_chars": len(contract),
            "known_amounts_eur": known,
        }
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        return 0

    try:
        verdict = decide_verdict(
            claim,
            facts_map,
            playbook_path=playbook_path,
            contract_path=contract_path,
        )
    except MissingApiKeyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(verdict.to_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
