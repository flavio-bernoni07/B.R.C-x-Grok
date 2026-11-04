"use client";

import type { MarketSnapshot } from "@agent/lib/rice";
import { cn } from "@/lib/utils";
import { eur, pct, shortDate, trendClass } from "./format";

/** Chat card for rice_market_snapshot: paddy prices per variety and world rice in euros. */
export function MarketOverview({ market }: { readonly market: MarketSnapshot }) {
  const thai = market.world.thai_5pct;
  return (
    <section className="w-full space-y-2 rounded-xl border bg-card p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">Paddy prices</h3>
        <span className="text-muted-foreground text-xs">week of {shortDate(market.as_of)}</span>
      </header>
      <table className="w-full text-sm tabular-nums">
        <tbody>
          {market.paddy.map((p) => (
            <tr key={p.variety} className="border-b last:border-0">
              <td className="py-1">{p.variety}</td>
              <td className="py-1 text-right">{eur(p.price_eur_t)}/t</td>
              <td className={cn("w-28 py-1 text-right", trendClass(p.change_52w_pct))}>{pct(p.change_52w_pct)} yoy</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted-foreground text-xs">
        World rice (Thai 5%): {eur(thai.eur_t)}/t,{" "}
        <span className={trendClass(thai.change_12m_eur_pct)}>{pct(thai.change_12m_eur_pct)}</span> in euros over 12
        months. Sources: EU Agri-food Data Portal, World Bank, ECB.
      </p>
    </section>
  );
}
