"""Grok learning from people's decisions, on real cases one after another.

    python -m scenarios.learning            # recorded Grok answers
    python -m scenarios.learning --live     # real Grok (XAI_API_KEY, or .env.local)

Four Esselunga orders ship, and each arrives with damaged packs noted on the signed
DDT; Esselunga claims each one. For every claim the run shows what Grok was given
(the documents, the Playbook, and the closest past decisions as examples), what it
decided, and whether a person was needed. After the same decision three times on
the same kind of case, code drafts a rule; a person approves it; the next claim of
that kind is decided by the rule, with no Grok call for the verdict.

Nothing is retrained inside Grok: it learns through what it is shown (past
decisions) and through rules people approve.
"""

from __future__ import annotations

import argparse
import shutil
import tempfile
from datetime import date
from pathlib import Path
from typing import Any

from agent import grok, learning
from core.world import fresh_erp
from crm.actions import decide
from dispute.claim_reader import call_grok as live_read_claim
from dispute.service import handle_claim
from dispute.verdict import DEFAULT_PLAYBOOK
from dispute.verdict import call_grok_verdict as live_verdict
from order.service import receive_order
from shipping.service import invoice_shipment, reconcile_and_send, record_delivery, ship_order

# order ref, packs ordered, packs damaged, how the retailer writes the order in the email
CASES = [("ESS-DMG-101", 1200, 48, "ESS DMG 101"), ("ESS-DMG-102", 1500, 96, "ESS-DMG-102"),
         ("ESS-DMG-103", 960, 72, "ess dmg 103"), ("ESS-DMG-104", 1800, 120, "ESS DMG-104")]
PRICE = 1.85


def _edi(ref: str, qty: int) -> str:
    return (f"UNH+1+ORDERS:D:96A:UN'BGM+220+{ref}+9'DTM+137:20261104:102'NAD+BY+BUYER001::9'"
            f"NAD+SU+SUPPLIER001::9'LIN+1++8000000000000:EN'QTY+21:{qty}'PRI+AAA:{PRICE}:CT'UNS+S'UNT+10+1'")


def _email(written_ref: str, damaged: int, invoice: str) -> str:
    return (f"Oggetto: Merce danneggiata ordine {written_ref}\n\nBuongiorno, allo scarico al CeDi Melzo "
            f"{damaged} confezioni di Arborio 1 kg erano rotte, come annotato con riserva sul DDT. "
            f"Fattura {invoice}. Chiediamo nota di credito di {damaged * PRICE:.2f} euro "
            f"({damaged} x {PRICE:.2f}).\n\nQualità Fornitori Esselunga")


