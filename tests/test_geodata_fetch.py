"""Check the hunting-stand fetch command and complete ingestion boundary."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


class StandFetch(unittest.TestCase):
    def fetch(self, directory, exported):
        response = io.BytesIO(b'original-source-pbf')
        response.headers = {'Last-Modified': 'Sat, 03 Oct 2026 20:20:50 GMT'}
        commands = []
        def osmium(args, **kwargs):
            commands.append(args)
            output = Path(args[args.index('-o') + 1])
            output.write_bytes(exported if args[1] == 'export' else b'filtered-pbf')
        with patch.object(sys, 'argv', [str(ROOT / 'scripts/fetch-ambony.py'), str(directory)]), \
                patch('urllib.request.urlopen', return_value=response), \
                patch('subprocess.run', side_effect=osmium):
            runpy.run_path(str(ROOT / 'scripts/fetch-ambony.py'), run_name='__main__')
        return commands

    def test_standard_and_legacy_stands_keep_original_export_bytes(self):
        rows = [json.dumps({'type': 'Feature', 'id': f'node/{index}',
                'properties': properties, 'geometry': {'type': 'Point', 'coordinates': [23, 53]}}).encode() + b'\n'
                for index, properties in enumerate([
                    {'amenity': 'hunting_stand'}, {'hunting': 'stand'},
                    {'hunting': 'yes'}, {'hunting': 'raised_hide'}])]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = self.fetch(root, b'\n' + b''.join(rows))
            self.assertIn('nwr/amenity=hunting_stand', commands[0])
            self.assertEqual((root / 'stands.geojsonseq').read_bytes(), b''.join(rows[:2]))
            manifest = json.loads((root / 'manifest.json').read_text())
            self.assertEqual(manifest['extract_sha256'], hashlib.sha256(b''.join(rows[:2])).hexdigest())
            self.assertEqual(manifest['sha256'], hashlib.sha256(b'original-source-pbf').hexdigest())

    def test_empty_export_fails_without_publishing_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, 'No OSM hunting stands found'):
                self.fetch(root, b'\n\r\n')
            self.assertFalse((root / 'manifest.json').exists())


@unittest.skipUnless(os.environ.get('GEODATA_TEST_DISPOSABLE') == '1' and
                     os.environ.get('TEST_DATABASE_URL'), 'requires isolated ingestion dependencies and PostGIS')
class StandIngest(unittest.TestCase):
    def ingest(self, directory, standard):
        root = Path(directory) / 'fixture'
        shutil.copytree(ROOT / 'data/fixtures', root)
        source = root / 'osm/stands.geojsonseq'
        features = [json.loads(line.lstrip('\x1e')) for line in source.read_text().splitlines()]
        for feature in features:
            feature['properties'].pop('amenity', None)
            if standard:
                feature['properties'].pop('hunting', None)
                feature['properties']['amenity'] = 'hunting_stand'
            else:
                feature['properties']['hunting'] = 'yes'
        source.write_text(''.join(json.dumps(feature) + '\n' for feature in features))
        osm_path = root / 'osm/manifest.json'
        osm = json.loads(osm_path.read_text())
        osm['extract_sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
        osm['sha256'] = hashlib.sha256(('source-' + str(uuid4())).encode()).hexdigest()
        osm_path.write_text(json.dumps(osm))
        manifest_path = root / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['id'] = 'stand-regression-' + str(uuid4())
        manifest_path.write_text(json.dumps(manifest))
        recipients_path = root / 'recipients/manifest.json'
        recipients = json.loads(recipients_path.read_text())
        recipients['snapshot_id'] = manifest['id']
        recipients_path.write_text(json.dumps(recipients))
        extract_directory = Path(directory) / 'extracts'
        extract_directory.mkdir()
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/ingest-bubd.py'),
            str(root / 'bubd.parquet'), str(manifest_path), str(root / 'obwody.json'),
            str(root / 'obwody-manifest.json'), str(root / 'protected/manifest.json'),
            str(recipients_path), str(source), str(osm_path)], cwd=ROOT, capture_output=True, text=True,
            env={**os.environ, 'DATABASE_URL': os.environ['TEST_DATABASE_URL'],
                 'GEODATA_EXTRACT_DIR': str(extract_directory)})
        return result, len(features), extract_directory, manifest['id'], source.read_bytes()

    def test_importer_accepts_standard_tag_without_rewriting_export(self):
        with tempfile.TemporaryDirectory() as directory:
            result, count, extracts, snapshot, original = self.ingest(directory, True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f'and {count} OSM stands', result.stdout)
            self.assertEqual((extracts / f'{snapshot}.geojsonseq').read_bytes(), original)
            import psycopg
            with psycopg.connect(os.environ['TEST_DATABASE_URL']) as connection:
                self.assertEqual(connection.execute('SELECT count(*) FROM ambona').fetchone()[0], count)

    def test_importer_rejects_unrelated_hunting_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            result, _, extracts, _, _ = self.ingest(directory, False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('OSM stand extract contains no', result.stderr)
            self.assertFalse(list(extracts.iterdir()))


if __name__ == '__main__':
    unittest.main()
