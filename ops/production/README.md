# Dedicated production host

Production runs on one OVH VPS in Canada (alias `bor-widzi-vps`): Ubuntu 26.04, 2 vCPU,
4 GB RAM and 40 GB disk, chosen on 2026-11-14 as the only VPS. The privacy policy names Canada
and its adequacy decision (2002/2/EC, which covers organisations under PIPEDA, OVH among them). That host was set up
before `provision.sh` existed in its current form and takes the Hardening section's
already-provisioned path; `provision.sh` targets a fresh Debian 13 host, which is what a
later move would use. The existing `zabka-vps` alias belongs to a shared
host and is not this deployment target. Use a separate account and SSH alias.
The API, Findings and Integrity loops run in one supervised process. Proof
HMAC keys and daily rate salts live in that process's memory and change on
restart. A restart also resets the effective per-IP rate-limit day: the new salt
produces new keys, so the old counters no longer limit that client. Do not add replicas until their coordination and routing are measured
and agreed. PostgreSQL uses 512 MB shared buffers; swap is 2 GB at swappiness 10. Its encryption key comes from `/dev/urandom`
on each boot and is never persisted. Other active swap is rejected.

## Host provisioned under the old names

Until the Bór czuwa rename ([ADR 0014](../../docs/adr/0014-technical-identity-follows-the-public-name.md))
every unit, account, path and database here began with `zglos`. The scripts now create and manage only the
`bor-czuwa` names and never touch the old ones, so a host set up earlier has two sets side by side until
the old set is retired. Both sets listen on the same loopback port, so retire the old API first. Nothing was
released and the data is fictional, so nothing is migrated: the new database starts empty and the national
geodata is ingested again.

| Old | New |
| --- | --- |
| `/usr/local/lib/zglos-release` | `/usr/local/lib/bor-czuwa-release` |
| `/opt` `/etc` `/var/lib` `zglos-mysliwego[-demo]` | `bor-czuwa[-demo]` |
| units `zglos-api`, `zglos-monitor`, `zglos-backup`, `zglos-demo-*` | `bor-czuwa-api`, `bor-czuwa-monitor`, `bor-czuwa-backup`, `bor-czuwa-demo-*` |
| accounts `zglos`, `zglos-maint`, `zglos-build`, `zglos-demo[-maint\|-build]` | `bor-czuwa`, `bor-czuwa-maint`, `bor-czuwa-build`, `bor-czuwa-demo[-maint\|-build]` |
| database and roles `zglos`, `zglos_owner`, `zglos_demo`, `zglos_demo_owner`, `zglos_demo_runtime` | `bor_czuwa`, `bor_czuwa_owner`, `bor_czuwa_demo`, `bor_czuwa_demo_owner`, `bor_czuwa_demo_runtime` |
| `/etc/letsencrypt/renewal-hooks/deploy/bor-widzi-nginx` | `.../bor-czuwa-nginx` |
| lock files `zglos-*.lock`, `/run/zglos-backup` | `bor-czuwa-*.lock`, `/run/bor-czuwa-backup` |
| restic tag `zglos`, signature namespace `zglos-release` | `bor-czuwa`, `bor-czuwa-release` |

Order:

1. Stop and disable the old units and timers. `systemctl disable` refuses a glob, so name them. On
   the demo host:

   ```sh
   sudo systemctl disable --now zglos-demo-api.service zglos-demo-geodata-refresh.timer \
     zglos-demo-integrity-digest.timer zglos-demo-monitor.timer zglos-demo-backup.timer
   sudo systemctl stop zglos-demo-geodata-refresh.service zglos-demo-integrity-digest.service \
     zglos-demo-monitor.service zglos-demo-backup.service
   ```

   The four `.service` units that the timers start have no install section, so `list-unit-files` shows
   them as `static`. Check `systemctl is-active 'zglos-*'` reports nothing active and
   `systemctl list-unit-files 'zglos*'` shows no `enabled` line. From here until step 6 the
   demo is down, because nginx still points at the old paths. Nothing is deleted yet, so rolling
   back is re-enabling the old units.
2. Run `install-release-control.sh`.
3. Bootstrap again: `bootstrap-demo.py` on the demo host. `provision.sh` is for a fresh dedicated
   host only; on a host provisioned under the old names it stops at the swap check, because the
   active swap is `/dev/mapper/zglos_swap`.
4. Recreate the environment files in the new `/etc` directory. Copy the release policy and the
   allowed-signers file there, update the paths inside the policy, and sign each candidate's
   `acceptance.json` with `-n bor-czuwa-release`; a candidate signed under `zglos-release` no longer
   verifies. The policy and the allowed-signers file themselves carry no namespace.

   The policy also names the repository and the branches a run may come from. The verifier accepts a
   run only when its repository equals the policy's `repository` exactly and its branch is listed.
   For the hosted run set `repository` to `barankiewicz/bor-czuwa` and list the deploy branch the
   candidate's CI run was built on (its `head_branch`), for example
   `deploy/private-bor-czuwa-f407c8e-20261112`. Before step 6, run
   this from the checkout on that branch. It prints the policy values and exits non-zero if the policy
   cannot be read, the repository differs from the remote, or the branch is not listed:

   ```sh
   policy=$(sudo cat /etc/bor-czuwa-demo/release-policy.json) && python3 -c 'import json,re,sys; p=json.loads(sys.argv[1]); print(p["repository"], p["branches"], sys.argv[2], sys.argv[3]); sys.exit(not ("/".join(re.split("[:/]", sys.argv[2].removesuffix(".git"))[-2:]) == p["repository"] and sys.argv[3] in p["branches"]))' "$policy" "$(git remote get-url origin)" "$(git branch --show-current)"
   ```

   A policy left at the old repository name fails activation with `untrusted CI repository`.
5. To skip a long download, copy the old extracts into the directory step 3 created, then give the
   copy the owner and mode bootstrap gave that directory. A plain `cp -a` keeps the old account as
   owner, and the new maintenance account then cannot write there, so the first ingest fails:

   ```sh
   sudo cp -r --no-preserve=ownership /var/lib/zglos-mysliwego-demo/geodata-extracts/. \
     /var/lib/bor-czuwa-demo/geodata-extracts/
   sudo chown -R bor-czuwa-demo-maint:www-data /var/lib/bor-czuwa-demo/geodata-extracts
   sudo find /var/lib/bor-czuwa-demo/geodata-extracts -type d -exec chmod 0750 {} +
   sudo find /var/lib/bor-czuwa-demo/geodata-extracts -type f -exec chmod 0640 {} +
   ```

   The `www-data` group is how nginx reads the extracts, so do not use the maintenance group here.
6. Activate.
7. Only then remove the old set: the database, roles, pg_hba and pg_ident lines, accounts, the
   `/opt`, `/etc` and `/var/lib` directories, the unit files in `/etc/systemd/system`, the renewal
   hook `bor-widzi-nginx`, `/etc/ssh/zglos-hardening.conf` and its `Include` line in `sshd_config`,
   `/etc/sysctl.d/90-zglos.conf`, `/etc/postgresql/17/main/conf.d/90-zglos.conf`, the old coredump
   and apt drop-ins, the `zglos_swap` entries in crypttab and fstab, and `/run/lock/zglos-*.lock`.

## Private demo on the already provisioned Ubuntu host

This is a separate, explicitly staging-only deployment, not production acceptance.
Do **not** run `provision.sh` on the already hardened Ubuntu 26.04 host.
The demo uses fictional Reports and real national geodata. Keep Reports until
explicit deletion; there is no automatic wipe or promotion. Provider and application
backups remain off. Native physical-device acceptance is separate from browser proof.

Install reviewed release controls independently on the host:

```sh
sudo bash ops/production/install-release-control.sh
```

Never run that installer from an uploaded candidate. It installs trusted activation,
rollback, nginx rendering/auditing, unit templates and bootstrap controls under
`/usr/local/lib/bor-czuwa-release`. Uploaded application source, build files and service
definitions do not become privileged deployment scripts. Dependencies install under
the isolated build account with npm lifecycle scripts disabled. Source/build bytes
are checked again after installation, without rebuilding or modifying assets.
Demo virtual environments use `--system-site-packages` to reuse the signed Ubuntu
`python3-gdal` binding. The installer installs the hash-pinned Python dependencies
(`scripts/requirements-hashes.txt`, `pip --require-hashes`) unprivileged, and requires an
`osgeo.gdal` import whose release version exactly matches `gdal-config --version`.
It does not edit the artifact's requirements files.
Production keeps its existing isolated GDAL installation path.