def run(*, live: bool = False, quiet: bool = False, out_dir: Path | None = None) -> dict[str, Any]:
    say = (lambda *a: None) if quiet else print
    if live and not grok.has_key():
        raise SystemExit("--live needs XAI_API_KEY or GROK_API_KEY (environment or .env.local)")
    out = Path(out_dir or tempfile.mkdtemp(prefix="brc-learning-"))
    out.mkdir(parents=True, exist_ok=True)
    playbook = out / "playbook.md"
    shutil.copy(DEFAULT_PLAYBOOK, playbook)
    erp = fresh_erp()
    rows = []
    for n, (ref, qty, damaged, written) in enumerate(CASES, start=1):
        r = receive_order(erp, _edi(ref, qty), source_name=f"ORDERS {ref}")
        decide(erp, r["case_id"], approve=True, by="Giulia, order desk", reason="checks pass")
        sent = ship_order(erp, ref, ship_date="2026-11-05")
        inv = invoice_shipment(erp, sent["desadv_ref"], invoice_date="2026-11-05")
        reconcile_and_send(erp, ref)
        record_delivery(erp, sent["desadv_ref"], signed_by="Esselunga CeDi Melzo", when="2026-11-06",
                        note=f"{damaged} pz danneggiati")
        amount = round(damaged * PRICE, 2)
        recorded_read = {"order_ref": written, "invoice_ref": inv["invoice_ref"], "product": "Arborio 1 kg",
                         "quantity": damaged, "amount": amount, "claim_type": "damage", "confidence": 0.9,
                         "raw_notes": "damage noted on the DDT"}
        recorded_verdict = {"decision": "accept", "amount": amount, "confidence": 0.86, "needs_sign_off": False,
                            "summary": "Damage noted on the signed DDT.",
                            "points": [{"text": f"Signed DDT notes {damaged} damaged packs", "amount": amount,
                                        "source": {"kind": "pod", "ref": sent["ddt_ref"], "detail": "reservation"}}]}
        seen: dict[str, Any] = {}

        def read(text: str, rr: dict[str, Any] = recorded_read) -> dict[str, Any]:
            return live_read_claim(text, api_key=grok.api_key()) if live else dict(rr)

        def verdict(messages: list[dict[str, str]], rv: dict[str, Any] = recorded_verdict) -> dict[str, Any]:
            seen["prompt_chars"] = sum(len(m["content"]) for m in messages)
            seen["has_playbook"] = any("PLAYBOOK" in m["content"] for m in messages)
            seen["has_precedents"] = any('"precedents"' in m["content"] for m in messages)
            return live_verdict(messages, api_key=grok.api_key()) if live else dict(rv)

        claim = handle_claim(erp, _email(written, damaged, inv["invoice_ref"]), out_dir=out, read_caller=read,
                             verdict_caller=verdict, received_on=date(2026, 11, 7), issue_date=date(2026, 11, 7))
        logged = learning.case_for(erp, claim["claim_id"])
        v = claim["verdict"]
        say(f"\n== Claim {n}: {written}, {damaged} damaged packs, €{amount:.2f}")
        if seen:
            say(f"  Grok was given: the email, the documents (order, DESADV, invoice, signed DDT, threeway), "
                f"the Playbook{' and these past decisions: ' + ', '.join(logged['precedents']) if logged['precedents'] else ''}"
                f"{'' if logged['precedents'] else ' (no past decisions yet)'} ({seen['prompt_chars']:,} characters)")
            say(f"  Grok decided: {v['decision']} €{v['amount']} (confidence {v['confidence']:.2f}); "
                f"sources {', '.join(p['source']['ref'] for p in v['points'])}")
        else:
            say(f"  no Grok call for the verdict: rule {logged['rule_id']} decided {v['decision']} €{v['amount']}")
        if claim["status"] == "awaiting_person":
            say(f"  a person is needed: {'; '.join(v['sign_off_reasons'])}")
            decide(erp, claim["case_id"], approve=True, by="Sara, credit desk", reason="damage is on the signed DDT",
                   playbook_path=playbook)
            say("  Sara approves")
        else:
            say(f"  no person needed: {(erp.claim(claim['claim_id'])['outcome'] or {}).get('kind')} sent")
        for draft in learning.rules(erp, "draft"):
            say(f"  code drafted rule {draft['rule_id']} from {', '.join(draft['support'])}: {draft['text']}")
            learning.approve_rule(erp, draft["rule_id"], by="Sara, credit desk",
                                  reason="three damage claims backed by the signed DDT, all accepted")
            say("  Sara approves the rule: from now on it decides these claims")
        rows.append({"claim": n, "decided_by": "rule" if not seen else ("person" if claim["status"] == "awaiting_person" else "grok"),
                     "decision": v["decision"], "amount": v["amount"], "precedents": len(logged["precedents"] or []),
                     "grok_verdict_call": bool(seen)})
    say("\n" + learning.render_playbook(erp))
    return {"rows": rows, "rules": learning.rules(erp), "out_dir": str(out)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Show Grok learning from decisions on consecutive claims")
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args(argv)
    run(live=args.live)
    if args.live:
        print(grok.usage_summary())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
