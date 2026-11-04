"""Dispute path: claim reading, facts, verdict (this package grows step by step)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from dispute.claim_reader import ClaimExtraction, ClaimType, read_claim

__all__ = ["ClaimExtraction", "ClaimType", "read_claim"]


def __getattr__(name: str):
    if name in __all__:
        from dispute import claim_reader

        return getattr(claim_reader, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
