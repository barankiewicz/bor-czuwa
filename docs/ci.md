# Candidate checks

`.github/workflows/verify.yml` runs on pull requests, pushes to `main` or
`release`, `release/**`, `release-*` or `deploy/private-*`, and manual dispatch. `Required checks` is the final job result.
Branch protection and rulesets are separate repository settings; this workflow
does not assume they exist. A push to any other branch, such as `execute/faza-6`,
starts nothing, so a candidate is opened as a pull request or pushed to a
`release/*` branch to get a result. Making `Required checks` mandatory is an owner
step in the [accounts human step](../.scratch/pre-production-human-steps/issues/03-accounts.md).

The job installs locked npm dependencies with lifecycle scripts disabled. It
runs typechecking, Notice goldens, the marker rejection test, an explicit staging
build, operational tests, Android debug compilation, the disposable HTTP/PostGIS
and built-browser gate, and the packaging exclusion check. The isolated gate
creates two separate stacks and records each suite, starting state and cleanup
result. The packaging command comes from the private-context gate:

```sh
node scripts/check-private-context.mjs --engine podman --build-images
```

The operational step is `npm run test:ops`. It runs four Python test files that
need only the standard library and, for the backup tests, restic: `test_production_ops.py`,
`test_nginx_indexing.py`, `test_extract_artifact.py` and `test_geodata_fetch.py`. The two
`StandIngest` cases in `test_geodata_fetch.py` need PostGIS and the ingestion
dependencies, so they are skipped on the runner and the output says so. Three files
are drill-only and no CI job runs them: `test_host_hardening.py` needs the disposable
systemd container that `scripts/production-drill.py` builds, `test_production_restore.py`
needs two disposable PostgreSQL 17 hosts and restic and the drill skips it by the
owner's decision of 2026-10-03, and `test_findings_monitor.py` is run by the drill
only. The last one is not blocked by anything: it uses mocks and the standard
library and passes on a plain checkout. Moving drill-only files into CI was ruled
out of this change, so it stays where it is, and new monitor tests belong in a
file `test:ops` already runs.
Files outside CI drift without anyone noticing, so read them before trusting them.

The six-week check-in is built out of the app by default, so the ordinary browser
run skips its three specs. `npm run test:check-in` builds the web image with
`VITE_CHECK_IN_ENABLED=true`, starts one disposable stack, runs `check-in.spec.ts`
and `latest-work.spec.ts`, and fails unless the three flag-dependent specs ran
and passed. It is not part of
the hosted job; run it before switching the flag on.

Both setup failures and failed suites fail the job. Required checks continue
where their prerequisites exist, so one failed check need not hide other results.
The final command refuses missing, skipped or failed results, changed source or
lockfile identity, dirty source, incomplete isolated runs, missing toolchain
identity and missing artifacts. Artifact upload failure also fails the job.
The existing production marker test plants forbidden markers and checks their
rejection. CI never changes the production gate to make legal drafts pass.

Android SDK installation uses the SDK root's `cmdline-tools/latest/bin/sdkmanager`,
not an assumed shell PATH entry. Private-demo builds retain their recipient policy
in staging, including the two-version update fixtures and server-rendered Findings
checks. Typechecking clears only the build-only recipient variable because SvelteKit
loads its default mode without emitting assets; production builds still reject it.
Browser checks use the available primary handoff route. A secondary copy does not
start mail confirmation; the demo test opens the approved-inbox mail action before
checking the manual confirmation question.
Opening mail is not confirmation or delivery. Browser assertions inspect the current
Notice's persisted event kinds before and after the explicit confirmation action,
not incidental global badge counts or intermediate-state wording.

## Evidence

Each run uploads `verification-<source SHA>-<run ID>-<attempt>` for 14 days.
`.scratch/ci/candidate.json` joins these records:

- Source commit, lockfile SHA-256, workflow run and attempt.
- Required command outcomes, exit codes and redacted diagnostic tails.
- Two isolated run records, fixture/source fingerprints and container image IDs.
- Node, npm, Java, Gradle, Podman, Compose and Playwright versions.
- SHA-256 and sizes for the staging archive and debug APK.
- Production dependency advisory counts and affected package summaries.

`checksEligible` means the required engineering checks passed for those inputs.
`releaseApproved` remains false. Dependency audit findings are reported even when
advisories exist; a registry failure fails the audit check. Zero known advisories
does not establish security clearance.

