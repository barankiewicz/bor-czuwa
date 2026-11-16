"""Emit fixed monitoring events; never copy HTTP responses or exceptions into alerts."""
from email.message import EmailMessage
import argparse
import json
import os
from pathlib import Path
import smtplib
import socket
import ssl
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import startup_refusals  # noqa: E402


def setting(name, default):
    """A monitor.env or unit setting; unset or empty means the production value, so an old monitor.env keeps working."""
    return os.environ.get(name) or default


def answered(url):
    """The JSON an API route returned, or the failure class: 'geodata_unavailable' for that 503 body, else None."""
    try:
        with urlopen(url, timeout=5) as response:
            return json.load(response), None
    except HTTPError as error:
        try:
            body = json.load(error)
        except Exception:
            body = None
        return None, 'geodata_unavailable' if error.code == 503 and isinstance(body, dict) \
            and body.get('error') == 'geodata_unavailable' else 'failed'
    except Exception:
        return None, 'failed'


def min_days():
    """Days of certificate life below which to alert; a missing, unreadable or nonpositive value means the default."""
    try:
        value = float(setting('MONITOR_CERT_MIN_DAYS', '14'))
    except ValueError:
        return 14.0
    return value if 0 < value < float('inf') else 14.0


def certificate_days_left(host, port, connect):
    """Days until the certificate that a TLS handshake serves for `host` expires; None when no handshake completes."""
    context = ssl.create_default_context()
    try:
        with socket.create_connection((connect, port), timeout=5) as sock, \
                context.wrap_socket(sock, server_hostname=host) as tls:
            expires = ssl.cert_time_to_seconds(tls.getpeercert()['notAfter'])
    except ssl.SSLCertVerificationError:
        return -1.0  # served, but expired or not valid for the host: below any threshold
    except Exception:
        return None
    return (expires - time.time()) / 86400


def events():
    failures = []
    failure_counts = [0, 0]
    base = f"http://127.0.0.1:{int(setting('MONITOR_API_PORT', '3001'))}/api/"
    health, health_failure = answered(base + 'health')
    if health_failure:
        failures.append('api_down')
    ready, ready_failure = answered(base + 'ready')
    if ready_failure:
        failures.append(ready_failure if ready_failure == 'geodata_unavailable' else 'database_unavailable')
    # Readiness failing explains a route that fails or answers nonsense, and a database outage is one event: only
    # an explicit 'stale' answer survives geodata trouble.
    worker, worker_failure = answered(base + 'worker-status')
    try:
        if worker_failure:
            raise ValueError
        if worker['status'] == 'stale' and ready_failure != 'failed':
            failures.append('worker_stale')
        failure_counts = [worker['terminal_failures'], worker['integrity_terminal_failures']]
        if worker['terminal_failures'] or worker['integrity_terminal_failures']:
            failures.append('terminal_work_failed')
        # A flood and a Report going viral look alike from here, so the operator decides
        # whether to raise REPORT_HOURLY_CEILING.
        if worker.get('report_ceiling_active'):
            failures.append('report_ceiling_reached')
    except Exception:
        # Ready, yet the route failed or answered something unreadable.
        if not ready_failure:
            failures.append('worker_stale')
    for event, unit in [('geodata-refresh_failed', setting('MONITOR_REFRESH_UNIT', 'geodata-refresh.service')),
                        ('integrity-digest_failed', setting('MONITOR_DIGEST_UNIT', 'integrity-digest.service'))]:
        result = subprocess.run(['systemctl', 'is-failed', '--quiet', unit], check=False)
        if result.returncode == 0:
            failures.append(event)
    # The certificate nginx serves, read by handshake: a failed renewal hook leaves the old one in place.
    host = os.environ.get('MONITOR_CERT_HOST')
    if host:
        left = certificate_days_left(host, int(setting('MONITOR_CERT_PORT', '443')), setting('MONITOR_CERT_CONNECT', '127.0.0.1'))
        if left is not None and left < min_days():
            failures.append('certificate_expiring')
    # Fixed tokens recorded when the API refused to start or a release step was refused; see startup_refusals.py.
    # The file lives in a root-owned sibling of the monitor's own state directory, which this account can write.
    failures += startup_refusals.recent(
        Path(os.environ.get('STATE_DIRECTORY', '/var/lib/bor-czuwa/monitor')).parent / 'refusals' / 'startup-refusals')
    return {'events': list(dict.fromkeys(failures)), 'failure_counts': failure_counts}


