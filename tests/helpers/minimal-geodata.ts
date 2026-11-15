import type pg from 'pg';

export const minimalGeodataSchema = 'geo_aaaaaaaaaaaaaaaaaaaa';

// The smallest geodata the API's start check accepts: the five tables of a conforming schema,
// one dwelling, recorded as current. For tests that start the API on a database with no ingest.
export async function seedMinimalGeodata(admin: Pick<pg.Client, 'query'>) {
  const schema = minimalGeodataSchema;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const geom = 'geom geometry(MultiPolygon, 2180)';
  await admin.query(`CREATE TABLE ${schema}.dwelling (${geom})`);
  await admin.query(`CREATE TABLE ${schema}.obwod_lowiecki (objectid integer, number text, source_year integer, ${geom})`);
  await admin.query(`CREATE TABLE ${schema}.recipient_jurisdiction (id integer)`);
  await admin.query(`CREATE TABLE ${schema}.ambona (osm_id text, geom geometry(Point, 2180))`);
  await admin.query(`CREATE TABLE ${schema}.protected_area (kind text, inspire_id text, name text, parent_kind text,
    document_state text, documents jsonb, ${geom})`);
  await admin.query(`INSERT INTO ${schema}.dwelling VALUES (ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 2180)))`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO app_runtime`);
  await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO app_runtime`);
  await admin.query(`INSERT INTO geodata_snapshot (id, datasets, coverage, storage_schema)
    VALUES ('s', '{}', ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 2180)), '${schema}')`);
  await admin.query("INSERT INTO current_geodata (snapshot_id) VALUES ('s')");
  // What recipient lookup needs for the current snapshot.
  await admin.query("INSERT INTO recipient_dataset (snapshot_id, sources) VALUES ('s', '{}')");
  await admin.query(`INSERT INTO recipient_jurisdiction (snapshot_id, kind, unit_id, name, geom)
    VALUES ('s', 'gmina', 'g1', 'x', ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 2180)))`);
}
