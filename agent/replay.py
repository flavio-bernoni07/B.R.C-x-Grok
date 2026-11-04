"""Replay invented dispute cases week by week and draw the case curve.

    python -m agent.replay                       # table on screen
    python -m agent.replay --svg docs/img/case-curve.svg

This is a simulation, said plainly: the cases are invented, "Grok" and the person
are scripted. What is real is the loop they run through: agent/learning.py logs
every decision, finds precedents, drafts a rule after three matching decisions by a
person, a person approves the rule, and from then on the rule decides with no Grok
call. The confidence threshold is the starting value in grok-agent-dec.md (0.7).

Scripted Grok: confidence 0.5 with no close precedent, +0.15 for each agreeing
precedent of the same kind, 0.4 on unclear cases. Scripted person: decides
correctly and approves draft rules at the end of each week.
"""

from __future__ import annotations

import argparse
import random
from typing import Any

from agent import learning
from core.erp import Erp

THRESHOLD = 0.7
KINDS = [
    # name, share, signature fields that define the kind, the right decision
    ("missing pallet noted on the signed DDT", 0.25,
     {"case_type": "shortage", "threeway_reason": "matched", "proofs": "pod", "checks": "reservation_on_ddt"}, "accept"),
    ("shortage claim, documents agree, clean DDT", 0.20,
     {"case_type": "shortage", "threeway_reason": "matched", "proofs": "ddt,pod", "checks": ""}, "reject"),
    ("promo price billed at list price", 0.20,
     {"case_type": "pricing", "threeway_reason": "Invoice price differs from the PO price", "proofs": "", "checks": ""}, "accept"),
    ("flyer contribution deducted, no clause", 0.15,
     {"case_type": "other", "threeway_reason": "matched", "proofs": "", "checks": ""}, "reject"),
    ("unclear claim", 0.20, None, None),
]
RETAILERS = ["Esselunga", "Coop Italia", "Conad", "Carrefour Italia"]
PRODUCTS = ["CAR-1KG", "ARB-1KG-CTN12", "BAS-500G", "RSP-FUNGHI-210"]


def _case(rng: random.Random, n: int) -> tuple[str, dict[str, Any], str | None]:
    pick = rng.random()
    acc = 0.0
    for name, share, fields, decision in KINDS:
        acc += share
        if pick <= acc:
            break
    sig = {"task": "dispute.verdict", "retailer": rng.choice(RETAILERS), "product": rng.choice(PRODUCTS),
           "amount_band": rng.choice(["<100", "100-500", "500-2000"])}
    if fields is None:  # unclear: a different mix every time, so no rule can form
        sig.update({"case_type": "other", "threeway_reason": rng.choice(["Short delivery against the order", "matched",
                                                                          "no threeway"]),
                    "proofs": rng.choice(["", "warehouse_event", "ddt"]), "checks": rng.choice(["", "missing_documents"])})
        decision = rng.choice(["accept", "partial", "reject"])
    else:
        sig.update(fields)
    return name, sig, decision


def run(weeks: int = 6, per_week: int = 10, seed: int = 7) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    erp = Erp()
    learning.ensure_schema(erp)
    rows = []
    n = 0
    for week in range(1, weeks + 1):
        asked = grok_calls = by_rule = 0
        for _ in range(per_week):
            n += 1
            name, sig, right = _case(rng, n)
            ref = f"SIM-{n:03d}"
            rule = learning.match_rule(erp, sig)
            if rule:
                by_rule += 1
                learning.log_case(erp, task="dispute.verdict", subject_ref=ref, signature=sig,
                                  proposal={"decision": rule["action"]["decision"]}, confidence=1.0, asked_person=False,
                                  why_person=[], decided_by="rule", decision=rule["action"]["decision"],
                                  rule_id=rule["rule_id"])
                continue
            grok_calls += 1
            precedents = learning.similar(erp, sig)
            unclear = right is None or name == "unclear claim"
            agreeing = sum(1 for p in precedents if p["decision"] == right and p["score"] >= 9)
            confidence = 0.4 if unclear else min(0.5 + 0.15 * agreeing, 0.95)
            needs_person = confidence < THRESHOLD or unclear
            if needs_person:
                asked += 1
                learning.log_case(erp, task="dispute.verdict", subject_ref=ref, signature=sig,
                                  proposal={"decision": right}, confidence=confidence, asked_person=True,
                                  why_person=["confidence under 0.7" if not unclear else "unclear claim"],
                                  precedents=[p["case_id"] for p in precedents])
                learning.record_person_decision(erp, ref, decided_by="Sara (scripted)", decision=right,
                                                reason=f"{name}: {right}", overturned=False)
            else:
                learning.log_case(erp, task="dispute.verdict", subject_ref=ref, signature=sig,
                                  proposal={"decision": right}, confidence=confidence, asked_person=False,
                                  why_person=[], decided_by="grok", decision=right,
                                  precedents=[p["case_id"] for p in precedents])
        for draft in learning.rules(erp, "draft"):
            learning.approve_rule(erp, draft["rule_id"], by="Sara (scripted)", reason="the three cases behind it agree")
        rows.append({"week": week, "cases": per_week, "asked_person": asked, "share_person": asked / per_week,
                     "grok_calls": grok_calls, "decided_by_rule": by_rule,
                     "active_rules": len(learning.rules(erp, "active"))})
    return rows


