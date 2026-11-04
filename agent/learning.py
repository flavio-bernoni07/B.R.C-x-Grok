"""The learning loop from grok-agent-dec.md: case log, precedents, rules, promotion.

1. Every decision is logged with the case's signature (task, case type, retailer,
   product, threeway reason, amount band, which proofs exist), who decided and why.
2. Before Grok decides, an ACTIVE rule that matches exactly decides instead, with
   no Grok call; otherwise the three closest past cases go into Grok's prompt.
3. When the same kind of case got the same decision three times (from a person or
   from Grok) and none was overturned, a DRAFT rule is written. A person must approve it before
   it decides anything. Playbook changes always need a person.
4. When a person overturns a rule's decision, the rule goes back to draft.

`render_playbook()` writes the rules as markdown, the same text people and Grok read.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from core.erp import Erp, now_iso

PROMOTE_AFTER = 3
PATTERN_KEYS = ("task", "case_type", "threeway_reason", "proofs", "checks")
WEIGHTS = {"case_type": 3, "threeway_reason": 3, "proofs": 2, "retailer": 1, "product": 1, "amount_band": 1, "checks": 2}

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_cases (case_id TEXT PRIMARY KEY, task TEXT NOT NULL, subject_ref TEXT,
    signature TEXT NOT NULL, proposal TEXT, confidence REAL, decided_by TEXT, asked_person INTEGER NOT NULL,
    why_person TEXT, decision TEXT, reason TEXT, overturned INTEGER NOT NULL DEFAULT 0, rule_id TEXT,
    precedents TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playbook_rules (rule_id TEXT PRIMARY KEY, task TEXT NOT NULL, pattern TEXT NOT NULL,
    action TEXT NOT NULL, status TEXT NOT NULL, support TEXT NOT NULL, text TEXT, approved_by TEXT,
    approved_reason TEXT, created_at TEXT NOT NULL, overturned_at TEXT);
"""


def ensure_schema(erp: Erp) -> None:
    erp.db.executescript(SCHEMA)
    erp.db.commit()


def amount_band(amount: float | None) -> str:
    if amount is None:
        return "none"
    return "<100" if amount < 100 else "100-500" if amount < 500 else "500-2000" if amount < 2000 else "2000+"


def dispute_signature(claim: dict[str, Any], facts: dict[str, Any]) -> dict[str, Any]:
    """What makes two disputes 'the same kind of case'."""
    threeway = facts.get("threeway") or {}
    reasons = sorted({l.get("reason") or "matched" for l in threeway.get("lines") or []}) or ["no threeway"]
    proofs = sorted({p.get("kind") for p in facts.get("proofs") or [] if p.get("kind") in {"pod", "recadv", "ddt",
                                                                                            "warehouse_event", "damage_photo"}})
    reservation = any("reservation" in (p.get("summary") or "") for p in facts.get("proofs") or [])
    checks = facts.get("checks") or {}
    flags = sorted(k for k, bad in (("late", checks.get("inside_complaint_window") is False),
                                    ("duplicate", bool(checks.get("earlier_claims_same_order_and_type"))),
                                    ("reservation_on_ddt", reservation),
                                    ("missing_documents", bool(facts.get("misses")))) if bad)
    return {
        "task": "dispute.verdict",
        "case_type": claim.get("claim_type") or "other",
        "retailer": (facts.get("order") or {}).get("customer"),
        "product": ((facts.get("order") or {}).get("lines") or [{}])[0].get("item_code"),
        "threeway_reason": "; ".join(reasons),
        "amount_band": amount_band(claim.get("amount")),
        "proofs": ",".join(proofs),
        "checks": ",".join(flags),
    }


def _pattern(sig: dict[str, Any]) -> dict[str, Any]:
    return {k: sig.get(k) for k in PATTERN_KEYS}


def log_case(erp: Erp, *, task: str, subject_ref: str, signature: dict[str, Any], proposal: dict[str, Any] | None,
             confidence: float | None, asked_person: bool, why_person: list[str], decided_by: str | None = None,
             decision: str | None = None, reason: str | None = None, rule_id: str | None = None,
             precedents: list[str] | None = None) -> str:
    ensure_schema(erp)
    case_id = erp.next_id("agent_case", "AC-")
    erp.db.execute(
        "INSERT INTO agent_cases(case_id, task, subject_ref, signature, proposal, confidence, decided_by, asked_person, "
        "why_person, decision, reason, overturned, rule_id, precedents, at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)",
        (case_id, task, subject_ref, json.dumps(signature), json.dumps(proposal, default=str), confidence, decided_by,
         int(asked_person), json.dumps(why_person), decision, reason, rule_id, json.dumps(precedents or []), now_iso()))
    erp.db.commit()
    if decision and decided_by and decided_by != "rule":
        maybe_draft_rule(erp, signature, decision)
    return case_id


