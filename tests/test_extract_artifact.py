import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from extract_artifact import publish_extract


class ExtractArtifactTest(unittest.TestCase):
    def test_publication_is_complete_and_snapshot_name_cannot_change_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = [b'first', b' second']
            digest = hashlib.sha256(b''.join(source)).hexdigest()
            self.assertEqual(publish_extract(iter(source), 'snapshot-1', directory, digest), digest)
            target = Path(directory) / 'snapshot-1.geojsonseq'
            self.assertEqual(target.read_bytes(), b'first second')
            self.assertEqual(publish_extract(iter(source), 'snapshot-1', directory, digest), digest)
            with self.assertRaisesRegex(ValueError, 'immutable'):
                publish_extract([b'different'], 'snapshot-1', directory)
            self.assertEqual(target.read_bytes(), b'first second')
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_hash_failure_leaves_no_public_or_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'hash'):
                publish_extract([b'wrong'], 'snapshot-2', directory, '0' * 64)
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
