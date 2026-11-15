import importlib.util
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).resolve().parents[1] / 'ops/production/monitor.py')
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class FailureAlerts(unittest.TestCase):
    def test_second_failure_alerts_without_repeating_unchanged_count(self):
        first = {'events': ['terminal_work_failed'], 'failure_counts': [1, 0]}
        second = {'events': ['terminal_work_failed'], 'failure_counts': [2, 0]}
        self.assertTrue(monitor.should_alert(first, {'events': [], 'failure_counts': [0, 0]}))
        self.assertTrue(monitor.should_alert(second, first))
        self.assertFalse(monitor.should_alert(second, second))
        self.assertFalse(monitor.should_alert(first, second))

    def test_second_failure_sends_second_mail_and_unchanged_count_stays_quiet(self):
        script = str(Path(__file__).resolve().parents[1] / 'ops/production/monitor.py')
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'monitor-state'
            backup = Path(directory) / 'backup-success'
            backup.write_text(datetime.now(timezone.utc).isoformat())
            smtp = Mock()
            smtp.__enter__ = Mock(return_value=smtp)
            smtp.__exit__ = Mock(return_value=False)
            env = {'ALERT_FROM': 'operator@example.test', 'ALERT_TO': 'operator@example.test',
                   'SMTP_HOST': 'mock.invalid', 'SMTP_PORT': '587', 'SMTP_USER': 'test', 'SMTP_PASSWORD': 'test'}
            for failures in [1, 2, 2]:
                status = {'status': 'ok', 'terminal_failures': failures, 'integrity_terminal_failures': 0}
                responses = [io.BytesIO(json.dumps(value).encode()) for value in
                             [{'status': 'ok'}, {'status': 'ready'}, status]]
                with patch('sys.argv', [script]), patch.dict('os.environ', env), \
                        patch('pathlib.Path', side_effect=lambda name: state if name.endswith('monitor-state') else backup), \
                        patch('urllib.request.urlopen', side_effect=responses), \
                        patch('subprocess.run', return_value=Mock(returncode=1)), \
                        patch('smtplib.SMTP', return_value=smtp):
                    runpy.run_path(script, run_name='__main__')
            self.assertEqual(smtp.send_message.call_count, 2)
            for call in smtp.send_message.call_args_list:
                self.assertEqual(call.args[0].get_content(), 'terminal_work_failed\n')
            self.assertEqual(json.loads(state.read_text())['failure_counts'], [2, 0])
