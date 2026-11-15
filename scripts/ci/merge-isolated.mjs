// Rebuilds the two-run isolated report from the two single-run results of the parallel CI jobs.
// Usage: merge-isolated.mjs RUNS_DIR EVIDENCE_DIR
//   RUNS_DIR/run-N/ holds one matrix job's output: isolated-report-N.json (ISOLATED_REPORT_PATH of that
//   job), isolated.json and isolated.log (its evidence record) and the run's own logs and browser output.
//   EVIDENCE_DIR/release-artifact.json names the archive that was built once; both runs must have tested it.
// Writes EVIDENCE_DIR/isolated-report.json, isolated.json and isolated.log in the shapes `evidence.mjs
// finalize` and the release verifier read, and exits 1 when anything is missing, failed or inconsistent.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const json = async file => JSON.parse(await readFile(file, 'utf8'));

export async function mergeIsolated(runsDirectory, evidenceDirectory) {
  const failures = [];
  const fail = (run, error) => failures.push({ stage: 'merge', ...(run ? { run } : {}), error });
  const parts = [];
  let built;
  try { built = (await json(path.join(evidenceDirectory, 'release-artifact.json'))).sha256; } catch { fail(0, 'built candidate archive hash unreadable'); }
  for (const run of [1, 2]) {
    const directory = path.join(runsDirectory, `run-${run}`);
    try {
      const report = await json(path.join(directory, `isolated-report-${run}.json`));
      const check = await json(path.join(directory, 'isolated.json'));
      if (report.runs?.length !== 1 || report.runs[0].run !== run) throw new Error(`report does not hold exactly run ${run}`);
      parts.push({ run, directory, report, check });
    } catch (error) { fail(run, `run ${run} evidence missing or unreadable: ${error.message}`); }
  }
  for (const { run, report, check } of parts) {
    if (check.outcome !== 'success' || check.exitCode !== 0) fail(run, `run ${run} job failed: ${check.outcome}`);
    for (const item of report.failures ?? []) failures.push(item);
    if (!report.candidate?.verifiedBefore || !report.candidate.verifiedAfter) fail(run, `run ${run} did not verify the candidate archive before and after`);
    if (built && report.candidate?.artifactSha256 !== built) fail(run, `run ${run} tested archive ${report.candidate?.artifactSha256}, not the built archive ${built}`);
  }
  const [first, second] = parts;
  if (first && second) {
    for (const key of ['gitHead', 'sourceAndBuildSha256', 'fixtureAndGoldenSha256']) {
      if (first.report.identity?.[key] !== second.report.identity?.[key]) fail(0, `runs differ in source identity: ${key}`);
    }
    if (JSON.stringify(first.check.identity) !== JSON.stringify(second.check.identity)) fail(0, 'runs differ in evidence identity');
    if (first.report.candidate?.artifactSha256 !== second.report.candidate?.artifactSha256
      || first.report.candidate?.mode !== second.report.candidate?.mode) fail(0, 'runs tested a different archive');
  }
  const runs = parts.map(part => part.report.runs[0]);
  const consecutiveStartsMatch = runs.length === 2 && runs.every(run => run.cleanStartingRows)
    && JSON.stringify(runs[0].startingRows) === JSON.stringify(runs[1].startingRows)
    && JSON.stringify(runs[0].startingFailedJobReasons) === JSON.stringify(runs[1].startingFailedJobReasons);
  if (!consecutiveStartsMatch) failures.push({ stage: 'clean_starts', error: 'Two consecutive clean starting states were not recorded' });
  const report = {
    ...(first?.report ?? {}),
    recordedAt: new Date().toISOString(),
    runs,
    failures,
    consecutiveStartsMatch,
    candidate: first ? { artifactSha256: first.report.candidate?.artifactSha256, mode: first.report.candidate?.mode,
      verifiedBefore: parts.every(part => part.report.candidate?.verifiedBefore === true),
      verifiedAfter: parts.every(part => part.report.candidate?.verifiedAfter === true) } : undefined
  };
  const success = failures.length === 0 && parts.every(part => part.check.exitCode === 0);
  const times = key => parts.map(part => part.check[key]).filter(Boolean).sort();
  const check = { name: 'isolated', identity: first?.check.identity, startedAt: times('startedAt')[0], finishedAt: times('finishedAt').at(-1),
    exitCode: success ? 0 : 1, signal: null, outcome: success ? 'success' : 'failure' };
  await mkdir(evidenceDirectory, { recursive: true });
  for (const { directory, run } of parts) {
    for (const entry of await readdir(directory)) {
      if (['isolated.json', 'isolated.log'].includes(entry) || entry === `isolated-report-${run}.json`) continue;
      await cp(path.join(directory, entry), path.join(evidenceDirectory, entry), { recursive: true });
    }
  }
  const logs = [];
  for (const { run, directory } of parts) logs.push(`=== isolated run ${run} ===\n${await readFile(path.join(directory, 'isolated.log'), 'utf8').catch(() => '')}`);
  await writeFile(path.join(evidenceDirectory, 'isolated.log'), logs.join('\n'));
  await writeFile(path.join(evidenceDirectory, 'isolated-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(evidenceDirectory, 'isolated.json'), `${JSON.stringify(check, null, 2)}\n`);
  return { report, check };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [runs, evidence] = process.argv.slice(2);
  if (!runs || !evidence) throw new Error('Usage: merge-isolated.mjs RUNS_DIR EVIDENCE_DIR');
  const { report } = await mergeIsolated(path.resolve(runs), path.resolve(evidence));
  console.log(report.failures.length ? JSON.stringify(report.failures, null, 2) : 'Both isolated runs merged.');
  process.exitCode = report.failures.length ? 1 : 0;
}
