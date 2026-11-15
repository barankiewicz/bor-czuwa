#!/usr/bin/env bash
# Firewall, kernel network sysctls and automatic security updates. provision.sh runs it on a
# fresh host; on an already provisioned host the runbook's Hardening section runs it directly.
# It is safe to repeat. HARDEN_APPLY=0 writes and validates the files without loading them
# (the disposable drill cannot change its host's kernel).
set -euo pipefail
source /etc/os-release
[[ $EUID == 0 ]]
: "${SSH_PORT:?Set existing administrative SSH port}"
[[ $SSH_PORT =~ ^[0-9]+$ && $SSH_PORT -gt 0 && $SSH_PORT -le 65535 ]]
# A wrong port here would lock the operator out, so something must be listening on it right now. The
# listening socket, not `sshd -T`, is the authority: on Ubuntu ssh.socket can listen on a port that
# sshd's own configuration does not report.
[[ -n $(ss -ltnH "sport = :$SSH_PORT") ]] || { echo "Nothing listens on TCP $SSH_PORT; refusing to firewall." >&2; exit 1; }
apply=${HARDEN_APPLY:-1}

# Only SSH, HTTP and HTTPS come in; replies to our own connections come back; loopback is open.
# DHCP answers are admitted by port, since a broadcast offer matches no tracked connection: OVH
# VPSes take their IPv4 address by DHCP, and a dropped offer loses the address when the lease ends.
# The rules live in their own table, so ufw, fail2ban or container rules on the host are left alone
# (the table is deleted and recreated, never `flush ruleset`). It has no forward chain, so it does not
# touch routing either. To back it out from a kept session: nft delete table inet bor_czuwa
install -d /etc/nftables.d
cat > /etc/nftables.d/bor-czuwa.nft.new <<CONF
table inet bor_czuwa
delete table inet bor_czuwa
table inet bor_czuwa {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state invalid drop
    iif lo accept
    ct state established,related accept
    ip protocol icmp accept
    ip6 nexthdr ipv6-icmp accept
    udp sport 67 udp dport 68 accept
    udp sport 547 udp dport 546 accept
    tcp dport { $SSH_PORT, 80, 443 } accept
  }
}
CONF
nft -c -f /etc/nftables.d/bor-czuwa.nft.new
mv /etc/nftables.d/bor-czuwa.nft.new /etc/nftables.d/bor-czuwa.nft
# nftables.service loads /etc/nftables.conf at boot, which is what persists the rules.
[[ -f /etc/nftables.conf ]] || printf '#!/usr/sbin/nft -f\n' > /etc/nftables.conf
grep -qxF 'include "/etc/nftables.d/bor-czuwa.nft"' /etc/nftables.conf || \
  echo 'include "/etc/nftables.d/bor-czuwa.nft"' >> /etc/nftables.conf
if [[ $apply == 1 ]]; then
  nft -f /etc/nftables.d/bor-czuwa.nft
  systemctl enable nftables
fi

install -d /etc/sysctl.d /etc/apt/apt.conf.d
sysctl_failed=0
cat > /etc/sysctl.d/91-bor-czuwa-hardening.conf <<'CONF'
# Server network stack: no spoofed sources, no redirects, no source routing, SYN flood cookies.
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
net.ipv4.tcp_syncookies = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
# Martian packets are dropped but never logged: the kernel log would otherwise keep client addresses.
net.ipv4.conf.all.log_martians = 0
net.ipv4.conf.default.log_martians = 0
# Kernel information and attack surface.
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
kernel.unprivileged_bpf_disabled = 1
kernel.sysrq = 0
fs.suid_dumpable = 0
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
CONF

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
# Security updates only, never a silent reboot: a new kernel waits for the operator. apt list options
# accumulate across files, so the stock 50unattended-upgrades list (which includes plain Debian updates)
# is cleared first.
# Ubuntu's own 50unattended-upgrades already limits itself to the -security pockets.
if [[ $ID == debian ]]; then
  cat > /etc/apt/apt.conf.d/52bor-czuwa-upgrades <<'CONF'
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
  "origin=Node Source,codename=nodistro";
};
Unattended-Upgrade::Automatic-Reboot "false";
CONF
fi

if [[ $apply == 1 ]]; then
  # Our own file only: another sysctl.d file's error must not matter, and the firewall is already loaded.
  # -e ignores keys this kernel does not have (IPv6 disabled, for one).
  sysctl -e -p /etc/sysctl.d/91-bor-czuwa-hardening.conf >/dev/null || sysctl_failed=1
  systemctl enable --now unattended-upgrades
fi
if [[ $sysctl_failed == 1 ]]; then
  echo 'Firewall and updates are in place, but loading the sysctl file failed; run sysctl -p on it and read the error.' >&2
  exit 1
fi
