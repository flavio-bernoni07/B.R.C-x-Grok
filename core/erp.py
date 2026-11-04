"""Mini ERP: one SQLite database shared by the Order, Shipping and Dispute rows.

Every record keeps the document it came from (`source_doc`), and every action is
written to the `audit` table with who did it (code, grok or a person). That is how
the back office meets "every action traceable to its source document".

Quantities are stored in the product's own unit (EA for packs, CTN for cartons);
money is stored as REAL euros and turned into Decimal where documents are written.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "erp.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    gtin TEXT PRIMARY KEY,
    item_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    uom TEXT NOT NULL,
    units_per_case INTEGER NOT NULL DEFAULT 1,
    list_price REAL,
    vat_rate REAL NOT NULL,
    units_per_pallet INTEGER,
    unit_weight_kg REAL
);
CREATE TABLE IF NOT EXISTS retailers (
    gln TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    vat_id TEXT,
    address TEXT,
    cap TEXT,
    comune TEXT,
    provincia TEXT,
    sdi_code TEXT,
    delivery_point TEXT
);
CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref TEXT,
    body TEXT,
    path TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    subject_ref TEXT,
    source_doc TEXT,
    detail TEXT
);
CREATE TABLE IF NOT EXISTS batches (
    batch TEXT PRIMARY KEY,
    gtin TEXT NOT NULL,
    qty REAL NOT NULL,
    status TEXT NOT NULL,
    available_from TEXT,
    source_doc TEXT
);
CREATE TABLE IF NOT EXISTS production_events (
    event_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    batch TEXT,
    gtin TEXT,
    qty REAL,
    at TEXT NOT NULL,
    note TEXT
);
CREATE TABLE IF NOT EXISTS orders (
    order_ref TEXT PRIMARY KEY,
    buyer_gln TEXT,
    supplier_gln TEXT,
    order_date TEXT,
    delivery_date TEXT,
    status TEXT NOT NULL,
    contract_id TEXT,
    ordrsp_ref TEXT,
    source_doc TEXT,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS order_lines (
    order_ref TEXT NOT NULL,
    line_no INTEGER NOT NULL,
    gtin TEXT,
    qty_ordered REAL,
    qty_confirmed REAL,
    unit_price REAL,
    PRIMARY KEY (order_ref, line_no)
);
CREATE TABLE IF NOT EXISTS shipments (
    desadv_ref TEXT PRIMARY KEY,
    order_ref TEXT NOT NULL,
    ship_date TEXT,
    ddt_ref TEXT,
    source_doc TEXT,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS shipment_lines (
    desadv_ref TEXT NOT NULL,
    gtin TEXT NOT NULL,
    batch TEXT,
    qty REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
    invoice_ref TEXT PRIMARY KEY,
    order_ref TEXT NOT NULL,
    desadv_ref TEXT UNIQUE,
    invoice_date TEXT,
    total_net REAL,
    total_vat REAL,
    total REAL,
    status TEXT NOT NULL,
    source_doc TEXT,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS invoice_lines (
    invoice_ref TEXT NOT NULL,
    gtin TEXT NOT NULL,
    qty REAL NOT NULL,
    unit_price REAL NOT NULL,
    vat_rate REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS proofs (
    doc_id TEXT PRIMARY KEY,
    order_ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT,
    summary TEXT
);
CREATE TABLE IF NOT EXISTS claims (
    claim_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    order_ref TEXT,
    invoice_ref TEXT,
    status TEXT NOT NULL,
    source_doc TEXT,
    extraction TEXT,
    verdict TEXT,
    outcome TEXT
);
CREATE TABLE IF NOT EXISTS signoffs (
    case_id TEXT PRIMARY KEY,
    row TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_ref TEXT,
    title TEXT,
    proposal TEXT,
    reasons TEXT,
    status TEXT NOT NULL,
    decided_by TEXT,
    decision_reason TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _dumps(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, default=str)


def _loads(value: str | None) -> Any:
    if value is None:
        return None
    return json.loads(value)


class Erp:
    """Thin wrapper over sqlite3. One instance per database file (or `:memory:`)."""

    def __init__(self, path: Path | str = ":memory:") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()

    # ----- generic helpers -------------------------------------------------
    def close(self) -> None:
        self.db.close()

    def _one(self, sql: str, args: Iterable[Any] = ()) -> dict[str, Any] | None:
        row = self.db.execute(sql, tuple(args)).fetchone()
        return dict(row) if row else None

    def _all(self, sql: str, args: Iterable[Any] = ()) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.execute(sql, tuple(args)).fetchall()]

    def next_id(self, name: str, prefix: str, width: int = 5) -> str:
        cur = self._one("SELECT value FROM counters WHERE name = ?", (name,))
        value = (cur["value"] if cur else 0) + 1
        self.db.execute(
            "INSERT INTO counters(name, value) VALUES(?, ?) "
            "ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            (name, value),
        )
        self.db.commit()
        return f"{prefix}{value:0{width}d}"

    def log(
        self,
        actor: str,
        action: str,
        subject_ref: str | None = None,
        *,
        source_doc: str | None = None,
        detail: Any = None,
    ) -> None:
        if actor not in {"code", "grok", "person", "retailer"} and not actor.startswith("person:"):
            raise ValueError(f"unknown actor {actor!r}")
        self.db.execute(
            "INSERT INTO audit(at, actor, action, subject_ref, source_doc, detail) VALUES(?,?,?,?,?,?)",
            (now_iso(), actor, action, subject_ref, source_doc, _dumps(detail)),
        )
        self.db.commit()

    def audit(self, subject_ref: str | None = None) -> list[dict[str, Any]]:
        if subject_ref:
            rows = self._all("SELECT * FROM audit WHERE subject_ref = ? ORDER BY id", (subject_ref,))
        else:
            rows = self._all("SELECT * FROM audit ORDER BY id")
        for row in rows:
            row["detail"] = _loads(row["detail"])
        return rows

    # ----- documents -------------------------------------------------------
    def add_document(self, kind: str, ref: str | None, body: str | None, *, path: str | None = None) -> str:
        doc_id = self.next_id("doc", "DOC-")
        self.db.execute(
            "INSERT INTO documents(doc_id, kind, ref, body, path, created_at) VALUES(?,?,?,?,?,?)",
            (doc_id, kind, ref, body, path, now_iso()),
        )
        self.db.commit()
        return doc_id

    def document(self, doc_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM documents WHERE doc_id = ?", (doc_id,))

    def documents(self, ref: str | None = None, kind: str | None = None) -> list[dict[str, Any]]:
        sql, args = "SELECT * FROM documents WHERE 1=1", []
        if ref:
            sql += " AND ref = ?"
            args.append(ref)
        if kind:
            sql += " AND kind = ?"
            args.append(kind)
        return self._all(sql + " ORDER BY doc_id", args)

    # ----- master data -----------------------------------------------------
    def upsert_product(self, **p: Any) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO products(gtin, item_code, name, uom, units_per_case, list_price, "
            "vat_rate, units_per_pallet, unit_weight_kg) VALUES(?,?,?,?,?,?,?,?,?)",
            (
                p["gtin"], p["item_code"], p["name"], p["uom"], int(p.get("units_per_case") or 1),
                p.get("list_price"), float(p["vat_rate"]), p.get("units_per_pallet"), p.get("unit_weight_kg"),
            ),
        )
        self.db.commit()

    def product(self, *, gtin: str | None = None, item_code: str | None = None) -> dict[str, Any] | None:
        if gtin:
            return self._one("SELECT * FROM products WHERE gtin = ?", (gtin,))
        if item_code:
            return self._one("SELECT * FROM products WHERE item_code = ?", (item_code,))
        return None

    def products(self) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM products ORDER BY item_code")

    def upsert_retailer(self, **r: Any) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO retailers(gln, name, vat_id, address, cap, comune, provincia, "
            "sdi_code, delivery_point) VALUES(?,?,?,?,?,?,?,?,?)",
            (
                r["gln"], r["name"], r.get("vat_id"), r.get("address"), r.get("cap"), r.get("comune"),
                r.get("provincia"), r.get("sdi_code"), r.get("delivery_point"),
            ),
        )
        self.db.commit()

    def retailer(self, gln: str | None) -> dict[str, Any] | None:
        if not gln:
            return None
        return self._one("SELECT * FROM retailers WHERE gln = ?", (gln,))

    # ----- orders ----------------------------------------------------------
    def save_order(
        self,
        *,
        order_ref: str,
        buyer_gln: str | None,
        supplier_gln: str | None,
        order_date: str | None,
        lines: list[dict[str, Any]],
        status: str,
        source_doc: str | None,
        contract_id: str | None = None,
        delivery_date: str | None = None,
        notes: Any = None,
    ) -> None:
        self.db.execute("DELETE FROM order_lines WHERE order_ref = ?", (order_ref,))
        self.db.execute(
            "INSERT OR REPLACE INTO orders(order_ref, buyer_gln, supplier_gln, order_date, delivery_date, "
            "status, contract_id, ordrsp_ref, source_doc, notes) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (order_ref, buyer_gln, supplier_gln, order_date, delivery_date, status, contract_id, None,
             source_doc, _dumps(notes)),
        )
        for idx, line in enumerate(lines, start=1):
            self.db.execute(
                "INSERT INTO order_lines(order_ref, line_no, gtin, qty_ordered, qty_confirmed, unit_price) "
                "VALUES(?,?,?,?,?,?)",
                (order_ref, int(line.get("line_no") or idx), line.get("gtin"), line.get("quantity"),
                 line.get("qty_confirmed"), line.get("unit_price")),
            )
        self.db.commit()

    def order(self, order_ref: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM orders WHERE order_ref = ?", (order_ref,))
        if not row:
            return None
        row["notes"] = _loads(row["notes"])
        row["lines"] = self._all(
            "SELECT * FROM order_lines WHERE order_ref = ? ORDER BY line_no", (order_ref,)
        )
        return row

    def orders(self, status: str | None = None) -> list[dict[str, Any]]:
        refs = self._all(
            "SELECT order_ref FROM orders" + (" WHERE status = ?" if status else "") + " ORDER BY order_ref",
            (status,) if status else (),
        )
        return [self.order(r["order_ref"]) for r in refs]  # type: ignore[misc]

    def set_order(self, order_ref: str, **fields: Any) -> None:
        if not fields:
            return
        if "notes" in fields:
            fields["notes"] = _dumps(fields["notes"])
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE orders SET {cols} WHERE order_ref = ?", (*fields.values(), order_ref))
        self.db.commit()

    def confirm_line(self, order_ref: str, line_no: int, qty_confirmed: float) -> None:
        self.db.execute(
            "UPDATE order_lines SET qty_confirmed = ? WHERE order_ref = ? AND line_no = ?",
            (qty_confirmed, order_ref, line_no),
        )
        self.db.commit()

    # ----- shipments and invoices -----------------------------------------
    def save_shipment(self, *, desadv_ref: str, order_ref: str, ship_date: str, ddt_ref: str,
                      lines: list[dict[str, Any]], source_doc: str | None, notes: str | None) -> None:
        self.db.execute(
            "INSERT INTO shipments(desadv_ref, order_ref, ship_date, ddt_ref, source_doc, notes) VALUES(?,?,?,?,?,?)",
            (desadv_ref, order_ref, ship_date, ddt_ref, source_doc, notes),
        )
        for line in lines:
            self.db.execute(
                "INSERT INTO shipment_lines(desadv_ref, gtin, batch, qty) VALUES(?,?,?,?)",
                (desadv_ref, line["gtin"], line.get("batch"), line["qty"]),
            )
        self.db.commit()

    def shipments(self, order_ref: str) -> list[dict[str, Any]]:
        rows = self._all("SELECT * FROM shipments WHERE order_ref = ? ORDER BY desadv_ref", (order_ref,))
        for row in rows:
            row["lines"] = self._all("SELECT * FROM shipment_lines WHERE desadv_ref = ?", (row["desadv_ref"],))
        return rows

    def shipment(self, desadv_ref: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM shipments WHERE desadv_ref = ?", (desadv_ref,))
        if row:
            row["lines"] = self._all("SELECT * FROM shipment_lines WHERE desadv_ref = ?", (desadv_ref,))
        return row

    def save_invoice(self, *, invoice_ref: str, order_ref: str, desadv_ref: str, invoice_date: str,
                     lines: list[dict[str, Any]], total_net: float, total_vat: float, total: float,
                     status: str, source_doc: str | None, notes: str | None = None) -> None:
        self.db.execute(
            "INSERT INTO invoices(invoice_ref, order_ref, desadv_ref, invoice_date, total_net, total_vat, total, "
            "status, source_doc, notes) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (invoice_ref, order_ref, desadv_ref, invoice_date, total_net, total_vat, total, status, source_doc, notes),
        )
        for line in lines:
            self.db.execute(
                "INSERT INTO invoice_lines(invoice_ref, gtin, qty, unit_price, vat_rate) VALUES(?,?,?,?,?)",
                (invoice_ref, line["gtin"], line["qty"], line["unit_price"], line["vat_rate"]),
            )
        self.db.commit()

    def invoices(self, order_ref: str | None = None) -> list[dict[str, Any]]:
        if order_ref:
            rows = self._all("SELECT * FROM invoices WHERE order_ref = ? ORDER BY invoice_ref", (order_ref,))
        else:
            rows = self._all("SELECT * FROM invoices ORDER BY invoice_ref")
        for row in rows:
            row["lines"] = self._all("SELECT * FROM invoice_lines WHERE invoice_ref = ?", (row["invoice_ref"],))
        return rows

    def invoice(self, invoice_ref: str) -> dict[str, Any] | None:
        rows = [i for i in self.invoices() if i["invoice_ref"] == invoice_ref]
        return rows[0] if rows else None

    def set_invoice_status(self, invoice_ref: str, status: str) -> None:
        self.db.execute("UPDATE invoices SET status = ? WHERE invoice_ref = ?", (status, invoice_ref))
        self.db.commit()

    def add_proof(self, *, doc_id: str, order_ref: str, kind: str, ref: str, summary: str) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO proofs(doc_id, order_ref, kind, ref, summary) VALUES(?,?,?,?,?)",
            (doc_id, order_ref, kind, ref, summary),
        )
        self.db.commit()

    def proofs(self, order_ref: str) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM proofs WHERE order_ref = ? ORDER BY doc_id", (order_ref,))

    # ----- claims ----------------------------------------------------------
    def save_claim(self, *, claim_id: str, source_doc: str, status: str) -> None:
        self.db.execute(
            "INSERT INTO claims(claim_id, received_at, status, source_doc) VALUES(?,?,?,?)",
            (claim_id, now_iso(), status, source_doc),
        )
        self.db.commit()

    def set_claim(self, claim_id: str, **fields: Any) -> None:
        for key in ("extraction", "verdict", "outcome"):
            if key in fields:
                fields[key] = _dumps(fields[key])
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE claims SET {cols} WHERE claim_id = ?", (*fields.values(), claim_id))
        self.db.commit()

    def claim(self, claim_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM claims WHERE claim_id = ?", (claim_id,))
        if row:
            for key in ("extraction", "verdict", "outcome"):
                row[key] = _loads(row[key])
        return row

    def claims(self) -> list[dict[str, Any]]:
        return [self.claim(r["claim_id"]) for r in self._all("SELECT claim_id FROM claims ORDER BY claim_id")]  # type: ignore[misc]

    # ----- sign-off queue (see core/signoff.py) -----------------------------
    def insert_signoff(self, row: dict[str, Any]) -> None:
        self.db.execute(
            "INSERT INTO signoffs(case_id, row, kind, subject_ref, title, proposal, reasons, status, "
            "decided_by, decision_reason, created_at, decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["case_id"], row["row"], row["kind"], row.get("subject_ref"), row.get("title"),
             _dumps(row.get("proposal")), _dumps(row.get("reasons")), row["status"], None, None,
             now_iso(), None),
        )
        self.db.commit()

    def update_signoff(self, case_id: str, **fields: Any) -> None:
        for key in ("proposal", "reasons"):
            if key in fields:
                fields[key] = _dumps(fields[key])
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE signoffs SET {cols} WHERE case_id = ?", (*fields.values(), case_id))
        self.db.commit()

    def signoff(self, case_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM signoffs WHERE case_id = ?", (case_id,))
        if row:
            row["proposal"] = _loads(row["proposal"])
            row["reasons"] = _loads(row["reasons"])
        return row

    def signoffs(self, *, status: str | None = None, row: str | None = None) -> list[dict[str, Any]]:
        sql, args = "SELECT case_id FROM signoffs WHERE 1=1", []
        if status:
            sql += " AND status = ?"
            args.append(status)
        if row:
            sql += " AND row = ?"
            args.append(row)
        return [self.signoff(r["case_id"]) for r in self._all(sql + " ORDER BY case_id", args)]  # type: ignore[misc]
