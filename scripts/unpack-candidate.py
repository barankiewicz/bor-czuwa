"""Extract a downloaded verification artifact without executing candidate code."""
import io
from pathlib import Path
import sys
import tarfile
import zipfile

root = Path(sys.argv[1]).resolve()
with zipfile.ZipFile(root / 'verification.zip') as archive:
    names = archive.namelist()
    if names.count('candidate.json') != 1 or names.count('artifacts/release.tar') != 1:
        raise SystemExit('Candidate archive is missing or ambiguous')
    payload = root / 'payload'
    payload.mkdir(exist_ok=False)
    with tarfile.open(fileobj=io.BytesIO(archive.read('artifacts/release.tar'))) as release:
        for entry in release.getmembers():
            if not (entry.isfile() or entry.isdir()):
                raise SystemExit('Candidate contains a link or special file')
            if not (payload / entry.name).resolve().is_relative_to(payload):
                raise SystemExit('Candidate path escapes payload')
        release.extractall(payload, filter='data')