Create a root-owned mode-0600 JSON file locally on the host, for example
`/root/bor-demo-deployment.json`. Its configuration interface is:

```json
{
  "domain": "demo.example.invalid",
  "certificateName": "existing-certificate-lineage",
  "demoTestRecipient": "owner@example.invalid",
  "accessUser": "owner",
  "ingestTimeoutSeconds": 21600
}
```

Use the actual approved HTTPS host, existing certificate name and owner-controlled
Notice inbox only in private host configuration. `certificateName` is independent
of the host name; bootstrap does not obtain certificates. No SMTP password is
needed for client email handoff. `accessUser` defaults to `owner`.

For deterministic national ingest, optionally add `initialInputs`, an array of
eight absolute existing input paths in the `scripts/ingest-bubd.py` order:
BUBD parquet, BUBD manifest, hunting-district GeoJSON, hunting-district manifest,
protected-area manifest, recipient-jurisdiction manifest, OSM stands sequence,
OSM manifest. The manifests' dependent files must remain alongside them as expected
by the loader. Make these **public national input files** readable by
`bor-czuwa-demo-maint`; keep their recorded hashes/provenance intact. Do not substitute
fixture data. Without `initialInputs`, activation downloads current real national
inputs through the existing ingest pipeline.

Bootstrap the application state only:

```sh
sudo python3 /usr/local/lib/bor-czuwa-release/bootstrap-demo.py /root/bor-demo-deployment.json
```

Bootstrap checks existing Node 24, npm, PostgreSQL client, nginx, OpenSSL, GDAL
development/CLI tools, `ss` and `osmium`. Install the signed Ubuntu `osmium-tool`
package separately if absent; both live national download and scheduled refresh
require it, even when first ingest uses preloaded inputs.

Bootstrap creates `/opt/bor-czuwa-demo`, `/etc/bor-czuwa-demo`,
`/var/lib/bor-czuwa-demo`, the `bor-czuwa-demo`, `bor-czuwa-demo-maint` and
`bor-czuwa-demo-build` system accounts, and the `bor_czuwa_demo` database. It preserves
existing credentials and data when repeated. Changed existing configuration is
rejected rather than silently overwritten. It changes no packages, provider
settings, SSH, firewall, swap or PostgreSQL resource/logging policy.

Database roles are `bor_czuwa_demo_owner` and `bor_czuwa_demo_runtime`; neither has
superuser, database creation, role creation, replication or RLS-bypass privileges.
Only `bor-czuwa-demo-maint` has the owner peer mapping. Host authentication rejects
owner TCP access and runtime access to other databases. `runtime.env` contains
only runtime credentials and `RUNTIME_DB_ROLE=bor_czuwa_demo_runtime`; migration/ingest
credentials stay in `maintenance.env`. The API never receives owner credentials.
Bootstrap generates strong runtime and browser passwords privately. The browser
password stays in root-only `access-password`; retrieve it directly into the
owner's password manager, never chat, CI or a command-line argument.

Separately install the reviewed root-owned
`/etc/bor-czuwa-demo/release-policy.json`, mode 0600. Set
`environment` to `demo`, `branches` to the deploy branch of the candidate's CI run (its
`head_branch`, see step 4 of the cut-over), and the repository and exact trusted workflow digest following the release-candidate runbook.
This policy cannot approve production or signing. Demo uploads remain untrusted
until the installed host verifier authenticates the original ZIP before any
installation, dependency execution, migration or service change. The workstation
needs no privileged control installation for demo; production retains its existing
independent workstation verification. The host always selects its installed demo policy.
Because the repository is private, a separately scoped read-only API token is a
prerequisite. On the host, an optional root-owned mode-0600 `candidate-api.env`
contains `GH_TOKEN` using shell-compatible quoted syntax. Do **not** copy a broad
workstation GitHub token, SSH key or credential store to the host.
The installed environment clears inherited `GH_TOKEN`. Only the verifier subprocess
loads `candidate-api.env`; dependency installers, migrations, psql, runtime and
systemd clients do not receive that credential. Do not pass operator tokens through
sudo or deployment command environments.

The candidate must come from successful trusted staging CI. Its exact
`releaseCandidate.configuration.demoTestRecipient` must equal the approved private
configuration. Every demo artifact also requires `androidApiOrigin` equal to
the approved `https://` host. Recipient, mode and origin mismatches fail before
service changes or migrations. Production defaults remain production-only,
including signed human acceptance; omission of `demo` never selects staging.

```sh
bash ops/production/deploy.sh /path/to/authenticated-candidate dedicated-ssh-alias demo.example.invalid demo
```

Set `DEPLOY_SSH_CONFIG=/absolute/path/to/private/ssh-config` when this operator
environment requires an explicit OpenSSH configuration. Default SSH behavior is
unchanged. The private alias must retain strict host verification and the dedicated
identity; this option is not a host-key verification bypass.

The uploader sends only `verification.zip` for demo. It invokes the installed root
control, not upload code. The equivalent host interface, after root-owned staging
upload, is:

```sh
sudo bash /usr/local/lib/bor-czuwa-release/activate.sh demo.example.invalid SOURCE_COMMIT /opt/bor-czuwa-demo/staging.XXXXXXXX demo
```

Environment-specific locks and units isolate state; a shared proxy lock prevents
concurrent use of nginx and the single loopback API listener on port 3001.
Activation refuses an active other environment or an unexpected listener.
Existing app routes close with 503 before workers stop. First activation preserves
the closed bootstrap proxy until readiness passes. Migrations run as maintenance,
never root; failures leave the API stopped. Initial ingest runs while the API is
stopped, with disk-backed temporary storage, the existing refresh lock, a 2304 MiB
memory cap, 1 GiB swap cap and a bounded systemd control group.
`ingestTimeoutSeconds` accepts 60–86400 seconds, default 21600. A failed activation
does not delete Reports, claim database recovery or reinstall a partial release.
An installed source commit with different candidate bytes is rejected.

Only `bor-czuwa-demo-api.service` and the national
`bor-czuwa-demo-geodata-refresh.timer` are enabled. Demo digest, monitor-mail and backup
timers remain disabled. No authority SMTP, alert mail or daily digest is configured
or authorized by this deployment. The Notice inbox is not authorization for alerts.

The HTTPS gate first requires Basic authentication and issues a Secure, HttpOnly,
SameSite=Strict `__Host-bor_demo` session cookie only after a successful GET/HEAD.
No 401 or rewrite-phase OPTIONS response issues that cookie. A matching cookie disables Basic so Report
`Authorization: Bearer` ownership tokens pass unchanged for Findings, events and
Withdrawal. Losing the cookie requires browser login again. Rotating `cookieToken`
in root-only `gate.json` and regenerating/reloading audited nginx invalidates existing
cookies and native codes. Cached valid Basic credentials can still mint a new cookie.
Full access revocation requires rotating both `cookieToken` and the shared Basic
password (`access-password` plus its matching `access.htpasswd` hash), followed by
audited regeneration/reload. Do not call cookie-only rotation complete revocation.
HTTP-01 remains outside the gate; staging stays noindex, logs stay disabled,
canonical security/forwarding/rate policy remains, and worker status stays closed.
After readiness and the full privacy audit, activation replaces the bootstrap
certificate hook with the installed full privacy-audit reload hook.

