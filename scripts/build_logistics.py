"""Build data/world/logistics.json: the places trucks drive between, road distances, fleet and fuel.

    python scripts/build_logistics.py          # needs the internet once; the app then reads the file offline
    # python.org builds on macOS have no certificates: SSL_CERT_FILE=$(python -m certifi) python scripts/build_logistics.py

Every figure in the file names where it came from:
- places: OpenStreetMap Nominatim (the plant at its street, each delivery point at the centre of
  the comune in data/world/retailers.json; the CeDi names are the demo world's, the towns are real)
- road km and minutes: OSRM table service on OpenStreetMap roads (car profile; the app never lets a
  truck average more than the legal 80 km/h, so drive times are a floor, not a promise)
- diesel price: MASE weekly national average (gasolio auto, taxes included), latest week in the series
- fuel use: ICCT 2018, typical EU tractor-trailer on the Long Haul cycle
- CO2 per litre: an estimate (2.65 kg/l), labelled as such
"""

from __future__ import annotations

import csv
import io
import json
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "world" / "logistics.json"
UA = {"User-Agent": "brc-hackathon-logistics-builder"}

PLANT = {"id": "PLANT-PV", "name": "Riso Scotti plant, Pavia", "query": "Via Angelo Scotti, Pavia, Italia", "fallback": "Pavia, Italia"}
# delivery point -> the comune it sits in (retailers.json names the point; Esselunga's CeDi is in Melzo)
POINT_TOWN = {
    "CeDi Melzo": "Melzo, Italia",
    "CeDi Carrefour Nord": "Milano, Italia",
    "CeDi Auchan": "Rozzano, Italia",
    "CeDi Coop Nord": "Casalecchio di Reno, Italia",
    "CeDi Ancona": "Ancona, Italia",
}
MASE_CSV = "https://sisen.mase.gov.it/dgsaie/api/v1/weekly-prices/report/export?format=CSV&lang=it"


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


def geocode(query: str) -> dict | None:
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": query, "format": "json", "limit": 1})
    hits = json.loads(get(url))
    time.sleep(1.1)  # Nominatim usage policy: at most one request a second
    if not hits:
        return None
    h = hits[0]
    return {"lat": round(float(h["lat"]), 5), "lon": round(float(h["lon"]), 5), "osm": f"{h['osm_type']}/{h['osm_id']}", "display_name": h["display_name"]}


def it_number(s: str) -> float:
    return float(s.replace(".", "").replace(",", "."))


def diesel() -> dict:
    rows = list(csv.DictReader(io.StringIO(get(MASE_CSV).decode("iso-8859-1"))))
    last = [r for r in rows if r.get("GASOLIO_AUTO")][-1]
    return {"eur_per_l": round(it_number(last["GASOLIO_AUTO"]) / 1000, 5), "week": last["DATA_RILEVAZIONE"],
            "source": "MASE, prezzi medi settimanali dei carburanti, gasolio auto (EUR per 1000 l, taxes included)",
            "url": MASE_CSV}


def main() -> int:
    retailers = json.loads((ROOT / "data" / "world" / "retailers.json").read_text())["retailers"]
    plant = geocode(PLANT["query"]) or geocode(PLANT["fallback"])
    points = [{"id": PLANT["id"], "name": PLANT["name"], "kind": "plant", **plant}]
    for r in retailers:
        town = POINT_TOWN[r["delivery_point"]]
        g = geocode(town)
        points.append({"id": r["delivery_point"], "name": r["delivery_point"], "kind": "delivery_point",
                       "retailer": r["name"], "gln": r["gln"], "town": town.split(",")[0], **g})
    coords = ";".join(f"{p['lon']},{p['lat']}" for p in points)
    osrm_url = f"https://router.project-osrm.org/table/v1/driving/{coords}?annotations=distance,duration"
    table = json.loads(get(osrm_url))
    km = [[round(d / 1000, 1) for d in row] for row in table["distances"]]
    minutes = [[round(s / 60) for s in row] for row in table["durations"]]
    out = {
        "_comment": "Places, road distances, fleet and fuel for the route planner (agent/lib/shipping/routes.ts). "
                    "Built by scripts/build_logistics.py; every figure names its source. The CeDi are the demo "
                    "world's delivery points, placed at the centre of their real comune.",
        "built_on": date.today().isoformat(),
        "points": points,
        "matrix": {"order": [p["id"] for p in points], "km": km, "minutes": minutes,
                   "source": "OSRM table service on OpenStreetMap roads, car profile (ODbL)", "url": osrm_url},
        "fleet": {
            "trucks": [
                {"truck_id": "TRUCK-PV-03", "plate": "GC204LM"},
                {"truck_id": "TRUCK-PV-04", "plate": "GC388RA"},
                {"truck_id": "TRUCK-PV-05", "plate": "GD015TS"},
                {"truck_id": "TRUCK-PV-06", "plate": "GD772BN"},
            ],
            "pallet_capacity": 33, "max_payload_kg": 24000,
            "source": "demo fleet: 13.6 m semi-trailer, 33 EUR pallets, same limits as the golden order's trucks",
        },
        "fuel": {
            "l_per_100km": 32.6,
            "source": "ICCT (2018), Fuel consumption testing of tractor-trailers in the European Union and the "
                      "United States: typical EU tractor-trailer, Long Haul cycle",
            "url": "https://theicct.org/publication/fuel-consumption-testing-of-tractor-trailers-in-the-european-union-and-the-united-states",
        },
        "diesel": diesel(),
        "co2": {"kg_per_l": 2.65, "source": "estimate: a common combustion factor for diesel, demo value "
                "(agent-core/OPS-WORKSPACE-PROMPT.md, section 5B); not a measured figure"},
        "rules": {
            "max_daily_driving_h": 9,
            "max_daily_driving_source": "Regulation (EC) No 561/2006, art. 6(1): daily driving time shall not exceed nine hours",
            "max_daily_driving_url": "https://eur-lex.europa.eu/eli/reg/2006/561/oj",
            "truck_speed_kmh": 80,
            "truck_speed_source": "Codice della Strada, art. 142: 80 km/h on motorways for goods vehicles over 12 t",
        },
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(points)} points, diesel {out['diesel']['eur_per_l']} EUR/l (week {out['diesel']['week']})")
    for p in points:
        print(f"  {p['id']:<22} {p['lat']:.4f},{p['lon']:.4f}  {p['display_name'][:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
