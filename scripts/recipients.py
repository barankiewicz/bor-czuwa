"""Load PRG and GDOŚ jurisdiction polygons for an existing geodata snapshot."""

import hashlib
import json
from pathlib import Path

from psycopg import sql
from psycopg.types.json import Jsonb
from osgeo import ogr, osr


FIELDS = {
    "gmina": ("JPT_KOD_JE", "JPT_NAZWA_"),
    "powiat": ("JPT_KOD_JE", "JPT_NAZWA_"),
    "voiv": ("JPT_KOD_JE", "JPT_NAZWA_"),
    "police": ("IIP_IDENTY", "JPT_NAZWA_"),
    "forest": ("IIP_IDENTY", "JPT_NAZWA_"),
    "nationalPark": ("kodinspire", "nazwa"),
    "reserve": ("kodinspire", "nazwa"),
}


def features(kind, path, member=None):
    location = f'/vsizip/{path.resolve()}/{member}' if member else str(path)
    source = ogr.Open(location)
    if source is None:
        raise ValueError(f"Cannot open {path}")
    layer = source.GetLayer()
    source_crs = layer.GetSpatialRef()
    if source_crs is None:
        raise ValueError(f"Missing CRS in {path}")
    target_crs = osr.SpatialReference()
    target_crs.ImportFromEPSG(2180)
    source_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source_crs, target_crs)
    id_field, name_field = FIELDS[kind]
    for feature in layer:
        name = feature.GetField(name_field)
        if kind in ("nationalPark", "reserve") and name and name.endswith(" - otulina"):
            continue
        unit_id = feature.GetField(id_field)
        geometry = feature.GetGeometryRef()
        if not unit_id or not name or geometry is None:
            raise ValueError(f"Missing id, name or geometry in {path}")
        if kind in ("gmina", "powiat", "voiv"):
            unit_id = str(unit_id).zfill({"gmina": 7, "powiat": 4, "voiv": 2}[kind])
        geometry = geometry.Clone()
        if geometry.Transform(transform) != 0:
            raise ValueError(f"Cannot transform {unit_id} to EPSG:2180")
        if geometry.IsEmpty() or not geometry.IsValid() or ogr.GT_Flatten(geometry.GetGeometryType()) not in (
            ogr.wkbPolygon, ogr.wkbMultiPolygon
        ):
            raise ValueError(f"Invalid polygon {unit_id} in {path}")
        yield str(unit_id), str(name), geometry.ExportToWkb().hex()


def recipient_inputs(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest["files"]
    if set(files) != set(FIELDS):
        raise ValueError("Manifest must name every jurisdiction layer")
    paths = {}
    hashes = {}
    for kind, source in files.items():
        path = manifest_path.parent / source["path"]
        if path not in hashes:
            with path.open("rb") as stream:
                hashes[path] = hashlib.file_digest(stream, "sha256").hexdigest()
        if hashes[path] != source["sha256"]:
            raise ValueError(f"Hash mismatch for {kind}")
        paths[kind] = (path, source.get('member'))

    return manifest, paths


def stage_recipient_jurisdiction(connection, manifest, paths, schema):
    connection.execute("""CREATE TEMP TABLE incoming_recipient_jurisdiction (
        kind text, unit_id text, name text, geom geometry(Geometry,2180),
        PRIMARY KEY (kind, unit_id)) ON COMMIT DROP""")
    counts = {}
    with connection.cursor().copy(
        "COPY incoming_recipient_jurisdiction (kind, unit_id, name, geom) FROM STDIN"
    ) as copy:
        for kind, (path, member) in paths.items():
            count = 0
            for unit_id, name, geometry in features(kind, path, member):
                copy.write_row((kind, unit_id, name, geometry))
                count += 1
            if count == 0:
                raise ValueError(f"No recipient polygons for {kind}")
            expected = manifest["files"][kind].get("feature_count")
            if expected is not None and count != expected:
                raise ValueError(f"Feature count mismatch for {kind}: {count}")
            counts[kind] = count
    connection.execute(sql.SQL("""INSERT INTO {}.recipient_jurisdiction
        SELECT %s, kind, unit_id, name, ST_Multi(geom)
        FROM incoming_recipient_jurisdiction""").format(sql.Identifier(schema)), (manifest["snapshot_id"],))
    connection.execute("INSERT INTO recipient_dataset (snapshot_id, sources) VALUES (%s, %s)",
                       (manifest["snapshot_id"], Jsonb(manifest)))
    print(f"Loaded recipient jurisdiction: {counts}")
