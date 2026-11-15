"""Check generated proxy headers and HTML through a disposable loopback TLS server."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'docker.io/library/nginx:1.28-alpine'
DOMAIN = 'example.invalid'


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.robots = []
        self.csp = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'meta':
            if attributes.get('name', '').lower() in ('robots', 'googlebot'):
                self.robots.append(attributes.get('content', '').lower())
            if attributes.get('http-equiv', '').lower() == 'content-security-policy':
                self.csp.append(attributes.get('content', ''))


def check(build, policy, evidence, config_file=None):
    build = build.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    command = ['python3', str(ROOT / 'ops/production/render-nginx.py'), DOMAIN]
    if policy == 'staging':
        command += ['--indexing', 'staging']
    config = config_file.read_bytes() if config_file else subprocess.check_output(command)
    (evidence / 'nginx.conf').write_bytes(config)
    report = {'policy': policy, 'config_sha256': hashlib.sha256(config).hexdigest(),
              'image': IMAGE, 'responses': [], 'result': 'failed'}
    security = dict(re.findall(r'add_header ([\w-]+) "([^"]+)" always;',
                               (build / 'security-headers.conf').read_text()))
    name = f'indexing-{uuid.uuid4().hex}'
    context = ssl._create_unverified_context()
    with tempfile.TemporaryDirectory(prefix='nginx-indexing-') as temporary:
        certs = Path(temporary)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', f'/CN={DOMAIN}', '-keyout', str(certs / 'privkey.pem'),
                        '-out', str(certs / 'fullchain.pem')], check=True, capture_output=True)
        try:
            subprocess.run(['podman', 'run', '--detach', '--name', name,
                            '--publish', '127.0.0.1::443',
                            '--volume', f'{build}:/opt/bor-czuwa/current/build:ro,Z',
                            '--volume', f'{evidence.resolve() / "nginx.conf"}:/etc/nginx/nginx.conf:ro,Z',
                            '--volume', f'{certs}:/etc/letsencrypt/live/{DOMAIN}:ro,Z',
                            '--entrypoint', '/bin/sh', IMAGE, '-c',
                            'adduser -D -H -G www-data www-data; exec nginx -g "daemon off;"'],
                           check=True, capture_output=True)
            report['image_id'] = subprocess.check_output(
                ['podman', 'inspect', '--format', '{{.Image}}', name], text=True).strip()
            address = subprocess.check_output(['podman', 'port', name, '443'], text=True).strip()

            def fetch(path):
                request = urllib.request.Request(f'https://{address}{path}', headers={'Host': DOMAIN})
                try:
                    response = urllib.request.urlopen(request, context=context, timeout=3)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    return response.status, response.headers, response.read()

            for attempt in range(50):
                try:
                    fetch('/service-worker.js')
                    break
                except (urllib.error.URLError, TimeoutError):
                    if attempt == 49:
                        raise
                    time.sleep(0.1)
            effective = subprocess.check_output(['podman', 'exec', name, 'nginx', '-T'],
                                                stderr=subprocess.DEVNULL)
            (evidence / 'nginx-effective.conf').write_bytes(effective)
            report['effective_config_sha256'] = hashlib.sha256(effective).hexdigest()
            immutable = next((build / '_app/immutable').rglob('*.js'))
            paths = ['/', '/legal/privacy/v1/', '/legal/terms/v1/',
                     '/' + immutable.relative_to(build).as_posix(), '/service-worker.js',
                     '/api/worker-status', '/api/not-a-route']
            for path in paths:
                status, headers, body = fetch(path)
                metadata = Metadata()
                if headers.get_content_type() == 'text/html':
                    metadata.feed(body.decode())
                record = {'path': path, 'status': status, 'headers': list(headers.items()),
                          'body_sha256': hashlib.sha256(body).hexdigest(),
                          'robots_meta': metadata.robots, 'csp_meta': metadata.csp}
                report['responses'].append(record)
                document = path in paths[:3]
                expected_status = 200 if not path.startswith('/api/') else (
                    404 if path == '/api/worker-status' else 502)
                assert status == expected_status, f'{path}: HTTP {status}, expected {expected_status}'
                robots = headers.get_all('X-Robots-Tag', [])
                # The app host never serves the public face: the header excludes every response, and a
                # public build adds no robots metadata of its own.
                assert robots == ['noindex, nofollow'], f'{path}: missing exclusion header: {robots}'
                if document and policy == 'public':
                    assert not metadata.robots, f'{path}: public document has robots metadata {metadata.robots}'
                elif document and metadata.robots:
                    assert metadata.robots == ['noindex, nofollow'], f'{path}: wrong static staging metadata'
                for header, expected in security.items():
                    assert headers.get_all(header) == [expected], f'{path}: changed {header}'
                if document:
                    assert metadata.csp, f'{path}: missing document CSP'
                if not path.startswith('/api/'):
                    cache = 'public, max-age=31536000, immutable' if path.startswith('/_app/') else 'no-cache'
                    assert headers.get('Cache-Control') == cache, f'{path}: changed caching'
            # SSR is disabled: the app writes its robots metadata during hydration.
            probe = subprocess.run(['node', '--input-type=module', '-e', '''
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const documents = [];
  for (const path of ['/', '/legal/privacy/v1/', '/legal/terms/v1/']) {
    await page.goto(process.argv[1] + path);
    await page.waitForFunction(() => document.title.length > 0);
    documents.push(await page.evaluate(path => ({
      path,
      title: document.title,
      robots_meta: [...document.querySelectorAll('meta[name="robots"], meta[name="googlebot"]')]
        .map(element => element.content.toLowerCase()),
      csp_meta: [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')]
        .map(element => element.content)
    }), path));
  }
  console.log(JSON.stringify({ browser: browser.version(), documents }));
} finally {
  await browser.close();
}
''', f'https://{address}'], cwd=ROOT, check=True, capture_output=True, text=True)
            hydrated = json.loads(probe.stdout)
            report['browser'] = hydrated['browser']
            report['hydrated_documents'] = hydrated['documents']
            for document in hydrated['documents']:
                expected = ['noindex, nofollow'] if policy == 'staging' else []
                assert document['robots_meta'] == expected, (
                    f'{document["path"]}: wrong hydrated {policy} metadata: {document["robots_meta"]}')
                assert document['csp_meta'], f'{document["path"]}: missing hydrated CSP'
            report['result'] = 'passed'
        except Exception as error:
            report['error'] = str(error)
            report['container_logs'] = subprocess.run(
                ['podman', 'logs', name], capture_output=True, text=True).stderr
            raise
        finally:
            subprocess.run(['podman', 'rm', '--force', name], capture_output=True)
            (evidence / 'responses.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--policy', choices=['public', 'staging'], required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--config', type=Path, help='Check a retained configuration instead of rendering it')
    args = parser.parse_args()
    result = check(args.build, args.policy, args.evidence, args.config)
    print(f'{args.policy} indexing passed; config SHA-256 {result["config_sha256"]}')
