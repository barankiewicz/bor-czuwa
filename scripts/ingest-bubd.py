"""Load BUBD row groups into a staging table and publish atomically."""
import hashlib
import json
import os
import sys
from pathlib import Path

import pyarrow.compute as pc
import pyarrow.parquet as pq
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from osgeo import ogr, osr
from protected_areas import protected_inputs, stage_protected_areas
from recipients import recipient_inputs, stage_recipient_jurisdiction
from ambony import stage_ambony
from extract_artifact import publish_extract
from geodata_snapshot import (create_storage, index_storage, dataset_rows, migrate_legacy_storage,
                              grant_storage, publish_views, record_snapshot, repair_polygons,
                              retain_two_vintages, schema_name)

if len(sys.argv) != 9:
    raise SystemExit('Usage: ingest-bubd.py BUBD.parquet BUBD.json OBWODY.json OBWODY-manifest.json PROTECTED.json RECIPIENTS.json STANDS.geojsonseq STANDS.json')
source, manifest_path, obwody_path, obwody_manifest_path, protected_manifest_path, recipient_manifest_path, ambony_path, ambony_manifest_path = map(Path, sys.argv[1:])
extract_directory = os.environ['GEODATA_EXTRACT_DIR']
protected_entries, protected_datasets = protected_inputs(protected_manifest_path)
recipient_manifest, recipient_paths = recipient_inputs(recipient_manifest_path)
manifest = json.loads(manifest_path.read_text())
obwody_manifest = json.loads(obwody_manifest_path.read_text())
ambony_manifest = json.loads(ambony_manifest_path.read_text())
if recipient_manifest['snapshot_id'] != manifest['id']:
    raise ValueError('Recipient manifest must name the same snapshot')
with source.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
if digest != manifest['sha256']:
    raise ValueError('The input hash does not match its manifest')
with obwody_path.open('rb') as stream:
    obwody_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
if obwody_digest != obwody_manifest['sha256']:
    raise ValueError('The BDL input hash does not match its manifest')
if manifest.get('coverage_kind') != 'poland' and obwody_manifest.get('coverage_bbox_2180') != manifest['coverage_bbox_2180']:
    raise ValueError('The BDL fixture must cover the same area as BUBD')
datasets = dataset_rows(manifest, obwody_manifest, protected_datasets, recipient_manifest, ambony_manifest)

parquet = pq.ParquetFile(source)
geo = json.loads(parquet.schema_arrow.metadata[b'geo'])
column = geo['primary_column']
metadata = geo['columns'][column]
crs = metadata['crs']
spatial_reference = osr.SpatialReference()
spatial_reference.SetFromUserInput(crs if isinstance(crs, str) else json.dumps(crs))
if spatial_reference.GetAuthorityCode(None) != '2180' or metadata['encoding'] != 'WKB':
    raise ValueError('BUBD must contain WKB in EPSG:2180')

