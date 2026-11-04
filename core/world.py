"""Load the one fake world (products, retailers, starting stock) into a Mini ERP."""

from __future__ import annotations

import json
from pathlib import Path

from core.erp import Erp
from core.stock import record_event

WORLD_DIR = Path(__file__).resolve().parents[1] / "data" / "world"


def load_world(erp: Erp, world_dir: Path | str = WORLD_DIR) -> Erp:
    root = Path(world_dir)
    for product in json.loads((root / "products.json").read_text(encoding="utf-8"))["products"]:
        erp.upsert_product(**product)
    for retailer in json.loads((root / "retailers.json").read_text(encoding="utf-8"))["retailers"]:
        erp.upsert_retailer(**retailer)
    for event in json.loads((root / "stock.json").read_text(encoding="utf-8"))["events"]:
        record_event(erp, event["kind"], batch=event["batch"], gtin=event.get("gtin"), qty=event.get("qty"),
                     available_from=event.get("available_from"), note=event.get("note"))
    erp.log("code", "world.loaded", None, detail={"from": str(root)})
    return erp


def fresh_erp(path: Path | str = ":memory:", world_dir: Path | str = WORLD_DIR) -> Erp:
    """A new database with the world loaded. Deletes an existing file at `path`."""
    if str(path) != ":memory:" and Path(path).exists():
        Path(path).unlink()
    return load_world(Erp(path), world_dir)
