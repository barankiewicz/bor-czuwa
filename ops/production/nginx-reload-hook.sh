#!/usr/bin/env bash
# Certbot invokes this installed root-owned hook, never release-upload code.
set -euo pipefail
[[ $EUID == 0 ]]
python3 /usr/local/lib/bor-czuwa-release/audit-nginx.py
systemctl reload nginx
