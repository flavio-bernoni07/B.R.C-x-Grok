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


_AMOUNT = re.compile(r"\d[\d.,]*\d|\d")


def amounts_in(text: str) -> set[float]:
    """Every value a figure in the text could mean, in Italian or English notation.
    "23.882,40" and "23,882.40" give 23882.40; "1.490" gives both 1490 and 1.49."""
    values: set[float] = set()
    for tok in _AMOUNT.findall(text or ""):
        cands = []
        if "." in tok and "," in tok:
            dec = "," if tok.rfind(",") > tok.rfind(".") else "."
            other = "." if dec == "," else ","
            cands.append(tok.replace(other, "").replace(dec, "."))
        elif "," in tok or "." in tok:
            sep = "," if "," in tok else "."
            head, _, tail = tok.rpartition(sep)
            cands.append(tok.replace(sep, ""))              # thousands separator
            if tok.count(sep) == 1:
                cands.append(head + "." + tail)              # decimal separator
        else:
            cands.append(tok)
        for c in cands:
            try:
                values.add(round(float(c), 2))
            except ValueError:
                pass
    return values


def amount_in_text(amount: float, text: str) -> bool:
    return any(abs(amount - v) <= 0.005 for v in amounts_in(text))


def unknown_amounts(text: str, allowed_text: str) -> list[float]:
    """Figures in `text` whose value appears nowhere in `allowed_text` (compared by value, so
    300.00, 300,00 and 300.0 are the same; a share like 0.9 may be written as 90%)."""
    allowed = amounts_in(allowed_text)
    allowed |= {round(a * 100, 2) for a in allowed if 0 < a <= 1}
    out = []
    for tok in _AMOUNT.findall(text or ""):
        options = amounts_in(tok)
        if options and not any(abs(o - a) <= 0.005 for o in options for a in allowed):
            out.append(min(options))
    return out
