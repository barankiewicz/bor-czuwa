"""Exercise deployment eligibility, proxy privacy and retained backup behavior."""
import json
import contextlib
import socket
import ssl
import threading
import urllib.error
import io
import re
import runpy
import shlex
import shutil
from unittest.mock import Mock, patch
import fcntl
import os
import importlib.util
import zipfile
from pathlib import Path
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('deployment', ROOT / 'ops/production/deployment.py')
deployment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deployment)


class BackupExpiry(unittest.TestCase):
    def test_expiration_deletes_old_ciphertext_without_dropping_recent_recovery_points(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {**os.environ, 'RESTIC_REPOSITORY': str(root / 'repository'),
                   'RESTIC_PASSWORD': 'disposable-drill-password'}
            def restic(*args):
                return subprocess.check_output(['restic', *args], env=env, stderr=subprocess.DEVNULL)
            restic('init')
            source = root / 'report.dump'
            now = datetime.now(timezone.utc)
            old_ids = []
            for days in [40, 35, 34, 7, 1, 0]:
                source.write_text(f'Synthetic recovery point {days}\n')
                output = restic('backup', '--json', '--tag', 'bor-czuwa', '--time',
                                (now - timedelta(days=days, seconds=5)).strftime('%Y-%m-%d %H:%M:%S'), str(source))
                summary = json.loads(output.splitlines()[-1])
                if days >= 34:
                    old_ids.append(summary['snapshot_id'])
            # Keep a shared blob alive inside a pack that also contains expired private bytes.
            mixed = root / 'mixed'
            mixed.mkdir()
            (mixed / 'shared').write_bytes(os.urandom(1024 * 1024))
            (mixed / 'expired').write_text('Expired synthetic private payload\n')
            output = restic('backup', '--json', '--tag', 'bor-czuwa', '--time',
                            (now - timedelta(days=40)).strftime('%Y-%m-%d %H:%M:%S'), str(mixed))
            old_mixed = json.loads(output.splitlines()[-1])['snapshot_id']
            tree = json.loads(restic('cat', 'tree', f'{old_mixed}:{mixed}'))
            expired_blob = next(node['content'][0] for node in tree['nodes'] if node['name'] == 'expired')
            shared_blob = next(node['content'][0] for node in tree['nodes'] if node['name'] == 'shared')
            mixed_packs = []
            for index in restic('list', 'index').decode().splitlines():
                for pack in json.loads(restic('cat', 'index', index))['packs']:
                    contents = {blob['id'] for blob in pack['blobs']}
                    if expired_blob in contents and shared_blob in contents:
                        mixed_packs.append(pack['id'])
            self.assertTrue(mixed_packs, 'fixture needs expired and retained blobs in one pack')
            (mixed / 'expired').unlink()
            restic('backup', '--tag', 'bor-czuwa', str(mixed))
            subprocess.run(['python3', str(ROOT / 'ops/production/backup.py'), 'expire'], env=env, check=True)
            live_packs = restic('list', 'packs').decode().splitlines()
            for pack in mixed_packs:
                self.assertNotIn(pack, live_packs)
                self.assertFalse((root / 'repository/data' / pack[:2] / pack).exists())
            remaining = json.loads(restic('snapshots', '--json'))
            self.assertTrue(remaining)
            self.assertTrue(all(now - datetime.fromisoformat(row['time'].replace('Z', '+00:00')) < timedelta(days=34)
                                for row in remaining))
            for snapshot in old_ids:
                restored = subprocess.run(['restic', 'restore', snapshot, '--target', str(root / 'restore')],
                                          env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.assertNotEqual(restored.returncode, 0)
            restic('check', '--read-data')
            self.assertEqual(len(remaining), 4)


class BackupDisabled(unittest.TestCase):
    def test_monitor_does_not_require_a_backup_when_runtime_is_healthy(self):
        responses = [io.BytesIO(json.dumps(value).encode()) for value in [
            {'status': 'ok'}, {'status': 'ready'},
            {'status': 'ok', 'terminal_failures': 0, 'integrity_terminal_failures': 0}
        ]]
        output = io.StringIO()
        script = str(ROOT / 'ops/production/monitor.py')
        with patch('sys.argv', [script, '--check']), \
                patch('urllib.request.urlopen', side_effect=responses), \
                patch('subprocess.run', return_value=Mock(returncode=1)) as systemctl, \
                contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
            runpy.run_path(script, run_name='__main__')
        self.assertEqual(stopped.exception.code, 0)
        self.assertEqual(json.loads(output.getvalue())['events'], [])
        self.assertFalse(any('bor-czuwa-backup.service' in call.args[0] for call in systemctl.call_args_list))


class VerifierCredentialBoundary(unittest.TestCase):
    def test_repository_token_exists_only_in_verifier_subprocess(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credential = root / 'candidate-api.env'
            credential.write_text("GH_TOKEN='disposable-verifier-only'\n")
            credential.chmod(0o600)
            # This unprivileged fixture represents the root-owned file metadata.
            (root / 'stat').write_text('#!/bin/sh\nprintf "600:0\\n"\n')
            (root / 'node').write_text(
                '#!/usr/bin/env python3\nimport os, sys\n'
                'assert os.environ.get("GH_TOKEN") == "disposable-verifier-only"\n'
                'assert sys.argv[2:] == ["verify", "fixture", "staging"]\n'
                'print("verifier-only")\n')
            for name in ['stat', 'node']:
                (root / name).chmod(0o700)
            command = '''
set -euo pipefail
source "$1"
etc=$2
control=$2
test -z "${GH_TOKEN+x}"
python3 -c 'import os; assert "GH_TOKEN" not in os.environ'
verify_candidate fixture staging
test -z "${GH_TOKEN+x}"
sh -c 'test -z "${GH_TOKEN+x}"'
python3 -c 'import os; assert "GH_TOKEN" not in os.environ'
'''
            result = subprocess.run(
                ['bash', '-c', command, 'credential-boundary',
                 str(ROOT / 'ops/production/environment.sh'), str(root)],
                env={**os.environ, 'PATH': f"{root}:{os.environ['PATH']}",
                     'GH_TOKEN': 'disposable-inherited-operator'},
                capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.strip(), 'verifier-only')


class ProxyHardening(unittest.TestCase):
    def test_effective_nginx_policy_rejects_hardening_regressions(self):
        config = subprocess.check_output(['python3', str(ROOT / 'ops/production/render-nginx.py'),
                                          'app.example']).decode()
        config += '\nadd_header Permissions-Policy "camera=(self), geolocation=(self)" always;\n'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'nginx'
            executable.write_text('#!/bin/sh\ncat "$NGINX_TEST_CONFIG"\n')
            executable.chmod(0o700)
            source = root / 'effective.conf'
            env = {**os.environ, 'PATH': f"{root}:{os.environ['PATH']}", 'NGINX_TEST_CONFIG': str(source)}
            def audit(text):
                source.write_text(text)
                return subprocess.run(['python3', str(ROOT / 'ops/production/audit-nginx.py')],
                                      env=env, capture_output=True).returncode
            self.assertEqual(audit(config), 0)
            for broken in [
                config.replace('server_tokens off;', 'server_tokens on;'),
                config.replace('zone=places:10m rate=1r/s', 'zone=places:10m rate=5r/s'),
                config.replace('limit_req zone=places burst=2 nodelay;', 'limit_req zone=api_reads burst=2 nodelay;'),
                config.replace('$client_rate_key zone=reports', '$binary_remote_addr zone=reports'),
                config.replace('camera=(self), geolocation=(self)', 'camera=*, geolocation=*'),
                config.replace('proxy_set_header X-Forwarded-Host $server_name;', 'proxy_set_header X-Forwarded-Host $http_x_forwarded_host;'),
                config.replace('proxy_set_header X-Forwarded-Proto $scheme;', 'proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;'),
                config.replace('(?s)', ''),
                config.replace('proxy_set_header X-Forwarded-Host $server_name;', 'proxy_set_header X-Forwarded-Host $http_host;'),
            ]:
                self.assertNotEqual(audit(broken), 0)

    def test_audit_refuses_a_render_without_the_tls_and_request_hardening(self):
        config = subprocess.check_output(['python3', str(ROOT / 'ops/production/render-nginx.py'),
                                          'app.example']).decode()
        config += '\nadd_header Permissions-Policy "camera=(self), geolocation=(self)" always;\n'
        hsts = 'add_header Strict-Transport-Security "max-age=31536000" always;'
        post = 'if ($request_method !~ ^(?:POST|OPTIONS)$) { return 405; }'
        self.assertIn(hsts, config)
        self.assertIn(post, config)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'nginx'
            executable.write_text('#!/bin/sh\ncat "$NGINX_TEST_CONFIG"\n')
            executable.chmod(0o700)
            source = root / 'effective.conf'
            env = {**os.environ, 'PATH': f"{root}:{os.environ['PATH']}", 'NGINX_TEST_CONFIG': str(source)}
            def audit(text):
                source.write_text(text)
                return subprocess.run(['python3', str(ROOT / 'ops/production/audit-nginx.py')],
                                      env=env, capture_output=True).returncode
            self.assertEqual(audit(config), 0)
            for name, broken in {
                'old TLS': config.replace('ssl_protocols TLSv1.2 TLSv1.3;', 'ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;'),
                'no protocols': config.replace('ssl_protocols TLSv1.2 TLSv1.3;', ''),
                'CBC suite': config.replace('ssl_ciphers ', 'ssl_ciphers ECDHE-RSA-AES128-SHA:'),
                'finite-field suite without parameters': config.replace('ssl_ciphers ', 'ssl_ciphers DHE-RSA-AES128-GCM-SHA256:'),
                'server cipher order': config.replace('ssl_prefer_server_ciphers off;', 'ssl_prefer_server_ciphers on;'),
                'session tickets': config.replace('ssl_session_tickets off;', 'ssl_session_tickets on;'),
                'stapling without verify': config.replace('ssl_session_tickets off;', 'ssl_session_tickets off;\n    ssl_stapling on;'),
                'no HTTP/2': config.replace('http2 on;', ''),
                'no HSTS': config.replace(hsts, ''),
                'HSTS for subdomains': config.replace('max-age=31536000"', 'max-age=31536000; includeSubDomains"'),
                'HSTS preload': config.replace('max-age=31536000"', 'max-age=31536000; preload"'),
                'HSTS under the floor': config.replace('max-age=31536000"', 'max-age=100"'),
                'HSTS in one place differs': config.replace('max-age=31536000"', 'max-age=600"', 1),
                'well-known blocked': config.replace('(?!well-known/)', ''),
                'error page without security headers': config.replace(
                    'location @e404 {\n      internal;\n      include /opt/bor-czuwa/current/build/security-headers.conf;\n      add_header Strict-Transport-Security "max-age=31536000" always;',
                    'location @e404 {\n      internal;'),
                'JSON error page naming nginx': config.replace('return 404 "Not found\\n";', 'return 404 "nginx 404\\n";'),
                'slow header timeout': config.replace('client_header_timeout 10s;', 'client_header_timeout 300s;'),
                'no body timeout': config.replace('client_body_timeout 10s;', ''),
                'no proxy read timeout': config.replace('proxy_read_timeout 15s;', ''),
                'huge header buffers': config.replace('large_client_header_buffers 4 8k;', 'large_client_header_buffers 64 1m;'),
                'no connection limit': config.replace('limit_conn connections 40;', ''),
                'upload route on the shared pool': config.replace('limit_conn upload_connections 40;', '', 1),
                'upload route with a large client share': config.replace('limit_conn connections 4;', 'limit_conn connections 40;', 1),
                'PUT allowed': config.replace(post, 'if ($request_method !~ ^(?:POST|PUT|OPTIONS)$) { return 405; }'),
                'no method list': config.replace(post, ''),
                'dotfiles served': config.replace('location ~ /\\.(?!well-known/) { return 404; }', ''),
                'backups served': config.replace('(?:bak|', '(?:'),
                'stats PUT allowed': config.replace('if ($request_method !~ ^(?:POST)$) { return 405; }', 'if ($request_method !~ ^(?:POST|PUT)$) { return 405; }'),
                'stats no method list': config.replace('if ($request_method !~ ^(?:POST)$) { return 405; }', ''),
                'default 405 page': config.replace('error_page 405 = @e405;', ''),
            }.items():
                with self.subTest(name):
                    self.assertNotEqual(audit(broken), 0)

    def test_hsts_max_age_is_a_deploy_setting_with_a_floor_and_an_audited_result(self):
        render = ROOT / 'ops/production/render-nginx.py'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'nginx').write_text('#!/bin/sh\ncat "$NGINX_TEST_CONFIG"\n')
            (root / 'nginx').chmod(0o700)
            env = {**os.environ, 'PATH': f"{root}:{os.environ['PATH']}", 'NGINX_TEST_CONFIG': str(root / 'effective.conf')}
            default = subprocess.check_output(['python3', str(render), 'app.example', '--config-path', str(root)], text=True)
            self.assertIn('Strict-Transport-Security "max-age=31536000"', default)
            (root / 'hsts-max-age').write_text('600\n')
            ramp = subprocess.check_output(['python3', str(render), 'app.example', '--config-path', str(root)], text=True)
            self.assertNotIn('Strict-Transport-Security "max-age=31536000"', ramp)
            self.assertEqual(ramp.count('Strict-Transport-Security "max-age=600"'), default.count('Strict-Transport-Security "max-age=31536000"'))
            (root / 'effective.conf').write_text(ramp + '\nadd_header Permissions-Policy "camera=(self), geolocation=(self)" always;\n')
            self.assertEqual(subprocess.run(['python3', str(ROOT / 'ops/production/audit-nginx.py')], env=env).returncode, 0)
            for value in ['299', '0', 'forever', '31536000; includeSubDomains', '99999999999']:
                (root / 'hsts-max-age').write_text(value + '\n')
                refused = subprocess.run(['python3', str(render), 'app.example', '--config-path', str(root)], capture_output=True)
                self.assertNotEqual(refused.returncode, 0, value)

    def test_app_host_stays_noindex_in_every_indexing_mode(self):
        # The public face is the landing on another host, so the app host never lifts the exclusion.
        for mode in ['public', 'staging']:
            config = subprocess.check_output(['python3', str(ROOT / 'ops/production/render-nginx.py'),
                                              'app.example', '--indexing', mode]).decode()
            self.assertIn('set $document_robots "noindex, nofollow";', config)
            self.assertNotIn('set $document_robots "";', config)
            self.assertIn('add_header X-Robots-Tag $document_robots always;', config)

    def test_private_gate_audit_requires_exact_browser_native_and_header_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gate = root / 'gate.json'
            gate.write_text(json.dumps({'cookieToken': 'a' * 64, 'passwordFile': '/etc/demo/access.htpasswd'}))
            config = subprocess.check_output([
                'python3', str(ROOT / 'ops/production/render-nginx.py'), 'demo.example',
                '--indexing', 'staging', '--private-gate', str(gate)], text=True)
            config += '\nadd_header Permissions-Policy "camera=(self), geolocation=(self)" always;\n'
            executable = root / 'nginx'
            executable.write_text('#!/bin/sh\ncat "$NGINX_TEST_CONFIG"\n')
            executable.chmod(0o700)
            source = root / 'effective.conf'
            env = {**os.environ, 'PATH': f"{root}:{os.environ['PATH']}", 'NGINX_TEST_CONFIG': str(source)}

            def audit(text):
                source.write_text(text)
                return subprocess.run(['python3', str(ROOT / 'ops/production/audit-nginx.py')],
                                      env=env, capture_output=True).returncode

            self.assertEqual(audit(config), 0)
            for broken in [
                config.replace('map $http_cookie $private_browser_realm', 'map $http_cookie $private_realm'),
                config.replace('~^https://localhost:', '~^https://foreign.example:'),
                config.replace(':/api/" off;', ':/" off;'),
                config.replace('https://localhost:' + 'a' * 64, 'https://localhost:' + 'b' * 64),
                config.replace('proxy_set_header X-Bor-Demo-Invitation "";',
                               'proxy_set_header X-Bor-Demo-Invitation $http_x_bor_demo_invitation;'),
                config.replace('proxy_set_header Forwarded "";',
                               'proxy_set_header Forwarded ""; proxy_set_header Authorization "overwritten";'),
                config.replace('add_header Access-Control-Allow-Origin $cors_origin always;',
                               'add_header Access-Control-Allow-Origin "*" always;'),
            ]:
                self.assertNotEqual(audit(broken), 0)


class DeploymentEligibility(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.approved = {'domain': 'demo.example', 'certificateName': 'existing-ip-cert',
                         'demoTestRecipient': 'owner@example.invalid'}

    def candidate(self, mode, recipient=None, origin=None):
        configuration = {'mode': mode, 'demoTestRecipient': recipient, 'androidApiOrigin': origin}
        with zipfile.ZipFile(self.directory / 'verification.zip', 'w') as archive:
            archive.writestr('candidate.json', json.dumps({
                'releaseCandidate': {'mode': mode, 'configuration': configuration}}))

    def test_demo_requires_exact_approved_recipient_and_origin(self):
        with patch.object(deployment, 'demo_config', return_value=self.approved):
            self.candidate('staging', 'owner@example.invalid', 'https://demo.example')
            deployment.check_candidate(self.directory, 'demo', 'demo.example')
            with self.assertRaisesRegex(ValueError, 'domain differs'):
                deployment.check_candidate(self.directory, 'demo', 'other.example')
            for recipient, origin in [(None, None), ('authority@example.invalid', None),
                                      ('owner@example.invalid', None),
                                      ('owner@example.invalid', 'https://other.example')]:
                self.candidate('staging', recipient, origin)
                with self.assertRaises(ValueError):
                    deployment.check_candidate(self.directory, 'demo', 'demo.example')

    def test_staging_and_production_cannot_cross_environment_boundary(self):
        with patch.object(deployment, 'demo_config', return_value=self.approved):
            self.candidate('production')
            deployment.check_candidate(self.directory, 'production')
            with self.assertRaisesRegex(ValueError, 'staging eligibility'):
                deployment.check_candidate(self.directory, 'demo')
            self.candidate('staging', 'owner@example.invalid')
            with self.assertRaisesRegex(ValueError, 'production eligibility'):
                deployment.check_candidate(self.directory, 'production')
            self.candidate('production', 'owner@example.invalid')
            with self.assertRaisesRegex(ValueError, 'forbidden'):
                deployment.check_candidate(self.directory, 'production')

    def test_production_android_origin_is_the_app_host_not_the_apex(self):
        self.candidate('production', None, 'https://app.bor-czuwa.pl')
        deployment.check_candidate(self.directory, 'production', 'app.bor-czuwa.pl')
        for origin in ['https://bor-czuwa.pl', None]:
            self.candidate('production', None, origin)
            with self.assertRaisesRegex(ValueError, 'app host'):
                deployment.check_candidate(self.directory, 'production', 'app.bor-czuwa.pl')

    def test_rollback_requires_exact_target_and_explicit_indexeddb_compatibility(self):
        receipt = {'sourceCommit': 'a' * 40, 'candidateSha256': 'b' * 64}
        authorization = {**receipt, 'indexedDbCompatible': True, 'backups': 'off',
                         'authorization': 'Owner approved this fictional-data application rollback'}
        with patch.object(deployment, 'private_json', return_value=authorization):
            deployment.authorize_rollback(self.directory, json.dumps(receipt))
            for key, value in [('sourceCommit', 'c' * 40), ('candidateSha256', 'd' * 64),
                               ('indexedDbCompatible', False), ('backups', 'on'), ('authorization', '')]:
                with patch.dict(authorization, {key: value}), self.assertRaises(ValueError):
                    deployment.authorize_rollback(self.directory, json.dumps(receipt))


class ActivationFailurePaths(unittest.TestCase):
    """Run activate.sh in a user namespace over a temp tree, with the host seams stubbed."""
    STUBS = {
        'systemctl': ('echo "$*" >> "$T/systemctl.log"\n'
                      '[ "$1" != daemon-reload ] || [ ! -e "$T/fail-reload" ] || exit 1\n'
                      '[ "$1 $2" != "stop jobs" ] || [ ! -e "$T/fail-stop-jobs" ] || exit 1\n'
                      '[ "$1 $2" != "stop bor-czuwa-api.service" ] || [ ! -e "$T/fail-api-stop" ] || exit 1\n'
                      '[ "$1 $2" != "start jobs" ] || [ ! -e "$T/fail-start-jobs" ] || { [ ! -e "$T/copy-fails-in-cleanup" ] || touch "$T/fail-cp-conf"; exit 1; }\n'
                      '[ "$1 $2" != "stop bor-czuwa-api.service" ] || echo stopped > "$T/api"\n'
                      '[ "$1" != is-active ]\n'),
        'ss': 'exit 0\n',
        'gdal-config': 'echo 3.2.2\n',
        'psql': 'if [ -e "$T/no-geodata" ]; then echo f; else echo t; fi\n',
        'systemd-run': '[ ! -e "$T/fail-ingest" ] || exit 1\n',
        'runuser': 'shift 3\nexec "$@"\n',
        'npm': ('if [ "$1" = ci ]; then [ ! -e "$T/fail-npm" ] || { echo "npm registry unreachable" >&2; exit 1; }; fi\n'
                'if [ "$1" = run ] && [ -e "$T/fail-migrate" ]; then\n'
                '  echo "error: password authentication failed for role owner_secret" >&2\n'
                '  echo "Failure class: 55P03" >&2; exit 1; fi\nexit 0\n'),
        'python3': ('if [ "$1" = -m ]; then mkdir -p .venv/bin\n'
                    'printf "#!/bin/sh\\nexit 0\\n" > .venv/bin/pip; cp .venv/bin/pip .venv/bin/python\n'
                    'chmod +x .venv/bin/pip .venv/bin/python; exit 0; fi\n'
                    'case "$1" in */deployment.py) if [ -e "$T/real-deployment" ]; then exec /usr/bin/python3 "$@"; fi; if [ "$2" = units ] && [ -e "$T/fail-units" ]; then exit 1; fi; if [ "$2" = close ]; then cat >/dev/null; echo config-closed; fi; exit 0 ;;\n'
                    '*/unpack-candidate.py) [ ! -e "$T/fail-unpack" ] || { echo "FileNotFoundError: $T/secret/verification.zip" >&2; exit 1; }; exit 0 ;;\n'
                    '*/audit-nginx.py) exit 0 ;; */render-nginx.py) echo config-open; exit 0 ;; esac\n'
                    'exec /usr/bin/python3 "$@"\n'),
        # Fails the copy onto the live nginx config once the test arms it.
        'cp': ('for a; do last=$a; done\n'
               '[ ! -e "$T/fail-cp-conf" ] || [ "$last" != "$T/nginx/nginx.conf" ] || exit 1\nexec /usr/bin/cp "$@"\n'),
        # The real wait is 30 s; the wrapper records the request and shortens it to 1 s.
        'flock': 'echo "$*" >> "$T/flock.log"\n'
                 'if [ "$1" = -w ]; then shift 2; set -- -w 1 "$@"; fi\nexec /usr/bin/flock "$@"\n',
    }
    # The real refusal helper, so the sentences under test are the shipped ones.
    REFUSE = ''.join((re.search(pattern, (ROOT / 'ops/production/environment.sh').read_text()) or [''])[0]
                     for pattern in [r'(?ms)^refuse\(\) \{.*?^\}\n', r'(?ms)^load_env\(\) \{.*?^\}\n', r'(?m)^record_refusal\(\) \{[^\n]*\}\n'])
    ENVIRONMENT = REFUSE.replace('%', '%%') + '''refusal_file=$T/refusals/startup-refusals; export BOR_CZUWA_REFUSAL_FILE=$refusal_file; control=$T/control; monitor=bor-czuwa-monitor
base=$T/base; etc=$T/etc; eligibility=production; api=bor-czuwa-api
maint_user=$(id -un); build_user=$(id -un); lock=$T/deploy.lock
verify_candidate() { [ ! -e "$T/fail-verify" ] || { echo "Release blocked: trusted policy missing or unsafe" >&2; return 1; }; echo '{"sourceCommit":"%(commit)s"}'; }
stop_jobs() { systemctl stop jobs; }
start_jobs() { systemctl start jobs; }
ready() { return 0; }
publish_proxy() {
  echo "proxy ${1:-open}" >> "$T/systemctl.log"
  if [[ ${1:-open} == maintenance ]]; then
    [[ ! -e $T/fail-maintenance-after-open || ! -e $T/routes || $(cat $T/routes) != open ]] || return 1
    echo closed > "$T/routes"
  else
    echo open > "$T/routes"
    # The real function ends by installing the renewal hook once routes are open.
    install -m 0755 "$control/environment.sh" "$T/missing/renewal-hooks/deploy/hook"
  fi
}
'''
    COMMIT = 'a' * 40

    @classmethod
    def setUpClass(cls):
        probe = subprocess.run(['unshare', '-r', 'true'], capture_output=True)
        if probe.returncode:
            raise unittest.SkipTest('user namespaces unavailable')

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.t = Path(temporary.name)
        t = self.t
        (t / 'bin').mkdir()
        for name, body in self.STUBS.items():
            # The installer runs npm under env -i, so the temp path is baked in rather than inherited.
            (t / 'bin' / name).write_text('#!/bin/sh\n' + body.replace('$T', str(t)))
            (t / 'bin' / name).chmod(0o755)
        control = t / 'control'
        control.mkdir()
        script = (ROOT / 'ops/production/activate.sh').read_text()
        script = script.replace('/usr/local/lib/bor-czuwa-release', str(control))
        script = script.replace('/run/lock/bor-czuwa-proxy.lock', str(t / 'proxy.lock'))
        (control / 'activate.sh').write_text(script)
        (control / 'environment.sh').write_text(self.ENVIRONMENT % {'commit': self.COMMIT})
        (control / 'unpack-candidate.py').write_text('')
        shutil.copy(ROOT / 'scripts/release-candidate.mjs', control / 'release-candidate.mjs')
        shutil.copy(ROOT / 'ops/production/startup_refusals.py', control / 'startup_refusals.py')
        (control / 'deployment.py').write_text('')
        (t / 'etc').mkdir()
        (t / 'etc/dedicated-host').touch()
        for name in ['runtime', 'maintenance', 'monitor', 'digest']:
            (t / f'etc/{name}.env').write_text('MIGRATION_DATABASE_URL=x\n')
            (t / f'etc/{name}.env').chmod(0o600)
        (t / 'base/releases').mkdir(parents=True)
        self.staging = t / 'base/staging.fixture'
        (self.staging / 'payload/scripts').mkdir(parents=True)
        (self.staging / 'payload/scripts/requirements.txt').write_text('')
        self.write_verification_archive()

    def write_verification_archive(self):
        """The staged candidate's archive, and the result the stubbed verifier reports for it."""
        manifest = json.dumps({'identity': {'sourceCommit': self.COMMIT},
                               'releaseCandidate': {'files': {'build/index.html': 'a' * 64}}}).encode()
        archive = self.staging / 'verification.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('candidate.json', manifest)
        import hashlib
        (self.t / 'result.json').write_text(json.dumps({
            'sourceCommit': self.COMMIT, 'mode': 'production', 'action': 'activate',
            'candidateSha256': hashlib.sha256(manifest).hexdigest(),
            'verificationZipSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))
        for name in ['environment.sh']:
            text = (self.t / 'control' / name).read_text()
            (self.t / 'control' / name).write_text(text.replace(
                "echo '{\"sourceCommit\":\"%s\"}'" % self.COMMIT, 'cat "$T/result.json"'))

    def use_the_real_proxy_publisher(self):
        """Keep environment.sh's own publish_proxy over a temp nginx tree; stub only the other seams."""
        text = (ROOT / 'ops/production/environment.sh').read_text()
        text = text.replace('/etc/nginx', str(self.t / 'nginx')).replace('/etc/letsencrypt', str(self.t / 'le'))
        text = text.replace('base=/opt/bor-czuwa\n', 'base=$T/base\n').replace('etc=/etc/bor-czuwa\n', 'etc=$T/etc\n')
        text = text.replace('lock=/run/lock/bor-czuwa-deploy.lock', 'lock=$T/deploy.lock')
        text = text.replace('maint_user=bor-czuwa-maint', 'maint_user=$(id -un)').replace('build_user=bor-czuwa-build', 'build_user=$(id -un)')
        text += ('verify_candidate() { cat "$T/result.json"; }\nstop_jobs() { systemctl stop jobs; }\n'
                 'start_jobs() { systemctl start jobs; }\nready() { return 0; }\n')
        # Tests set T in the environment; the sourced file reads it the same way.
        (self.t / 'control/environment.sh').write_text(text)
        (self.t / 'control/nginx-reload-hook.sh').write_text('#!/bin/sh\n')
        (self.t / 'nginx').mkdir()
        (self.t / 'nginx/nginx.conf').write_text('config-open\n')
        (self.t / 'le/renewal-hooks/deploy').mkdir(parents=True)

    def activate(self, hold_lock=False):
        env = {**os.environ, 'T': str(self.t), 'PATH': f'{self.t}/bin:{os.environ["PATH"]}'}
        held = None
        if hold_lock:
            # Held by this process until the activation returns, so load cannot let it win the lock.
            held = open(self.t / 'deploy.lock', 'w')
            fcntl.flock(held, fcntl.LOCK_EX)
        try:
            return subprocess.run(['unshare', '-r', 'bash', str(self.t / 'control/activate.sh'), 'app.example',
                                   self.COMMIT, str(self.staging)], env=env, capture_output=True, text=True, timeout=60)
        finally:
            if held:
                held.close()

    def calls(self):
        return (self.t / 'systemctl.log').read_text().splitlines()

    def test_a_successful_run_installs_and_leaves_no_staging_directory(self):
        (self.t / 'missing/renewal-hooks/deploy').mkdir(parents=True)
        result = self.activate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.staging.exists())
        self.assertEqual((self.t / 'base/current').resolve(), self.t / 'base/releases' / self.COMMIT / 'payload')

    def test_a_successful_run_leaves_a_receipt_that_only_root_can_change(self):
        (self.t / 'missing/renewal-hooks/deploy').mkdir(parents=True)
        result = self.activate()
        self.assertEqual(result.returncode, 0, result.stderr)
        release = self.t / 'base/releases' / self.COMMIT
        receipt = release / 'activation-receipt.json'
        self.assertTrue(receipt.is_file(), result.stderr)
        # Beside payload/, which the verifier walks, and owned like the rest of the installed release.
        self.assertEqual(receipt.parent, release)
        self.assertEqual(receipt.stat().st_uid, (release / 'payload/installed').stat().st_uid)
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o644)
        content = json.loads(receipt.read_text())
        self.assertEqual(content['version'], 1)
        self.assertEqual(content['result']['sourceCommit'], self.COMMIT)
        self.assertEqual(content['files'], {'build/index.html': 'a' * 64})

    def test_a_receipt_that_cannot_be_written_stops_activation_before_anything_is_installed(self):
        (self.t / 'missing/renewal-hooks/deploy').mkdir(parents=True)
        result_file = self.t / 'result.json'
        result = json.loads(result_file.read_text())
        result['verificationZipSha256'] = '0' * 64
        result_file.write_text(json.dumps(result))
        outcome = self.activate()
        self.assertEqual(outcome.returncode, 1)
        self.assertEqual(outcome.stderr.strip(), 'Activation stopped before anything was changed; the running release and its routes are untouched. Failed step: write_receipt.')
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:activation_write_receipt'])
        self.assertFalse((self.t / 'base/releases' / self.COMMIT).exists())
        self.assertFalse(self.staging.exists())

    def test_a_failing_final_publish_stops_the_api_closes_routes_and_says_so(self):
        # A7: the certbot hook directory is missing, so the last command of publish_proxy fails.
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Activation failed. API remains stopped and application routes remain closed.', result.stderr)
        calls = self.calls()
        self.assertEqual(calls[-1], 'proxy maintenance')
        self.assertIn('stop bor-czuwa-api.service', calls[calls.index('proxy open'):])

    def test_a_failing_job_stop_after_the_maintenance_page_still_ends_closed_with_the_message(self):
        (self.t / 'fail-stop-jobs').touch()
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Activation failed. API remains stopped and application routes remain closed.', result.stderr)
        self.assertEqual((self.t / 'routes').read_text().strip(), 'closed')
        self.assertEqual((self.t / 'api').read_text().strip(), 'stopped')

    def test_a_failed_recovery_does_not_claim_the_state_it_did_not_reach(self):
        # Routes opened, start_jobs fails, then the maintenance reload fails too: routes stay open.
        (self.t / 'missing/renewal-hooks/deploy').mkdir(parents=True)
        (self.t / 'fail-start-jobs').touch()
        (self.t / 'fail-maintenance-after-open').touch()
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.t / 'routes').read_text().strip(), 'open')
        self.assertNotIn('routes remain closed', result.stderr)
        self.assertIn('application routes may be open', result.stderr)

    def test_a_failed_config_copy_during_cleanup_is_not_masked_by_a_later_successful_reload(self):
        # publish_proxy runs under || in the handler, where errexit is off: the failed copy of the
        # closed config must still make it return failure, not fall through to audit and reload.
        self.use_the_real_proxy_publisher()
        (self.t / 'fail-start-jobs').touch()
        (self.t / 'copy-fails-in-cleanup').touch()
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.t / 'nginx/nginx.conf').read_text().strip(), 'config-open')
        self.assertNotIn('routes remain closed', result.stderr)
        self.assertIn('application routes may be open', result.stderr)

    def test_a_failed_api_stop_during_recovery_does_not_claim_the_api_stopped(self):
        (self.t / 'fail-api-stop').touch()
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('API remains stopped', result.stderr)
        self.assertIn('the API may still be running', result.stderr)

    def test_a_second_activation_gives_up_on_the_lock_after_30_seconds_with_a_message(self):
        result = self.activate(hold_lock=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Another activation holds the deploy lock; gave up after 30 s.', result.stderr)
        self.assertIn('-w 30', (self.t / 'flock.log').read_text())
        self.assertFalse((self.t / 'base/current').exists())
        self.assertFalse(self.staging.exists())
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:deploy_lock_busy'])

    def test_a_failed_dependency_install_leaves_no_staging_directory(self):
        (self.t / 'fail-npm').touch()
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.staging.exists())

    def test_a_failed_migration_reports_its_class_and_never_its_message(self):
        (self.t / 'fail-migrate').touch()
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Activation failed. API remains stopped and application routes remain closed.', result.stderr)
        self.assertIn('Cause class: 55P03.', result.stderr)
        self.assertNotIn('owner_secret', result.stderr)

    def test_a_failed_initial_ingest_names_its_step_without_its_output(self):
        # F7-07-9: the extracts directory belonged to another account, so the ingest could not write.
        (self.t / 'no-geodata').touch()
        (self.t / 'fail-ingest').touch()
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Failed step: initial_ingest.', result.stderr)
        # The API never started, so the monitor must hear of it from the file.
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:activation_initial_ingest'])
        # stop_jobs stopped the monitor timer; the handler starts it again so the token is mailed.
        calls = self.calls()
        self.assertIn('start bor-czuwa-monitor.timer', calls[calls.index('stop jobs'):])
        self.assertEqual(self.calls().count('proxy maintenance'), 2)

    def test_a_missing_candidate_archive_stops_cleanly_with_a_token_and_no_traceback(self):
        (self.t / 'fail-unpack').touch()
        result = self.activate()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), 'Activation stopped before anything was changed; the running release and its routes are untouched. Failed step: unpack_candidate.')
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:activation_unpack_candidate'])
        self.assertFalse(self.staging.exists())

    def test_a_failed_verification_is_refused_once_with_a_fixed_sentence(self):
        (self.t / 'fail-verify').touch()
        result = self.activate()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.count('Release refused: candidate_unverified.'), 1, result.stderr)
        self.assertNotIn('Release blocked', result.stderr)
        self.assertEqual((self.t / 'refusals/startup-refusals').read_text().count('candidate_unverified'), 1)
        self.assertFalse(self.staging.exists())

    def test_a_malformed_settings_line_never_prints_its_credential(self):
        (self.t / 'etc/maintenance.env').write_text('MIGRATION_DATABASE_URL=x\npostgres://owner:canary-pw-81f2@db.example/app\n')
        result = self.activate()
        self.assertIn('Failed step: migrate.', result.stderr)
        for text in [result.stdout, result.stderr, (self.t / 'refusals/startup-refusals').read_text()]:
            self.assertNotIn('canary-pw-81f2', text)

    def test_an_unset_variable_in_the_settings_is_a_refusal_not_a_silent_exit(self):
        (self.t / 'etc/maintenance.env').write_text('MIGRATION_DATABASE_URL=$MISSING_DATABASE_URL_CANARY\n')
        result = self.activate()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Failed step: migrate.', result.stderr)
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:activation_migrate'])
        calls = self.calls()
        self.assertIn('start bor-czuwa-monitor.timer', calls[calls.index('stop jobs'):])

    def test_a_large_file_cannot_smuggle_an_exit_past_the_line_check(self):
        # 200 KB, past the 64 KB pipe buffer: an exit first, then thousands of valid lines. A check that died of SIGPIPE would let it be sourced.
        (self.t / 'etc/maintenance.env').write_text('exit 0\n' + ''.join(f'VALUE_{n}=1\n' for n in range(20000)))
        result = self.activate()
        self.assertGreater((self.t / "etc/maintenance.env").stat().st_size, 200000)
        self.assertIn('Failed step: migrate.', result.stderr)
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:activation_migrate'])

    def test_a_failure_installing_units_does_not_claim_nothing_changed(self):
        (self.t / 'fail-units').touch()
        result = self.activate()
        self.assertIn('Failed step: install_units.', result.stderr)
        self.assertIn('installed but not active', result.stderr)
        self.assertNotIn('before anything was changed', result.stderr)

    def test_a_failed_daemon_reload_records_its_step_and_says_what_changed(self):
        (self.t / 'fail-reload').touch()
        result = self.activate()
        self.assertIn('installed but before it was activated', result.stderr)
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:activation_install_units'])

    def test_a_rejected_candidate_is_one_record_and_one_sentence(self):
        shutil.copy(ROOT / 'ops/production/deployment.py', self.t / 'control/deployment.py')
        shutil.copy(ROOT / 'ops/production/startup_refusals.py', self.t / 'control/startup_refusals.py')
        (self.t / 'real-deployment').touch()
        with zipfile.ZipFile(self.staging / 'verification.zip', 'w') as archive:
            archive.writestr('candidate.json', json.dumps({'releaseCandidate': {
                'mode': 'staging', 'configuration': {'mode': 'staging'}}}))
        result = self.activate()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.count('Release refused:'), 1, result.stderr)
        self.assertIn('Release refused: candidate_not_eligible.', result.stderr)
        self.assertIn('Failed step: candidate_check.', result.stderr)
        lines = (self.t / 'refusals/startup-refusals').read_text().splitlines()
        self.assertEqual([line.split(' ', 1)[1] for line in lines], ['release_refused:candidate_not_eligible'])

    def test_a_failing_line_before_a_valid_assignment_is_still_refused(self):
        pwned = self.t / 'pwned-activation'
        for text in ['postgres://owner:canary-pw-33aa@db.example/app\nMIGRATION_DATABASE_URL=x\n', 'false\nMIGRATION_DATABASE_URL=x\n',
                     'MIGRATION_DATABASE_URL=x; exit 0\n', f'MIGRATION_DATABASE_URL=$(touch {pwned})\n',
                     f'MIGRATION_DATABASE_URL=`touch {pwned}`\n', 'MIGRATION_DATABASE_URL=a&b\n', 'PATH=/tmp\n',
                     f"RANDOM='names[$(touch {pwned})]'\n", f"SECONDS='names[$(touch {pwned})]'\n", 'UID=55\n', 'EUID=1\n',
                     f"LINENO='a[$(touch {pwned})]'\n", 'UNKNOWN_NAME=1\n']:
            (self.t / 'etc/maintenance.env').write_text(text)
            (self.t / 'refusals').exists() and shutil.rmtree(self.t / 'refusals')
            result = self.activate()
            self.assertIn('Failed step: migrate.', result.stderr, text)
            self.assertNotIn('canary-pw-33aa', result.stderr + result.stdout)
            self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:activation_migrate'])
            self.assertFalse(pwned.exists(), text)

    def test_a_failure_sourcing_the_maintenance_settings_is_attributed_to_the_migration_step(self):
        (self.t / 'etc/maintenance.env').write_text('return 1\n')
        result = self.activate()
        self.assertIn('Failed step: migrate.', result.stderr)
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:activation_migrate'])

    def test_each_later_step_names_itself_when_it_fails(self):
        (self.t / 'missing/renewal-hooks/deploy').mkdir(parents=True)
        (self.t / 'fail-start-jobs').touch()
        result = self.activate()
        self.assertIn('Failed step: start_jobs.', result.stderr)
        (self.t / 'fail-start-jobs').unlink()
        (self.t / 'fail-stop-jobs').touch()
        self.assertIn('Failed step: stop_jobs.', self.activate().stderr)

    def test_a_host_without_the_environment_marker_says_which_refusal_it_is(self):
        # The production script on a host that only has the demo environment: no /etc/bor-czuwa.
        (self.t / 'etc/dedicated-host').unlink()
        result = self.activate()
        self.assertEqual(result.returncode, 1)
        self.assertRegex(result.stderr, r'^Release refused: host_not_prepared\. ')
        self.assertFalse(self.staging.exists())
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:host_not_prepared'])

    def test_each_early_refusal_has_its_own_token(self):
        (self.t / 'etc/runtime.env').chmod(0o644)
        self.assertIn('Release refused: host_file_mode.', self.activate().stderr)
        (self.t / 'etc/runtime.env').chmod(0o600)
        (self.t / 'base/releases' / self.COMMIT / 'payload').mkdir(parents=True)
        self.assertIn('Release refused: release_exists.', self.activate().stderr)


