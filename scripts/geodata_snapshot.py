"""Versioned PostGIS storage and atomic publication for geodata refreshes."""

import hashlib
import os

from psycopg import sql
from psycopg.types.json import Jsonb


TABLES = ('dwelling', 'obwod_lowiecki', 'protected_area', 'recipient_jurisdiction', 'ambona')


def runtime_role():
    role = os.environ.get('RUNTIME_DB_ROLE', 'app_runtime')
    if role not in ('app_runtime', 'bor_czuwa_demo_runtime'):
        raise ValueError('Unsupported runtime database role')
    return sql.Identifier(role)


def repair_polygons(connection, table, label):
    table_name = sql.Identifier(table)
    invalid = connection.execute(sql.SQL("""SELECT 1 FROM {} WHERE geom IS NULL OR ST_IsEmpty(geom)
        OR GeometryType(geom) NOT IN ('POLYGON', 'MULTIPOLYGON') LIMIT 1""").format(table_name)).fetchone()
    if invalid:
        raise ValueError(f'Invalid {label} geometry')
    changed = connection.execute(sql.SQL('''SELECT 1 FROM {} WHERE NOT ST_IsValid(geom)
        AND (ST_IsEmpty(ST_CollectionExtract(ST_MakeValid(geom),3))
          OR abs(ST_Area(ST_CollectionExtract(ST_MakeValid(geom),3)) - ST_Area(geom))
             > greatest(ST_Area(geom),1) * 0.0001) LIMIT 1''').format(table_name)).fetchone()
    if changed:
        raise ValueError(f'{label} geometry repair changes its area')
    repaired = connection.execute(sql.SQL('''UPDATE {} SET geom = ST_CollectionExtract(ST_MakeValid(geom),3)
        WHERE NOT ST_IsValid(geom)''').format(table_name)).rowcount
    if connection.execute(sql.SQL("""SELECT 1 FROM {} WHERE NOT ST_IsValid(geom) OR ST_IsEmpty(geom)
        OR GeometryType(geom) NOT IN ('POLYGON', 'MULTIPOLYGON') LIMIT 1""").format(table_name)).fetchone():
        raise ValueError(f'Invalid {label} geometry after repair')
    if repaired:
        print(f'Repaired {repaired} {label} polygons with ST_MakeValid')


def schema_name(snapshot_id):
    return 'geo_' + hashlib.sha256(snapshot_id.encode()).hexdigest()[:20]


def dataset_rows(bubd, obwody, protected, recipients, osm):
    prg = recipients['files']
    prg_names = ('gmina', 'powiat', 'voiv', 'police', 'forest')
    prg_files = list({(entry['source_url'], entry['sha256']):
                      {'source_url': entry['source_url'], 'sha256': entry['sha256']}
                      for kind in prg_names if (entry := prg[kind])}.values())
    digest = hashlib.sha256()
    for entry in prg_files:
        digest.update(bytes.fromhex(entry['sha256']))
    datasets = [
        {'name': 'BDOT10k BUBD', 'source_url': bubd['source_url'],
         'retrieved_at': bubd['retrieved_at'], 'sha256': bubd['sha256']},
        {'name': obwody['source_name'], 'source_url': obwody['source_url'],
         'retrieved_at': obwody['retrieved_at'], 'source_years': obwody['source_years'],
         'disclaimer': obwody['disclaimer'], 'sha256': obwody['sha256']},
        *protected,
        {'name': 'PRG', 'source_url': prg_files[0]['source_url'], 'source_files': prg_files,
         'retrieved_at': recipients['retrieved_at'], 'publisher_date': recipients.get('publisher_date'),
         'sha256': digest.hexdigest()},
        {'name': 'OpenStreetMap hunting stands', 'source_url': osm['source_url'],
         'source_files': osm.get('source_files'), 'retrieved_at': osm['retrieved_at'],
         'publisher_date': osm.get('publisher_date'), 'sha256': osm['sha256']},
    ]
    if len(datasets) != 10 or len({row['name'] for row in datasets}) != 10:
        raise ValueError('Snapshot needs ten distinct datasets')
    return datasets


def create_storage(connection, schema):
    identifier = sql.Identifier(schema)
    connection.execute(sql.SQL('CREATE SCHEMA {}').format(identifier))
    for table, definition in {
        'dwelling': 'lokalnyid text PRIMARY KEY, geom geometry(MultiPolygon,2180) NOT NULL',
        'obwod_lowiecki': 'objectid integer PRIMARY KEY, number text NOT NULL, source_year integer NOT NULL, geom geometry(MultiPolygon,2180) NOT NULL',
        'protected_area': "kind text NOT NULL CHECK (kind IN ('park_narodowy', 'rezerwat', 'otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo')), inspire_id text NOT NULL, name text NOT NULL, parent_kind text, document_state text CHECK (document_state IN ('plan_ochrony', 'zadania_ochronne', 'neither', 'not_in_crfop_snapshot')), documents jsonb NOT NULL, geom geometry(MultiPolygon,2180) NOT NULL, PRIMARY KEY (kind, inspire_id)",
        'recipient_jurisdiction': "snapshot_id text NOT NULL REFERENCES public.geodata_snapshot(id), kind text NOT NULL CHECK (kind IN ('gmina', 'powiat', 'voiv', 'police', 'forest', 'nationalPark', 'reserve')), unit_id text NOT NULL, name text NOT NULL, geom geometry(MultiPolygon,2180) NOT NULL, PRIMARY KEY (snapshot_id, kind, unit_id)",
        'ambona': 'osm_id text PRIMARY KEY, geom geometry(Point,2180) NOT NULL',
    }.items():
        connection.execute(sql.SQL('CREATE TABLE {}.{} ({})').format(identifier, sql.Identifier(table), sql.SQL(definition)))


