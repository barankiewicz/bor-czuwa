#!/usr/bin/env bash
# Serialize authenticated installation, migrations and readiness-gated activation.
set -Eeuo pipefail
[[ $EUID == 0 && ( $# == 3 || $# == 4 ) && $1 =~ ^[a-z0-9.-]+$ && $2 =~ ^[a-f0-9]{40}$ ]]
control=/usr/local/lib/bor-czuwa-release
[[ $(realpath "$0") == "$control/activate.sh" ]] || exec bash "$control/activate.sh" "$@"
environment=${4:-production}
domain=$1
source "$control/environment.sh"
[[ $3 =~ ^$base/staging\.[A-Za-z0-9]+$ && ! -L $3 ]] || refuse bad_staging_dir
[[ $environment != demo || $domain == "$approved_domain" ]] || refuse domain_mismatch
# deploy.sh made this staging directory for this run; any exit before the move below removes it.
# Named here because an exit from inside refuse() would see that function's own $3.
staging=$3
trap 'rm -rf -- "$staging"' EXIT
exec 9>"$lock"
flock -w 30 9 || { record_refusal deploy_lock_busy; echo 'Another activation holds the deploy lock; gave up after 30 s.' >&2; exit 1; }
# Environments have isolated state, but share one loopback listener and nginx.
exec 8>/run/lock/bor-czuwa-proxy.lock
flock 8
if [[ $environment == demo ]]; then other=bor-czuwa-api; else other=bor-czuwa-demo-api; fi
! systemctl is-active --quiet "$other.service" || { record_refusal other_environment_active; echo 'Another environment owns the single API listener.' >&2; exit 1; }
if ! systemctl is-active --quiet "$api.service"; then
  [[ -z $(ss -H -ltn 'sport = :3001') ]] || { record_refusal listener_taken; echo 'Unexpected process owns the API listener.' >&2; exit 1; }
fi
[[ -f $etc/dedicated-host ]] || refuse host_not_prepared
for file in runtime maintenance; do
  [[ ! -L $etc/$file.env && $(stat -c '%a:%u' "$etc/$file.env" 2>/dev/null) == 600:0 ]] || refuse host_file_mode
done
if [[ $environment == production ]]; then
  for file in monitor digest; do [[ $(stat -c '%a:%u' "$etc/$file.env" 2>/dev/null) == 600:0 ]] || refuse host_file_mode; done
else
  [[ ! -L $etc/gate.json && $(stat -c '%a:%u' "$etc/gate.json" 2>/dev/null) == 600:0 ]] || refuse host_file_mode
fi
# deployment.py prints one fixed sentence and records its own token for a refusal. Run outside the error
# trap and add only the step, so one refusal is one record and one sentence.
deployment_step() {
  local text
  step=$1; shift
  if ! text=$(python3 "$control/deployment.py" "$@" 2>&1); then
    echo "$text Failed step: $step.${step_note:-}" >&2
    exit 1
  fi
}
# Before the activation handler exists the running API and its routes have not been touched. Only the
# last early step has written anything outside the staging directory, so the sentence says which.
early_failed() {
  record_refusal "activation_$step"
  if [[ $step == install_units ]]; then
    echo 'Activation stopped after the new release was installed but before it was activated; unit files may be partly updated. The running API and its routes were not touched. Failed step: install_units.' >&2
  else
    echo 'Activation stopped before anything was changed; the running release and its routes are untouched.'"${step:+ Failed step: $step.}" >&2
  fi
}
trap early_failed ERR
step=unpack_candidate
# Its own error text can carry paths, so only the step class is printed.
python3 "$control/unpack-candidate.py" "$3" >/dev/null 2>&1
step=verify_candidate
# In an if, so the failure is handled once here, and the verifier's own message (which names policy state) is not shown.
if ! receipt=$(verify_candidate "$3" "$eligibility" 2>/dev/null); then refuse candidate_unverified; fi
[[ $(printf '%s' "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sourceCommit"])') == "$2" ]] || refuse commit_mismatch
# Independent host boundary: check the authenticated manifest before units or migrations.
deployment_step candidate_check candidate "$3" "$environment" "$domain"
release=$base/releases/$2
if [[ ! -f $release/payload/installed ]]; then
  [[ ! -e $release ]] || refuse release_exists
  step=install_dependencies
  cd "$3/payload"
  printf '%s\n' "$2" > RELEASE
  chmod 0755 "$3"
  install -d -o "$build_user" -g "$build_user" node_modules .venv .install-home
  runuser -u "$build_user" -- env -i PATH="$PATH" HOME="$3/payload/.install-home" npm ci --ignore-scripts >/dev/null
  venv_options=()
  if [[ $environment == demo ]]; then venv_options+=(--system-site-packages); fi
  runuser -u "$build_user" -- env -i PATH="$PATH" python3 -m venv "${venv_options[@]}" .venv
  # Every package but GDAL installs from the hash-pinned file and nothing else is resolved.
  runuser -u "$build_user" -- env -i PATH="$PATH" HOME="$3/payload/.install-home" .venv/bin/pip install -q --require-hashes -r scripts/requirements-hashes.txt
  # GDAL is the one unhashed input: production builds the host's own version, chosen here.
  if [[ $environment == production ]]; then
    runuser -u "$build_user" -- env -i PATH="$PATH" HOME="$3/payload/.install-home" .venv/bin/pip install -q "GDAL==$(gdal-config --version)"
  fi
  # Demo reuses the signed platform binding, but must match the installed GDAL CLI.
  runuser -u "$build_user" -- env -i PATH="$PATH" .venv/bin/python -c \
    'from osgeo import gdal; import sys; sys.exit(gdal.VersionInfo("RELEASE_NAME") != sys.argv[1])' \
    "$(gdal-config --version)"
  rm -rf .install-home
  chown -R root:root "$3"
  chmod -R go-w "$3"
  chmod 0755 "$3"
  # Recheck source/build bytes after unprivileged dependency installation.
  verify_candidate "$3" "$eligibility" >/dev/null 2>&1 || refuse candidate_unverified
  # The receipt lets a later rollback verify these bytes without GitHub, after the hosted artifact expires.
  # It sits beside payload/ (not inside it), written by root after the ownership change above.
  step=write_receipt
  node "$control/release-candidate.mjs" write-receipt "$3" "$receipt" >/dev/null 2>&1
  touch installed
  mv "$3" "$release"
  trap - EXIT
else
  [[ ! -L $release && ! -L $release/payload/installed ]]
  if ! installed_receipt=$(verify_candidate "$release" "$eligibility" 2>/dev/null); then refuse candidate_unverified; fi
  [[ $installed_receipt == "$receipt" ]] || { record_refusal installed_candidate_differs; echo 'Installed commit has a different candidate identity; use a new verified source commit.' >&2; exit 1; }
  rm -rf -- "$3"
fi
# Unit definitions and privileged operations come from reviewed installed controls,
# never from uploaded payload scripts or service files.
step_note=' The new release is installed but not active; unit files may be partly updated. The running API and its routes were not touched.'
deployment_step install_units units "$control" "$environment"
systemctl daemon-reload
activation_failed() {
  local cleanup_failed=0
  # The monitor hears of it too: the API may never start, so nothing else would say so.
  [[ -z $step ]] || record_refusal "activation_$step"
  # stop_jobs stopped the production monitor timer; it must run again to mail the token above.
  [[ $environment != production ]] || systemctl start "$monitor.timer" >/dev/null 2>&1 || true
  systemctl stop "$api.service" >/dev/null 2>&1 || cleanup_failed=1
  publish_proxy maintenance >/dev/null 2>&1 || cleanup_failed=1
  if [[ $cleanup_failed == 0 ]]; then
    echo 'Activation failed. API remains stopped and application routes remain closed. Repair forward, or authorize a compatible application rollback. No database rollback or backup exists.'"${step:+ Failed step: $step.}${cause_class:+ Cause class: $cause_class.}" >&2
  else
    echo 'Activation failed and cleanup did not finish: the API may still be running and application routes may be open. Stop the API and publish the maintenance page by hand.'"${step:+ Failed step: $step.}${cause_class:+ Cause class: $cause_class.}" >&2
  fi
}
# Installed before the maintenance page goes up, so any failure from here on takes this path.
cause_class=
trap activation_failed ERR
step=maintenance_page
publish_proxy maintenance
step=stop_jobs
stop_jobs
step=migrate
load_env "$etc/maintenance.env"
cd "$release/payload"
# Root alone reads environment files. Maintenance gets owner credentials, API never does.
if ! migration_errors=$(runuser -u "$maint_user" -- env -u GH_TOKEN -u RELEASE_POLICY_PATH -u DATABASE_URL npm run migrate 2>&1 >/dev/null); then
  # Only the fixed class token crosses over, never the message text.
  cause_class=$(printf '%s\n' "$migration_errors" | sed -n 's/^Failure class: \([0-9A-Za-z]\{1,40\}\)$/\1/p' | tail -n 1)
  false
fi
step=link_switch
ln -sfn "$release/payload" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
step=geodata_check
has_geodata=$(runuser -u "$maint_user" -- env -u GH_TOKEN -u RELEASE_POLICY_PATH psql -d "$MIGRATION_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c 'SELECT EXISTS(SELECT 1 FROM current_geodata)')
[[ $has_geodata == t || $has_geodata == f ]]
if [[ $has_geodata == f ]]; then
  if [[ -z ${initial_config:-} ]]; then initial_config='{}'; fi
  step=initial_ingest
  ingest_seconds=$(printf '%s' "$initial_config" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ingestTimeoutSeconds",21600))')
  systemd-run --quiet --wait --collect --service-type=exec --unit="$api-initial-ingest" \
    --property="User=$maint_user" --property="WorkingDirectory=$release/payload" \
    --property="EnvironmentFile=$etc/maintenance.env" --property="RuntimeMaxSec=$ingest_seconds" \
    --property=KillMode=control-group --property=NoNewPrivileges=true --property=UMask=0077 \
    --property=MemoryMax=2304M --property=MemorySwapMax=1G --property=TimeoutStopSec=30 \
    --property=LimitCORE=0 --property=StandardOutput=null --property=StandardError=null \
    --setenv="BOR_CZUWA_INITIAL_CONFIG=$initial_config" \
    --setenv="TMPDIR=/var/lib/$(basename "$base")/geodata-tmp" \
    --setenv="GEODATA_EXTRACT_DIR=/var/lib/$(basename "$base")/geodata-extracts" \
    --setenv="GEODATA_REFRESH_LOG=/var/lib/$(basename "$base")/geodata-tmp/refresh.log" \
    /usr/bin/flock "/var/lib/$(basename "$base")/geodata-tmp/refresh.lock" \
    /usr/bin/python3 "$control/deployment.py" ingest "$release/payload" "$environment"
fi
step=api_start
systemctl enable --now "$api.service"
step=readiness
ready
step=publish_routes
# Until this point an existing nginx route returns 503; first bootstrap stays 404.
publish_proxy
step=start_jobs
start_jobs
trap - ERR
