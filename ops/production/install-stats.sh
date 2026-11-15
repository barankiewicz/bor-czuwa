#!/usr/bin/env bash
# Installs GoatCounter for the landing's page-opening counts on this host, as root.
#   bash ops/production/install-stats.sh                 # downloads the pinned release
#   bash ops/production/install-stats.sh <file.gz>       # uses a copy you already downloaded
# The release is pinned below. The script works on its own private copy: it hashes that copy,
# unpacks that copy and installs the unpacked file, so what was checked is what gets installed.
# It creates the account, the state directory, the unit and the one site the nginx location uses
# (Host website.stats.bor-czuwa.local), and sets the site to collect nothing but the page path.
set -euo pipefail

# Looked up 2026-11-12 on the project's GitHub release page (the API's digest for this asset).
# To move to a newer release, change all three from that page and nothing else.
GOATCOUNTER_VERSION=v2.7.0
GOATCOUNTER_URL=https://github.com/arp242/goatcounter/releases/download/v2.7.0/goatcounter-v2.7.0-linux-amd64.gz
GOATCOUNTER_GZ_SHA256=98d221cb9c8ef2bf76d8daa9cca647839f8d8b0bb5bc7400ff9337c5da834511

[[ $# -le 1 ]] || { echo "usage: $0 [goatcounter-linux-amd64.gz]" >&2; exit 2; }
# The nginx location asks the counter through auth_request; refuse a build without it.
nginx -V 2>&1 | grep -q -- --with-http_auth_request_module || { echo "this nginx lacks ngx_http_auth_request_module" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [[ $# -eq 1 ]]; then cp -- "$1" "$work/gc.gz"; else curl -fsSL -o "$work/gc.gz" "$GOATCOUNTER_URL"; fi
[[ $(sha256sum "$work/gc.gz" | cut -d' ' -f1) == "$GOATCOUNTER_GZ_SHA256" ]] || { echo "sha256 does not match the pinned $GOATCOUNTER_VERSION" >&2; exit 1; }
gunzip "$work/gc.gz"
chmod 0755 "$work/gc"
[[ $("$work/gc" version) == version=$GOATCOUNTER_VERSION\;* ]] || { echo "unexpected version" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
db=sqlite+/var/lib/bor-czuwa-stats/db.sqlite3
id bor-czuwa-stats >/dev/null 2>&1 || useradd --system --home-dir /var/lib/bor-czuwa-stats --shell /usr/sbin/nologin bor-czuwa-stats
install -d -m 0755 /opt/goatcounter
install -m 0755 "$work/gc" /opt/goatcounter/goatcounter
install -d -o bor-czuwa-stats -g bor-czuwa-stats -m 0700 /var/lib/bor-czuwa-stats
install -m 0644 "$here/bor-czuwa-stats.service" /etc/systemd/system/bor-czuwa-stats.service
systemctl daemon-reload
if [[ ! -f /var/lib/bor-czuwa-stats/db.sqlite3 ]]; then
  # The dashboard login. The password is asked for interactively and lives only in the database.
  runuser -u bor-czuwa-stats -- /opt/goatcounter/goatcounter db create site -createdb -db "$db" \
    -vhost website.stats.bor-czuwa.local -user.email "${STATS_EMAIL:?set STATS_EMAIL to the dashboard login address}"
fi
# Collect nothing but the page: no session, referrer, browser, screen size, location or language
# (collect = 0), and raw hits older than 14 days are deleted. Verified by running v2.7.0: every
# page opening then counts once, and the browser and system tables stay empty.
runuser -u bor-czuwa-stats -- /opt/goatcounter/goatcounter db query -db "$db" -format exec \
  "update sites set settings = json_set(settings, '\$.collect', 0, '\$.data_retention', 14)"
systemctl enable --now bor-czuwa-stats.service
systemctl restart bor-czuwa-stats.service
systemctl is-active --quiet bor-czuwa-stats.service

# The counter must be listening on loopback, and on nothing else. Wait a few seconds for it.
listening=
for _ in $(seq 1 15); do
  if ss -ltnH 'sport = :8081' | grep -q '^LISTEN .* 127\.0\.0\.1:8081 '; then listening=yes; break; fi
  sleep 1
done
[[ -n $listening ]] || { echo "nothing listens on 127.0.0.1:8081" >&2; exit 1; }
if ss -ltnH 'sport = :8081' | grep -v '^LISTEN .* 127\.0\.0\.1:8081 ' | grep -q .; then echo "port 8081 is not loopback only" >&2; exit 1; fi
echo "GoatCounter $GOATCOUNTER_VERSION is running on 127.0.0.1:8081 only"
