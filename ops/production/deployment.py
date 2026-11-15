"""Root-controlled private deployment settings and candidate boundaries."""
import argparse
import json
import sys
import os
from pathlib import Path
import re
import shlex
import stat
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import startup_refusals  # noqa: E402

DEMO_ETC = Path('/etc/bor-czuwa-demo')

# Every refusal prints one of these tokens and its sentence, never an exception message or a path.
REFUSALS = {
    'no_authorization': 'No rollback authorization is on file for this host.',
    'other_commit': 'The rollback authorization names a different commit.',
    'other_candidate': 'The rollback authorization names a different candidate.',
    'indexeddb_incompatible': 'The rollback authorization does not confirm the phones can read this release.',
    'backups_not_off': 'The rollback authorization does not state that backups are off.',
    'config_missing': 'A private deployment file is missing.',
    'config_not_private': 'A private deployment file is not a root-owned regular file with mode 0600.',
    'config_invalid': 'A private deployment file holds a value this release does not accept.',
    'domain_mismatch': 'The domain differs from the approved one.',
    'candidate_not_eligible': 'The candidate is not eligible for this environment.',
    'candidate_mismatch': 'The candidate differs from the approved deployment settings.',
    'candidate_unreadable': 'The candidate manifest could not be read.',
    'proxy_config_unexpected': 'The live proxy configuration is not one this release can close.',
    'unknown_environment': 'The environment is neither production nor demo.',
    'certificate_missing': 'The approved certificate is not installed on this host.',
    'host_prerequisite_missing': 'The host is not the provisioned one this step needs, or a program it needs is missing.',
    'unsafe_existing_state': 'Existing demo state differs from what this step would create; review it before going on.',
    'file_access': 'A file this step needs could not be read or written.',
    'unclassified': 'The cause is not one of the known classes.',
}


class Refusal(ValueError):
    def __init__(self, token, detail=''):
        super().__init__(detail or token)
        self.token = token


def private_json(path):
    path = Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise Refusal('config_missing') from None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise Refusal('config_not_private', 'configuration must be a root-owned regular file with mode 0600')
    try:
        return json.loads(path.read_text())
    except ValueError:
        raise Refusal('config_invalid') from None


def demo_config(path=DEMO_ETC / 'deployment.json'):
    config = private_json(path)
    if not isinstance(config, dict) or any(not isinstance(config.get(key, ''), str)
                                            for key in ['domain', 'certificateName', 'demoTestRecipient', 'accessUser']):
        raise Refusal('config_invalid', 'configuration must be an object with text fields')
    if not re.fullmatch(r'[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?', config.get('domain', '')):
        raise Refusal('config_invalid', 'invalid domain')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', config.get('certificateName', '')):
        raise Refusal('config_invalid', 'invalid certificate name')
    if not re.fullmatch(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}',
                        config.get('demoTestRecipient', '')):
        raise Refusal('config_invalid', 'approved test recipient required')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', config.get('accessUser', 'owner')):
        raise Refusal('config_invalid', 'invalid access user')
    seconds = config.get('ingestTimeoutSeconds', 21600)
    if type(seconds) is not int or not 60 <= seconds <= 86400:
        raise Refusal('config_invalid', 'ingest timeout must be between 60 and 86400 seconds')
    inputs = config.get('initialInputs')
    if inputs is not None and (not isinstance(inputs, list) or len(inputs) != 8
                               or any(not isinstance(value, str) or not value.startswith('/') for value in inputs)):
        raise Refusal('config_invalid', 'initialInputs must contain eight absolute national input paths')
    return config


def check_candidate(directory, environment, expected_domain=None):
    with zipfile.ZipFile(Path(directory) / 'verification.zip') as archive:
        manifest = json.loads(archive.read('candidate.json'))
    candidate = manifest['releaseCandidate']
    configuration = candidate['configuration']
    if environment == 'demo':
        config = demo_config()
        if expected_domain is not None and config['domain'] != expected_domain:
            raise Refusal('domain_mismatch', 'domain differs from approved deployment configuration')
        if candidate['mode'] != 'staging' or configuration['mode'] != 'staging':
            raise Refusal('candidate_not_eligible', 'demo requires staging eligibility')
        if configuration.get('demoTestRecipient') != config['demoTestRecipient']:
            raise Refusal('candidate_mismatch', 'candidate recipient differs from approved deployment configuration')
        if configuration.get('androidApiOrigin') != 'https://' + config['domain']:
            raise Refusal('candidate_mismatch', 'demo Android origin differs from approved HTTPS origin')
    elif environment == 'production':
        if candidate['mode'] != 'production' or configuration['mode'] != 'production':
            raise Refusal('candidate_not_eligible', 'production requires production eligibility')
        if configuration.get('demoTestRecipient') not in (None, ''):
            raise Refusal('candidate_not_eligible', 'demo recipient is forbidden in production')
        if expected_domain is not None and configuration.get('androidApiOrigin') != 'https://' + expected_domain:
            raise Refusal('candidate_mismatch', 'Android API origin differs from the app host')
    else:
        raise Refusal('unknown_environment', 'unknown deployment environment')


UNIT_DIR = Path('/etc/systemd/system')


