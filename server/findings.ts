import { failureClass } from './failure-class.ts';
import type { ProtectedAreas, ProtectedArea } from '../src/lib/report.ts';
import { noteDatabaseFailure, pool } from './db.ts';
import { dwellingAreaClass } from '../src/lib/findings-reading.ts';
import { evaluateTimeFindings, type RuleSet } from '../src/lib/time-findings.ts';

function sqlState(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

function retryableFailure(error: unknown) {
  const code = sqlState(error);
  return code.startsWith('08') || code.startsWith('40') ||
    ['57014', '57P01', '57P02', '57P03'].includes(code);
}

export async function runNextFindingsJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const jobs = await client.query(`SELECT * FROM findings_job
      WHERE failed_reason IS NULL AND available_at <= now()
      ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!jobs.rowCount) {
      await client.query('COMMIT');
      return false;
    }
    const job = jobs.rows[0];
    await client.query('SAVEPOINT compute');
    let pinned = false;
    let step = 'report';
    let errorClass: string | undefined;
    let reason: string | undefined;
    try {
      const { rows: [report] } = await client.query(`SELECT *,
        ST_Transform(ST_SetSRID(ST_MakePoint(incident_lon, incident_lat), 4326), 2180) AS point
        FROM report WHERE id = $1`, [job.report_id]);
      step = 'rule_set';
      const { rows: [rule] } = job.rule_set_id
        ? await client.query('SELECT id, parameters FROM rule_set WHERE id = $1', [job.rule_set_id])
        : await client.query(`SELECT id, parameters FROM rule_set
          WHERE effective_from = (SELECT max(effective_from) FROM rule_set
            WHERE effective_from <= ($1::timestamptz AT TIME ZONE 'Europe/Warsaw')::date)
          ORDER BY published_at DESC LIMIT 1`, [report.occurred_at]);
      // A species no Rule set lists is bad Report data; one only an older Rule set lacks is not.
      const { rows: [current] } = report.species && report.species !== 'unknown'
        ? await client.query(`SELECT parameters->'species' ? $1 AS lists_species FROM rule_set
            ORDER BY effective_from DESC, published_at DESC LIMIT 1`, [report.species])
        : { rows: [{ lists_species: true }] };
      step = 'snapshot';
      // Whole-area measurements require coverage of the whole area, including border/coastal boxes.
      const snapshotColumns = `s.id, s.datasets, s.storage_schema,
        CASE WHEN $2::jsonb IS NULL THEN ST_Covers(s.coverage, $1::geometry) ELSE
          ST_Covers(s.coverage, ST_Transform(ST_MakeEnvelope(($2::jsonb->>0)::float, ($2::jsonb->>1)::float,
            ($2::jsonb->>2)::float, ($2::jsonb->>3)::float, 4326), 2180)) END AS covered`;
      const snapshotArgs = [report.point, report.incident_bounds ? JSON.stringify(report.incident_bounds) : null];
      const { rows: [snapshot] } = job.geodata_snapshot_id
        ? await client.query(`SELECT ${snapshotColumns} FROM geodata_snapshot s WHERE s.id = $3`,
          [...snapshotArgs, job.geodata_snapshot_id])
        : await client.query(`SELECT ${snapshotColumns} FROM current_geodata c
            JOIN geodata_snapshot s ON s.id = c.snapshot_id FOR SHARE OF c`, snapshotArgs);

      if (rule && snapshot && (!job.rule_set_id || !job.geodata_snapshot_id)) {
        await client.query(`UPDATE findings_job SET rule_set_id = $2, geodata_snapshot_id = $3
          WHERE report_id = $1`, [job.report_id, rule.id, snapshot.id]);
      }
      await client.query('SAVEPOINT pinned');
      pinned = true;

      if (!rule) reason = 'before_earliest_rule_set';
      else if (!current?.lists_species && (rule.parameters as Partial<RuleSet>).species &&
        !(rule.parameters as RuleSet).species[report.species]) reason = 'unknown_species';
      else if (!snapshot) reason = 'no_geodata_snapshot';
      else if (snapshot.covered && !/^geo_[a-f0-9]{20}$/.test(snapshot.storage_schema ?? '')) reason = 'snapshot_storage_unavailable';
      else {
        // Outside coverage the spatial Findings are not computed; the time Findings need no geodata.
        const outside = !snapshot.covered;
        const notCovered = { status: 'not_computed', reason: 'outside_coverage' };
        const schema = snapshot.storage_schema as string;
        const isArea = report.incident_source === 'area';
        // The Incident area as the polygon the Reporter drew or the phone sent, never its centre (ADR-0011).
        const areaGeom: Buffer | null = isArea ? (await client.query(`SELECT ST_AsEWKB(ST_Transform(ST_MakeEnvelope(
          ($1::jsonb->>0)::float, ($1::jsonb->>1)::float, ($1::jsonb->>2)::float, ($1::jsonb->>3)::float, 4326), 2180)) AS area`,
        [JSON.stringify(report.incident_bounds)])).rows[0].area : null;
        const thresholdM = (rule.parameters as { dwelling_threshold_m: number }).dwelling_threshold_m;
        step = 'dwelling';
        const { rows: [nearest] } = outside ? { rows: [] } : isArea ? await client.query(`SELECT d.min_m,
          c.contains_dwelling, c.within_threshold_share
          FROM (SELECT ST_Distance(geom, $1::geometry) AS min_m FROM ${schema}.dwelling
            WHERE ST_DWithin(geom, $1::geometry, 1000) ORDER BY geom <-> $1::geometry LIMIT 1) d
          CROSS JOIN LATERAL (SELECT
            COALESCE(bool_or(ST_Relate(w.geom, $1::geometry, 'T********')), false) AS contains_dwelling,
            -- The union of per-dwelling buffers avoids counting overlaps twice (one buffer of the union is far costlier); boundary contact alone is not a dwelling inside.
            LEAST(1.0, GREATEST(0.0, COALESCE(ST_Area(ST_Intersection($1::geometry,
              ST_UnaryUnion(ST_Collect(ST_Buffer(w.geom, $2::float, 'quad_segs=32'))))), 0) / ST_Area($1::geometry))) AS within_threshold_share
            FROM ${schema}.dwelling w WHERE ST_DWithin(w.geom, $1::geometry, $2::float)) c`, [areaGeom, thresholdM])
          : await client.query(`SELECT ST_Distance(geom, $1::geometry) AS value_m
          FROM ${schema}.dwelling WHERE ST_DWithin(geom, $1::geometry, 1000)
          ORDER BY geom <-> $1::geometry LIMIT 1`, [report.point]);
        const measurement = outside ? { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' }
          : isArea ? nearest
            ? { status: 'area_measured', basis: 'area', min_m: nearest.min_m, within_threshold_share: nearest.within_threshold_share, contains_dwelling: nearest.contains_dwelling,
                class: dwellingAreaClass(nearest.min_m, nearest.contains_dwelling, thresholdM), threshold_m: thresholdM, search_radius_m: 1000 }
            : { status: 'area_none_within_radius', basis: 'area', min_m: null, within_threshold_share: 0, contains_dwelling: false,
                class: 'beyond_threshold', threshold_m: thresholdM, search_radius_m: 1000 }
          : nearest
          ? { status: 'measured', value_m: nearest.value_m, search_radius_m: 1000 }
          : { status: 'none_within_radius', value_m: null, search_radius_m: 1000 };
        const hasAmbony = !outside && snapshot.datasets.some((dataset: { name: string }) => dataset.name === 'OpenStreetMap hunting stands');
        step = 'ambona';
        // From an area the distance is to its edge, 0 for a stand inside it; ties go to the lower id.
        const { rows: [stand] } = !hasAmbony ? { rows: [] } : isArea ? await client.query(`SELECT osm_id, ST_Distance(geom, $1::geometry) AS distance_m
          FROM ${schema}.ambona ORDER BY geom <-> $1::geometry, osm_id LIMIT 1`, [areaGeom])
          : await client.query(`SELECT osm_id, ST_Distance(geom, $1::geometry) AS distance_m
          FROM ${schema}.ambona ORDER BY geom <-> $1::geometry LIMIT 1`, [report.point]);
        const nearestAmbona = outside ? notCovered : !hasAmbony ? { status: 'not_computed' } : stand
          ? { status: 'mapped', osm_id: stand.osm_id, distance_m: stand.distance_m, ...(isArea ? { measured_from: 'area_edge' } : {}) }
          : { status: 'none_mapped' };
        step = 'hunting_district';
        // Resolve vintages at each covered location, as for a point; a newer adjacent district cannot erase older land.
        const { rows: overlaps } = !isArea || outside ? { rows: [] } : await client.query(`WITH clipped AS MATERIALIZED (
          SELECT number, source_year, ST_Intersection(geom, $1::geometry) AS geom
          FROM ${schema}.obwod_lowiecki WHERE geom && $1::geometry AND ST_Relate(geom, $1::geometry, 'T********')
        ), effective AS (
          SELECT older.number, older.source_year, ST_Difference(older.geom,
            COALESCE((SELECT ST_Union(newer.geom) FROM clipped newer WHERE newer.source_year > older.source_year),
              ST_GeomFromText('POLYGON EMPTY', 2180))) AS geom FROM clipped older
        ) SELECT number, source_year,
          LEAST(1.0, GREATEST(0.0, ST_Area(ST_Union(geom)) / ST_Area($1::geometry))) AS share
          FROM effective GROUP BY number, source_year HAVING ST_Area(ST_Union(geom)) > 0
          ORDER BY number, source_year DESC`, [areaGeom]);
        const { rows: [uncovered] } = !isArea || outside ? { rows: [] } : await client.query(`SELECT
          LEAST(1.0, GREATEST(0.0, ST_Area(ST_Difference($1::geometry, COALESCE((SELECT ST_Union(geom) FROM ${schema}.obwod_lowiecki
            WHERE ST_Intersects(geom, $1::geometry)),
            ST_GeomFromText('POLYGON EMPTY', 2180)))) / ST_Area($1::geometry))) AS outside_share`, [areaGeom]);
        const { rows: [obwod] } = isArea || outside ? { rows: [] } : await client.query(`SELECT number, source_year
          FROM ${schema}.obwod_lowiecki WHERE ST_Covers(geom, $1::geometry)
          ORDER BY source_year DESC, number ASC, objectid ASC LIMIT 1`, [report.point]);
        const obwodyDataset = (snapshot.datasets as { name: string; source_url: string; retrieved_at: string;
          disclaimer?: string }[]).find(dataset => dataset.name === 'Bank Danych o Lasach');
        const obwodLowiecki = outside ? notCovered : obwodyDataset ? {
          ...(isArea ? { status: 'area', outside_share: uncovered.outside_share,
            obwody: overlaps.map(item => ({ name: 'Obwód łowiecki', number: item.number, source_year: item.source_year, share: item.share })) } : {
          status: obwod ? 'inside' : 'outside',
          ...(obwod ? { name: 'Obwód łowiecki', number: obwod.number, source_year: obwod.source_year } : {}) }),
          disclaimer: obwodyDataset.disclaimer ?? 'Dane o obwodach łowieckich mają charakter poglądowy.',
          source_name: obwodyDataset.name, source_url: obwodyDataset.source_url,
          retrieved_at: obwodyDataset.retrieved_at
        } : { status: 'not_computed', reason: 'snapshot_without_bdl' };
        const protectedAreas: ProtectedAreas = outside ? { status: 'not_computed', reason: 'outside_coverage' }
          : ['GDOS:ParkiNarodowe', 'GDOS:Rezerwaty',
          'GDOS:ParkiKrajobrazowe', 'GDOS:ObszarySpecjalnejOchrony', 'GDOS:SpecjalneObszaryOchrony', 'CRFOP']
          .every(name => snapshot.datasets.some((dataset: { name: string }) => dataset.name === name))
          ? { status: 'computed', rules: (rule.parameters as Partial<RuleSet>).protected_areas ?? null, park_narodowy: [], rezerwat: [], otulina: [],
              park_krajobrazowy: [], natura_2000_oso: [], natura_2000_soo: [] }
          : { status: 'not_computed', reason: 'snapshot_without_protected_areas' };
        if (protectedAreas.status === 'computed') {
          step = 'protected_areas';
          // An area counts when any positive part of it lies inside; wholly inside also gets the margin to the boundary.
          const { rows: areas } = isArea ? await client.query(`SELECT p.kind, p.inspire_id, p.name, p.parent_kind,
            p.document_state, p.documents, ST_Covers(p.geom, $1::geometry) AS whole,
            i.share, CASE WHEN ST_Covers(p.geom, $1::geometry) THEN ST_Distance(ST_Boundary(p.geom), $1::geometry) END AS boundary_m
            FROM ${schema}.protected_area p
            CROSS JOIN LATERAL (SELECT LEAST(1.0, GREATEST(0.0, ST_Area(ST_Intersection(p.geom, $1::geometry)) / ST_Area($1::geometry))) AS share) i
            WHERE geom && $1::geometry AND ST_Relate(p.geom, $1::geometry, 'T********') ORDER BY p.kind, p.inspire_id`, [areaGeom])
            : await client.query(`SELECT kind, inspire_id, name, parent_kind,
            document_state, documents, ST_Distance(ST_Boundary(geom), $1::geometry) AS boundary_m
            FROM ${schema}.protected_area WHERE ST_Covers(geom, $1::geometry) ORDER BY kind, inspire_id`, [report.point]);
          for (const area of areas) {
            const finding: ProtectedArea = { name: area.name, inspire_id: area.inspire_id };
            if (isArea) { finding.coverage = area.whole ? 'wholly_inside' : 'partly_inside'; finding.area_share = area.share; }
            if ((area.kind === 'park_narodowy' || area.kind === 'rezerwat') && area.boundary_m !== null) {
              finding.boundary_distance = { status: 'measured', value_m: area.boundary_m, search_radius_m: null };
            }
            if (area.kind === 'rezerwat') {
              finding.document_state = area.document_state;
              finding.documents = area.documents;
            }
            if (area.kind === 'otulina') finding.parent_kind = area.parent_kind;
            protectedAreas[area.kind as keyof Omit<typeof protectedAreas, 'status' | 'rules'>].push(finding);
          }
        }

        step = 'time_findings';
        const parameters = rule.parameters as Partial<RuleSet>;
        const timeFindings = parameters.noc && parameters.species && parameters.citations
          ? evaluateTimeFindings({
              at: report.occurred_at.toISOString(), coarseness: report.occurred_coarseness,
              window_end: report.occurred_window_end?.toISOString()
            }, report.incident_bounds ? { bounds: report.incident_bounds } : { lat: report.incident_lat, lon: report.incident_lon }, report.species, parameters as RuleSet)
          : { noc: { status: 'not_computed', reason: 'historical_rules_unavailable' },
              okres_ochronny: { status: 'not_computed', reason: 'historical_rules_unavailable' } };
        step = 'write_findings';
        await client.query(`INSERT INTO findings
          (report_id, rule_set_id, geodata_snapshot_id, dwelling_distance, obwod_lowiecki, accuracy_m, area_bounds, noc, okres_ochronny, protected_areas, nearest_ambona, shape_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,2)`, [job.report_id, rule.id, snapshot.id, measurement,
          obwodLowiecki, report.incident_source === 'device_fix' ? report.accuracy_m : null,
          report.incident_bounds ? JSON.stringify(report.incident_bounds) : null,
          timeFindings.noc, timeFindings.okres_ochronny, protectedAreas, nearestAmbona]);
        await client.query(`INSERT INTO report_event (report_id, kind) VALUES ($1, 'findings_computed')`, [job.report_id]);
        await client.query('DELETE FROM findings_job WHERE report_id = $1', [job.report_id]);
      }
    } catch (error) {
      errorClass = failureClass(error);
      noteDatabaseFailure(error);
      await client.query(`ROLLBACK TO SAVEPOINT ${pinned ? 'pinned' : 'compute'}`);
      // A lock timeout means a geodata switchover is in progress; wait it out without spending an attempt.
      if (sqlState(error) === '55P03') await client.query(`UPDATE findings_job
        SET available_at = now() + interval '5 seconds' WHERE report_id = $1`, [job.report_id]);
      else if (!retryableFailure(error) || job.attempts >= 3) reason = 'computation_failed';
      else await client.query(`UPDATE findings_job SET attempts = attempts + 1,
        available_at = now() + $2 * interval '1 second' WHERE report_id = $1`,
      [job.report_id, 2 ** job.attempts]);
    }
    if (reason) {
      await client.query('UPDATE findings_job SET failed_reason = $2 WHERE report_id = $1', [job.report_id, reason]);
      await client.query(`INSERT INTO report_event (report_id, kind, details)
        VALUES ($1, 'findings_failed', $2)`, [job.report_id, { reason, ...(errorClass ? { error_class: errorClass, step } : {}) }]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    noteDatabaseFailure(error);
    await client.query('ROLLBACK');
    throw new Error('findings_worker_unavailable');
  } finally {
    client.release();
  }
}
