#!/usr/bin/env bash
# Sourced only by installed controls, never from a candidate upload.
# Repository credentials belong only to the verifier subprocess, never installers,
# maintenance, runtime or systemd clients. Ignore inherited operator credentials.
unset GH_TOKEN
case ${environment:-production} in
  production)
    base=/opt/bor-czuwa
    etc=/etc/bor-czuwa
    eligibility=production
    api=bor-czuwa-api
    refresh=geodata-refresh
    digest=integrity-digest
    monitor=bor-czuwa-monitor
    backup=bor-czuwa-backup
    maint_user=bor-czuwa-maint
    runtime_user=bor-czuwa
    build_user=bor-czuwa-build
    lock=/run/lock/bor-czuwa-deploy.lock
    ;;
  demo)
    base=/opt/bor-czuwa-demo
    etc=/etc/bor-czuwa-demo
    eligibility=staging
    api=bor-czuwa-demo-api
    refresh=bor-czuwa-demo-geodata-refresh
    digest=bor-czuwa-demo-integrity-digest
    monitor=bor-czuwa-demo-monitor
    backup=bor-czuwa-demo-backup
    maint_user=bor-czuwa-demo-maint
    runtime_user=bor-czuwa-demo
    build_user=bor-czuwa-demo-build
    lock=/run/lock/bor-czuwa-demo-deploy.lock
    export RELEASE_POLICY_PATH=$etc/release-policy.json
    # deployment.py records its refusals here, so the demo path must be set before it runs.
    export BOR_CZUWA_REFUSAL_FILE=/var/lib/$(basename "$base")/refusals/startup-refusals
    config_shell=$(python3 "$control/deployment.py" shell)
    eval "$config_shell"
    ;;
  *) echo 'Unknown deployment environment.' >&2; exit 1 ;;
esac
# A refusal names one fixed class and says it in one sentence, never a path or an exception.
# ops/production/deployment.py prints the same "Release refused: <token>." shape for its own causes.
refuse() {
  local text
  case $1 in
    not_installed) text='That release was never installed on this host.' ;;
    host_not_prepared) text='This host has no dedicated-host marker for this environment; check the environment argument.' ;;
    host_file_mode) text='A private configuration file is missing or is not a root-owned file with mode 0600.' ;;
    bad_staging_dir) text='The staging directory is not a fresh one made by deploy.sh for this environment.' ;;
    domain_mismatch) text='The domain differs from the approved one.' ;;
    candidate_unverified) text='The candidate could not be verified against the trusted release policy.' ;;
    config_unreadable) text='A private settings file could not be loaded; check it for a malformed line.' ;;
    deploy_lock_busy) text='Another release step holds the deploy lock.' ;;
    other_environment_active) text='Another environment owns the single API listener.' ;;
    commit_mismatch) text='The verified candidate was built from a different commit than the one named.' ;;
    release_exists) text='That release directory exists but was never completed; remove it by hand and run again.' ;;
    *) set -- unclassified; text='The cause is not one of the known classes.' ;;
  esac
  record_refusal "$1"
  echo "Release refused: $1. $text" >&2
  exit 1
}

# Root-only token file for refusals; the monitor reads it (see startup_refusals.py). deployment.py reads the variable.
refusal_file=/var/lib/$(basename "$base")/refusals/startup-refusals
export BOR_CZUWA_REFUSAL_FILE=$refusal_file
record_refusal() { python3 "$control/startup_refusals.py" release "$1" "$refusal_file" 2>/dev/null || true; }

# Read a root-only settings file as data, never as shell. Each line must be NAME=value for an allowed name, where the value is
# empty, plain (letters, digits and _@%+=:,./-), single-quoted (as shlex.quote writes it) or double-quoted
# without $, a backtick or a backslash. The value is taken literally and assigned with declare, so nothing in
# the file runs, and a rejected line prints nothing (it could hold a password). Returns 1 on any rejection.
load_env() {
  [[ -r $1 ]] || return 1
  local line name value i
  local -a names=() values=()
  local assign='^([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
  local plain='^[A-Za-z0-9_@%+=:,./-]*$'
  local single="^'([^']*)'\$"
  local double='^"([^"$`\\]*)"$'
  # Only the names these files carry (see the .env.example files). Anything else, above all the shell's own
  # variables (RANDOM, SECONDS, UID, PATH, BASH_ENV...), is refused: assigning to some of them evaluates the value.
  local allowed=' DATABASE_URL MIGRATION_DATABASE_URL RUNTIME_DB_PASSWORD RUNTIME_DB_ROLE RESTIC_REPOSITORY RESTIC_PASSWORD_FILE REPORT_HOURLY_CEILING '
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ $line =~ $assign ]] || return 1
    name=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    [[ $allowed == *" $name "* ]] || return 1
    if [[ $value =~ $single || $value =~ $double ]]; then
      value=${BASH_REMATCH[1]}
    elif [[ ! $value =~ $plain ]]; then
      return 1
    fi
    names+=("$name")
    values+=("$value")
  done 2>/dev/null < "$1"
  for i in "${!names[@]}"; do
    declare -gx "${names[$i]}=${values[$i]}" >/dev/null 2>&1 || return 1
  done
}

