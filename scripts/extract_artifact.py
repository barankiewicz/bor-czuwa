"""Publish immutable ambony downloads without loading whole file into memory."""

import hashlib
import os
import re
import tempfile
from pathlib import Path


def publish_extract(chunks, snapshot_id, directory, expected_sha256=None):
    if not re.fullmatch(r'[a-z0-9-]{1,80}', snapshot_id):
        raise ValueError('Invalid geodata snapshot id')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f'{snapshot_id}.geojsonseq'
    digest = hashlib.sha256()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix='.ambony-', delete=False) as output:
            temporary = Path(output.name)
            for chunk in chunks:
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        sha256 = digest.hexdigest()
        if expected_sha256 and sha256 != expected_sha256:
            raise ValueError('OSM stand extract hash does not match its manifest')
        os.chmod(temporary, 0o644)
        try:
            os.link(temporary, target)
        except FileExistsError:
            with target.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != sha256:
                    raise ValueError('Snapshot ids are immutable; use a new id')
        else:
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        return sha256
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