class OfflineRollback(unittest.TestCase):
    """The real verifier CLI in a user namespace with no network device, so no GitHub call can succeed."""
    COMMIT = 'c' * 40

    @classmethod
    def setUpClass(cls):
        if subprocess.run(['unshare', '-rn', 'true'], capture_output=True).returncode:
            raise unittest.SkipTest('network namespaces unavailable')

    def setUp(self):
        import hashlib
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.t = t = Path(temporary.name)
        self.release = t / 'release'
        (self.release / 'payload/build').mkdir(parents=True)
        (self.release / 'payload/build/index.html').write_text('<h1>Installed</h1>')
        (self.release / 'payload/installed').touch()
        files = {'build/index.html': hashlib.sha256(b'<h1>Installed</h1>').hexdigest()}
        manifest = json.dumps({'identity': {'sourceCommit': self.COMMIT},
                               'releaseCandidate': {'mode': 'staging', 'files': files}}).encode()
        with zipfile.ZipFile(self.release / 'verification.zip', 'w') as bundle:
            bundle.writestr('candidate.json', manifest)
        self.result = {'sourceCommit': self.COMMIT, 'mode': 'staging', 'action': 'activate', 'artifactSha256': 'd' * 64,
                       'candidateSha256': hashlib.sha256(manifest).hexdigest(),
                       'verificationZipSha256': hashlib.sha256((self.release / 'verification.zip').read_bytes()).hexdigest(),
                       'verificationArtifactId': 1, 'workflowRunId': '2', 'workflowAttempt': 1, 'workflowBranch': 'main'}
        (t / 'policy.json').write_text(json.dumps({'repository': 'owner/repository', 'workflowSha256': 'a' * 64,
                                                   'branches': ['main'], 'environment': 'demo'}))
        (t / 'policy.json').chmod(0o600)

    def node(self, *arguments):
        env = {**os.environ, 'RELEASE_POLICY_PATH': str(self.t / 'policy.json')}
        return subprocess.run(['unshare', '-rn', 'node', str(ROOT / 'scripts/release-candidate.mjs'), *arguments],
                              env=env, capture_output=True, text=True, timeout=60)

    def activate(self):
        outcome = self.node('write-receipt', str(self.release), json.dumps(self.result))
        self.assertEqual(outcome.returncode, 0, outcome.stderr)

    def rollback(self):
        return self.node('verify', str(self.release), 'staging', 'rollback')

    def test_a_release_activated_with_a_receipt_rolls_back_with_no_network(self):
        self.activate()
        outcome = self.rollback()
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        verified = json.loads(outcome.stdout)
        self.assertEqual((verified['sourceCommit'], verified['action']), (self.COMMIT, 'rollback'))
        # The fields deployment.py reads for the demo's rollback authorization are kept.
        self.assertEqual(verified['candidateSha256'], self.result['candidateSha256'])

    def test_a_release_without_a_receipt_still_needs_github(self):
        outcome = self.rollback()
        self.assertEqual(outcome.returncode, 1)
        self.assertRegex(outcome.stderr, r'^Release blocked: ')
        self.assertNotIn('activation receipt', outcome.stderr)

    def test_a_changed_installed_byte_is_refused_by_name(self):
        self.activate()
        (self.release / 'payload/build/index.html').write_text('<h1>Changed</h1>')
        outcome = self.rollback()
        self.assertEqual(outcome.returncode, 1)
        self.assertEqual(outcome.stderr.strip(), 'Release blocked: installed release does not match its activation receipt: build/index.html')

    def test_the_receipt_is_not_an_unlisted_file_of_the_release(self):
        self.activate()
        self.assertTrue((self.release / 'activation-receipt.json').is_file())
        self.assertFalse((self.release / 'payload/activation-receipt.json').exists())
        self.assertEqual(self.rollback().returncode, 0)


