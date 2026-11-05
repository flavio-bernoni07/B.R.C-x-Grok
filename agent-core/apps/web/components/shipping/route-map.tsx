"use client";

/**
 * The map of one dispatch day: the plant, the delivery points and the trucks, on the real map of
 * northern and central Italy (regions, coastline, lakes). Positions are true: plain
 * equirectangular, x scaled by cos(latitude), the same projection as the geometry in italy.ts
 * (built once by scripts/build-italy-map.py; nothing is fetched at request time). Legs are drawn
 * as gentle curves from stop to stop so a truck's way out and back stay apart; the km in the plan
 * are road km (OSRM).
 *
 * "By hand" draws today's way, orders grouped by warehouse: a trip from Pavia to each delivery point and
 * back. "Grok's plan" draws the planned trucks, each in its colour, stop after stop.
 */
import type { DispatchPlan } from "@agent/lib/shipping/routes";
import { useId, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ITALY_MAP } from "./italy";

export const TRUCK_COLORS = ["#203119", "#559646", "#9fc6bf", "#a2b9a2", "#cfe2cf"];

const INK = "#203119";
const ink = (a: number) => `rgb(32 49 25 / ${a})`;
const SEA = "#e6efec"; // Mint Cream, lighter
const LAND = "#fcfdfb"; // Seasalt with a breath of Honeydew
const ABROAD = "#f4f7f0"; // Honeydew, lighter: land outside Italy
const COAST = "#c2d9d4"; // Opal, lighter
const HALO = "#fcfdfb";

const { width: W, height: H, projection: PR } = ITALY_MAP;
const NAME = 15;
const SUB = 13;

type Pt = { x: number; y: number };
type Box = { x0: number; y0: number; x1: number; y1: number };
type Place = Pt & { id: string; label: string; sub: string; orders: number; r: number; plant?: boolean };
type Label = { p: Place; box: Box; anchor: "start" | "middle" | "end"; tx: number; leader: [Pt, Pt] | null };

const project = (lat: number, lon: number): Pt => ({ x: (lon - PR.lonMin) * PR.kx, y: (PR.latMax - lat) * PR.ky });

/** Rough text width for Satoshi; labels are placed on it, so it errs wide. */
const textW = (s: string, size: number) => s.length * size * 0.52;

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

function places(plan: DispatchPlan) {
  const byId = new Map<string, Place>();
  for (const r of plan.routes)
    for (const s of r.stops) {
      const prev = byId.get(s.point);
      byId.set(s.point, { id: s.point, label: s.retailer ?? s.point, sub: s.town ?? "", orders: (prev?.orders ?? 0) + s.orders.length, r: 7, ...project(s.lat, s.lon) });
    }
  const plant: Place = { id: plan.plant.id, label: "Pavia", sub: "Riso Scotti plant", orders: 0, r: 9, plant: true, ...project(plan.plant.lat, plan.plant.lon) };
  return { plant, points: byId };
}

