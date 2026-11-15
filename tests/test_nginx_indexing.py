"""Serve generated nginx policy with synthetic documents, without approving a release."""
import base64
import json
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
import uuid
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('indexing', ROOT / 'scripts/check-nginx-indexing.py')
indexing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(indexing)


class Indexing(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.build = self.root / 'build'
        for route in ['', 'legal/privacy/v1', 'legal/terms/v1']:
            target = self.build / route / 'index.html'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('<!doctype html><html><head><title>Synthetic indexing fixture</title><script>console.log("fixture")</script>'
                              '</head><body>Synthetic indexing fixture</body></html>')
        asset = self.build / '_app/immutable/fixture.js'
        asset.parent.mkdir(parents=True)
        asset.write_text('// Synthetic immutable asset\n')
        (self.build / 'service-worker.js').write_text('// Synthetic service worker\n')
        subprocess.run(['node', str(ROOT / 'scripts/write-security-headers.mjs')], cwd=self.root, check=True)

    def add_staging_metadata(self):
        for document in self.build.rglob('*.html'):
            document.write_text(document.read_text().replace(
                '<head>', '<head><meta name="robots" content="noindex, nofollow">'))

    def test_public_build_documents_are_excluded_by_the_header_alone(self):
        indexing.check(self.build, 'public', self.root / 'evidence')

    def test_staging_documents_remain_excluded_through_generated_proxy(self):
        self.add_staging_metadata()
        indexing.check(self.build, 'staging', self.root / 'evidence')

    def test_public_response_check_rejects_staging_document_metadata(self):
        self.add_staging_metadata()
        with self.assertRaisesRegex(AssertionError, 'public document has robots metadata'):
            indexing.check(self.build, 'public', self.root / 'evidence')

    def test_staging_response_check_rejects_missing_document_metadata(self):
        with self.assertRaisesRegex(AssertionError, 'wrong hydrated staging metadata'):
            indexing.check(self.build, 'staging', self.root / 'evidence')

    def test_response_check_rejects_a_document_without_the_exclusion_header(self):
        config = subprocess.check_output([
            'python3', str(ROOT / 'ops/production/render-nginx.py'), 'example.invalid'], text=True)
        lifted = self.root / 'lifted.conf'
        lifted.write_text(config.replace('add_header X-Robots-Tag $document_robots always;',
                                         'add_header X-Robots-Tag "" always;'))
        with self.assertRaisesRegex(AssertionError, 'missing exclusion header'):
            indexing.check(self.build, 'public', self.root / 'evidence', lifted)

    def test_rendered_proxy_negotiates_modern_tls_and_refuses_abuse(self):
        config = subprocess.check_output([
            'python3', str(ROOT / 'ops/production/render-nginx.py'), indexing.DOMAIN], text=True)
        config_file = self.root / 'hardening.conf'
        config_file.write_text(config)
        certs = self.root / 'certs'
        certs.mkdir()
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', f'/CN={indexing.DOMAIN}', '-keyout', str(certs / 'privkey.pem'),
                        '-out', str(certs / 'fullchain.pem')], check=True, capture_output=True)
        (self.build / '.well-known').mkdir()
        (self.build / '.well-known/security.txt').write_text('Contact: synthetic\n')
        name = 'proxy-hardening-' + uuid.uuid4().hex
        try:
            subprocess.run(['podman', 'run', '--detach', '--name', name,
                            '--publish', '127.0.0.1::443', '--publish', '127.0.0.1::80',
                            '--volume', f'{self.build}:/opt/bor-czuwa/current/build:ro,Z',
                            '--volume', f'{config_file}:/etc/nginx/nginx.conf:ro,Z',
                            '--volume', f'{certs}:/etc/letsencrypt/live/{indexing.DOMAIN}:ro,Z',
                            '--entrypoint', '/bin/sh', indexing.IMAGE, '-c',
                            'adduser -D -H -G www-data www-data; exec nginx -g "daemon off;"'],
                           check=True, capture_output=True)
            host, port = subprocess.check_output(['podman', 'port', name, '443'], text=True).strip().rsplit(':', 1)
            port = int(port)
            http_port = int(subprocess.check_output(['podman', 'port', name, '80'], text=True).strip().rsplit(':', 1)[1])

            def context(version=None, ciphers=None, alpn=None):
                value = ssl._create_unverified_context()
                if version:
                    value.minimum_version = value.maximum_version = version
                if ciphers:
                    value.set_ciphers(ciphers)
                if alpn:
                    value.set_alpn_protocols(alpn)
                return value

            def connect(value):
                raw = socket.create_connection((host, port), timeout=15)
                return value.wrap_socket(raw, server_hostname=indexing.DOMAIN)

            def exchange(request, value=None, prefix=b''):
                with connect(value or context()) as connection:
                    connection.sendall(prefix + request)
                    data = b''
                    try:
                        while chunk := connection.recv(65536):
                            data += chunk
                    except (ssl.SSLError, ConnectionError, TimeoutError):
                        pass
                    return data

            for attempt in range(50):
                try:
                    connect(context()).close()
                    break
                except OSError:
                    if attempt == 49:
                        raise
                    time.sleep(0.1)
            with connect(context(alpn=['h2', 'http/1.1'])) as connection:
                self.assertEqual(connection.selected_alpn_protocol(), 'h2')
            with connect(context(ssl.TLSVersion.TLSv1_3)) as connection:
                self.assertEqual(connection.version(), 'TLSv1.3')
            with connect(context(ssl.TLSVersion.TLSv1_2, 'ECDHE-RSA-AES128-GCM-SHA256')) as connection:
                self.assertEqual(connection.cipher()[0], 'ECDHE-RSA-AES128-GCM-SHA256')
            # A CBC suite is refused by the server, not merely unavailable to this client.
            probe = context(ssl.TLSVersion.TLSv1_2)
            probe.set_ciphers('ECDHE-RSA-AES128-SHA')
            with self.assertRaises(ssl.SSLError):
                connect(probe)
            def request(method, target, extra=''):
                data = exchange(f'{method} {target} HTTP/1.1\r\nHost: {indexing.DOMAIN}\r\n{extra}'
                                'Connection: close\r\n\r\n'.encode())
                head, _, body = data.partition(b'\r\n\r\n')
                return int(head.split()[1]), head.decode().lower(), body.decode(errors='replace')

            status, head, body = request('GET', '/')
            self.assertEqual(status, 200)
            self.assertIn('strict-transport-security: max-age=31536000\r\n', head + '\r\n')
            self.assertNotIn('includesubdomains', head)
            self.assertNotIn('preload', head)
            status, head, _ = request('GET', '/api/reports')
            self.assertEqual(status, 405)
            self.assertIn('strict-transport-security', head)
            for method, target in [('PUT', '/api/reports'), ('PATCH', '/api/reports'), ('DELETE', '/api/reports'),
                                   ('TRACE', '/'), ('POST', '/'), ('PUT', '/'), ('POST', '/service-worker.js'),
                                   ('POST', '/_app/immutable/fixture.js'), ('GET', '/api/reports'),
                                   ('POST', '/api/health'), ('PUT', '/api/reports/00000000-0000-4000-8000-000000000001'),
                                   ('POST', '/api/geodata/synthetic/ambony')]:
                status, head, body = request(method, target)
                self.assertEqual((method, target, status), (method, target, 405))
                self.assertEqual(body, '{"error":"method_not_allowed"}' if target.startswith('/api/') else 'Method not allowed\n')
                self.assertNotIn('nginx', body.lower())
                for header in ['x-content-type-options: nosniff', 'content-security-policy:',
                               'strict-transport-security: max-age=31536000', 'x-robots-tag: noindex']:
                    self.assertIn(header, head, (method, target, header))
            # The route's own methods still reach the (absent) API: 502 means it was proxied.
            for method, target in [('POST', '/api/reports'), ('GET', '/api/ready'), ('OPTIONS', '/api/reports'),
                                   ('DELETE', '/api/reports/00000000-0000-4000-8000-000000000001')]:
                self.assertEqual(request(method, target)[0], 502, (method, target))
            for target in ['/.env', '/.git/config', '/_app/.hidden', '/index.html.bak', '/service-worker.js~', '/dump.sql']:
                status, head, body = request('GET', target)
                self.assertEqual((target, status, body), (target, 404, 'Not found\n'))
                self.assertIn('text/plain', head)
                self.assertIn('x-content-type-options: nosniff', head)
                self.assertNotIn('nginx', body.lower())
            status, head, body = request('GET', '/missing')
            self.assertEqual((status, body), (404, 'Not found\n'))
            status, head, body = request('GET', '/api/nothing-here')
            self.assertEqual(status, 502)
            self.assertIn('application/json', head)
            self.assertEqual(body, '{"error":"unavailable"}')
            self.assertIn('strict-transport-security: max-age=31536000', head)
            # /.well-known/ stays reachable for security.txt and App Links; other dotfiles do not.
            status, _, body = request('GET', '/.well-known/security.txt')
            self.assertEqual((status, body), (200, 'Contact: synthetic\n'))
            status, head, body = request('GET', '/api/worker-status')
            self.assertEqual((status, body, 'application/json' in head), (404, '{"error":"not_found"}', True))
            # Stock nginx always names itself in Server, but server_tokens off keeps the version out.
            self.assertIn('server: nginx\r\n', head + '\r\n')
            status, _, body = request('POST', '/api/reports', 'Content-Length: 9000\r\n')
            self.assertIn(status, (413, 400))
            # A header line beyond the 8k buffer is refused before any route sees it.
            status, _, body = request('GET', '/', 'X-Padding: ' + 'a' * 9000 + '\r\n')
            self.assertIn(status, (400, 431))
            self.assertNotIn('nginx', body.lower())
            # A client that dribbles its headers is cut off at client_header_timeout (10s) with 408.
            started = time.monotonic()
            data = exchange(b'', prefix=f'GET / HTTP/1.1\r\nHost: {indexing.DOMAIN}\r\nX-Slow: a'.encode())
            elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 9)
            self.assertLess(elapsed, 14)
            self.assertTrue(data == b'' or data.startswith(b'HTTP/1.1 408'), data[:80])
            # HSTS is for the TLS host only: the plain-HTTP redirect carries none, and POST is refused there.
            def plain(method):
                with socket.create_connection((host, http_port), timeout=5) as connection:
                    connection.sendall(f'{method} /x HTTP/1.1\r\nHost: {indexing.DOMAIN}\r\nConnection: close\r\n\r\n'.encode())
                    return connection.recv(65536).decode().lower()
            redirect = plain('GET')
            self.assertTrue(redirect.startswith('http/1.1 301'))
            self.assertNotIn('strict-transport-security', redirect)
            self.assertTrue(plain('POST').startswith('http/1.1 405'))
        finally:
            subprocess.run(['podman', 'rm', '--force', name], capture_output=True)

    def test_private_gate_preserves_report_bearer_and_never_grants_failed_auth(self):
        gate = self.root / 'gate'
        gate.mkdir()
        gate.chmod(0o755)
        password = 'synthetic-private-access-password'
        password_hash = subprocess.check_output(['openssl', 'passwd', '-6', '-stdin'],
                                                input=(password + '\n').encode()).decode().strip()
        (gate / 'access.htpasswd').write_text('owner:' + password_hash + '\n')
        (gate / 'access.htpasswd').chmod(0o644)
        (gate / 'gate.json').write_text(json.dumps({'cookieToken': 'a' * 64,
                                                  'passwordFile': '/etc/demo-gate/access.htpasswd'}))
        config = subprocess.check_output([
            'python3', str(ROOT / 'ops/production/render-nginx.py'), indexing.DOMAIN,
            '--indexing', 'staging', '--environment-path', '/opt/bor-czuwa-demo',
            '--certificate-name', 'existing-ip-cert', '--private-gate', str(gate / 'gate.json')], text=True)
        # A loopback-only synthetic API observes what the real generated proxy forwards.
        config = config.replace('http {', '''http {
  server {
    listen 127.0.0.1:3001;
    location / {
      add_header X-Observed-Authorization $http_authorization always;
      add_header X-Observed-Invitation $http_x_bor_demo_invitation always;
      default_type application/json;
      return 200 '{"status":"ready"}';
    }
  }''', 1)
        config_file = self.root / 'private.conf'
        config_file.write_text(config)
        certs = self.root / 'certs'
        certs.mkdir()
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', f'/CN={indexing.DOMAIN}', '-keyout', str(certs / 'privkey.pem'),
                        '-out', str(certs / 'fullchain.pem')], check=True, capture_output=True)
        acme = self.root / 'acme/.well-known/acme-challenge'
        acme.mkdir(parents=True)
        (acme / 'synthetic-proof').write_text('synthetic-http01')
        extracts = self.root / 'extracts'
        extracts.mkdir()
        (extracts / 'synthetic.geojsonseq').write_text('synthetic-national-source\n')
        name = 'private-gate-' + uuid.uuid4().hex
        context = ssl._create_unverified_context()
        try:
            subprocess.run(['podman', 'run', '--detach', '--name', name,
                            '--publish', '127.0.0.1::443', '--publish', '127.0.0.1::80',
                            '--volume', f'{self.build}:/opt/bor-czuwa-demo/current/build:ro,Z',
                            '--volume', f'{config_file}:/etc/nginx/nginx.conf:ro,Z',
                            '--volume', f'{certs}:/etc/letsencrypt/live/existing-ip-cert:ro,Z',
                            '--volume', f'{gate}:/etc/demo-gate:ro,Z',
                            '--volume', f'{self.root / "acme"}:/var/lib/letsencrypt:ro,Z',
                            '--volume', f'{extracts}:/var/lib/bor-czuwa-demo/geodata-extracts:ro,Z',
                            '--entrypoint', '/bin/sh', indexing.IMAGE, '-c',
                            'adduser -D -H -G www-data www-data; exec nginx -g "daemon off;"'],
                           check=True, capture_output=True)
            address = subprocess.check_output(['podman', 'port', name, '443'], text=True).strip()
            http_address = subprocess.check_output(['podman', 'port', name, '80'], text=True).strip()

            def fetch(path, headers=None, method='GET'):
                request = urllib.request.Request('https://' + address + path,
                                                 headers={'Host': indexing.DOMAIN, **(headers or {})},
                                                 method=method)
                try:
                    response = urllib.request.urlopen(request, context=context, timeout=3)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    return response.status, response.headers, response.read()

            for attempt in range(50):
                try:
                    fetch('/')
                    break
                except (urllib.error.URLError, TimeoutError):
                    if attempt == 49:
                        raise
                    time.sleep(0.1)
            basic = 'Basic ' + base64.b64encode(('owner:' + password).encode()).decode()
            bad_basic = 'Basic ' + base64.b64encode(b'owner:wrong-password').decode()
            security = dict(re.findall(r'add_header ([\w-]+) "([^"]+)" always;',
                                       (self.build / 'security-headers.conf').read_text()))
            for headers in [{}, {'Authorization': bad_basic},
                            {'Cookie': '__Host-bor_demo=forged'},
                            {'Authorization': 'Bearer synthetic-report-token'}]:
                status, response, _ = fetch('/', headers)
                self.assertEqual(status, 401)
                self.assertIsNone(response.get('Set-Cookie'))
                for header, expected in security.items():
                    self.assertEqual(response.get_all(header), [expected])
            # This route returns in nginx's rewrite phase, before Basic authentication.
            status, response, _ = fetch('/api/geodata/synthetic/ambony',
                                         {'Authorization': bad_basic}, 'OPTIONS')
            self.assertEqual(status, 204)
            self.assertIsNone(response.get('Set-Cookie'))
            status, response, _ = fetch('/', {'Authorization': basic})
            self.assertEqual(status, 200)
            cookie_header = response['Set-Cookie']
            for attribute in ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']:
                self.assertIn(attribute, cookie_header)
            self.assertEqual(response.get_all('X-Robots-Tag'), ['noindex, nofollow'])
            cookie = cookie_header.split(';', 1)[0]
            report = '/api/reports/00000000-0000-4000-8000-000000000001'
            for route, method in [(report + '/findings', 'GET'), (report + '/events', 'POST'),
                                  (report, 'DELETE')]:
                status, response, _ = fetch(route, {'Cookie': cookie,
                                                   'Authorization': 'Bearer synthetic-report-token'}, method)
                self.assertEqual(status, 200)
                self.assertEqual(response['X-Observed-Authorization'], 'Bearer synthetic-report-token')
                for header, expected in security.items():
                    self.assertEqual(response.get_all(header), [expected])
            native = {'Origin': 'https://localhost', 'X-Bor-Demo-Invitation': 'a' * 64,
                      'Authorization': 'Bearer synthetic-report-token'}
            status, response, _ = fetch('/api/ready', {
                'Origin': 'https://localhost', 'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'x-bor-demo-invitation'}, 'OPTIONS')
            self.assertEqual(status, 204)
            self.assertEqual(response.get_all('Access-Control-Allow-Origin'), ['https://localhost'])
            self.assertIn('x-bor-demo-invitation', response['Access-Control-Allow-Headers'])
            self.assertIsNone(response.get('Set-Cookie'))
            for route, method in [('/api/ready', 'GET'), (report + '/findings', 'GET'),
                                  (report + '/events', 'POST'), (report, 'DELETE')]:
                status, response, _ = fetch(route, native, method)
                self.assertEqual(status, 200)
                self.assertEqual(response.get_all('Access-Control-Allow-Origin'), ['https://localhost'])
                self.assertEqual(response['X-Observed-Authorization'], 'Bearer synthetic-report-token')
                self.assertIsNone(response.get('X-Observed-Invitation'))
                self.assertIsNone(response.get('Set-Cookie'))
                self.assertEqual(response['Cache-Control'], 'no-store')
            for rejected in [{**native, 'Origin': 'https://foreign.example'},
                             {**native, 'X-Bor-Demo-Invitation': 'b' * 64},
                             {'Origin': 'https://localhost'}]:
                self.assertEqual(fetch('/api/ready', rejected)[0], 401)
            self.assertEqual(fetch('/', native)[0], 401)
            status, response, body = fetch('/api/geodata/synthetic/ambony', native)
            self.assertEqual(status, 200)
            self.assertEqual(body, b'synthetic-national-source\n')
            self.assertIsNone(response.get('Set-Cookie'))
            status, response, _ = fetch('/api/geodata/synthetic/ambony', {
                'Origin': 'https://localhost', 'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'x-bor-demo-invitation'}, 'OPTIONS')
            self.assertEqual(status, 204)
            self.assertIn('x-bor-demo-invitation', response['Access-Control-Allow-Headers'])
            # Location-level cache headers must not drop the cookie or security headers.
            for route in ['/_app/immutable/fixture.js', '/service-worker.js']:
                status, response, _ = fetch(route, {'Authorization': basic})
                self.assertEqual(status, 200)
                self.assertIsNotNone(response.get('Set-Cookie'))
                for header, expected in security.items():
                    self.assertEqual(response.get_all(header), [expected])
            self.assertEqual(fetch('/api/worker-status', {'Cookie': cookie})[0], 404)
            request = urllib.request.Request('http://' + http_address +
                                             '/.well-known/acme-challenge/synthetic-proof',
                                             headers={'Host': indexing.DOMAIN})
            with urllib.request.urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b'synthetic-http01')
                self.assertIsNone(response.headers.get('Set-Cookie'))
        finally:
            subprocess.run(['podman', 'rm', '--force', name], capture_output=True)


if __name__ == '__main__':
    unittest.main()