def _case(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("signature", "proposal", "why_person", "precedents"):
        out[key] = json.loads(out[key]) if out[key] else None
    return out


def cases(erp: Erp, task: str | None = None) -> list[dict[str, Any]]:
    ensure_schema(erp)
    rows = erp._all("SELECT * FROM agent_cases" + (" WHERE task = ?" if task else "") + " ORDER BY case_id",
                    (task,) if task else ())
    return [_case(r) for r in rows]


def case_for(erp: Erp, subject_ref: str) -> dict[str, Any] | None:
    ensure_schema(erp)
    rows = erp._all("SELECT * FROM agent_cases WHERE subject_ref = ? ORDER BY case_id", (subject_ref,))
    return _case(rows[-1]) if rows else None


def record_person_decision(erp: Erp, subject_ref: str, *, decided_by: str, decision: str, reason: str,
                           overturned: bool) -> list[str]:
    """A person decided a logged case. Overturning a rule demotes it. Returns rules drafted or demoted."""
    case = case_for(erp, subject_ref)
    if not case:
        return []
    erp.db.execute("UPDATE agent_cases SET decided_by = ?, decision = ?, reason = ?, overturned = ? WHERE case_id = ?",
                   (decided_by, decision, reason, int(overturned), case["case_id"]))
    erp.db.commit()
    changed = []
    if overturned and case["rule_id"]:
        demote_rule(erp, case["rule_id"], why=f"{decided_by} overturned {subject_ref}: {reason}")
        changed.append(case["rule_id"])
    if not overturned:
        drafted = maybe_draft_rule(erp, case["signature"], decision)
        if drafted:
            changed.append(drafted)
    return changed


def similar(erp: Erp, signature: dict[str, Any], k: int = 3) -> list[dict[str, Any]]:
    """The k closest decided cases of the same task, never an overturned one."""
    scored = []
    for c in cases(erp, signature["task"]):
        if not c["decision"] or c["overturned"]:
            continue
        score = sum(w for key, w in WEIGHTS.items() if c["signature"].get(key) == signature.get(key))
        scored.append((score, c["case_id"], c))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [{"case_id": c["case_id"], "subject_ref": c["subject_ref"], "decision": c["decision"],
             "decided_by": c["decided_by"], "reason": c["reason"], "score": s}
            for s, _, c in scored[:k] if s > 0]


def rules(erp: Erp, status: str | None = None) -> list[dict[str, Any]]:
    ensure_schema(erp)
    rows = erp._all("SELECT * FROM playbook_rules" + (" WHERE status = ?" if status else "") + " ORDER BY rule_id",
                    (status,) if status else ())
    for r in rows:
        for key in ("pattern", "action", "support"):
            r[key] = json.loads(r[key])
    return rows


def match_rule(erp: Erp, signature: dict[str, Any]) -> dict[str, Any] | None:
    pattern = _pattern(signature)
    for r in rules(erp, "active"):
        if r["pattern"] == pattern:
            return r
    return None


def maybe_draft_rule(erp: Erp, signature: dict[str, Any], decision: str) -> str | None:
    """The same decision three times on the same kind of case, none overturned: draft a rule.
    A draft decides nothing until a person approves it."""
    pattern = _pattern(signature)
    if any(r["pattern"] == pattern and r["status"] in {"draft", "active"} for r in rules(erp)):
        return None
    # Decisions by a person or by Grok both count; a rule's own decisions do not.
    same = [c for c in cases(erp, signature["task"]) if _pattern(c["signature"]) == pattern and c["decision"]
            and c["decided_by"] and c["decided_by"] != "rule"]
    if any(c["overturned"] for c in same):
        return None
    agreeing = [c for c in same if c["decision"] == decision]
    if len(agreeing) < PROMOTE_AFTER or len(agreeing) != len(same):
        return None
    rule_id = erp.next_id("playbook_rule", "R-")
    text = (f"When a {pattern['case_type']} claim has threeway '{pattern['threeway_reason']}', proofs "
            f"[{pattern['proofs'] or 'none'}] and flags [{pattern['checks'] or 'none'}]: {decision}.")
    erp.db.execute(
        "INSERT INTO playbook_rules(rule_id, task, pattern, action, status, support, text, created_at) VALUES(?,?,?,?,?,?,?,?)",
        (rule_id, signature["task"], json.dumps(pattern), json.dumps({"decision": decision}), "draft",
         json.dumps([c["case_id"] for c in agreeing]), text, now_iso()))
    erp.db.commit()
    erp.log("code", "agent.rule_drafted", rule_id, detail={"pattern": pattern, "decision": decision})
    return rule_id


def approve_rule(erp: Erp, rule_id: str, *, by: str, reason: str) -> None:
    if not reason.strip():
        raise ValueError("write one line on why the rule is right")
    erp.db.execute("UPDATE playbook_rules SET status = 'active', approved_by = ?, approved_reason = ? WHERE rule_id = ?",
                   (by, reason, rule_id))
    erp.db.commit()
    erp.log(f"person:{by}", "agent.rule_approved", rule_id, detail=reason)


def demote_rule(erp: Erp, rule_id: str, *, why: str) -> None:
    erp.db.execute("UPDATE playbook_rules SET status = 'draft', overturned_at = ? WHERE rule_id = ?", (now_iso(), rule_id))
    erp.db.commit()
    erp.log("code", "agent.rule_demoted", rule_id, detail=why)


def render_playbook(erp: Erp, task: str = "dispute.verdict") -> str:
    lines = [f"# Learned rules: {task}", "",
             "Written by agent/learning.py from people's decisions. Active rules decide with no Grok call; "
             "draft rules wait for a person.", ""]
    for status in ("active", "draft"):
        rs = [r for r in rules(erp, status) if r["task"] == task]
        lines.append(f"## {status.capitalize()} ({len(rs)})")
        for r in rs:
            who = f", approved by {r['approved_by']}: {r['approved_reason']}" if r["approved_by"] else ""
            lines.append(f"- **{r['rule_id']}** {r['text']} Supported by {', '.join(r['support'])}{who}")
        lines.append("")
    return "\n".join(lines)


def write_playbook(erp: Erp, path: Path | str, task: str = "dispute.verdict") -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(render_playbook(erp, task), encoding="utf-8")
