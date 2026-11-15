#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

for name in ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  if [[ -z ${!name:-} ]]; then
    echo "Missing signing environment: $name" >&2
    exit 1
  fi
done
if [[ ! -r $ANDROID_KEYSTORE_PATH || ! -f $ANDROID_KEYSTORE_PATH ]]; then
  echo 'ANDROID_KEYSTORE_PATH must name a readable keystore outside the repository.' >&2
  exit 1
fi
export ANDROID_KEYSTORE_PATH="$(realpath "$ANDROID_KEYSTORE_PATH")"
case "$ANDROID_KEYSTORE_PATH" in
  "$PWD"/*) echo 'Keep the release keystore outside the repository.' >&2; exit 1 ;;
esac
if [[ ! ${ANDROID_API_ORIGIN:-} =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]; then
  echo 'Set ANDROID_API_ORIGIN to HTTPS server origin before building Android assets.' >&2
  exit 1
fi

[[ $# == 2 ]] || { echo 'Usage: build-release.sh VERIFIED_CANDIDATE_DIRECTORY SIGNED_OUTPUT_DIRECTORY' >&2; exit 1; }
control=/usr/local/lib/bor-czuwa-release
receipt=$(node "$control/release-candidate.mjs" verify "$1" production sign)
[[ $(printf '%s' "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["androidApiOrigin"])') == "$ANDROID_API_ORIGIN" ]] || { echo 'Signing origin differs from tested Android origin.' >&2; exit 1; }
[[ ! -e $2 ]] || { echo 'Signed output directory must not exist.' >&2; exit 1; }
mkdir -m 0700 "$2"
# Sign the CI-produced binaries. Never compile or synchronize a new build here.
"${ANDROID_HOME:?Set ANDROID_HOME}/build-tools/36.0.0/apksigner" sign \
  --ks "$ANDROID_KEYSTORE_PATH" --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
  --out "$2/app-release.apk" "$1/payload/android-release/app-release-unsigned.apk"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs "$2/app-release.apk"
cp "$1/payload/android-release/app-release.aab" "$2/app-release.aab"
jarsigner -keystore "$ANDROID_KEYSTORE_PATH" -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -keypass:env ANDROID_KEY_PASSWORD "$2/app-release.aab" "$ANDROID_KEY_ALIAS"
jarsigner -verify "$2/app-release.aab"
sha256sum "$2/app-release.apk" "$2/app-release.aab"
echo 'Signing complete. Physical fresh-install/update and final acceptance remain required. No upload performed.'