class RollbackRefusals(unittest.TestCase):
    """Run rollback.sh in a user namespace; only the host seams are stubbed."""
    COMMIT = 'b' * 40

    @classmethod
    def setUpClass(cls):
        if subprocess.run(['unshare', '-r', 'true'], capture_output=True).returncode:
            raise unittest.SkipTest('user namespaces unavailable')

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.t = t = Path(temporary.name)
        (t / 'bin').mkdir()
        stubs = {'systemctl': 'echo "$*" >> "$T/systemctl.log"\n[ "$1" != is-active ]\n',
                 'runuser': ('shift 3\nif [ -e "$T/db-refuses" ]; then echo "Database check refused: $(cat "$T/db-refuses")." >&2; '
                             'echo "secret $CANARY" >&2; exit 82; fi\nexit 0\n'),
                 'python3': 'case "$1" in */startup_refusals.py) exec /usr/bin/python3 "$@" ;; esac\nexit 0\n', 'flock': 'exit 0\n'}
        for name, body in stubs.items():
            (t / 'bin' / name).write_text('#!/bin/sh\n' + body.replace('$T', str(t)))
            (t / 'bin' / name).chmod(0o755)
        control = t / 'control'
        control.mkdir()
        script = (ROOT / 'ops/production/rollback.sh').read_text().replace('/usr/local/lib/bor-czuwa-release', str(control))
        script = script.replace('/run/lock/bor-czuwa-proxy.lock', str(t / 'proxy.lock'))
        script = script.replace('source "$etc/runtime.env"', 'true')
        (control / 'rollback.sh').write_text(script)
        shutil.copy(ROOT / 'ops/production/startup_refusals.py', control / 'startup_refusals.py')
        (control / 'environment.sh').write_text(ActivationFailurePaths.REFUSE + (
            'refusal_file=$T/refusals/startup-refusals; control=$T/control\n'
            'base=$T/base; etc=$T/etc; eligibility=production; api=bor-czuwa-api; runtime_user=x; lock=$T/deploy.lock\n'
            'verify_candidate() { [ ! -e "$T/fail-verify" ] || { echo "Release blocked: trusted policy missing or unsafe" >&2; return 1; }; echo "{}"; }\nstop_jobs() { :; }\nstart_jobs() { :; }\nready() { :; }\n'
            'publish_proxy() { :; }\n').replace('$T', str(t)))
        (t / 'etc').mkdir()
        (t / 'etc/runtime.env').write_text('')
        (t / 'etc/runtime.env').chmod(0o600)
        self.release = t / 'base/releases' / self.COMMIT
        (self.release / 'payload').mkdir(parents=True)
        (self.release / 'payload/installed').touch()

    def rollback(self):
        env = {**os.environ, 'T': str(self.t), 'PATH': f'{self.t}/bin:{os.environ["PATH"]}', 'CANARY': 'canary-9f3a'}
        return subprocess.run(['unshare', '-r', 'bash', str(self.t / 'control/rollback.sh'), self.COMMIT],
                              env=env, capture_output=True, text=True, timeout=60)

    def test_a_target_that_was_never_installed_names_the_cause(self):
        (self.release / 'payload/installed').unlink()
        result = self.rollback()
        self.assertEqual(result.returncode, 1)
        self.assertRegex(result.stderr, r'^Release refused: not_installed\. ')
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:not_installed'])

    def test_a_malformed_runtime_settings_line_is_a_fixed_refusal_that_never_prints_it(self):
        (self.t / 'etc/runtime.env').write_text('DATABASE_URL=x\npostgres://app:canary-pw-5c0d@db.example/app\n')
        result = self.rollback()
        self.assertEqual(result.returncode, 1)
        self.assertRegex(result.stderr, r'^Release refused: config_unreadable\. ')
        for text in [result.stdout, result.stderr, (self.t / 'refusals/startup-refusals').read_text()]:
            self.assertNotIn('canary-pw-5c0d', text)
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:config_unreadable'])

    def test_an_unset_variable_in_the_runtime_settings_is_a_fixed_refusal(self):
        (self.t / 'etc/runtime.env').write_text('DATABASE_URL=$MISSING_DATABASE_URL_CANARY\n')
        result = self.rollback()
        self.assertRegex(result.stderr, r'^Release refused: config_unreadable\. ')
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:config_unreadable'])

    def test_a_failing_line_before_a_valid_assignment_is_refused(self):
        pwned = self.t / 'pwned-rollback'
        for text in ['postgres://app:canary-pw-77bb@db.example/app\nDATABASE_URL=x\n', 'false\nDATABASE_URL=x\n',
                     'DATABASE_URL=x; exit 0\n', f'DATABASE_URL=$(touch {pwned})\n', 'DATABASE_URL=a|b\n',
                     f"RANDOM='names[$(touch {pwned})]'\n", 'UID=55\n', 'EUID=1\n', 'UNKNOWN_NAME=1\n']:
            (self.t / 'etc/runtime.env').write_text(text)
            result = self.rollback()
            self.assertRegex(result.stderr, r'^Release refused: config_unreadable\. ', text)
            self.assertNotIn('canary-pw-77bb', result.stderr + result.stdout)
            self.assertFalse(pwned.exists(), text)

    def test_a_large_file_cannot_smuggle_an_exit_past_the_line_check(self):
        (self.t / 'etc/runtime.env').write_text('exit 0\n' + ''.join(f'VALUE_{n}=1\n' for n in range(20000)))
        result = self.rollback()
        self.assertRegex(result.stderr, r'^Release refused: config_unreadable\. ')

    def test_a_missing_runtime_settings_file_is_a_fixed_refusal_without_a_stat_error(self):
        (self.t / 'etc/runtime.env').unlink()
        result = self.rollback()
        self.assertRegex(result.stderr, r'^Release refused: host_file_mode\. ')
        self.assertNotIn('stat', result.stderr)
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:host_file_mode'])

    def test_a_failed_verification_is_refused_once_and_its_message_is_not_shown(self):
        (self.t / 'fail-verify').touch()
        result = self.rollback()
        self.assertEqual(result.stderr.count('Release refused: candidate_unverified.'), 1, result.stderr)
        self.assertNotIn('Release blocked', result.stderr)

    def test_an_incompatible_database_says_the_running_release_is_unchanged(self):
        (self.t / 'db-refuses').write_text('ledger_newer_than_application')
        result = self.rollback()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.strip(),
                         'Rollback refused: database not compatible (ledger_newer_than_application). '
                         'The running release is unchanged.')
        self.assertNotIn('canary', result.stderr)
        self.assertNotIn('API remains stopped', result.stderr)
        # The refusal reaches the monitor as an event, not only the terminal.
        self.assertEqual(startup_refusals.recent(self.t / 'refusals/startup-refusals'), ['release_refused:database_incompatible'])
        calls = (self.t / 'systemctl.log').read_text() if (self.t / 'systemctl.log').exists() else ''
        self.assertNotIn('stop', calls)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


