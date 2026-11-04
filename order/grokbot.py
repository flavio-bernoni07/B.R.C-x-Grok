"""Grokbot for the Order row: the three cases in order-dec.md.

1. parse_flags   -> Grok proposes a corrected EDI; the parser must read it cleanly.
2. qty_short     -> code computes the options (split or a reduced quantity);
                    Grok picks one and writes the message. Grok never sets a quantity.
3. price_mismatch -> code drafts the mail; Grok may rewrite it in the retailer's
                    language, keeping exactly the same figures.

Every function works without a key: it returns None (parse) or the code's own
choice and text, marked source="code". A person confirms every order anyway.
"""

from __future__ import annotations

from typing import Any

from agent import grok
from agent.checks import numbers_in


def _numbers(text: str) -> set[str]:
    return numbers_in(text)


def _live(caller: Any) -> bool:
    return caller is not None or grok.has_key()


# ----- 1. parse_flags -------------------------------------------------------

def propose_parse_fix(raw_edi: str, flags: list[dict[str, Any]], *, caller: Any = None) -> dict[str, Any] | None:
    if not _live(caller):
        return None
    messages = [
        {
            "role": "system",
            "content": (
                "You repair EDIFACT ORDERS messages for the Riso Scotti back office. "
                "Fix only what the parser flags name: segment terminators, date formats, "
                "Italian thousand separators in QTY (20.000 means 20000). Never invent a value "
                "you cannot read; if a value is unreadable, leave it and set confidence under 0.5. "
                "Return one JSON object: {\"corrected_edi\": string, \"changes\": "
                "[{\"segment\": string, \"before\": string, \"after\": string, \"why\": string}], "
                "\"confidence\": number from 0 to 1}."
            ),
        },
        {"role": "user", "content": "Parser flags:\n" + "\n".join(f"- {f.get('code')}: {f.get('message')}" for f in flags)
         + "\n\nEDI as received:\n" + raw_edi},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        problems = []
        if not isinstance(payload.get("corrected_edi"), str) or "BGM" not in payload.get("corrected_edi", ""):
            problems.append("corrected_edi must be the full EDI text with its BGM segment")
        if not isinstance(payload.get("changes"), list):
            problems.append("changes must be a list")
        if not isinstance(payload.get("confidence"), (int, float)):
            problems.append("confidence must be a number")
        return problems

    try:
        payload = grok.chat_json(messages, task="order.fix_parse", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        return None
    if float(payload.get("confidence") or 0) < 0.5:
        return None
    return payload


# ----- 2. qty_short ---------------------------------------------------------

def qty_options(*, ordered: float, available: float, next_date: str | None, later_available: float) -> list[dict[str, Any]]:
    """The only answers allowed. Quantities come from stock, never from Grok."""
    options: list[dict[str, Any]] = []
    now = max(int(available), 0)
    rest = int(ordered) - now
    if now > 0 and next_date and later_available >= rest > 0:
        options.append({"action": "split", "now_qty": now, "later_qty": rest, "later_date": next_date})
    if now > 0:
        options.append({"action": "mail", "now_qty": now, "later_qty": 0, "later_date": None})
    return options


def _qty_template(option: dict[str, Any], *, order_ref: str, ordered: float, buyer: str, product: str) -> str:
    if option["action"] == "split":
        return (
            f"Gentile {buyer}, per l'ordine {order_ref} ({product}) possiamo consegnare subito "
            f"{option['now_qty']} pezzi e i restanti {option['later_qty']} dal {option['later_date']}. "
            f"Vi confermiamo le due consegne con l'ORDRSP. Cordiali saluti, Riso Scotti."
        )
    return (
        f"Gentile {buyer}, per l'ordine {order_ref} ({product}) oggi possiamo garantire "
        f"{option['now_qty']} dei {int(ordered)} pezzi richiesti. Vi chiediamo se accettate questa quantità "
        f"o preferite rivedere l'ordine. Cordiali saluti, Riso Scotti."
    )


def propose_qty_resolution(
    *,
    order_ref: str,
    gtin: str,
    product: str,
    buyer: str,
    ordered: float,
    available: float,
    next_date: str | None,
    later_available: float,
    caller: Any = None,
) -> dict[str, Any] | None:
    options = qty_options(ordered=ordered, available=available, next_date=next_date, later_available=later_available)
    if not options:
        return None
    default = options[0]
    result = dict(default)
    result["message"] = _qty_template(default, order_ref=order_ref, ordered=ordered, buyer=buyer, product=product)
    result["source"] = "code"
    if not _live(caller):
        return result

    allowed_numbers = _numbers(" ".join(
        str(v) for o in options for v in (o["now_qty"], o["later_qty"], o["later_date"] or "")
    ) + f" {int(ordered)} {order_ref} {product}")
    messages = [
        {
            "role": "system",
            "content": (
                "You help the Riso Scotti order desk when stock is short. Choose one of the allowed "
                "options and write a short, polite message to the retailer in Italian. Use only the "
                "quantities and dates given. Return one JSON object: {\"action\": one of the allowed "
                "actions, \"message\": string, \"why\": string, \"confidence\": number}."
            ),
        },
        {"role": "user", "content": (
            f"Order {order_ref}, retailer {buyer}, product {product} (GTIN {gtin}). Ordered {int(ordered)}, "
            f"available now {int(available)}. Allowed options: {options}"
        )},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        problems = []
        if payload.get("action") not in {o["action"] for o in options}:
            problems.append(f"action must be one of {[o['action'] for o in options]}")
        extra = _numbers(str(payload.get("message") or "")) - allowed_numbers
        if extra:
            problems.append(f"the message uses figures that are not in the options: {sorted(extra)}")
        return problems

    try:
        payload = grok.chat_json(messages, task="order.qty_short", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        return result
    chosen = next(o for o in options if o["action"] == payload["action"])
    return {**chosen, "message": payload.get("message") or result["message"], "why": payload.get("why"),
            "confidence": payload.get("confidence"), "source": "grok"}


# ----- 3. price_mismatch ----------------------------------------------------

def polish_price_mail(code_draft: str, *, caller: Any = None) -> tuple[str, str]:
    """Returns (mail, source). The figures must stay exactly those of the code draft."""
    if not _live(caller):
        return code_draft, "code"
    allowed = _numbers(code_draft)
    messages = [
        {
            "role": "system",
            "content": (
                "You rewrite a price-discrepancy email from Riso Scotti to a retailer in clear, polite "
                "Italian. Keep every figure, order number and contract id exactly as given; add no new "
                "figure. Return one JSON object: {\"mail\": string}."
            ),
        },
        {"role": "user", "content": code_draft},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        mail = str(payload.get("mail") or "")
        if not mail:
            return ["mail is empty"]
        problems = []
        if _numbers(mail) - allowed:
            problems.append(f"new figures appeared: {sorted(_numbers(mail) - allowed)}")
        if allowed - _numbers(mail):
            problems.append(f"figures were dropped: {sorted(allowed - _numbers(mail))}")
        return problems

    try:
        payload = grok.chat_json(messages, task="order.price_mail", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        return code_draft, "code"
    return str(payload["mail"]), "grok"
