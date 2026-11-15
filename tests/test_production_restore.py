"""Run on disposable database hosts with PostgreSQL 17 tools and restic installed."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
TABLES = ['report', 'report_event', 'findings', 'findings_job', 'integrity_signal',
          'integrity_refresh', 'report_withdrawal', 'schema_migrations', 'rule_set',
          'geodata_snapshot', 'geodata_dataset', 'current_geodata', 'recipient_dataset']


class Recovery(unittest.TestCase):
    def test_restore_keeps_report_state_authorization_and_pending_work_then_rebuilds_geodata(self):
        source = os.environ['DRILL_SOURCE_DATABASE_URL']
        target = os.environ['DRILL_TARGET_DATABASE_URL']
        def sql(database, query):
            return subprocess.check_output(['psql', '-XAt', '-d', database, '-c', query],
                                           env=os.environ).decode().strip()
        def state(database):
            return {table: sql(database, f"SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]')) FROM {table} t")
                    for table in TABLES}
        sql(source, "DELETE FROM findings_job WHERE report_id='28000000-0000-4000-8000-000000000001'; "
            "DELETE FROM report WHERE id='28000000-0000-4000-8000-000000000001'; "
            "DELETE FROM report_withdrawal WHERE id='28000000-0000-4000-8000-000000000002'; "
            "DELETE FROM rate_counter WHERE ip_hash='ephemeral-drill';")
        token = '28' * 32
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        point = json.loads((ROOT / 'data/fixtures/acceptance.json').read_text())['edge']['point']
        sql(source, f"""INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
            occurred_source, occurred_coarseness, incident_lat, incident_lon, incident_source,
            has_note, app_version, privacy_policy_version, terms_of_use_version)
            VALUES ('28000000-0000-4000-8000-000000000001','{token_hash}','shot',
            '2026-09-24T12:00:00Z','2026-09-24T12:00:00Z','device_clock','exact',
            {point['lat']},{point['lon']},'moved_by_reporter',false,'drill','fixture','fixture');
            INSERT INTO findings_job (report_id, available_at, rule_set_id, geodata_snapshot_id)
            SELECT '28000000-0000-4000-8000-000000000001', now()+interval '1 day',
            'pl-2018-04-01-v2-protected-v1',snapshot_id FROM current_geodata;
            INSERT INTO report_withdrawal (id,token_sha256)
            VALUES ('28000000-0000-4000-8000-000000000002','{token_hash}');
            INSERT INTO rate_counter VALUES ('ephemeral-drill',1,1,now(),now()+interval '1 day');""")
        expected = state(source)
        env = {**os.environ, 'MIGRATION_DATABASE_URL': source}
        subprocess.run([sys.executable, str(ROOT / 'ops/production/backup.py'), 'backup'], env=env, check=True)
        wrong_key = subprocess.run(['restic', 'dump', 'latest', '/report.tar'],
                                   env={**env, 'RESTIC_PASSWORD': 'wrong-key'}, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        self.assertNotEqual(wrong_key.returncode, 0)
        subprocess.run([sys.executable, str(ROOT / 'ops/production/backup.py'), 'restore', 'latest'],
                       env={**env, 'MIGRATION_DATABASE_URL': target}, check=True)
        self.assertEqual(state(target), expected)
        self.assertEqual(sql(target, 'SELECT count(*) FROM rate_counter'), '0')
        self.assertEqual(sql(target, f"SELECT token_sha256 FROM report WHERE id='28000000-0000-4000-8000-000000000001'"), token_hash)
        storage = sql(target, 'SELECT storage_schema FROM geodata_snapshot JOIN current_geodata ON id=snapshot_id')
        self.assertEqual(sql(target, f'SELECT count(*) FROM {storage}.dwelling'), '0')
        subprocess.run([sys.executable, 'scripts/ingest-bubd.py', 'data/fixtures/bubd.parquet',
                        'data/fixtures/manifest.json', 'data/fixtures/obwody.json',
                        'data/fixtures/obwody-manifest.json', 'data/fixtures/protected/manifest.json',
                        'data/fixtures/recipients/manifest.json', 'data/fixtures/osm/stands.geojsonseq',
                        'data/fixtures/osm/manifest.json'], cwd=ROOT,
                       env={**os.environ, 'DATABASE_URL': target, 'GEODATA_REBUILD': '1',
                            'GEODATA_EXTRACT_DIR': '/tmp/restored-extracts'}, check=True)
        self.assertEqual(state(target), expected)
        self.assertEqual(sql(target, f'SELECT count(*) FROM {storage}.dwelling'), sql(source, f'SELECT count(*) FROM {storage}.dwelling'))
        replay = subprocess.run([sys.executable, str(ROOT / 'ops/production/backup.py'), 'restore', 'latest'],
                                env={**env, 'MIGRATION_DATABASE_URL': target}, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        self.assertNotEqual(replay.returncode, 0)
        self.assertEqual(state(target), expected)


if __name__ == '__main__':
    unittest.main()
