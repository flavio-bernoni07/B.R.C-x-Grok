"""The Monday memo for the paddy buyer: this week's call per variety, every number with its source.

Code writes the memo from the advisor's facts. With a key, Grok rewrites it for the
buyer; any figure that is not one of the facts makes the code version stand.
"""

from __future__ import annotations

from typing import Any

from agent import grok
from agent.checks import unknown_amounts


def code_memo(calls: list[dict[str, Any]], backtest: dict[str, Any] | None = None) -> str:
    week = calls[0]["week"] if calls else "n/a"
    lines = [f"Paddy purchasing, week of {week}. A person signs every purchase.", ""]
    for c in calls:
        s = c["signals"]
        ago = f", a year ago €{c['price_a_year_ago']:.0f}" if c.get("price_a_year_ago") else ""
        world = (f"; world rice in euros {s['world_eur_3m'] * 100:+.1f}% over 3 months"
                 if s.get("world_eur_3m") is not None else "")
        trend = f"; 4-week trend {s['trend_4w'] * 100:+.1f}%" if s.get("trend_4w") is not None else ""
        lines.append(f"- {c['variety']}: €{c['price_eur_t']:.0f}/t{ago}. Expected {c['expected_8w_change'] * 100:+.1f}% "
                     f"in 8 weeks{world}{trend}. Call: {c['call']} ({c['tonnes_vs_usual']:g} "
                     f"{'week' if c['tonnes_vs_usual'] == 1 else 'weeks'} of use this week).")
    if backtest:
        lines += ["", f"Track record: over {backtest['n']} past variety-campaigns this rule paid "
                      f"{backtest['saved_pct'] * 100:+.2f}% against even buying and called the direction right "
                      f"{backtest['direction_hit_rate'] * 100:.0f}% of the time. Treat it as a signal, not a promise."]
    lines += ["", "Sources: " + "; ".join(sorted({src for c in calls for src in c["sources"]}))]
    return "\n".join(lines)


def weekly_memo(calls: list[dict[str, Any]], backtest: dict[str, Any] | None = None, *, caller: Any = None) -> dict[str, str]:
    text = code_memo(calls, backtest)
    if caller is None and not grok.has_key():
        return {"memo": text, "by": "code"}
    messages = [
        {"role": "system", "content": (
            "You write the Monday paddy purchasing memo for Riso Scotti's buyer: short, plain English, one line per "
            "variety, then one line on how far to trust it. Use only the figures in the facts; add none. "
            'Return one JSON object: {"memo": string}.')},
        {"role": "user", "content": text},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        extra = unknown_amounts(str(payload.get("memo") or ""), text)
        return [f"figures not in the facts: {extra}"] if extra else []

    try:
        payload = grok.chat_json(messages, task="forecast_quality.memo", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        return {"memo": text, "by": "code"}
    return {"memo": str(payload["memo"]), "by": "grok"}
