// The three specs that skip unless the web build sets VITE_CHECK_IN_ENABLED=true. The gate needs each of them
// to have run and passed: a positive total with 0 skipped would also pass if they were deleted.
export const flagDependentSpecs = [
  { file: 'check-in.spec.ts', title: 'a due check-in opens from home, saves on one tap' },
  { file: 'check-in.spec.ts', title: 'on Android a "Jeszcze nie" answered early moves the pending check-in reminder' },
  { file: 'latest-work.spec.ts', title: 'answering due Signed Notice check-in clears action' }
];

function* specsOf(suite) {
  for (const spec of suite.specs ?? []) yield spec;
  for (const child of suite.suites ?? []) yield* specsOf(child);
}

// Names of flag-dependent specs that are absent from a Playwright JSON report or did not pass.
export function checkInSpecsNotPassed(playwrightReport) {
  const found = [...specsOf({ suites: playwrightReport.suites })];
  return flagDependentSpecs.filter(({ file, title }) => !found.some(spec =>
    spec.file.endsWith(file) && spec.title.includes(title)
    && spec.tests.length > 0 && spec.tests.every(test => test.status === 'expected'
      && test.results.at(-1)?.status === 'passed'))).map(({ file, title }) => `${file}: ${title}`);
}
