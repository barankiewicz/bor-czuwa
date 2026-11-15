#!/usr/bin/env bash
# Take an upload into a fresh staging directory for activate.sh, as root, without giving the
# operator a general root write. Installed with the release controls; never run from an upload.
#   receive.sh ENVIRONMENT new                    -> creates a staging directory, prints its path
#   receive.sh ENVIRONMENT STAGING_DIR FILE < data -> writes one of the known candidate files
set -euo pipefail
[[ $EUID == 0 ]]
control=/usr/local/lib/bor-czuwa-release
[[ $(realpath "$0") == "$control/receive.sh" ]] || { echo 'Run the installed copy.' >&2; exit 1; }
[[ ${1:-} == production || ${1:-} == demo ]] || { echo 'Unknown environment.' >&2; exit 1; }
environment=$1
source "$control/environment.sh"
if [[ $# == 2 && $2 == new ]]; then
  mktemp -d "$base/staging.XXXXXXXX"
  exit 0
fi
[[ $# == 3 ]] || { echo 'Usage: receive.sh ENVIRONMENT new | ENVIRONMENT STAGING_DIR FILE' >&2; exit 1; }
# Only a directory this script created (root-owned, under the release base, not a link) and only
# the file names activation reads; anything else could aim a root write elsewhere.
[[ $2 =~ ^$base/staging\.[A-Za-z0-9]+$ && -d $2 && ! -L $2 && $(stat -c %u "$2") == 0 ]] \
  || { echo 'Not a staging directory.' >&2; exit 1; }
case $3 in
  verification.zip|acceptance.json|acceptance.json.sig) ;;
  *) echo 'Not a candidate file.' >&2; exit 1 ;;
esac
[[ ! -e $2/$3 && ! -L $2/$3 ]] || { echo 'Already received.' >&2; exit 1; }
# A 1 GiB ceiling keeps a runaway upload from filling the disk.
head -c 1073741824 > "$2/$3"
