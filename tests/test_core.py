"""Mini ERP, stock and production events, sign-off queue, Playbook write-back, digest."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from core import signoff
from core.digest import build_digest
from core.stock import allocate, available_to_promise, record_event
from core.world import fresh_erp

ROOT = Path(__file__).resolve().parents[1]
CAR = "8000000000001"


def test_world_loads_one_product_list_for_every_row() -> None:
    erp = fresh_erp()
    assert erp.product(gtin=CAR)["item_code"] == "CAR-1KG"
    assert erp.product(item_code="ARB-1KG-CTN12")["units_per_case"] == 12
    assert erp.retailer("BUYER001")["name"] == "Esselunga"
    assert any(row["action"] == "world.loaded" for row in erp.audit())


def test_atp_counts_released_and_planned_by_date_never_held() -> None:
    erp = fresh_erp()
    assert available_to_promise(erp, CAR)["atp"] == 12000 + 4000  # no date: planned counts
    assert available_to_promise(erp, CAR, "20261104")["atp"] == 12000  # LOT-C-0419 is ready on 9 Nov
    assert available_to_promise(erp, CAR, "2026-11-09")["atp"] == 16000
    record_event(erp, "quality_hold", batch="LOT-C-0418", qty=1200, note="chalky")
    atp = available_to_promise(erp, CAR, "20261104")
    assert atp["atp"] == 10800 and atp["held"] == 1200


def test_hold_release_and_line_stop() -> None:
    erp = fresh_erp()
    record_event(erp, "quality_hold", batch="LOT-C-0417")
    assert available_to_promise(erp, CAR, "20261104")["atp"] == 6000
    record_event(erp, "hold_released", batch="LOT-C-0417")
    assert available_to_promise(erp, CAR, "20261104")["atp"] == 12000
    record_event(erp, "line_stopped", batch="LOT-C-0419")
    assert available_to_promise(erp, CAR)["planned"] == 0
    with pytest.raises(ValueError):
        record_event(erp, "melted", batch="X")


def test_allocate_skips_held_batches() -> None:
    erp = fresh_erp()
    record_event(erp, "quality_hold", batch="LOT-C-0417")
    taken, short = allocate(erp, CAR, 8000)
    assert [t["batch"] for t in taken] == ["LOT-C-0418"]
    assert short == 2000


def test_signoff_needs_who_and_why() -> None:
    erp = fresh_erp()
    case_id = signoff.request(erp, row="dispute", kind="verdict", subject_ref="CLM-1", title="t",
                              proposal={"x": 1}, reasons=["Grok marked the case as unsure"])
    assert [c["case_id"] for c in signoff.pending(erp)] == [case_id]
    with pytest.raises(signoff.SignoffError):
        signoff.decide(erp, case_id, approve=True, by="Sara", reason="  ")
    done = signoff.decide(erp, case_id, approve=False, by="Sara", reason="Wrong order picked")
    assert done["status"] == "rejected" and done["decision_reason"] == "Wrong order picked"
    with pytest.raises(signoff.SignoffError):
        signoff.decide(erp, case_id, approve=True, by="Sara", reason="again")
    with pytest.raises(signoff.SignoffError):
        signoff.request(erp, row="dispute", kind="x", subject_ref="y", title="t", proposal={}, reasons=[])


def test_past_case_replaces_placeholder_then_appends(tmp_path: Path) -> None:
    playbook = tmp_path / "playbook.md"
    shutil.copy(ROOT / "data" / "disputes" / "playbook.md", playbook)
    signoff.record_past_case(playbook, when="2026-11-07", order_ref="RS26112", case_type="other",
                             decision="reject (approved)", amount=None, notes="Sara: late gate-in | quantities agree")
    signoff.record_past_case(playbook, when="2026-11-08", order_ref="PO1", case_type="pricing",
                             decision="accept", amount=72.0, notes="ok")
    text = playbook.read_text()
    assert "No past cases yet" not in text
    assert "| 2026-11-07 | RS26112 | other | reject (approved) | — | Sara: late gate-in quantities agree |" in text
    assert "| 2026-11-08 | PO1 | pricing | accept | 72.00 | ok |" in text


def test_digest_lists_waiting_cases() -> None:
    erp = fresh_erp()
    signoff.request(erp, row="order", kind="confirm", subject_ref="ESS1", title="Confirm ESS1",
                    proposal={}, reasons=["Order rule: a person confirms every order before ORDRSP"])
    digest = build_digest(erp)
    assert "Sign-offs: 0 decided, 1 waiting" in digest
    assert "SO-00001 (order): Confirm ESS1" in digest


def test_erp_file_persists(tmp_path: Path) -> None:
    db = tmp_path / "erp.sqlite"
    erp = fresh_erp(db)
    erp.close()
    from core.erp import Erp

    again = Erp(db)
    assert again.product(gtin=CAR)
