"""Load designated GDOŚ layers and CRFOP into the snapshot transaction."""
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

from openpyxl import load_workbook
from osgeo import ogr
from psycopg.types.json import Jsonb
from psycopg import sql
from geodata_snapshot import repair_polygons

LAYERS = {
    'GDOS:ParkiNarodowe': 'park_narodowy',
    'GDOS:Rezerwaty': 'rezerwat',
    'GDOS:ParkiKrajobrazowe': 'park_krajobrazowy',
    'GDOS:ObszarySpecjalnejOchrony': 'natura_2000_oso',
    'GDOS:SpecjalneObszaryOchrony': 'natura_2000_soo',
}


def protected_inputs(manifest_path):
    manifest_path = Path(manifest_path)
    entries = json.loads(manifest_path.read_text())['datasets']
    if len(entries) != 6 or {entry['name'] for entry in entries} != {*LAYERS, 'CRFOP'}:
        raise ValueError('Protected snapshot needs all five designated GDOŚ layers and CRFOP')
    for entry in entries:
        path = manifest_path.parent / entry['file']
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != entry['sha256']:
            raise ValueError(f"Input hash does not match manifest: {entry['name']}")
    datasets = [{key: entry[key] for key in ('name', 'source_url', 'retrieved_at', 'sha256', 'publisher_date')
                 if key in entry} for entry in entries]
    return entries, datasets


def reserve_documents(path):
    # The publisher uses an .xls extension for an OOXML workbook.
    with path.open('rb') as stream:
        workbook = load_workbook(stream, read_only=True, data_only=True)
        workbook.active.reset_dimensions()
        rows = workbook.active.iter_rows(values_only=True)
        headers = next(rows)
        required = {'inspire_id', 'plan_ochrony', 'zadania_ochronne'}
        if not required.issubset(headers):
            raise ValueError('CRFOP document columns are missing')
        reserves = {}
        for values in rows:
            row = dict(zip(headers, values))
            inspire_id = row['inspire_id']
            if not inspire_id:
                continue
            if any(row[key] not in ('t', 'f') for key in ('plan_ochrony', 'zadania_ochronne')):
                raise ValueError(f'CRFOP document flags are incomplete: {inspire_id}')
            state = 'plan_ochrony' if row['plan_ochrony'] == 't' else 'zadania_ochronne' if row['zadania_ochronne'] == 't' else 'neither'
            documents = [
                {'kind': key, 'url': 'https://crfop.gdos.gov.pl/CRFOP/widok/viewrezerwatprzyrody.jsf?fop=' + quote(inspire_id, safe='')}
                for key in ('plan_ochrony', 'zadania_ochronne') if row[key] == 't'
            ]
            record = (state, documents)
            if inspire_id in reserves and reserves[inspire_id] != record:
                raise ValueError(f'Conflicting CRFOP records: {inspire_id}')
            reserves[inspire_id] = record
        workbook.close()
    return reserves


def stage_protected_areas(connection, manifest_path, entries, schema):
    root = Path(manifest_path).parent
    crfop = next(entry for entry in entries if entry['name'] == 'CRFOP')
    reserves = reserve_documents(root / crfop['file'])
    connection.execute('''CREATE TEMP TABLE incoming_protected_area (
        kind text NOT NULL, inspire_id text NOT NULL, name text NOT NULL,
        parent_kind text, document_state text, documents jsonb NOT NULL,
        geom geometry(Geometry,2180), PRIMARY KEY (kind, inspire_id)
    ) ON COMMIT DROP''')
    for entry in entries:
        if entry['name'] == 'CRFOP':
            continue
        collection = json.loads((root / entry['file']).read_text())
        crs = collection.get('crs', {})
        if crs not in ({'type': 'EPSG', 'properties': {'code': '2180'}},
                       {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::2180'}}):
            raise ValueError('GDOŚ geometry must use EPSG:2180')
        if collection.get('type') != 'FeatureCollection':
            raise ValueError('GDOŚ input must be a FeatureCollection')
        for feature in collection['features']:
            properties = feature['properties']
            name, inspire_id = properties['nazwa'], properties['kodinspire']
            if not isinstance(name, str) or not name.strip() or not isinstance(inspire_id, str) or not inspire_id.strip():
                raise ValueError('GDOŚ feature needs a name and INSPIRE identifier')
            kind = LAYERS[entry['name']]
            parent_kind = None
            if name.endswith(' - otulina'):
                # Landscape-park otulina is not one of the requested context layers.
                if kind not in ('park_narodowy', 'rezerwat'):
                    continue
                parent_kind, kind = kind, 'otulina'
                name = name.removesuffix(' - otulina')
            state, documents = reserves.get(inspire_id, ('not_in_crfop_snapshot', [])) if kind == 'rezerwat' else (None, [])
            geometry = ogr.CreateGeometryFromJson(json.dumps(feature['geometry']))
            if geometry is None:
                raise ValueError('GDOŚ feature has no geometry')
            connection.execute('INSERT INTO incoming_protected_area VALUES (%s,%s,%s,%s,%s,%s,ST_GeomFromWKB(%s,2180))',
                               (kind, inspire_id, name, parent_kind, state, Jsonb(documents), bytes(geometry.ExportToWkb())))
    repair_polygons(connection, 'incoming_protected_area', 'GDOŚ')
    connection.execute(sql.SQL('INSERT INTO {}.protected_area SELECT kind, inspire_id, name, parent_kind, document_state, documents, ST_Multi(geom) FROM incoming_protected_area').format(sql.Identifier(schema)))
