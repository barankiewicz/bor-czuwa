import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.scratch/faza-2/workloads');
const { edge } = JSON.parse(await readFile(path.join(root, 'data/fixtures/acceptance.json'), 'utf8'));
const at = '2026-09-24T12:00:00Z';
const sharedPhoto = createHash('sha256').update('phase-2 workload shared photo').digest('hex');

function report(layout, sequence) {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const idHex = hash(`phase-2-workload:${layout}:${sequence}`).slice(0, 32);
  const id = `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-4${idHex.slice(13, 16)}-8${idHex.slice(17, 20)}-${idHex.slice(20)}`;
  const lat = layout === 'dense-cluster'
    ? edge.point.lat
    : edge.point.lat + ((sequence * 0.6180339887498949) % 1 - 0.5) * 0.04;
  const lon = layout === 'dense-cluster'
    ? edge.point.lon
    : edge.point.lon + ((sequence * 0.7548776662466927) % 1 - 0.5) * 0.08;
  return {
    id,
    event_type: 'person_with_gun',
    captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: { lat, lon, accuracy_m: 8, at },
    incident_location: { lat, lon, source: 'device_fix' },
    species: null,
    photo_sha256: [layout === 'dense-cluster' ? sharedPhoto : hash(`scattered-photo-${sequence}`)],
    has_note: false,
    app_version: '0.1.0',
    privacy_policy_version: 'internal-workload',
    terms_of_use_version: 'internal-workload',
    token_sha256: hash(`phase-2-workload:${layout}:${sequence}`)
  };
}

await mkdir(output, { recursive: true });
for (const layout of ['scattered', 'dense-cluster']) {
  const rows = Array.from({ length: 10_000 }, (_, index) => JSON.stringify(report(layout, index + 1)));
  await writeFile(path.join(output, `${layout}.jsonl`), `${rows.join('\n')}\n`);
}
console.log(`Generated 10,000 reports per layout in ${path.relative(root, output)}`);
