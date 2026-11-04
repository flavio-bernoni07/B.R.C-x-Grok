"""Checks code runs on anything Grok writes."""

from __future__ import annotations

import re

_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


def numbers_in(text: str) -> set[str]:
    """Digits only, so 12.000, 12000 and 12,000 compare equal; 2.20 and 220 too."""
    return {re.sub(r"[.,]", "", n).lstrip("0") or "0" for n in _NUMBER.findall(text or "")}


def unknown_numbers(text: str, allowed_text: str) -> set[str]:
    """Figures in `text` that do not appear anywhere in `allowed_text`."""
    return numbers_in(text) - numbers_in(allowed_text)