The native demo keeps bundled offline assets. Its Menu invitation field validates
the privately supplied 64-character `gate.json` `cookieToken` against HTTPS
`/api/ready`; no code is embedded in an APK or stored on disk. Deliver it through
a private file/password manager, never chat or screenshots. Process death or the
clear action removes the code without deleting Drafts, Reports or Withdrawal tokens.
Busy invitation requests preserve keyboard focus. Refused, cleared or revoked
access returns displaced component-owned focus to the entry; accepted access
focuses the clear action. Completion does not take focus from another control.
Local capture needs neither invitation nor network. All native API requests use
the same transport, retaining bodies, AbortSignal and Report Bearer authorization.
The invitation header is limited to the exact configured HTTPS origin and `/api/`;
redirects are refused. The staging-only proxy accepts it only from
`https://localhost`, strips it before Node, and allows credential-free CORS
preflight without issuing a cookie or revealing application data. Report-level
403 proof refusal does not invalidate the invitation. Native public-source download
uses the same gate and existing Android document-save flow, not an unauthenticated
external-browser URL. Public production still refuses a private gate/demo artifact.
Gate401 invalidation notifies the mounted Menu entry immediately; no polling or
local-data deletion is used. Readiness status-only failures cancel unused response
bodies. The privacy audit strictly checks both browser and native maps, exact native
origin/API scope, stripped invitation header and unchanged Report Bearer forwarding.

For an application-only rollback, create root-owned mode-0600
`/etc/bor-czuwa-demo/rollback-authorization.json` with the exact verified target
`sourceCommit`, `candidateSha256`, `indexedDbCompatible: true`, `backups: "off"` and
a nonempty `authorization` record. Explicitly establish client IndexedDB compatibility;
matching PostgreSQL schemas do not prove it. Then:

```sh
sudo bash /usr/local/lib/bor-czuwa-release/rollback.sh TARGET_SOURCE_COMMIT demo
```

Rollback reauthenticates the installed staging artifact with the installed demo
policy, checks exact authorization and database/schema/geodata compatibility as
the runtime account, closes routes, switches the application, and waits for
readiness before reopening. It never rolls back the database. An incompatible
target is rejected without switching the running release.

Parent/operator smoke commands, after installing the separately reviewed inputs:

```sh
python3 -m unittest discover -s tests -p test_production_ops.py
python3 -m unittest discover -s tests -p test_nginx_indexing.py
sudo python3 /usr/local/lib/bor-czuwa-release/audit-nginx.py
sudo systemctl is-active bor-czuwa-demo-api.service bor-czuwa-demo-geodata-refresh.timer
sudo systemctl is-enabled bor-czuwa-demo-backup.timer bor-czuwa-demo-integrity-digest.timer bor-czuwa-demo-monitor.timer
sudo systemctl is-active bor-czuwa-demo-backup.timer bor-czuwa-demo-integrity-digest.timer bor-czuwa-demo-monitor.timer
curl --fail --silent --show-error http://127.0.0.1:3001/api/ready
```

The mail timers should report `disabled`; the backup timer may report `static`
because it has no install target. All three must remain inactive, not merely unenabled.
From an unauthenticated external browser, check HTTPS returns 401 and no
`Set-Cookie`; failed credentials must do the same. Sign in, confirm cookie flags
and security/noindex headers, and create **only fictional** Reports. Exercise
Findings, a Report event and Withdrawal with the ownership Bearer token plus
the private session cookie. Confirm `/api/worker-status` remains 404 and HTTP-01
still works without login. Do not send an authority message or treat these browser
checks as native-device evidence. Repeat deployment of the same authenticated
candidate, update to a new authenticated staging candidate, and exercise an
explicitly authorized compatible rollback; retain actual outcomes separately.

## Provision and bootstrap

Run `SSH_USER=<operator> SSH_PORT=<existing administrative port> bash ops/production/provision.sh`
as root on the dedicated Debian 13 host. Keep the current SSH connection open
and verify another key-authenticated connection before closing it. The operator
must already exist with a non-empty `~/.ssh/authorized_keys`. Provisioning disables
password and keyboard-interactive login, denies root login, and allows only that
operator. It validates the effective configuration with `sshd -T` before reloading
SSH. The managed include lives outside Debian's snippet wildcard, so it is read
once while vendor snippets remain in place. Conditional `Match` policies are
unsupported: the check follows includes and refuses any `Match` directive before
reload. Remove those rules before provisioning this dedicated host; public IPv4,
IPv6 and unauthorized-user contexts are also checked. Recheck with `python3 ops/production/check-ssh.py <operator> <port>`.
The script installs
PostgreSQL 17/PostGIS, Node 24 from the signed NodeSource repository,
unattended upgrades, nginx, certbot, restic and Python/GDAL. It owns this host's
firewall and PostgreSQL settings. Repeating it preserves the database and swap.
Only SSH, HTTP and HTTPS are public; PostgreSQL and Node bind to loopback.

Create the four files in `/etc/bor-czuwa/` from the adjacent names-only
examples: `runtime.env`, `maintenance.env`, `digest.env`, `monitor.env`.
All must be root-owned mode 600 and hold no secrets from the repository. The release scripts
read two of them, `runtime.env` and `maintenance.env`, as data and never as shell: each line
is `NAME=value` with a plain, single-quoted or double-quoted value (no `$`, backtick or
backslash inside double quotes), and any other line refuses the release. Those two files
accept only six names: `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `RUNTIME_DB_PASSWORD`,
`RUNTIME_DB_ROLE`, `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE`; any other name refuses
the release. `monitor.env` and `digest.env` are not read by the scripts; systemd loads them
for their units, and they carry the names in their examples (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASSWORD`, `ALERT_FROM`, `ALERT_TO` for the monitor; `DIGEST_FROM`,
`DIGEST_TO` and `DATABASE_URL` for the digest).
`DATABASE_URL` in
runtime and digest uses `app_runtime`; maintenance uses
`postgresql:///bor_czuwa?host=/var/run/postgresql&user=bor_czuwa_owner` through the
peer mapping for the `bor-czuwa-maint` system account. `RUNTIME_DB_PASSWORD` must
match the runtime URL. PostgreSQL creates PostGIS once, then removes superuser
from `bor_czuwa_owner`. The owner retains `CREATEROLE` and an ADMIN grant on
`app_runtime` so migrations can set its password; runtime cannot become owner.
Root loads the maintenance environment and runs migrations as `bor-czuwa-maint`.
The API account `bor-czuwa` has no owner peer mapping. The API receives neither SMTP nor backup
secrets.

Backups are off by the owner's decision of 2026-10-03. No backup provider is selected.
Activation and rollback explicitly disable `bor-czuwa-backup.timer`. The timer has no
install target, and monitoring ignores backup freshness and backup failures.
Do not enable the timer or require a backup account for launch. The retained
backup code and expiry tests do not establish a current recovery point.

If backups are enabled later, set `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE`
for the approved repository. Keep its credentials and the restic password outside the
repo, mode 600 and owned by `bor-czuwa-maint`, with an offline copy in the operator's password manager. For SFTP,
pin the provider's SSH host key; never disable verification. Initialize with
`restic init` after loading the maintenance environment. Provider location, expiry
access and snapshot retention need evidence before enabling this path.

### Where each host lives

Bór czuwa answers on two names that live on two different hosts: `bor-czuwa.pl` (and
`www.bor-czuwa.pl`) for the landing and `app.bor-czuwa.pl` for the app.

| Name | Serves | Lives on |
| --- | --- | --- |
| `bor-czuwa.pl` | Landing, privacy policy, terms | lh.pl shared hosting, directory `public_html/bor-czuwa-landing/` |
| `app.bor-czuwa.pl` | Web app, API | This OVH VPS, `15.235.120.240`, behind the nginx this runbook renders |

The VPS has one nginx server block and one certificate, for the app host, and never serves the
landing. The app host sends `X-Robots-Tag: noindex, nofollow` on every response, documents
included, so search results land on the landing. The API's Origin check follows the host nginx
forwards, so it accepts `https://app.bor-czuwa.pl` and `https://localhost` and
refuses the landing's name. Build the Android release with
`ANDROID_API_ORIGIN=https://app.bor-czuwa.pl`; a production candidate is refused
when that origin differs from the `DOMAIN` given to `deploy.sh`. The Play Console privacy policy
URL is `https://bor-czuwa.pl/prywatnosc/`.

DNS. The `bor-czuwa.pl` zone is managed in the lh.pl panel, and both names are records in it.
The zone also holds the domain's mail records (MX, SPF, DMARC); change those only on purpose.

- App: an A record for `app.bor-czuwa` pointing at `15.235.120.240`, with an AAAA record only
  if the VPS has a reachable IPv6 address. Check that it resolves from outside before
  requesting the certificate.
