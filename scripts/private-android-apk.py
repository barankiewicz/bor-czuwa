"""Inspect or copy authenticated private-test APK bytes without executing them."""
import hashlib
import json
from pathlib import Path
import re
import sys
import subprocess
import os
import zipfile


def digest(value):
    return hashlib.sha256(value).hexdigest()


def inspect(apk):
    payload = {}
    with zipfile.ZipFile(apk) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)) or sum(entry.file_size for entry in entries) > 128 * 1024 * 1024:
            raise ValueError('ambiguous or oversized APK')
        for entry in sorted(entries, key=lambda item: item.filename):
            if entry.is_dir():
                continue
            name = entry.filename
            if name.startswith('/') or '..' in name.split('/'):
                raise ValueError('invalid APK path')
            data = archive.read(entry)
            # APK v1 signatures are replaced; v2/v3 blocks are outside ZIP entries.
            signature = re.fullmatch(r'META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))', name, re.I)
            if not signature:
                payload[name] = digest(data)
        configuration = json.loads(archive.read('assets/capacitor.config.json'))
        runtime_files = {name.removeprefix('assets/public/'): archive.read(name).decode('utf-8')
                         for name in names if name.startswith('assets/public/')
                         and (name.endswith('.js') or name == 'assets/public/index.html')}
        scanner = Path(__file__).with_name('private-android-runtime.mjs')
        environment = {name: os.environ[name] for name in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL')
                       if name in os.environ}
        runtime = json.loads(subprocess.run(['node', str(scanner)], input=json.dumps(runtime_files),
                                           text=True, capture_output=True, check=True,
                                           env=environment).stdout)
    return {
        'apkSha256': digest(Path(apk).read_bytes()),
        'payloadFiles': payload,
        'applicationId': configuration.get('appId'),
        'androidScheme': configuration.get('server', {}).get('androidScheme', 'https'),
        'remoteServerUrl': bool(configuration.get('server', {}).get('url')),
        'bundledShell': 'assets/public/index.html' in payload,
        'compiledConfiguration': runtime,
    }


if __name__ == '__main__':
    try:
        command = sys.argv[1]
        if command == 'extract' and len(sys.argv) == 4:
            with zipfile.ZipFile(sys.argv[2]) as archive:
                member = 'artifacts/app-debug.apk'
                if archive.namelist().count(member) != 1:
                    raise ValueError('private APK missing or ambiguous')
                entry = archive.getinfo(member)
                if entry.file_size > 64 * 1024 * 1024:
                    raise ValueError('private APK too large')
                with open(sys.argv[3], 'xb') as output:
                    output.write(archive.read(entry))
        elif command == 'inspect' and len(sys.argv) == 3:
            print(json.dumps(inspect(*sys.argv[2:]), sort_keys=True))
        else:
            raise ValueError('invalid inspection command')
    except Exception:
        raise SystemExit('Private APK inspection refused.') from None