startup_refusals = load('startup_refusals', 'ops/production/startup_refusals.py') \
    if (ROOT / 'ops/production/startup_refusals.py').exists() else None


class StartupRefusalRecord(unittest.TestCase):
    """The root-written token file and the monitor event that reads it."""
    NOW = datetime(2026, 11, 13, 21, 4, 59, tzinfo=timezone.utc)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        # The token file sits in a root-owned sibling of the monitor's state directory, never inside it.
        self.file = self.directory / 'refusals' / 'startup-refusals'
        (self.directory / 'monitor').mkdir()
        self.file.parent.mkdir()

    def test_the_status_table_is_the_one_the_api_exits_with(self):
        if not (ROOT / 'node_modules/tsx').exists():
            self.skipTest('dependencies not installed')
        printed = subprocess.run(['node', '--import', 'tsx', '-e',
            "import('./server/startup-check.ts').then(m => console.log(JSON.stringify(Object.entries(m.startupRefusals)"
            ".map(([token, row]) => [row.exit, token, row.retry]))))"],
            cwd=ROOT, capture_output=True, text=True, check=True).stdout
        table = json.loads(printed)
        self.assertEqual({exit: token for exit, token, _ in table}, startup_refusals.TOKENS)
        # The unit stops restarting for exactly the statuses that cannot clear by themselves.
        unit = (ROOT / 'ops/production/bor-czuwa-api.service').read_text()
        # A list, not a range: systemd silently ignores a range here (measured on systemd 259).
        stops = re.search(r'^RestartPreventExitStatus=(\d+(?: \d+)*)$', unit, re.M).group(1).split()
        self.assertEqual({str(exit) for exit, _, retry in table if not retry}, set(stops))

    def test_an_impossible_timestamp_is_skipped_and_the_monitor_run_goes_on(self):
        self.file.write_text('2026-99-99T99:99Z startup_refused:geodata_missing\n'
                             f'{datetime.now(timezone.utc):%Y-%m-%dT%H:%MZ} startup_refused:geodata_empty\n')
        self.assertEqual(self.events()['events'], ['startup_refused:geodata_empty'])

    def test_a_token_stamped_in_the_future_expires_after_a_backward_clock_correction(self):
        now = datetime.now(timezone.utc)
        startup_refusals.record(self.file, 85, now + timedelta(hours=2))
        self.assertEqual(self.events()['events'], [])
        self.file.unlink()
        startup_refusals.record(self.file, 85, now + timedelta(minutes=1))
        self.assertEqual(self.events()['events'], ['startup_refused:geodata_missing'])

    def test_a_directory_another_account_can_write_is_refused(self):
        self.file.parent.chmod(0o777)
        with self.assertRaises(PermissionError):
            startup_refusals.record(self.file, 85, self.NOW)
        self.assertFalse(self.file.exists())

    def test_concurrent_writers_all_land(self):
        script = ("import importlib.util, sys\n"
                  "spec = importlib.util.spec_from_file_location('m', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
                  "m.record_release(sys.argv[2], sys.argv[3])\n")
        tokens = sorted(startup_refusals.RELEASE_TOKENS)[:24]
        workers = [subprocess.Popen(['python3', '-c', script, str(ROOT / 'ops/production/startup_refusals.py'), str(self.file), token])
                   for token in tokens]
        self.assertEqual([worker.wait() for worker in workers], [0] * len(tokens))
        self.assertEqual({f'release_refused:{token}' for token in tokens}, set(startup_refusals.recent(self.file)))
        self.assertEqual([p.name for p in self.file.parent.iterdir() if p.name.startswith('.startup-refusals.') and p.suffix != '.lock'], [])

    def test_release_refusals_reach_the_monitor_as_their_own_events(self):
        startup_refusals.record_release(self.file, 'other_commit', datetime.now(timezone.utc))
        startup_refusals.record_release(self.file, 'not_a_listed_token', datetime.now(timezone.utc))
        self.assertEqual(self.events()['events'], ['release_refused:other_commit'])

    def test_every_token_the_scripts_and_deployment_can_print_is_recordable(self):
        sh = (ROOT / 'ops/production/environment.sh').read_text()
        shell = set(re.findall(r'^    ([a-z_]+)\) text=', sh, re.M)) - {'*'}
        self.assertTrue({'not_installed', 'host_not_prepared', 'release_exists'} <= shell)
        scripts = ''.join((ROOT / 'ops/production' / name).read_text() for name in ['activate.sh', 'rollback.sh'])
        known = shell | set(deployment.REFUSALS) | {'database_incompatible', 'command_failed'} | set(re.findall(r'record_refusal ([a-z_]+)', scripts))
        self.assertEqual(known - startup_refusals.RELEASE_TOKENS, set())

    def test_a_refusal_writes_one_fixed_line_and_nothing_else(self):
        startup_refusals.record(self.file, 84, self.NOW)
        self.assertEqual(self.file.read_text(), '2026-11-13T21:04Z startup_refused:rule_set_changed\n')
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o644)

    def test_an_unlisted_status_writes_nothing(self):
        for status in [0, 1, 143, 200, 98]:
            startup_refusals.record(self.file, status, self.NOW)
        self.assertFalse(self.file.exists())

    def test_the_file_keeps_only_the_last_50_lines(self):
        # Root-owned lines only are carried forward, so this runs as (fake) root.
        script = ("import importlib.util, sys\nfrom datetime import datetime, timedelta, timezone\n"
                  "spec = importlib.util.spec_from_file_location('m', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
                  "now = datetime(2026, 11, 13, 21, 4, tzinfo=timezone.utc)\n"
                  "for minute in range(60): m.record(sys.argv[2], 94, now + timedelta(minutes=minute))\n")
        subprocess.run(['python3', '-c', script, str(ROOT / 'ops/production/startup_refusals.py'), str(self.file)], check=True)
        lines = self.file.read_text().splitlines()
        self.assertEqual(len(lines), 50)
        self.assertTrue(lines[-1].startswith('2026-11-13T22:03Z'))

    def test_a_planted_link_is_replaced_not_written_through(self):
        victim = self.directory / 'victim'
        victim.write_text('untouched\n')
        self.file.symlink_to(victim)
        startup_refusals.record(self.file, 85, self.NOW)
        self.assertEqual(victim.read_text(), 'untouched\n')
        self.assertFalse(self.file.is_symlink())

    def test_text_that_is_not_a_fixed_line_is_never_kept_or_reported(self):
        self.file.write_text('2026-11-13T21:00Z startup_refused:geodata_missing password=hunter2\n'
                             '2026-11-13T21:00Z startup_refused:not_in_the_table\n'
                             '2026-11-13T21:01Z startup_refused:geodata_empty\n')
        self.assertEqual(startup_refusals.recent(self.file, self.NOW), ['startup_refused:geodata_empty'])

    def test_the_stop_hook_records_only_a_main_process_exit(self):
        environment = {**os.environ, 'SERVICE_RESULT': 'exit-code', 'EXIT_CODE': 'exited', 'EXIT_STATUS': '86'}
        run = lambda env: subprocess.run(['python3', str(ROOT / 'ops/production/startup_refusals.py'), 'record', str(self.file)],
                                         env=env, capture_output=True, text=True)
        self.assertEqual(run(environment).returncode, 0)
        self.assertIn('startup_refused:geodata_schema_missing', self.file.read_text())
        self.file.unlink()
        for override in [{'SERVICE_RESULT': 'success'}, {'EXIT_CODE': 'killed'}, {'EXIT_STATUS': 'SIGTERM'}]:
            run({**environment, **override})
        self.assertFalse(self.file.exists())

    def events(self):
        with patch.dict(os.environ, {'STATE_DIRECTORY': str(self.directory / 'monitor')}), \
                patch('urllib.request.urlopen', side_effect=lambda *a, **k: io.BytesIO(json.dumps(
                    {'status': 'ok', 'terminal_failures': 0, 'integrity_terminal_failures': 0}).encode())), \
                patch('subprocess.run', return_value=Mock(returncode=1)):
            return runpy.run_path(str(ROOT / 'ops/production/monitor.py'))['events']()

    def test_the_monitor_mails_a_refusal_once_and_recovers_when_it_ages_out(self):
        monitor = runpy.run_path(str(ROOT / 'ops/production/monitor.py'))
        now = datetime.now(timezone.utc)
        startup_refusals.record(self.file, 85, now - timedelta(minutes=1))
        first = self.events()
        self.assertEqual(first['events'], ['startup_refused:geodata_missing'])
        # The same event on the next minute's run: no second mail.
        self.assertFalse(monitor['should_alert'](self.events(), first))
        # Past the window the token is gone, so the monitor reports recovery once.
        self.file.unlink()
        startup_refusals.record(self.file, 85, now - timedelta(minutes=45))
        later = self.events()
        self.assertEqual(later['events'], [])
        self.assertTrue(monitor['should_alert'](later, first))

    def test_a_missing_file_or_an_old_state_file_changes_nothing(self):
        self.assertEqual(self.events()['events'], [])


