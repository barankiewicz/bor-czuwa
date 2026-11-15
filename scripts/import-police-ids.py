"""List PRG KPP/KMP units before their official intake addresses are checked."""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


PRG_URL = (
    "https://api.dane.gov.pl/media/resources/20260730/"
    "00_granice_specjalne_xml_414a8615.zip"
)
CHECKED_AT = "2026-09-24"
OGR = "{http://ogr.maptools.org/}"
GML = "{http://www.opengis.net/gml}"


def import_units(path: Path) -> list[dict]:
    root = ET.parse(path).getroot()
    units = []
    for member in root.findall(f"{GML}featureMember"):
        feature = member[0]
        unit_id = feature.findtext(f"{OGR}IIP_IDENTY")
        name = feature.findtext(f"{OGR}JPT_NAZWA_")
        if not unit_id or not name or not name.startswith(
            ("Komenda Powiatowa Policji", "Komenda Miejska Policji")
        ):
            raise ValueError(f"Unexpected PRG police unit: {unit_id}, {name}")
        units.append(
            {
                "kind": "police",
                "id": unit_id,
                "name": name,
                "email": None,
                "sourceUrl": None,
                "jurisdictionSourceUrl": PRG_URL,
                "checkedAt": None,
                "missingReason": "Official administrative intake page not researched",
            }
        )
    if len(units) != 336 or len({unit["id"] for unit in units}) != 336:
        raise ValueError(f"Expected 336 unique PRG police units, got {len(units)}")
    return sorted(units, key=lambda unit: unit["name"])


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: import-police-ids.py INPUT.gml OUTPUT.json")
    result = {
        "assembledAt": CHECKED_AT,
        "jurisdictionSourceUrl": PRG_URL,
        "idField": "IIP_IDENTY",
        "units": import_units(Path(sys.argv[1])),
    }
    Path(sys.argv[2]).write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
