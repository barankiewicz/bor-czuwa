# Development

The web app and Capacitor Android app support all five Event types, local Drafts,
confirmed Incident areas for shots and home captures, queued sync, Findings,
per-authority Notices, local PDF export and durable Withdrawal. Use fictional Reports
in development. The local stack loads acceptance fixtures, not nationwide coverage.

Current work is Faza 7, the final audit and remediation phase. [Faza 6](.scratch/faza-6/issues/README.md) is closed.
Phase 1 closed by transferring unfinished work; that closure does not authorize release.
The future public map and analytics are separate from this audit phase.

Code, tests, this runbook, `PRODUCT.md`, `DESIGN.md` and the phase-2
spec/index are tracked. Other planning and domain records remain mostly local,
with selected tracked exceptions. Planning links resolve in the maintainer's workspace;
a fresh clone may need those documents supplied separately. Check `git ls-files <path>`
before relying on a local file being included in a commit.

## Architecture entry points

| Responsibility | Owner |
| --- | --- |
| Static SvelteKit app, browser/Android navigation | `src/routes/`, `src/lib/journey-navigation.ts`, `src/lib/platform.ts` |
| IndexedDB Drafts, Reports, tokens and durable Withdrawal; foreground retry | `src/lib/local-store.ts`, `src/lib/sync.ts` |
| Draft readiness and shared Incident geometry | `src/lib/draft-readiness.ts`, `src/lib/home-area.ts` |
| Recipient resolution, Polish Notice composition and local PDF | `src/lib/recipient-resolver.ts`, `src/lib/notice-composer.ts`, `src/lib/notice-pdf.ts` |
| HTTP transport and atomic Report operations | `server/api.ts`, `server/report-domain.ts` |
| Separate Findings and Integrity loops in one Node process | `server/main.ts`, `server/findings.ts`, `server/integrity.ts` |
| Applied-once schema changes and restricted runtime role | `server/migrate.ts`, `server/migrations/`, [migration conventions](docs/migrations.md) |
| Versioned PostGIS datasets and immutable OSM extracts | `scripts/ingest.py`, `scripts/ingest-bubd.py`, `scripts/extract_artifact.py` |
| Static assets, proxy policy and production recovery | `containers/nginx.conf`, [production runbook](ops/production/README.md) |

`CONTEXT.md` defines domain terms; `docs/adr/` owns the legal, privacy and Rule set
decisions. Measurements are Findings, never verdicts. Identity, notes, photo bytes
and exact home fixes stay on the device. A Notice handoff never proves delivery.

## Landing site

The repository is an npm workspace with two members: the app at the root and the public
landing site in `landing/`, a separate SvelteKit static build. `npm ci` at the root
installs both. The landing is not part of the app's build, tests or package, and the
app's scripts behave as they did before it existed.

The landing prerenders four pages (Home, Prywatność, Regulamin, O projekcie) in Polish
at the root and in English under `/en/`. Each page sets `lang` and links to its other
language. The pages are static documents with no SvelteKit runtime. One inline script in
`landing/src/app.html` sets the light or dark theme before first paint and drives the header
switch; `landing/static/motion.js` runs the scroll reveals on Home. `svelte.config.js` allows
the inline script and each language's JSON-LD block by hash, so any edit to them is picked up
by the next build.

The landing reuses the app's sources and keeps no copies of them. A Vite alias reaches
the app's tokens and font declarations (`src/routes/tokens.css`, which the app's
`page.css` imports too), the mark in `brand/` and the legal markdown in
`src/lib/legal/v1/`. The app's three text fonts and the kit's icon and share image reach
`landing/static/` as symlinks, so they keep fixed URLs. The display face, Archivo, is cut
from `brand/src/fonts/` by `landing/scripts/subset-archivo.sh`. The privacy policy and terms are therefore the same files in both
places: the app renders them at its versioned routes for offline use, and the landing
renders them again. The English translations, `privacy.en.md` and `terms.en.md`, sit beside
them; the landing's English routes render those, and the Polish text is the binding one. One
rewrite differs: the texts link to each other at the app's routes, and the landing points
those links at its own pages. The share images in `landing/static/share/` are drawn from the brand kit by
`npx tsx landing/scripts/build-share-images.ts`; `landing/src/lib/share.ts` says which image each
page uses. The site's constants (app URL,
Play listing URL, source repository URL, the portfolio URL and the flag that shows or
hides the Play badge) are in `landing/src/lib/site.ts`. The domain in them is the
working assumption, not a cleared name.

```sh
npm run build:landing   # static files in landing/build/
npm run dev -w landing  # local dev server on 127.0.0.1
npm run test:landing    # builds the app and the landing, then runs their tests
npm run check           # the app's checks, then the landing's
```

`test:landing` needs Chromium (`npx playwright install chromium`) and no database or
Compose stack. It holds two tests. One loads the app's and the landing's privacy and terms
pages in a browser and fails if their text differs, and holds the English routes to the
English files. The same-origin test loads every landing page under its production origin and
fails if any request leaves it except the page-opening count; `count.test.ts` drives that count
with the app host intercepted, so no test reaches a live collector. `head.test.ts` reads the share
tags, structured data and crawler files from the build, and `htaccess.test.ts` runs the built
`.htaccess` through a local `httpd` and skips where there is none. The app's `build` script, which stops on
legal placeholders, is not what `test:landing` runs; it uses a plain `vite build`.

## Release gates

Public release remains blocked. [Human steps](.scratch/pre-production-human-steps/README.md)
cover approved Notice fragments, legal review, accounts and signing/distribution.
Steps 06/08 gate the separate formal follow-up capability. The six-week Signed Notice check-in is hidden by default. Build with
`VITE_CHECK_IN_ENABLED=true` to restore its prompts, tasks and reminders after steps
06/08 are approved. Rebuild the web or Android assets when changing this flag.
Hidden builds cancel pending check-in reminders at startup and keep recorded
Notice events and outcomes. The interval is not a validated statutory deadline.
Run `npm run test:check-in` before switching the flag on. It builds the web image with
`VITE_CHECK_IN_ENABLED=true`, runs `check-in.spec.ts` and `latest-work.spec.ts` once
against a disposable stack and fails unless the three flag-dependent specs ran and passed. Ordinary
`npm run test:browser` runs keep skipping the three flag-dependent specs.
[Ticket 29](.scratch/faza-2/issues/29-directory-release-gate.md)
requires verified authority inbox coverage or an explicit owner-approved exception.