class SettingsParser(unittest.TestCase):
    LOAD_ENV = re.search(r'(?ms)^load_env\(\) \{.*?^\}\n', (ROOT / 'ops/production/environment.sh').read_text()).group(0)

    def load(self, text, *names):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'f.env').write_text(text)
            script = self.LOAD_ENV + 'set -euo pipefail\nload_env "$1" || { echo REJECTED; exit 3; }\n' + \
                ''.join(f'printf "%s\\n" "${{{name}}}"\n' for name in names)
            return subprocess.run(['bash', '-c', script, 'x', str(Path(directory) / 'f.env')], capture_output=True, text=True)

    def test_the_files_the_scripts_write_still_load_literally(self):
        # bootstrap-demo.py writes shlex.quote(value) lines; the runbook's examples are NAME= with a plain or quoted value.
        owner = 'postgresql:///bor_czuwa_demo?host=/var/run/postgresql&user=bor_czuwa_demo_owner'
        runtime = 'postgresql://bor_czuwa_demo_runtime:' + 'ab' * 32 + '@127.0.0.1:5432/bor_czuwa_demo'
        text = ''.join(key + '=' + shlex.quote(value) + '\n' for key, value in
                       {'MIGRATION_DATABASE_URL': owner, 'DATABASE_URL': runtime, 'RUNTIME_DB_ROLE': 'bor_czuwa_demo_runtime'}.items())
        result = self.load(text + '# a comment\n\nRESTIC_REPOSITORY=\nRESTIC_PASSWORD_FILE="two words"\n', 'MIGRATION_DATABASE_URL', 'DATABASE_URL', 'RUNTIME_DB_ROLE', 'RESTIC_REPOSITORY', 'RESTIC_PASSWORD_FILE')
        self.assertEqual(result.stdout.splitlines(), [owner, runtime, 'bor_czuwa_demo_runtime', '', 'two words'])

    def test_a_quoted_value_is_data_even_when_it_looks_like_shell(self):
        result = self.load("DATABASE_URL='x; exit 0 $(id) `id` | &'\n", 'DATABASE_URL')
        self.assertEqual(result.stdout.strip(), 'x; exit 0 $(id) `id` | &')

    def test_nothing_that_could_run_is_accepted(self):
        for text in ['DATABASE_URL=x; exit 0\n', 'DATABASE_URL=$(id)\n', 'DATABASE_URL=`id`\n', 'DATABASE_URL=$B\n', 'DATABASE_URL="$B"\n',
                     'DATABASE_URL=a&b\n', 'DATABASE_URL=a|b\n', 'exit 0\n', 'DATABASE_URL=x\nexit 0\n', "DATABASE_URL='unclosed\n",
                     'export DATABASE_URL=x\n']:
            result = self.load(text, 'DATABASE_URL')
            self.assertEqual(result.stdout.strip(), 'REJECTED', text)
            self.assertEqual(result.returncode, 3, text)

    def test_only_the_names_these_files_carry_are_accepted(self):
        marker = Path(tempfile.mkdtemp()) / 'executed'
        # Assigning to some shell variables evaluates the value (RANDOM, SECONDS, LINENO...) or errors (UID, EUID).
        for text in [f"RANDOM='names[$(touch {marker})]'\n", f"SECONDS='names[$(touch {marker})]'\n", f"LINENO='a[$(touch {marker})]'\n",
                     'UID=55\n', 'EUID=1\n', 'PATH=/tmp\n', 'LD_PRELOAD=/x\n', 'BASH_ENV=/x\n', 'IFS=x\n', 'SOMETHING_ELSE=1\n',
                     'database_url=x\n']:
            result = self.load(text, 'DATABASE_URL')
            self.assertEqual(result.stdout.strip(), 'REJECTED', text)
            self.assertFalse(marker.exists(), text)
            self.assertEqual(result.stderr, '', text)
        self.assertEqual(self.load('RUNTIME_DB_ROLE=bor_czuwa_demo_runtime\n', 'RUNTIME_DB_ROLE').stdout.strip(), 'bor_czuwa_demo_runtime')