def read_state(state):
    """The last delivered state plus the events seen since; the legacy bare list and a file without pending both read."""
    empty = {'events': [], 'failure_counts': [0, 0], 'pending': [], 'observed': []}
    try:
        value = json.loads(state.read_text())
        if isinstance(value, list):
            value = {'events': value}
        events = value['events'] if 'events' in value else []
        result = {'events': events, 'failure_counts': value.get('failure_counts', [0, 0]),
                  'pending': value.get('pending', []), 'observed': value.get('observed', events)}
        if not all(isinstance(result[key], list) for key in ['events', 'failure_counts', 'pending', 'observed']):
            raise ValueError
        return result
    except FileNotFoundError:
        return empty
    except Exception:
        # Unreadable state must never silence alerts: start again from empty and mail what is wrong now.
        return empty


def write_state(state, value):
    """Replace the state file whole: a stop in the middle leaves the old file, never a partial one."""
    temporary = state.with_name(state.name + '.new')
    with open(temporary, 'w') as handle:
        handle.write(json.dumps(value) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, state)


def ping_healthcheck(failing):
    """Tell an external dead man's switch that this run happened and whether it found trouble.

    The service alerts when pings stop, which is the one failure this monitor cannot mail about
    itself: the host down, cut off, or the timer no longer running. A ping carries no event names
    and no response body is read; a ping that fails is ignored so it never blocks the run.
    """
    url = os.environ.get('HEALTHCHECK_URL', '')
    if not url.startswith('https://'):
        return
    try:
        with urlopen(url.rstrip('/') + ('/fail' if failing else ''), data=b'', timeout=10):
            pass
    except Exception:
        pass


def should_alert(current, previous):
    if isinstance(previous, list):
        previous = {'events': previous, 'failure_counts': [0, 0]}
    return current['events'] != previous['events'] or any(
        count > old for count, old in zip(current['failure_counts'], previous['failure_counts']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Print fixed event names without sending mail')
    args = parser.parse_args()
    if args.check:
        print(json.dumps(events()))
        raise SystemExit(0)
    os.umask(0o077)
    # systemd sets STATE_DIRECTORY from the unit's StateDirectory=, which differs on the demo host.
    state = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/bor-czuwa/monitor') + '/monitor-state')
    current = events()
    # Before the mail, so the external check hears of trouble even when mail delivery is what failed.
    ping_healthcheck(bool(current['events']))
    previous = read_state(state)
    # An event that appears after a run that did not see it is a new outage, whatever was last delivered, and
    # stays listed until a mail has gone out, even if it clears first. The vocabulary is fixed, so the list stays short.
    pending = previous['pending'] + [name for name in current['events']
                                     if name not in previous['observed'] and name not in previous['pending']]
    if should_alert(current, previous) or pending:
        message = EmailMessage()
        message['From'] = os.environ['ALERT_FROM']
        message['To'] = os.environ['ALERT_TO']
        message['Subject'] = 'Bór czuwa: runtime check'
        names = current['events'] + [name for name in pending if name not in current['events']]
        message.set_content('\n'.join(names + ([] if current['events'] else ['Runtime recovered.'])))
        try:
            with smtplib.SMTP(os.environ['SMTP_HOST'], int(os.environ['SMTP_PORT']), timeout=15) as smtp:
                smtp.starttls(context=ssl.create_default_context())
                smtp.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
                smtp.send_message(message)
        except Exception:
            # Keep what was last delivered and remember what has happened since, so the next run still mails it.
            write_state(state, {**previous, 'pending': pending, 'observed': current['events']})
            raise SystemExit('Operator alert delivery failed.') from None
    write_state(state, {**current, 'pending': [], 'observed': current['events']})
