"""Download BDL obwody łowieckie as Esri JSON in EPSG:2180."""
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

source_url = 'https://mapserver.bdl.lasy.gov.pl/ArcGIS/rest/services/WMS_Obwody_lowieckie/MapServer/6'
output = Path(sys.argv[1])
bbox = json.loads(Path(sys.argv[2]).read_text())['coverage_bbox_2180'] if len(sys.argv) > 2 else None


def query(parameters):
    with urlopen(f'{source_url}/query?{urlencode(parameters)}', timeout=120) as response:
        data = json.load(response)
    if 'error' in data:
        raise ValueError(data['error'])
    return data


filter_parameters = {'where': '1=1', 'f': 'json'}
if bbox:
    filter_parameters.update(geometry=','.join(map(str, bbox)), geometryType='esriGeometryEnvelope',
                             inSR=2180, spatialRel='esriSpatialRelIntersects')
ids = sorted(query({**filter_parameters, 'returnIdsOnly': 'true'})['objectIds'])
if not ids:
    raise ValueError('No obwody łowieckie found')

features = []
fields = None
for start in range(0, len(ids), 100):
    page = query({'objectIds': ','.join(map(str, ids[start:start + 100])),
                  'outFields': 'objectid,hd_int_num,hunt_dist_nr,a_year',
                  'returnGeometry': 'true', 'outSR': 2180, 'f': 'json'})
    if page.get('spatialReference', {}).get('wkid') != 2180 or page.get('geometryType') != 'esriGeometryPolygon':
        raise ValueError('BDL returned unexpected geometry or CRS')
    fields = page['fields']
    features.extend(page['features'])

actual = [feature['attributes']['objectid'] for feature in features]
if sorted(actual) != ids or len(actual) != len(set(actual)):
    raise ValueError('BDL returned an incomplete or duplicate feature set')
if any(not feature['attributes'].get('hunt_dist_nr') or not feature.get('geometry', {}).get('rings')
       for feature in features):
    raise ValueError('BDL returned an obwód without number or geometry')

payload = {'geometryType': 'esriGeometryPolygon', 'spatialReference': {'wkid': 2180},
           'fields': fields, 'features': features}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
digest = hashlib.sha256(output.read_bytes()).hexdigest()
manifest = {'source_url': source_url, 'retrieved_at': datetime.now(timezone.utc).isoformat(),
            'source_name': 'Bank Danych o Lasach',
            'disclaimer': 'Dane o obwodach łowieckich mają charakter poglądowy.',
            'sha256': digest, 'feature_count': len(features),
            'source_years': sorted({feature['attributes']['a_year'] for feature in features})}
if bbox:
    manifest['coverage_bbox_2180'] = bbox
output.with_name(output.stem + '-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Downloaded {len(features)} BDL obwody łowieckie')
