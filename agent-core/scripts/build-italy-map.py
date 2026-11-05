#!/usr/bin/env python3
"""Build the map of northern and central Italy behind the Shipping route map.

    python3 agent-core/scripts/build-italy-map.py [--cache DIR]

Run it by hand when the delivery points in data/world/logistics.json change. It downloads the
geometry (the internet is needed here, at build time only), crops it to a box around the plant
and the delivery points plus padding, projects it, simplifies it and writes
apps/web/components/shipping/italy.ts. The app reads only that file: it never fetches geometry.

Sources (recorded again in the generated file):
- Italian regions: openpolis/geojson-italy, topojson/limits_IT_regions.topo.json, derived from
  ISTAT's administrative boundaries, CC BY 4.0. TopoJSON keeps shared borders as shared arcs, so
  each border is simplified once and neighbouring regions still meet exactly.
- Neighbouring countries and lakes: Natural Earth 10m (admin 0 countries, lakes, lakes Europe),
  public domain.

Projection: plain equirectangular, x scaled by cos(latitude) at the centre of the box, fitted to
a 1000 x 520 view. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOGISTICS = ROOT / "data" / "world" / "logistics.json"
OUT = ROOT / "agent-core" / "apps" / "web" / "components" / "shipping" / "italy.ts"

SOURCES = {
    "regions": "https://raw.githubusercontent.com/openpolis/geojson-italy/master/topojson/limits_IT_regions.topo.json",
    "countries": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson",
    "lakes": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson",
    "lakes_europe": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes_europe.geojson",
}

W, H = 1000, 520
LAT_PAD, LON_PAD = 0.55, 1.4  # degrees around the points, before fitting the box to W x H
MARGIN = 14  # px: geometry is clipped this far outside the view, so clip edges never show
TOL = 0.45  # px: Douglas-Peucker tolerance
MIN_LAKE_AREA = 10  # px^2

REGION_EN = {
    "Piemonte": "Piedmont",
    "Valle d'Aosta/Vallée d'Aoste": "Aosta Valley",
    "Lombardia": "Lombardy",
    "Trentino-Alto Adige/Südtirol": "Trentino-South Tyrol",
    "Veneto": "Veneto",
    "Friuli-Venezia Giulia": "Friuli-Venezia Giulia",
    "Liguria": "Liguria",
    "Emilia-Romagna": "Emilia-Romagna",
    "Toscana": "Tuscany",
    "Umbria": "Umbria",
    "Marche": "Marche",
    "Lazio": "Lazio",
    "Abruzzo": "Abruzzo",
}
# Where to look for room for a sea's name (lon_min, lat_min, lon_max, lat_max).
SEAS = [("Adriatic Sea", (12.4, 42.8, 15.6, 45.2)), ("Ligurian Sea", (6.8, 42.8, 10.4, 44.4))]


def fetch(name: str, cache: Path):
    path = cache / Path(SOURCES[name]).name
    if not path.exists():
        print(f"downloading {SOURCES[name]}")
        try:
            with urllib.request.urlopen(SOURCES[name], timeout=120) as r:
                path.write_bytes(r.read())
        except urllib.error.URLError:  # e.g. python.org builds without root certificates
            subprocess.run(["curl", "-fsSL", "-o", str(path), SOURCES[name]], check=True)
    return json.loads(path.read_text("utf-8"))


# --- view and projection -------------------------------------------------------------------


def make_view():
    points = json.loads(LOGISTICS.read_text("utf-8"))["points"]
    lats = [p["lat"] for p in points]
    lons = [p["lon"] for p in points]
    mid_lat = (min(lats) + max(lats)) / 2
    mid_lon = (min(lons) + max(lons)) / 2
    k = math.cos(math.radians(mid_lat))
    span_lat = max(max(lats) - min(lats) + 2 * LAT_PAD, (max(lons) - min(lons) + 2 * LON_PAD) * k * H / W)
    span_lon = span_lat * W / H / k
    ky = H / span_lat
    return {"lonMin": mid_lon - span_lon / 2, "latMax": mid_lat + span_lat / 2, "kx": ky * k, "ky": ky}


def projector(view):
    lon0, lat0, kx, ky = view["lonMin"], view["latMax"], view["kx"], view["ky"]
    return lambda lon, lat: ((lon - lon0) * kx, (lat0 - lat) * ky)


# --- geometry helpers ----------------------------------------------------------------------


def simplify(pts, tol=TOL):
    """Douglas-Peucker, iterative; keeps both ends."""
    if len(pts) < 3:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm if norm else math.hypot(px - ax, py - ay)
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(ring, tol=TOL):
    """A closed ring: split at the point farthest from the first, simplify both halves."""
    if len(ring) < 4:
        return ring
    x0, y0 = ring[0]
    far = max(range(len(ring)), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    return simplify(ring[: far + 1], tol)[:-1] + simplify(ring[far:], tol)


def clip_ring(ring, x0, y0, x1, y1):
    """Sutherland-Hodgman against an axis-aligned box. The ring is open (last != first)."""
    def cut(pts, inside, cross):
        out = []
        for i, cur in enumerate(pts):
            prev = pts[i - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
        return out

    def at_x(x):
        return lambda p, q: (x, p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]))

    def at_y(y):
        return lambda p, q: (p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]), y)

    pts = ring
    for inside, cross in (
        (lambda p: p[0] >= x0, at_x(x0)),
        (lambda p: p[0] <= x1, at_x(x1)),
        (lambda p: p[1] >= y0, at_y(y0)),
        (lambda p: p[1] <= y1, at_y(y1)),
    ):
        if not pts:
            break
        pts = cut(pts, inside, cross)
    return pts if len(pts) >= 3 else []


def clip_line(line, x0, y0, x1, y1):
    """Keep the runs of a polyline whose segments touch the box (extra bits fall outside the view)."""
    runs, run = [], []
    for p, q in zip(line, line[1:]):
        touches = not (max(p[0], q[0]) < x0 or min(p[0], q[0]) > x1 or max(p[1], q[1]) < y0 or min(p[1], q[1]) > y1)
        if touches:
            if not run:
                run.append(p)
            run.append(q)
        elif run:
            runs.append(run)
            run = []
    if run:
        runs.append(run)
    return runs


def area(ring):
    return abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(ring, ring[1:] + ring[:1]))) / 2


def bbox(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def inside(rings, x, y):
    """Even-odd point in polygon over all rings (holes included)."""
    c = False
    for r in rings:
        for (ax, ay), (bx, by) in zip(r, r[1:] + r[:1]):
            if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
                c = not c
    return c


def seg_dist(x, y, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)


def label_spots(rings, name, size, area_box, step=5, n=6):
    """Where a name fits inside the rings: up to n centres, best first, whose text box keeps the
    most room to the edge (at least 2 px), each well apart from the ones before. The route map
    takes the first that no delivery label covers."""
    w, h = len(name) * size * 0.55 + 8, size + 6
    bx0, by0, bx1, by1 = area_box
    edges = [(a, b) for r in rings for a, b in zip(r, r[1:] + r[:1])]
    edges = [e for e in edges if not (max(e[0][0], e[1][0]) < bx0 - 40 or min(e[0][0], e[1][0]) > bx1 + 40
                                      or max(e[0][1], e[1][1]) < by0 - 40 or min(e[0][1], e[1][1]) > by1 + 40)]
    nx, ny = int((bx1 - bx0) / step) + 1, int((by1 - by0) / step) + 1
    field = {}
    for i in range(nx):
        for j in range(ny):
            x, y = bx0 + i * step, by0 + j * step
            d = min((seg_dist(x, y, a[0], a[1], b[0], b[1]) for a, b in edges), default=1e9)
            field[i, j] = d if inside(rings, x, y) else -d
    hw, hh = int(w / 2 / step) + 1, int(h / 2 / step) + 1
    cands = []
    for i in range(hw, nx - hw):
        for j in range(hh, ny - hh):
            if field[i, j] < h / 2:
                continue
            room = min(field[i + a, j + b] for a in range(-hw, hw + 1) for b in range(-hh, hh + 1))
            if room >= 2:
                cands.append((room, bx0 + i * step, by0 + j * step))
    cands.sort(reverse=True)
    picked = []
    for room, x, y in cands:
        if all(abs(x - px) > w * 0.7 or abs(y - py) > h * 2 for px, py in picked):
            picked.append((round(x, 1) if x % 1 else int(x), round(y, 1) if y % 1 else int(y)))
            if len(picked) == n:
                break
    return picked


def split_borders(runs, neighbour_rings, near=2.5):
    """Italy's outline is its coast plus its land borders; a stretch that runs along a
    neighbouring country's edge is a land border."""
    edges = [(a, b) for r in neighbour_rings for a, b in zip(r, r[1:] + r[:1])]
    coast, land = [], []
    for run in runs:
        x0, y0, x1, y1 = bbox([run])
        local = [e for e in edges if not (max(e[0][0], e[1][0]) < x0 - near or min(e[0][0], e[1][0]) > x1 + near
                                          or max(e[0][1], e[1][1]) < y0 - near or min(e[0][1], e[1][1]) > y1 + near)]
        on = [any(seg_dist(x, y, a[0], a[1], b[0], b[1]) < near for a, b in local) for x, y in run]
        piece, kind = [run[0]], None
        for k in range(1, len(run)):
            seg = on[k - 1] and on[k]
            if kind is not None and seg != kind:
                (land if kind else coast).append(piece)
                piece = [run[k - 1]]
            kind = seg
            piece.append(run[k])
        (land if kind else coast).append(piece)
    return coast, land


