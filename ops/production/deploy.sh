#!/usr/bin/env bash
# Upload an authenticated candidate; never rebuild assets or execute upload scripts.
set -euo pipefail
[[ $# == 3 || $# == 4 ]] || { echo 'Usage: deploy.sh CANDIDATE_DIRECTORY DEDICATED_SSH_ALIAS DOMAIN [demo]' >&2; exit 1; }
[[ $2 =~ ^[A-Za-z0-9_-]+$ && $2 != zabka-vps && $3 =~ ^[a-z0-9.-]+$ ]]
control=/usr/local/lib/bor-czuwa-release
ssh_command=(ssh)
if [[ -n ${DEPLOY_SSH_CONFIG:-} ]]; then ssh_command+=(-F "$DEPLOY_SSH_CONFIG"); fi
environment=${4:-production}
case $environment in
  production) eligibility=production; base=/opt/bor-czuwa ;;
  demo)
    eligibility=staging
    base=/opt/bor-czuwa-demo
    export RELEASE_POLICY_PATH=${RELEASE_POLICY_PATH:-/etc/bor-czuwa-demo/release-policy.json}
    ;;
  *) echo 'Unknown deployment environment.' >&2; exit 1 ;;
esac
if [[ $environment == demo ]]; then
  # This metadata selects only the proposed commit/path. The installed host
  # control authenticates the original ZIP before any installation or migration.
  release=$(unzip -p "$1/verification.zip" candidate.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["identity"]["sourceCommit"])')
else
  receipt=$(node "$control/release-candidate.mjs" verify "$1" "$eligibility")
  release=$(printf '%s' "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sourceCommit"])')
fi
[[ $release =~ ^[a-f0-9]{40}$ ]]
staging=$("${ssh_command[@]}" "$2" "sudo -n mktemp -d $base/staging.XXXXXXXX")
[[ $staging =~ ^$base/staging\.[A-Za-z0-9]+$ ]]
files=(verification.zip)
if [[ $environment == production ]]; then files+=(acceptance.json acceptance.json.sig); fi
for file in "${files[@]}"; do
  "${ssh_command[@]}" "$2" "sudo -n tee $staging/$file >/dev/null" < "$1/$file"
done
"${ssh_command[@]}" "$2" "sudo -n bash $control/activate.sh $3 $release $staging $environment"
if [[ $environment == demo ]]; then
  # No Basic password enters argv or CI. Authenticated browser/Bearer proof is separate.
  [[ $(curl --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' "https://$3/api/ready") == 401 ]]
else
  curl --fail --silent --show-error --max-time 15 "https://$3/api/ready" >/dev/null
  [[ $(curl --fail --silent --show-error --max-time 15 "https://$3/RELEASE") == "$release" ]]
fi
