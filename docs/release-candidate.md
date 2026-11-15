# Release the verified candidate

A green workflow is engineering evidence, not permission to publish. Production
activation requires a successful trusted GitHub run, its exact downloaded artifact,
and signed human acceptance of that candidate. Missing evidence stops the release
before dependencies, migrations, services or signing keys are used.

## Independent release controls

Install `ops/production/install-release-control.sh` as root from an independently
reviewed checkout on the operator workstation and dedicated host. Review updates
to these controls separately from candidate uploads. The installed verifier,
activation and rollback scripts live in `/usr/local/lib/bor-czuwa-release`. Give the
operator sudo access only to those fixed entrypoints and the documented staging
upload operations. Never authorize execution of a script inside an upload.
A root administrator can replace these controls; this boundary does not constrain
root or someone holding the release approver's private key.

Create `/etc/bor-czuwa/release-policy.json`, owned by root and not writable
by other users. Use the real repository, approved branch names and SHA-256 of the
reviewed `.github/workflows/verify.yml` bytes:

```json
{
  "repository": "OWNER/REPOSITORY",
  "branches": ["main", "release"],
  "workflowSha256": "REPLACE_WITH_REVIEWED_WORKFLOW_SHA256",
  "maxAgeHours": 72,
  "allowedSigners": "/etc/bor-czuwa/release-allowed-signers",
  "approver": "release-owner"
}
```

The allowed-signers file uses OpenSSH's standard format:
`release-owner ssh-ed25519 <PUBLIC_KEY>`. Keep its private key outside the repo
and release artifact. The public-key file also needs root ownership and no group
or other write permission. Install `unzip`, `python3`, Node and OpenSSH client
tools on both machines. Public repositories use GitHub's HTTPS API without a
credential. A private repository requires a read-only `GH_TOKEN`; missing access,
rate limits, expired artifacts and network errors block verification. CI receives
no signing or deployment credentials. Branch protection is not required by this
mechanism.

## Private demo staging

An explicitly isolated private environment consumes the same authenticated
candidate path with `staging` eligibility. It never grants production acceptance
or permits signing. Use a root-owned demo policy with `"environment": "demo"`
and the explicitly approved private branch; production policies remain separate.
`RELEASE_POLICY_PATH` selects that policy and retains the same ownership checks.

The `deploy/private-*` workflow branch or explicit `demo` dispatch requires
private repository variables `DEMO_TEST_RECIPIENT` and `DEMO_API_ORIGIN`.
The first is the approved owner-controlled Notice inbox; the second is the
trusted HTTPS origin. Neither is a deployment credential. Missing values fail
the workflow. `VITE_DEMO_TEST_RECIPIENT` is accepted only in staging builds and
binds every outgoing client recipient path to the test inbox. Candidate evidence
retains that client configuration and the Android origin; host activation checks
both against independently installed private configuration.

See [the dedicated-host runbook](../ops/production/README.md) for isolated
bootstrap, deployment, cookie-gated browser access and rollback commands. Report
Bearer tokens must remain intact after private entry authentication. A demo
rollback additionally needs explicit target-bound IndexedDB compatibility
authorization; it does not undo a database migration or restore lost Reports.
Keep real-Incident processing, public release and physical Android proof separate.

For a private repository, give the host only a separately scoped read-only token
for that repository's Actions, Contents and Metadata. Keep the workstation's
broad OAuth credential on the workstation. No CI deploy key or production
acceptance signer belongs on the host or in an artifact.


## Produce and retrieve the candidate

The normal workflow produces staging evidence. For production, dispatch
`Verify candidate` with `mode=production` and the real HTTPS Android API origin.
The workflow runs required source checks and freezes production web assets and
unsigned Android release binaries in one archive. Both isolated HTTP/PostGIS and
browser runs mount that archive's runtime source and web assets read-only. Their
records must prove the same archive digest before and after the suites. Private
build-context exclusion remains required. Production
marker and legal-placeholder checks remain mandatory. Current draft legal
inputs deliberately block that production build.

