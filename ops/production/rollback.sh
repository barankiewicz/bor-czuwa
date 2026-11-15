#!/usr/bin/env bash
# Application-only rollback to a verified, schema- and IndexedDB-compatible release.
set -euo pipefail
[[ $EUID == 0 && ( $# == 1 || $# == 2 ) && $1 =~ ^[a-f0-9]{40}$ ]]
control=/usr/local/lib/bor-czuwa-release
[[ $(realpath "$0") == "$control/rollback.sh" ]] || exec bash "$control/rollback.sh" "$@"
environment=${2:-production}
source "$control/environment.sh"
exec 9>"$lock"
flock -n 9 || refuse deploy_lock_busy
exec 8>/run/lock/bor-czuwa-proxy.lock
flock -n 8 || refuse deploy_lock_busy
if [[ $environment == demo ]]; then other=bor-czuwa-api; else other=bor-czuwa-demo-api; fi
! systemctl is-active --quiet "$other.service" || refuse other_environment_active
release=$base/releases/$1
[[ -f $release/payload/installed && ! -L $release ]] || refuse not_installed
if ! receipt=$(verify_candidate "$release" "$eligibility" rollback 2>/dev/null); then refuse candidate_unverified; fi
python3 "$control/deployment.py" candidate "$release" "$environment"
if [[ $environment == demo ]]; then
  python3 "$control/deployment.py" rollback "$release" "$receipt"
else
  # Production rollback keeps its existing effective domain and certificate policy.
  domain=$(python3 -c 'import re; from pathlib import Path; c=Path("/etc/nginx/nginx.conf").read_text(); print(re.findall(r"server_name ([a-z0-9.-]+);",c)[0])')
fi
[[ ! -L $etc/runtime.env && $(stat -c '%a:%u' "$etc/runtime.env" 2>/dev/null) == 600:0 ]] || refuse host_file_mode
load_env "$etc/runtime.env" || refuse config_unreadable
cd "$release/payload"
# Never execute application compatibility code as root or with owner credentials.
if ! database_check=$(runuser -u "$runtime_user" -- env -u GH_TOKEN -u MIGRATION_DATABASE_URL -u RUNTIME_DB_PASSWORD \
  node --import tsx ops/production/check-database.ts 2>&1); then
  # Only the fixed token crosses over; this runs before anything is stopped or switched.
  database_token=$(printf '%s\n' "$database_check" | sed -n 's/^Database check refused: \([a-z_]\{1,40\}\)\.$/\1/p' | tail -n 1)
  record_refusal database_incompatible
  echo "Rollback refused: database not compatible${database_token:+ ($database_token)}. The running release is unchanged." >&2
  exit 1
fi
python3 "$control/deployment.py" units "$control" "$environment"
systemctl daemon-reload
publish_proxy maintenance
stop_jobs
rollback_failed() {
  systemctl stop "$api.service" >/dev/null 2>&1 || true
  publish_proxy maintenance >/dev/null 2>&1 || true
  echo 'Application rollback failed. API remains stopped. No database rollback was attempted.' >&2
}
trap rollback_failed ERR
ln -sfn "$release/payload" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
systemctl start "$api.service"
ready
publish_proxy
start_jobs
trap - ERR
