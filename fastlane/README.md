# Store submission drafts

These files are drafts for Alicja's approval. Nothing here authorizes a Play upload.
`metadata/android/{pl-PL,en-US}` follows fastlane supply's text and image layout.
Descriptions describe the reporting app, not the separate future public map.

The 512 × 512 icon and the 1024 × 500 feature graphics come from the Bór czuwa kit in
`brand/store/`. Phone screenshots are browser renders
of fictional local records at 1080 × 1920, in both interface languages. After `npx vite build`,
`node scripts/play-screenshots.mjs` retakes all six identically. They are
layout drafts, not evidence from Android. Replace or approve them after the signed
release is checked on a physical phone. No real home, person, note or Report is shown.
The staging title is browser metadata and is outside the screenshot.

Review the descriptions in both languages, the screenshots, icon and graphics.
Check current Play character and image limits at submission. Complete human steps
02 (legal pages), 03 (domain/mailbox) and 04 (signing/distribution). Supply the public
Privacy policy URL and support mailbox in Play Console after those exist; no invented
contact appears in these files. Review [data-safety.md](data-safety.md) against the
release actually submitted, including the map/privacy changes in faza-4 ticket 18.

For the signed AAB and APK, run `npm run build:release` with `ANDROID_API_ORIGIN`,
`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD`. Keep the key outside the checkout. The script fails before
building if a signing value is absent, and production assets still fail until legal
placeholders are completed. It never uses the staging override and never uploads.
Outputs are under `android/app/build/outputs/{bundle,apk}/release/`.
Android versioning belongs to faza-4 ticket 13; check its version code before an update.
