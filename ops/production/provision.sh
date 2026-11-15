#!/usr/bin/env bash
# Run as root on the project's dedicated Debian 13 VPS.
set -euo pipefail
source /etc/os-release
[[ $ID == debian && $VERSION_ID == 13 && $EUID == 0 ]]
: "${SSH_PORT:?Set existing administrative SSH port}"
[[ $SSH_PORT =~ ^[0-9]+$ && $SSH_PORT -gt 0 && $SSH_PORT -le 65535 ]]
if [[ ! -e /etc/bor-czuwa/dedicated-host ]]; then
  [[ ! -d /opt/zabka-stats && ! -d /home/zabka ]]
  [[ -z $(find /etc/nginx/sites-enabled -type l ! -name default -print 2>/dev/null || true) ]]
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg unzip openssh-client nginx postgresql-17 postgresql-17-postgis-3 \
  python3-venv python3-dev libgdal-dev gdal-bin build-essential unattended-upgrades \
  restic certbot nftables openssh-server cryptsetup systemd-cryptsetup
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
cat > /etc/apt/sources.list.d/nodesource.list <<'EOF'
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main
EOF
apt-get update
apt-get install -y nodejs
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]]
id bor-czuwa >/dev/null 2>&1 || useradd --system --home /var/lib/bor-czuwa --shell /usr/sbin/nologin bor-czuwa
for account in bor-czuwa-maint bor-czuwa-build; do
  id "$account" >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin "$account"
done
bash "$(dirname "$0")/harden-ssh.sh"
install -d -m 0700 /etc/bor-czuwa
install -d -m 0755 /opt/bor-czuwa/releases /var/lib/letsencrypt
install -d -m 0755 -o root -g root /var/lib/bor-czuwa
install -d -m 0750 -o bor-czuwa-maint -g www-data /var/lib/bor-czuwa/geodata-extracts
install -d -m 0700 -o bor-czuwa-maint -g bor-czuwa-maint /var/lib/bor-czuwa/monitor
# Refusal tokens: written by root only, read by the monitor account, so that account cannot forge them.
install -d -m 0755 -o root -g root /var/lib/bor-czuwa/refusals
install -d /etc/sysctl.d /etc/systemd/coredump.conf.d /etc/systemd/system/nginx.service.d
# The swap encryption key is generated from /dev/urandom on each boot.
# Reject other active swap rather than paging anonymous request data to plaintext.
while read -r active_swap; do
  [[ $(readlink -f "$active_swap") == $(readlink -f /dev/mapper/bor_czuwa_swap) ]]
done < <(swapon --show=NAME --noheadings)
if [[ ! -f /swapfile ]]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
fi
[[ $(stat -c '%s' /swapfile) == 2147483648 ]]
chmod 600 /swapfile
grep -q '^bor_czuwa_swap ' /etc/crypttab || \
  echo 'bor_czuwa_swap /swapfile /dev/urandom swap,cipher=aes-xts-plain64,size=256' >> /etc/crypttab
sed -i '\|^/swapfile |d' /etc/fstab
grep -q '^/dev/mapper/bor_czuwa_swap ' /etc/fstab || \
  echo '/dev/mapper/bor_czuwa_swap none swap sw 0 0' >> /etc/fstab
systemctl daemon-reload
systemctl start systemd-cryptsetup@bor_czuwa_swap.service
swapon --show=NAME --noheadings | grep -q "$(readlink -f /dev/mapper/bor_czuwa_swap)" || swapon /dev/mapper/bor_czuwa_swap
echo 'vm.swappiness=10' > /etc/sysctl.d/90-bor-czuwa.conf
sysctl --system >/dev/null
cat > /etc/postgresql/17/main/conf.d/90-bor-czuwa.conf <<'EOF'
listen_addresses = '127.0.0.1'
shared_buffers = '512MB'
effective_cache_size = '2GB'
work_mem = '4MB'
maintenance_work_mem = '128MB'
max_connections = 30
log_statement = 'none'
log_min_error_statement = 'panic'
log_min_messages = 'panic'
log_connections = off
log_disconnections = off
log_duration = off
log_min_duration_statement = -1
log_min_duration_sample = -1
log_transaction_sample_rate = 0
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
logging_collector = off
EOF
cat > /etc/systemd/coredump.conf.d/90-bor-czuwa.conf <<'EOF'
[Coredump]
Storage=none
ProcessSizeMax=0
EOF
cat > /etc/systemd/system/nginx.service.d/privacy.conf <<'EOF'
[Service]
StandardOutput=null
StandardError=null
LimitCORE=0
EOF
# Firewall, kernel network sysctls and automatic security updates.
bash "$(dirname "$0")/harden-host.sh"
systemctl daemon-reload
systemctl enable --now postgresql certbot.timer
systemctl restart postgresql
bash "$(dirname "$0")/bootstrap-database.sh"
# PostgreSQL listens on loopback only (listen_addresses above) and pg_hba admits exactly three
# local paths: the postgres superuser over the socket, the maintenance account as the owner over
# the socket, and the runtime role over loopback TCP. Everything else is refused by default.
install -m 0640 -o postgres -g postgres "$(dirname "$0")/pg_hba.conf" /etc/postgresql/17/main/pg_hba.conf
sed -i '/^bor_czuwa_maintenance root bor_czuwa_owner$/d' /etc/postgresql/17/main/pg_ident.conf
grep -q '^bor_czuwa_maintenance bor-czuwa-maint bor_czuwa_owner$' /etc/postgresql/17/main/pg_ident.conf || \
  echo 'bor_czuwa_maintenance bor-czuwa-maint bor_czuwa_owner' >> /etc/postgresql/17/main/pg_ident.conf
systemctl reload postgresql
touch /etc/bor-czuwa/dedicated-host
