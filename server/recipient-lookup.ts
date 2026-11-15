import { z } from 'zod';
import { incidentAreaSchema } from '../src/lib/report.ts';
import gminy from '../data/authority-directory/gminy.json' with { type: 'json' };
import police from '../data/authority-directory/police.json' with { type: 'json' };
import regional from '../data/authority-directory/regional.json' with { type: 'json' };
import parks from '../data/authority-directory/parks.json' with { type: 'json' };
import manifest from '../data/authority-directory/manifest.json' with { type: 'json' };
import { pool } from './db.ts';

const pointSchema = z.strictObject({ lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180) });
export const areaSchema = incidentAreaSchema.refine(({ bounds }) =>
  bounds[2] - bounds[0] <= 0.115 && bounds[3] - bounds[1] <= 0.073);
export const recipientLocationSchema = z.union([pointSchema, areaSchema]);

type Row = { kind: string; unit_id: string; name: string; snapshot_id: string };
type Unit = { kind: 'gmina' | 'police' | 'psl' | 'nationalPark' | 'rdos'; id: string };
type Candidate = Unit & { name: string; catalog: 'matched' | 'unknown' };

const catalog = new Map([...gminy.units, ...police.units, ...regional.units, ...parks.units]
  .map(unit => [`${unit.kind}:${unit.id}`, unit.name]));

export function isKnownRecipient(kind: string, id: string) {
  return catalog.has(`${kind}:${id}`);
}

function role(kind: string): Unit['kind'] | null {
  if (kind === 'gmina' || kind === 'police' || kind === 'nationalPark') return kind;
  if (kind === 'voiv') return 'psl';
  if (kind === 'reserve_voiv') return 'rdos';
  return null;
}

export async function lookupRecipients(location: z.infer<typeof recipientLocationSchema>) {
  const isArea = 'type' in location;
  const bounds = isArea ? location.bounds : null;
  const result = await pool.query(`WITH location AS (
      SELECT CASE WHEN $1::boolean
        THEN ST_Transform(ST_MakeEnvelope($4, $5, $6, $7, 4326), 2180)
        ELSE ST_Transform(ST_SetSRID(ST_MakePoint($2, $3), 4326), 2180)
      END AS geom
    ), matched AS (
      SELECT j.kind, j.unit_id, j.name, j.snapshot_id, j.geom
      FROM current_geodata c
      JOIN recipient_dataset d ON d.snapshot_id = c.snapshot_id
      JOIN recipient_jurisdiction j ON j.snapshot_id = c.snapshot_id
      CROSS JOIN location l
      WHERE CASE WHEN $1::boolean THEN ST_Intersects(j.geom, l.geom) ELSE ST_Covers(j.geom, l.geom) END
    )
    SELECT kind, unit_id, name, snapshot_id FROM matched
    UNION ALL
    SELECT DISTINCT 'reserve_voiv', v.unit_id, v.name, v.snapshot_id
    FROM matched r
    JOIN recipient_jurisdiction v ON v.snapshot_id = r.snapshot_id AND v.kind = 'voiv'
      AND ST_Intersects(r.geom, v.geom)
    WHERE r.kind = 'reserve'
    UNION ALL
    SELECT 'dataset', '', '', c.snapshot_id
    FROM current_geodata c JOIN recipient_dataset d ON d.snapshot_id = c.snapshot_id
    ORDER BY kind, unit_id`, [isArea,
    isArea ? null : location.lon, isArea ? null : location.lat,
    bounds?.[0] ?? null, bounds?.[1] ?? null, bounds?.[2] ?? null, bounds?.[3] ?? null]);

  const rows = result.rows as Row[];
  if (!rows.length) return null;
  const candidates = new Map<string, Candidate>();
  for (const row of rows) {
    const kind = role(row.kind);
    if (!kind) continue;
    const key = `${kind}:${row.unit_id}`;
    const directoryName = catalog.get(key);
    candidates.set(key, { kind, id: row.unit_id, name: directoryName ?? row.name,
      catalog: directoryName ? 'matched' : 'unknown' });
  }

  const all = [...candidates.values()].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byRole = (kind: Unit['kind']) => all.filter(candidate => candidate.kind === kind);
  const requiredRoles: Unit['kind'][] = ['gmina', 'police', 'psl'];
  const unresolved = requiredRoles.filter(kind => !byRole(kind).length);
  const ambiguousRoles = [...new Set(all.map(candidate => candidate.kind))]
    .filter(kind => byRole(kind).length > 1);
  const unique = ambiguousRoles.length === 0;
  const pointRows = (kind: string) => rows.filter(row => row.kind === kind);
  const onlyRow = (kind: string) => pointRows(kind).length === 1 ? pointRows(kind)[0] : null;
  const legacyUnique = !isArea && unique && pointRows('powiat').length === 1;
  const snapshot = rows[0];
  const units = (['gmina', 'police', 'nationalPark', 'psl', 'rdos'] as const)
    .flatMap(kind => byRole(kind).map(({ id }) => ({ kind, id })));
  return {
    candidates: all,
    ambiguity: { ambiguous: ambiguousRoles.length > 0, roles: ambiguousRoles, unresolved },
    provenance: { snapshot_id: snapshot.snapshot_id, directory_version: manifest.version },
    ...(legacyUnique ? { units } : {}),
    ...(!isArea && legacyUnique ? {
      inside: { nationalPark: pointRows('nationalPark').length > 0, reserve: pointRows('reserve').length > 0 },
      places: { gmina: onlyRow('gmina')?.name ?? null, powiat: onlyRow('powiat')?.name ?? null,
        nadlesnictwo: onlyRow('forest')?.name ?? null }
    } : {})
  };
}

/** Gmina names an Incident area touches, largest overlap first, for the Reporter's preview. */
export async function areaPlaces(area: z.infer<typeof areaSchema>) {
  const result = await pool.query(`SELECT j.name
    FROM current_geodata c
    JOIN recipient_jurisdiction j ON j.snapshot_id = c.snapshot_id AND j.kind = 'gmina'
    CROSS JOIN LATERAL (SELECT ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 2180) AS geom) l
    WHERE ST_Intersects(j.geom, l.geom)
    GROUP BY j.name
    ORDER BY sum(ST_Area(ST_Intersection(j.geom, l.geom))) DESC, j.name`, area.bounds);
  return { gminy: result.rows.map(row => row.name as string) };
}
