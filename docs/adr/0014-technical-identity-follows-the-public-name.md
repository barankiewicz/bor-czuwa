# Technical identity follows the public name

Status: accepted, 2026-11-12. Supersedes [ADR 0013](0013-public-brand-keeps-technical-identity.md).

The public name is Bór czuwa, and every technical identifier now says so too: the Android package id
and custom URL scheme `pl.borczuwa.app`, the npm package, the Java package, the IndexedDB database,
the compose project, systemd units, system users, install paths, the production database and its
roles, the environment prefix and the container and test-runner names, all `bor-czuwa` or
`bor_czuwa` where a hyphen is not allowed.

ADR 0013 kept the old identifiers so that existing installs would keep their Drafts, Reports and
withdrawal tokens. That protects nobody here. Nothing has been released: no public web origin has
users, no build was given to anyone, and the Play listing does not exist. The cost of keeping the
old names is the opposite one. An Android package id is permanent after the first Play upload, so a
new name would be stuck with an old id for the life of the app, and every operator command and log
line would keep naming a product that no longer exists.

The Android package id does not follow the hosting domain. The domain is still provisional, while
the id must outlive any move. The Capacitor WebView origin stays `https://localhost`, so the app's
web storage does not depend on a hostname either. Hostnames stay deploy arguments and are not
written into source.

## What an existing test install sees

No migration is written. A test build under the old package id is a separate Android app from the
renamed one, with its own empty storage, and it is not overwritten or removed. A browser on a web
origin that served the old build sees an empty `bor-czuwa` IndexedDB database, because the old
`zglos-mysliwego` one is not read. The `localStorage` keys (`first-launch-seen`, `interface-language`,
`draft-reminders`) never carried the old name and are unchanged, so such a browser skips the
first-launch screen and opens on an empty store. A test database or host provisioned under the old role and
database names is not touched by the renamed scripts and has to be created again.

## What stays

The local directory `zglos-mysliwego`, the git history, closed tickets, evidence under `.scratch/`
and the prototypes keep the old name as historical records. Local tooling and worktrees are keyed
on the directory path, so renaming it would cost more than it returns.