/** The view: the map's own frame, grown only if a delivery point lies outside it. */
function viewBox(all: Place[]) {
  const pad = 60;
  const x0 = Math.min(0, ...all.map((p) => p.x - pad));
  const y0 = Math.min(0, ...all.map((p) => p.y - pad));
  const x1 = Math.max(W, ...all.map((p) => p.x + pad));
  const y1 = Math.max(H, ...all.map((p) => p.y + pad));
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

const DIRS = [
  { k: "E", dx: 1, dy: 0, cost: 0 },
  { k: "W", dx: -1, dy: 0, cost: 0 },
  { k: "NE", dx: 0.7, dy: -0.7, cost: 6 },
  { k: "SE", dx: 0.7, dy: 0.7, cost: 6 },
  { k: "NW", dx: -0.7, dy: -0.7, cost: 6 },
  { k: "SW", dx: -0.7, dy: 0.7, cost: 6 },
  { k: "N", dx: 0, dy: -1, cost: 10 },
  { k: "S", dx: 0, dy: 1, cost: 10 },
] as const;
const GAPS = [6, 18, 32, 48, 66, 88];

/**
 * Label placement: each label tries eight directions at growing distances and takes the cheapest
 * spot that covers no other label, point or route line and stays on the map. Crowded points go
 * first. A label set away from its point gets a short leader line.
 */
function placeLabels(all: Place[], plant: Place, view: { x0: number; y0: number; w: number; h: number }, lines: Pt[], k = 1, withSub = true): Label[] {
  const markers: Box[] = all.map((p) => ({ x0: p.x - p.r - 3, y0: p.y - p.r - 3, x1: p.x + p.r + 3, y1: p.y + p.r + 3 }));
  const crowd = (p: Place) => all.filter((q) => q !== p && Math.hypot(q.x - p.x, q.y - p.y) < 90).length;
  const order = [...all].sort((a, b) => crowd(b) - crowd(a) || a.y - b.y);
  const placed: Label[] = [];
  for (const p of order) {
    const sub = p.orders > 1 ? `${p.sub} · ${p.orders} orders` : p.sub;
    const w = Math.max(textW(p.label, NAME * k), withSub ? textW(sub, SUB * k) : 0) + 4;
    const h = withSub ? 34 * k : NAME * k + 6;
    const west = p.x < plant.x - 4 || (p.plant && all.some((q) => !q.plant && q.x > p.x + 4));
    let best: { cost: number; label: Label } | null = null;
    for (const g of GAPS)
      for (const d of DIRS) {
        const reach = p.r + g;
        const cx = p.x + d.dx * reach;
        const cy = p.y + d.dy * reach;
        const x0 = d.dx > 0 ? cx : d.dx < 0 ? cx - w : cx - w / 2;
        const y0 = d.dy > 0 ? cy : d.dy < 0 ? cy - h : cy - h / 2;
        const box = { x0, y0, x1: x0 + w, y1: y0 + h };
        let bump = 0;
        for (const m of markers) bump += overlap(box, m);
        for (const l of placed) bump += overlap(box, l.box) * 2;
        for (const q of lines) if (q.x > box.x0 - 2 && q.x < box.x1 + 2 && q.y > box.y0 - 2 && q.y < box.y1 + 2) bump += 6;
        const out =
          Math.max(0, view.x0 + 6 - box.x0) + Math.max(0, box.x1 - (view.x0 + view.w - 6)) + Math.max(0, view.y0 + 6 - box.y0) + Math.max(0, box.y1 - (view.y0 + view.h - 6));
        const side = (west ? d.dx > 0 : d.dx < 0) ? 8 : 0;
        const cost = g + d.cost + side + bump * 4 + out * 400;
        if (!best || cost < best.cost) {
          const anchor = d.dx > 0 ? "start" : d.dx < 0 ? "end" : "middle";
          const tx = anchor === "start" ? box.x0 : anchor === "end" ? box.x1 : (box.x0 + box.x1) / 2;
          let leader: [Pt, Pt] | null = null;
          if (g > 12) {
            const near = { x: Math.max(box.x0, Math.min(p.x, box.x1)), y: Math.max(box.y0 + 4, Math.min(p.y, box.y1 - 4)) };
            const len = Math.hypot(near.x - p.x, near.y - p.y) || 1;
            const ux = (near.x - p.x) / len;
            const uy = (near.y - p.y) / len;
            leader = [
              { x: p.x + ux * (p.r + 2), y: p.y + uy * (p.r + 2) },
              { x: near.x - ux * 3, y: near.y - uy * 3 },
            ];
          }
          best = { cost, label: { p, box, anchor, tx, leader } };
        }
      }
    if (best) placed.push(best.label);
  }
  return placed;
}

/** One truck's loop: plant, stops, plant; each leg bows a little to its right, so a truck's way
 * out and its way back stay apart. Also returns points along the line, for label placement. */
function loop(pts: Pt[]) {
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  const along: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(len * 0.13, 46);
    const c = { x: (a.x + b.x) / 2 - (dy / len) * bow, y: (a.y + b.y) / 2 + (dx / len) * bow };
    d += ` Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    const n = Math.max(2, Math.ceil(len / 7));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const u = 1 - t;
      along.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
    }
  }
  return { d, along };
}

/** A small truck, drawn upright, in its route's colour; the same glyph marks the truck in lists. */
export function TruckGlyph({ color, size = 18 }: { readonly color: string; readonly size?: number }) {
  return (
    <svg viewBox="-13 -9 26 18" width={size} height={(size * 18) / 26} aria-hidden className="shrink-0">
      <TruckShape color={color} />
    </svg>
  );
}

function TruckShape({ color }: { readonly color: string }) {
  return (
    <g stroke="#ffffff" strokeWidth={1.6} strokeLinejoin="round">
      <rect x="-12" y="-8" width="15" height="11.5" rx="2" fill={color} />
      <path d="M3.5 -4.5h4.6l3.4 3.6v4.4h-8z" fill={color} />
      <circle cx="-7" cy="5" r="2.6" fill={INK} />
      <circle cx="7" cy="5" r="2.6" fill={INK} />
    </g>
  );
}

/** Crop to the plant and the stops, with room for their names: a smaller map that stays legible. */
function cropBox(all: Place[]) {
  const x0 = Math.max(0, Math.min(...all.map((p) => p.x)) - 120);
  const x1 = Math.min(W, Math.max(...all.map((p) => p.x)) + 190);
  const y0 = Math.max(0, Math.min(...all.map((p) => p.y)) - 60);
  const y1 = Math.min(H, Math.max(...all.map((p) => p.y)) + 50);
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

export function RouteMap({
  plan,
  mode,
  focus,
  hideBaseline,
  compact,
  zoom,
  moving,
  className,
}: {
  readonly plan: DispatchPlan;
  readonly mode: "baseline" | "plan";
  readonly focus?: string | null;
  /** Draw only the planned routes (the trips of one truck per order are not shown). */
  readonly hideBaseline?: boolean;
  /** Home: cropped to the stops, names only, set larger so they read at a third of the width. */
  readonly compact?: boolean;
  /** Shipping, half the page: cropped to the stops, names a little larger, with their towns. */
  readonly zoom?: boolean;
  /** Each truck creeps along its loop while the map is on screen (the trucks have not left yet). */
  readonly moving?: boolean;
  readonly className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const crop = !!compact || !!zoom;
  const k = compact ? 2.3 : zoom ? 1.45 : 1;
  const m = compact ? 1.6 : zoom ? 1.25 : 1;
  const { plant, points, view, loops, labels, mapLabels, scale } = useMemo(() => {
    const { plant, points } = places(plan);
    const all = [plant, ...points.values()];
    const view = crop ? cropBox(all) : viewBox(all);
    const loops = plan.routes.map((r) => loop([plant, ...r.stops.map((s) => points.get(s.point)!).filter(Boolean), plant]));
    const lines = loops.flatMap((l) => l.along);
    const labels = placeLabels(all, plant, view, lines, k, !compact);
    // Region, country and sea names: the first of their spots that no label, point or route covers.
    const taken = [...labels.map((l) => l.box), ...all.map((p) => ({ x0: p.x - 12, y0: p.y - 12, x1: p.x + 12, y1: p.y + 12 }))];
    const mapLabels: { name: string; kind: string; x: number; y: number }[] = [];
    for (const m of compact ? [] : ITALY_MAP.labels) {
      const w = textW(m.name, 12) / 2 + 4;
      for (const [x, y] of m.spots) {
        const box = { x0: x - w, y0: y - 11, x1: x + w, y1: y + 8 };
        if (box.x0 < view.x0 + 8 || box.x1 > view.x0 + view.w - 8 || box.y0 < view.y0 + 8 || box.y1 > view.y0 + view.h - 28) continue;
        if (taken.some((t) => overlap(box, t) > 0) || lines.some((q) => q.x > box.x0 && q.x < box.x1 && q.y > box.y0 && q.y < box.y1)) continue;
        mapLabels.push({ name: m.name, kind: m.kind, x, y });
        taken.push(box);
        break;
      }
    }
    // 100 km at the centre latitude: x and y share one scale in this projection.
    const scale = (PR.ky / 111.32) * 100;
    return { plant, points, view, loops, labels, mapLabels, scale };
  }, [plan, compact, crop, k]);
  const trips = useMemo(() => {
    const byPoint = new Map<string, number>();
    for (const t of plan.baseline.trips) byPoint.set(t.point, (byPoint.get(t.point) ?? 0) + 1);
    return [...byPoint.entries()];
  }, [plan]);

  const clip = `map-${uid}`;
  const bottom = view.y0 + view.h;
  return (
    <svg
      viewBox={`${view.x0} ${view.y0} ${view.w} ${view.h}`}
      className={cn("h-auto w-full select-none", className)}
      role="img"
      aria-label={mode === "plan" ? "Planned truck routes" : "Orders grouped by warehouse, one truck each"}
    >
      {/* <desc>, not <title>: a title shows as a hover tooltip over the whole map. */}
      <desc>
        Map of northern and central Italy, true positions. Lines join the stops in order; km in the plan are road km (OSRM, OpenStreetMap). Regions: ISTAT via
        openpolis, CC BY 4.0. Countries and lakes: Natural Earth.
      </desc>
      <defs>
        <clipPath id={clip}>
          <rect x={view.x0} y={view.y0} width={view.w} height={view.h} rx="14" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clip})`}>
        {/* The map. */}
        <rect x={view.x0} y={view.y0} width={view.w} height={view.h} fill={SEA} />
        {/* Neighbours: a stroke under the fill leaves a coastline only on their outer edge. */}
        <path d={ITALY_MAP.neighbours} fill="none" stroke={COAST} strokeWidth={2} strokeLinejoin="round" />
        <path d={ITALY_MAP.neighbours} fill={ABROAD} />
        <path d={ITALY_MAP.land} fill={LAND} fillRule="evenodd" />
        <path d={ITALY_MAP.lakes} fill={SEA} stroke={COAST} strokeWidth={0.75} />
        <path d={ITALY_MAP.regionBorders} fill="none" stroke={ink(0.13)} strokeWidth={0.8} strokeLinejoin="round" strokeLinecap="round" />
        <path d={ITALY_MAP.nationalBorders} fill="none" stroke={ink(0.24)} strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" />
        <path d={ITALY_MAP.coast} fill="none" stroke={COAST} strokeWidth={1.1} strokeLinejoin="round" strokeLinecap="round" />
        {mapLabels.map((m) => (
          <text
            key={m.name}
            x={m.x}
            y={m.y + 4}
            textAnchor="middle"
            fontSize="12"
            fontWeight={500}
            fontStyle={m.kind === "sea" ? "italic" : undefined}
            letterSpacing="0.02em"
            fill={m.kind === "country" ? ink(0.22) : ink(0.3)}
          >
            {m.name}
          </text>
        ))}

        {/* Today's way: orders grouped by warehouse, one truck each, out and back. */}
        <g className="transition-opacity duration-500" style={{ opacity: mode === "baseline" && !hideBaseline ? 1 : 0 }}>
          {trips.map(([id, n]) => {
            const p = points.get(id);
            if (!p) return null;
            const mx = (plant.x + p.x) / 2;
            const my = (plant.y + p.y) / 2;
            return (
              <g key={id}>
                <line x1={plant.x} y1={plant.y} x2={p.x} y2={p.y} stroke={ink(0.45)} strokeWidth={1.4 + n * 0.8} strokeDasharray="5 5" strokeLinecap="round" />
                {/* The count rides on long lines only; near the plant the label already says how many orders. */}
                {n > 1 && Math.hypot(p.x - plant.x, p.y - plant.y) >= 90 ? (
                  <g transform={`translate(${mx},${my})`}>
                    <rect x="-15" y="-10" width="30" height="20" rx="10" fill={INK} />
                    <text textAnchor="middle" y="4.5" fontSize="12" fontWeight="700" fill="#ebf1e4">
                      ×{n}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </g>

        {/* The plan: each truck's loop, drawn in when it appears. */}
        <g>
          {plan.routes.map((r, i) => {
            const { d } = loops[i];
            const color = TRUCK_COLORS[i % TRUCK_COLORS.length];
            const dim = !!focus && focus !== r.truck_id;
            const width = (dim ? 2 : 3.25) * m;
            const draw = {
              strokeDasharray: 1,
              strokeDashoffset: mode === "plan" ? 0 : 1,
              transition: `stroke-dashoffset 900ms cubic-bezier(0.23,1,0.32,1) ${i * 140}ms`,
            };
            return (
              <g key={`${r.truck_id}-${i}`} style={{ opacity: mode === "plan" ? (dim ? 0.22 : 1) : 0, transition: "opacity 300ms" }}>
                <path d={d} pathLength={1} fill="none" stroke={ink(0.16)} strokeWidth={width + 2.5} strokeLinejoin="round" strokeLinecap="round" style={draw} />
                <path d={d} pathLength={1} fill="none" stroke={color} strokeWidth={width} strokeLinejoin="round" strokeLinecap="round" style={draw} />
              </g>
            );
          })}
        </g>

        {/* Leader lines, then the points, then their names (with a halo so lines never cut a word). */}
        {labels.map(({ p, leader }) =>
          leader ? <line key={`l-${p.id}`} x1={leader[0].x} y1={leader[0].y} x2={leader[1].x} y2={leader[1].y} stroke={ink(0.38)} strokeWidth={1} strokeLinecap="round" /> : null,
        )}
        {[...points.values()].map((p) => (
          <circle key={p.id} cx={p.x} cy={p.y} r={6.5 * m} fill="#ffffff" stroke={INK} strokeWidth={2.25 * m} />
        ))}
        <g transform={`translate(${plant.x},${plant.y}) scale(${m})`}>
          <rect x="-8.5" y="-8.5" width="17" height="17" rx="4.5" fill={INK} stroke="#ffffff" strokeWidth={1.5} />
          <circle r="2.6" fill="#bfff80" />
        </g>
        {/* The trucks: each sits on its way out and creeps a few km forward over two and a half minutes, then stops: road speed, seen from a country map. Only while the map is on screen. */}
        {moving && mode === "plan"
          ? plan.routes.map((r, i) => (
              <g key={`truck-${r.truck_id ?? i}`} style={{ opacity: focus && focus !== r.truck_id ? 0.25 : 1, transition: "opacity 300ms" }}>
                <g transform={`scale(${m})`}>
                  <TruckShape color={TRUCK_COLORS[i % TRUCK_COLORS.length]} />
                </g>
                <animateMotion
                  dur="150s"
                  fill="freeze"
                  calcMode="linear"
                  keyPoints={`${(0.07 + i * 0.09).toFixed(3)};${(0.095 + i * 0.09).toFixed(3)}`}
                  keyTimes="0;1"
                  rotate="0"
                  path={loops[i].d}
                />
              </g>
            ))
          : null}

        {labels.map(({ p, box, anchor, tx }) => {
          const sub = p.orders > 1 ? `${p.sub} · ${p.orders} orders` : p.sub;
          return (
            <g key={`t-${p.id}`} stroke={HALO} strokeWidth={4 * k} strokeLinejoin="round" style={{ paintOrder: "stroke" }}>
              <text x={tx} y={box.y0 + 13 * k} textAnchor={anchor} fontSize={NAME * k} fontWeight="700" fill={INK}>
                {p.label}
              </text>
              {compact ? null : (
                <text x={tx} y={box.y0 + 30 * k} textAnchor={anchor} fontSize={SUB * k} fill={ink(0.62)}>
                  {sub}
                </text>
              )}
            </g>
          );
        })}

        {/* Scale and credits. */}
        {compact ? null : (
          <g transform={`translate(${view.x0 + 22},${bottom - 22})`} stroke={ink(0.45)} strokeWidth={1} fill="none">
            <path d={`M0,-4 V0 H${scale.toFixed(1)} V-4`} />
            <text x={scale + 7} y="3" fontSize="11" fill={ink(0.5)} stroke="none">
              100 km
            </text>
          </g>
        )}
        <text x={view.x0 + view.w - 16} y={bottom - 14} textAnchor="end" fontSize={compact ? 13 : zoom ? 12 : 10} fill={ink(0.4)} stroke={HALO} strokeWidth={3} style={{ paintOrder: "stroke" }}>
          {compact ? "© ISTAT, openpolis (CC BY 4.0) · Natural Earth" : "Regions © ISTAT, openpolis (CC BY 4.0) · Natural Earth"}
        </text>
      </g>
    </svg>
  );
}
