"""Read effective sshd settings before reloading the dedicated host's SSH service."""
import glob
from pathlib import Path
import shlex
import subprocess
import sys


def reject_conditional_policy(path, visited):
    path = path.resolve()
    if path in visited:
        return
    visited.add(path)
    for line in path.read_text().splitlines():
        lexer = shlex.shlex(line, posix=True, punctuation_chars='=')
        lexer.whitespace_split = True
        fields = list(lexer)
        if not fields:
            continue
        keyword = fields.pop(0).lower()
        if fields and fields[0] == '=':
            fields.pop(0)
        # A finite list of connection samples cannot prove arbitrary Match conditions safe.
        if keyword == 'match':
            raise SystemExit('SSH policy mismatch: conditional Match directives are unsupported')
        if keyword == 'include':
            for pattern in fields:
                for included in glob.glob(str(Path('/etc/ssh') / pattern)):
                    reject_conditional_policy(Path(included), visited)


user, port = sys.argv[1:]
subprocess.run(['/usr/sbin/sshd', '-t'], check=True)
reject_conditional_policy(Path('/etc/ssh/sshd_config'), set())
for login in [user, 'root', 'bor-czuwa-unauthorized']:
    for address in ['127.0.0.1', '203.0.113.2', '2001:db8::2']:
        output = subprocess.check_output([
            '/usr/sbin/sshd', '-T', '-C', f'user={login},host=public.example,addr={address}'
        ], text=True)
        settings = {}
        for line in output.splitlines():
            key, value = line.split(' ', 1)
            settings.setdefault(key, []).append(value)
        for key, value in {'passwordauthentication': 'no', 'kbdinteractiveauthentication': 'no',
                           'permitrootlogin': 'no', 'pubkeyauthentication': 'yes',
                           'allowusers': user, 'port': port}.items():
            if settings.get(key) != [value]:
                raise SystemExit(f'SSH policy mismatch: {key}')
print('SSH policy verified.')