The staging archive comes from the explicit host build. Browser tests exercise
the separately built Compose web image whose identity is in each isolated run.
The archive and APK are internal review artifacts, not production release
artifacts. A release path must verify its own required results and use its tested
artifact; rebuilding or changing source requires new evidence. Legal, directory,
provider, signed-device and accessibility gates remain open where not separately
approved. Debug compilation does not prove signed installation or update.

## Trust and cleanup

Untrusted changes run only on disposable GitHub-hosted runners. Host package
installation precedes checkout. Application installs, tests, rootless Podman
builds and Gradle run as the runner user. The workflow requests only
`contents: read`, does not persist checkout credentials, and receives no signing
or production secrets. It does not publish, deploy or upload to a store.

The host step does not call apt. It checks that the runner image has the tools
and libraries the job needs, installs restic from the upstream release and
installs poppler from a tarball of `.deb` files attached to the
`ci-host-packages-noble-1` release of this repository. Each download is pinned
by sha256 in `verify.yml`. To change the packages, publish a new tarball under a
new release tag and update the tag and hash in the workflow; never replace an
existing asset. Any edit to `verify.yml` changes the workflow digest that the
release consumer's policy pins, so the installed policy needs the new digest
before a candidate built by the edited workflow can be activated. Container
builds inside the job, such as the ingest image, still install their own
packages from Debian's mirrors.

There are no restored caches or downloaded artifacts. Every evidence artifact
has a run-specific name. A release consumer must treat PR artifacts and their
self-reported JSON as untrusted input, and independently validate the workflow,
source, origin and successful job result before using evidence. This file is not
an attestation or a substitute for hosted check status.

The job has a 120-minute limit; the isolated step has an 80-minute limit. New
changes cancel older runs for the same ref. The isolated runner forwards signals
and removes only its randomly named Compose project and volumes. Abrupt runner
loss can interrupt cleanup and evidence upload; missing evidence cannot qualify
a candidate. The hosted VM is disposable. No global container or volume prune
runs.

Only fictional Reports and disposable databases belong in these jobs. Uploaded
logs are limited to a 2 MiB tail per required command and redact URLs, email
addresses and common credential assignments. Raw browser traces, database dumps,
Report rows, home locations, identity examples and signing files are not uploaded.
Redaction is an additional guard, not permission to run private data through CI.
Authorization diagnostics redact both the Bearer/Basic scheme and its value in
plain headers, JSON headers and quoted Node diagnostics. Structured Authorization
metadata is masked by its key, using the same boundary for command records and the
final candidate. Seeded CLI failures check retained files, command output and
parseable JSON, so masking only the scheme cannot expose the remaining credential.

## Local proof and hosted enforcement

The command boundary is also usable locally:

```sh
node scripts/ci/evidence.mjs run typecheck -- npm run check
node scripts/ci/evidence.mjs finalize
```

`CI_EVIDENCE_DIR` selects the evidence directory (default `.scratch/ci`).
`ISOLATED_REPORT_PATH` selects the isolated summary without changing default local
runner behavior. The workflow sets it to `.scratch/ci/isolated-report.json`.
A partial local run must fail finalization. Use a clean checkout for a candidate.

The CLI regressions seed setup and behavioral failures and inspect retained
redacted logs. They also exercise skipped results, changed lockfile identity,
incomplete isolated runs and missing artifacts. Synthetic success fixtures prove
the decision logic only. Local checks do not prove GitHub has loaded or enforced
the workflow. Retain actual run URLs, conclusions and artifact identities after an
authorized push; record unavailable hosted infrastructure as an open gate.

## Consuming a verified artifact

The [release runbook](release-candidate.md) defines the independent trust policy,
artifact download, human acceptance and activation. Manual dispatch can select
`production` and a public Android API origin. That path builds production web
assets and unsigned Android binaries, checks actual nginx HTTP headers/indexing,
and records their exact archive and file digests. Draft legal markers still block
production; a staging artifact cannot be promoted with a signature.

Every mode records `releaseCandidate`, build configuration and private-context
proof in `candidate.json`. The separate staging archive/debug APK remain review
outputs. The release consumer uses `artifacts/release.tar`, whose archived web
bytes passed the HTTP probe, alongside required source checks. It verifies GitHub
run status, repository/event/branch, reviewed workflow digest, attempt, required
job and the original GitHub ZIP digest. Host activation and rollback use an
independently installed verifier. No hosted execution or public release is
claimed by the local fixture tests.
