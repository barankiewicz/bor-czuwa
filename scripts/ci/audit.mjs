import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.env.CI_EVIDENCE_DIR ?? '.scratch/ci');
await mkdir(directory, { recursive: true });
const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', timeout: 120_000 });
let report;
try {
  const audit = JSON.parse(result.stdout);
  if (![0, 1].includes(result.status) || !audit.metadata?.vulnerabilities || audit.error) throw new Error('Registry audit failed');
  report = { vulnerabilities: audit.metadata.vulnerabilities, exitCode: result.status,
    findings: Object.values(audit.vulnerabilities ?? {}).map(item => ({ name: item.name, severity: item.severity,
      isDirect: item.isDirect, range: item.range, fixAvailable: item.fixAvailable })),
    note: 'Known advisory counts are not security or release clearance.' };
} catch {
  report = { registryError: true, exitCode: result.status };
  process.exitCode = 1;
}
await writeFile(path.join(directory, 'audit-summary.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