- Landing: lh.pl must know the name, in two places. The DNS record for `bor-czuwa` points at
  lh.pl, either by the hosting target the panel shows for the account or by the zone's existing
  wildcard if one covers it; do not guess the value, read it in the panel. Then, in the panel's
  domain section, map the name to the directory `public_html/bor-czuwa-landing/`. A DNS record
  alone does not make lh.pl serve that directory. Check with `dig +short bor-czuwa.pl`.

HSTS with `includeSubDomains` or `preload` is a separate decision: it would commit every name
under `bor-czuwa.pl` to HTTPS for the whole max-age, and cannot be recalled early.

The earlier names `bor-czuwa.barankiewicz.dev` and `app.bor-czuwa.barankiewicz.dev` were
retired on 2026-11-16; their records are deleted from the `barankiewicz.dev` zone.

Certificate. Only the app host has one on the VPS. The landing's TLS is lh.pl's and is checked
with `curl -sSI https://bor-czuwa.pl/` after the first deploy.

Landing deploy. The landing is published by the `landing-deploy` GitHub Actions workflow, by
manual dispatch only, because the landing goes live with the app release and not before. It
builds both sites, runs the landing's checks and uploads only `landing/build/` over FTPS. Set
these once in the repository settings, outside any file:

- secrets `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`: the lh.pl account's FTP login;
- variable `FTP_SERVER_DIR`: exactly `public_html/bor-czuwa-landing/`. The workflow refuses
  any other value, because the account holds other projects' sites in neighbouring directories
  and the upload can delete files in its target.

Run it from the Actions tab or with `gh workflow run landing-deploy.yml --ref main`; the job runs
only on main. FTPS certificate checking is off (`security: loose`) because lh.pl's certificate
does not match its FTP hostname, as for the other sites on the account. An attacker on the
runner's network path could read the FTP login; this is an accepted risk, and rotating the lh.pl
password is the remedy if it is ever suspected.
Afterwards read the live headers with `curl -sSI https://bor-czuwa.pl/` and check
`Content-Security-Policy: frame-ancestors 'none'` and `Referrer-Policy: no-referrer` are present.
If they are missing, mod_headers is off on the account: the pages still carry their own CSP and
referrer meta elements, and only the framing ban is lost. Also check that
`curl -sI https://bor-czuwa.pl/.ftp-deploy-sync-state.json` answers 403; a 200 means
the account's Apache ignored the deny and the file list is public.

App TLS. Point the app host at this host, verify DNS, then obtain TLS before
activation. Use `certbot certonly --standalone -d <app host>` for initial issuance
with nginx stopped. After activation, configure renewal with
`certbot certonly --webroot -w /var/lib/letsencrypt -d <app host>` and a deploy
hook that runs the privacy audit before reloading nginx. nginx's effective
configuration is generated from the tested local route policy. Certificates
are never added to release artifacts.

Follow the [verified-candidate runbook](../../docs/release-candidate.md) before
activation. Install the reviewed release controls independently on the operator
workstation and host. `deploy.sh CANDIDATE_DIRECTORY DEDICATED_SSH_ALIAS DOMAIN`
accepts only the exact artifact from a successful trusted CI run plus signed
human acceptance. It does not build assets. The host repeats verification before
installing locked dependencies as `bor-czuwa-build` with `npm ci --ignore-scripts`.
A deployment lock protects installation and activation. Release payloads become
root-owned and read-only to service accounts; `current` points into the verified
payload. The host holds no GitHub deploy key and CI holds no deployment secret.

A first activation migrates the empty database and runs a complete geodata ingest
before starting the API. Activation stops workers before migrating and takes no
backup. A failed migration leaves the API stopped. Repair forward unless a
separately verified matching recovery point exists. Python uses Debian GDAL and
the hash-pinned Python requirements.

## Visit counts for the landing

The landing counts how many times each of its ten pages is opened, and nothing about who opens
them. Each page opening makes one empty POST to `https://app.<apex>/_stats/website?p=<path>`
(`landing/src/lib/files.ts`, `countScript`). The nginx on this host answers it itself and hands a
GoatCounter instance on the same VPS a plain GET for the path. The counter is bound to
`127.0.0.1:8081`, so nginx is the only thing that can reach it and its dashboard is not on the
internet.

What nginx forwards is decided in `containers/nginx.conf`, location `/_stats/website`: the path
only if it is one of the ten pages (anything else is dropped and answered 204), a fixed `Host`
(`website.stats.bor-czuwa.local`, which is how GoatCounter picks the site) and a fixed
`User-Agent`. The visitor's request headers and body are not forwarded at all, which
`tests/test_stats_proxy.py` proves by running this nginx in a container against a fake counter and
sending a request full of address, referrer, cookie, language and authorization headers.
The counter then sees every visit as the same visitor from the same address, which is why it can
keep no sessions.

### Install

1. Debian's `nginx` package includes `ngx_http_auth_request_module`, which the location needs
   (`nginx -V 2>&1 | grep auth_request`; `install-stats.sh` refuses to go on without it). The
   rendered config does not load on an nginx without it, so the deploy would stop at `nginx -t`
   and leave the running site alone.
2. As root: `STATS_EMAIL=<your address> bash ops/production/install-stats.sh`. The script is pinned
   to GoatCounter v2.7.0 and the sha256 of its linux-amd64 archive (both from the project's release
   page, 2026-11-12). It downloads the archive into a private temporary directory, hashes that copy,
   unpacks that copy and installs the unpacked file, so what was checked is what runs. To use an
   archive you downloaded yourself, pass its path. It then creates the `bor-czuwa-stats` account and
   `/var/lib/bor-czuwa-stats`, installs `bor-czuwa-stats.service`, creates the single site (Host
   `website.stats.bor-czuwa.local`; you are asked for the dashboard password once), and requires a
   positive listener on `127.0.0.1:8081`, and nothing on any other address.
3. The script also sets what the dashboard would: `collect` 0 (no session, referrer, browser,
   screen size, location or language) and `data_retention` 14 days, with
   `goatcounter db query -format exec "update sites set settings = json_set(settings, '$.collect', 0, '$.data_retention', 14)"`.
   Check it with `goatcounter db query -db sqlite+/var/lib/bor-czuwa-stats/db.sqlite3 "select settings from sites"`.
4. Render and reload nginx as usual (`render-nginx.py` already carries the location).
5. Prove it end to end. `curl -si -X POST 'https://app.<apex>/_stats/website?p=/'` answers 204 and
   nothing else (no cookie, no body, whatever the counter says). Within a minute the dashboard
   shows one view for the home page. A query that is not exactly `?p=` plus one of the ten paths
   changes nothing. Then send 30 quick requests and confirm the dashboard shows 30 more:
   nginx answers 204 even if the counter refuses a request, so only the dashboard shows a drop.

What was checked by running v2.7.0 itself (a throwaway container, the exact request nginx sends):
a GET `/count?p=/en/` with the site's Host and a browser User-Agent is counted. A bare
`Mozilla/5.0` is filed under bots and counted as nothing, which is why the location sends a complete
browser string. With `collect` 0, every view counts once (sessions are off), the browser and system
tables stay empty, and the `hits` table holds no rows after the counter stores its totals. The
database then holds, per path and hour, a count; the path is kept without its trailing slash
(`/en`, `/prywatnosc`); the location, language and size tables hold only empty values and a count.
Under `systemd-run` with every restriction in the unit (including `MemoryDenyWriteExecute`), it
started and answered a count.

**Page views only.** Every hit reaches GoatCounter from loopback with one fixed address and one fixed
browser string, so any figure it labels visitors, unique visitors, browsers or systems means
nothing here. Read the page totals and nothing else.

**Rate limit.** GoatCounter limits `/count` per client address (4 a second by default). All hits
arrive from `127.0.0.1`, so all visitors would share that one bucket; the unit passes
`-ratelimit count:50/1`. nginx limits each visitor itself (the `events` zone). Check the dashboard
after the burst in step 5 on first install.

### Dashboard

