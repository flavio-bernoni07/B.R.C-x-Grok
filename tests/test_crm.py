"""CRM backend: inbox router, case briefings, plain-language questions, the decision dispatcher, the API."""

from __future__ import annotations

import json
import threading
import urllib.request
from datetime import date
from pathlib import Path

import pytest

import demo
from core import signoff
from core.erp import Erp
from crm import actions, ask, briefing, inbox
from crm.api import Api, make_handler
from http.server import HTTPServer

ROOT = Path(__file__).resolve().parents[1]
INBOX = ROOT / "data" / "inbox"
LANE = {"01": "dispute", "02": "dispute", "03": "order", "04": "order", "05": "shipping", "06": "shipping",
        "07": "payment", "08": "payment", "09": "promo", "10": "other"}


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


@pytest.fixture()
def db(tmp_path: Path) -> Path:
    path = tmp_path / "demo.sqlite"
    demo.run(db=str(path), out_dir=tmp_path / "out", quiet=True)
    return path


def test_keyword_reader_finds_the_lane_but_never_decides_alone(db: Path) -> None:
    erp = Erp(db)
    right = 0
    for msg in sorted(INBOX.glob("*.txt")):
        lane, conf = inbox.classify_by_code(msg.read_text())
        right += lane == LANE[msg.name[:2]]
        assert conf < inbox.CLEAR
    assert right >= 9
    res = inbox.route(erp, (INBOX / "05_slot_move.txt").read_text())
    assert res["status"] == "awaiting_person" and res["lane"] == "shipping"
    assert res["refs"]["orders"] == ["ESS-GOLD-001"]


def test_grok_sorts_and_clear_messages_go_straight_to_their_lane(db: Path, tmp_path: Path) -> None:
    erp = Erp(db)
    for name in ("03_order_change_qty.txt", "05_slot_move.txt", "09_promo_notice.txt", "10_other.txt"):
        text = (INBOX / name).read_text()
        caller = lambda _m, n=name: {"lane": LANE[n[:2]], "refs": ["ESS-GOLD-001"] if "ESS-GOLD-001" in text else [],
                                     "summary": n, "confidence": 0.9}
        res = inbox.route(erp, text, caller=caller, out_dir=tmp_path)
        if name.startswith("10"):
            assert res["status"] == "awaiting_person"
        else:
            assert res["status"] == "routed", res
    notes = erp.order("ESS-GOLD-001")["notes"]
    assert notes["change_requests"] and notes["slot_requests"]
    assert erp.documents(kind="promo notice")


def test_grok_cannot_invent_a_reference(db: Path) -> None:
    erp = Erp(db)
    text = (INBOX / "09_promo_notice.txt").read_text()
    res = inbox.classify(erp, text, caller=lambda _m: {"lane": "promo", "refs": ["ESS-9999"], "confidence": 0.9})
    assert res["by"] == "code"  # Grok's answer failed the check twice


def test_payment_email_read_by_grok_is_checked_and_posted(db: Path, tmp_path: Path) -> None:
    erp = Erp(db)
    text = (INBOX / "07_payment_email.txt").read_text()
    good = {"remittance_ref": None, "docs": [{"invoice_ref": "FT-2026/0001", "due": 24710.40, "paid": 24410.40,
                                              "adjustments": [{"code": "PC", "amount": 300.0, "note": "volantino"}]}]}
    from finance.receivables import read_remittance_email

    assert read_remittance_email(erp, text, caller=lambda _m: good)["docs"][0]["paid"] == 24410.40
    bad = json.loads(json.dumps(good))
    bad["docs"][0]["paid"] = 24000.0
    assert read_remittance_email(erp, text, caller=lambda _m: bad) is None


def test_every_waiting_case_gets_a_three_line_briefing(db: Path) -> None:
    erp = Erp(db)
    inbox.route(erp, (INBOX / "10_other.txt").read_text())
    for case in erp.signoffs():
        b = briefing.brief(erp, case["case_id"])
        assert b["what_happened"] and b["proposal"] and b["question"]
    case_id = signoff.pending(erp)[0]["case_id"]
    rewritten = briefing.brief(erp, case_id, caller=lambda _m: {"what_happened": "A message.", "proposal": "File it.",
                                                                 "question": "Which lane?"})
    assert rewritten["by"] == "grok"
    invented = briefing.brief(erp, case_id, caller=lambda _m: {"what_happened": "Worth €9,999.", "proposal": "x",
                                                                "question": "y"})
    assert invented["by"] == "code"