# --- path encoding -------------------------------------------------------------------------


def num(v: int) -> str:
    """Tenths of a px as the shortest decimal: 15 -> 1.5, 3 -> .3, -20 -> -2."""
    s = f"{abs(v) / 10:.1f}".rstrip("0").rstrip(".")
    s = s[1:] if s.startswith("0.") else s
    return ("-" if v < 0 else "") + (s or "0")


def encode(pts, closed):
    q = [(round(x * 10), round(y * 10)) for x, y in pts]
    out = [q[0]]
    for p in q[1:]:
        if p != out[-1]:
            out.append(p)
    if closed and len(out) > 1 and out[-1] == out[0]:
        out.pop()
    if len(out) < (3 if closed else 2):
        return ""
    parts = [f"M{num(out[0][0])} {num(out[0][1])}l"]
    nums = []
    for a, b in zip(out, out[1:]):
        nums += [num(b[0] - a[0]), num(b[1] - a[1])]
    body = nums[0]
    for n in nums[1:]:
        body += n if n.startswith("-") else " " + n
    return parts[0] + body + ("z" if closed else "")


# --- layers --------------------------------------------------------------------------------


def italy(topo, proj, box):
    tr = topo["transform"]
    (sx, sy), (tx, ty) = tr["scale"], tr["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append(proj(x * sx + tx, y * sy + ty))
        arcs.append(simplify(pts))

    regions = topo["objects"]["regions"]["geometries"]
    used = [0] * len(arcs)
    shapes = []
    for g in regions:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        mine = set()
        rings = []
        for poly in polys:
            for ring_arcs in poly:
                ring = []
                for a in ring_arcs:
                    mine.add(a if a >= 0 else ~a)
                    seg = arcs[a] if a >= 0 else arcs[~a][::-1]
                    ring += seg[1:] if ring else seg
                if ring and ring[0] == ring[-1]:
                    ring.pop()
                clipped = clip_ring(ring, *box)
                if clipped:
                    rings.append(clipped)
        for a in mine:
            used[a] += 1
        if rings:
            shapes.append((g["properties"]["reg_name"], rings))

    borders, outline = [], []
    for i, arc in enumerate(arcs):
        for run in clip_line(arc, *box):
            (borders if used[i] > 1 else outline).append(run)
    return shapes, borders, outline


def polygons(features, proj, box, keep):
    rings_by_name = []
    for f in features:
        if not keep(f["properties"]):
            continue
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        rings = []
        for poly in polys:
            for ring in poly:
                pts = [proj(lon, lat) for lon, lat in ring]
                if pts[0] == pts[-1]:
                    pts.pop()
                x0, y0, x1, y1 = bbox([pts])
                if x1 < box[0] or x0 > box[2] or y1 < box[1] or y0 > box[3]:
                    continue
                clipped = clip_ring(simplify_ring(pts), *box)
                if clipped:
                    rings.append(clipped)
        if rings:
            rings_by_name.append((f["properties"].get("NAME_EN") or f["properties"].get("name") or "", rings))
    return rings_by_name


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "brc-italy-map")
    args = ap.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)

    view = make_view()
    proj = projector(view)
    box = (-MARGIN, -MARGIN, W + MARGIN, H + MARGIN)
    inset = (8, 8, W - 8, H - 8)

    shapes, borders, outline = italy(fetch("regions", args.cache), proj, box)
    countries = fetch("countries", args.cache)["features"]
    neighbours = polygons(countries, proj, box, lambda p: p["ADMIN"] != "Italy")
    lake_features = fetch("lakes", args.cache)["features"] + fetch("lakes_europe", args.cache)["features"]
    lakes = [r for _, rings in polygons(lake_features, proj, box, lambda p: True) for r in rings if area(r) >= MIN_LAKE_AREA]

    def in_view(rings):
        return [r for r in (clip_ring(r, *inset) for r in rings) if r]

    coast, national = split_borders(outline, [r for _, rings in neighbours for r in rings])

    labels = []
    for name, rings in shapes:
        vis = in_view(rings)
        if vis:
            en = REGION_EN.get(name, name)
            spots = label_spots(vis, en, 12, bbox(vis))
            if spots:
                labels.append({"name": en, "kind": "region", "spots": spots})
    for name, rings in neighbours:
        vis = in_view(rings)
        if vis and sum(area(r) for r in vis) > 4000:
            spots = label_spots(vis, name, 12, bbox(vis))
            if spots:
                labels.append({"name": name, "kind": "country", "spots": spots})
    land = [r for _, rings in shapes for r in rings] + [r for _, rings in neighbours for r in rings]
    view_ring = [(inset[0], inset[1]), (inset[2], inset[1]), (inset[2], inset[3]), (inset[0], inset[3])]
    for name, (lo0, la0, lo1, la1) in SEAS:
        x0, y0 = proj(lo0, la1)
        x1, y1 = proj(lo1, la0)
        area_box = (max(x0, inset[0]), max(y0, inset[1]), min(x1, inset[2]), min(y1, inset[3]))
        spots = label_spots([view_ring] + in_view(land), name, 12, area_box)
        if spots:
            labels.append({"name": name, "kind": "sea", "spots": spots})

    def join(rings, closed=True):
        return "".join(encode(r, closed) for r in rings)

    layers = {
        "land": join([r for _, rings in shapes for r in rings]),
        "neighbours": join([r for _, rings in neighbours for r in rings]),
        "lakes": join(lakes),
        "regionBorders": join(borders, closed=False),
        "coast": join(coast, closed=False),
        "nationalBorders": join(national, closed=False),
    }
    today = dt.date.today().isoformat()
    proj_out = {k: round(v, 6) for k, v in view.items()}
    src = "\n".join(f" *   {u}" for u in SOURCES.values())
    ts = f"""/**
 * The map of northern and central Italy behind the Shipping route map (route-map.tsx).
 * Generated by agent-core/scripts/build-italy-map.py on {today} from data/world/logistics.json.
 * Do not edit by hand: change the script and run it again. Nothing here is fetched at request time.
 *
 * Sources, downloaded once at build time:
{src}
 *
 * - Italian regions, their borders and Italy's outline: openpolis/geojson-italy, derived from ISTAT's
 *   administrative boundaries (1 January 2026). Licence: CC BY 4.0, (c) Openpolis and ISTAT.
 * - Neighbouring countries and lakes: Natural Earth 10m, public domain (naturalearthdata.com).
 *
 * Projection: plain equirectangular, x scaled by cos(latitude) at the centre of the view:
 *   x = (lon - lonMin) * kx,  y = (latMax - lat) * ky.
 * Paths are in that {W} x {H} space, cropped to the plant and the delivery points plus padding and
 * simplified (Douglas-Peucker, {TOL} px). Shared region borders are simplified once, so regions meet exactly.
 */

export type MapLabel = {{ name: string; kind: "region" | "country" | "sea"; spots: [number, number][] }};

export type ItalyMap = {{
  width: number;
  height: number;
  projection: {{ lonMin: number; latMax: number; kx: number; ky: number }};
  /** Italy's regions, one path (even-odd). */
  land: string;
  /** Neighbouring countries and San Marino. */
  neighbours: string;
  lakes: string;
  /** Borders between two Italian regions. */
  regionBorders: string;
  /** Italy's coastline. */
  coast: string;
  /** Italy's land borders with its neighbours and San Marino. */
  nationalBorders: string;
  /** Names, each with up to six spots where it fits (best first), in the same space. */
  labels: MapLabel[];
}};

export const ITALY_MAP: ItalyMap = {{
  width: {W},
  height: {H},
  projection: {json.dumps(proj_out).replace('"', "")},
  labels: {json.dumps(labels, ensure_ascii=False)},
""" + "".join(f"  {k}:\n    {json.dumps(v)},\n" for k, v in layers.items()) + "};\n"
    OUT.write_text(ts, "utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1024:.1f} KB; {len(labels)} labels")
    for k, v in layers.items():
        print(f"  {k}: {len(v) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