Owner only, never public. From your machine: `ssh -N -L 8081:127.0.0.1:8081 <operator>@<host>`,
add `127.0.0.1 website.stats.bor-czuwa.local` to your hosts file, and open
`http://website.stats.bor-czuwa.local:8081/`. The Host in the address is what selects the site.
There is no public stats hostname, no certificate for one and no nginx location that proxies
anything but `/count`.

### Backup and retention

Backups are off for this host (above), and the counter follows that: its database is a single
file, `/var/lib/bor-czuwa-stats/db.sqlite3`, holding hourly totals per page. Losing it loses past
totals and nothing else. A copy for peace of mind is `sudo -u bor-czuwa-stats sqlite3
/var/lib/bor-czuwa-stats/db.sqlite3 ".backup '/tmp/stats.sqlite3'"`. Hourly totals stay
indefinitely; they identify nobody.

## Indexing policy checks

The app host is never indexed: the public face is the landing on lh.pl, so
`render-nginx.py <domain>` sends `X-Robots-Tag: noindex, nofollow` on every
response, documents included. The two `--indexing` modes now render the same robots header;
the flag remains because the private gate requires `--indexing staging`. Checking a build's own
robots metadata is `check-nginx-indexing.py --policy`. Locations that add
cache headers repeat their security and indexing headers because nginx does not
inherit the server's `add_header` directives there.

`npm run test:ops` includes the generated-proxy response tests. They need Podman,
OpenSSL, Node, Python, Playwright Chromium and the `docker.io/library/nginx:1.28-alpine` image; the
backup tests still need restic. The indexing tests use synthetic HTML and a
disposable nginx container with a loopback-only TLS port. They use no API process or
database and change no running host.

For a candidate's existing build directory, retain served-response evidence with:

```sh
python3 scripts/check-nginx-indexing.py --build build --policy public \
  --evidence .scratch/indexing-public
```

Run the same command with `--policy staging` and a staging build to verify its
exclusion header and hydrated document metadata. The public policy checks that the
header is present and that a public build adds no robots metadata of its own. SSR is disabled, so the current
app writes its robots metadata after JavaScript starts; the check records both
raw HTML and hydrated metadata. Keep the two build directories separate.
Each run saves the rendered and effective nginx configuration, configuration
hashes, nginx image ID, response headers, document metadata and body hashes.
`--config <path>` checks a retained configuration, including a known failing one.
The check also verifies security headers, immutable caching, worker revalidation
and the blocked worker-status route.

This check accepts build output without running the release approval gate. A
passing result proves proxy behavior for those bytes only. `npm run build` must
still pass its legal and test-marker checks before release. Candidate enforcement
remains with Faza 4 ticket 28; Faza 5 ticket 12 owns actual-host acceptance.

## Runtime checks and alerts

