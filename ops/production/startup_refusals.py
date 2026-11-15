"""Record why a start, rollback, activation or demo bootstrap was refused, as fixed tokens only, for the monitor to mail.

The API exits with a status that names the cause (server/startup-check.ts holds the same table).
systemd runs `record` as root after every stop of the unit; the release scripts call `release`.
The file sits in a directory that only root can write (the monitor account reads it, and keeps its
own mutable state elsewhere), so no other account can forge a line. Nothing but a token from these
tables and a UTC minute is ever stored.
"""
from datetime import datetime, timedelta, timezone
import fcntl
import os
from pathlib import Path
import re
import secrets
import stat
import sys

TOKENS = {
    80: 'ledger_checksum_mismatch', 81: 'ledger_newer_than_application', 82: 'migration_required',
    83: 'ledger_missing', 84: 'rule_set_changed', 85: 'geodata_missing', 86: 'geodata_schema_missing',
    87: 'geodata_rebuild_required', 88: 'geodata_empty', 89: 'migration_list_mismatch',
    90: 'unsupported_runtime_role', 96: 'schema_incomplete', 97: 'database_url_invalid', 91: 'database_auth_failed', 92: 'database_missing',
    93: 'database_permission_denied', 94: 'database_unavailable', 95: 'unknown',
}
# Refusals of a release step: deployment.py, environment.sh (refuse) and rollback.sh name these.
RELEASE_TOKENS = frozenset([
    'no_authorization', 'other_commit', 'other_candidate', 'indexeddb_incompatible', 'backups_not_off',
    'not_installed', 'config_missing', 'config_not_private', 'config_invalid', 'domain_mismatch',
    'candidate_not_eligible', 'candidate_mismatch', 'candidate_unreadable', 'proxy_config_unexpected',
    'unknown_environment', 'file_access', 'unclassified', 'host_not_prepared', 'host_file_mode',
    'bad_staging_dir', 'commit_mismatch', 'release_exists', 'database_incompatible', 'command_failed', 'candidate_unverified', 'config_unreadable', 'deploy_lock_busy', 'other_environment_active',
    'listener_taken', 'installed_candidate_differs',
    'activation_unpack_candidate', 'activation_verify_candidate', 'activation_candidate_check',
    'activation_install_dependencies', 'activation_write_receipt', 'activation_install_units',
    'certificate_missing', 'host_prerequisite_missing', 'unsafe_existing_state',
    # activate.sh: the step that was running when an activation failed.
    'activation_maintenance_page', 'activation_stop_jobs', 'activation_migrate', 'activation_link_switch', 'activation_geodata_check', 'activation_initial_ingest', 'activation_api_start', 'activation_readiness', 'activation_publish_routes', 'activation_start_jobs'])
KEPT_LINES = 50
# How long a refusal keeps counting as current. The monitor runs every minute.
WINDOW = timedelta(minutes=30)
# A line stamped later than now means the clock went back; a little skew is allowed, an hour is not.
SKEW = timedelta(minutes=2)
LINE = re.compile(r'(\d{4}-\d\d-\d\dT\d\d:\d\dZ) (startup_refused|release_refused):([a-z_]{1,40})')


def parse(text):
    """Valid lines only, as (UTC minute, kind, token). Anything else in the file is ignored."""
    found = []
    for line in text.splitlines():
        match = LINE.fullmatch(line)
        if not match:
            continue
        valid = TOKENS.values() if match.group(2) == 'startup_refused' else RELEASE_TOKENS
        if match.group(3) not in valid:
            continue
        try:
            when = datetime.strptime(match.group(1), '%Y-%m-%dT%H:%MZ').replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        found.append((when, match.group(2), match.group(3)))
    return found


def recent(path, now=None):
    """Event names for refusals inside the window, once each, sorted."""
    now = now or datetime.now(timezone.utc)
    try:
        with open(path, 'rb') as handle:
            text = handle.read(8192).decode('ascii', 'replace')
    except OSError:
        return []
    return sorted({f'{kind}:{token}' for when, kind, token in parse(text) if -SKEW <= now - when <= WINDOW})


def append(path, kind, token, now=None):
    """Append one fixed line; keep the last KEPT_LINES. The writer must own a non-shared directory."""
    now = now or datetime.now(timezone.utc)
    line = f'{now:%Y-%m-%dT%H:%MZ} {kind}:{token}'
    path = Path(path)
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise PermissionError('refusal directory is not private to its writer')
        # One writer at a time: the API's stop hook and a release script can refuse together.
        lock = os.open('.' + path.name + '.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        fcntl.flock(lock, fcntl.LOCK_EX)
        old = []
        try:
            descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            with os.fdopen(descriptor, 'rb') as handle:
                if stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    old = [f'{when:%Y-%m-%dT%H:%MZ} {k}:{kept}'
                           for when, k, kept in parse(handle.read(8192).decode('ascii', 'replace'))]
        except OSError:
            pass
        temporary = f'.{path.name}.{os.getpid()}.{secrets.token_hex(4)}'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory)
        with os.fdopen(descriptor, 'w') as handle:
            handle.write('\n'.join((old + [line])[-KEPT_LINES:]) + '\n')
            handle.flush()
            os.fchmod(handle.fileno(), 0o644)
            os.fsync(handle.fileno())
        os.rename(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)


def record(path, exit_status, now=None):
    """The API's exit status as a startup token. Unlisted statuses write nothing."""
    token = TOKENS.get(exit_status)
    if token is not None:
        append(path, 'startup_refused', token, now)


def record_release(path, token, now=None):
    """A release step's refusal token. Tokens outside the fixed list write nothing."""
    if token in RELEASE_TOKENS:
        append(path, 'release_refused', token, now)


if __name__ == '__main__':
    # `record <file>`: ExecStopPost=+ gives SERVICE_RESULT and EXIT_STATUS; only a main-process exit counts.
    # `release <token> <file>`: a release script refused. Both fail quietly so they never mask the refusal.
    if len(sys.argv) == 3 and sys.argv[1] == 'record':
        status = os.environ.get('EXIT_STATUS', '')
        if os.environ.get('SERVICE_RESULT') == 'exit-code' and os.environ.get('EXIT_CODE') == 'exited' and status.isdigit():
            record(sys.argv[2], int(status))
    elif len(sys.argv) == 4 and sys.argv[1] == 'release':
        record_release(sys.argv[3], sys.argv[2])
    else:
        raise SystemExit('usage: startup_refusals.py record <file> | release <token> <file>')
