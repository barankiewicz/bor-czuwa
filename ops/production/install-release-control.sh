#!/usr/bin/env bash
# Run only from an independently reviewed checkout, never an uploaded candidate.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Install release controls as root from a reviewed checkout.' >&2; exit 1; }
cd "$(dirname "$0")/../.."
control=/usr/local/lib/bor-czuwa-release
install -d -m 0755 "$control" "$control/units"
install -m 0644 scripts/release-candidate.mjs scripts/check-release.mjs scripts/unpack-candidate.py "$control/"
install -m 0644 ops/production/environment.sh ops/production/deployment.py ops/production/bootstrap-demo.py \
  ops/production/render-nginx.py ops/production/audit-nginx.py ops/production/startup_refusals.py "$control/"
install -m 0755 ops/production/activate.sh ops/production/rollback.sh ops/production/nginx-reload-hook.sh "$control/"
install -m 0644 containers/nginx.conf "$control/nginx.template.conf"
install -m 0644 ops/production/bor-czuwa-*.service ops/production/bor-czuwa-*.timer \
  ops/geodata-refresh.* ops/integrity-digest.* "$control/units/"
echo 'Reviewed release controls installed. Configure the selected root-owned release policy and private deployment settings separately.'