class DemoEnvironment(unittest.TestCase):
    def test_the_demo_configuration_refusal_is_recorded_under_the_demo_path(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / 'bin').mkdir()
            (directory / 'bin/python3').write_text(f'#!/bin/sh\necho "$BOR_CZUWA_REFUSAL_FILE" > {directory}/seen\nexit 1\n')
            (directory / 'bin/python3').chmod(0o755)
            subprocess.run(['bash', '-c', 'set -e; environment=demo; control=/nowhere; source "$1"', 'x',
                            str(ROOT / 'ops/production/environment.sh')],
                           env={**os.environ, 'PATH': f'{directory}/bin:{os.environ["PATH"]}'}, capture_output=True)
            self.assertEqual((directory / 'seen').read_text().strip(), '/var/lib/bor-czuwa-demo/refusals/startup-refusals')


class RefusalSentences(unittest.TestCase):
    """deployment.py and bootstrap-demo.py print a fixed token, never an exception, path or value."""
    def run_deployment(self, *args, files=None):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            etc = directory / 'etc'
            etc.mkdir()
            for name, text in (files or {}).items():
                (etc / name).write_text(text)
                (etc / name).chmod(0o600)
            source = (ROOT / 'ops/production/deployment.py').read_text().replace("Path('/etc/bor-czuwa-demo')", f"Path('{etc}')")
            (directory / 'deployment.py').write_text(source)
            shutil.copy(ROOT / 'ops/production/startup_refusals.py', directory / 'startup_refusals.py')
            result = subprocess.run(['unshare', '-r', 'python3', str(directory / 'deployment.py'), *args],
                                    capture_output=True, text=True, cwd=directory,
                                    env={**os.environ, 'BOR_CZUWA_REFUSAL_FILE': str(directory / 'refusals/startup-refusals')})
            result.recorded = startup_refusals.recent(directory / 'refusals/startup-refusals')
            return result

    @classmethod
    def setUpClass(cls):
        if subprocess.run(['unshare', '-r', 'true'], capture_output=True).returncode:
            raise unittest.SkipTest('user namespaces unavailable')

    RECEIPT = json.dumps({'sourceCommit': 'a' * 40, 'candidateSha256': 'b' * 64})
    GOOD = {'sourceCommit': 'a' * 40, 'candidateSha256': 'b' * 64, 'indexedDbCompatible': True, 'backups': 'off',
            'authorization': 'Owner approved this fictional-data rollback'}

    def rollback(self, **changes):
        authorization = {**self.GOOD, **changes}
        return self.run_deployment('rollback', '/x', self.RECEIPT, files={
            'rollback-authorization.json': json.dumps({k: v for k, v in authorization.items() if v != 'drop'})})

    def test_the_four_rollback_refusals_and_the_missing_file_are_distinct(self):
        sentences = {}
        for label, result in [
                ('no_authorization', self.run_deployment('rollback', '/x', self.RECEIPT)),
                ('other_commit', self.rollback(sourceCommit='c' * 40)),
                ('other_candidate', self.rollback(candidateSha256='d' * 64)),
                ('indexeddb_incompatible', self.rollback(indexedDbCompatible=False))]:
            self.assertEqual(result.returncode, 1, label)
            self.assertRegex(result.stderr, rf'^Release refused: {label}\. ')
            sentences[label] = result.stderr
        self.assertEqual(len(set(sentences.values())), 4)
        # Each refusal also reaches the monitor, as a fixed event.
        self.assertEqual(self.run_deployment('rollback', '/x', self.RECEIPT).recorded, ['release_refused:no_authorization'])
        self.assertEqual(self.rollback().returncode, 0)

    def test_a_rollback_authorization_of_the_wrong_shape_is_a_fixed_refusal(self):
        for text in ['[]', '"x"', '3']:
            result = self.run_deployment('rollback', '/x', self.RECEIPT, files={'rollback-authorization.json': text})
            self.assertRegex(result.stderr, r'^Release refused: config_invalid\. ', text)

    def test_a_config_value_never_reaches_the_terminal(self):
        result = self.run_deployment('shell', files={
            'deployment.json': json.dumps({'domain': 'secret-canary.invalid!', 'certificateName': 'x',
                                           'demoTestRecipient': 'a@b.example'})})
        self.assertRegex(result.stderr, r'^Release refused: config_invalid\. ')
        self.assertNotIn('secret-canary', result.stderr)

    def test_a_config_of_the_wrong_shape_is_a_token_not_a_traceback(self):
        for text in ['[]', '"x"', '{"domain": 5, "certificateName": "x", "demoTestRecipient": "a@b.example"}',
                     '{"domain": "a.example", "certificateName": ["x"], "demoTestRecipient": "a@b.example"}']:
            result = self.run_deployment('shell', files={'deployment.json': text})
            self.assertRegex(result.stderr, r'^Release refused: config_invalid\. ', text)
            self.assertNotIn('Traceback', result.stderr)

    def test_a_demo_call_without_its_private_config_names_the_file_class(self):
        result = self.run_deployment('shell')
        self.assertRegex(result.stderr, r'^Release refused: config_missing\. ')

    def test_a_missing_certificate_is_a_fixed_token_not_a_usage_error(self):
        # Reach the certificate guard with the host seams faked: root, installed path, Ubuntu 26.04, no certificate.
        source = (ROOT / 'ops/production/bootstrap-demo.py').read_text()
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / 'deployment.py').write_text((ROOT / 'ops/production/deployment.py').read_text())
            shutil.copy(ROOT / 'ops/production/startup_refusals.py', directory / 'startup_refusals.py')
            prelude = ("import os, sys\nfrom pathlib import Path\nimport fcntl\n"
                       "os.geteuid = lambda: 0\nfcntl.flock = lambda *a: None\n"
                       "_open = os.open\nos.open = lambda p, *a, **k: _open('/dev/null', os.O_RDONLY) if 'deploy.lock' in str(p) else _open(p, *a, **k)\n"
                       f"_rt = Path.read_text\nPath.read_text = lambda self, *a, **k: 'ID=ubuntu\\nVERSION_ID=\"26.04\"\\n' if str(self) == '/etc/os-release' else _rt(self, *a, **k)\n"
                       "import deployment\ndeployment.demo_config = lambda p=None: {'domain': 'x.example', 'certificateName': 'nocert'}\n"
                       "__file__ = '/usr/local/lib/bor-czuwa-release/bootstrap-demo.py'\n")
            (directory / 'run.py').write_text(prelude + "exec(compile(open('bootstrap-demo.py').read().replace('Path(__file__).resolve()', 'Path(\\'/usr/local/lib/bor-czuwa-release/bootstrap-demo.py\\')'), 'b', 'exec'))\n")
            (directory / 'bootstrap-demo.py').write_text(source)
            result = subprocess.run(['python3', 'run.py', 'cfg.json'], capture_output=True, text=True, cwd=directory)
        self.assertEqual(result.stderr.strip(), 'Demo bootstrap failed: certificate_missing.', result.stderr)
        self.assertEqual(result.returncode, 1)

    def test_demo_bootstrap_prints_a_token_never_the_exception(self):
        # main() needs the installed host, so the failure is raised where main() would be called.
        source = (ROOT / 'ops/production/bootstrap-demo.py').read_text()
        self.assertEqual(source.count('        main()\n'), 1)
        for raised, token in [("OSError('/secret/path canary')", 'file_access'), ("ValueError('canary value')", 'config_invalid'),
                              ("subprocess.CalledProcessError(1, 'canary')", 'command_failed'),
                              ("Refusal('config_missing')", 'config_missing'), ("AttributeError('canary')", 'unclassified')]:
            with tempfile.TemporaryDirectory() as directory:
                (Path(directory) / 'deployment.py').write_text((ROOT / 'ops/production/deployment.py').read_text())
                shutil.copy(ROOT / 'ops/production/startup_refusals.py', Path(directory) / 'startup_refusals.py')
                (Path(directory) / 'bootstrap-demo.py').write_text(
                    source.replace('        main()\n', f'        raise {raised}\n').replace('import DEMO_ETC, demo_config', 'import DEMO_ETC, demo_config, Refusal'))
                result = subprocess.run(['python3', 'bootstrap-demo.py'], capture_output=True, text=True, cwd=directory)
            self.assertEqual(result.stderr.strip(), f'Demo bootstrap failed: {token}.')
            self.assertEqual(result.returncode, 1)


