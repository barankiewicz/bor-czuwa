#!/usr/bin/env bash
set -euo pipefail
npm run build:android
(cd android && ./gradlew --no-daemon assembleDebug)
mkdir -p "${CI_EVIDENCE_DIR:-.scratch/ci}/artifacts"
cp android/app/build/outputs/apk/debug/app-debug.apk "${CI_EVIDENCE_DIR:-.scratch/ci}/artifacts/app-debug.apk"
