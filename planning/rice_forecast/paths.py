"""Where data lives. Defaults to the repo's data/ folder; override with RICE_DATA_DIR."""

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("RICE_DATA_DIR", REPO_ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"
OUT_DIR = DATA_DIR / "out"
