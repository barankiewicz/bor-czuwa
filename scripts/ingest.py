"""Download all current sources, then ingest one complete geodata snapshot."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen


BUBD_URL = 'https://opendata.geoportal.gov.pl/bdot10k/schemat2021/GeoParquet/OT_BUBD_A.parquet'
CRFOP_RESOURCES = 'https://api.dane.gov.pl/1.4/datasets/471/resources?page=1&per_page=100'


def current_crfop():
    resources = []
    url = CRFOP_RESOURCES
    while url:
        with urlopen(url, timeout=30) as response:
            page = json.load(response)
        resources.extend(page['data'])
        url = page['links'].get('next')
    candidates = [item['attributes'] for item in resources
                  if item['attributes']['title'].endswith(' - rezerwaty przyrody')
                  and item['attributes'].get('file_url')]
    if not candidates:
        raise ValueError('No dated CRFOP reserve export found')
    latest = max(candidates, key=lambda item: item['data_date'])
    return latest['file_url'], latest['data_date']


def download_bubd(directory):
    path = directory / 'bubd.parquet'
    digest = hashlib.sha256()
    with urlopen(BUBD_URL, timeout=180) as response, path.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
    manifest = {'id': 'pending', 'source_url': BUBD_URL,
                'retrieved_at': datetime.now(timezone.utc).isoformat(),
                'sha256': digest.hexdigest(), 'coverage_kind': 'poland',
                'coverage_bbox_2180': [0, 0, 1000000, 1000000]}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def run(*args):
    subprocess.run([sys.executable, *map(str, args)], check=True)


def refresh():
    if not os.environ.get('GEODATA_EXTRACT_DIR'):
        raise ValueError('GEODATA_EXTRACT_DIR is required')
    with tempfile.TemporaryDirectory(prefix='geodata-refresh-') as temporary:
        root = Path(temporary)
        download_bubd(root)
        run('scripts/fetch-obwody.py', root / 'obwody.json')
        crfop_url, crfop_date = current_crfop()
        run('scripts/fetch-protected-areas.py', root / 'protected', crfop_url)
        protected_manifest = root / 'protected/manifest.json'
        protected = json.loads(protected_manifest.read_text())
        next(entry for entry in protected['datasets'] if entry['name'] == 'CRFOP')['publisher_date'] = crfop_date
        protected_manifest.write_text(json.dumps(protected, indent=2) + '\n')
        run('scripts/fetch-prg.py', root / 'recipients', 'pending', protected_manifest)
        run('scripts/fetch-ambony.py', root / 'osm')
        manifest_path = root / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        obwody_manifest = root / 'obwody-manifest.json'
        recipients_manifest = root / 'recipients/manifest.json'
        recipient = json.loads(recipients_manifest.read_text())
        digests = [manifest['sha256'], json.loads(obwody_manifest.read_text())['sha256']]
        digests.extend(entry['sha256'] for entry in protected['datasets'])
        digests.extend(recipient['files'][kind]['sha256']
                       for kind in ('gmina', 'powiat', 'voiv', 'police', 'forest'))
        digests.append(json.loads((root / 'osm/manifest.json').read_text())['sha256'])
        snapshot_id = datetime.now(timezone.utc).date().isoformat() + '-' + hashlib.sha256(''.join(digests).encode()).hexdigest()[:12]
        manifest['id'] = snapshot_id
        recipient['snapshot_id'] = snapshot_id
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
        recipients_manifest.write_text(json.dumps(recipient, indent=2) + '\n')
        run('scripts/ingest-bubd.py', root / 'bubd.parquet', manifest_path,
            root / 'obwody.json', obwody_manifest, protected_manifest, recipients_manifest,
            root / 'osm/stands.geojsonseq', root / 'osm/manifest.json')


if __name__ == '__main__':
    log = Path(os.environ.get('GEODATA_REFRESH_LOG', 'geodata-refresh.log'))
    try:
        refresh()
    except Exception as error:
        with log.open('a') as output:
            output.write(f'{datetime.now(timezone.utc).isoformat()} FAILED {type(error).__name__}\n')
        raise
    else:
        with log.open('a') as output:
            output.write(f'{datetime.now(timezone.utc).isoformat()} OK\n')
