import { pool } from './db.ts';
import { clusterReportIds, digestForDay, exclude, liftExclusion, mailDigest, reportCounts, unpublish,
  requeueFindings, type ExclusionReason } from './operator.ts';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const usage = 'Usage: npm run operator -- exclude [--cluster] <report-id> <fabricated|duplicate|test> | lift-exclusion [--cluster] <report-id> | unpublish <report-id> | requeue-findings <reason> [--since YYYY-MM-DD] | counts | digest [YYYY-MM-DD] | digest-preview [YYYY-MM-DD]';

async function main(args: string[]) {
  const [command, ...rest] = args;
  if (command === 'requeue-findings' && (rest.length === 1 || (rest.length === 3 && rest[1] === '--since'))) {
    return console.log(`Requeued ${await requeueFindings(rest[0], rest[2])} Findings jobs`);
  }
  if (command === 'counts' && rest.length === 0) return console.log(await reportCounts());
  if ((command === 'digest' || command === 'digest-preview') && rest.length <= 1) {
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now() - 86_400_000);
    const day = rest[0] ?? yesterday;
    if (command === 'digest') await mailDigest(day);
    else process.stdout.write(await digestForDay(day));
    return;
  }
  if (command === 'unpublish' && rest.length === 1 && uuid.test(rest[0])) {
    await unpublish(rest[0]);
    return console.log(`Unpublished ${rest[0]}`);
  }
  if (command === 'exclude' || command === 'lift-exclusion') {
    const clustered = rest[0] === '--cluster';
    const values = clustered ? rest.slice(1) : rest;
    const expected = command === 'exclude' ? 2 : 1;
    if (values.length !== expected || !uuid.test(values[0])) throw new Error(usage);
    const ids = clustered ? await clusterReportIds(values[0]) : [values[0]];
    if (command === 'exclude') await exclude(ids, values[1] as ExclusionReason);
    else await liftExclusion(ids);
    return console.log(`${command}: ${ids.join(', ')}`);
  }
  throw new Error(usage);
}

try { await main(process.argv.slice(2)); }
catch (error) { console.error((error as Error).message); process.exitCode = 1; }
finally { await pool.end(); }
