import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { redact } from './ci/redact.mjs';
import { checkInSpecsNotPassed } from './ci/check-in-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `--check-in-gate`: one run, built with VITE_CHECK_IN_ENABLED=true, only the check-in specs, none skipped.
const checkInGate = process.argv.includes('--check-in-gate');
// `ISOLATED_RUN=1|2`: execute only that numbered run, so CI can run the two in parallel on separate runners.
// `scripts/ci/merge-isolated.mjs` rebuilds the two-run report. The check-in gate is always a single run.
const singleRun = checkInGate ? undefined : process.env.ISOLATED_RUN || undefined;
const checkInSpecs = ['tests/browser/check-in.spec.ts', 'tests/browser/latest-work.spec.ts'];
const output = path.resolve(root, process.env.ISOLATED_REPORT_PATH
  ?? (checkInGate ? '.scratch/ci/check-in-gate-report.json' : '.scratch/faza-2/evidence/01-isolated-baseline.json'));
const { Client } = pg;
let activeChild;
let interrupted = false;
let podmanService;

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  if (activeChild?.pid) {
    try { process.kill(-activeChild.pid, signal); } catch { /* process already exited */ }
  }
});

async function podmanSocketReady(socketPath) {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    const finish = ready => { socket.destroy(); resolve(ready); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function ensurePodmanSocket() {
  try {
    const socket = await command('systemctl', ['--user', 'start', 'podman.socket']);
    if (socket.code === 0) return 'systemd user socket';
  } catch { /* Hosted runners may have no user systemd session. */ }
  const socketPath = execFileSync('podman', ['info', '--format', '{{.Host.RemoteSocket.Path}}'], { encoding: 'utf8' }).trim();
  if (!socketPath) throw new Error('Podman reports no remote socket path');
  if (await podmanSocketReady(socketPath)) return 'existing Podman socket';
  await mkdir(path.dirname(socketPath), { recursive: true });
  podmanService = spawn('podman', ['system', 'service', '--time=0', `unix://${socketPath}`], { detached: true, stdio: 'ignore' });
  let startupError;
  podmanService.once('error', error => { startupError = error; });
  for (let attempt = 0; attempt < 60 && !interrupted; attempt++) {
    if (startupError) throw startupError;
    if (podmanService.exitCode !== null || podmanService.signalCode !== null) break;
    if (await podmanSocketReady(socketPath)) return 'runner-owned Podman socket';
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Podman socket service did not become ready at ${socketPath}`);
}

function stopPodmanService() {
  if (podmanService?.pid) {
    try { process.kill(-podmanService.pid, 'SIGTERM'); } catch { /* Service already exited. */ }
  }
}

function command(program, args, env = process.env, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, detached: true,
      stdio: logFile ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    activeChild = child;
    const chunks = [];
    if (logFile) {
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
        chunks.push(chunk);
        (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
      });
    }
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      try {
        if (logFile) await writeFile(logFile, Buffer.concat(chunks));
        resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 143), signal });
      } catch (error) { reject(error); }
    });
  });
}

async function fixtureHash() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else files.push(file);
    }
  }
  await walk(path.join(root, 'data/fixtures'));
  await walk(path.join(root, '.scratch/faza-2/workloads'));
  for (const relative of ['data/rule-sets/2026-09-24-v2.json', 'tests/golden/notice-cases.json',
    'tests/golden/notice-skeletons.json', 'tests/golden/notice-places.json']) files.push(path.join(root, relative));
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

async function sourceIdentity() {
  const head = await new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    let value = '';
    child.stdout.on('data', chunk => value += chunk);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(value.trim()) : reject(new Error('git rev-parse failed')));
  });
  const diff = await new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--binary', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('git diff failed')));
  });
  const untracked = await new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(Buffer.concat(chunks).toString().split('\0').filter(Boolean)) : reject(new Error('git ls-files failed')));
  });
  const buildHash = createHash('sha256').update(head).update(diff)
    .update(await readFile(path.join(root, 'package-lock.json')));
  for (const relative of untracked) buildHash.update(relative).update(await readFile(path.join(root, relative)));
  return { gitHead: head, sourceAndBuildSha256: buildHash.digest('hex'), fixtureAndGoldenSha256: await fixtureHash() };
}

async function counts(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(`SELECT
      (SELECT count(*)::int FROM report) AS reports,
      (SELECT count(*)::int FROM report_event) AS events,
      (SELECT count(*)::int FROM findings) AS findings,
      (SELECT count(*)::int FROM findings_job) AS jobs,
      (SELECT count(*)::int FROM findings_job WHERE failed_reason IS NOT NULL) AS failed_jobs`);
    const failed = await client.query(`SELECT failed_reason AS reason, count(*)::int AS count
      FROM findings_job WHERE failed_reason IS NOT NULL GROUP BY failed_reason ORDER BY failed_reason`);
    return { rows: result.rows[0], failedJobReasons: Object.fromEntries(failed.rows.map(row => [row.reason, row.count])) };
  } finally { await client.end(); }
}

function imageFingerprints(project) {
  const services = { app: `${project}-app`, web: `${project}-web`, fixtureLoader: `${project}-fixture`,
    postgis: 'docker.io/postgis/postgis:17-3.5' };
  const images = execFileSync('podman', ['image', 'inspect', ...Object.values(services),
    '--format', '{"id":"{{.Id}}","digest":"{{.Digest}}"}'], { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));
  return Object.fromEntries(Object.keys(services).map((service, index) => {
    const image = images[index];
    return [service, { id: image.id, digest: image.digest || null, names: [services[service]] }];
  }));
}

// Ports stay below the kernel's ephemeral range (32768 to 60999): a client socket holding a drawn port made
// rootlessport fail to bind. Each draw is checked bindable on loopback, the address Compose publishes on.
function canBind(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// ISOLATED_FORCE_FIRST_DB_PORT is a test hook: the first attempt takes that database port without the bind
// check, which reproduces a port another process grabs between the check and `compose up`.
async function drawPorts(attempt) {
  const forced = attempt === 1 ? Number(process.env.ISOLATED_FORCE_FIRST_DB_PORT) : 0;
  const ports = forced ? [forced] : [];
  for (let tries = 0; ports.length < 3 && tries < 200; tries++) {
    const port = randomInt(20000, 32768);
    if (!ports.includes(port) && await canBind(port)) ports.push(port);
  }
  if (ports.length < 3) throw new Error('No bindable ports found below 32768');
  return { db: ports[0], api: ports[1], web: ports[2] };
}

// Compose's `down` leaves the run's four image tags. Remove them by exact name, never by prune.
function removeRunImages(project) {
  const wanted = new Set(['app', 'migration', 'fixture', 'web'].map(service => `${project}-${service}`));
  const listed = execFileSync('podman', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').map(line => line.trim()).filter(Boolean)
    .filter(name => wanted.has(name.slice(0, name.lastIndexOf(':')).split('/').pop()));
  if (!listed.length) return { removed: [], exitCode: 0 };
  const removal = spawnSync('podman', ['image', 'rm', ...listed], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { removed: listed, exitCode: removal.status ?? 1, ...(removal.status === 0 ? {} : { error: redact(removal.stderr ?? '') }) };
}

async function browserRateUsage(url, reset = false) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (reset) await client.query('DELETE FROM rate_counter');
    const result = await client.query(`SELECT daily_count FROM rate_counter
      WHERE expires_at > now() ORDER BY daily_count DESC`);
    const dailyCounts = result.rows.map(row => row.daily_count);
    return { dailyLimit: 50, dailyCounts, peakDailyCount: Math.max(0, ...dailyCounts) };
  } finally { await client.end(); }
}

const report = {
  recordedAt: new Date().toISOString(),
  runs: [],
  failures: [],
  auditBaseline: {
    buildAndCheck: 'passed', api: '62/65 passed', browser: '56/61 passed',
    knownFailures: 'Findings and transition timeouts; original failing test identifiers were not retained',
    mixedWorkloadFindingsP95Seconds: 12.91,
    mixedWorkloadFindingsMaxSeconds: 16.76,
    apiWaitSeconds: 8,
    fixture: 'reused database containing thousands of Reports'
  },
  independentAcceptance: 'Geospatial measurements remain in data/fixtures/**/README.md and acceptance.json; Notice goldens remain in tests/golden/. Their combined SHA-256 is recorded above.'
};
let exitCode = 0;
let candidate;
try {
  if (singleRun !== undefined && !['1', '2'].includes(singleRun)) throw new Error(`ISOLATED_RUN must be 1 or 2, got ${singleRun}`);
  console.log('Generating deterministic workload fixtures');
  const workloadGeneration = await command(process.execPath, ['scripts/generate-workloads.mjs']);
  if (workloadGeneration.code !== 0) throw new Error(`Workload generation failed with exit ${workloadGeneration.code}`);
  console.log('Hashing source, build, fixture and golden inputs');
  report.identity = await sourceIdentity();
  const playwrightPackage = JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/package.json'), 'utf8'));
  const browserPins = JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
  const chromium = browserPins.browsers.find(browser => browser.name === 'chromium');
  report.conditions = {
    node: process.version,
    api: 'real HTTP against PostGIS 17-3.5 fixture loaded from checked-in source files',
    browser: `Chromium ${chromium.browserVersion} (Playwright ${playwrightPackage.version}), 390x844 CSS px, one worker`,
    physicalAndroid: 'not run; baseline has no attached-device measurement'
  };
  if (process.env.CI_CANDIDATE_ARCHIVE) {
    const { candidateStack } = await import('./ci/candidate-stack.mjs');
    candidate = await candidateStack(root, path.resolve(process.env.CI_CANDIDATE_ARCHIVE));
    report.candidate = { artifactSha256: candidate.artifactSha256, mode: candidate.mode, verifiedBefore: true, verifiedAfter: false };
  }
  console.log('Starting Podman socket');
  report.conditions.podmanSocket = await ensurePodmanSocket();
  console.log(`Podman socket ready (${report.conditions.podmanSocket})`);
  const results = report.runs;
  for (let index = singleRun ? Number(singleRun) : 1; index <= (checkInGate ? 1 : singleRun ? Number(singleRun) : 2) && !interrupted; index++) {
    const id = `bor-czuwa-isolated-${Date.now()}-${randomUUID()}`;
    const environment = { ...process.env, ...(checkInGate ? { VITE_CHECK_IN_ENABLED: 'true' } : {}) };
    const result = { run: index, project: id, suites: {}, portRetries: [] };
    const compose = (...args) => command('podman', ['compose', ...(candidate?.files ?? []), '-p', id, ...args], environment);
    const composeLogged = (logFile, ...args) => command('podman', ['compose', ...(candidate?.files ?? []), '-p', id, ...args], environment, logFile);
    let runStage = 'network';
    try {
      console.log(`Starting isolated run ${index}/2 (${id})`);
      const network = `${id}_default`;
      const created = await command('podman', ['network', 'create', '--label', `com.docker.compose.project=${id}`,
        '--label', 'com.docker.compose.network=default', network]);
      if (created.code !== 0) throw new Error(`Network allocation failed with exit ${created.code}`);
      const subnet = execFileSync('podman', ['network', 'inspect', network, '--format', '{{range .Subnets}}{{.Subnet}}{{end}}'], { encoding: 'utf8' }).trim();
      const prefix = /^(\d+\.\d+\.\d+)\.0\/24$/.exec(subnet)?.[1];
      if (!prefix) throw new Error(`Expected an IPv4 /24 disposable network, got ${subnet}`);
      environment.TEST_SUBNET = prefix;
      environment.TEST_PROXY_IP = `${prefix}.3`;
      result.subnet = subnet;
      runStage = 'startup';
      let up;
      for (let attempt = 1; ; attempt++) {
        const ports = await drawPorts(attempt);
        environment.TEST_DB_PORT = String(ports.db);
        environment.TEST_API_PORT = String(ports.api);
        environment.TEST_WEB_PORT = String(ports.web);
        result.ports = ports;
        const upLog = path.join(path.dirname(output), `01-run-${index}-startup-attempt-${attempt}.log`);
        await mkdir(path.dirname(upLog), { recursive: true });
        up = await composeLogged(upLog, 'up', '--build', '-d', '--wait');
        if (up.code === 0) break;
        const busy = /address already in use/.exec(await readFile(upLog, 'utf8').catch(() => ''));
        if (!busy || attempt >= 3 || interrupted) break;
        result.portRetries.push({ attempt, ports, error: 'bind: address already in use' });
        console.log(`Port in use on attempt ${attempt}; drawing new ports`);
        await compose('down', '--volumes', '--remove-orphans');
      }
      if (up.code !== 0) throw new Error(`Compose startup failed with exit ${up.code}`);
      runStage = 'image_metadata';
      result.images = imageFingerprints(id);
      runStage = 'starting_rows';
      const databaseUrl = `postgres://skeleton:skeleton-local-only@127.0.0.1:${environment.TEST_DB_PORT}/skeleton`;
      const startingState = await counts(databaseUrl);
      result.startingRows = startingState.rows;
      result.startingFailedJobReasons = startingState.failedJobReasons;
      result.cleanStartingRows = Object.values(result.startingRows).every(value => value === 0);
      const urls = {
        ...environment,
        DATABASE_URL: databaseUrl,
        TEST_DATABASE_URL: databaseUrl,
        TEST_RUNTIME_DATABASE_URL: `postgres://app_runtime:runtime-local-only@127.0.0.1:${environment.TEST_DB_PORT}/skeleton`,
        TEST_CANDIDATE_MODE: candidate?.mode ?? 'staging',
        TEST_BASE_URL: `http://127.0.0.1:${environment.TEST_API_PORT}`,
        TEST_WEB_URL: `http://127.0.0.1:${environment.TEST_WEB_PORT}`
      };
      for (const [name, args] of checkInGate ? [['browser', ['run', 'test:browser']]] : [['api', ['run', 'test:api']], ['browser', ['run', 'test:browser']]]) {
        if (interrupted) throw new Error('Isolated run interrupted');
        runStage = name;
        if (name === 'browser') await browserRateUsage(databaseUrl, true);
        const logPath = path.join(path.dirname(output), `01-run-${index}-${name}.log`);
        await mkdir(path.dirname(logPath), { recursive: true });
        const browserArtifacts = path.join(path.dirname(output), `01-run-${index}-browser-artifacts`);
        const browserResults = path.join(path.dirname(output), `01-run-${index}-browser-results.json`);
        if (name === 'browser') args.push('--', '--output', browserArtifacts, '--reporter=line,json', ...(checkInGate ? checkInSpecs : []));
        const suiteEnvironment = name === 'browser' ? { ...urls, PLAYWRIGHT_JSON_OUTPUT_FILE: browserResults } : urls;
        const run = await command('npm', args, suiteEnvironment, logPath);
        result.suites[name] = { exitCode: run.code, output: path.relative(root, logPath),
          ...(name === 'browser' ? { artifacts: path.relative(root, browserArtifacts), results: path.relative(root, browserResults) } : {}) };
        if (run.code !== 0) report.failures.push({ run: index, suite: name, exitCode: run.code, output: path.relative(root, logPath) });
        if (name === 'browser' && checkInGate) {
          const playwrightReport = JSON.parse(await readFile(browserResults, 'utf8').catch(() => '{"stats":{},"suites":[]}'));
          const { stats } = playwrightReport;
          const notPassed = checkInSpecsNotPassed(playwrightReport);
          result.checkInGate = { expected: stats.expected ?? 0, unexpected: stats.unexpected ?? 0, flaky: stats.flaky ?? 0, skipped: stats.skipped ?? 0, flagDependentNotPassed: notPassed };
          if (!result.checkInGate.expected || result.checkInGate.skipped || notPassed.length) {
            report.failures.push({ run: index, suite: 'check_in_gate', error: `Check-in specs ran ${result.checkInGate.expected}, skipped ${result.checkInGate.skipped}, flag-dependent specs not passed: ${notPassed.join('; ') || 'none'}; the gate needs a build with VITE_CHECK_IN_ENABLED=true` });
          }
        }
        if (name === 'browser') {
          runStage = 'browser_rate_budget';
          result.browserRateUsage = await browserRateUsage(databaseUrl);
          console.log(`Browser daily rate counts: ${result.browserRateUsage.dailyCounts.join(', ') || '0'} / ${result.browserRateUsage.dailyLimit} per IP/scope (fixed-clock limit cases excluded)`);
          if (result.browserRateUsage.peakDailyCount >= result.browserRateUsage.dailyLimit) throw new Error('Browser journeys exhausted the daily Report limit');
        }
      }
      runStage = 'ending_rows';
      const endingState = await counts(databaseUrl);
      result.endingRows = endingState.rows;
      result.endingFailedJobReasons = endingState.failedJobReasons;
      result.repeatableStart = Object.values(result.startingRows).every(value => value === 0);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      report.failures.push({ run: index, stage: runStage, error: result.error });
      if (runStage === 'startup') {
        const services = ['db', 'migration', 'fixture', 'app'];
        try {
          const diagnosticPath = path.join(path.dirname(output), `01-run-${index}-startup-services.log`);
          const captured = spawnSync('podman', ['compose', ...(candidate?.files ?? []), '-p', id,
            'logs', '--no-color', '--timestamps', '--tail', '100', ...services], {
            cwd: root, env: environment, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024
          });
          await mkdir(path.dirname(diagnosticPath), { recursive: true });
          await writeFile(diagnosticPath, redact((captured.stdout ?? '') + (captured.stderr ?? '')
            + (captured.error ? `\n${captured.error.message}\n` : '')));
          result.startupDiagnostics = { services, output: path.relative(root, diagnosticPath),
            exitCode: captured.status, signal: captured.signal, ...(captured.error ? { error: redact(captured.error.message) } : {}) };
        } catch (error) {
          result.startupDiagnostics = { services, error: redact(error instanceof Error ? error.message : String(error)) };
        }
      }
    } finally {
      try {
        const down = await compose('down', '--volumes', '--remove-orphans');
        result.cleanupExitCode = down.code;
        if (down.code !== 0) report.failures.push({ run: index, stage: 'cleanup', exitCode: down.code });
      } catch (error) {
        result.cleanupError = error instanceof Error ? error.message : String(error);
        report.failures.push({ run: index, stage: 'cleanup', error: result.cleanupError });
      }
      try {
        result.imageCleanup = removeRunImages(id);
        if (result.imageCleanup.exitCode !== 0) report.failures.push({ run: index, stage: 'image_cleanup', exitCode: result.imageCleanup.exitCode });
      } catch (error) {
        result.imageCleanup = { removed: [], error: redact(error instanceof Error ? error.message : String(error)) };
        report.failures.push({ run: index, stage: 'image_cleanup', error: result.imageCleanup.error });
      }
    }
    results.push(result);
    if (interrupted) {
      exitCode = 1;
      break;
    }
  }

  // Not applicable to a single run (the check-in gate, or one numbered run): the field is omitted there.
  const paired = !checkInGate && !singleRun;
  if (paired) report.consecutiveStartsMatch = results.length === 2 && results.every(run => run.cleanStartingRows) && JSON.stringify(results[0].startingRows) === JSON.stringify(results[1].startingRows)
    && JSON.stringify(results[0].startingFailedJobReasons) === JSON.stringify(results[1].startingFailedJobReasons);
  if (!paired ? results.some(run => !run.cleanStartingRows) : (!report.consecutiveStartsMatch || results.some(run => !run.cleanStartingRows))) {
    report.failures.push({ stage: 'clean_starts', error: !singleRun ? 'Two consecutive clean starting states were not recorded' : 'A clean starting state was not recorded' });
  }
} catch (error) {
  report.failures.push({ stage: 'setup', error: error instanceof Error ? error.message : String(error) });
} finally {
  try {
    if (candidate) {
      try { await candidate.verify(); report.candidate.verifiedAfter = true; }
      catch (error) { report.failures.push({ stage: 'candidate_identity', error: error.message }); }
      finally { await candidate.cleanup(); }
    }
  } finally {
    stopPodmanService();
  }
  if (interrupted) report.failures.push({ stage: 'interrupted', error: 'Isolated runner interrupted' });
  if (report.failures.length) exitCode = 1;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Isolated baseline report: ${path.relative(root, output)}`);
  process.exitCode = exitCode;
}