The runtime source archive contains only committed runtime inputs. Its manifest
records source commit, lockfile digest, toolchain, build mode, Android origin,
per-file hashes and the archive digest. A disposable nginx serves the exact web
bytes in that archive using the rendered production configuration. Actual HTTP
responses on documents, service worker and errors must retain security headers.
The app host stays noindex on every response in production too; the public face is the landing on another host.
Unsigned Android bytes pass ZIP integrity and APK package/version checks; signed
physical behavior remains a separate gate. This is a local HTTP check; the dedicated HTTPS host, TLS,
provider logging and national data still need their owners' evidence.

Download the named `verification-<commit>-<run>-<attempt>` artifact as the original
GitHub ZIP, not a ZIP repacked from an extracted directory. Use the artifact ID
returned by GitHub's run-artifacts API:

```sh
mkdir /absolute/path/candidate
# Use the actual repository and artifact ID from the selected successful run.
gh api repos/OWNER/REPOSITORY/actions/artifacts/ARTIFACT_ID/zip \
  > /absolute/path/candidate/verification.zip
python3 /usr/local/lib/bor-czuwa-release/unpack-candidate.py /absolute/path/candidate
node /usr/local/lib/bor-czuwa-release/release-candidate.mjs verify \
  /absolute/path/candidate staging
```

Use `production sign` for a production candidate that is ready for signing but
has not completed physical acceptance. `staging` never grants production
eligibility. The verifier independently queries the run, current attempt,
required job, workflow bytes and artifact digest from GitHub. PR artifacts,
changed workflow revisions, failed or missing checks, stale source/lockfile
identity and modified ZIP/payload bytes are refused. Default freshness is
72 hours. A new source commit or rebuild needs a new run and acceptance.
Local `checksEligible: true` or copied success JSON cannot satisfy this check.

The GitHub artifact retention is 14 days. Activation requires the artifact to
remain available and unexpired at GitHub, and the run to be at most 72 hours old by
default (`maxAgeHours` in the policy).
When activation succeeds it writes `activation-receipt.json` in the release
directory, beside `payload/`: the verifier's result and the candidate file digests.
A rollback to that release checks `verification.zip`, `candidate.json` and every
installed file against the receipt, with the same unlisted-file walk, makes no
GitHub call and still needs the signed rollback acceptance. A release activated
before receipts existed has none, keeps the live check, and can be rolled back
only while its artifact exists, 14 days after its run. Receipts are not written
for releases already installed. The receipt guards against a changed byte, not
against root.

## Finalize a private test APK locally

GitHub's default debug signer is ephemeral. Two CI debug APKs are not an update
chain merely because their package IDs match. The separate local command below
reuses the already existing workstation Android debug key and pinned public
certificate; it never generates a key, uploads one, or uses the production signer.
The original CI ZIP remains unchanged. Its signed APK is a new, explicitly
identified **private test** artifact, never a production-eligible release.

Run only from an independently reviewed operator checkout. That checkout's
`verify.yml` supplies the reviewed workflow digest; the explicit source commit and
`deploy/private-*` branch supply the intended candidate identity. The ordinary
`verifyCandidate` staging checks still authenticate the successful GitHub run,
attempt, job, original ZIP and payload. The helper, APK inspector and verifier
bytes must themselves match that exact authenticated candidate. No new local
root policy/provisioning is needed for this pinned disposable test identity.
The production CLI's root-policy and staging-sign refusal remain unchanged.