def run_many(replays: int = 20, weeks: int = 6, per_week: int = 10) -> list[dict[str, Any]]:
    """Average of several replays (seeds 1..N), so one unlucky week does not draw the curve."""
    runs = [run(weeks=weeks, per_week=per_week, seed=seed) for seed in range(1, replays + 1)]
    out = []
    for week in range(weeks):
        rows = [r[week] for r in runs]
        out.append({"week": week + 1, "cases": per_week, "replays": replays,
                    "asked_person": sum(r["asked_person"] for r in rows) / replays,
                    "share_person": sum(r["share_person"] for r in rows) / replays,
                    "grok_calls": sum(r["grok_calls"] for r in rows) / replays,
                    "decided_by_rule": sum(r["decided_by_rule"] for r in rows) / replays,
                    "active_rules": sum(r["active_rules"] for r in rows) / replays})
    return out


def svg(rows: list[dict[str, Any]]) -> str:
    """Two lines over the weeks: share of cases a person decided, share decided by a rule."""
    w, h, left, top, right, bottom = 640, 320, 56, 36, 40, 48
    pw, ph = w - left - right, h - top - bottom
    xs = [left + i * pw / max(len(rows) - 1, 1) for i in range(len(rows))]

    def y(v: float) -> float:
        return top + ph * (1 - v)

    def line(key: str, color: str) -> str:
        pts = " ".join(f"{x:.1f},{y(r[key]):.1f}" for x, r in zip(xs, rows))
        dots = "".join(f'<circle cx="{x:.1f}" cy="{y(r[key]):.1f}" r="3.5" fill="{color}"/>' for x, r in zip(xs, rows))
        return f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2.5"/>{dots}'

    for r in rows:
        r["share_rule"] = r["decided_by_rule"] / r["cases"]
    grid = "".join(
        f'<line x1="{left}" x2="{w - right}" y1="{y(v):.1f}" y2="{y(v):.1f}" stroke="#d9ddd9"/>'
        f'<text x="{left - 8}" y="{y(v) + 4:.1f}" font-size="11" text-anchor="end" fill="#5b665f">{int(v * 100)}%</text>'
        for v in (0, 0.25, 0.5, 0.75, 1))
    ticks = "".join(f'<text x="{x:.1f}" y="{h - bottom + 18}" font-size="11" text-anchor="middle" fill="#5b665f">'
                    f'week {r["week"]}</text>' for x, r in zip(xs, rows))
    last = rows[-1]
    labels = (f'<text x="{xs[-1] - 6:.1f}" y="{y(last["share_person"]) + 20:.1f}" font-size="12" text-anchor="end" '
              f'fill="#a96300">a person decided</text>'
              f'<text x="{xs[-1] - 6:.1f}" y="{y(last["share_rule"]) - 10:.1f}" font-size="12" text-anchor="end" '
              f'fill="#2d62a3">a learned rule decided, no Grok call</text>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" '
            f'aria-label="Case curve: the share of cases a person decided falls from {rows[0]["share_person"]:.0%} '
            f'to {last["share_person"]:.0%} over {len(rows)} weeks as rules are learned" '
            f'font-family="IBM Plex Sans, system-ui, sans-serif"><rect width="{w}" height="{h}" fill="#ffffff"/>'
            f'<text x="{left}" y="22" font-size="14" font-weight="600" fill="#18201c">Case curve '
            f'(average of {rows[0].get("replays", 1)} replays of {sum(r["cases"] for r in rows)} invented claims, scripted Grok and person)</text>'
            f'{grid}{ticks}{line("share_person", "#a96300")}{line("share_rule", "#2d62a3")}{labels}</svg>\n')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay invented cases through the learning loop")
    parser.add_argument("--svg", help="write the chart to this file")
    parser.add_argument("--replays", type=int, default=20, help="average this many replays (seeds 1..N)")
    args = parser.parse_args(argv)
    rows = run_many(replays=args.replays)
    print(f"Average of {args.replays} replays, 10 invented claims a week; Grok and the person are scripted.")
    print("| Week | A person decided | Grok calls | Decided by a learned rule | Active rules |")
    print("|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['week']} | {r['share_person']:.0%} | {r['grok_calls']:.1f} | {r['decided_by_rule']:.1f} | "
              f"{r['active_rules']:.1f} |")
    if args.svg:
        with open(args.svg, "w", encoding="utf-8") as fh:
            fh.write(svg(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
