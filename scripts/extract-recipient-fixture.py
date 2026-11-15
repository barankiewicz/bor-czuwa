"""Extract one-powiat PRG geometry and add labelled synthetic protected areas."""

import hashlib
import json
import sys
from pathlib import Path

from osgeo import ogr, osr


LAYERS = {
    "gmina": ("admin", "A03_Granice_gmin.gml"),
    "powiat": ("admin", "A02_Granice_powiatow.gml"),
    "voiv": ("admin", "A01_Granice_wojewodztw.gml"),
    "police": ("special", "K02_Komenda_powiatowa_policji.gml"),
    "forest": ("special", "U06_Nadlesnictwo.gml"),
}
URLS = {
    "admin": "https://api.dane.gov.pl/media/resources/20260730/00_jednostki_administracyjne_gml_e0e52ce7.zip",
    "special": "https://api.dane.gov.pl/media/resources/20260730/00_granice_specjalne_xml_414a8615.zip",
}


def write_protected(path, field_id, value_id, name, bounds):
    ring = ogr.Geometry(ogr.wkbLinearRing)
    x1, y1, x2, y2 = bounds
    for x, y in [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)]:
        ring.AddPoint_2D(x, y)
    polygon = ogr.Geometry(ogr.wkbPolygon)
    polygon.AddGeometry(ring)
    spatial = osr.SpatialReference()
    spatial.ImportFromEPSG(2180)
    source = ogr.GetDriverByName("GeoJSON").CreateDataSource(str(path))
    layer = source.CreateLayer(path.stem, spatial, ogr.wkbPolygon)
    layer.CreateField(ogr.FieldDefn(field_id, ogr.OFTString))
    layer.CreateField(ogr.FieldDefn("nazwa", ogr.OFTString))
    feature = ogr.Feature(layer.GetLayerDefn())
    feature.SetField(field_id, value_id)
    feature.SetField("nazwa", name)
    feature.SetGeometry(polygon)
    layer.CreateFeature(feature)
    source = None


def main(admin_zip, special_zip, output):
    output.mkdir(parents=True, exist_ok=True)
    manifest = {"snapshot_id": "moniecki-2026-09-25-obwody-protected-v1", "retrieved_at": "2026-09-24T16:00:00Z", "publisher_date": "2026-07-30", "synthetic_protected_areas": True,
                "files": {}}
    for kind, (archive, member) in LAYERS.items():
        zip_path = admin_zip if archive == "admin" else special_zip
        source = ogr.Open(f"/vsizip/{zip_path.resolve()}/{member}")
        if source is None:
            raise ValueError(f"Cannot open {member}")
        layer = source.GetLayer()
        layer.SetSpatialFilterRect(742298.0669, 618265.2128, 756298.0669, 630265.2128)
        count = layer.GetFeatureCount()
        path = output / f"{kind}.geojson"
        if path.exists():
            path.unlink()
        destination = ogr.GetDriverByName("GeoJSON").CreateDataSource(str(path))
        destination.CopyLayer(layer, kind)
        destination = None
        manifest["files"][kind] = {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                    "feature_count": count, "source_url": URLS[archive]}
    for kind, unit_id, name, bounds in [
        ("nationalPark", "PL.ZIPOP.1393.PN.22", "Testowy park narodowy", (744000, 620000, 745000, 621000)),
        ("reserve", "fixture.reserve", "Testowy rezerwat", (747000, 620000, 748000, 621000)),
    ]:
        path = output / f"{kind}.geojson"
        if path.exists():
            path.unlink()
        write_protected(path, "kodinspire", unit_id, name, bounds)
        manifest["files"][kind] = {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                    "feature_count": 1, "source_url": "synthetic fixture"}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: extract-recipient-fixture.py ADMIN.zip SPECIAL.zip OUTPUT_DIR")
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
