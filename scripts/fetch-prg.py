"""Download current PRG GML archives and bind them to the GDOŚ recipient layers."""

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen


RESOURCES = {
    'admin': 2355393,
    'special': 2355404,
}
LAYERS = {
    'gmina': ('admin', 'A03_Granice_gmin.gml'),
    'powiat': ('admin', 'A02_Granice_powiatow.gml'),
    'voiv': ('admin', 'A01_Granice_wojewodztw.gml'),
    'police': ('special', 'K02_Komenda_powiatowa_policji.gml'),
    'forest': ('special', 'U06_Nadlesnictwo.gml'),
}


def download(url, path):
    digest = hashlib.sha256()
    with urlopen(url, timeout=180) as response, path.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
    return digest.hexdigest()


def main(directory, snapshot_id, protected_manifest_path):
    directory.mkdir(parents=True, exist_ok=False)
    archives = {}
    for kind, resource_id in RESOURCES.items():
        with urlopen(f'https://api.dane.gov.pl/1.4/resources/{resource_id}', timeout=30) as response:
            attributes = json.load(response)['data']['attributes']
        url = attributes['file_url']
        if not url:
            raise ValueError(f'PRG resource {resource_id} has no file URL')
        path = directory / f'{kind}.zip'
        archives[kind] = {'path': path.name, 'sha256': download(url, path),
                          'source_url': url, 'publisher_date': attributes['data_date']}
    protected = {entry['name']: entry for entry in
                 json.loads(protected_manifest_path.read_text())['datasets']}
    files = {kind: {**archives[archive], 'member': member}
             for kind, (archive, member) in LAYERS.items()}
    for kind, layer in [('nationalPark', 'GDOS:ParkiNarodowe'), ('reserve', 'GDOS:Rezerwaty')]:
        entry = protected[layer]
        path = (protected_manifest_path.parent / entry['file']).resolve()
        files[kind] = {'path': os.path.relpath(path, directory),
                       'sha256': entry['sha256'], 'source_url': entry['source_url']}
    manifest = {'snapshot_id': snapshot_id,
                'retrieved_at': datetime.now(timezone.utc).isoformat(),
                'publisher_date': max(archive['publisher_date'] for archive in archives.values()),
                'files': files}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: fetch-prg.py DIRECTORY SNAPSHOT_ID PROTECTED_MANIFEST.json')
    main(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