class MigrationFailureClass(unittest.TestCase):
    def test_a_failed_migration_prints_a_class_line_beside_the_error(self):
        if not (ROOT / 'node_modules/tsx').exists():
            self.skipTest('dependencies not installed')
        result = subprocess.run(['node', '--import', 'tsx', 'server/migrate.ts'], cwd=ROOT, capture_output=True, text=True,
                                env={**os.environ, 'MIGRATION_DATABASE_URL': 'postgresql://x@127.0.0.1:1/x',
                                     'RUNTIME_DB_PASSWORD': 'x'})
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr, r'(?m)^Failure class: [0-9A-Za-z]{1,40}$')


class MonitorFixes(unittest.TestCase):
    """Ticket 33: the monitor reads its names from the environment, never loses a healed outage, and watches the certificate."""
    SCRIPT = str(ROOT / 'ops/production/monitor.py')
    OK = {'health': {'status': 'ok'}, 'ready': {'status': 'ready'},
          'worker-status': {'status': 'ok', 'terminal_failures': 0, 'integrity_terminal_failures': 0}}
    MAIL_ENV = {'ALERT_FROM': 'a@example.test', 'ALERT_TO': 'b@example.test', 'SMTP_HOST': 'smtp.example.test',
                'SMTP_PORT': '587', 'SMTP_USER': 'u', 'SMTP_PASSWORD': 'p'}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        # monitor.py sets umask 077 for its own process; in-process runs must not leak it into later tests.
        previous = os.umask(0o022)
        os.umask(previous)
        self.addCleanup(os.umask, previous)
        self.mails = []
        self.urls = []

    def answer(self, routes):
        def urlopen(url, timeout=None):
            self.urls.append(url)
            value = routes[url.rsplit('/', 1)[1]]
            if isinstance(value, Exception):
                raise value
            return io.BytesIO(json.dumps(value).encode())
        return urlopen

    def smtp(self, up):
        mails = self.mails
        class Fake:
            def __init__(self, *args, **kwargs):
                if not up:
                    raise OSError('connection refused: /secret/path')
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def starttls(self, **kwargs): pass
            def login(self, *args): pass
            def send_message(self, message): mails.append(message.get_content().strip().split('\n'))
        return Fake

    def run_once(self, routes=None, mail_up=True, failed=(), env=None, check=False):
        """One monitor run as systemd would start it; returns what main raised, or None, or the --check output."""
        routes = {**self.OK, **(routes or {})}
        def systemctl(command, **kwargs):
            return Mock(returncode=0 if command[-1] in failed else 1)
        output = io.StringIO()
        ambient = {key: value for key, value in os.environ.items() if not key.startswith('MONITOR_')}
        with patch.dict(os.environ, {**ambient, **self.MAIL_ENV, 'STATE_DIRECTORY': str(self.state), **(env or {})}, clear=True), \
                patch('sys.argv', [self.SCRIPT] + (['--check'] if check else [])), \
                patch('urllib.request.urlopen', side_effect=self.answer(routes)), \
                patch('subprocess.run', side_effect=systemctl), \
                patch('smtplib.SMTP', self.smtp(mail_up)), \
                contextlib.redirect_stdout(output):
            try:
                runpy.run_path(self.SCRIPT, run_name='__main__')
            except SystemExit as stopped:
                if check:
                    return json.loads(output.getvalue())
                return stopped.code
        return None

    def events(self, routes=None, **kwargs):
        return self.run_once(routes, check=True, **kwargs)['events']

    DOWN = {'health': OSError('refused')}

    def test_an_outage_that_healed_while_mail_was_down_is_mailed_with_the_first_delivery(self):
        self.assertEqual(self.run_once(self.DOWN, mail_up=False), 'Operator alert delivery failed.')
        self.run_once(mail_up=False)
        self.assertEqual(self.mails, [])
        self.assertIsNone(self.run_once())
        self.assertEqual(len(self.mails), 1)
        self.assertEqual(self.mails[0], ['api_down', 'Runtime recovered.'])
        self.run_once()
        self.assertEqual(len(self.mails), 1)

    def test_a_second_outage_that_began_and_cleared_after_a_delivery_is_not_lost(self):
        self.run_once(self.DOWN)
        self.assertEqual(self.mails, [['api_down']])
        self.run_once(mail_up=False)
        self.run_once(self.DOWN, mail_up=False)
        self.run_once(mail_up=False)
        self.run_once()
        self.assertEqual(self.mails[1:], [['api_down', 'Runtime recovered.']])

    def test_two_healed_events_arrive_in_one_mail(self):
        self.run_once(self.DOWN, mail_up=False, failed={'geodata-refresh.service'})
        self.run_once(mail_up=False)
        self.run_once()
        self.assertEqual(len(self.mails), 1)
        self.assertEqual(set(self.mails[0]), {'api_down', 'geodata-refresh_failed', 'Runtime recovered.'})

    def test_an_event_still_present_when_mail_returns_is_mailed_once(self):
        self.run_once(self.DOWN, mail_up=False)
        self.run_once(self.DOWN)
        self.assertEqual(self.mails, [['api_down']])
        self.run_once(self.DOWN)
        self.assertEqual(len(self.mails), 1)
        self.run_once()
        self.assertEqual(self.mails[-1], ['Runtime recovered.'])

    def test_a_delivered_recovery_is_still_one_plain_line(self):
        self.run_once(self.DOWN)
        self.run_once()
        self.assertEqual(self.mails, [['api_down'], ['Runtime recovered.']])

    def test_state_files_from_the_old_monitor_are_read(self):
        for old, mails in [(['api_down'], 1), ({'events': ['api_down'], 'failure_counts': [0, 0]}, 1),
                           ({'events': [], 'failure_counts': [0, 0]}, 0), ([], 0)]:
            with self.subTest(old=old):
                self.mails.clear()
                (self.state / 'monitor-state').write_text(json.dumps(old) + '\n')
                self.assertIsNone(self.run_once())
                self.assertEqual(len(self.mails), mails)

    def test_ports_and_unit_names_come_from_the_environment(self):
        demo = {'MONITOR_API_PORT': '3002', 'MONITOR_REFRESH_UNIT': 'bor-czuwa-demo-geodata-refresh.service',
                'MONITOR_DIGEST_UNIT': 'bor-czuwa-demo-integrity-digest.service'}
        self.assertEqual(self.events(failed={'bor-czuwa-demo-geodata-refresh.service'}, env=demo), ['geodata-refresh_failed'])
        self.assertEqual(self.events(failed={'bor-czuwa-demo-integrity-digest.service'}, env=demo), ['integrity-digest_failed'])
        self.assertTrue(self.urls and all(':3002/' in url for url in self.urls[-3:]))
        # An old monitor.env sets none of them: production names and port apply.
        self.urls.clear()
        self.assertEqual(self.events(failed={'integrity-digest.service'}), ['integrity-digest_failed'])
        self.assertTrue(all(':3001/' in url for url in self.urls))

    def test_the_demo_unit_carries_the_demo_values_and_the_production_unit_stays_as_it_was(self):
        units = Path(self.tmp.name) / 'units'
        target = Path(self.tmp.name) / 'systemd'
        units.mkdir(), target.mkdir()
        shutil.copy(ROOT / 'ops/production/bor-czuwa-monitor.service', units)
        config = {'domain': 'demo.example', 'certificateName': 'demo', 'demoTestRecipient': 'a@example.test'}
        with patch.object(deployment, 'UNIT_DIR', target), patch.object(deployment, 'demo_config', return_value=config):
            deployment.install_units(self.tmp.name, 'demo')
            demo = (target / 'bor-czuwa-demo-monitor.service').read_text()
            deployment.install_units(self.tmp.name, 'production')
            production = (target / 'bor-czuwa-monitor.service').read_text()
        for line in ['Environment=MONITOR_REFRESH_UNIT=bor-czuwa-demo-geodata-refresh.service',
                     'Environment=MONITOR_DIGEST_UNIT=bor-czuwa-demo-integrity-digest.service',
                     'Environment=MONITOR_CERT_HOST=demo.example', 'Environment=MONITOR_CERT_MIN_DAYS=2',
                     'StateDirectory=bor-czuwa-demo/monitor']:
            self.assertIn(line, demo)
        self.assertNotIn('MONITOR_', production)

    def test_a_stopped_database_is_one_event(self):
        stopped = {'ready': OSError('refused'), 'worker-status': OSError('refused')}
        self.assertEqual(self.events(stopped), ['database_unavailable'])

    def test_missing_geodata_is_its_own_event_not_a_database_outage(self):
        body = io.BytesIO(b'{"error":"geodata_unavailable"}')
        refused = urllib.error.HTTPError('http://127.0.0.1:3001/api/ready', 503, 'x', {}, body)
        self.assertEqual(self.events({'ready': refused}), ['geodata_unavailable'])

    def test_a_refusing_report_ceiling_is_its_own_event(self):
        # Viral growth and a flood look alike from here, so the owner hears about it and decides.
        busy = {'status': 'ok', 'terminal_failures': 0, 'integrity_terminal_failures': 0, 'report_ceiling_active': True}
        self.assertEqual(self.events({'worker-status': busy}), ['report_ceiling_reached'])
        self.assertEqual(self.events({'worker-status': {**busy, 'report_ceiling_active': False}}), [])

    def test_worker_stale_needs_a_stale_answer_or_a_failed_route_while_the_api_is_ready(self):
        stale = {'status': 'stale', 'terminal_failures': 0, 'integrity_terminal_failures': 0}
        self.assertEqual(self.events({'worker-status': stale}), ['worker_stale'])
        self.assertEqual(self.events({'worker-status': OSError('refused')}), ['worker_stale'])

    def certificate(self, days, trusted=True):
        pem = Path(self.tmp.name) / f'{days}.pem'
        key = Path(self.tmp.name) / f'{days}.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', str(days), '-subj', '/CN=localhost',
                        '-addext', 'subjectAltName=DNS:localhost', '-keyout', str(key), '-out', str(pem)],
                       check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(pem, key)
        server = socket.socket()
        server.bind(('127.0.0.1', 0))
        server.listen(5)
        def serve():
            while True:
                try:
                    connection, _ = server.accept()
                    context.wrap_socket(connection, server_side=True).close()
                except Exception:
                    if server.fileno() == -1:
                        return
        threading.Thread(target=serve, daemon=True).start()
        self.addCleanup(server.close)
        real = ssl.create_default_context
        patcher = patch('ssl.create_default_context', side_effect=lambda *a, **k: real(cafile=str(pem) if trusted else None))
        patcher.start()
        self.addCleanup(patcher.stop)
        return {'MONITOR_CERT_HOST': 'localhost', 'MONITOR_CERT_CONNECT': '127.0.0.1',
                'MONITOR_CERT_PORT': str(server.getsockname()[1])}

    def test_a_certificate_close_to_expiry_raises_one_fixed_event(self):
        soon = self.certificate(1)
        self.assertEqual(self.events(env={**soon, 'MONITOR_CERT_MIN_DAYS': '2'}), ['certificate_expiring'])
        self.assertEqual(self.events(env={**soon, 'MONITOR_CERT_MIN_DAYS': '1.5'}), ['certificate_expiring'])
        self.assertEqual(self.events(env={**soon, 'MONITOR_CERT_MIN_DAYS': '0.5'}), [])

    def test_a_certificate_that_does_not_validate_alerts_whatever_the_threshold(self):
        untrusted = self.certificate(60, trusted=False)
        for threshold in ['14', '2', '0', '-3', 'soon']:
            with self.subTest(threshold=threshold):
                self.assertEqual(self.events(env={**untrusted, 'MONITOR_CERT_MIN_DAYS': threshold}), ['certificate_expiring'])

    def test_a_nonpositive_threshold_falls_back_to_the_default_instead_of_silencing_the_check(self):
        soon = self.certificate(10)
        for threshold in ['0', '-1', 'soon']:
            with self.subTest(threshold=threshold):
                self.assertEqual(self.events(env={**soon, 'MONITOR_CERT_MIN_DAYS': threshold}), ['certificate_expiring'])

    def test_an_unreadable_state_file_does_not_silence_alerts(self):
        for broken in ['', '{"events": ["api_d', 'null', '42', '{"events": 3}']:
            with self.subTest(broken=broken):
                self.mails.clear()
                (self.state / 'monitor-state').write_text(broken)
                self.assertIsNone(self.run_once(self.DOWN))
                self.assertEqual(self.mails, [['api_down']])
                self.assertEqual(json.loads((self.state / 'monitor-state').read_text())['events'], ['api_down'])

    def test_a_write_that_cannot_finish_leaves_the_previous_state_file_whole(self):
        self.run_once(self.DOWN)
        before = (self.state / 'monitor-state').read_text()
        with patch('os.replace', side_effect=OSError('stopped')):
            with self.assertRaises(OSError):
                self.run_once()
        self.assertEqual((self.state / 'monitor-state').read_text(), before)

    def test_an_explicit_stale_answer_is_reported_unless_the_database_is_down(self):
        stale = {'status': 'stale', 'terminal_failures': 0, 'integrity_terminal_failures': 0}
        geodata = urllib.error.HTTPError('http://127.0.0.1:3001/api/ready', 503, 'x', {}, io.BytesIO(b'{"error":"geodata_unavailable"}'))
        self.assertEqual(self.events({'ready': geodata, 'worker-status': stale}), ['geodata_unavailable', 'worker_stale'])
        self.assertEqual(self.events({'ready': OSError('refused'), 'worker-status': stale}), ['database_unavailable'])
        self.assertEqual(self.events({'ready': OSError('refused'), 'worker-status': OSError('refused')}), ['database_unavailable'])

    def test_an_event_is_named_once_even_when_the_worker_answer_is_both_stale_and_unreadable(self):
        self.assertEqual(self.events({'worker-status': {'status': 'stale'}}), ['worker_stale'])

    def test_a_nonfinite_threshold_falls_back_to_the_default(self):
        sixty = self.certificate(60)
        for threshold in ['inf', '-inf', 'nan']:
            with self.subTest(threshold=threshold):
                self.assertEqual(self.events(env={**sixty, 'MONITOR_CERT_MIN_DAYS': threshold}), [])

    def test_a_malformed_worker_answer_while_the_api_is_not_ready_adds_nothing(self):
        self.assertEqual(self.events({'ready': OSError('refused'), 'worker-status': {'foo': 1}}), ['database_unavailable'])
        self.assertEqual(self.events({'worker-status': {'foo': 1}}), ['worker_stale'])

    def test_ten_days_left_is_fine_for_the_demo_threshold_and_not_for_the_production_default(self):
        ten = self.certificate(10)
        self.assertEqual(self.events(env={**ten, 'MONITOR_CERT_MIN_DAYS': '2'}), [])
        self.assertEqual(self.events(env=ten), ['certificate_expiring'])

    def test_no_certificate_host_means_no_certificate_check(self):
        self.assertEqual(self.events(), [])

    def test_no_mail_carries_a_certificate_field_a_path_or_an_exception(self):
        env = {**self.certificate(1), 'MONITOR_CERT_MIN_DAYS': '2'}
        self.run_once({**self.DOWN, 'ready': OSError('/secret/path')}, env=env, mail_up=False)
        self.run_once(env=env)
        self.assertTrue(self.mails)
        allowed = {'api_down', 'database_unavailable', 'geodata_unavailable', 'certificate_expiring', 'Runtime recovered.'}
        for line in sum(self.mails, []):
            self.assertIn(line, allowed)
        self.assertIn('certificate_expiring', sum(self.mails, []))