First retain the original `verification.zip` and unpack it with the reviewed
`scripts/unpack-candidate.py`. Supply `GH_TOKEN` from the existing repository-only
read-only credential reference. Load the existing test keystore/key passwords
into `PRIVATE_ANDROID_TEST_STORE_PASSWORD` and `PRIVATE_ANDROID_TEST_KEY_PASSWORD`
through protected references or hidden input, never command arguments or logs.
These are existing test credentials, not a request for a new key or permission to
substitute the production `ANDROID_KEYSTORE_*` variables. SDK/keytool/inspection
children receive no GitHub or production-signing credentials.
The shared verifier also allowlists extraction, marker-check and signature-
verification child environments: GitHub and test/release passwords stay in the
parent, never those subprocesses. A reachable environment-observation regression
is still required before treating this new boundary as exercised evidence.

```sh
ANDROID_HOME=/path/to/android-sdk \
ANDROID_API_ORIGIN="$approved_demo_origin" \
VITE_DEMO_TEST_RECIPIENT="$approved_test_inbox" \
npm run finalize:android:test -- \
  /absolute/candidate /absolute/new-private-output \
  EXPECTED_COMMIT deploy/private-reviewed-branch
```

The output parent must already exist; the new output directory must not exist
and must be outside the candidate. The helper authenticates evidence before
touching the existing `~/.android/debug.keystore`; it refuses links/another owner,
restricts it to0600 and verifies its pinned public certificate before signing.
It copies the authenticated `.demo` APK, aligns/signs that copy locally, then
checks certificate, actual manifest/version, test label, bundled HTTPS offline
shell, compiled approved origin/inbox and every non-signature ZIP-entry hash.
The client consumes one content-hashed configuration module. The inspector parses
its exact JSON export, checks its filename hash and follows the HTML entry's real
JavaScript import graph without executing APK code. The known API and handoff chunks retain named exports. The inspector checks the
actual exported URL and recipient functions against their supported compiler
shapes and follows their configuration bindings. Unrelated literals, unused
accessors or differently exported functions cannot satisfy those checks. The module is part of the same build's offline shell.
Default and supplied localized app labels must all contain TEST. The helper also
matches its parser, runtime consumers and build configuration to the authenticated
candidate's source hashes. This deliberately couples validation to the known
compiler output for these two modules. A changed compiler shape fails closed and
needs a reviewed inspector update; this is not a general JavaScript verifier.
APK v1 signature metadata and v2/v3 signing blocks are the only excluded signing
material. No payload entry may be changed, removed or added.

On success, `app-private-test.apk` and `provenance.json` bind the original CI
run/artifact/ZIP/APK, finalized APK, pinned certificate, manifest version and payload
hashes. Failed outputs retain `failure.json` and their owned intermediates, never a
successful install/update claim. Do not install from a failed command or without
the matching provenance. No phone operation occurs in this command.

For actual update proof, use two genuinely changed approved successful candidates
with the same separate `.demo` application ID/certificate and increasing
package-derived versionCode. Do not bump a version solely to manufacture proof.
Acquire the current phone lease before inspecting the installed signer or using
install/update. A conflicting installed signer is not permission to uninstall,
clear Drafts/tokens or overwrite the owner's app. Existing debug compilation and
negative consumer tests do not establish a physical update pass.

## Sign existing Android binaries

The existing `npm run build:release` entrypoint now signs CI-produced unsigned
binaries instead of rebuilding them. Keep the keystore outside the repo and use
the existing signing environment variables and `ANDROID_HOME`:

```sh
npm run build:release -- /absolute/path/candidate /absolute/path/new-signed-output
```

This command verifies production CI identity before using signing credentials,
then runs `apksigner` and `jarsigner` on the exact unsigned APK/AAB. It prints
signed digests and certificate information. It does not upload either file.
Ticket 13's owner must record versionCode, certificate SHA-256, unsigned and
signed digests, fresh installation and update from the previous signed version.
Debug compilation or an older physical run cannot stand in for those results.

## Human acceptance

Create `acceptance.json` beside `verification.zip`. Bind it to `candidateSha256`,
the SHA-256 of the exact `candidate.json` bytes inside the authenticated ZIP.
Every gate needs `outcome: "accepted"`, an owner, a retained evidence reference
and that evidence's SHA-256. Required keys are `legal`, `directory`, `rules`,
`geodata`, `national`, `host`, `android`, `accessibility`, `reconciliation` and
`final`. A missing gate reports its responsible owner.

