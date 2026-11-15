"""Run mixed-load measurements on a fresh, resource-limited PostGIS database."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--inputs', type=Path, required=True, help='Pinned national inputs directory; fixture inputs for --test')
parser.add_argument('--workload', type=Path, help='Prior national findings.json containing the 1,000 pinned points')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--ingest-image', required=True, help='Cached image with scripts/requirements.txt installed')
parser.add_argument('--app-image', required=True, help='Cached Node image; current source is mounted read-only')
parser.add_argument('--test', action='store_true', help='Run HTTP regression against fixtures instead of national benchmark')
args = parser.parse_args()
inputs, output = args.inputs.resolve(), args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
prefix = 'bor-f5-07-' + uuid.uuid4().hex[:12]
network, volume, db, ingest, app = [prefix + '-' + part for part in ('net', 'data', 'db', 'ingest', 'app')]
record = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'status': 'running',
          'root': str(ROOT), 'inputs': str(inputs), 'fixture': args.test, 'samples': [],
          'hardware': {'platform': platform.platform(), 'memoryBytes': os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES'),
                       'loadAverageAtStart': os.getloadavg(), 'cpu': subprocess.check_output(['lscpu'], text=True),
                       'storage': subprocess.check_output(['findmnt', '-T', str(output)], text=True)},
          'limits': {'db': {'memoryMiB': 1024, 'cpus': 2}, 'appAndDriver': {'memoryMiB': 1024, 'cpus': 2},
                     'ingest': {'memoryMiB': 2560, 'cpus': 2}, 'swap': False},
          'cache': 'Source bytes and host filesystem cache reused; new database volume. Worker-only runs first, then mixed and recovery. No host cache eviction.',
          'topology': 'One Node API process with unmodified main.ts Findings and Integrity loops; separate HTTP driver child. Direct loopback HTTP without nginx/TLS.'}
created = []
# Keep the cached image's /app/node_modules visible; a full /app source bind hides it.
# Mount every Node source/input directory used here, never the image's old source.
source_mounts = []
for name in ('server', 'src', 'scripts', 'tests', 'data', 'package.json', 'package-lock.json',
             'tsconfig.json', 'tsconfig.server.json'):
    source_mounts += ['-v', f'{ROOT / name}:/app/{name}:ro']
node_options = ['--user', '0', '--network', network, '--memory=1g', '--memory-swap=1g', '--cpus=2',
                '--security-opt', 'label=disable', *source_mounts, '-w', '/app']


def run(*command, **kwargs):
    return subprocess.check_output(command, cwd=ROOT, text=True, stderr=subprocess.STDOUT, **kwargs).strip()


def save():
    (output / 'run.json').write_text(json.dumps(record, indent=2) + '\n')


def sql(query):
    return run('podman', 'exec', db, 'psql', '-h', '127.0.0.1', '-U', 'skeleton', '-d', 'national', '-Atc', query)


def sample():
    row = {'time': time.time()}
    for name in (db, app):
        try:
            pid = int(run('podman', 'inspect', name, '--format', '{{.State.Pid}}'))
            group = Path('/sys/fs/cgroup') / Path(f'/proc/{pid}/cgroup').read_text().split('0::', 1)[1].strip().lstrip('/')
            row[name] = {field: (group / field).read_text().strip() for field in
                         ('memory.current', 'memory.peak', 'cpu.stat', 'memory.max', 'cpu.max')}
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass
    record['samples'].append(row)
    save()


try:
    record['gitHead'] = run('git', '-C', str(ROOT), 'rev-parse', 'HEAD')
    files = run('git', '-C', str(ROOT), 'ls-files').splitlines()
    files += ['scripts/benchmark-national-mixed.mjs', 'scripts/run-national-mixed.py', 'tests/national-mixed.test.ts']
    record['sourceHashes'] = {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest()
                              for file in sorted(set(files)) if (ROOT / file).is_file() and not file.startswith('.scratch/')}
    record['images'] = {name: run('podman', 'image', 'inspect', image, '--format', '{{.Id}}') for name, image in
                        [('database', 'docker.io/postgis/postgis:17-3.5'), ('ingest', args.ingest_image), ('app', args.app_image)]}
    dependency_check = prefix + '-dependencies'
    created.append(('rm', '-f', dependency_check))
    image_lock = run('podman', 'run', '--name', dependency_check, '--network=none',
                     '--memory=1g', '--memory-swap=1g', '--cpus=2', args.app_image,
                     'node', '--input-type=module', '-e',
                     "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto';"
                     "console.log(createHash('sha256').update(readFileSync('/app/package-lock.json')).digest('hex'));")
    source_lock = hashlib.sha256((ROOT / 'package-lock.json').read_bytes()).hexdigest()
    record['dependencies'] = {'sourceLockSha256': source_lock, 'imageLockSha256': image_lock,
                              'binding': 'Current Node source/input paths mounted individually at /app; cached image node_modules retained. No host Node dependencies.'}
    if image_lock != source_lock:
        raise RuntimeError('Cached app image lockfile differs from source; supply an image built from the current lockfile')
    run('podman', 'network', 'create', network)
    created.append(('network', 'rm', network))
    run('podman', 'volume', 'create', volume)
    created.append(('volume', 'rm', volume))
    run('podman', 'run', '-d', '--name', db, '--network', network, '--memory=1g', '--memory-swap=1g', '--cpus=2',
        '-e', 'POSTGRES_USER=skeleton', '-e', 'POSTGRES_PASSWORD=disposable-only', '-e', 'POSTGRES_DB=national',
        '-p', '127.0.0.1::5432', '-v', f'{volume}:/var/lib/postgresql/data', 'docker.io/postgis/postgis:17-3.5',
        'postgres', '-c', 'log_statement=none', '-c', 'log_min_error_statement=panic', '-c', 'log_min_messages=panic')
    created.append(('rm', '-f', db))
    for attempt in range(60):
        try:
            if sql('SELECT 1') == '1':
                break
        except subprocess.CalledProcessError:
            time.sleep(1)
    else:
        raise RuntimeError('Disposable PostGIS did not start')
    owner = f'postgres://skeleton:disposable-only@{db}:5432/national'
    for name, script in [('migration', 'migrate.ts'), ('rules', 'load-rule-sets.ts')]:
        container = prefix + '-' + name
        created.append(('rm', '-f', container))
        (output / f'{name}.log').write_text(run('podman', 'run', '--name', container, *node_options,
            '-e', f'MIGRATION_DATABASE_URL={owner}', '-e', f'DATABASE_URL={owner}',
            '-e', 'RUNTIME_DB_PASSWORD=disposable-runtime', args.app_image,
            'node', '--import', 'tsx', f'server/{script}'))
    record['postgres'] = sql('SELECT version()')
    record['postgis'] = sql('SELECT postgis_full_version()')
    record['dbSettings'] = sql("SELECT name||'='||setting FROM pg_settings WHERE name IN ('shared_buffers','work_mem','max_connections','effective_cache_size','max_parallel_workers_per_gather')")
    created.append(('rm', '-f', ingest))
    with (output / 'ingest.log').open('w') as log:
        subprocess.run(['podman', 'run', '--name', ingest, '--network', network, '--memory=2560m', '--memory-swap=2560m', '--cpus=2',
                        '--security-opt', 'label=disable', '-v', f'{ROOT}:/app:ro', '-v', f'{inputs}:/inputs:ro', '-v', f'{output}:/evidence:rw',
                        '-e', 'GEODATA_EXTRACT_DIR=/evidence/extracts', '-e', f'DATABASE_URL=postgres://skeleton:disposable-only@{db}:5432/national',
                        '-w', '/app', args.ingest_image, 'python', 'scripts/ingest-bubd.py', '/inputs/bubd.parquet', '/inputs/manifest.json',
                        '/inputs/obwody.json', '/inputs/obwody-manifest.json', '/inputs/protected/manifest.json', '/inputs/recipients/manifest.json',
                        '/inputs/osm/stands.geojsonseq', '/inputs/osm/manifest.json'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1200)
    record['concurrentContainersAtBenchmarkStart'] = run('podman', 'ps', '--format', '{{.Names}} {{.Status}}')
    record['benchmarkSourceHashes'] = {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in record['sourceHashes']}
    command = ['podman', 'run', '--name', app, *node_options, '-v', f'{output}:/evidence:rw',
               '-e', f'DATABASE_URL=postgres://app_runtime:disposable-runtime@{db}:5432/national', '-e', 'BENCHMARK_DISPOSABLE=1']
    created.append(('rm', '-f', app))
    if args.test:
        command += ['-d', '-p', '127.0.0.1::3001', '-e', 'HOST=0.0.0.0', args.app_image, 'node', '--import', 'tsx', 'server/main.ts']
        run(*command)
        api_port = run('podman', 'port', app, '3001').rsplit(':', 1)[1]
        import urllib.request
        for attempt in range(60):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{api_port}/api/ready', timeout=2).close()
                break
            except OSError:
                time.sleep(1)
        with (output / 'test.log').open('w') as log:
            subprocess.run(['podman', 'exec', app, 'node', '--import', 'tsx', '--test', 'tests/national-mixed.test.ts'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
        with (output / 'area-fixture.log').open('w') as log:
            subprocess.run(['podman', 'exec', app, 'node', '--import', 'tsx',
                            'scripts/benchmark-national-mixed.mjs', '--fixture-areas',
                            '/evidence/area-fixture.json', 'http://127.0.0.1:3001'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
        record['areaFixture'] = {'path': 'area-fixture.json', 'scope': 'Bounded actual HTTP/worker area-driver fixture, not national timing'}
    else:
        if not args.workload:
            raise ValueError('--workload is required for national measurements')
        (output / 'workload.json').write_bytes(args.workload.read_bytes())
        command += [args.app_image, 'node', '--import', 'tsx', 'scripts/benchmark-national-mixed.mjs', '/evidence/mixed.json', '/evidence/workload.json']
        with (output / 'benchmark.log').open('w') as log:
            child = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 1200
            while child.poll() is None:
                sample()
                if time.monotonic() > deadline:
                    child.terminate()
                    raise TimeoutError('Benchmark exceeded 20 minutes')
                time.sleep(1)
            if child.returncode:
                raise RuntimeError(f'Benchmark exit {child.returncode}; see benchmark.log')
    sample()
    record['status'] = 'complete'
except BaseException as error:
    record.update(status='failed', error=str(error), errorOutput=getattr(error, 'output', None))
    raise
finally:
    record['cleanup'] = []
    for command in reversed(created):
        cleaned = subprocess.run(['podman', *command], capture_output=True, text=True)
        record['cleanup'].append({'command': command, 'exitCode': cleaned.returncode, 'stderr': cleaned.stderr})
    record['loadAverageAtEnd'] = os.getloadavg()
    record['endedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    save()
    if any(row['exitCode'] for row in record['cleanup']):
        raise RuntimeError('Disposable resource cleanup failed; see run.json')
