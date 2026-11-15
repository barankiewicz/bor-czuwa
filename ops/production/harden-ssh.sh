#!/usr/bin/env bash
# Keep the current session open until a second key-authenticated login succeeds.
set -euo pipefail
[[ $EUID == 0 ]]
: "${SSH_USER:?Set the existing administrative SSH user}"
: "${SSH_PORT:?Set the existing administrative SSH port}"
[[ $SSH_USER =~ ^[a-z_][a-z0-9_-]*$ && $(id -u "$SSH_USER") != 0 ]]
[[ $SSH_PORT =~ ^[0-9]+$ && $SSH_PORT -gt 0 && $SSH_PORT -le 65535 ]]
operator_home=$(getent passwd "$SSH_USER" | cut -d: -f6)
[[ -s $operator_home/.ssh/authorized_keys ]]
# Keep the managed policy outside Debian's wildcard include directory.
rm -f /etc/ssh/sshd_config.d/00-bor-czuwa.conf
cat > /etc/ssh/bor-czuwa-hardening.conf <<EOF
Port $SSH_PORT
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers $SSH_USER
EOF
# OpenSSH takes the first value; put our include before vendor/cloud defaults.
include='Include /etc/ssh/bor-czuwa-hardening.conf'
sed -i '\|^Include /etc/ssh/sshd_config.d/00-bor-czuwa.conf$|d;\|^Include /etc/ssh/bor-czuwa-hardening.conf$|d' /etc/ssh/sshd_config
sed -i "1i $include" /etc/ssh/sshd_config
/usr/sbin/sshd -t
python3 "$(dirname "$0")/check-ssh.py" "$SSH_USER" "$SSH_PORT"
systemctl reload ssh
