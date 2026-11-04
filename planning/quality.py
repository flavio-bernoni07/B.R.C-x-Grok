"""Lot quality from a photo of the lab sample, and what it is worth.

    python -m planning.quality data/quality/sample_tray.png --variety Carnaroli --lot LOT-PADDY-17

1. The lab photographs the milled sample of a paddy delivery on a black tray.
2. Code finds each grain (threshold + connected regions) and measures it:
   - broken: shorter than 3/4 of a whole grain (the median length of the sample)
   - chalky: at least 3/4 of the grain is opaque white
   - a blob much bigger than one grain is two or more grains touching: it is flagged
     and left out of the percentages, never counted as one big grain.
3. Broken grains lower the whole-grain milling yield (resa a intero). Up to 1 point
   under the contract nothing changes; beyond that the price drops per point; at 6
   points the lot can be refused. One point is 10 kg of whole rice per tonne of paddy
   turned into broken rice, so a point is worth 10 kg x (milled price - broken price),
   both from the EU price data.
4. Where the lot goes: few broken grains, premium 1 kg packs; more, standard packs;
   many, rice drinks and rice cakes.
5. Too chalky, too many clumps, or a cut to apply: a person in the lab confirms first.

Contract yields per variety and the 70% total milling yield are demo values, to check
with the mentor and the Pavia/Vercelli paddy contract templates.
"""

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

TOTAL_MILLING_YIELD = 70.0
CONTRACT_WHOLE_YIELD = {"Carnaroli": 58.0, "Arborio": 60.0, "Selenio": 64.0, "S. Andrea": 62.0, "Baldo": 61.0,
                        "Roma": 61.0, "Long B": 58.0}
TOLERANCE_POINTS, REFUSE_POINTS = 1.0, 6.0
KG_PER_POINT = 10.0
CHALK_LEVEL = 225
CHALKY_SHARE = 0.75
BROKEN_RATIO = 0.75
CLUMP_RATIO = 1.6
LAB_CHECK_CHALKY_PCT = 6.0


@dataclass
class Grain:
    label: int
    area: int
    length: float
    whiteness: float
    kind: str  # whole | broken | clump | dust
    chalky: bool


def _otsu(gray: np.ndarray) -> int:
    hist = np.bincount(gray.ravel(), minlength=256).astype(float)
    total, sum_all = hist.sum(), np.dot(np.arange(256), hist)
    best, best_t, w0, sum0 = -1.0, 128, 0.0, 0.0
    for t in range(256):
        w0 += hist[t]
        if w0 == 0 or w0 == total:
            continue
        sum0 += t * hist[t]
        m0, m1 = sum0 / w0, (sum_all - sum0) / (total - w0)
        between = w0 * (total - w0) * (m0 - m1) ** 2
        if between > best:
            best, best_t = between, t
    return best_t


def analyse(image: Path | str | np.ndarray) -> dict[str, Any]:
    from PIL import Image
    from scipy import ndimage

    gray = np.asarray(Image.open(image).convert("L")) if not isinstance(image, np.ndarray) else image
    mask = gray > _otsu(gray)
    labels, n = ndimage.label(mask)
    raw = []
    for lab in range(1, n + 1):
        ys, xs = np.nonzero(labels == lab)
        if len(xs) < 3:
            continue
        coords = np.stack([xs, ys]).astype(float)
        eig = np.linalg.eigvalsh(np.cov(coords)) if len(xs) > 2 else np.array([0.0, 0.0])
        length = 4 * math.sqrt(max(eig.max(), 0.0))
        pixels = gray[ys, xs]
        raw.append((lab, len(xs), length, float(np.mean(pixels >= CHALK_LEVEL))))
    if not raw:
        raise ValueError("no grains found: is the tray black and the sample spread out?")
    median_area = float(np.median([a for _, a, _, _ in raw]))
    grains: list[Grain] = []
    for lab, area, length, white in raw:
        kind = "dust" if area < 0.25 * median_area else "clump" if area > CLUMP_RATIO * median_area else "grain"
        grains.append(Grain(lab, area, length, white, kind, white >= CHALKY_SHARE))
    singles = [g for g in grains if g.kind == "grain"]
    whole_len = float(np.median([g.length for g in singles])) if singles else 0.0
    for g in singles:
        g.kind = "broken" if g.length < BROKEN_RATIO * whole_len else "whole"
    measured = [g for g in grains if g.kind in {"whole", "broken"}]
    n_meas = len(measured) or 1
    return {
        "grains_measured": len(measured),
        "broken_pct": round(100 * sum(g.kind == "broken" for g in measured) / n_meas, 2),
        "chalky_pct": round(100 * sum(g.chalky for g in measured) / n_meas, 2),
        "clumps_left_out": sum(g.kind == "clump" for g in grains),
        "whole_grain_length_px": round(whole_len, 1),
        "grains": [asdict(g) for g in grains],
    }