# Load the separately scoped root credential only inside the verifier's subshell.
verify_candidate() (
  if [[ -e $etc/candidate-api.env ]]; then
    [[ ! -L $etc/candidate-api.env && $(stat -c '%a:%u' "$etc/candidate-api.env") == 600:0 ]]
    set -a
    source "$etc/candidate-api.env"
    set +a
  fi
  exec node "$control/release-candidate.mjs" verify "$@"
)

stop_jobs() {
  systemctl stop "$refresh.timer" "$digest.timer" "$backup.timer" "$monitor.timer"
  systemctl stop "$api.service" "$refresh.service" "$digest.service" "$monitor.service" "$backup.service"
  systemctl disable --now "$backup.timer"
  if [[ $environment == demo ]]; then
    # A demo sends alerts and the digest only once the owner has put their mail settings on the
    # host; without the file nothing could deliver them, so the timer stays off.
    [[ -f $etc/digest.env ]] || systemctl disable --now "$digest.timer"
    [[ -f $etc/monitor.env ]] || systemctl disable --now "$monitor.timer"
  fi
}

start_jobs() {
  systemctl enable --now "$refresh.timer"
  if [[ $environment == production || -f $etc/digest.env ]]; then systemctl enable --now "$digest.timer"; fi
  if [[ $environment == production || -f $etc/monitor.env ]]; then systemctl enable --now "$monitor.timer"; fi
}

ready() {
  local attempt
  for attempt in {1..30}; do
    if curl -fsS --max-time 2 http://127.0.0.1:3001/api/ready >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

render_proxy() {
  if [[ $environment == demo ]]; then
    python3 "$control/render-nginx.py" "$approved_domain" --indexing staging \
      --environment-path "$base" --config-path "$etc" \
      --certificate-name "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["certificateName"])' "$etc/deployment.json")" \
      --private-gate "$etc/gate.json"
  else
    python3 "$control/render-nginx.py" "$domain"
  fi
}

publish_proxy() {
  # Generate privately, audit the exact effective configuration, and reload only
  # after readiness. A failed audit restores disk config without opening routes.
  # Callers may run this under || or in an ERR handler, where errexit is off inside
  # the function, so every step that matters returns its own failure.
  local pending previous
  pending=$(mktemp /etc/nginx/bor-czuwa-pending.XXXXXXXX) || return 1
  previous=$(mktemp /etc/nginx/bor-czuwa-previous.XXXXXXXX) || { rm -f "$pending"; return 1; }
  chmod 0600 "$pending" "$previous" || { rm -f "$pending" "$previous"; return 1; }
  if [[ ${1:-open} == maintenance ]]; then
    local result=0
    render_proxy | python3 "$control/deployment.py" close > "$pending" || result=$?
    if [[ $result == 3 ]]; then rm -f "$pending" "$previous"; return 0; fi
    if [[ $result != 0 ]]; then rm -f "$pending" "$previous"; return 1; fi
  elif ! render_proxy > "$pending"; then
    rm -f "$pending" "$previous"; return 1
  fi
  cp /etc/nginx/nginx.conf "$previous" || { rm -f "$pending" "$previous"; return 1; }
  if ! cp "$pending" /etc/nginx/nginx.conf || ! chmod 0600 /etc/nginx/nginx.conf; then
    cp "$previous" /etc/nginx/nginx.conf || true
    rm -f "$pending" "$previous"
    return 1
  fi
  if ! python3 "$control/audit-nginx.py"; then
    cp "$previous" /etc/nginx/nginx.conf
    rm -f "$pending" "$previous"
    return 1
  fi
  if ! systemctl reload nginx; then
    cp "$previous" /etc/nginx/nginx.conf
    rm -f "$pending" "$previous"
    return 1
  fi
  rm -f "$pending" "$previous"
  if [[ ${1:-open} == open ]]; then
    # Replace the intentionally proxy-refusing certificate bootstrap hook only now.
    install -m 0755 "$control/nginx-reload-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/bor-czuwa-nginx || return 1
  fi
}