def install_units(control, environment):
    templates = Path(control) / 'units'
    for template in templates.iterdir():
        name, text = template.name, template.read_text()
        if environment == 'demo':
            replacements = [('/opt/bor-czuwa', '/opt/bor-czuwa-demo'),
                            ('/etc/bor-czuwa', '/etc/bor-czuwa-demo'),
                            ('/var/lib/bor-czuwa', '/var/lib/bor-czuwa-demo'),
                            ('StateDirectory=bor-czuwa/', 'StateDirectory=bor-czuwa-demo/'),
                            ('User=bor-czuwa-maint', 'User=bor-czuwa-demo-maint'), ('User=bor-czuwa\n', 'User=bor-czuwa-demo\n'),
                            ('bor-czuwa-api.service', 'bor-czuwa-demo-api.service'),
                            ('bor-czuwa-monitor.service', 'bor-czuwa-demo-monitor.service'),
                            ('bor-czuwa-backup', 'bor-czuwa-demo-backup')]
            for old, new in replacements:
                text = text.replace(old, new)
            if name == 'bor-czuwa-monitor.service':
                # The monitor's own names: unit names, and the host to read the certificate from. The demo certificate
                # lives about 6.7 days, so it warns at 2. monitor.env, loaded after these, can still override them.
                text = text.replace('EnvironmentFile=', 'Environment=MONITOR_REFRESH_UNIT=bor-czuwa-demo-geodata-refresh.service\n'
                                    'Environment=MONITOR_DIGEST_UNIT=bor-czuwa-demo-integrity-digest.service\n'
                                    'Environment=MONITOR_CERT_HOST=' + demo_config()['domain'] + '\n'
                                    'Environment=MONITOR_CERT_MIN_DAYS=2\n' + 'EnvironmentFile=', 1)
            if name.startswith('bor-czuwa-'):
                name = name.replace('bor-czuwa-', 'bor-czuwa-demo-', 1)
            else:
                name = 'bor-czuwa-demo-' + name
                text = text.replace('Unit=geodata-refresh.service', 'Unit=bor-czuwa-demo-geodata-refresh.service')
                text = text.replace('Unit=integrity-digest.service', 'Unit=bor-czuwa-demo-integrity-digest.service')
        target = UNIT_DIR / name
        target.write_text(text)
        target.chmod(0o644)


def initial_ingest(payload, environment):
    # The caller runs this installed control as the maintenance account. Source inputs
    # are public national datasets; ingest-bubd validates their recorded digests.
    config = json.loads(os.environ['BOR_CZUWA_INITIAL_CONFIG'])
    inputs = config.get('initialInputs')
    os.environ['DATABASE_URL'] = os.environ['MIGRATION_DATABASE_URL']
    command = [str(Path(payload) / '.venv/bin/python'),
               'scripts/ingest-bubd.py' if inputs else 'scripts/ingest.py', *(inputs or [])]
    os.chdir(payload)
    os.execv(command[0], command)


def authorize_rollback(directory, receipt):
    receipt = json.loads(receipt)
    try:
        authorization = private_json(DEMO_ETC / 'rollback-authorization.json')
    except Refusal:
        raise Refusal('no_authorization') from None
    if not isinstance(authorization, dict):
        raise Refusal('config_invalid', 'rollback authorization must be an object')
    if authorization.get('sourceCommit') != receipt['sourceCommit']:
        raise Refusal('other_commit', 'rollback authorization names another commit')
    if authorization.get('candidateSha256') != receipt['candidateSha256']:
        raise Refusal('other_candidate', 'rollback authorization names another candidate')
    if authorization.get('indexedDbCompatible') is not True:
        raise Refusal('indexeddb_incompatible', 'IndexedDB compatibility not confirmed')
    if authorization.get('backups') != 'off':
        raise Refusal('backups_not_off', 'backups not stated off')
    if not isinstance(authorization.get('authorization'), str) or not authorization['authorization'].strip():
        raise Refusal('no_authorization', 'explicit application and IndexedDB rollback authorization required')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['shell', 'candidate', 'units', 'ingest', 'rollback', 'close'])
    parser.add_argument('arguments', nargs='*')
    args = parser.parse_args()
    try:
        if args.command == 'shell':
            config = demo_config()
            print('approved_domain=' + shlex.quote(config['domain']))
            print('initial_config=' + shlex.quote(json.dumps({key: config[key] for key in
                  ['initialInputs', 'ingestTimeoutSeconds'] if key in config})))
        elif args.command == 'candidate':
            check_candidate(*args.arguments)
        elif args.command == 'units':
            install_units(*args.arguments)
        elif args.command == 'rollback':
            authorize_rollback(*args.arguments)
        elif args.command == 'close':
            # A host whose live config predates a policy change would fail today's audit if closed by
            # editing it, so the closed config is today's render (read from stdin) plus the 503.
            if 'proxy_pass http://api;' not in Path('/etc/nginx/nginx.conf').read_text():
                raise SystemExit(3)
            config = sys.stdin.read()
            marker = 'ssl_session_tickets off;'
            if marker not in config:
                raise Refusal('proxy_config_unexpected', 'unexpected TLS configuration')
            print(config.replace(marker, marker + '\n    return 503;'))
        else:
            initial_ingest(*args.arguments)
    except Exception as error:
        if isinstance(error, Refusal):
            token = error.token
        elif isinstance(error, (zipfile.BadZipFile, KeyError, json.JSONDecodeError)):
            token = 'candidate_unreadable'
        elif isinstance(error, OSError):
            token = 'file_access'
        else:
            token = 'unclassified'
        try:
            startup_refusals.record_release(os.environ.get('BOR_CZUWA_REFUSAL_FILE', '/var/lib/bor-czuwa/refusals/startup-refusals'), token)
        except Exception:
            pass
        raise SystemExit(f'Release refused: {token}. {REFUSALS[token]}') from None
