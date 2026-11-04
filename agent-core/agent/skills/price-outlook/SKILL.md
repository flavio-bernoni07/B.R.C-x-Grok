---
description: Paddy price outlook (where a variety's price is heading and whether to buy now or wait), made by putting the statistical baseline beside current news.
---

# Paddy price outlook

Keep it fast: at most three tool calls, then answer.

1. Call `rice_price_forecast` for the variety. The default is 8 weeks. The user already sees the chart, so don't repeat the whole table.
2. Call `rice_market_news` **once**, with one query that names the variety and the main drivers. For example: "Carnaroli paddy price Italy, India rice export policy, EU rice import tariffs, Asian export prices, last 30 days". Long B follows world prices; Carnaroli, Arborio and the other round varieties are mostly Italian.
3. Call `rice_market_snapshot` only if the user compares varieties or asks about world prices.

## Combine

- If `prophet_beats_naive` is false, centre on the last price and use the band as the range.
- Shift the range with the news. Name each driver, its direction (↑ or ↓) and its date. Stay inside the band unless the news clearly justifies leaving it, and say why when you do.

## Answer: short, no more than about 120 words

**<Variety>, next N weeks:** up / flat / down, likely €X–Y/t.
**Advice:** buy now / buy part / wait, plus one reason.

Then 2 to 4 bullets, one per driver: ↑ or ↓, the fact, the date, and a [source](url).

End with: "Advice only. A person signs every purchase."