def test_questions_pick_a_view_and_answer_from_its_rows(db: Path) -> None:
    erp = Erp(db)
    assert ask.ask(erp, "What are the numbers this week?")["view"] == "numbers"
    t = ask.ask(erp, "Show me the history of ESS-GOLD-001")
    assert t["view"] == "trace" and "ORDRSP" in t["answer"]
    d = ask.ask(erp, "Which deductions are we disputing?")
    assert d["view"] == "deductions" and d["rows"][0]["amount"] == 300.0
    live = ask.ask(erp, "how much is open?", caller=lambda m: {"view": "numbers", "filters": {}}
                   if "catalog" in m[0]["content"] else {"answer": "€300.00 is still open."})
    assert live["answered_by"] == "grok" and live["answer"] == "€300.00 is still open."
    liar = ask.ask(erp, "how much is open?", caller=lambda m: {"view": "numbers", "filters": {}}
                   if "catalog" in m[0]["content"] else {"answer": "€1,234,567 is open."})
    assert liar["answered_by"] == "code"


def test_decide_runs_what_each_row_needs(db: Path, tmp_path: Path) -> None:
    erp = Erp(db)
    edi = (ROOT / "data" / "world" / "golden" / "ORDERS_ESS-GOLD-001.edi").read_text().replace("ESS-GOLD-001", "ESS-NEW-002") \
        .replace("8000000000001", "8000000000000").replace("QTY+21:12000", "QTY+21:1000").replace("PRI+AAA:2.20", "PRI+AAA:1.85")
    from order.service import receive_order

    r = receive_order(erp, edi)
    done = actions.decide(erp, r["case_id"], approve=True, by="Giulia", reason="ok")
    assert done["done"].startswith("ORDRSP sent") and erp.order("ESS-NEW-002")["status"] == "ready_to_ship"
    short = receive_order(erp, edi.replace("ESS-NEW-002", "ESS-NEW-003").replace("8000000000000", "8000000000001"))
    assert short["step"] == "stock_short"  # Carnaroli is sold out and nothing can be split
    assert "desk" in actions.decide(erp, short["case_id"], approve=True, by="Giulia", reason="call Esselunga")["done"]
    res = inbox.route(erp, (INBOX / "10_other.txt").read_text())
    filed = actions.decide(erp, res["case_id"], approve=True, by="Sara", reason="sales visit", lane="other")
    assert filed["result"] == {"status": "filed"}
    with pytest.raises(signoff.SignoffError):
        actions.decide(erp, res["case_id"], approve=True, by="Sara", reason="again")


def test_api_serves_the_dashboard(db: Path) -> None:
    server = HTTPServer(("127.0.0.1", 0), make_handler(Api(str(db))))
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        def call(path, body=None):
            req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read())

        assert call("/api/health")["ok"] is True
        assert call("/api/numbers")["fill_rate"] == 0.9
        assert call("/api/orders")[0]["order_ref"] == "ESS-GOLD-001"
        assert "ORDERS" in call("/api/orders/ESS-GOLD-001/trace")["text"]
        assert call("/api/receivables?as_of=2026-11-30")["open_total"] == 300.0
        assert call("/api/ask", {"question": "what is waiting for a person?"})["view"] == "waiting"
        routed = call("/api/inbox", {"text": (INBOX / "10_other.txt").read_text()})
        waiting = call("/api/waiting")
        assert any(w["case_id"] == routed["case_id"] and w["question"] for w in waiting)
        decided = call(f"/api/waiting/{routed['case_id']}/decide",
                       {"approve": True, "by": "Sara", "reason": "sales visit", "lane": "other"})
        assert decided["done"] == "sent to other"
        with pytest.raises(urllib.error.HTTPError):
            call("/api/nothing")
    finally:
        server.shutdown()
