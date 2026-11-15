# Container build inputs

Run container builds from the repository root. These are the supported entry points:

| Entry point | Images |
| --- | --- |
| `npm run stack` or `podman compose up --build` | app, migration (the app target), web, fixture |
| `docker compose up --build` | The same Compose services |
| `podman build -f containers/app.Containerfile --target app .` | Node API and migration runner |
| `podman build -f containers/app.Containerfile --target web .` | nginx and static assets |
| `podman build -f containers/ingest.Containerfile .` | Fixture ingestion |

The direct build commands also support `docker` in place of `podman`.
Both engines use the repository root as the context. Podman reads
`.containerignore`; Docker reads `.dockerignore`. Keep their contents identical.
A custom ignore file, another context root or a Dockerfile-specific ignore file
is outside this contract.

The policies deny files by default and admit the application source, server,
static assets, checked-in data, scripts, container files and required Node build
configuration. They exclude private directories and credential files even inside
an admitted source directory. npm configuration stays outside the context because
`.npmrc` can contain registry tokens. New build inputs need an explicit policy
change. Put captures and local data outside the admitted directories; an ignore
policy cannot recognize a secret saved under an ordinary source filename.

The container build generates `.svelte-kit` and `build` itself. It installs its
own dependencies and uses the checked-in fonts, authority directory, Rule sets
and geodata fixtures. Host output, Android signing files, tool worktrees,
credentials, browser traces and local planning documents are not build inputs.
The production host deployment uses its existing tracked-source archive and does
not use these container entry points.

## Verify the boundary

Requirements: Node 22.12 or later, Git, tar and the selected container engine.
Run each engine separately; a Docker alias pointing at Podman is not Docker proof.

```sh
node scripts/check-private-context.mjs --engine podman --build-images
node scripts/check-private-context.mjs --engine docker --build-images
```

The check copies tracked working files into a temporary directory and plants
synthetic markers in private paths there. It never copies the real private
workspace directories. A scratch image with `COPY .` exposes the complete
copyable context, including files no application Dockerfile happens to use.
The check saves that image and scans every layer for the marker. With
`--build-images`, it also builds and scans every layer of app, web and fixture,
including inherited layers. Gzip layers are decompressed before scanning. This catches a private file copied and deleted in a
later layer. The migration service uses the checked app target.

Build logs go to stderr. The final stdout line is JSON. Exit 0 means `ok: true`;
any failed build, private marker or cleanup failure exits nonzero. The result
records the engine, source commit, number of planted paths and each image's ID,
layer count and uncompressed layer archive bytes. The source commit identifies
the baseline; tracked working edits are included. Image IDs identify the actual
built images. Context size is the scratch layer archive size, including tar
headers and padding, not the engine's compressed network transfer size.
Temporary source, saved archives and tagged images are removed after the check.
The engine may retain build cache.

Without `--build-images`, the command checks only the scratch context image.
The deployment tests use this shorter check:

```sh
node --import tsx --test tests/private-build-context.test.ts
PACKAGING_ENGINE=docker node --import tsx --test tests/private-build-context.test.ts
```

The negative control adds an exception for the planted tool worktree. This
command must exit 1 with `error: "private_marker_in_layer:context"`:

```sh
node scripts/check-private-context.mjs --engine podman --negative
```

The test checks both success and that deliberate failure. CI can run the full
command for each engine and retain its JSON and stderr as build evidence.

These are staging containers. Successful packaging checks do not authorize a
public release. The production marker/legal check, Android signing checks and
human release gates in [Development](../DEVELOPMENT.md#release-gates) still apply.