def _latest(variety: str, stage: str) -> float | None:
    from planning.data import eu_series

    try:
        values = [p for _, p in eu_series(variety, stage) if not math.isnan(p)]
    except KeyError:
        return None
    return values[-1] if values else None


def lot_report(analysis: dict[str, Any], *, variety: str, lot: str, tonnes: float,
               paddy_price: float | None = None, milled_price: float | None = None,
               broken_price: float | None = None) -> dict[str, Any]:
    contract = CONTRACT_WHOLE_YIELD.get(variety)
    if contract is None:
        raise KeyError(f"no contract whole-grain yield for {variety!r}")
    paddy_price = paddy_price if paddy_price is not None else _latest(variety, "Paddy")
    milled_price = milled_price if milled_price is not None else _latest(variety, "Milled non parboiled")
    broken_price = broken_price if broken_price is not None else _latest("Mezzagrana", "Broken")
    whole_yield = TOTAL_MILLING_YIELD * (1 - analysis["broken_pct"] / 100)
    below = max(0.0, contract - whole_yield)
    per_point = KG_PER_POINT * ((milled_price or 0) - (broken_price or 0)) / 1000
    cut = round(max(0.0, below - TOLERANCE_POINTS) * per_point, 2)
    if below >= REFUSE_POINTS:
        destination, decision = "refuse, or buy at a renegotiated price", "can be refused"
    elif analysis["broken_pct"] < 5:
        destination, decision = "premium 1 kg packs", "accept"
    elif analysis["broken_pct"] < 15:
        destination, decision = "standard packs", "accept with the price cut" if cut else "accept"
    else:
        destination, decision = "rice drinks and rice cakes", "accept with the price cut" if cut else "accept"
    reasons = []
    if analysis["chalky_pct"] > LAB_CHECK_CHALKY_PCT:
        reasons.append(f"chalky grains {analysis['chalky_pct']:.1f}% (above {LAB_CHECK_CHALKY_PCT:.0f}%)")
    if analysis["clumps_left_out"] > 0.1 * max(analysis["grains_measured"], 1):
        reasons.append(f"{analysis['clumps_left_out']} clumps of touching grains left out: spread the sample again")
    if cut:
        reasons.append(f"a contract price cut of €{cut:.2f}/t would apply")
    if below >= REFUSE_POINTS:
        reasons.append(f"{below:.1f} yield points under contract: the lot can be refused")
    return {"lot": lot, "variety": variety, "tonnes": tonnes, "broken_pct": analysis["broken_pct"],
            "chalky_pct": analysis["chalky_pct"], "grains_measured": analysis["grains_measured"],
            "whole_yield": round(whole_yield, 2), "contract_whole_yield": contract,
            "points_below": round(below, 2), "eur_per_point": round(per_point, 2), "price_cut_eur_t": cut,
            "paddy_price_eur_t": paddy_price, "lot_value_cut_eur": round(cut * tonnes, 2),
            "destination": destination, "decision": decision, "needs_lab_check": bool(reasons),
            "why_lab_check": reasons,
            "sources": ["photo analysis (planning/quality.py)",
                        f"EU Agri-food prices: {variety} paddy and milled, Mezzagrana broken (latest week)",
                        "contract whole-grain yield (demo value)"]}


