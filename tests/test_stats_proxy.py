"""Run the app host's nginx in a container against a fake GoatCounter and read what it forwards.

The counting location must hand the counter a GET for one of the landing's ten paths and a fixed
site label, and nothing that identifies the visitor. This starts the real nginx image on the host
network with containers/nginx.conf and a listener on 127.0.0.1:18081 standing in for the counter.
Skipped where podman or the nginx image is missing.
"""
import http.server
import json
import re
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'docker.io/library/nginx:1.28-alpine'
NAME = 'bor-czuwa-14-stats-proxy'
PORT, COUNTER = 18090, 18081


def have_image():
    try:
        return subprocess.run(['podman', 'image', 'exists', IMAGE]).returncode == 0
    except FileNotFoundError:
        return False


@unittest.skipUnless(have_image(), 'podman or the nginx image is not available')
class StatsProxy(unittest.TestCase):
    seen = []
    # The exact URL the landing's count script requests for each page, from the real script.
    counts = {}

    @classmethod
    def setUpClass(cls):
        helper = subprocess.run(['npx', 'tsx', str(ROOT / 'landing/tests/count-urls.ts')], cwd=ROOT, capture_output=True, text=True, check=True)
        cls.counts = {page: '?' + urlsplit(url).query for page, url in json.loads(helper.stdout).items()}
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        config = (ROOT / 'containers/nginx.conf').read_text()
        config = re.sub(r'  resolver .*;\n', '', config)
        config = config.replace('server app:3001 resolve;', 'server 127.0.0.1:3001;')
        config = config.replace('server 127.0.0.1:8081;', f'server 127.0.0.1:{COUNTER};')
        config = config.replace('listen 8080;', f'listen 127.0.0.1:{PORT};')
        config = config.replace('/etc/nginx/security-headers.conf', '/work/security-headers.conf')
        (root / 'security-headers.conf').write_text('add_header X-Content-Type-Options "nosniff" always;\n')
        (root / 'nginx.conf').write_text(config)
        seen = cls.seen

        class Counter(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}))
                # What GoatCounter really answers with, plus a cookie and a header that identify it:
                # none of it may reach the visitor.
                self.send_response(200)
                self.send_header('Content-Type', 'image/gif')
                self.send_header('Set-Cookie', 'session=upstream; Path=/')
                self.send_header('X-Upstream-Marker', 'counter')
                self.end_headers()
                self.wfile.write(b'GIF89a')

            def log_message(self, *args):
                pass

        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', COUNTER), Counter)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        subprocess.run(['podman', 'rm', '-f', NAME], capture_output=True)
        subprocess.run(['podman', 'run', '-d', '--name', NAME, '--network', 'host', '-v', f'{root}:/work:ro,Z', IMAGE,
                        'nginx', '-c', '/work/nginx.conf', '-g', 'daemon off;'], check=True, capture_output=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/health', timeout=1)
            except urllib.error.HTTPError:
                break
            except OSError:
                threading.Event().wait(0.1)

    @classmethod
    def tearDownClass(cls):
        subprocess.run(['podman', 'rm', '-f', NAME], capture_output=True)
        cls.server.shutdown()
        cls.temporary.cleanup()

    def setUp(self):
        self.seen.clear()

    def post(self, query, method='POST'):
        time.sleep(0.12)  # the location rate-limits a client to 10 requests a second
        request = urllib.request.Request(f'http://127.0.0.1:{PORT}/_stats/website{query}', method=method, headers={
            'X-Forwarded-For': '203.0.113.7', 'X-Real-IP': '203.0.113.8', 'Forwarded': 'for=203.0.113.9',
            'True-Client-IP': '203.0.113.10', 'Referer': 'https://example.org/secret', 'Cookie': 'session=abc',
            'User-Agent': 'VisitorBrowser/1.0 (Secret Phone)', 'Origin': 'https://bor-czuwa.pl',
            'Accept-Language': 'pl-PL', 'Authorization': 'Bearer visitor'})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def test_a_known_page_reaches_the_counter_with_nothing_about_the_visitor(self):
        status, headers, body = self.post(self.counts['/en/privacy/'])
        self.assertEqual(status, 204, 'always 204, whatever the counter answered')
        self.assertEqual(body, b'', 'the counter\'s image never passes through')
        for name in headers:
            self.assertNotIn(name.lower(), ('set-cookie', 'x-upstream-marker', 'content-type'), name)
        self.assertEqual(len(self.seen), 1)
        method, path, received = self.seen[0]
        self.assertEqual((method, path), ('GET', '/count?p=/en/privacy/'))
        self.assertEqual(received['host'], 'website.stats.bor-czuwa.local')
        # GoatCounter v2.7.0 files a bare "Mozilla/5.0" under bots and counts nothing (checked by
        # running it), so the fixed User-Agent is a complete browser string.
        self.assertRegex(received['user-agent'], r'^Mozilla/5\.0 \(.+\) AppleWebKit/.+ Chrome/\d+')
        for header in ['x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip', 'referer', 'cookie', 'origin',
                       'accept-language', 'authorization', 'x-forwarded-host', 'x-forwarded-proto']:
            self.assertNotIn(header, received)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertIn('noindex', headers['X-Robots-Tag'])

    def test_every_one_of_the_ten_pages_counts_and_nothing_else_does(self):
        self.assertEqual(len(self.counts), 10)
        for page, query in self.counts.items():
            self.post(query)
        self.assertEqual([path for _, path, _ in self.seen], [f'/count?p={page}' for page in self.counts],
                         'each page the script counts reaches the counter under its own path')
        self.seen.clear()
        for query in ['', '?p=', '?p=/admin/', '?p=/en/privacy', '?p=/%0d%0aX-Evil:1', '?p=https://evil.example/']:
            self.assertEqual(self.post(query)[0], 204, query)
        self.assertEqual(self.seen, [], 'text a visitor chose never reaches the counter')
        self.post('?p=/&p=/x')
        self.post(self.counts['/'] + '&extra=1')
        self.assertEqual(self.seen, [], 'only the exact query the script sends is forwarded')

    def test_only_post_is_counted(self):
        # Any other method is refused outright (405) rather than quietly answered, and never counted.
        for method in ['GET', 'PUT', 'DELETE', 'PATCH']:
            self.assertEqual(self.post(self.counts['/'], method=method)[0], 405, method)
        self.assertEqual(self.seen, [])

    def test_a_dead_counter_does_not_break_the_answer(self):
        self.server.shutdown()
        self.server.server_close()
        try:
            self.assertEqual(self.post(self.counts['/'])[0], 204)
        finally:
            self.server = http.server.ThreadingHTTPServer(('127.0.0.1', COUNTER), self.server.RequestHandlerClass)
            threading.Thread(target=self.server.serve_forever, daemon=True).start()


if __name__ == '__main__':
    unittest.main()
