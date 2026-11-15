import { pool } from './db.ts';
import { clusterConfirmation, clusterPreview, clusterReportIds, digestForDay, exclude, liftExclusion, mailDigest, reportCounts, unpublish,
  requeueFindings, type ExclusionReason } from './operator.ts';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const usage = 'Usage: npm run operator -- exclude [--cluster] <report-id> <fabricated|duplicate|test> [--confirm <token>, required with --cluster] | lift-exclusion [--cluster] <report-id> | unpublish <report-id> | requeue-findings <reason> [--since YYYY-MM-DD] | counts | digest [YYYY-MM-DD] | digest-preview [YYYY-MM-DD]';

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
    const clustered = rest.includes('--cluster');
    // --confirm <token> or --confirm=<token>, anywhere after the command.
    let confirm: string | undefined;
    const values: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--cluster') continue;
      if (rest[i] === '--confirm') confirm = rest[++i];
      else if (rest[i].startsWith('--confirm=')) confirm = rest[i].slice('--confirm='.length);
      else values.push(rest[i]);
    }
    const expected = command === 'exclude' ? 2 : 1;
    if (values.length !== expected || !uuid.test(values[0]) || (confirm !== undefined && !(command === 'exclude' && clustered))) {
      throw new Error(usage);
    }
    if (command === 'exclude' && clustered) {
      const { members, truncated, cap } = await clusterPreview(values[0]);
      console.log(`Cluster of ${members.length}${truncated ? '+' : ''} Reports around ${values[0]}:`);
      for (const member of members) {
        const how = member.linkedFrom ? `${member.reasons.join(', ')}, reached from ${member.linkedFrom}` : 'seed';
        console.log(`  ${member.id}  ${how}${member.signalClipped ? `  (signal clipped at ${cap}: ${cap}+ links)` : ''}`);
      }
      if (truncated) throw new Error(`Cluster truncated at ${cap}; it is larger than the cap, so nothing was excluded. Exclude Reports one by one.`);
      const token = clusterConfirmation(members);
      if (confirm !== token) {
        throw new Error(`Nothing excluded. Check the members above, then re-run with --confirm ${token} to exclude exactly these ${members.length} Reports.`);
      }
      await exclude(members.map(member => member.id), values[1] as ExclusionReason);
      return console.log(`exclude: ${members.length} Reports`);
    }
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
