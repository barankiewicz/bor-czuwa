import { createHash, randomUUID } from 'node:crypto';
import type { Challenge, Payload } from 'altcha-lib/v1/types';
import type { Report } from '../../src/lib/report.ts';

export function solve(challenge: Challenge): Payload {
  for (let number = 0; number <= challenge.maxnumber!; number++) {
    if (createHash('sha256').update(challenge.salt + number).digest('hex') === challenge.challenge) {
      const { maxnumber: _, ...payload } = challenge;
      return { ...payload, number };
    }
  }
  throw new Error('No solution');
}

export async function postReport(base: string, report: unknown) {
  const challenge = await fetch(`${base}/api/challenge`);
  return fetch(`${base}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(report as object), solution: solve(await challenge.json()) }) });
}

export function reportAt(): Report {
  const at = '2026-09-24T12:00:00Z';
  return { id: randomUUID(), token_sha256: createHash('sha256').update(randomUUID()).digest('hex'),
    event_type: 'shot', captured_at: at, occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: { lat: 52, lon: 21, accuracy_m: 8, at },
    incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, has_note: false,
    app_version: '0.1.0', privacy_policy_version: 'internal-fixture', terms_of_use_version: 'internal-fixture' };
}