def index_storage(connection, schema):
    identifier = sql.Identifier(schema)
    for table in TABLES:
        connection.execute(sql.SQL('CREATE INDEX {} ON {}.{} USING gist (geom)').format(
            sql.Identifier(table + '_geom_idx'), identifier, sql.Identifier(table)))


def grant_storage(connection, schema):
    role = runtime_role()
    connection.execute(sql.SQL('GRANT USAGE ON SCHEMA {} TO {}').format(sql.Identifier(schema), role))
    connection.execute(sql.SQL('GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}').format(sql.Identifier(schema), role))


def publish_views(connection, schema):
    grant_storage(connection, schema)
    for table in TABLES:
        connection.execute(sql.SQL('CREATE OR REPLACE VIEW public.{} AS SELECT * FROM {}.{}').format(
            sql.Identifier(table), sql.Identifier(schema), sql.Identifier(table)))
        connection.execute(sql.SQL('GRANT SELECT ON public.{} TO {}').format(sql.Identifier(table), runtime_role()))


def migrate_legacy_storage(connection):
    current = connection.execute('SELECT snapshot_id FROM current_geodata').fetchone()
    if not current:
        # A fresh database holds only migration 001's empty placeholder tables. Views replace them.
        for table in TABLES:
            if connection.execute("SELECT relkind FROM pg_class WHERE oid = to_regclass(%s)", (f'public.{table}',)).fetchone() != ('r',):
                continue
            if connection.execute(sql.SQL('SELECT 1 FROM public.{} LIMIT 1').format(sql.Identifier(table))).fetchone():
                raise ValueError(f'Unpublished public.{table} holds rows')
            connection.execute(sql.SQL('DROP TABLE public.{}').format(sql.Identifier(table)))
        return
    old_id = current[0]
    row = connection.execute('SELECT storage_schema FROM geodata_snapshot WHERE id = %s', (old_id,)).fetchone()
    if row[0]:
        return
    old_schema = schema_name(old_id)
    connection.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(old_schema)))
    for table in TABLES:
        if table == 'ambona' and not connection.execute("SELECT to_regclass('public.ambona')").fetchone()[0]:
            connection.execute(sql.SQL('CREATE TABLE {}.ambona (osm_id text PRIMARY KEY, geom geometry(Point,2180) NOT NULL)').format(sql.Identifier(old_schema)))
            continue
        connection.execute(sql.SQL('ALTER TABLE public.{} SET SCHEMA {}').format(
            sql.Identifier(table), sql.Identifier(old_schema)))
    publish_views(connection, old_schema)
    connection.execute('UPDATE geodata_snapshot SET storage_schema = %s WHERE id = %s', (old_schema, old_id))


def record_snapshot(connection, snapshot_id, schema, retrieved_at, coverage, datasets):
    connection.execute('''INSERT INTO geodata_snapshot (id, created_at, datasets, coverage, storage_schema)
        VALUES (%s,%s,%s,ST_Multi(ST_MakeEnvelope(%s,%s,%s,%s,2180)),%s)''',
        (snapshot_id, retrieved_at, Jsonb(datasets), *coverage, schema))
    for dataset in datasets:
        connection.execute('''INSERT INTO geodata_dataset
            (snapshot_id, name, source_url, retrieved_at, publisher_date, sha256, source_files)
            VALUES (%s,%s,%s,%s,%s,%s,%s)''',
            (snapshot_id, dataset['name'], dataset['source_url'], dataset['retrieved_at'],
             dataset.get('publisher_date'), dataset['sha256'],
             Jsonb(dataset['source_files']) if 'source_files' in dataset else None))


def retain_two_vintages(connection):
    old_schemas = connection.execute('''SELECT storage_schema FROM geodata_snapshot
        WHERE storage_schema IS NOT NULL ORDER BY
        (id = (SELECT snapshot_id FROM current_geodata)) DESC, created_at DESC, id DESC OFFSET 2''').fetchall()
    for (schema,) in old_schemas:
        pinned = connection.execute('''SELECT 1 FROM findings_job j JOIN geodata_snapshot s
            ON s.id = j.geodata_snapshot_id WHERE s.storage_schema = %s
            AND j.failed_reason IS NULL LIMIT 1''', (schema,)).fetchone()
        if pinned:
            continue
        for table in TABLES:
            connection.execute(sql.SQL('DROP TABLE IF EXISTS {}.{}').format(sql.Identifier(schema), sql.Identifier(table)))
        connection.execute(sql.SQL('DROP SCHEMA {}').format(sql.Identifier(schema)))
        connection.execute('UPDATE geodata_snapshot SET storage_schema = NULL WHERE storage_schema = %s', (schema,))
