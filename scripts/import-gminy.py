"""Import gmina intake addresses from MSWiA's CSV export of its XLS file."""

import csv
import json
import re
import sys
from pathlib import Path


SOURCE_URL = (
    "https://api.dane.gov.pl/media/resources/20260416/"
    "Baza_teleadresowa_jst_w_Polsce_16.04.2026.xls"
)
SOURCE_DATE = "2026-04-16"
CHECKED_AT = "2026-09-24"
GMINA_TYPES = {"GW", "GMW", "GM", "MNP"}
EMAIL = re.compile(r"[^\s,@]+@[^\s,@]+\.[^\s,@]+")
PREFERRED_EMAILS = {
    "1202012": "sekretariat@borzecin.pl",
    "2814033": "urzad.miasta@dobremiasto.com.pl",
}
SOURCE_CORRECTIONS = {
    "1462011": (
        "info@plock.eu",
        "https://nowy.plock.eu/kontakt/",
    ),
    "1465011": (
        "kontakt@um.warszawa.pl",
        "https://um.warszawa.pl/kontakt",
    ),
    "2007072": (
        "sekretariat@sniadowo.pl",
        "https://www.sniadowo.pl/",
    ),
}
EXPECTED_COLUMNS = {
    "Kod_TERYT",
    "nazwa_samorządu",
    "Województwo",
    "Powiat",
    "typ_JST",
    "nazwa_urzędu_JST",
    "ogólny adres poczty elektronicznej gminy/powiatu/województwa",
}


def import_rows(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if not EXPECTED_COLUMNS.issubset(reader.fieldnames or []):
            raise ValueError("MSWiA columns changed")
        units = []
        for row in reader:
            if row["typ_JST"] not in GMINA_TYPES:
                continue
            unit_id = row["Kod_TERYT"].strip().zfill(7)
            if not re.fullmatch(r"\d{7}", unit_id):
                raise ValueError(f"Invalid TERYT: {unit_id}")
            raw_email = row[
                "ogólny adres poczty elektronicznej gminy/powiatu/województwa"
            ]
            addresses = EMAIL.findall(raw_email)
            preferred = PREFERRED_EMAILS.get(unit_id)
            if preferred and preferred not in addresses:
                raise ValueError(f"Preferred email absent from MSWiA file: {unit_id}")
            email = preferred or (addresses[0] if addresses else None)
            source_url = SOURCE_URL
            if unit_id in SOURCE_CORRECTIONS:
                email, source_url = SOURCE_CORRECTIONS[unit_id]
            units.append(
                {
                    "kind": "gmina",
                    "id": unit_id,
                    "name": row["nazwa_urzędu_JST"].strip(),
                    "place": row["nazwa_samorządu"].strip(),
                    "jstType": row["typ_JST"],
                    "powiat": row["Powiat"].strip(),
                    "voivodeship": row["Województwo"].strip(),
                    "email": email,
                    "sourceUrl": source_url,
                    "checkedAt": CHECKED_AT,
                    **({"missingReason": "No valid email in MSWiA file"} if not email else {}),
                }
            )
    if len(units) != 2477 or len({unit["id"] for unit in units}) != 2477:
        raise ValueError(f"Expected 2477 unique gminy, got {len(units)}")
    return sorted(units, key=lambda unit: unit["id"])


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: import-gminy.py INPUT.csv OUTPUT.json")
    result = {
        "sourceDate": SOURCE_DATE,
        "sourceUrl": SOURCE_URL,
        "checkedAt": CHECKED_AT,
        "units": import_rows(Path(sys.argv[1])),
    }
    Path(sys.argv[2]).write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
