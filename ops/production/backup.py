"""Encrypted Report backups and empty-database recovery. Run with a private environment."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import parse_qs, unquote, urlsplit


def run(*args, **kwargs):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, **kwargs)


def expire():
    cutoff = datetime.now(timezone.utc) - timedelta(days=34)
    snapshots = json.loads(run('restic', 'snapshots', '--json'))
    expired = [row['id'] for row in snapshots
               if datetime.fromisoformat(row['time'].replace('Z', '+00:00')) <= cutoff]
    if expired:
        run('restic', 'forget', *expired)
    run('restic', 'forget', '--tag', 'bor-czuwa', '--keep-daily', '7', '--keep-weekly', '4')
    run('restic', 'prune', '--max-unused', '0')
    remaining = json.loads(run('restic', 'snapshots', '--json'))
    if any(datetime.fromisoformat(row['time'].replace('Z', '+00:00')) <= cutoff for row in remaining):
        raise RuntimeError('backup_expiration_failed')
    run('restic', 'check')


def database_environment():
    url = urlsplit(os.environ['MIGRATION_DATABASE_URL'])
    if url.scheme not in ('postgres', 'postgresql'):
        raise ValueError('maintenance_database_requires_postgresql_uri')
    values = {'host': url.hostname, 'port': url.port, 'user': url.username,
              'password': url.password, 'dbname': url.path.lstrip('/')}
    for name, value in parse_qs(url.query).items():
        if name not in values or len(value) != 1:
            raise ValueError('unsupported_database_uri_option')
        values[name] = value[0]
    names = {'host': 'PGHOST', 'port': 'PGPORT', 'user': 'PGUSER',
             'password': 'PGPASSWORD', 'dbname': 'PGDATABASE'}
    return {**os.environ, **{names[name]: unquote(str(value)) for name, value in values.items() if value}}


def backup():
    # Expire even when today's database dump fails. This repository belongs only to this app.
    expire()
    with tempfile.TemporaryDirectory(dir='/run/bor-czuwa-backup') as directory:
        root = Path(directory)
        env = database_environment()
        dump = root / 'report.dump'
        with dump.open('wb') as output:
            subprocess.run(['pg_dump', '-Fc', '--no-owner',
                            '--exclude-table-data=public.rate_counter',
                            '--exclude-table-data=geo_*.*',
                            '--exclude-table-data=public.osm_stand_extract',
                            *[f'--exclude-table-data=public.{name}' for name in
                              ('dwelling', 'obwod_lowiecki', 'protected_area', 'recipient_jurisdiction', 'ambona')]],
                           env=env, stdout=output, stderr=subprocess.DEVNULL, check=True)
        (root / 'release').write_text(Path('/opt/bor-czuwa/current/RELEASE').read_text())
        with subprocess.Popen(['tar', '-C', directory, '-cf', '-', 'report.dump', 'release'],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as archive:
            subprocess.run(['restic', 'backup', '--tag', 'bor-czuwa', '--stdin', '--stdin-filename', 'report.tar'],
                           stdin=archive.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            archive.stdout.close()
            if archive.wait() != 0:
                raise RuntimeError('backup_archive_failed')
    expire()
    state = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/bor-czuwa/backup') + '/backup-success')
    state.write_text(datetime.now(timezone.utc).isoformat() + '\n')


def restore(snapshot):
    env = database_environment()
    # Never clean or overwrite an existing database.
    present = run('psql', '-XAt', '-c', "SELECT to_regclass('public.schema_migrations') IS NOT NULL", env=env)
    if present.strip() != b'f':
        raise RuntimeError('restore_requires_empty_database')
    with tempfile.TemporaryDirectory(dir='/run/bor-czuwa-backup') as directory:
        root = Path(directory)
        with subprocess.Popen(['restic', 'dump', snapshot, '/report.tar'], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL) as archive:
            subprocess.run(['tar', '-C', directory, '-xf', '-'], stdin=archive.stdout,
                           stderr=subprocess.DEVNULL, check=True)
            archive.stdout.close()
            if archive.wait() != 0:
                raise RuntimeError('restore_archive_failed')
        subprocess.run(['pg_restore', '--exit-on-error', '--single-transaction', '--no-owner',
                        '--dbname=', str(root / 'report.dump')],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print('Restored database; matching release: ' + (root / 'release').read_text().strip())
        print('Rebuild matching geodata before enabling API. Runtime grants require npm run migrate.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['backup', 'expire', 'restore'])
    parser.add_argument('snapshot', nargs='?')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == 'restore':
            if not args.snapshot:
                parser.error('restore requires a snapshot id')
            restore(args.snapshot)
        elif args.command == 'backup':
            backup()
        else:
            expire()
    except Exception:
        raise SystemExit('Backup operation failed; inspect access and recovery state locally.') from None
