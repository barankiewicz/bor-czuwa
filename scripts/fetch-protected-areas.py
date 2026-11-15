"""Download designated GDOŚ layers and a dated CRFOP XLSX export with byte hashes."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
import xml.etree.ElementTree as ET

from protected_areas import LAYERS

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('crfop_url', help='Dated rezerwaty przyrody XLSX export URL from dane.gov.pl')
args = parser.parse_args()
args.directory.mkdir(parents=True, exist_ok=False)
datasets = []
for name in [*LAYERS, 'CRFOP']:
    if name == 'CRFOP':
        url, filename = args.crfop_url, 'crfop.xlsx'
    else:
        query = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeName': name}
        with urlopen('https://sdi.gdos.gov.pl/wfs?' + urlencode({**query, 'resultType': 'hits'}), timeout=120) as response:
            hits = ET.fromstring(response.read())
        expected = int(hits.attrib['numberMatched'])
        url = 'https://sdi.gdos.gov.pl/wfs?' + urlencode({**query, 'outputFormat': 'application/json', 'srsName': 'EPSG:2180'})
        filename = name.split(':')[1] + '.json'
    with urlopen(url, timeout=180) as response:
        data = response.read()
    if name != 'CRFOP' and len(json.loads(data)['features']) != expected:
        raise ValueError(f'Incomplete WFS response: {name}')
    (args.directory / filename).write_bytes(data)
    datasets.append({'name': name, 'file': filename, 'source_url': url,
                     'retrieved_at': datetime.now(timezone.utc).isoformat(),
                     'sha256': hashlib.sha256(data).hexdigest()})
(args.directory / 'manifest.json').write_text(json.dumps({'datasets': datasets}, indent=2) + '\n')
