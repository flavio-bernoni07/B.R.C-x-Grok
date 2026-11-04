"""Documents for the Shipping and invoicing row, written by code from Mini ERP records.

- EANCOM DESADV (what is on the truck, by batch)
- DDT (the Italian transport document), as text
- EDI INVOIC 380 (the invoice for the retailer's system)
- FatturaPA TD01 (the same invoice for SdI), built and validated with a38

All are demo documents: marked as such, never transmitted.
"""

from __future__ import annotations

from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from io import StringIO
from typing import Any

import a38
import a38.validation

from dispute.outcome import SELLER

CENT = Decimal("0.01")


def money(value: float | Decimal) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def _yyyymmdd(iso: str) -> str:
    return iso.replace("-", "")[:8]


def build_desadv(*, desadv_ref: str, order_ref: str, ship_date: str, buyer_gln: str | None,
                 supplier_gln: str | None, delivery_point: str | None, lines: list[dict[str, Any]]) -> str:
    seg = [
        "UNH+1+DESADV:D:96A:UN:EAN005'",
        f"BGM+351+{desadv_ref}+9'",
        f"DTM+11:{_yyyymmdd(ship_date)}:102'",
        f"RFF+ON:{order_ref}'",
    ]
    if supplier_gln:
        seg.append(f"NAD+SU+{supplier_gln}::9'")
    if buyer_gln:
        seg.append(f"NAD+BY+{buyer_gln}::9'")
    if delivery_point:
        seg.append(f"NAD+DP+++{delivery_point}'")
    seg.append("CPS+1'")
    for n, line in enumerate(lines, start=1):
        seg.append(f"LIN+{n}++{line['gtin']}:SRV'")
        seg.append(f"QTY+12:{_qty(line['qty'])}'")
        if line.get("batch"):
            seg.append(f"PCI+36E'GIN+BX+{line['batch']}'")
    seg.append(f"CNT+2:{len(lines)}'")
    seg.append(f"UNT+{len(seg) + 1}+1'")
    return "\n".join(seg) + "\n"


def build_ddt(*, ddt_ref: str, desadv_ref: str, order_ref: str, ship_date: str, buyer: dict[str, Any] | None,
              lines: list[dict[str, Any]], products: dict[str, dict[str, Any]]) -> str:
    name = (buyer or {}).get("name") or "Retailer"
    point = (buyer or {}).get("delivery_point") or ""
    rows = []
    for line in lines:
        product = products.get(line["gtin"], {})
        rows.append(f"  {product.get('item_code', line['gtin']):<16} {product.get('name', ''):<40} "
                    f"batch {line.get('batch') or '-':<12} qty {_qty(line['qty'])} {product.get('uom', '')}")
    return (
        f"DOCUMENTO DI TRASPORTO {ddt_ref} (demo)\n"
        f"Mittente: {SELLER['denominazione']}, {SELLER['indirizzo']}, {SELLER['comune']}\n"
        f"Destinatario: {name}, {point}\n"
        f"Data: {ship_date}   Ordine: {order_ref}   DESADV: {desadv_ref}\n\n"
        + "\n".join(rows)
        + "\n\nFirma vettore: ______   Firma destinatario: ______\n"
    )


def build_invoic_380(*, invoice_ref: str, invoice_date: str, order_ref: str, desadv_ref: str,
                     buyer_gln: str | None, supplier_gln: str | None, lines: list[dict[str, Any]],
                     total_net: Decimal, total_vat: Decimal, total: Decimal) -> str:
    seg = [
        "UNH+1+INVOIC:D:96A:UN:EAN008'",
        f"BGM+380+{invoice_ref}+9'",
        f"DTM+137:{_yyyymmdd(invoice_date)}:102'",
        f"RFF+ON:{order_ref}'",
        f"RFF+DQ:{desadv_ref}'",
    ]
    if supplier_gln:
        seg.append(f"NAD+SU+{supplier_gln}::9'")
    if buyer_gln:
        seg.append(f"NAD+BY+{buyer_gln}::9'")
    seg.append("CUX+2:EUR:4'")
    for n, line in enumerate(lines, start=1):
        seg.append(f"LIN+{n}++{line['gtin']}:SRV'")
        seg.append(f"QTY+47:{_qty(line['qty'])}'")
        seg.append(f"MOA+203:{money(Decimal(str(line['qty'])) * Decimal(str(line['unit_price'])))}'")
        seg.append(f"PRI+AAA:{line['unit_price']}'")
        seg.append(f"TAX+7+VAT+++:::{line['vat_rate']:g}'")
    seg.append("UNS+S'")
    seg.append(f"MOA+79:{total_net}'")
    seg.append(f"MOA+124:{total_vat}'")
    seg.append(f"MOA+77:{total}'")
    seg.append(f"UNT+{len(seg) + 1}+1'")
    return "\n".join(seg) + "\n"