Production runs on the one OVH VPS, in Canada. Dedicated-host provisioning,
provider logging/DDoS controls, real TLS, remote backup retention and authorized alert
delivery still need the evidence listed in
[ticket 28's verification record](.scratch/faza-2/evidence/28-production/verification.md).
Local restore and browser tests do not close those checks.
[Ticket 31](.scratch/faza-2/issues/31-release-acceptance.md) owns final web, physical Android
and restored-infrastructure acceptance, including remaining suite failures. Neither
prototype approval nor an individual implementation ticket closes these release gates.

## Place search and map requests

Place search runs only when a Reporter submits a name. It uses the public
[Nominatim service](https://operations.osmfoundation.org/policies/nominatim/)
through `/api/places`. The app does not offer autocomplete. The server sends
only the submitted text, limits results to five places in Poland, identifies
the application, and allows at most one upstream request per second across
the process. Successful results are reused from a 200-entry memory cache for up to
24 hours. Entries remain until replacement or eviction; restart clears the cache.
The app does not store the submitted search text or the result list. If the
Reporter chooses a reference place and confirms a direction and distance from
it, the Draft keeps that reference and offset on this device. They are omitted
from the saved Report, Notices and server requests. The API sends no saved device fix, home fix,
or map center with the search. Search text is not written to application logs.

Nominatim receives the submitted name and the server's IP address. Its own
handling of requests follows the
[OpenStreetMap Foundation privacy policy](https://wiki.osmfoundation.org/wiki/Privacy_Policy).
The search prompt asks for a town or place and warns against entering a home
address. Public Nominatim can refuse requests or change its policy, so the
provider sits behind the app's API route and can be changed on the server.

Map tiles come directly from `tile.openstreetmap.org` after the Reporter presses
„Pokaż mapę”. The picker and kept-place preview share this choice for the current
page session. Both start closed after a reload. The picker starts on the chosen
point, the Draft's GPS fix, or a Poland overview; it never uses the saved home as
a fallback. The kept-place preview fits the Incident location and any Draft fix.
OpenStreetMap sees the device's IP address and viewed area, including new areas
requested by panning and zooming, under its privacy policy. Search is visible
above the map and is available without opening map imagery. A result moves the
map but does not select the Incident point. The Reporter can instead give a
direction and distance from the named reference, confirm that choice and adjust
its radius. The Draft and Sprawdź describe the selected place in words. Loading
or incomplete map imagery disables pointer, Enter and Space selection. Coordinate
entry and the reference-place form remain available; retrying does not change
the selected place.

## Incident location

The Draft records what the Reporter knows, and `src/lib/home-area.ts` turns
it into the one place that Sprawdź draws, saving confirms and the Report
sends. No screen shows sizes, cells or bounds.

Gdzie stores the active location method in the Draft. Switching methods keeps
the inactive point and radius or direction and distance on the device; only the
active method supplies the Incident location. A late GPS fix makes direction
available without changing the method or accepting a missing manual point.
Coordinate entry works before map consent. Opening the map centers the chosen
point, or the Draft's GPS fix when no point has been chosen.

| Draft | Sent | Size |
| --- | --- | --- |
| Shot heard now, away from home | area with `hearing_bearing_deg` and `hearing_distance_m` | square of side 2r around the estimate; r = max(250 m, half the distance), the distance alone, or 1 km with no estimate |
| Shot heard now, from home | fixed grid cell holding the estimate, no direction or distance | 4 km cell when r <= 1 km, else 8 km |
| Point and radius (earlier, no GPS, or changed) | area around the point | square of side 2r from the radius slider (100 m to 3 km); a grid cell when the point is at home |
| Person with a gun, injured animal or poaching seen now, away from home | area with basis `estimated_from_sighting`, direction and distance in the `hearing_*` fields | as a shot heard now, but with no estimate the device fix with its Accuracy |
| Person with a gun, injured animal or poaching seen now, from home | fixed grid cell holding the estimate, no direction or distance | as a shot heard now; 4 km with no estimate |
| Remains now, from home | grid cell holding the home | 4 km |
| Remains now, away from home | the device fix with its Accuracy | none |

A saved home answers the home question by distance (150 m) unless the
Reporter answered it; otherwise Sprawdź asks. A device fix farther than
150 m also asks when its Accuracy circle reaches into the home zone
(distance minus Accuracy is at most 150 m), because the Reporter could be
at home. A place the Reporter chose on the map has no Accuracy and is
judged by distance alone. Changing the place reopens
the question. The Draft stores the area that was on screen when the
Reporter saved, so any later change of place, direction, distance or radius
needs a new save on Sprawdź. The server refuses a home area smaller than the
grid or carrying direction or distance, and areas under 150 m a side.
`/api/area-places` accepts the same areas, writes nothing and has its own
nginx rate limit. Builds before this contract sent a distance band, which
the server still accepts. The estimate model (half the distance, at least
250 m) is the prototype's and has not been checked against how well people
judge gunshot distance.

## Asset delivery and the authority directory

nginx gzips HTML, CSS, JavaScript, JSON and SVG responses, API responses
included, and sends `Vary: Accept-Encoding`. Files under `/_app/immutable/`
have content hashes in their names and are cached for a year as
`immutable`. Everything else, including `/`, `/_app/version.json` and
`/service-worker.js`, is sent with `Cache-Control: no-cache`, so a browser
revalidates it on every use and finds a new build straight away.

The authority directory (police, PSŁ, RDOŚ, national parks and gminy, about
1.2 MB of JSON and 87 kB gzipped) is not part of the capture code. Its four
files are hashed build assets that the app fetches when the Reporter opens
Notice recipients. Nothing in capture waits for them, and capture never
fetches them before the first save.

The service worker installs only the capture shell: the app code, the
interface font, the start page and the two legal pages. The authority
directory and the PDF engine (the pdf-lib chunk and Noto Sans) are separate
caches that the page asks the worker to fill after capture is usable, one
file at a time, so a failed or interrupted download leaves capture ready and
resumes with what is missing. The groups are read from the client Vite
manifest at worker build time, so hashed names follow the build. Menu leads
with language and one offline summary: ready, downloading, or the features
that still need a connection. It offers a download only when files are missing
and the phone is online; reconnecting retries on its own. Storage and Android
reminder advice stay in Menu, while save errors stay where they happen.
The Android app bundles every file
and always reports ready. If the directory still cannot load, the recipients
screen says so, says the Report is still saved, and offers a retry. Review
renders live in `prototypes/review/`, outside the public build.

## Run locally

Requires Node 22.12 or later, rootless Podman, a Compose provider, and systemd user
services. The database credentials in `compose.yaml` are disposable local values.
All published ports bind to loopback. Run commands from the repository root.

```sh
npm run stack
```

This starts the Podman user socket, builds the containers, starts PostgreSQL 17 with
PostGIS, applies migrations in a separate service, loads the checked-in fixture,
and serves the app at http://localhost:3000. The API uses the restricted runtime role.
The first build downloads container images and dependencies. Subsequent fixture
loads check the snapshot and leave existing Reports intact.

The API listens at http://localhost:3001. PostgreSQL uses localhost:54329. Stop the
stack with `podman compose down`; its named database volume remains.

For client development, run `npm ci` and `npm run dev` with the stack running.
Vite proxies `/api` to the container. Offline reload needs the production build,
so browser tests use the nginx app on port 3000.

### Container build inputs

`npm run stack`, `npm run test:isolated` and `docker compose up --build` all build
`containers/app.Containerfile` and `containers/ingest.Containerfile` with the repository
root as the context. So does a direct `podman build` or `docker build -f containers/...`
run from the root. Every one of these reads `.dockerignore`: Docker does unless a
`containers/<name>.dockerignore` sits beside the Containerfile, and Podman falls back
to it because the repo has no `.containerignore`. Do not add either kind. The engine
would read that file instead, and the two engines would see different files.

The policy denies everything and then admits the root build configs plus `src`,
`server`, `static`, `data`, `scripts` and `containers`. Inside those directories it
excludes `.env` files, keys, keystores, captures, logs, caches and build output again.
A new build input needs its own line. An ignore rule cannot tell that an ordinary
filename holds a secret, so keep credentials, captures and local data outside the
admitted directories. `.npmrc` is not admitted, because it is where registry tokens
usually live; the Containerfile passes its `audit` and `fund` settings to `npm ci` as flags.
The production deployment ships `git archive HEAD` and builds no container.

To check the boundary for one engine:

```sh
node scripts/check-private-context.mjs --engine podman
node scripts/check-private-context.mjs --engine docker --build-images
```

The script copies only tracked files into a temporary directory and never reads the
real private ones. Untracked files under the admitted directories are recreated there
by name, empty. It plants a synthetic marker in 32 private paths (tool worktrees,
`.aws/credentials`, a keystore, test output, a `.env` inside `src/` and others), builds
a `FROM scratch` image that holds the whole context, and scans every layer,
decompressing gzip and zstd layers. It fails when:

- a private marker is in any layer (`private_marker_in_layer`);
- the context holds a file that is not a tracked file under the admitted roots, such as
  a stray `data/reports-dump.json` in your checkout (`unexpected_in_context`);
- a tracked file under the admitted roots is missing, which catches an exclusion that
  is too broad (`tracked_input_missing`);
- a `.containerignore` or a `containers/*.dockerignore` exists (`other_ignore_file`).

`--build-images` also builds the fixture, app and web images through Compose and scans
all their layers, inherited ones included; with Podman it starts the user socket first.
`--negative` admits `.tools/` and must exit 1 with `private_marker_in_layer:context`.
Build logs go to stderr. The last stdout line is a JSON summary with the context's file
count and size in bytes, the commit, and whether the tree had uncommitted changes.
The script removes the images it tagged and its temporary files, but the engine keeps
its build cache. The saved images are unpacked under the system temporary directory;
set `TMPDIR` elsewhere if `/tmp` is a small tmpfs, since the fixture image is 1.7 GB.

`tests/private-build-context.test.ts` runs the plain check and the negative control for
each engine that `podman info` or `docker info` can reach, so `npm run test:api` and the
isolated runner include it.

## Checks

The agreed seams are real HTTP with disposable PostGIS, Notice composer golden texts,
browser and physical Android journeys, and deployment/restore/privacy checks. Keep
independent geospatial expectations and review changed Notice goldens before accepting
them. Documentation-only work uses link/status review and a runbook walkthrough.

Browser PDF checks require Poppler's `pdftotext` and `pdfinfo` commands
(`poppler-utils` on Fedora).

```sh
npm ci
npx playwright install chromium
npm run check
npm run test:isolated
```

The isolated command runs API and browser suites twice. Each run gets a new Compose
project, PostGIS volume, network and loopback ports. The ports come from 20000 to 32767,
below the kernel's ephemeral range, and each is checked free first; if Compose still
reports one in use, the runner draws new ports and records the retry in the run report.
Podman allocates and reserves the network subnet before Compose starts, avoiding occupied
subnets. It removes that project's containers, network, volume and its four image tags
(`-app`, `-migration`, `-fixture`, `-web`) on exit, by exact name and never with a prune. It never reads `DATABASE_URL` or touches
the regular developer stack. Tests that inspect PostGIS require `TEST_DATABASE_URL`;
tests that start their own API or worker also use `DATABASE_URL`. The runner sets
both to the disposable database, plus `TEST_BASE_URL` and `TEST_WEB_URL` to its services.
`TEST_RUNTIME_DATABASE_URL` supplies the restricted `app_runtime` login separately
for fixtures that create their own database and run an HTTP API and worker in
the test process. These fixtures reserve owner credentials for setup.

The runner first uses the workstation's user-systemd Podman socket. Without a user
session, it reuses a responding rootless socket or starts an owned Podman API
service. It records the selected path and stops only its own service during cleanup.
Hosted setup does not establish a trusted successful candidate run; retain the
workflow URL, source/artifact identity and every required result separately.

The command writes source, build and fixture hashes, starting/ending row counts
and suite results to `.scratch/faza-2/evidence/01-isolated-baseline.json`. API
output and Playwright failure traces stay under `.scratch/` and `test-results/`,
outside production assets. The source hash includes the current commit, tracked
working diff, non-ignored untracked files and lockfile. Fixture hash covers
`data/fixtures/`, rule data and Notice goldens, plus generated workload files. Existing independent geospatial
expectations and Notice golden texts remain inputs; the runner does not regenerate
them.

Startup, suite and cleanup failures appear in the evidence file's `failures` list;
even a failure before the first suite produces evidence and a nonzero exit.
Image fingerprints inspect only the four images used by that run and retain IDs,
digests and requested references.

Before the browser suite, the runner clears only its disposable database's rate
counters. Capture-only journeys intercept Report uploads; sync journeys still use
the real API. After the suite, the runner prints and records daily counts per
IP/scope and fails if any current count reaches the 50-write limit. The deliberately
fixed-clock midnight and DST tests each create a new migrated database and an API
process with restricted runtime credentials. Only that process owns the test clock;
no Findings or Integrity worker runs against its data. The helper acknowledges clock
changes before requests continue and closes the API before dropping its database.
Live cleanup cannot delete these counters, and the tests do not spend the live
stack's budget. Production rate limits remain unchanged. The geospatial API test file
also owns its API server, using the live clock and fixture database so the normal
Findings worker still computes its Reports. Its admission budget is separate from
other API files. The worker requeue test holds a Findings write lock only while it
checks the reset job, then lets the live worker continue.

Clocked test teardown closes its owned HTTP connections before the database pool.
The helper still rejects a killed or unsuccessful API exit; unfinished client
connections must not turn cleanup into a five-second forced-kill race.
The parent fixture uses one PostgreSQL Client and awaits its physical connection
end before dropping the database; a Pool end callback can precede socket closure.
Browser clock tests stop the page worker and drain forwarding handlers before
closing their API, so cleanup does not interrupt an in-flight routed request.

`npm run test:workloads` creates deterministic 10,000-Report JSONL datasets for
scattered points and a same-point/same-photo cluster under `.scratch/`. Use each
file's first 100, 1,000 or 10,000 rows for later benchmarks. IDs, times, points
and photo hashes are stable; all records are synthetic. `test:isolated` generates
and hashes both datasets before its runs.

`scripts/run-national-mixed.py` keeps the original three 1,000-point phases and
adds three 1,000-area phases covering home cells, hearing and sighting estimates,
and Reporter-selected areas. Source anchors must cover the whole generated area;
the area cohort never replaces or shrinks the point cohort. `--test --inputs
data/fixtures` also runs the bounded real HTTP/worker area-driver regression,
including independent home-cell expectations and truthful outside-coverage cases.
Supply cached images through `--app-image` and `--ingest-image`; the app image's
lockfile must match the source. Fixture success is not a national timing or
dedicated-host capacity result. Retain the source, data, limits and every failed
attempt separately from measured national results.

The controlled browser suite uses one Playwright worker at 390 × 844 CSS pixels,
against the local built web app and API. Record browser version with any timing
comparison. It verifies functional results, not an Android performance budget.
For low-end Android measurements, record device model, Android version, app build
hash, battery/thermal state and network conditions with each result. No physical
Android device or performance budget is assumed by this baseline; later tickets
set budgets from measured workloads.

The API tests use real PostGIS through HTTP. Browser coverage includes offline
reload, Report capture, reconnection, Findings and the fields sent to the server.
The isolated report keeps current-run failures separate from the audit baseline.
For a focused test, provision a separate disposable Compose project with its own
ports and subnet as the runner does. Set `DATABASE_URL` and `TEST_DATABASE_URL` to
that database, and `TEST_BASE_URL`/`TEST_WEB_URL` to its API/web URLs. Then run, for
example, `npx tsx --test tests/notice-composer.test.ts` or
`npx playwright test tests/browser/notices.spec.ts`. `npm test` runs both complete
suites against those services; it does not create an isolated database. Never point
these commands at the regular developer or operator database.

`npm run test:ops` separately checks production backup/expiry tooling and needs restic.
It also runs the extract and geodata fetch tests, which need only the standard library.
Three Python files are drill-only, run by `scripts/production-drill.py` or by hand and
never by CI: `test_host_hardening.py`, `test_production_restore.py` and
`test_findings_monitor.py`. [docs/ci.md](docs/ci.md) says why.
The fresh-host restore drill has additional prerequisites in the
[production verification record](.scratch/faza-2/evidence/28-production/verification.md).

Follow the [full UI contract](.scratch/faza-2/spec.md#ui-acceptance-contract): 56 px
effective targets, WCAG 2.2 AA, keyboard/focus, 320 px reflow, 200% text, short
landscape, desktop, light/dark/noc and reduced motion. Keep detector and visual
review renders outside public assets, provide Polish copy before/after, and verify
native behavior on physical Android. Browser simulation does not replace that proof.

Browser regressions also cover rapid connectivity changes during IndexedDB reads
and a delayed GPS callback from a previous capture. Both failed before their fixes.

Draft editing submits native writes without waiting for an earlier commit;
Report saves and deletions remain ordering barriers. The prepared IndexedDB
writer explicitly starts transaction commit before a lifecycle handler returns.
Successful saves still await both the request and transaction completion.
Note input retains its 400 ms debounce. Lifecycle handling never blocks leaving
or makes a second persistent copy of the Draft.

The native durability regression holds an independent Draft-store transaction
using `getKey`, without reading Draft values or writing data. Trusted `pagehide`
aborts that blocker. A bare reader then checks the exact Draft ID, note and
captured time before application hydration. Its diagnostic Service Worker bypass
covers input through the raw read, not only the reader request. This is not proof
of ordinary Service Worker departure, browser-process death or physical Android
lifecycle behavior.

Pull requests and release-branch changes use the [candidate checks](docs/ci.md).
The workflow retains required results and staging artifact identities. Hosted run
proof and release approval remain separate from local verification.

## Release builds

`npm run build` creates production web assets and rejects test markers and legal
placeholders in the shipped files. Human step 02 must approve and complete the legal
pages before this passes. `npm run build:staging` explicitly skips that gate for internal
checks and gives every route a staging title and `noindex`. The local fixture container
uses staging. Do not deploy its output publicly. To recheck existing output, run
`node scripts/check-release.mjs`.

The staging command also sets `MODE=staging` for SvelteKit's analysis and prerender
workers, which reload Vite configuration separately. A private demo recipient
does not relax production-mode validation.

A clean checkout names the build after its commit, so two clones of one commit built
with the same command produce the same archive, whatever the clone path, build time, umask
or `LANG`. The inputs that must match are the commit, a `node_modules` installed by
`npm ci` in that checkout (`scripts/ci/release-artifact.mjs` refuses a symlinked one,
because its target's paths and package versions end up in the hashed files) and the Node
version. An inherited `SOURCE_DATE_EPOCH` is ignored; the archive time is the commit time.
A dirty tree, or a build without `.git` such as the container build, keeps SvelteKit's
default name (the build start time) and is not reproducible. `KIT_VERSION_NAME` overrides
the name; the update test uses it to build two releases from one source, and the release
script refuses to run with it set.

Python installs from `scripts/requirements-hashes.txt` with `pip install --require-hashes`,
which checks every package hash and refuses any dependency the file omits. After editing `scripts/requirements.txt`, regenerate it with
`grep -v '^GDAL==' scripts/requirements.txt | uv pip compile - --universal --generate-hashes
--python-version 3.12 -o scripts/requirements-hashes.txt`. GDAL stays out of that file and is
the one unhashed input: production installs the host's own `gdal-config` version at
activation, and the ingest image installs the version pinned in `requirements.txt`.

`npm run build:android` bundles staging assets for debug checks. The production
`npm run build:release -- CANDIDATE NEW_OUTPUT` command instead verifies an
authenticated production candidate and signs its already compiled unsigned
APK/AAB; it never rebuilds or synchronizes new assets. Its four existing signing
variables refer to an authorized keystore outside this checkout. Production
signing, legal and human acceptance remain separate from private debug testing.
Store drafts, images and the data-safety answers live in [fastlane/README.md](fastlane/README.md).
They require Alicja's approval before submission. This command does not upload anything.

`npm run finalize:android:test -- CANDIDATE NEW_OUTPUT EXPECTED_COMMIT PRIVATE_BRANCH`
is the separate local private-test path. Run the independently reviewed helper,
not candidate/upload code. It authenticates successful staging CI, checks the
approved demo origin/inbox through the runtime-consumed configuration module and
exact helper/build-source bytes, then finalizes an APK copy with
the existing pinned debug/test identity. It verifies unchanged non-signature
payload, manifest/version, bundled offline shell and certificate, and retains
original/final hashes in `provenance.json`. It neither installs an app nor grants
production eligibility. See the [private-test command and credential boundary](docs/release-candidate.md#finalize-a-private-test-apk-locally).

## Android APK

The release version comes from `package.json`. Gradle derives `versionCode` as
`major * 10000 + minor * 100 + patch`; minor and patch must each fit 0 to 99,
and the code must be positive and below Play's limit. Version `0.1.0` has code `100`.
The web bundle targets Chromium 107, which is also the minimum Android WebView.
An older provider opens the bundled `webview-update.html` without app JavaScript.
Huawei's provider uses another version scheme and is refused until its Chromium
compatibility is verified. A Chromium-based provider meeting the minimum is required.
The update screen follows the system's light or dark appearance.

Android 12 and later exclude every app-data domain from both cloud backup and
device transfer through `data_extraction_rules.xml`; `allowBackup` remains false.
Notice-mail attachment copies expire after an hour. Startup and the next mail
handoff remove expired copies; completing a Withdrawal removes all copies. A
failed cleanup leaves the Withdrawal pending for retry. Android gallery reads dimensions with BitmapFactory's bounds-only pass, then
decodes with power-of-two sampling so its pixel bitmap stays within 2048 pixels.
EXIF orientation is applied before JPEG encoding. Both bitmaps are recycled;
Capacitor runs the decoder on its plugin thread. Encoded bytes use the existing
metadata stripping and hashing path. Web gallery reads JPEG/PNG headers before
decoding and admits at most 12 million pixels, an 8192-pixel edge and 20 MiB of
encoded bytes. It rejects unsupported formats, animation and malformed headers
before requesting a resized, EXIF-oriented bitmap. Rejection preserves the Draft
and earlier photos; choose another file to retry. Output stays within 2048 pixels.
The browser may still decode an admitted full frame before resizing. These are
conservative admission limits, not a measured guarantee for every device or codec
scratch allocation. Android decoding is unchanged.

### Brand assets

The mark, logotype and every icon made from them live in `brand/`, drawn by `brand/src/build.py`
(see `brand/README.md`). Change the generator, not the SVGs. The web app inlines
`brand/symbol/symbol-white.svg` in the header and serves `static/brand/favicon.svg`, a copy of
`brand/icons/favicon.svg`; copy it again after a rebuild of the kit. After changing the Android layers in
`brand/android/`, run
`python3 scripts/build-brand-assets.py` from the repository root (requires ImageMagick's `magick`).
The script turns the launcher foreground, the themed monochrome layer and the day and night splash
into Android vectors, and cuts the legacy launcher PNGs from the same layers. The launcher
background and the day splash use the paper color (#f6f7f5), the night splash #1b1a17. The web
header draws the one-colour symbol in the band's text color. Check small-size rendering and Android
icon masks after a change.

### Build and install

Use JDK 21 and Android SDK 36. Set `ANDROID_HOME` if Gradle cannot find the SDK.
The phone must be able to reach the HTTPS API origin used in the build:

```sh
ANDROID_API_ORIGIN=https://your-api.example npm run build:android
cd android
./gradlew assembleDebug installDebug
```

`build:android` builds staging assets and copies them into the Capacitor project.
The debug APK uses the Android debug key. For a Play upload, set
`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and
`ANDROID_KEY_PASSWORD` in the build environment, then run `npm run build:release`
from the repository root with `ANDROID_API_ORIGIN` set. This rebuilds production assets
and checks the release gate before signing. Do not sign the staging assets from the
debug recipe. Keep the keystore and passwords outside the repository. Step 04 owns
key generation and Play upload.

The footprint test was run against a temporary centroid mutation. It failed with
145.896 m instead of the independently measured 140.000 m. The mutation was removed
before running the passing test. Measurement methods and source hashes live in
[the fixture record](data/fixtures/README.md).

## Boundaries

Signed Notices can be exported as PDF on the device, including offline. The PDF
uses the existing composer and an embedded Noto Sans font for Latin, Greek and
Cyrillic text. Unsupported characters stop export and offer a copy-to-editor
fallback instead of producing an incomplete document. Web downloads the file;
Android opens the system file picker. Photos are saved separately. Exporting and
opening official-service instructions do not create lifecycle events. The
Reporter records confirmation and outcomes through the existing Notice flow.

The instructions link to the official general letter, e-Doręczenia and document
signing pages. On 26 September 2026, the signing page listed PDF among accepted
formats, with a 25 MB limit; the general letter page allowed attachments up to
150 MB combined. Limits and route availability must be checked on the chosen
service. The app does not authenticate, sign, upload or submit there.

Pixel 10a checks on 26 September 2026 covered native PDF save and cancellation,
a separate JPEG save, and opening the official instructions in the external
browser. The saved PDF preserved Polish and Cyrillic names and the `№` symbol.
Notice status stayed unchanged. Authenticated filing was not performed.

IndexedDB owns the immutable Report, a random 256-bit token, and local lifecycle
events. The Report transport and proof solution reach `POST /api/reports`; the server stores
the token's SHA-256 hash. Findings reads require `Authorization: Bearer <token>`.
Unknown fields are rejected at every transport object. There are no accounts,
identity fields, device identifiers, photo bytes, or note text on the server.

An insert, its lifecycle events, and its Findings job commit together. Repeating
the same ID and token hash returns 200; a different hash returns 409. Workers claim
jobs with `FOR UPDATE SKIP LOCKED`. Each computation uses one database snapshot,
writes a distance state with separate Accuracy, and records its Rule set and
geodata snapshot. Transient failures get three retries; terminal failures stay
visible through the API.

The loader streams GeoParquet row groups, keeps KST 110, preserves `LOKALNYID` as
text, and validates EPSG:2180 footprints before publishing them in one transaction.
The fixture has a smaller interior coverage window with a checked 1000 m margin.
Points outside that window yield `point_outside_fixture`, not a claim about absent
buildings. A refresh loads new tables in a separate schema, then switches the five
public views and `current_geodata` in one transaction. Two storage vintages remain;
older snapshot metadata stays for existing Findings.

## Geodata refresh

Run `npm run ingest` in the ingestion environment with `DATABASE_URL` and
`GEODATA_EXTRACT_DIR=/var/lib/bor-czuwa/geodata-extracts` set. It downloads
current BUBD, BDL, five GDOŚ layers, CRFOP, PRG, and OSM hunting stands. CRFOP and
PRG URLs come from their current dane.gov.pl resource records. A matching set of
hashes skips publication. Failures leave the current views in place and append to
`geodata-refresh.log`, or to `GEODATA_REFRESH_LOG` when set.

`ops/geodata-refresh.service` and `ops/geodata-refresh.timer` schedule the command
on the first day of each month. Install them with the production box setup. Run
`npm run load-rule-sets` when a rule file changes.

Each snapshot has ten rows in `geodata_dataset`. PRG uses two downloaded ZIP files;
its row keeps both file hashes in `source_files` and a SHA-256 of those hashes in
`sha256`. The fixture's PRG row instead records hashes of its clipped input files.

## OSM hunting stands and ODbL

The monthly refresh downloads Geofabrik's dated Poland OSM extract and keeps features
tagged [`amenity=hunting_stand`](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dhunting_stand)
or the legacy `hunting=stand`. Polygon and line features become centre points for distance
measurement. Findings report the nearest mapped stand from the indicated point or
from the edge of an Incident area (0 m when a stand lies inside). The result describes OSM data, not where a shot
occurred. Missing tags and incomplete mapping cannot establish that no stand exists.

The filtered extract is a derivative database. ODbL 1.0 sections 4.3 and 4.4(c)
apply when a Finding is shown publicly. Each OSM result credits OpenStreetMap
contributors, links the ODbL license, gives its retrieval date and snapshot ID,
and links the exact filtered GeoJSON sequence at
`/api/geodata/{snapshot_id}/ambony`. nginx serves the exact filtered bytes from
`GEODATA_EXTRACT_DIR`, with ETag, Last-Modified and Range support. Publication
copies to a temporary file, checks its SHA-256, then creates the final name in
one filesystem operation before the database switches snapshots. A failed copy
leaves the current snapshot in place. If the database rejects publication,
ingestion checks for a committed snapshot and removes an unreferenced file. If
that check cannot reach the database, it keeps the complete file to avoid losing
a committed snapshot's download. Check `geodata_snapshot` before removing one.

Keep every published extract indefinitely, including after older spatial tables
are removed. Back up this directory with the database and
restore it before serving traffic. The local stack shares a named volume between
fixture ingestion and nginx, mounted read-only in nginx. Production nginx needs
read access to the same path. At most two downloads run globally and two per
address; the route also allows one new request per second with a burst of two.
Ordinary API requests keep their own connections and database pool.

Ticket 27 was checked on 2026-09-29 against the isolated Podman stack. A
1,719,414,421-byte sparse file, the measured national BUBD source size, stood
in for a large ambony download. Two clients paused after response headers;
both got 200 with full Content-Length. A third download got 429 while health
still returned 200. nginx memory was 3.334 MB idle and 8.487 MB during the
check; app memory was 120.0 MB idle and 120.6 MB during. The test used a sparse
file because the actual national ambony extract was unavailable here. It checks
bounded size and slow clients, not production throughput or real OSM contents.

Before replacing an existing deployment's API download route, export legacy
`osm_stand_extract` rows with the ingestion Python environment:

```sh
DATABASE_URL="$MIGRATION_DATABASE_URL" \
GEODATA_EXTRACT_DIR=/var/lib/bor-czuwa/geodata-extracts \
python scripts/export-ambony.py
```

The exporter reads 1 MiB chunks, compares an existing file's SHA-256, and deletes
each database row only after its file is durable. Rerunning resumes remaining
rows. Check that nginx can read the files before switching
the route. Direct API access to this download path then returns 404. Reuse of the
download follows ODbL. No non-OSM source data is included in that download.
Source: https://www.openstreetmap.org/copyright and
https://opendatacommons.org/licenses/odbl/1-0/.

On 2026-09-25, the 1,719,414,421-byte national BUBD file produced 8,104,084
residential footprints. The dwelling table and its indexes used 2,926 MB. The load
completed with the database capped at 2 GB RAM and 1 GB swap, and the loader capped
at 1.5 GB RAM and 1 GB swap. Killing a separate load during the copy left the
previous snapshot live; API checks finished in 3.2 seconds during that load.

Sync runs while the document is visible. Network failures retain the local Report
and retry with backoff. A rejected Report stays local. Challenge solving, rate-limit
handling, and retry after an app update belong to ticket 10. The service worker
caches app assets only; API responses and tokens stay out of its cache. nginx and
the API do not log requests, headers, bodies, or client addresses.

## Protected areas

Findings include protected-area rows. The checked-in protected polygons
and CRFOP workbook are synthetic acceptance data; see
[their fixture record](data/fixtures/protected/README.md). The rest of the fixture
still uses real BUBD footprints. This build remains an internal test app.

The loader reads the five designated GDOŚ GeoJSON layers in EPSG:2180 and the
CRFOP reserve XLSX export. It splits park and reserve otulina by the literal
`" - otulina"` suffix. CRFOP document flags join on `inspire_id = kodinspire` only.
A missing identifier cannot establish that a reserve has neither document.
Missing flags, conflicting records, unrepairable polygons or incorrect hashes abort
the transaction, leaving the previous snapshot available.
The national GDOŚ download contains 24 self-intersecting polygons. Ingest repairs
them with `ST_MakeValid` only when the area changes by at most 0.01%; a larger
change aborts the refresh. The national BDL download has 14 polygons repaired
under the same limit.

To fetch national source files, run this in the ingestion environment, supplying
the current dated reserve export URL from dane.gov.pl dataset 471:

```sh
python scripts/fetch-protected-areas.py /tmp/protected-download \
  https://api.dane.gov.pl/media/resources/20260204/rezerwaty_przyrody_-_stan_na_04.02.2026.xls
```

The downloader checks each WFS feature count against `resultType=hits`. It uses
only the designated layers, without proposed or consulted enlargements. It
writes retrieval times and SHA-256 hashes to its manifest. The CRFOP workbook
uses an `.xls` extension despite containing XLSX; openpyxl reads the bytes and
ignores its incorrect declared worksheet dimensions.

Pass that manifest as the fifth loader argument, after BUBD and BDL inputs, with
the recipient manifest sixth.
Use a new snapshot id in the BUBD manifest when any source changes. The coverage
window must also be backed by the BUBD extract. Running the same snapshot again
checks all six protected source hashes and leaves existing Findings unchanged.
The production refresh command fetches all sources and performs this load in one
transaction.

CRFOP document links open the reserve's register entry, where the governing
plan ochrony and zadania ochronne are listed. The export does not provide direct
PDF URLs. Both document links remain when both flags are true; `plan_ochrony`
takes precedence in the single document-state field.

Findings store memberships and boundary distances, with all matching areas kept.
An empty membership array means the point is outside that layer. Older snapshots
return `not_computed`, never an empty result presented as a completed check.
The interface derives the ban assertion from the unrounded boundary distance and
Accuracy. For an Incident area each entry carries `coverage` (`wholly_inside` or
`partly_inside`) and `area_share`; the ban needs `wholly_inside` with a positive
boundary distance, and an empty array means the area is outside that layer.
Hand-placed points have null Findings Accuracy. The transport records
`moved_by_reporter` when the Reporter moves the Incident point in the location picker.

Protected-area treatment and its citation live in the `protected-v1` Rule set
revisions. Each revision keeps the previous time and species rules and its legal
effective date. Original Rule set files and existing database records stay
unchanged. Findings carry the selected policy alongside measurements; the UI
does not supply a current-law fallback for an older result without that policy.

## Sync limits

The sync worker cancels response bodies when it needs only status or headers.
Successful challenge and pending-Findings responses still parse their JSON.
This keeps terminal-history refresh from retaining unused response bodies without
changing admission limits, retry timing or local Report content.

Challenges expire after ten minutes. A process-local key signs them; each accepted
solution can create one Report. A restart invalidates outstanding challenges, so
the client fetches another. The 1 to 2 second target on Android still needs device
calibration; nine desktop Chromium samples had a 229 ms median.

A random salt rotates at Warsaw midnight. Only its HMAC of the client address enters
the unlogged `rate_counter` table. The table expires at the next midnight, at most
25 hours later during the autumn DST change. Only new accepted Reports count.
Backups must exclude that table:

```sh
pg_dump --exclude-table=public.rate_counter "$DATABASE_URL" > backup.sql
```

Run one API process. Multiple processes would hold separate salts and counters.
nginx overwrites `X-Real-IP`; the API trusts it only from `TRUSTED_PROXY_IP`.
Report admission still accepts the first 50 new Reports per salted address per
Warsaw day. Reports after five in an hour or 15 in a day get an Integrity signal;
only the 51st is refused. A retry of an accepted Report, a conflicting resend and a
retry of a withdrawn id spend the same counts as a new Report, because the Altcha
solution is stateless and would otherwise be reusable without limit. Withdrawals of
an id the token does not own are limited to 50 a day per address and 200 per /48; a
Withdrawal tombstone is keyed on the id and the token hash, so it stops only the
Report that token created.
IPv6 clients also share 200 a day per /48, and the whole service takes at most
`REPORT_HOURLY_CEILING` (600 by default) an hour; a refused phone retries after the
next full hour plus a random part of the one after (ADR-0008).

The proxy has separate, short-term limits per address. Challenges allow one request
per second with a burst of five. Report creation allows five per second with a
burst of 20; the 50-per-day database ceiling still applies. Recipient and area
lookup share two per second with a burst of ten. Address flags allow one per second
with a burst of five, and Withdrawal allows two per second with a burst of ten.
These routes have separate counters, so one busy task does not spend another task's
burst. Notice event writes allow 10 per second with a burst of 20 so an offline
batch from a shared mobile address can drain. Findings,
health, readiness, place search and other API reads allow five per second with a
burst of ten. Immutable geodata downloads allow one per second with a burst of two;
the document, service worker and other mutable static files allow 30 per second
with a burst of 100. Hashed immutable app assets use the 40-connection per-address
and 100-connection global ceilings without a request-rate limit. Browser startup
and repeated page loads need many of those files. Worker status is not public.
Every unmatched API path gets the read limit before the API returns 404.

The API admits at most 64 active responses. Within that total it reserves ceilings
of eight Notice event writes, 64 other writes, 12 lookups, 24 reads and eight
health/readiness requests. A second simultaneous event request
for one Report gets HTTP 429 with `Retry-After: 1`; another Report can still write.
An owned Report can hold 128 Reporter-written Notice events over its lifetime,
including outcome corrections. System events do not count. A replay of an accepted
event ID still returns 200 after the cap; a fresh event returns 409 `event_limit`.
Five recipients with three initial Notice events each leave 113 slots for later
handoffs and corrections. This is a lifetime storage ceiling, so retrying that 409
later will not help.

Notice events use `FOR NO KEY UPDATE` on the immutable Report row. This serializes
event admission and Withdrawal while allowing worker foreign-key reads. The same
transaction resolves replay ownership before committing, without borrowing another
pool connection.

The proxy allows 40 active requests per address and 100 globally. It gives clients
ten seconds for headers and bodies, five seconds of idle keepalive, and 15 seconds
for upstream send/read. The API gives request bodies 15 seconds, headers ten
seconds, and caps each connection at 100 requests. Proxy 429 responses include
`Retry-After: 1`; the Android origin can read that header. Access and rejection
logs are disabled. Shared mobile NATs can hit proxy bursts together, so clients
keep local work and retry. These limits protect this process and database; OVH VAC
and network capacity remain the upstream DDoS controls. nginx uses one worker with
256 connection slots, including upstream sockets. Connection limits start after
headers arrive; a slow header stream can occupy a socket before those limits apply.

The hardening tests create their own API instances for clock control. Run them
through the disposable setup described under [Checks](#checks).

### Recovery after server loss

A phone learns that the server lost one of its Reports only when it asks about
that Report. Uploads, pending Findings and unsent Notice events already ask. A
Report with terminal Findings and every Notice event delivered gets a presence
check: one authorized Findings read when the app starts, then again on a resume
or reconnect once an hour has passed. Nothing polls while the app stays open or
in the background, so a loss is found at the next launch, or at the first resume
or reconnect an hour after the last check. A 429 waits for `Retry-After`; a failure
retries after 30 seconds, doubling up to an hour. Check times stay in memory, so an
unchanged answer writes nothing on the phone.
Routine worker timers do not start healthy-Report presence checks. If a launch,
resume or reconnect overlaps an interrupted pass, the worker retains that request
until a new pass can run; failed probes still use their own retry deadlines.

A 404 from any of these requests drops the synced mark and uploads the same Report
again, with its ID and token hash, then replays its Notice events and outcomes in
their recorded order under their original IDs; the server stores each once. The
phone keeps its Findings, note, photos and private fix. Its screen says the server
lost the Report and that the phone will save it again. A Withdrawal recorded on the
phone, or a server tombstone, stops the upload, so a withdrawn Report never returns.

Only a Report still on a phone can come back. A Report whose phone copy was deleted,
withdrawn, or lost with the phone stays lost; nothing else holds its data.

## Integrity operations

Findings and Integrity use separate worker loops. Integrity stores point, burst
and photo counts in `integrity_signal`; it never changes Findings or Notices.
Creation and Withdrawal queue affected Reports for refresh, so counts may lag
until the queue drains. Migration 007 queues Reports that lacked signals.
`GET /api/worker-status` reports `integrity_queued`,
`integrity_oldest_age_seconds`, `integrity_terminal_failures` and
`integrity_last_poll_age_seconds`. The lease lasts 60 seconds; after a crash,
the worker can claim the job again. Exclusions are dated `report_event` rows;
`report_public_state` shows the current reason and `counts` derives included
and excluded totals. The excluded total also includes a count of excluded Reports withdrawn by
Reporters. That tally contains no Report facts. Withdrawal deletes the Report and its events
through a token-authenticated database function; the runtime role cannot delete or update events,
change a Report id, restore publication, or record an operator decision.
Exclusion does not change Integrity matching. Unpublishing
changes `publishable` and writes an event, but does not change those totals.

Run operator commands with `DATABASE_URL` set to the schema-owner credential, outside the API
process. Keep that credential out of the runtime environment. Read-only counts and digest preview
also work with the runtime role.

```sh
npm run operator -- counts
npm run operator -- exclude <report-id> fabricated
npm run operator -- exclude --cluster <report-id> duplicate
npm run operator -- exclude --cluster <report-id> duplicate --confirm <token>
npm run operator -- lift-exclusion <report-id>
npm run operator -- unpublish <report-id>
npm run operator -- digest-preview 2026-09-24
npm run operator -- digest 2026-09-24
```

`--cluster` acts on the Reports connected through points within 1 m and 30 days,
points within 500 m and 60 minutes, or matching photo hashes within 30 days. Public
Reports can link themselves, so a Report keeps at most 100 matches and a cluster at most
100 members; the window and the cap are `integrity_window()` and `integrity_cap()` in SQL,
the only place they are written. A Signal count that hit the cap is stored with
`matches_clipped` and shown as "clipped at 100" in the digest and the preview. Without
`--confirm` the command prints each member, why it joined and which Report it was reached
from, excludes nothing and exits with an error. The error names a token, the count and a
short hash of the sorted ids; `--confirm <token>` (or `--confirm=<token>`) excludes exactly
that set, so a swapped member is refused. A cluster over the cap is refused; exclude those
Reports one by one. One accept or withdrawal queues at most 99 neighbours plus up to 100 Reports
whose capped list held the changed one; in a cluster dense enough to fill that reverse bound, a
Report beyond it can keep a stale count until its next refresh.

The digest names at most 10 ids per cluster and lists at most 50 clusters, about 25 KB at
most. It reads one snapshot, marks a clipped cluster as truncated, and turns an expansion
that hits the statement timeout into a warning line. A failed run is retried twice, 5
minutes apart; after the third failure the command exits non-zero, so
`integrity-digest.service` fails and its journal shows `digest_gave_up_after_3_attempts`.
Preview prints the gmina-level digest. `digest` mails it. Without a date, both
commands use yesterday in Warsaw. Configure `SMTP_HOST`, `SMTP_PORT` (465 or 587),
`SMTP_USER`, `SMTP_PASSWORD`, `DIGEST_FROM`, and `DIGEST_TO` in the operator's
environment file. Install and enable `ops/integrity-digest.timer` to mail it at
08:00 Warsaw time.
