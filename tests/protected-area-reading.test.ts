import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeNotice } from '../src/lib/notice-composer.ts';
import { summarizeFindings } from '../src/lib/findings-summary.ts';
import { noticeFragments } from '../src/lib/notice-fragments.ts';
import type { Findings, Report, ProtectedArea, ProtectedAreaKind, ProtectedAreaRules, ProtectedAreas } from '../src/lib/report.ts';
import type { NoticeRuleSet } from '../src/lib/notice-composer.ts';
import rule from '../data/rule-sets/2026-09-24-v2.json' with { type: 'json' };

const rules = rule as NoticeRuleSet;
const kinds: ProtectedAreaKind[] = ['park_narodowy', 'rezerwat', 'otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo'];
const fixture = JSON.parse(readFileSync(new URL('browser/computed-findings.json', import.meta.url), 'utf8')) as Findings;
const report: Report = { id: '351ad090-8888-4888-8888-888888888888', event_type: 'person_with_gun', captured_at: '2026-09-25T10:00:00Z',
  occurred_at: { at: '2026-09-25T09:00:00Z', source: 'device_clock', coarseness: 'exact' },
  device_fix: { lat: 52, lon: 21, accuracy_m: 12, at: '2026-09-25T10:00:00Z' },
  incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, has_note: false,
  app_version: '0.1.0', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) };
const compose = (findings: Findings, source: 'device_fix' | 'moved_by_reporter' | 'area' = 'device_fix') => composeNotice({
  local: { report: { ...report, incident_location: source === 'area'
    ? { type: 'area', bounds: [21, 52, 21.05, 52.04], basis: 'reporter_selected_area', precise_fix_withheld: null }
    : { lat: 52, lon: 21, source } }, findings },
  recipient: { kind: 'police', id: 'police', name: 'Policja' }, others: [], variant: 'unsigned',
  ruleSet: rules, fragments: noticeFragments, platform: 'web'
});

const located = (source: 'device_fix' | 'moved_by_reporter' | 'area'): Report => ({ ...report, incident_location: source === 'area'
  ? { type: 'area', bounds: [21, 52, 21.05, 52.04], basis: 'reporter_selected_area', precise_fix_withheld: null }
  : { lat: 52, lon: 21, source } });

test('Notice and the Report screen summary agree on every protected-area assertion', () => {
    for (const kind of kinds) for (const treatment of ['ban', 'ban_without_documents', 'context', null] as const)
      for (const document_state of ['neither', 'plan_ochrony', 'zadania_ochronne', 'not_in_crfop_snapshot', undefined] as const)
        for (const source of ['device_fix', 'moved_by_reporter', 'area'] as const)
          for (const accuracy of [null, 0, 12]) for (const distance of [undefined, 0, 12, 12.001, 30]) {
            const area: ProtectedArea = { name: 'Obszar próbny', inspire_id: 'area', document_state,
              ...(distance === undefined ? {} : { boundary_distance: { status: 'measured', value_m: distance, search_radius_m: null } }) };
            const areas: Extract<ProtectedAreas, { status: 'computed' }> = { status: 'computed',
              ...Object.fromEntries(kinds.map(key => [key, key === kind ? [area] : []])) as Record<ProtectedAreaKind, ProtectedArea[]>,
              rules: treatment === null ? null : { treatment: Object.fromEntries(kinds.map(key => [key, treatment])) as ProtectedAreaRules['treatment'], citation: 'Podstawa prawna.' } };
            const expected = source === 'device_fix' && accuracy !== null && distance !== undefined && distance > accuracy
              && (kind === 'park_narodowy' && treatment === 'ban'
                || kind === 'rezerwat' && treatment === 'ban_without_documents' && document_state === 'neither');
            const label = JSON.stringify({ kind, treatment, document_state, source, accuracy, distance });
            const notice = compose({ ...fixture, accuracy_m: accuracy, protected_areas: areas }, source);
            assert.equal(notice.body.includes('polowanie jest tam zakazane'), expected, `Notice ${label}`);
            const fact = summarizeFindings(located(source), { ...fixture, accuracy_m: accuracy, protected_areas: areas }, rules, 'pl').facts
              .find(item => item.key === 'protected');
            assert.equal(fact?.ban === true, expected, `Screen ${label}`);
            assert.equal(fact?.value === 'Zakaz polowania', expected, `Screen value ${label}`);
          }
});

test('Polish Notice names all known datasets without raw dataset or Rule set identifiers', () => {
  const names = ['BDOT10k', 'BDOT10k/BUBD-A', 'GDOŚ', 'CRFOP', 'BDL', 'PRG', 'OpenStreetMap hunting stands',
    'GDOS:ParkiNarodowe', 'GDOS:Rezerwaty', 'GDOS:ParkiKrajobrazowe', 'GDOS:ObszarySpecjalnejOchrony', 'GDOS:SpecjalneObszaryOchrony', 'future:dataset'];
  const body = compose({ ...fixture, datasets: names.map(name => ({ name, source_url: '', retrieved_at: '', sha256: '' })) }).body;
  assert.match(body, /ambony z OpenStreetMap/);
  assert.match(body, /parki narodowe/);
  assert.match(body, /rezerwaty przyrody/);
  assert.match(body, /Centralny Rejestr Form Ochrony Przyrody/);
  const ingestedBody = compose({ ...fixture, datasets: ['BDOT10k BUBD', 'Bank Danych o Lasach']
    .map(name => ({ name, source_url: '', retrieved_at: '', sha256: '' })) }).body;
  assert.match(ingestedBody, /zabudowania z Bazy Danych Obiektów Topograficznych, Bank Danych o Lasach/);
  for (const name of names) assert.ok(!body.includes(name), name);
  assert.ok(!body.includes(fixture.rule_set_id));
  const pending = composeNotice({ local: { report, findings: { status: 'pending' } },
    recipient: { kind: 'police', id: 'police', name: 'Policja' }, others: [], variant: 'unsigned',
    ruleSet: rules, fragments: noticeFragments, platform: 'web' }).body;
  assert.ok(!pending.includes(rules.id));
});
