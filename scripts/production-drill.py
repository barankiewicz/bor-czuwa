"""Check production hardening in a disposable container; backups and restore stay disabled."""
import argparse
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host-only', action='store_true', help='Run only host deployment checks')
args = parser.parse_args()

ROOT = Path(__file__).resolve().parents[1]
name = 'bor-czuwa-host-drill-' + uuid.uuid4().hex[:12]
image = name + ':test'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


try:
    with tempfile.TemporaryDirectory() as directory:
        dockerfile = Path(directory) / 'Containerfile'
        dockerfile.write_text('''FROM docker.io/library/node:24-trixie-slim
RUN apt-get update -qq && apt-get install -y -qq python3 openssh-server postgresql-client restic iproute2 \\
    systemd systemd-sysv dbus nftables unattended-upgrades procps && \\
    rm -rf /var/lib/apt/lists/*
''')
        run('podman', 'build', '--layers', '-q', '-t', image, directory)
    run('podman', 'run', '-d', '--name', name + '-db', '--env', 'POSTGRES_PASSWORD=disposable-drill',
        'docker.io/postgis/postgis:17-3.5',
        stdout=subprocess.DEVNULL)
    for attempt in range(60):
        if subprocess.run(['podman', 'exec', name + '-db', 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('disposable_postgres_not_ready')
    # systemd is PID 1 so the unit sandboxes run for real. The container is privileged only inside its
    # rootless user namespace, and shares the disposable database container's network namespace.
    run('podman', 'run', '-d', '--name', name, '--network', 'container:' + name + '-db',
        '--systemd=always', '--privileged',
        '--env', 'PGHOST=127.0.0.1', '--env', 'PGUSER=postgres', '--env', 'PGPASSWORD=disposable-drill',
        image, '/sbin/init', stdout=subprocess.DEVNULL)
    for attempt in range(60):
        state = subprocess.run(['podman', 'exec', name, 'systemctl', 'is-system-running'],
                               capture_output=True, text=True).stdout.strip()
        if state in ('running', 'degraded'):
            break
        time.sleep(1)
    else:
        raise RuntimeError('drill_systemd_not_ready')
    # Copy only this checkout's deployment inputs, never local credentials or planning files.
    # A file copied in and unpacked inside, not `podman cp -`: piping the tar fails with "read/write on
    # closed pipe" for bundle sizes that land just past a 64 KiB multiple (podman 5.8.9).
    with tempfile.TemporaryDirectory() as staging:
        archive = Path(staging) / 'bundle.tar'
        with tarfile.open(archive, mode='w') as bundle:
            for relative in ['ops', 'containers/nginx.conf', 'server', 'src', 'data', 'scripts/requirements.txt', 'scripts/requirements-hashes.txt', 'tests/test_host_hardening.py',
                             'tests/test_production_ops.py', 'tests/test_findings_monitor.py', 'tests/fixtures',
                             'tests/migrations.test.ts', 'tests/helpers/test-database.ts',
                             'package.json', 'package-lock.json']:
                bundle.add(ROOT / relative, arcname=relative)
        run('podman', 'exec', name, 'mkdir', '-p', '/app')
        run('podman', 'cp', str(archive), f'{name}:/tmp/bundle.tar')
        run('podman', 'exec', name, 'tar', '-x', '--no-same-owner', '-C', '/app', '-f', '/tmp/bundle.tar')
    run('podman', 'exec', '--workdir', '/app', '--env', 'HOST_HARDENING_DRILL=1', name,
        'python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_host_hardening.py', '-v')
    if not args.host_only:
        run('podman', 'exec', '--workdir', '/app',
            '--env', 'TEST_DATABASE_URL=postgresql://postgres:disposable-drill@localhost/postgres',
            '--env', 'RUNTIME_DB_PASSWORD=disposable-runtime', name,
            'node', '--import', 'tsx', '--test', 'tests/migrations.test.ts')
        run('podman', 'exec', '--workdir', '/app', name,
            'python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_production_ops.py', '-v')
        run('podman', 'exec', '--workdir', '/app', name,
            'python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_findings_monitor.py', '-v')
    print('Host hardening passed. Backup and restore drill skipped: owner decision 2026-10-03.')
finally:
    # The tool container shares the database container's network namespace, so it must go first;
    # removing both in one call left the database container behind.
    for container in (name, name + '-db'):
        subprocess.run(['podman', 'rm', '-f', '--volumes', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['podman', 'rmi', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