`bor-czuwa-api.service` drains work for up to 180 seconds on SIGTERM and restarts
failed or exited processes after 5 seconds, except after a configuration refusal
(see [Why the API did not start](#why-the-api-did-not-start)). Its startup check
requires a compatible migration ledger and Rule sets, and populated current and
pinned geodata schemas. The compose app container runs `node` as PID 1 for the
same reason: SIGTERM has to reach the drain handler, which `npm` in between
would swallow.
Monthly ingest and daily digest use the active release, their own environment
files, and systemd timers. Ingest, digest, monitoring and the retained backup
service run as `bor-czuwa-maint`, separate from the API account. The ingest
lock and temporary downloads live in `/var/lib/bor-czuwa/geodata-tmp`,
owned by maintenance. Extracts remain readable by nginx's `www-data` group.
Monitoring owns only `/var/lib/bor-czuwa/monitor`.
The ingest lock prevents concurrent refreshes.
Ingest failures write only timestamp and exception class to the local refresh
record; command output and raw exceptions do not reach the journal.

Reports from the whole service share an hourly ceiling, 600 by default (ADR-0008). A flood and a
Report going viral look the same from the server, so the monitor sends `report_ceiling_reached`
while the ceiling refuses Reports and you decide. Refused Reports wait on the phones and nothing is
lost. To let more through, set `REPORT_HOURLY_CEILING=<number>` in `runtime.env` and run
`sudo systemctl restart bor-czuwa-api`. Keep it below what the Findings worker drains in an hour,
or the queue grows faster than it empties. A value that is not a whole number from 1 stops the API
at start.

`/api/health` proves process liveness. `/api/ready` proves database access and
that the current geodata exists and is usable; it answers 503 `geodata_unavailable`
otherwise (the answer is cached for 5 seconds, so polling does not load PostGIS).
`/api/worker-status` is blocked at nginx and available only on loopback.
`bor-czuwa-monitor.timer` checks all three every minute, queue age and terminal
failures separately, and failed ingest/digest services. Alerts contain fixed event
names only. Configure `ALERT_TO` as the
operator's authorized mailbox, then test SMTP failure/recovery and delivery.
The state file keeps the last delivered set plus a `pending` list of events seen
since. A failed delivery is retried, and an outage that began and cleared while mail
was down is still named in the first mail that gets through. Mail names only fixed
events: `api_down`, `database_unavailable` (the ready check failed), `geodata_unavailable`
(the database is up but there is nothing to answer a lookup from), `worker_stale`,
`terminal_work_failed`, `geodata-refresh_failed`, `integrity-digest_failed`,
`certificate_expiring`, `report_ceiling_reached` (the hourly Report ceiling refused a Report
in the last 15 minutes), and the startup and release refusals below. With PostgreSQL
stopped the monitor reports `database_unavailable` alone.

The monitor reads optional names from `monitor.env`; unset or empty keeps the production
value. `MONITOR_API_PORT` (3001), `MONITOR_REFRESH_UNIT` and `MONITOR_DIGEST_UNIT` (the
production unit names), and `MONITOR_CERT_HOST`: the app host name, whose certificate it
reads by TLS handshake on `MONITOR_CERT_CONNECT:MONITOR_CERT_PORT` (127.0.0.1:443) and
reports as `certificate_expiring` when fewer than `MONITOR_CERT_MIN_DAYS` days are left
(14; certbot renews at 30) or when it does not validate. Without `MONITOR_CERT_HOST` there
is no certificate check, so set it on production. The demo unit is installed with the demo
unit names, the approved demo domain and a threshold of 2 days (its certificate lives about
6.7 days). The daily digest has its own existing content contract.

### Why the API did not start

The unit discards the API's output, so the cause travels as the exit status. The
start check in `server/main.ts` prints one line, `Start refused: <token>. ...`,
and exits with the status in the table. systemd then runs
`startup_refusals.py record` as root (`ExecStopPost=+`, because the runtime
account must not write a file the monitor trusts), which appends
`<UTC minute> startup_refused:<token>` to
`/var/lib/bor-czuwa/refusals/startup-refusals`. That directory is root-owned
and not writable by anyone else (the monitor account only reads it and keeps its
own state in `monitor/`), so no other account can forge a line. The file keeps
the last 50 lines and holds nothing but a token from this table, or a release
token (see below). The monitor mails each token
recorded in the last 30 minutes as an event name, once, and mails recovery after
it ages out. Statuses 80 to 93, 96 and 97 are in `RestartPreventExitStatus=`, so the unit
stops after one try; 94 and 95 keep the 5-second restart.

The check cannot be an `ExecStartPre=`: systemd sets no exit status for a failed
`ExecStartPre=` and ignores `RestartPreventExitStatus=` for it (measured on
systemd 259, where the unit looped every second with exit 80 configured as final).

To read the cause by hand, run `systemctl show bor-czuwa-api.service -p ExecMainStatus`,
or `node --import tsx ops/production/check-database.ts` as the runtime account, which
prints `Database check refused: <token>.` and exits with the same status.

| Token | Status | Meaning and next step |
| --- | --- | --- |
| `ledger_checksum_mismatch` | 80 | An applied migration differs from this release. Run the release the database was migrated by, or restore. |
| `ledger_newer_than_application` | 81 | A newer release migrated the database. Activate that release or a newer one. |
| `migration_required` | 82 | This release has unapplied migrations. Run `activate.sh` for it. |
| `ledger_missing` | 83 | No migration ledger: the wrong database, or never migrated. Check `DATABASE_URL`, then activate. |
| `rule_set_changed` | 84 | A stored Rule set differs from `data/rule-sets`. A published Rule set never changes under its id; restore the file or publish a new id. |
| `geodata_missing` | 85 | No current geodata is recorded. Run the initial ingest (`activate.sh` does) or the geodata refresh. |
| `geodata_schema_missing` | 86 | The current schema, or a table or column Findings needs, is gone. Rebuild as in recovery step 4. |
| `geodata_rebuild_required` | 87 | The geodata uses an old storage layout. Rebuild as in recovery step 4. |
| `geodata_empty` | 88 | The current geodata holds no dwellings or no recipient areas. Rebuild as in recovery step 4. |
| `migration_list_mismatch` | 89 | The migration files in the release do not match its list. Redeploy a clean candidate. |
| `unsupported_runtime_role` | 90 | `RUNTIME_DB_ROLE` names a role this release does not support. |
| `database_auth_failed` | 91 | The database refused the runtime login. Check the password in `runtime.env` against the role. |
| `database_missing` | 92 | The database in `DATABASE_URL` does not exist. |
| `database_permission_denied` | 93 | The runtime role lacks a grant this release needs. Run `activate.sh` so the migrations restore it. |
| `database_url_invalid` | 97 | `DATABASE_URL` is not a valid URL. Correct it in `runtime.env`. |
| `schema_incomplete` | 96 | A table or column this release needs is missing, for example `current_geodata`. Run `activate.sh` for the migrations. |
| `database_unavailable` | 94 | PostgreSQL could not be reached, including a host name that does not resolve (`ENOTFOUND`): DNS failures are often transient, so the unit keeps retrying. |
| `unknown` | 95 | None of the above. The unit keeps retrying; run the check by hand. |

Start refusals are recorded as `startup_refused:<token>`. Release refusals (below, and each failed activation step as `activation_<step>`) are recorded in the same file as `release_refused:<token>`. The monitor mails either as an event name. `activate.sh`, `rollback.sh` and `deployment.py` refuse with
`Release refused: <token>. <sentence>`, for example `other_commit`,
`other_candidate`, `indexeddb_incompatible`, `no_authorization`, `not_installed`,
`host_not_prepared` (the host has no marker for the environment named, such as
the production script run on the demo host) or `config_missing`. A rollback whose
database check fails prints `Rollback refused: database not compatible (<token>).
The running release is unchanged.` A failed activation names the step that failed
(`Failed step: initial_ingest.`, `migrate`, `readiness` and so on) beside the
migration cause class. Demo bootstrap prints `Demo bootstrap failed: <token>.`
A failed activation is recorded as `release_refused:activation_<step>`, so the monitor hears of it even though the API never starts. None of these lines carries a path, a value or an exception message.

Findings `terminal_failures` counts only `computation_failed`; `domain_outcomes`
counts unavailable rules, species and coverage separately. `api_503_by_class`
counts responses since process start. Failure events and Integrity refresh rows
keep SQLSTATE or an error class plus a fixed step, without exception text.
The monitor sends another alert whenever either terminal failure count increases.

After fixing the cause, run under the runtime database role:

```sh
npm run operator -- requeue-findings computation_failed --since 2026-10-03
```

Omit `--since` to retry every job with that reason. The date selects failure events
from that day onward in the database time zone. The command resets attempts,
availability and pinned Rule set/snapshot, allowing the worker to select current
data. Check loopback `/api/worker-status` until the queue drains, then inspect
Findings for an affected Report. Domain reasons can also be selected explicitly;
retry them after the relevant data or Rule set has been corrected.

An external EU uptime monitor must check `https://app.bor-czuwa.pl/api/ready`
and send to that
same authorized destination. A second check on `https://bor-czuwa.pl/` covers the
landing on lh.pl, which this host's monitoring cannot see. Local monitoring cannot report a powered-off
host. Register the service and verify a deliberate API stop before release;
no external alert channel has been authorized or tested in this ticket.

## Backup and recovery

This section describes retained backup tooling for a later opt-in. With backups off,
a disk failure or operator mistake can lose all synced Reports. There is no current
backup restore point. The production drill must not claim backup/restore acceptance.

A later opt-in must restore the timer's `[Install]` target, enable it, and reinstate
backup freshness and failure monitoring. When enabled, it runs nightly at 02:00 UTC. `backup.py` streams a consistent
custom-format pg_dump into an encrypted restic archive in the selected repository.
It includes Reports, token hashes, events, Withdrawal tombstones, Findings,
pending Findings/Integrity jobs, Rule sets, snapshot provenance and the
migration ledger. PostgreSQL privileges survive restore. Geodata definitions
remain but geometry rows and old OSM byte payloads are excluded. `rate_counter`
rows are excluded; proof keys and salts are never on disk. Plaintext temporary
files live under `/run/bor-czuwa-backup`, mode 700, and disappear after each run.
A release SHA accompanies every dump. Keep those release artifacts available
for every retained backup.

Expiry runs before dumping and after backup. It explicitly forgets every
snapshot at least 34 days old, then keeps 7 daily and 4 weekly points and
prunes unused ciphertext with `--max-unused 0`, including partially live packs. A final snapshot-age check and `restic check` must
pass before backup success is recorded. The 34-day cutoff gives one day of
margin before the published 35-day bound. Failed pruning or a missed job is
a privacy incident, not a proven expiration. A daily timer alone cannot
promise deletion during a prolonged outage: an independent operator must
monitor repository expiry access, prune from another machine when the VPS is
unavailable, and confirm provider snapshots/deleted-block retention before
release. Use `python3 ops/production/backup.py expire` with the same private
repository access for that recovery. Do not enable provider snapshots
that retain old repository packs beyond this bound.

For a restore drill or disaster recovery:

1. Provision a fresh host and empty database. Install the release SHA from the
   selected backup. Stop API and scheduled writers; keep public traffic closed.
2. As root, export the maintenance environment and create `/run/bor-czuwa-backup`
   mode 700 owned by `bor-czuwa-maint`.
   Run `runuser -u bor-czuwa-maint -- python3 ops/production/backup.py restore <snapshot-id>`.
   Restore refuses a database containing a migration ledger and runs inside
   one transaction. Never restore over current Reports.
3. Run the matching release's `runuser -u bor-czuwa-maint -- npm run migrate` to set the runtime password.
   Restore preserved grants, migration checksums, authorization and pending
   work. Do not use a newer release until this restored pair is verified.
4. Rebuild the current snapshot and each snapshot pinned by unfinished
   Findings jobs with the original hash-matching inputs:
   `runuser -u bor-czuwa-maint -- env GEODATA_REBUILD=1 DATABASE_URL="$MIGRATION_DATABASE_URL" .venv/bin/python scripts/ingest-bubd.py <the original eight input paths>`.
   This mode requires empty geometry storage and every original dataset hash.
   It preserves snapshot metadata and an older pinned snapshot never replaces
   the current one. Regenerate immutable ambony files in
   `/var/lib/bor-czuwa/geodata-extracts`.
5. Compare expected Report/event/Findings content, token authorization,
   Withdrawal replay, queued job versions and ledger checksums against the
   source. Run `node --import tsx ops/production/check-database.ts` with the
   runtime environment. Start the API only after that check passes.

Reports accepted after the recovery point return only from phones that still
hold them, at each phone's next launch or hourly resume
([recovery after server loss](../../DEVELOPMENT.md#recovery-after-server-loss)).
A Report whose phone copy is gone cannot be recovered.

Original public inputs are not guaranteed to remain downloadable by hash.
Keep a separate archive of the public input bundles for current and pinned
snapshots, including manifests, outside the Report backup. The nationwide
source archive and retrieval drill remain release gates. Fetching today's
sources does not reproduce yesterday's snapshot. Monthly fresh-host restore
must use a recovery point, rebuild its geodata, and compare the state above when
backups are enabled. This is not part of the current no-backup release path.

For application rollback without schema changes, run
`bash /usr/local/lib/bor-czuwa-release/rollback.sh <installed-release-sha>` on the host.
A new signed rollback acceptance is required. A release activated by this version keeps
a receipt on the host (`activation-receipt.json` beside its `payload/`) and rolls back
without GitHub: the installed bytes are checked against the receipt, and a changed byte
is refused by name. An older release has no receipt and needs its hosted verification
artifact, which expires 14 days after its run. Releases already installed are not given
receipts afterwards, so the first rollback after this ships works from a receipt only for
a release activated since. Activation needs a hosted run at most 72 hours old by default.
Compatibility is checked before stopping the active process. Older code
against a newer ledger is refused. A schema rollback requires a matching
backup and release restored onto a fresh host; preserve post-backup Reports
and Withdrawal tombstones before any traffic cutover. Never replay a dump
over live data. Failed deployment keeps the API closed when compatibility
cannot be proved; recovery stays explicit. With backups disabled, a database
schema downgrade has no supported recovery point.

An IndexedDB schema bump is a separate rollback boundary. Once a device opens
the new schema, older builds cannot open that database. Do not roll back past a
release that increased the IndexedDB version, even when the server ledger is
compatible. Keep the new client and repair forward. Never ask Reporters to clear
storage as a rollback step: it contains local Reports, tokens, notes and photos.

Run `python3 scripts/production-drill.py` from the checkout to exercise activation,
service users, owner migrations and effective SSH settings in a disposable Podman
container. Use `--host-only` to rerun just the deployment checks. It skips backup and restore by the 2026-10-03 decision, while retaining
the offline expiry regression tests. systemctl, readiness, GDAL installation and
nginx activation use stand-ins; real systemd execution, nationwide ingest and
provider behavior still need dedicated-host evidence.

## Hardening

What the repository sets, and the command that shows it on a running host. Faza 7's audits test
these settings; they do not change them.

Which path applies. A fresh dedicated host gets everything from `provision.sh` (it calls
`harden-host.sh` and installs `pg_hba.conf`) and from the first activation (nginx and the unit files):
work through the verification commands below once it is up. The already provisioned demo host must not
run `provision.sh`. For it the order is fixed, because the proxy and unit files only change with the
cut-over from the old names (activation renders nginx and installs the units from the reviewed
controls; never edit the old `zglos-*` units in place):

1. Host steps 1 to 3 below (firewall, PostgreSQL, SSH). They need nothing from the new release.
2. The cut-over, exactly as in [Host provisioned under the old names](#host-provisioned-under-the-old-names).
3. Steps 4 and 5, which verify the new nginx render and the sandboxed units. On the demo host the units
   are the `bor-czuwa-demo-*` copies (`bor-czuwa-demo-api`, `-monitor`, `-backup`,
   `-geodata-refresh`, `-integrity-digest`); the commands below use the production names, so
   substitute them there.

### Before you touch the firewall or SSH

A wrong firewall or SSH change locks you out, and a host without an out-of-band console
cannot be rescued. So: keep your current SSH session open and do not close it until a second, new login from
another terminal (`ssh <operator>@<host>`, key only) has succeeded after the change. If it does not,
from the kept session run `sudo nft delete table inet bor_czuwa` (removes only this ticket's rules and
nothing else), or use the OVH console to do the same. The script also refuses to run unless something
is listening on the SSH port you give it.

### 1. Firewall, sysctls, security updates (`harden-host.sh`)

`provision.sh` runs it on a fresh host. `install-release-control.sh` does not install it, so on the demo
host take the one file from the reviewed checkout, read it, and copy it over (this is the host's
current-state setup, not a release control):

```sh
git show <reviewed-commit>:ops/production/harden-host.sh > /tmp/harden-host.sh      # on your machine
scp /tmp/harden-host.sh <operator>@<host>:/tmp/harden-host.sh
# on the host, with the second session kept open:
sudo nft list ruleset                  # read what is there; it is kept, only table inet bor_czuwa is ours
sudo SSH_PORT=<administrative port> bash /tmp/harden-host.sh
```

The rules live in their own table, `inet bor_czuwa`, deleted and recreated on each run, so ufw,
fail2ban or container rules are left alone. It writes `/etc/nftables.d/bor-czuwa.nft` and includes it
from `/etc/nftables.conf`, which `nftables.service` loads at boot; there is no forward chain, so
routing is not touched. The script loads the firewall first, then `/etc/sysctl.d/91-bor-czuwa-hardening.conf`
(only that file; a failure there is reported at the end and does not undo the firewall), then sets
unattended upgrades to Debian `-security` plus NodeSource, clearing the stock list first because apt
list options accumulate (the stock list includes ordinary Debian updates), with no automatic reboot: a
new kernel waits for you. On Ubuntu only `20auto-upgrades` is written, since Ubuntu's own defaults
already take `-security`. Verify:

```sh
nmap -Pn -p- 15.235.120.240                  # from another machine: SSH port, 80 and 443 only; add -6 -p- for IPv6
sudo nft list table inet bor_czuwa           # input policy drop; one dport rule: <ssh>, 80, 443
sudo systemctl is-enabled nftables
sysctl net.ipv4.conf.all.rp_filter net.ipv4.conf.all.accept_redirects net.ipv4.conf.all.accept_source_route \
  net.ipv4.tcp_syncookies kernel.dmesg_restrict kernel.kptr_restrict   # 1 0 0 1 1 2
apt-config dump | grep -E 'Unattended-Upgrade::(Origins|Automatic-Reboot)|Periodic::Unattended'
#   exactly two Origins-Pattern lines: Debian -security and Node Source
sudo unattended-upgrade --dry-run -d 2>&1 | grep -i 'allowed origins'
```

### 2. PostgreSQL stays local

`provision.sh` sets `listen_addresses = '127.0.0.1'` and installs `pg_hba.conf`: the postgres
superuser and the maintenance account (as the database owner) over the socket, the runtime role over
loopback. Nothing else is admitted. On the demo host, whose `pg_hba.conf` is the distribution file plus
the demo rules from `bootstrap-demo.py`, check instead of replacing it:

```sh
sudo -u postgres psql -XAtc 'SHOW listen_addresses'      # 127.0.0.1 or localhost, never * or 0.0.0.0
sudo ss -ltnp 'sport = :5432'                            # 127.0.0.1 and/or [::1] only
sudo awk '$1 !~ /^#/ && NF && $1 ~ /^host/ && $4 !~ /^(127\.0\.0\.1\/32|::1\/128)$/ && $NF != "reject"' \
  /etc/postgresql/17/main/pg_hba.conf                   # prints nothing
```

If the last command prints a rule, change its address to loopback or its method to `reject`, then
`sudo systemctl reload postgresql` and repeat.

### 3. SSH

`harden-ssh.sh` (run by `provision.sh`) is unchanged and was rechecked: key login only, no root,
`AllowUsers` the operator, the managed file read before vendor snippets. The drill proves it overrides
vendor defaults and that `check-ssh.py` detects drift and `Match` overrides.

```sh
sudo sshd -T | grep -E '^(port|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|allowusers) '
python3 ops/production/check-ssh.py <operator> <port>
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no <operator>@<host>   # must be refused
```

### 3a. The operator's sudo

`deploy.sh` needs root for three fixed, root-owned controls only: `receive.sh` (takes the upload
into a staging directory it created, and only the files activation reads), `activate.sh` and
`rollback.sh`. `ops/production/sudoers-deploy` allows exactly those without a password. Give the
operator a password first, from a kept session, then install the rule and remove any broader one:

```sh
sudo passwd <operator>                      # the password every other sudo will ask for
sed 's/^OPERATOR /<operator> /' ops/production/sudoers-deploy | sudo tee /etc/sudoers.d/bor-czuwa-deploy >/dev/null
sudo chmod 0440 /etc/sudoers.d/bor-czuwa-deploy && sudo visudo -cf /etc/sudoers.d/bor-czuwa-deploy
sudo grep -rn 'NOPASSWD' /etc/sudoers /etc/sudoers.d/   # only the bor-czuwa-deploy lines may remain
sudo -k; sudo -n true; echo $?                           # 1: anything else now needs the password
```

On Ubuntu the cloud image's `/etc/sudoers.d/90-cloud-init-users` grants the default account
`NOPASSWD:ALL`; remove that line once a second session has proved the password works.

### 4. nginx: TLS, HSTS, request handling (after activation)

Rendered by `render-nginx.py`, refused by `audit-nginx.py` if any of it is missing (so activation
and the certificate renewal hook both fail closed). Maintenance mode renders the same template with a
`return 503;` rather than editing the live file, so it passes the same audit even on a host whose live
config predates a policy change. TLS 1.2 and 1.3 only, the Mozilla "intermediate"
ECDHE suites without the finite-field ones (so no DH parameters), server cipher order off, session
tickets off, HTTP/2. OCSP stapling is off on purpose: Let's Encrypt certificates no longer carry an
OCSP responder URL, and nginx would only log errors. If a different CA is used and
`openssl x509 -noout -ocsp_uri -in /etc/letsencrypt/live/<name>/fullchain.pem` prints a URL, add
`ssl_stapling on; ssl_stapling_verify on;` and a `resolver`; the audit refuses stapling without both.

HSTS covers the app host only, with no `includeSubDomains` or `preload`, and the port 80 redirect sends
none. The audit rejects `includeSubDomains` and `preload`, which is what keeps it from reaching
`barankiewicz.dev` and the landing on lh.pl. The `max-age` is a deploy setting, not yet decided by the
owner: with no file it is one year (`31536000`); `/etc/bor-czuwa/hsts-max-age` (demo:
`/etc/bor-czuwa-demo/hsts-max-age`), root-owned, holds the number of seconds instead, between 300 and
63072000, and the audit refuses anything under 300. A browser that has seen the header refuses plain
HTTP for that host name until it expires, and it cannot be recalled early, so the certificate must keep
renewing. A cautious ramp, if wanted: `300` at first activation, check `curl -sSI` and one
`certbot renew --dry-run`, then `86400`, then a week or more after a real renewal worked, `31536000`;
each change is a file edit plus the next activation.

Request handling: header buffers 2k plus 4 x 8k, 10 s header and body timeouts, 15 s send timeout,
2 s upstream connect, a per-client connection limit, a separate pool of 40 connections with 4 per client
for every route that takes a request body (a client dripping a body cannot use up the page's connections), and per location only the methods it needs (405
otherwise, including `/_stats/website`, which takes POST only). Dotfiles other than `/.well-known/` and
`*.bak`, `*.old`, `*.sql`, `*~` and the like answer 404 like any missing file. Error responses carry
the security headers and a bare status: JSON under `/api/`, one line of plain text elsewhere. nginx
still sends `Server: nginx` (stock nginx cannot remove it) but no version.

```sh
testssl.sh --protocols --ciphers --headers --server-defaults https://app.bor-czuwa.pl
#   TLS 1.0 and 1.1 not offered, no CBC or RC4, no DH; HSTS with the max-age you set, no includeSubDomains, no preload
curl -sSI --http2 https://app.bor-czuwa.pl/ | grep -iE '^(HTTP/2|strict-transport|server)'
curl -sSI http://app.bor-czuwa.pl/ | grep -ic strict-transport    # 0
curl -sSI https://bor-czuwa.pl/ | grep -i strict-transport         # not ours: lh.pl's own header, if any
curl -sS -X PUT -w ' %{http_code}\n' https://app.bor-czuwa.pl/api/reports   # 405 {"error":"method_not_allowed"}
curl -sS -w ' %{http_code}\n' https://app.bor-czuwa.pl/.env                # 404 Not found
curl -sSI https://app.bor-czuwa.pl/missing | grep -iE 'x-content-type|strict-transport'  # both present on a 404
(printf 'GET / HTTP/1.1\r\nHost: app.bor-czuwa.pl\r\nX-Slow: a'; sleep 12) \
  | openssl s_client -quiet -connect app.bor-czuwa.pl:443    # closed or 408 after 10 s
sudo python3 /usr/local/lib/bor-czuwa-release/audit-nginx.py && echo audit ok
```

The same template feeds the test stack, so `containers/nginx.conf` already has the methods, dotfile
and error-page rules; TLS, HSTS and HTTP/2 exist only in the host render.

### 5. Services (after activation)

Each unit has an empty capability set, no devices, no kernel, clock, hostname or cgroup access, no
namespaces, an address-family allowlist and the `@system-service` syscall filter without `@privileged`
and `@resources`. The monitor, backup and refresh units are read-only except their own state
directories (`StateDirectory=`, so the demo copy writes under its own name); the monitor and backup
units also forbid writable-executable memory. The API and digest units do not: V8 maps JIT pages
writable and executable, so `MemoryDenyWriteExecute` would stop Node. The refresh unit leaves it off
because GDAL's Python binding was not exercised under it. The stats unit (GoatCounter, ticket 14) keeps
its loopback-only IP allowlist and its own `MemoryDenyWriteExecute`. Exposure before and after
(`systemd-analyze security`, 0 safe, 10 exposed, systemd 257): API 8.3 to 1.3, monitor 9.0 to 1.2,
backup 9.0 to 1.2, geodata refresh 9.0 to 1.3, digest 9.0 to 1.3, stats 2.3 to 1.2. The units reach the
host through the reviewed controls (`install-release-control.sh`, then activation; the stats unit through
`install-stats.sh`), not by editing files in place.

If backups are ever enabled with a repository on a local path (not SFTP), the backup unit runs under
`ProtectSystem=strict` and cannot write there: add `ReadWritePaths=<that path>` to a drop-in
(`systemctl edit bor-czuwa-backup.service`). Without it the repository write fails with a read-only
file system.

```sh
for u in bor-czuwa-api bor-czuwa-monitor bor-czuwa-backup geodata-refresh integrity-digest bor-czuwa-stats; do
  systemd-analyze security --no-pager "$u.service" | tail -1; done      # every line 2.0 or lower; demo: bor-czuwa-demo-*
pid=$(systemctl show -p MainPID --value bor-czuwa-api.service)
grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/$pid/status               # 0000000000000000, 1, 2
curl -fsS http://127.0.0.1:3001/api/ready                           # {"status":"ready"}
systemctl show -p Result --value bor-czuwa-monitor.service            # success after the next minute
```

### What the drill proves and what it cannot

`python3 scripts/production-drill.py --host-only` boots systemd in a disposable container, installs the
real unit files and starts the API, monitor (production and demo names), backup and digest units, and
probes the refresh and stats units' sandboxes with stand-ins; it also checks the written firewall (and
loads it beside a foreign table), sysctl, upgrade and `pg_hba` files, and activation's maintenance mode
over an old-template config. `test_nginx_indexing.py` runs the rendered nginx for TLS, HTTP/2, method,
dotfile, slow-header, error-header and HSTS behaviour. It cannot
load the sysctls into the host kernel (the container shares its host's), prove that the live
certificate, DNS, OVH network firewall or VAC behave, run the national ingest or the API's geodata gate
(no geodata), run the GoatCounter binary, or send mail. Those stay with the commands above and the
release gates.

## Privacy, TLS and provider evidence

`audit-nginx.py` inspects `nginx -T` without printing it. Every access log must
be off and every error log must target `/dev/null`. `X-Real-IP` is overwritten
with the socket address in memory; incoming forwarding headers are removed.
The API trusts only its loopback proxy. Route limits, global connections and
download concurrency reuse the tested nginx policy. Request bodies are 8 kB,
connection and read deadlines are bounded, immutable assets cache for a year,
and entry documents revalidate. nginx and API service output is discarded,
PostgreSQL query/parameter/error logging is disabled, and core dumps are off.
Administrative SSH logs are outside the anonymous Reporter request path.

Before release, send bounded synthetic traffic with distinctive IP, bearer,
lookup and body markers. Inspect nginx, application, PostgreSQL, journal,
core dumps, kernel/firewall and provider-controlled persistent logs. Record
scope, marker absence and inaccessible provider systems. Do not save raw
responses or credentials in the evidence. Recheck after certificate renewal.

Verify TLS, renewal and rollback externally, including IPv6 exposure, with the commands in
[Hardening](#hardening). The renderer always sets HSTS for the app host; see there for what that commits to.

OVH VAC capacity/settings and upstream traffic logging need evidence from
the dedicated account. Local route limits cannot prove volumetric protection.
Confirm the selected OVH service, region, DDoS configuration and any retained
network logs. Confirm the uptime provider's EU location and alert receipt. If backups are enabled
later, confirm repository encryption access, provider snapshot retention and EU location.
Each unverified item blocks public release; local container tests do not
establish provider behavior.
