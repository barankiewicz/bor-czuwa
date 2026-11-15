"""Bootstrap only the isolated application on an already hardened Ubuntu 26.04 host."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pwd
import secrets
import shlex
import shutil
import subprocess

import startup_refusals
from deployment import DEMO_ETC, Refusal, demo_config


def run(*command, **kwargs):
    return subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)


def directory(path, mode=0o755, owner='root', group='root'):
    run('install', '-d', '-m', f'{mode:o}', '-o', owner, '-g', group, str(path))


def private_file(path, text):
    # O_EXCL never truncates an existing secret or follows a symlink.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path, help='Root-owned mode-0600 deployment JSON')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('root required')
    release = Path('/usr/local/lib/bor-czuwa-release')
    if Path(__file__).resolve() != release / 'bootstrap-demo.py':
        parser.error('run installed, independently reviewed release controls')
    lock = os.open('/run/lock/bor-czuwa-demo-deploy.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if os_release.get('ID') != 'ubuntu' or os_release.get('VERSION_ID', '').strip('"') != '26.04':
        raise Refusal('host_prerequisite_missing', 'requires the already provisioned Ubuntu 26.04 host')
    config = demo_config(args.config)
    cert = Path('/etc/letsencrypt/live') / config['certificateName']
    if not all((cert / file).is_file() for file in ['fullchain.pem', 'privkey.pem']):
        raise Refusal('certificate_missing', 'existing approved certificate required')
    required = ['node', 'npm', 'psql', 'nginx', 'openssl', 'gdal-config', 'ogr2ogr', 'osmium', 'ss']
    missing = [program for program in required if shutil.which(program) is None]
    if missing:
        raise Refusal('host_prerequisite_missing', 'missing provisioned application prerequisites: ' + ', '.join(missing))
    if subprocess.check_output(['node', '-p', 'process.versions.node.split(".")[0]'], text=True).strip() != '24':
        raise Refusal('host_prerequisite_missing', 'provisioned Node 24 required')
    if not DEMO_ETC.exists():
        directory(DEMO_ETC, 0o700)
    elif DEMO_ETC.is_symlink() or not DEMO_ETC.is_dir() or DEMO_ETC.stat().st_uid != 0:
        raise Refusal('unsafe_existing_state', 'unsafe existing demo configuration directory')
    destination = DEMO_ETC / 'deployment.json'
    if destination.exists():
        if demo_config(destination) != config:
            raise Refusal('unsafe_existing_state', 'existing deployment configuration differs; review and change it explicitly')
    else:
        private_file(destination, json.dumps(config, indent=2) + '\n')
    for account in ['bor-czuwa-demo', 'bor-czuwa-demo-maint', 'bor-czuwa-demo-build']:
        try:
            existing = pwd.getpwnam(account)
            if existing.pw_uid == 0 or existing.pw_shell != '/usr/sbin/nologin':
                raise Refusal('unsafe_existing_state', 'existing application account has unexpected privileges')
        except KeyError:
            run('useradd', '--system', '--home', '/nonexistent', '--shell', '/usr/sbin/nologin', account)
    directory('/opt/bor-czuwa-demo/releases')
    directory('/var/lib/bor-czuwa-demo')
    directory('/var/lib/bor-czuwa-demo/geodata-extracts', 0o750, 'bor-czuwa-demo-maint', 'www-data')
    directory('/var/lib/bor-czuwa-demo/geodata-tmp', 0o700, 'bor-czuwa-demo-maint', 'bor-czuwa-demo-maint')
    directory('/var/lib/bor-czuwa-demo/monitor', 0o700, 'bor-czuwa-demo-maint', 'bor-czuwa-demo-maint')
    # Create each secret once. An interrupted bootstrap can be repeated without rotation.
    password_path = DEMO_ETC / 'runtime-password'
    if not password_path.exists():
        private_file(password_path, secrets.token_hex(32) + '\n')
    password = password_path.read_text().strip()
    if len(password) != 64 or any(letter not in '0123456789abcdef' for letter in password):
        raise Refusal('unsafe_existing_state', 'invalid retained runtime password')
    runtime = 'postgresql://bor_czuwa_demo_runtime:' + password + '@127.0.0.1:5432/bor_czuwa_demo'
    owner = 'postgresql:///bor_czuwa_demo?host=/var/run/postgresql&user=bor_czuwa_demo_owner'
    environments = {'runtime.env': {'DATABASE_URL': runtime, 'RUNTIME_DB_ROLE': 'bor_czuwa_demo_runtime'},
                    'maintenance.env': {'MIGRATION_DATABASE_URL': owner, 'RUNTIME_DB_PASSWORD': password,
                                        'RUNTIME_DB_ROLE': 'bor_czuwa_demo_runtime'}}
    for name, values in environments.items():
        target = DEMO_ETC / name
        expected = ''.join(key + '=' + shlex.quote(value) + '\n' for key, value in values.items())
        if target.exists():
            if target.read_text() != expected:
                raise Refusal('unsafe_existing_state', 'existing environment differs; refusing to replace credentials')
        else:
            private_file(target, expected)
    access = DEMO_ETC / 'access-password'
    if not access.exists():
        private_file(access, secrets.token_urlsafe(32) + '\n')
    hashed = subprocess.check_output(['openssl', 'passwd', '-6', '-stdin'], input=access.read_bytes()).decode().strip()
    htpasswd = DEMO_ETC / 'access.htpasswd'
    if not htpasswd.exists():
        private_file(htpasswd, config.get('accessUser', 'owner') + ':' + hashed + '\n')
    # nginx workers need this one password hash, never deployment JSON or plaintext secrets.
    run('chown', 'root:www-data', str(htpasswd))
    htpasswd.chmod(0o640)
    run('chown', 'root:www-data', str(DEMO_ETC))
    DEMO_ETC.chmod(0o710)
    gate = DEMO_ETC / 'gate.json'
    if not gate.exists():
        private_file(gate, json.dumps({'cookieToken': secrets.token_hex(32), 'passwordFile': str(htpasswd)}) + '\n')
    # PostgreSQL is already provisioned. No cluster, provider, host firewall or SSH changes.
    sql = """DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='bor_czuwa_demo_owner') THEN CREATE ROLE bor_czuwa_demo_owner LOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='bor_czuwa_demo_runtime') THEN CREATE ROLE bor_czuwa_demo_runtime LOGIN; END IF;
      IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
                 JOIN pg_roles granted ON granted.oid=m.roleid
                 WHERE r.rolname='bor_czuwa_demo_runtime'
                    OR (r.rolname='bor_czuwa_demo_owner' AND granted.rolname<>'bor_czuwa_demo_runtime')) THEN
        RAISE EXCEPTION 'unexpected_demo_role_membership';
      END IF;
    END $$;
    ALTER ROLE bor_czuwa_demo_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    ALTER ROLE bor_czuwa_demo_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    GRANT bor_czuwa_demo_runtime TO bor_czuwa_demo_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    """
    run('runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', input=sql.encode())
    exists = subprocess.check_output(['runuser', '-u', 'postgres', '--', 'psql', '-XAt', '-c',
                                     "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='bor_czuwa_demo'"], text=True).strip()
    if not exists:
        run('runuser', '-u', 'postgres', '--', 'createdb', '--owner=bor_czuwa_demo_owner', 'bor_czuwa_demo')
    elif exists != 'bor_czuwa_demo_owner':
        raise Refusal('unsafe_existing_state', 'existing demo database has an unexpected owner; refusing takeover')
    run('runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'bor_czuwa_demo',
        input=("CREATE EXTENSION IF NOT EXISTS postgis; REVOKE ALL ON DATABASE bor_czuwa_demo FROM PUBLIC; "
               "GRANT CONNECT ON DATABASE bor_czuwa_demo TO bor_czuwa_demo_runtime; "
               "ALTER ROLE bor_czuwa_demo_runtime PASSWORD '" + password + "';").encode())
    hba = Path('/etc/postgresql/17/main/pg_hba.conf')
    ident = Path('/etc/postgresql/17/main/pg_ident.conf')
    hba_rules = ('local bor_czuwa_demo bor_czuwa_demo_owner peer map=bor_czuwa_demo_maintenance\n'
                 'local all bor_czuwa_demo_owner reject\n'
                 'host all bor_czuwa_demo_owner 0.0.0.0/0 reject\n'
                 'host all bor_czuwa_demo_owner ::/0 reject\n'
                 'host bor_czuwa_demo bor_czuwa_demo_runtime 127.0.0.1/32 scram-sha-256\n'
                 'local all bor_czuwa_demo_runtime reject\n'
                 'host all bor_czuwa_demo_runtime 0.0.0.0/0 reject\n'
                 'host all bor_czuwa_demo_runtime ::/0 reject\n')
    if not hba.read_text().startswith(hba_rules):
        hba.write_text(hba_rules + hba.read_text())
    mapping = 'bor_czuwa_demo_maintenance bor-czuwa-demo-maint bor_czuwa_demo_owner'
    current = ident.read_text().splitlines()
    if any(line.strip() and not line.lstrip().startswith('#') and line.split()[0] == 'bor_czuwa_demo_maintenance'
           and line.strip() != mapping for line in current):
        raise Refusal('unsafe_existing_state', 'unexpected existing demo maintenance peer mapping')
    if mapping not in current:
        ident.write_text(ident.read_text() + '\n' + mapping + '\n')
    run('systemctl', 'reload', 'postgresql')
    private_file(DEMO_ETC / 'dedicated-host', '') if not (DEMO_ETC / 'dedicated-host').exists() else None
    print('Demo application bootstrap complete. Secrets remain in root-only configuration. No application, mail or backup timer started.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # A fixed token only: no path, value or exception text can reach the terminal.
        token = getattr(error, 'token', 'file_access' if isinstance(error, OSError)
                        else 'config_invalid' if isinstance(error, ValueError)
                        else 'command_failed' if isinstance(error, subprocess.SubprocessError) else 'unclassified')
        try:
            startup_refusals.record_release('/var/lib/bor-czuwa-demo/refusals/startup-refusals', token)
        except Exception:
            pass
        raise SystemExit(f'Demo bootstrap failed: {token}.') from None
