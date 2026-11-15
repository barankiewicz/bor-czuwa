import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInSpecsNotPassed } from '../scripts/ci/check-in-gate.mjs';

type Spec = { file: string; title: string; tests: { status: string; results: { status: string }[] }[] };
// The three titles the gate requires, pinned here so editing the gate's list cannot silently pass.
const dueCheckIn = 'a due check-in opens from home, saves on one tap';
const androidReminder = 'on Android a "Jeszcze nie" answered early moves the pending check-in reminder';
const answeringDue = 'answering due Signed Notice check-in clears action';
const spec = (file: string, title: string, status = 'passed'): Spec => ({ file, title,
  tests: [{ status: status === 'passed' ? 'expected' : status === 'skipped' ? 'skipped' : 'unexpected', results: [{ status }] }] });
// Shaped like Playwright's JSON reporter: describe blocks nest suites, and a file's top-level specs sit beside them.
function report(overrides: { drop?: string[]; status?: Record<string, string> } = {}) {
  const make = (file: string, title: string) => spec(file, title, overrides.status?.[title] ?? 'passed');
  const keep = (file: string, titles: string[]) => titles.filter(title => !overrides.drop?.includes(title)).map(title => make(file, title));
  return { suites: [
    { title: 'check-in.spec.ts', specs: keep('check-in.spec.ts', ['an unsigned Notice uses its available handoff route']),
      suites: [{ title: 'enabled six-week check-in', specs: keep('check-in.spec.ts', [dueCheckIn + ' and asks again', androidReminder]) }] },
    { title: 'latest-work.spec.ts', specs: keep('latest-work.spec.ts', ['home shows at most one task for 0 Drafts', answeringDue + ' even when no answer has arrived']) }
  ] };
}

test('the gate accepts a report where all three flag-dependent specs passed', () => {
  assert.deepEqual(checkInSpecsNotPassed(report()), []);
});

test('the gate names a flag-dependent spec that is missing, even when every other spec passed with 0 skipped', () => {
  const missing = checkInSpecsNotPassed(report({ drop: [androidReminder, answeringDue + ' even when no answer has arrived', dueCheckIn + ' and asks again'] }));
  assert.equal(missing.length, 3);
});

test('the gate names a flag-dependent spec that was skipped or failed', () => {
  const title = androidReminder;
  assert.deepEqual(checkInSpecsNotPassed(report({ status: { [title]: 'skipped' } })), [`check-in.spec.ts: ${title}`]);
  assert.deepEqual(checkInSpecsNotPassed(report({ status: { [title]: 'failed' } })), [`check-in.spec.ts: ${title}`]);
});
