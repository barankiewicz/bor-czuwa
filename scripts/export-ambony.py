"""Move legacy bytea extracts to immutable files before changing the public route."""

import os

import psycopg

from extract_artifact import publish_extract


def chunks(connection, snapshot_id, length):
    for offset in range(1, length + 1, 1024 * 1024):
        yield connection.execute('SELECT substring(geojsonseq FROM %s FOR %s) '
                                 'FROM osm_stand_extract WHERE snapshot_id = %s',
                                 (offset, 1024 * 1024, snapshot_id)).fetchone()[0]


with psycopg.connect(os.environ['DATABASE_URL']) as connection:
    connection.execute('SELECT pg_advisory_lock(2180)')
    connection.commit()
    rows = connection.execute('SELECT snapshot_id, octet_length(geojsonseq) '
                              'FROM osm_stand_extract ORDER BY snapshot_id').fetchall()
    for snapshot_id, length in rows:
        sha256 = publish_extract(chunks(connection, snapshot_id, length), snapshot_id,
                                 os.environ['GEODATA_EXTRACT_DIR'])
        connection.execute('DELETE FROM osm_stand_extract WHERE snapshot_id = %s', (snapshot_id,))
        connection.commit()
        print(f'Exported {snapshot_id}: {length} bytes, sha256 {sha256}')