Include these additional fields in the corresponding gate:

- `legal.versions`: accepted legal document versions.
- `directory.basis`: `coverage` or `accepted-exception`, with its signed decision
  in the referenced evidence. Faza-2/29 retains ownership.
- `rules.version` and `geodata.snapshot`: Rule set and Geodata snapshot IDs.
- `android.unsignedApkSha256`, `unsignedAabSha256`, `signedApkSha256`,
  `signedAabSha256`, `certificateSha256`, `versionCode`, `freshInstall: true`
  and `updateFromVersionCode`.

At the top level include `action: "activate"` and an ISO `expiresAt`. The final
owner must review the candidate, linked gate evidence and all 31 findings before
signing. Use the approver's existing OpenSSH key:

```sh
ssh-keygen -Y sign -f /private/path/release-key -n bor-czuwa-release \
  /absolute/path/candidate/acceptance.json
node /usr/local/lib/bor-czuwa-release/release-candidate.mjs verify \
  /absolute/path/candidate production
bash ops/production/deploy.sh /absolute/path/candidate DEDICATED_SSH_ALIAS DOMAIN
```

The signature covers the candidate digest, action, expiry and all gate evidence.
An editable local flag is insufficient. The release owner is responsible for the
truth of signed human claims; the script cannot observe a physical device or
provider console. Faza-2/28, faza-2/29, faza-2/31 and the existing human steps
remain the acceptance authorities.

Deployment sends the original ZIP and signed acceptance. The independently
installed host script extracts only regular files/directories, repeats
verification before installation, and keeps each release under
`releases/<commit>/payload`. `current` points to that payload. The tested web
assets and runtime source are never rebuilt or patched during activation.
Locked runtime dependencies are installed as `bor-czuwa-build` without lifecycle
scripts. HSTS is host configuration, stored separately from immutable assets.

## Authorized rollback

Rollback is a new human decision about an already verified candidate. Prepare a
new signed acceptance for the retained candidate with `action: "rollback"`,
current expiry and current gate evidence. Also include:

```json
{
  "rollback": {
    "authorization": "Reference to the owner's rollback decision",
    "indexedDbCompatible": true,
    "backups": "off"
  }
}
```

Keep the prior activation acceptance in the operator's audit archive, then put
the rollback acceptance and signature beside the retained verification ZIP.
Run `bash /usr/local/lib/bor-czuwa-release/rollback.sh <commit>` on the host. A release
with an activation receipt is verified offline against it. Rollback of an older release
without one may use an older successful run, but still requires its original GitHub
artifact, trusted workflow and matching installed bytes. Revoked access or expired
evidence blocks that path; repair forward with a newly verified candidate.

Backups remain off. The server migration ledger must be compatible before
stopping the active process. No schema downgrade or automatic database restore
is supported. Do not cross an IndexedDB version increase: older clients cannot
open a database upgraded on a device. Keep the newer client and repair forward.
Never tell Reporters to clear storage; it contains their local Reports and tokens.

## Engineering proof and open gates

`tests/release-candidate.test.ts` uses a disposable provider adapter and a fresh
OpenSSH test key to exercise acceptance and refusal. This adapter is unavailable
from the release CLI. Its successful fixture is not a trusted hosted result or
a production approval. `scripts/ci/production-http.mjs` checks actual nginx HTTP
responses and fails when any response lacks `noindex`. Candidate examples, commands and
31-finding reconciliation are retained in `.scratch/faza-4/evidence/28/`.

No production candidate, signing credential, public deployment or store upload
was created by this implementation. Hosted CI execution, current signed-device
proof, nonvisual physical acceptance, legal approval, directory coverage,
national mixed-load/host capacity and provider checks remain open until their
owners accept the same candidate.