def check_lot(erp: Any, image: Path | str, *, variety: str, lot: str, tonnes: float,
              batch: str | None = None) -> dict[str, Any]:
    """Analyse, report, and when a person must confirm: a quality sign-off, plus a hold on the
    linked finished-goods batch so nothing from it ships meanwhile."""
    from core import signoff
    from core.stock import record_event

    report = lot_report(analyse(image), variety=variety, lot=lot, tonnes=tonnes)
    doc_id = erp.add_document("lot quality report", lot, json.dumps(report, ensure_ascii=False))
    erp.log("code", "quality.lot_checked", lot, source_doc=doc_id, detail={k: report[k] for k in
            ("broken_pct", "chalky_pct", "price_cut_eur_t", "destination")})
    if not report["needs_lab_check"]:
        return {"status": "accepted", "report": report, "doc_id": doc_id}
    if batch:
        record_event(erp, "quality_hold", batch=batch, note=f"lot {lot}: {'; '.join(report['why_lab_check'])}")
    case_id = signoff.request(erp, row="quality", kind="lot_check", subject_ref=lot,
                              title=f"Lot {lot} ({variety}, {tonnes:g} t): confirm the quality before use",
                              proposal={"report": report, "batch": batch, "doc_id": doc_id},
                              reasons=report["why_lab_check"])
    return {"status": "awaiting_person", "case_id": case_id, "report": report, "doc_id": doc_id}


def make_sample(path: Path | str, *, whole: int = 80, broken: int = 8, chalky: int = 4, clumps: int = 2,
                seed: int = 17, size: tuple[int, int] = (900, 600)) -> dict[str, int]:
    """Draw a synthetic tray with known counts, to test and demo the check without a lab photo."""
    from PIL import Image, ImageDraw

    rng = random.Random(seed)
    img = Image.new("L", size, 12)
    draw = ImageDraw.Draw(img)
    cols, rows = 15, 10
    cells = [(c, r) for r in range(rows) for c in range(cols)]
    rng.shuffle(cells)
    cw, ch = size[0] // cols, size[1] // rows
    kinds = ["whole"] * (whole - chalky) + ["chalky"] * chalky + ["broken"] * broken + ["clump"] * clumps
    if len(kinds) > len(cells):
        raise ValueError("too many grains for the tray")
    for kind, (c, r) in zip(kinds, cells):
        cx, cy = c * cw + cw // 2, r * ch + ch // 2
        horizontal = rng.random() < 0.5
        length = 14 if kind == "broken" else 28
        width = 10
        tone = 250 if kind == "chalky" else rng.randint(150, 185)

        def grain(x: int, y: int) -> None:
            w, h = (length, width) if horizontal else (width, length)
            draw.ellipse([x - w // 2, y - h // 2, x + w // 2, y + h // 2], fill=tone)

        grain(cx, cy)
        if kind == "clump":
            grain(cx + (8 if horizontal else 7), cy + (7 if horizontal else 8))
    img.save(path)
    return {"whole": whole, "broken": broken, "chalky": chalky, "clumps": clumps}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check a lot from a photo of its milled sample")
    parser.add_argument("image")
    parser.add_argument("--variety", default="Carnaroli")
    parser.add_argument("--lot", default="LOT-PADDY")
    parser.add_argument("--tonnes", type=float, default=30.0)
    args = parser.parse_args(argv)
    report = lot_report(analyse(args.image), variety=args.variety, lot=args.lot, tonnes=args.tonnes)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