with psycopg.connect(os.environ['DATABASE_URL'], options=(
        '-c statement_timeout=1800000 '
        '-c lock_timeout=30000 '
        '-c idle_in_transaction_session_timeout=600000')) as connection:
    connection.execute('SELECT pg_advisory_lock(2180)')
    connection.commit()
    if connection.execute("SELECT to_regclass('public.schema_migrations')").fetchone()[0] is None:
        raise ValueError('Run schema migrations before geodata ingest')
    migrate_legacy_storage(connection)
    connection.commit()
    existing = connection.execute('SELECT id FROM geodata_snapshot WHERE id = %s', (manifest['id'],)).fetchone()
    rebuilding = os.environ.get('GEODATA_REBUILD') == '1'
    upgraded_legacy = False
    if existing:
        stored_datasets, same_coverage = connection.execute(
            '''SELECT datasets, CASE WHEN %s = 'poland' THEN TRUE ELSE
              ST_Equals(coverage, ST_MakeEnvelope(%s,%s,%s,%s,2180)) END
              FROM geodata_snapshot WHERE id = %s''',
            (manifest.get('coverage_kind'), *manifest['coverage_bbox_2180'], manifest['id'])).fetchone()
        if ([row['sha256'] for row in stored_datasets[:8]] !=
                [row['sha256'] for row in datasets[:8]] or
                not same_coverage):
            raise ValueError('Snapshot ids are immutable; use a new id')
        if len(stored_datasets) == 8:
            previous_recipients = connection.execute(
                'SELECT sources FROM recipient_dataset WHERE snapshot_id = %s', (manifest['id'],)).fetchone()
            if not previous_recipients or any(
                previous_recipients[0]['files'][kind]['sha256'] != recipient_manifest['files'][kind]['sha256']
                for kind in recipient_manifest['files']
            ):
                raise ValueError('Existing recipient data does not match this snapshot')
            connection.execute('UPDATE geodata_snapshot SET datasets = %s WHERE id = %s',
                               (Jsonb(datasets), manifest['id']))
            for dataset in datasets:
                connection.execute('''INSERT INTO geodata_dataset
                    (snapshot_id, name, source_url, retrieved_at, publisher_date, sha256, source_files)
                    VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
                    (manifest['id'], dataset['name'], dataset['source_url'], dataset['retrieved_at'],
                     dataset.get('publisher_date'), dataset['sha256'],
                     Jsonb(dataset['source_files']) if 'source_files' in dataset else None))
            upgraded_legacy = True
    current = connection.execute('''SELECT s.id, s.datasets, CASE WHEN %s = 'poland' THEN TRUE ELSE
        ST_Equals(s.coverage, ST_MakeEnvelope(%s,%s,%s,%s,2180)) END FROM current_geodata c
        JOIN geodata_snapshot s ON s.id = c.snapshot_id''',
        (manifest.get('coverage_kind'), *manifest['coverage_bbox_2180'])).fetchone()
    if rebuilding:
        if not existing or [row['sha256'] for row in stored_datasets] != [row['sha256'] for row in datasets]:
            raise ValueError('Recovery requires every original snapshot input hash')
        storage = schema_name(manifest['id'])
        if connection.execute('SELECT storage_schema FROM geodata_snapshot WHERE id = %s', (manifest['id'],)).fetchone()[0] != storage:
            raise ValueError('Recovery storage does not match the snapshot')
        for table in ('dwelling', 'obwod_lowiecki', 'protected_area', 'recipient_jurisdiction', 'ambona'):
            if connection.execute(sql.SQL('SELECT 1 FROM {}.{} LIMIT 1').format(sql.Identifier(storage), sql.Identifier(table))).fetchone():
                raise ValueError('Recovery requires empty geodata storage')
        connection.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(storage)))
        connection.execute('DELETE FROM recipient_dataset WHERE snapshot_id = %s', (manifest['id'],))
    if not rebuilding and current and current[2] and [row['sha256'] for row in current[1]] == [row['sha256'] for row in datasets]:
        print('Unchanged geodata; no new schema')
        connection.commit()
        sys.exit(0)
    if not rebuilding and existing and upgraded_legacy:
        print('Recorded legacy snapshot datasets; current geodata unchanged')
        connection.commit()
        sys.exit(0)
    if existing and not rebuilding:
        raise ValueError('Snapshot ids are immutable; use a new id')
    storage = schema_name(manifest['id'])
    connection.execute("SET LOCAL maintenance_work_mem = '256MB'")
    create_storage(connection, storage)
    rule = json.loads(Path('data/rule-sets/2018-04-01.json').read_text())
    connection.execute('CREATE TEMP TABLE incoming_dwelling (lokalnyid text PRIMARY KEY, geom geometry(Geometry,2180)) ON COMMIT DROP')
    for group in range(parquet.num_row_groups):
        table = parquet.read_row_group(group, columns=['LOKALNYID', 'KODKST', column])
        residential = table.filter(pc.equal(table['KODKST'], int(rule['residential_kst'])))
        with connection.cursor().copy('COPY incoming_dwelling (lokalnyid, geom) FROM STDIN') as copy:
            for row in residential.to_pylist():
                # PostGIS receives WKB through its hex input; the typmod fixes the SRID.
                copy.write_row((str(row['LOKALNYID']), row[column].hex()))
    del parquet
    count = connection.execute('SELECT count(*) FROM incoming_dwelling').fetchone()[0]
    if not count:
        raise ValueError('No residential footprints found')
    if connection.execute("SELECT 1 FROM incoming_dwelling WHERE geom IS NULL OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom) OR GeometryType(geom) NOT IN ('POLYGON', 'MULTIPOLYGON') LIMIT 1").fetchone():
        raise ValueError('Invalid residential footprint')
    obwody_source = ogr.Open(str(obwody_path))
    if obwody_source is None:
        raise ValueError('BDL input must be Esri JSON')
    obwody_layer = obwody_source.GetLayer()
    if obwody_layer.GetSpatialRef().GetAuthorityCode(None) != '2180':
        raise ValueError('BDL geometry must use EPSG:2180')
    connection.execute('CREATE TEMP TABLE incoming_obwod_lowiecki (objectid integer PRIMARY KEY, number text NOT NULL, source_year integer NOT NULL, geom geometry(Geometry,2180)) ON COMMIT DROP')
    with connection.cursor().copy('COPY incoming_obwod_lowiecki (objectid, number, source_year, geom) FROM STDIN') as copy:
        for obwod in obwody_layer:
            geometry = obwod.GetGeometryRef()
            if geometry is None or not obwod.GetField('hunt_dist_nr') or not obwod.GetField('a_year'):
                raise ValueError('BDL obwód lacks geometry, number or source year')
            copy.write_row((obwod.GetField('objectid'), obwod.GetField('hunt_dist_nr'),
                            obwod.GetField('a_year'), geometry.ExportToWkb().hex()))
    obwod_count = connection.execute('SELECT count(*) FROM incoming_obwod_lowiecki').fetchone()[0]
    if obwod_count != obwody_manifest['feature_count']:
        raise ValueError('BDL feature count does not match its manifest')
    repair_polygons(connection, 'incoming_obwod_lowiecki', 'BDL obwód')
    del obwody_layer, obwody_source
    connection.execute(sql.SQL('INSERT INTO {}.dwelling SELECT lokalnyid, ST_Multi(geom) FROM incoming_dwelling').format(sql.Identifier(storage)))
    connection.execute(sql.SQL('INSERT INTO {}.obwod_lowiecki SELECT objectid, number, source_year, ST_Multi(geom) FROM incoming_obwod_lowiecki').format(sql.Identifier(storage)))
    stage_protected_areas(connection, protected_manifest_path, protected_entries, storage)
    ambony_count = stage_ambony(connection, ambony_path, ambony_manifest, storage)
    if not rebuilding:
        record_snapshot(connection, manifest['id'], storage, manifest['retrieved_at'], manifest['coverage_bbox_2180'], datasets)
    stage_recipient_jurisdiction(connection, recipient_manifest, recipient_paths, storage)
    if manifest.get('coverage_kind') == 'poland':
        voiv = connection.execute(sql.SQL("SELECT count(*) FROM {}.recipient_jurisdiction WHERE kind = 'voiv'").format(sql.Identifier(storage))).fetchone()[0]
        if voiv != 16:
            raise ValueError('Nationwide PRG needs 16 voivodeships')
        connection.execute(sql.SQL('''UPDATE geodata_snapshot SET coverage = (
            SELECT ST_Multi(ST_Union(geom)) FROM {}.recipient_jurisdiction WHERE kind = 'voiv')
            WHERE id = %s''').format(sql.Identifier(storage)), (manifest['id'],))
    index_storage(connection, storage)
    if rebuilding:
        grant_storage(connection, storage)
    for table in ('dwelling', 'obwod_lowiecki', 'protected_area', 'recipient_jurisdiction', 'ambona'):
        connection.execute(sql.SQL('ANALYZE {}.{}').format(sql.Identifier(storage), sql.Identifier(table)))
    # Findings jobs wait on this lock with a timeout, so the slow extract write happens before it.
    with ambony_path.open('rb') as stream:
        publish_extract(iter(lambda: stream.read(1024 * 1024), b''), manifest['id'],
                        extract_directory, ambony_manifest['extract_sha256'])
    try:
        connection.execute('SELECT snapshot_id FROM current_geodata FOR UPDATE')
        if not rebuilding or (current and current[0] == manifest['id']):
            publish_views(connection, storage)
        if not rebuilding:
            connection.execute('INSERT INTO current_geodata (snapshot_id) VALUES (%s) ON CONFLICT (singleton) DO UPDATE SET snapshot_id = EXCLUDED.snapshot_id', (manifest['id'],))
        if not rebuilding:
            retain_two_vintages(connection)
        connection.commit()
    except BaseException:
        try:
            connection.rollback()
            with psycopg.connect(os.environ['DATABASE_URL']) as check:
                committed = check.execute('SELECT 1 FROM geodata_snapshot WHERE id = %s',
                                          (manifest['id'],)).fetchone() is not None
        except psycopg.Error:
            committed = True  # An uncertain commit must not lose its extract.
        if not committed:
            try:
                (Path(extract_directory) / f"{manifest['id']}.geojsonseq").unlink(missing_ok=True)
            except OSError as error:
                print(f'Could not remove uncommitted extract {manifest["id"]}: {error}', file=sys.stderr)
        raise
    print(f'Loaded {count} residential footprints, {obwod_count} BDL obwody and {ambony_count} OSM stands')
