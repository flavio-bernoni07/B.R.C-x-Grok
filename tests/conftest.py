"""Shared test setup.

- Tests never read the repo's .env.local: a saved Grok key must not turn an offline test into a live call.
- Tests never change tracked data: the Playbook and the sample outcomes must look the same after the run.
"""

import hashlib
import os
from pathlib import Path

import pytest

os.environ["BRC_OFFLINE"] = "1"

ROOT = Path(__file__).resolve().parents[1]
GUARDED = [ROOT / "data" / "disputes" / "playbook.md", ROOT / "data" / "disputes" / "outcomes"]


def _fingerprint() -> dict[str, str]:
    out = {}
    for path in GUARDED:
        files = sorted(path.rglob("*")) if path.is_dir() else [path]
        for f in files:
            if f.is_file():
                out[str(f.relative_to(ROOT))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


@pytest.fixture(scope="session", autouse=True)
def _tracked_data_unchanged():
    before = _fingerprint()
    yield
    after = _fingerprint()
    changed = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
    assert not changed, f"a test wrote to tracked data (restore with git checkout): {changed}"
