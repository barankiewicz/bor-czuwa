"""Deployment checks inside the disposable production-drill container."""
import configparser
import json
import shutil
import tempfile
import os
import re
import socket
import time
import urllib.request
from pathlib import Path
import subprocess
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class HostHardening(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('HOST_HARDENING_DRILL') != '1' or os.geteuid() != 0:
            raise RuntimeError('Run through scripts/production-drill.py, never on an operator host')
        for user in ['bor-czuwa', 'bor-czuwa-maint', 'bor-czuwa-build', 'sshoperator', 'postgres']:
            if subprocess.run(['id', user], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                subprocess.run(['useradd', '--system', '--create-home', user], check=True)
        Path('/run/sshd').mkdir(exist_ok=True)
        Path('/home/sshoperator/.ssh').mkdir()
        Path('/home/sshoperator/.ssh/authorized_keys').write_text('fixture-key-presence\n')

    def test_activation_installs_without_root_or_lifecycle_scripts_and_disables_backups(self):
        base = Path('/opt/bor-czuwa')
        (base / 'releases').mkdir(parents=True)
        config = Path('/etc/bor-czuwa')
        config.mkdir()
        (config / 'dedicated-host').touch()
        for name in ['runtime', 'maintenance', 'monitor', 'digest']:
            path = config / f'{name}.env'
            path.write_text('MIGRATION_DATABASE_URL=disposable\nRUNTIME_DB_PASSWORD=secret-must-not-reach-install\n')
            path.chmod(0o600)
        Path('/etc/nginx').mkdir(exist_ok=True)
        observed = Path('/tmp/activation-observed')
        observed.mkdir(mode=0o777)
        observed.chmod(0o777)
        staging_root = base / 'staging.fixture'
        staging = staging_root / 'payload'
        staging.mkdir(parents=True)
        control = Path('/usr/local/lib/bor-czuwa-release')
        control.mkdir(parents=True)
        shutil.copy(ROOT / 'ops/production/activate.sh', control / 'activate.sh')
        # This host privilege drill already substitutes systemd/readiness/GDAL.
        # Candidate trust is exercised separately against the provider/signature seam.
        # The controls activate.sh sources or runs come from the reviewed checkout, as
        # install-release-control.sh installs them. Only the two candidate-trust seams
        # are substituted: the payload is already unpacked, and verification is a receipt.
        for name in ['environment.sh', 'deployment.py', 'startup_refusals.py', 'render-nginx.py', 'audit-nginx.py', 'nginx-reload-hook.sh']:
            shutil.copy(ROOT / 'ops/production' / name, control / name)
        shutil.copy(ROOT / 'containers/nginx.conf', control / 'nginx.template.conf')
        (control / 'units').mkdir()
        for unit in [*(ROOT / 'ops/production').glob('bor-czuwa-*.service'), *(ROOT / 'ops/production').glob('bor-czuwa-*.timer'),
                     *(ROOT / 'ops').glob('geodata-refresh.*'), *(ROOT / 'ops').glob('integrity-digest.*')]:
            shutil.copy(unit, control / 'units' / unit.name)
        (control / 'unpack-candidate.py').write_text('# Payload fixture is already unpacked.\n')
        (control / 'release-candidate.mjs').write_text(
            'console.log(JSON.stringify({sourceCommit: "' + 'a' * 40 + '"}));\n')
        # deployment.py reads the candidate manifest from the staging directory.
        with zipfile.ZipFile(staging_root / 'verification.zip', 'w') as archive:
            archive.writestr('candidate.json', json.dumps({'releaseCandidate': {
                'mode': 'production',
                'configuration': {'mode': 'production', 'androidApiOrigin': 'https://app.example'}}}))
        for directory in ['/run/lock', '/etc/systemd/system', '/etc/letsencrypt/renewal-hooks/deploy']:
            Path(directory).mkdir(parents=True, exist_ok=True)
        Path('/etc/nginx/nginx.conf').write_text('# fixture: no proxy yet\n')
        shutil.copytree(ROOT / 'ops', staging / 'ops')
        shutil.copytree(ROOT / 'containers', staging / 'containers')
        (staging / 'scripts').mkdir()
        (staging / 'scripts/requirements.txt').write_text('')
        (staging / 'scripts/requirements-hashes.txt').write_text('')
        (staging / 'build').mkdir()
        (staging / 'package.json').write_text(json.dumps({
            'name': 'deployment-fixture', 'version': '1.0.0',
            'scripts': {'postinstall': 'touch /tmp/lifecycle-ran',
                        'migrate': 'id -u > /tmp/activation-observed/migration-uid'}
        }))
        subprocess.run(['npm', 'install', '--package-lock-only', '--ignore-scripts'], cwd=staging,
                       stdout=subprocess.DEVNULL, check=True)
        with tempfile.TemporaryDirectory() as directory:
            wrappers = Path(directory)
            wrappers.chmod(0o755)
            commands = {
                # Nothing is active, so activate.sh also reaches its listener check with ss.
                'systemctl': 'echo "$*" >> /tmp/activation-observed/systemctl\n[ "$1" != is-active ]\n',
                'gdal-config': 'echo 3.2.2\n',
                'curl': 'exit 0\n',
                'psql': 'echo t\n',
                'npm': 'test ! -w ops/production/activate.sh || exit 17\nif [ "$1" = ci ]; then id -u > /tmp/activation-observed/npm-uid; '
                       'env > /tmp/activation-observed/install-env; fi\nexec /usr/local/bin/npm "$@"\n',
                'python3': 'if [ "$1" = -m ]; then\n'
                           'mkdir -p .venv/bin\n'
                           "printf '#!/bin/sh\\nid -u > /tmp/activation-observed/pip-uid\\n' > .venv/bin/pip\n"
                           "printf '#!/bin/sh\\nexit 0\\n' > .venv/bin/python\n"
                           'chmod +x .venv/bin/pip .venv/bin/python\n'
                           'else case "$1" in */audit-nginx.py) ;; *) exec /usr/bin/python3 "$@" ;; esac; fi\n'
            }
            for name, body in commands.items():
                path = wrappers / name
                path.write_text('#!/bin/sh\n' + body)
                path.chmod(0o755)
            env = {**os.environ, 'PATH': directory + ':' + os.environ['PATH']}
            release = 'a' * 40
            subprocess.run(['bash', str(staging / 'ops/production/activate.sh'), 'app.example', release,
                            str(staging_root)], env=env, check=True)
            for name, user in [('npm', 'bor-czuwa-build'), ('pip', 'bor-czuwa-build'), ('migration', 'bor-czuwa-maint')]:
                uid = subprocess.check_output(['id', '-u', user], text=True).strip()
                self.assertNotEqual(uid, '0')
                self.assertEqual((observed / f'{name}-uid').read_text().strip(), uid)
            self.assertNotIn('secret-must-not-reach-install', (observed / 'install-env').read_text())
            self.assertFalse(Path('/tmp/lifecycle-ran').exists())
            calls = (observed / 'systemctl').read_text().splitlines()
            self.assertIn('disable --now bor-czuwa-backup.timer', calls)
            self.assertFalse(any('bor-czuwa-backup' in call for call in calls if call.startswith(('start ', 'enable '))))
            # activate.sh ran to its end: the release is current and the proxy was rendered for the domain.
            self.assertEqual((base / 'current').resolve(), base / 'releases' / release / 'payload')
            self.assertIn('server_name app.example;', Path('/etc/nginx/nginx.conf').read_text())
            self.assertIn('enable --now bor-czuwa-api.service', calls)
            self.assertEqual((base / 'releases' / release / 'payload/package.json').stat().st_uid, 0)
            self.assertFalse((base / 'releases' / release / 'payload/package.json').stat().st_mode & 0o022)

    def test_maintenance_config_passes_the_audit_over_a_live_config_from_the_old_template(self):
        """A host activated before the hardening has the old render live; closing it must still work."""
        control = Path('/usr/local/lib/bor-czuwa-release')
        control.mkdir(parents=True, exist_ok=True)
        for name in ['environment.sh', 'deployment.py', 'startup_refusals.py', 'render-nginx.py', 'audit-nginx.py']:
            shutil.copy(ROOT / 'ops/production' / name, control / name)
        shutil.copy(ROOT / 'containers/nginx.conf', control / 'nginx.template.conf')
        live = Path('/etc/nginx/nginx.conf')
        live.parent.mkdir(exist_ok=True)
        old = (ROOT / 'tests/fixtures/nginx-render-before-hardening.conf').read_text()
        live.write_text(old)
        with tempfile.TemporaryDirectory() as directory:
            stubs = Path(directory)
            (stubs / 'nginx').write_text('#!/bin/sh\n[ "$1" = -T ] && { cat /etc/nginx/nginx.conf; '
                                         'echo \'add_header Permissions-Policy "camera=(self), geolocation=(self)" always;\'; }\nexit 0\n')
            (stubs / 'systemctl').write_text('#!/bin/sh\necho "$*" >> /tmp/maintenance-systemctl\n')
            for stub in ['nginx', 'systemctl']:
                (stubs / stub).chmod(0o755)
            script = ('set -euo pipefail\ncontrol=/usr/local/lib/bor-czuwa-release\nenvironment=production\ndomain=app.example\n'
                      'source "$control/environment.sh"\npublish_proxy maintenance\n')
            result = subprocess.run(['bash', '-c', script], capture_output=True, text=True,
                                    env={**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}'})
            self.assertEqual(result.returncode, 0, result.stderr)
        closed = live.read_text()
        self.assertIn('return 503;', closed)
        self.assertIn('http2 on;', closed)
        self.assertIn('Strict-Transport-Security', closed)

    def test_owner_migrates_without_superuser_and_runtime_cannot_become_owner(self):
        subprocess.run(['bash', 'ops/production/bootstrap-database.sh'], cwd=ROOT, check=True)
        subprocess.run(['bash', 'ops/production/bootstrap-database.sh'], cwd=ROOT, check=True)
        def sql(query):
            return subprocess.check_output(['runuser', '-u', 'postgres', '--', 'psql', '-XAt',
                                            '-v', 'ON_ERROR_STOP=1', '-d', 'bor_czuwa', '-c', query], text=True).strip()
        self.assertEqual(sql("SELECT rolsuper FROM pg_roles WHERE rolname='bor_czuwa_owner'"), 'f')
        self.assertEqual(sql("SELECT extowner::regrole FROM pg_extension WHERE extname='postgis'"), 'postgres')
        sql("ALTER ROLE bor_czuwa_owner PASSWORD 'disposable-owner'")
        subprocess.run(['chown', '-R', 'bor-czuwa-build:bor-czuwa-build', str(ROOT)], check=True)
        subprocess.run(['runuser', '-u', 'bor-czuwa-build', '--', 'npm', 'ci', '--ignore-scripts'], cwd=ROOT,
                       check=True, stdout=subprocess.DEVNULL)
        env = {**os.environ, 'MIGRATION_DATABASE_URL': 'postgresql://bor_czuwa_owner:disposable-owner@localhost/bor_czuwa',
               'RUNTIME_DB_PASSWORD': 'disposable-runtime'}
        subprocess.run(['runuser', '-u', 'bor-czuwa-maint', '--', 'npm', 'run', 'migrate'], cwd=ROOT, env=env, check=True)
        self.assertEqual(sql('SELECT count(*) FROM schema_migrations'), '15')
        sql('ALTER ROLE app_runtime CREATEDB')
        rejected = subprocess.run(['runuser', '-u', 'bor-czuwa-maint', '--', 'npm', 'run', 'migrate'],
                                  cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('runtime_role_requires_provisioning', rejected.stderr)
        subprocess.run(['bash', 'ops/production/bootstrap-database.sh'], cwd=ROOT, check=True)

        result = subprocess.run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d',
                                 'postgresql://app_runtime:disposable-runtime@localhost/bor_czuwa',
                                 '-c', 'SET ROLE bor_czuwa_owner'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_ssh_effective_policy_overrides_vendor_defaults_and_detects_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            systemctl = Path(directory) / 'systemctl'
            systemctl.write_text('#!/bin/sh\nexit 0\n')
            systemctl.chmod(0o755)
            env = {**os.environ, 'PATH': directory + ':' + os.environ['PATH'],
                   'SSH_USER': 'sshoperator', 'SSH_PORT': '2222'}
            config = Path('/etc/ssh/sshd_config')
            config.write_text('Include /etc/ssh/sshd_config.d/*.conf\n'
                              'PasswordAuthentication yes\nKbdInteractiveAuthentication yes\nPermitRootLogin yes\n')
            vendor = Path('/etc/ssh/sshd_config.d/50-vendor.conf')
            vendor.write_text('X11Forwarding no\n')
            subprocess.run(['bash', 'ops/production/harden-ssh.sh'], cwd=ROOT, env=env, check=True)
            subprocess.run(['bash', 'ops/production/harden-ssh.sh'], cwd=ROOT, env=env, check=True)
            self.assertEqual(vendor.read_text(), 'X11Forwarding no\n')
            config.write_text('PasswordAuthentication yes\n' + config.read_text())
            result = subprocess.run(['python3', 'ops/production/check-ssh.py', 'sshoperator', '2222'],
                                    cwd=ROOT, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_ssh_check_rejects_remote_conditional_overrides_in_included_files(self):
        config = Path('/etc/ssh/sshd_config')
        config.write_text('Port 2222\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n'
                          'PermitRootLogin no\nPubkeyAuthentication yes\nAllowUsers sshoperator\n'
                          'Include=/etc/ssh/remote-policy\n')
        policy = Path('/etc/ssh/remote-policy')
        for match in ['Address 203.0.113.0/24', 'Address 198.51.100.0/24',
                      'Host public.example', 'User intruder']:
            with self.subTest(match=match):
                policy.write_text(f'Match {match}\n PasswordAuthentication yes\n AllowUsers intruder\n')
                subprocess.run(['/usr/sbin/sshd', '-t'], check=True)
                result = subprocess.run(['python3', 'ops/production/check-ssh.py', 'sshoperator', '2222'],
                                        cwd=ROOT, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
        policy.unlink()

    def run_harden_host(self, port='2222'):
        """Run harden-host.sh with something listening on the port, as it must be on a real host."""
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('0.0.0.0', int(port)))
        listener.listen()
        self.addCleanup(listener.close)
        subprocess.run(['bash', 'ops/production/harden-host.sh'], cwd=ROOT, check=True,
                       env={**os.environ, 'SSH_PORT': port, 'HARDEN_APPLY': '0'})

    @staticmethod
    def firewall_problems(ruleset, ssh_port):
        """Name everything in the managed nftables table that the host policy does not allow."""
        problems = []
        if 'flush ruleset' in ruleset:
            problems.append('flushes foreign rules')
        if 'chain forward' in ruleset:
            problems.append('touches forwarding')
        chain = re.search(r'table inet bor_czuwa \{\s*chain input \{(.*?)\n  \}\n\}', ruleset, re.S)
        if not chain or 'policy drop;' not in chain.group(1):
            return problems + ['input policy is not drop']
        accepted = [line.strip() for line in chain.group(1).splitlines() if line.strip().endswith('accept')]
        for line in accepted:
            if line not in ('iif lo accept', 'ct state established,related accept', 'ip protocol icmp accept',
                            'ip6 nexthdr ipv6-icmp accept', 'udp sport 67 udp dport 68 accept',
                            'udp sport 547 udp dport 546 accept', f'tcp dport {{ {ssh_port}, 80, 443 }} accept'):
                problems.append('unexpected accept: ' + line)
        for line in ['iif lo accept', 'ct state established,related accept', 'udp sport 67 udp dport 68 accept',
                     'udp sport 547 udp dport 546 accept', f'tcp dport {{ {ssh_port}, 80, 443 }} accept']:
            if line not in accepted:
                problems.append('missing: ' + line)
        return problems

    def test_firewall_admits_only_ssh_http_https_in_its_own_persisted_table(self):
        self.run_harden_host('2222')
        path = Path('/etc/nftables.d/bor-czuwa.nft')
        rules = path.read_text()
        subprocess.run(['nft', '-c', '-f', str(path)], check=True)
        self.assertEqual(self.firewall_problems(rules, '2222'), [])
        self.assertIn('include "/etc/nftables.d/bor-czuwa.nft"', Path('/etc/nftables.conf').read_text())
        # The check itself must be able to fail: an open database port, a missing drop policy, a flush.
        self.assertTrue(self.firewall_problems(rules.replace('{ 2222, 80, 443 }', '{ 2222, 80, 443, 5432 }'), '2222'))
        self.assertTrue(self.firewall_problems(rules.replace('policy drop;', 'policy accept;', 1), '2222'))
        self.assertTrue(self.firewall_problems('flush ruleset\n' + rules, '2222'))
        # A host that takes its address by DHCP loses it when the lease ends without these.
        self.assertTrue(self.firewall_problems(rules.replace('    udp sport 67 udp dport 68 accept\n', ''), '2222'))
        self.assertTrue(self.firewall_problems(rules.replace('    udp sport 547 udp dport 546 accept\n', ''), '2222'))
        # Nothing listening on the port (here 2200) would lock the operator out, so the script refuses.
        refused = subprocess.run(['bash', 'ops/production/harden-host.sh'], cwd=ROOT, capture_output=True,
                                 env={**os.environ, 'SSH_PORT': '2200', 'HARDEN_APPLY': '0'})
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(path.read_text(), rules)

    def test_firewall_leaves_other_tables_alone_and_can_be_backed_out(self):
        self.run_harden_host('2222')
        path = '/etc/nftables.d/bor-czuwa.nft'
        subprocess.run(['nft', 'add', 'table', 'inet', 'foreign_rules'], check=True)
        try:
            for attempt in range(2):  # the second load replaces our table, never someone else's
                subprocess.run(['nft', '-f', path], check=True)
                tables = subprocess.check_output(['nft', 'list', 'tables'], text=True)
                self.assertIn('table inet bor_czuwa', tables)
                self.assertIn('table inet foreign_rules', tables)
            # The runbook's recovery line from a kept session.
            subprocess.run(['nft', 'delete', 'table', 'inet', 'bor_czuwa'], check=True)
            tables = subprocess.check_output(['nft', 'list', 'tables'], text=True)
            self.assertNotIn('bor_czuwa', tables)
            self.assertIn('foreign_rules', tables)
        finally:
            subprocess.run(['nft', 'delete', 'table', 'inet', 'foreign_rules'], capture_output=True)
            subprocess.run(['nft', 'delete', 'table', 'inet', 'bor_czuwa'], capture_output=True)

    def test_firewall_is_loaded_before_sysctls_whatever_they_do(self):
        script = (ROOT / 'ops/production/harden-host.sh').read_text()
        self.assertLess(script.index('nft -f /etc/nftables.d/bor-czuwa.nft'), script.index('sysctl -e -p'))
        self.assertNotIn('sysctl --system', script)
        # A real apply: the kernel here may refuse some sysctl writes, and the firewall must still be in.
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'systemctl').write_text('#!/bin/sh\nexit 0\n')
            Path(directory, 'systemctl').chmod(0o755)
            listener = socket.socket()
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('0.0.0.0', 2222))
            listener.listen()
            self.addCleanup(listener.close)
            result = subprocess.run(['bash', 'ops/production/harden-host.sh'], cwd=ROOT, capture_output=True, text=True,
                                    env={**os.environ, 'PATH': directory + ':' + os.environ['PATH'], 'SSH_PORT': '2222'})
        try:
            self.assertIn('table inet bor_czuwa', subprocess.check_output(['nft', 'list', 'tables'], text=True))
            if result.returncode:
                self.assertIn('sysctl file failed', result.stderr)
        finally:
            subprocess.run(['nft', 'delete', 'table', 'inet', 'bor_czuwa'], capture_output=True)

    def test_sysctls_close_the_server_network_stack_and_name_real_kernel_keys(self):
        self.run_harden_host()
        settings = dict(line.split(' = ') for line in Path('/etc/sysctl.d/91-bor-czuwa-hardening.conf')
                        .read_text().splitlines() if line and not line.startswith('#'))
        expected = {'net.ipv4.conf.all.rp_filter': '1', 'net.ipv4.conf.default.rp_filter': '1',
                    'net.ipv4.conf.all.accept_redirects': '0', 'net.ipv6.conf.all.accept_redirects': '0',
                    'net.ipv4.conf.all.send_redirects': '0', 'net.ipv4.conf.all.accept_source_route': '0',
                    'net.ipv6.conf.all.accept_source_route': '0', 'net.ipv4.tcp_syncookies': '1',
                    'kernel.dmesg_restrict': '1', 'kernel.kptr_restrict': '2', 'net.ipv4.conf.all.log_martians': '0'}
        for key, value in expected.items():
            self.assertEqual(settings.get(key), value, key)
        for key in settings:
            self.assertTrue(Path('/proc/sys', *key.split('.')).exists(), key + ' is not a kernel setting')

    @staticmethod
    def update_origins():
        dump = subprocess.check_output(['apt-config', 'dump'], text=True)
        return dump, re.findall(r'Unattended-Upgrade::Origins-Pattern:: "([^"]+)"', dump)

    def test_unattended_upgrades_take_security_updates_only_and_never_reboot(self):
        self.run_harden_host()
        dump, origins = self.update_origins()
        self.assertIn('APT::Periodic::Unattended-Upgrade "1";', dump)
        self.assertIn('Unattended-Upgrade::Automatic-Reboot "false";', dump)
        # apt list options accumulate across files: the whole effective list, stock entries included,
        # must be exactly ours.
        self.assertEqual(origins, ['origin=Debian,codename=${distro_codename}-security,label=Debian-Security',
                                   'origin=Node Source,codename=nodistro'])
        # Without the #clear line the stock 50unattended-upgrades entries (plain Debian updates) survive.
        managed = Path('/etc/apt/apt.conf.d/52bor-czuwa-upgrades')
        original = managed.read_text()
        try:
            managed.write_text(original.replace('#clear Unattended-Upgrade::Origins-Pattern;\n', ''))
            self.assertIn('origin=Debian,codename=${distro_codename},label=Debian', self.update_origins()[1])
        finally:
            managed.write_text(original)
        self.assertEqual(len(self.update_origins()[1]), 2)

    @staticmethod
    def open_database_rules(hba):
        """The one-line check the runbook gives for pg_hba: any host rule that is not loopback and not a reject."""
        return subprocess.run(['awk', '$1 !~ /^#/ && NF && ($1 ~ /^host/) && $4 !~ /^(127\\.0\\.0\\.1\\/32|::1\\/128)$/ '
                               '&& $NF != "reject"', '-'], input=hba, capture_output=True, text=True).stdout

    def test_pg_hba_admits_only_local_paths(self):
        hba = (ROOT / 'ops/production/pg_hba.conf').read_text()
        self.assertEqual(self.open_database_rules(hba), '')
        rules = [line.split() for line in hba.splitlines() if line.strip() and not line.startswith('#')]
        self.assertEqual([(rule[0], rule[1], rule[2]) for rule in rules],
                         [('local', 'all', 'postgres'), ('local', 'bor_czuwa', 'bor_czuwa_owner'),
                          ('host', 'bor_czuwa', 'app_runtime'), ('host', 'bor_czuwa', 'app_runtime')])
        # Debian's stock file ends with remote-capable rules and the check must see them.
        self.assertNotEqual(self.open_database_rules(hba + 'host all all 0.0.0.0/0 scram-sha-256\n'), '')
        self.assertNotEqual(self.open_database_rules(hba + 'host all all ::/0 md5\n'), '')
        self.assertEqual(self.open_database_rules(hba + 'host all all 0.0.0.0/0 reject\n'), '')
        self.assertIn('install -m 0640 -o postgres -g postgres "$(dirname "$0")/pg_hba.conf"',
                      (ROOT / 'ops/production/provision.sh').read_text())
        self.assertIn("listen_addresses = '127.0.0.1'", (ROOT / 'ops/production/provision.sh').read_text())

    def test_scheduled_maintenance_runs_without_root(self):
        for name in ['ops/geodata-refresh.service', 'ops/integrity-digest.service',
                     'ops/production/bor-czuwa-monitor.service', 'ops/production/bor-czuwa-backup.service']:
            with self.subTest(unit=name):
                unit = configparser.ConfigParser(interpolation=None, strict=False)
                unit.read(ROOT / name)
                user = unit['Service'].get('User', 'root')
                uid = subprocess.check_output(['runuser', '-u', user, '--', 'id', '-u'], text=True).strip()
                self.assertNotEqual(uid, '0')


class SystemdSandbox(unittest.TestCase):
    """Install the repository's own units into the drill's systemd and run each one for real."""
    OWNER_URL = 'postgresql://bor_czuwa_owner:disposable-owner@127.0.0.1:5432/bor_czuwa'
    RUNTIME_URL = 'postgresql://app_runtime:disposable-runtime@127.0.0.1:5432/bor_czuwa'
    UNITS = {'bor-czuwa-api.service': ROOT / 'ops/production', 'bor-czuwa-monitor.service': ROOT / 'ops/production',
             'bor-czuwa-backup.service': ROOT / 'ops/production', 'geodata-refresh.service': ROOT / 'ops',
             'integrity-digest.service': ROOT / 'ops', 'bor-czuwa-stats.service': ROOT / 'ops/production'}
    # systemd-analyze security exposure (0 safe, 10 exposed) allowed; the unhardened files scored 8.3 to 9.0.
    CEILING = {name: 2.0 for name in UNITS}

    @classmethod
    def setUpClass(cls):
        if os.environ.get('HOST_HARDENING_DRILL') != '1' or os.geteuid() != 0:
            raise RuntimeError('Run through scripts/production-drill.py, never on an operator host')
        if not Path('/run/systemd/system').is_dir():
            raise RuntimeError('The drill must boot systemd to exercise unit sandboxes')
        for user in ['bor-czuwa', 'bor-czuwa-maint', 'bor-czuwa-build', 'bor-czuwa-stats']:
            if subprocess.run(['id', user], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                subprocess.run(['useradd', '--system', '--create-home', user], check=True)
        # The units name the NodeSource paths; this image keeps node under /usr/local.
        for program in ['node', 'npm']:
            if not Path('/usr/bin', program).exists():
                Path('/usr/bin', program).symlink_to(Path('/usr/local/bin', program))
        cls.prepare_database()
        cls.seed_geodata()
        base, config = Path('/opt/bor-czuwa'), Path('/etc/bor-czuwa')
        base.mkdir(parents=True, exist_ok=True)
        config.mkdir(exist_ok=True)
        current = base / 'current'
        if current.is_symlink() or current.exists():
            current.unlink() if current.is_symlink() else shutil.rmtree(current)
        current.symlink_to(ROOT)
        (ROOT / 'RELEASE').write_text('a' * 40 + '\n')
        for path, owner, group, mode in [('/var/lib/bor-czuwa', 'root', 'root', 0o755),
                                         ('/var/lib/bor-czuwa/monitor', 'bor-czuwa-maint', 'bor-czuwa-maint', 0o700),
                                         ('/var/lib/bor-czuwa/backup', 'bor-czuwa-maint', 'bor-czuwa-maint', 0o700),
                                         ('/var/lib/bor-czuwa/geodata-extracts', 'bor-czuwa-maint', 'www-data', 0o750)]:
            Path(path).mkdir(parents=True, exist_ok=True)
            shutil.chown(path, owner, group)
            Path(path).chmod(mode)
        smtp = 'SMTP_HOST=\nSMTP_PORT=\nSMTP_USER=\nSMTP_PASSWORD=\n'
        cls.private('runtime.env', f'DATABASE_URL={cls.RUNTIME_URL}\n')
        cls.private('monitor.env', f'DATABASE_URL={cls.RUNTIME_URL}\nALERT_FROM=a@example.invalid\nALERT_TO=b@example.invalid\n' + smtp)
        cls.private('digest.env', f'DATABASE_URL={cls.RUNTIME_URL}\nDIGEST_FROM=a@example.invalid\nDIGEST_TO=b@example.invalid\n' + smtp)
        cls.private('restic-password', 'disposable-restic\n', owner='bor-czuwa-maint')
        cls.private('maintenance.env', f'MIGRATION_DATABASE_URL={cls.OWNER_URL}\nRESTIC_REPOSITORY=/var/lib/bor-czuwa/backup/repo\n'
                    'RESTIC_PASSWORD_FILE=/etc/bor-czuwa/restic-password\n')
        subprocess.run(['runuser', '-u', 'bor-czuwa-maint', '--', 'env', 'RESTIC_PASSWORD_FILE=/etc/bor-czuwa/restic-password',
                        'restic', 'init', '--repo', '/var/lib/bor-czuwa/backup/repo'], check=True, capture_output=True)

    @classmethod
    def private(cls, name, text, owner='root'):
        path = Path('/etc/bor-czuwa') / name
        path.write_text(text)
        shutil.chown(path, owner, 'root' if owner == 'root' else owner)
        path.chmod(0o600)

    @classmethod
    def prepare_database(cls):
        def sql(query):
            return subprocess.check_output(['runuser', '-u', 'postgres', '--', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
                                            '-d', 'bor_czuwa', '-c', query], text=True).strip()
        subprocess.run(['bash', 'ops/production/bootstrap-database.sh'], cwd=ROOT, check=True)
        sql("ALTER ROLE bor_czuwa_owner PASSWORD 'disposable-owner'")
        if sql("SELECT to_regclass('public.schema_migrations') IS NOT NULL") == 't':
            return
        subprocess.run(['chown', '-R', 'bor-czuwa-build:bor-czuwa-build', str(ROOT)], check=True)
        subprocess.run(['runuser', '-u', 'bor-czuwa-build', '--', 'npm', 'ci', '--ignore-scripts'], cwd=ROOT,
                       check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['runuser', '-u', 'bor-czuwa-maint', '--', 'npm', 'run', 'migrate'], cwd=ROOT, check=True,
                       env={**os.environ, 'MIGRATION_DATABASE_URL': cls.OWNER_URL, 'RUNTIME_DB_PASSWORD': 'disposable-runtime'})

    @classmethod
    def seed_geodata(cls):
        # The API refuses to start, and /api/ready answers 503, without current geodata. The drill has no
        # national data, so it records the smallest geodata the start check accepts.
        schema = 'geo_aaaaaaaaaaaaaaaaaaaa'
        statements = [f'CREATE SCHEMA IF NOT EXISTS {schema}']
        geom = 'geom geometry(MultiPolygon, 2180)'
        polygon = "ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 2180))"
        statements += [
            f'CREATE TABLE IF NOT EXISTS {schema}.dwelling ({geom})', f'CREATE TABLE IF NOT EXISTS {schema}.obwod_lowiecki (objectid integer, number text, source_year integer, {geom})',
            f'CREATE TABLE IF NOT EXISTS {schema}.recipient_jurisdiction (id integer)',
            f'CREATE TABLE IF NOT EXISTS {schema}.ambona (osm_id text, geom geometry(Point, 2180))',
            f'CREATE TABLE IF NOT EXISTS {schema}.protected_area (kind text, inspire_id text, name text, parent_kind text, '
            f'document_state text, documents jsonb, {geom})']
        statements += [
            f'INSERT INTO {schema}.dwelling SELECT {polygon} WHERE NOT EXISTS (SELECT 1 FROM {schema}.dwelling)',
            # The backup unit dumps as the owner role, which must be able to read what the drill seeds.
            f'ALTER SCHEMA {schema} OWNER TO bor_czuwa_owner',
            *[f'ALTER TABLE {schema}.{table} OWNER TO bor_czuwa_owner'
              for table in ['dwelling', 'obwod_lowiecki', 'protected_area', 'recipient_jurisdiction', 'ambona']],
            f'GRANT USAGE ON SCHEMA {schema} TO app_runtime',
            f'GRANT SELECT ON ALL TABLES IN SCHEMA {schema} TO app_runtime',
            "INSERT INTO geodata_snapshot (id, datasets, coverage, storage_schema) SELECT 'drill', '{}', "
            "ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 2180)), "
            f"'{schema}' WHERE NOT EXISTS (SELECT 1 FROM geodata_snapshot WHERE id = 'drill')",
            "INSERT INTO current_geodata (snapshot_id) SELECT 'drill' WHERE NOT EXISTS (SELECT 1 FROM current_geodata)",
            "INSERT INTO recipient_dataset (snapshot_id, sources) SELECT 'drill', '{}' WHERE NOT EXISTS (SELECT 1 FROM recipient_dataset)",
            "INSERT INTO recipient_jurisdiction (snapshot_id, kind, unit_id, name, geom) SELECT 'drill', 'gmina', 'g1', 'x', "
            f"{polygon} WHERE NOT EXISTS (SELECT 1 FROM recipient_jurisdiction)"]
        subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', 'bor_czuwa',
                        '-c', '; '.join(statements)], check=True, capture_output=True)

    def install(self, name, dropin=None):
        shutil.copy(self.UNITS[name] / name, Path('/etc/systemd/system') / name)
        directory = Path('/etc/systemd/system') / (name + '.d')
        shutil.rmtree(directory, ignore_errors=True)
        if dropin:
            directory.mkdir()
            (directory / 'probe.conf').write_text('[Service]\n' + dropin)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)

    def show(self, name, *properties):
        out = subprocess.check_output(['systemctl', 'show', name, *[f'--property={value}' for value in properties]], text=True)
        return dict(line.split('=', 1) for line in out.splitlines())

    def run_oneshot(self, name):
        subprocess.run(['systemctl', 'reset-failed', name], capture_output=True)
        result = subprocess.run(['systemctl', 'start', name], capture_output=True, text=True)
        return result.returncode, self.show(name, 'Result', 'ExecMainStatus', 'ExecMainCode')

    def test_every_unit_is_sandboxed_and_scores_well(self):
        for name in self.UNITS:
            with self.subTest(unit=name):
                self.install(name)
                report = subprocess.run(['systemd-analyze', 'security', '--no-pager', name], capture_output=True, text=True).stdout
                score = float(re.search(r'exposure level for \S+: ([\d.]+)', report).group(1))
                print(f'EXPOSURE {name} {score}')
                self.assertLessEqual(score, self.CEILING[name], report)
                text = (self.UNITS[name] / name).read_text()
                for directive in ['CapabilityBoundingSet=', 'PrivateDevices=true', 'ProtectKernelTunables=true',
                                  'ProtectKernelModules=true', 'ProtectKernelLogs=true', 'ProtectControlGroups=true',
                                  'ProtectClock=true', 'ProtectHostname=true', 'RestrictNamespaces=true',
                                  'RestrictRealtime=true', 'RestrictSUIDSGID=true', 'LockPersonality=true',
                                  'RestrictAddressFamilies=AF_INET', 'SystemCallFilter=@system-service',
                                  'ProtectSystem=strict', 'NoNewPrivileges=true']:
                    self.assertIn(directive, text, f'{name} lacks {directive}')

    def test_api_serves_requests_inside_its_sandbox(self):
        # Output goes to the journal here only so a failure can be read.
        self.install('bor-czuwa-api.service', 'StandardOutput=journal\nStandardError=journal\n')
        started = subprocess.run(['systemctl', 'start', 'bor-czuwa-api.service'], capture_output=True, text=True)
        if started.returncode:
            self.fail(started.stderr + subprocess.run(['journalctl', '-u', 'bor-czuwa-api.service', '--no-pager', '-n', '30'],
                                                      capture_output=True, text=True).stdout)
        try:
            for attempt in range(40):
                try:
                    with urllib.request.urlopen('http://127.0.0.1:3001/api/ready', timeout=2) as response:
                        self.assertEqual(json.load(response), {'status': 'ready'})
                    break
                except OSError:
                    time.sleep(0.5)
            else:
                self.fail('API never became ready')
            with urllib.request.urlopen('http://127.0.0.1:3001/api/challenge', timeout=5) as response:
                self.assertEqual(response.status, 200)
            pid = self.show('bor-czuwa-api.service', 'MainPID')['MainPID']
            status = dict(line.split(':\t', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':\t' in line)
            self.assertEqual(status['CapEff'], '0000000000000000')
            self.assertEqual(status['CapBnd'], '0000000000000000')
            self.assertEqual(status['NoNewPrivs'], '1')
            self.assertEqual(status['Seccomp'], '2')
            self.assertNotEqual(status['Uid'].split()[0], '0')
            # The monitor runs beside it, reads its health routes and writes only its own state file.
            self.install('bor-czuwa-monitor.service')
            code, state = self.run_oneshot('bor-czuwa-monitor.service')
            self.assertEqual((code, state['Result']), (0, 'success'))
            self.assertTrue(Path('/var/lib/bor-czuwa/monitor/monitor-state').is_file())
        finally:
            subprocess.run(['systemctl', 'stop', 'bor-czuwa-api.service'], capture_output=True)

    def test_demo_monitor_unit_writes_its_state_under_the_demo_names(self):
        # The demo host runs the same unit files under bor-czuwa-demo-* names (deployment.py rewrites them).
        for user in ['bor-czuwa-demo', 'bor-czuwa-demo-maint']:
            if subprocess.run(['id', user], capture_output=True).returncode:
                subprocess.run(['useradd', '--system', '--create-home', user], check=True)
        Path('/etc/bor-czuwa-demo').mkdir(exist_ok=True)
        shutil.copy('/etc/bor-czuwa/monitor.env', '/etc/bor-czuwa-demo/monitor.env')
        demo = Path('/opt/bor-czuwa-demo')
        demo.mkdir(exist_ok=True)
        if not (demo / 'current').is_symlink():
            (demo / 'current').symlink_to(ROOT)
        with tempfile.TemporaryDirectory() as directory:
            units = Path(directory) / 'units'
            units.mkdir()
            shutil.copy(ROOT / 'ops/production/bor-czuwa-monitor.service', units)
            subprocess.run(['python3', 'ops/production/deployment.py', 'units', directory, 'demo'], cwd=ROOT, check=True)
        unit = Path('/etc/systemd/system/bor-czuwa-demo-monitor.service').read_text()
        self.assertNotIn('/var/lib/bor-czuwa/', unit)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        self.install('bor-czuwa-api.service')
        subprocess.run(['systemctl', 'start', 'bor-czuwa-api.service'], check=True)
        try:
            for attempt in range(40):
                try:
                    urllib.request.urlopen('http://127.0.0.1:3001/api/health', timeout=2).close()
                    break
                except OSError:
                    time.sleep(0.5)
            code, state = self.run_oneshot('bor-czuwa-demo-monitor.service')
            self.assertEqual((code, state['Result']), (0, 'success'), state)
            self.assertTrue(Path('/var/lib/bor-czuwa-demo/monitor/monitor-state').is_file())
        finally:
            subprocess.run(['systemctl', 'stop', 'bor-czuwa-api.service'], capture_output=True)

    def test_backup_unit_dumps_and_stores_a_snapshot(self):
        self.install('bor-czuwa-backup.service')
        code, state = self.run_oneshot('bor-czuwa-backup.service')
        self.assertEqual((code, state['Result']), (0, 'success'), state)
        listing = subprocess.check_output(['runuser', '-u', 'bor-czuwa-maint', '--', 'env', 'RESTIC_PASSWORD_FILE=/etc/bor-czuwa/restic-password',
                                           'restic', 'snapshots', '--json', '--repo', '/var/lib/bor-czuwa/backup/repo'])
        self.assertEqual(len(json.loads(listing)), 1)
        self.assertTrue(Path('/var/lib/bor-czuwa/backup/backup-success').is_file())

    def test_digest_unit_reaches_its_own_error_and_reads_the_database(self):
        # Mail is not configured, so the real command must stop at its own smtp_not_configured error (exit 1),
        # not at a sandbox kill (SIGSYS) or a missing path.
        self.install('integrity-digest.service')
        code, state = self.run_oneshot('integrity-digest.service')
        self.assertEqual((state['ExecMainCode'], state['ExecMainStatus']), ('1', '1'), state)
        self.install('integrity-digest.service', 'ExecStart=\nExecStart=/bin/sh -c "/usr/bin/npm run operator -- digest-preview >/dev/null"\n')
        code, state = self.run_oneshot('integrity-digest.service')
        self.assertEqual((code, state['Result']), (0, 'success'), state)

    def test_geodata_unit_writes_only_its_own_directories(self):
        script = Path('/usr/local/bin/sandbox-probe.sh')
        script.write_text('''set -e
touch "$GEODATA_EXTRACT_DIR/probe" "$TMPDIR/probe"
flock "$TMPDIR/refresh.lock" true
! touch /etc/probe 2>/dev/null
! touch /opt/probe 2>/dev/null
! touch /var/lib/probe 2>/dev/null
! touch /var/lib/bor-czuwa/monitor/probe 2>/dev/null
! unshare -U true 2>/dev/null
! python3 -c "import socket; socket.socket(socket.AF_NETLINK, socket.SOCK_RAW)" 2>/dev/null
python3 -c "import socket; socket.create_connection(('127.0.0.1', 5432), 3)"
test -z "$(ls /dev | grep -x sda)"
test "$(id -u)" != 0
test -z "$(ls /home)"
''')
        probe = 'ExecStart=\nExecStart=/bin/sh /usr/local/bin/sandbox-probe.sh\n'
        self.install('geodata-refresh.service', probe)
        code, state = self.run_oneshot('geodata-refresh.service')
        self.assertEqual((code, state['Result']), (0, 'success'), state)
        self.assertTrue(Path('/var/lib/bor-czuwa/geodata-extracts/probe').is_file())

    def test_stats_unit_stays_on_loopback_and_writes_only_its_directory(self):
        # The GoatCounter binary is downloaded at install time and is not in the drill, so a stand-in
        # (Python's HTTP server on the same address) runs inside the unit's real sandbox.
        Path('/var/lib/bor-czuwa-stats').mkdir(exist_ok=True)
        shutil.chown('/var/lib/bor-czuwa-stats', 'bor-czuwa-stats', 'bor-czuwa-stats')
        script = Path('/usr/local/bin/stats-probe.py')
        script.write_text("""import http.server, os, socket
for path in ['/etc/probe', '/opt/probe', '/var/lib/bor-czuwa/probe']:
    try:
        open(path, 'w'); raise SystemExit('wrote ' + path)
    except OSError:
        pass
open('/var/lib/bor-czuwa-stats/probe', 'w').close()
try:
    socket.create_connection(('192.0.2.1', 80), 1); raise SystemExit('left loopback')
except OSError:
    pass
http.server.ThreadingHTTPServer(('127.0.0.1', 8081), http.server.SimpleHTTPRequestHandler).serve_forever()
""")
        self.install('bor-czuwa-stats.service', 'ExecStart=\nExecStart=/usr/bin/python3 /usr/local/bin/stats-probe.py\n'
                     'StandardError=journal\nRestart=no\n')
        started = subprocess.run(['systemctl', 'start', 'bor-czuwa-stats.service'], capture_output=True, text=True)
        try:
            for attempt in range(30):
                try:
                    with urllib.request.urlopen('http://127.0.0.1:8081/', timeout=2) as response:
                        self.assertEqual(response.status, 200)
                    break
                except OSError:
                    time.sleep(0.3)
            else:
                self.fail(started.stderr + subprocess.run(['journalctl', '-u', 'bor-czuwa-stats.service', '--no-pager', '-n', '20'],
                                                          capture_output=True, text=True).stdout)
            pid = self.show('bor-czuwa-stats.service', 'MainPID')['MainPID']
            status = dict(line.split(':\t', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':\t' in line)
            self.assertEqual((status['CapEff'], status['NoNewPrivs'], status['Seccomp']), ('0000000000000000', '1', '2'))
            self.assertTrue(Path('/var/lib/bor-czuwa-stats/probe').is_file())
        finally:
            subprocess.run(['systemctl', 'stop', 'bor-czuwa-stats.service'], capture_output=True)


if __name__ == '__main__':
    unittest.main()