def build_td01_xml(*, invoice_ref: str, invoice_date: str, order_ref: str, ddt_ref: str, ship_date: str,
                   buyer: dict[str, Any], lines: list[dict[str, Any]],
                   products: dict[str, dict[str, Any]]) -> tuple[str, Decimal]:
    """FatturaPA TD01 via a38. Returns (xml, total). Raises if a38 validation fails."""
    vat = buyer.get("vat_id") or "IT00000000000"
    cedente = a38.CedentePrestatore(
        a38.DatiAnagraficiCedentePrestatore(
            a38.IdFiscaleIVA(SELLER["id_paese"], SELLER["id_codice"]),
            anagrafica=a38.Anagrafica(denominazione=SELLER["denominazione"]),
            regime_fiscale=SELLER["regime_fiscale"],
        ),
        a38.Sede(indirizzo=SELLER["indirizzo"], cap=SELLER["cap"], comune=SELLER["comune"],
                 provincia=SELLER["provincia"], nazione=SELLER["nazione"]),
    )
    cessionario = a38.CessionarioCommittente(
        a38.DatiAnagraficiCessionarioCommittente(
            a38.IdFiscaleIVA(vat[:2], vat[2:]),
            anagrafica=a38.Anagrafica(denominazione=buyer.get("name") or "Retailer"),
        ),
        a38.Sede(indirizzo=buyer.get("address") or "n/a", cap=buyer.get("cap") or "00000",
                 comune=buyer.get("comune") or "n/a", provincia=buyer.get("provincia") or "MI", nazione="IT"),
    )
    f = a38.FatturaPrivati12()
    f.fattura_elettronica_header.dati_trasmissione.update(
        a38.IdTrasmittente(SELLER["id_paese"], SELLER["id_codice"]),
        codice_destinatario=buyer.get("sdi_code") or "XXXXXXX",
    )
    f.fattura_elettronica_header.cedente_prestatore = cedente
    f.fattura_elettronica_header.cessionario_committente = cessionario
    body = f.fattura_elettronica_body[0]
    y, m, d = (int(x) for x in invoice_date[:10].split("-"))
    body.dati_generali.dati_generali_documento = a38.DatiGeneraliDocumento(
        tipo_documento="TD01", divisa="EUR", data=date(y, m, d), numero=invoice_ref,
        causale=[f"Ordine {order_ref}, DDT {ddt_ref}"],
    )
    sy, sm, sd = (int(x) for x in ship_date[:10].split("-"))
    body.dati_generali.dati_ordine_acquisto = [a38.DatiOrdineAcquisto(id_documento=order_ref[:20])]
    body.dati_generali.dati_ddt = [a38.DatiDDT(numero_ddt=ddt_ref[:20], data_ddt=date(sy, sm, sd))]
    for line in lines:
        product = products.get(line["gtin"], {})
        body.dati_beni_servizi.add_dettaglio_linee(
            descrizione=f"{product.get('name', line['gtin'])} (GTIN {line['gtin']})"[:1000],
            quantita=str(money(line["qty"])),
            unita_misura=product.get("uom") or "NR",
            prezzo_unitario=str(Decimal(str(line["unit_price"]))),
            aliquota_iva=str(money(line["vat_rate"])),
        )
    body.dati_beni_servizi.build_dati_riepilogo()
    body.build_importo_totale_documento()

    validation = a38.validation.Validation()
    f.validate(validation)
    if validation.errors:
        raise ValueError("FatturaPA TD01 failed a38 validation: " + "; ".join(str(e) for e in validation.errors))

    buf = StringIO()
    f.build_etree().write(buf, encoding="unicode", xml_declaration=True)
    xml = buf.getvalue()
    banner = "<!-- DEMO FatturaPA TD01 generated by shipping.documents (a38); not for SDI transmission -->\n"
    if xml.startswith("<?xml"):
        head, rest = xml.split("?>", 1)
        xml = head + "?>\n" + banner + rest.lstrip()
    total = Decimal(str(body.dati_generali.dati_generali_documento.importo_totale_documento))
    return xml, total


def _qty(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)
