"""Extract OSM hunting=stand features from dated Geofabrik Poland data."""
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.request import urlopen


SOURCE = 'https://download.geofabrik.de/europe/poland-latest.osm.pbf'
directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
pbf = directory / 'poland.osm.pbf'
digest = hashlib.sha256()
with urlopen(SOURCE, timeout=180) as response, pbf.open('wb') as output:
    publisher_date = parsedate_to_datetime(response.headers['Last-Modified']).date().isoformat()
    while chunk := response.read(1024 * 1024):
        output.write(chunk)
        digest.update(chunk)
filtered = directory / 'stands.osm.pbf'
subprocess.run(['osmium', 'tags-filter', str(pbf), 'nwr/amenity=hunting_stand',
                'nwr/hunting=stand', '-o', str(filtered)], check=True)
exported = directory / 'all.geojsonseq'
subprocess.run(['osmium', 'export', str(filtered), '-f', 'geojsonseq', '-u', 'type_id', '-o', str(exported)], check=True)
geojson = directory / 'stands.geojsonseq'
with exported.open('rb') as rows, geojson.open('wb') as output:
    for row in rows:
        payload = row.lstrip(b'\x1e').strip()
        if not payload:
            continue
        properties = json.loads(payload)['properties']
        if properties.get('amenity') == 'hunting_stand' or properties.get('hunting') == 'stand':
            output.write(row)
if not geojson.stat().st_size:
    raise ValueError('No OSM hunting stands found')
with geojson.open('rb') as stream:
    extract_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
(directory / 'manifest.json').write_text(json.dumps({
    'name': 'OpenStreetMap hunting stands', 'source_url': SOURCE,
    'retrieved_at': datetime.now(timezone.utc).isoformat(), 'publisher_date': publisher_date,
    'sha256': digest.hexdigest(), 'extract_sha256': extract_hash,
    'source_files': [{'source_url': SOURCE, 'sha256': digest.hexdigest()}],
}, indent=2) + '\n')
