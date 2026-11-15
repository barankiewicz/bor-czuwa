#!/usr/bin/env bash
set -euo pipefail

if [[ ! ${ANDROID_API_ORIGIN:-} =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]; then
  echo 'Set ANDROID_API_ORIGIN to HTTPS server origin before building Android assets.' >&2
  exit 1
fi

case "${1:-}" in
  '') build=build:staging; mode=staging ;;
  --release) build=build; mode=production ;;
  *) echo 'Usage: build-android.sh [--release]' >&2; exit 1 ;;
esac
# Resolve the same mode-specific environment as Vite before Capacitor chooses the package identity.
VITE_DEMO_TEST_RECIPIENT=$(node --import tsx --input-type=module -e '
  import { loadEnv } from "vite";
  import { resolveDemoTestRecipient } from "./src/lib/demo-policy.ts";
  process.stdout.write(resolveDemoTestRecipient(process.argv[1],
    loadEnv(process.argv[1], process.cwd(), "VITE_").VITE_DEMO_TEST_RECIPIENT) ?? "");
' "$mode")
export VITE_DEMO_TEST_RECIPIENT
VITE_API_ORIGIN="$ANDROID_API_ORIGIN" npm run "$build"
npx cap sync android