if __name__ == '__main__':
    unittest.main()


class DeploySudo(unittest.TestCase):
    """The deploy account's root commands are the installed controls, never an interpreter over an upload."""

    def allowed(self):
        text = (ROOT / 'ops/production/sudoers-deploy').read_text()
        rule = ' '.join(line.rstrip('\\').strip() for line in text.splitlines() if line and not line.startswith('#'))
        commands = [command.strip() for command in rule.split('NOPASSWD:', 1)[1].split(',')]
        return [re.fullmatch(r'/usr/bin/bash (/usr/local/lib/bor-czuwa-release/[a-z-]+\.sh) \*', command).group(1)
                for command in commands]

    def test_every_sudo_in_deploy_runs_an_allowed_installed_control(self):
        installed = (ROOT / 'ops/production/install-release-control.sh').read_text()
        allowed = self.allowed()
        self.assertTrue(allowed)
        for script in allowed:
            self.assertIn('ops/production/' + Path(script).name, installed, script)
        calls = re.findall(r'sudo -n ([^"]+)"', (ROOT / 'ops/production/deploy.sh').read_text())
        self.assertTrue(calls)
        for call in calls:
            words = call.replace('$control', '/usr/local/lib/bor-czuwa-release').split()
            self.assertEqual(words[0], 'bash', call)
            self.assertIn(words[1], allowed, call)

    def test_the_sudoers_file_parses(self):
        if shutil.which('visudo') is None:
            self.skipTest('visudo not installed')
        result = subprocess.run(['visudo', '-cf', str(ROOT / 'ops/production/sudoers-deploy')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
