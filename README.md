# Orahako plugin registry

Curated release metadata for the official Orahako plugins. This repository is
private and maintainer-only. It is the source of truth behind the public
marketplace index at <https://ysu.welain.com/updates/plugins.json>.

The client, website and API remain in
[`Youwenqwq/ysu-client`](https://github.com/Youwenqwq/ysu-client). Plugin source
lives in `Youwenqwq/orahako-official-plugins`. Because both repositories are
private, the public website serves a generated snapshot of the index; see
[Website snapshot](#website-snapshot).

## Repository layout

```text
plugins/<plugin-id>.json   One curated metadata file per plugin
bundles.json               Curated bundles offered by the marketplace
scripts/generate.mjs       Build dist/plugins.json (offline)
scripts/validate-artifacts.mjs  Verify every published ZIP online
scripts/sync-website.mjs   Write the website edge-function snapshot
scripts/lib/               Shared schema rules and registry loading
.github/workflows/         CI: generate, validate, upload dist/plugins.json
```

`dist/` is generated output and is not committed.

## Plugin metadata

Every `plugins/<id>.json` file contains both public marketplace display data
and registry-internal bookkeeping. The generator copies only schema-v1 fields
into the published index.

Public fields:

| Field        | Notes                                                     |
| ------------ | --------------------------------------------------------- |
| `id`         | Lowercase DNS-like plugin id; matches the file name       |
| `name`       | Display name                                              |
| `summary`    | Display summary                                           |
| `author`     | Display author                                            |
| `homepage`   | Optional absolute `https` URL                             |
| `icon`       | Optional package-relative icon path                       |
| `categories` | Non-empty array of display categories                     |
| `versions`   | Releases, newest first                                    |

Release fields:

| Field           | Notes                                                      |
| --------------- | ---------------------------------------------------------- |
| `version`       | SemVer published in the ZIP manifest                       |
| `apiVersion`    | Plugin API version; must be `1`                            |
| `minAppVersion` | Optional minimum app SemVer                                |
| `platforms`     | Subset of `["web", "android"]`                             |
| `zipUrl`        | Root-relative `/plugins/<id>/<version>.zip`                |
| `sha256`        | Lowercase SHA-256 of the published ZIP                     |
| `size`          | Exact ZIP byte size                                        |
| `publishedAt`   | ISO-8601 UTC timestamp, e.g. `2026-11-14T22:34:25Z`        |
| `changelog`     | Optional non-empty changelog                               |

Registry-internal fields (stripped from `dist/plugins.json` and the website
snapshot):

| Field        | Value                                             |
| ------------ | ------------------------------------------------- |
| `repository` | `Youwenqwq/orahako-official-plugins`              |
| `sourcePath` | Plugin directory inside that repository           |
| `trust`      | `official`                                        |
| `order`      | Curation order for the generated `plugins` array  |

The generator derives `updatedAt` deterministically as the latest release
`publishedAt`; there are no generation timestamps.

### Adding a plugin

Create `plugins/<id>.json` whose file name matches the plugin id. Set
`repository` to `Youwenqwq/orahako-official-plugins`, `sourcePath` to the
plugin directory in that repository (for example `plugins/theme-yuna`),
`trust` to `official`, and a unique positive `order` for the generated
`plugins` array. Then add the published release objects, newest first. Only
official plugins are curated here.

### Release immutability

`<id>@<version>` is immutable. Once a release is listed:

- Never edit `version`, `zipUrl`, `sha256`, `size` or `publishedAt`.
- Never replace the published ZIP at its existing URL.
- Publish a new version (and new ZIP URL) to change plugin code, then add a new
  release object at the top of the `versions` array and write a new changelog.

The public index keeps `zipUrl` values root-relative. The website serves the
ZIPs under `/plugins/<id>/<version>.zip`, so `scripts/validate-artifacts.mjs`
resolves them against <https://ysu.welain.com/updates/plugins.json> and verifies
size, SHA-256, safe archive paths and the manifest before a change is merged.

### Bundles

`bundles.json` contains the curated `bundles` array from schema version 1.
Bundle ids, names, school ids and plugin ids are validated; plugin ids in a
bundle may refer to plugins built into the client, so they are not required to
appear under `plugins/`.

## Commands

Requires Node.js 20+ and pnpm. The layout assumes the sibling repositories from
the project workspace:

```bash
pnpm install
pnpm run generate            # writes dist/plugins.json
pnpm run validate            # downloads and verifies every published artifact
pnpm run sync:website        # writes ../ysu-client/.../updates/plugins.json.js
pnpm run sync:website:check  # exits non-zero when the snapshot is stale
```

`sync:website` accepts `--out <path>` (or `REGISTRY_WEBSITE_INDEX`) when the
client checkout is not a sibling. `validate` accepts `REGISTRY_BASE_URL` to
point at a staging deployment; relative `zipUrl` values are resolved against
it.

The generator is deterministic: plugin files are read in file-name order and
then ordered by `order`, JSON uses two-space indentation with a trailing
newline, and repeated runs produce byte-identical output.

## Maintainer flow

This repository has no community submission bot, crawler or public template;
changes are maintainer pull requests only.

1. Publish the plugin build in `Youwenqwq/orahako-official-plugins` and upload
   the immutable ZIP to the website at `/plugins/<id>/<version>.zip`. CI
   validates against the live distribution, so the ZIP must already be
   reachable before the pull request checks can pass.
2. Open a pull request here. Add the new release entry with the exact published
   `sha256`, `size` and `publishedAt`, update `homepage`/display fields if
   needed, and keep existing releases untouched.
3. CI runs `pnpm run generate` (schema validation) and `pnpm run validate`
   (size, hash, ZIP layout and manifest verification). A successful run uploads
   `dist/plugins.json` as the `plugins.json` workflow artifact.
4. Merge after review. The registry never deploys the website itself.
5. In `ysu-client`, regenerate the public snapshot with
   `pnpm run sync:website` from this repository, commit the generated
   `website/edge-functions/updates/plugins.json.js`, and deploy.

## Website snapshot

Both metadata repositories are private, so the public distribution stays in
`ysu-client` as generated output. `scripts/sync-website.mjs` writes
`website/edge-functions/updates/plugins.json.js` with:

- a clearly marked `@generated` header,
- the schema-v1 index only (no registry-internal fields),
- the existing GET handler with JSON, CORS `*` and `Cache-Control: no-cache`,
- the existing OPTIONS preflight response.

Do not hand-edit that file; rerun `pnpm run sync:website` instead. The command
is idempotent and leaves the file untouched when it is already current, and
`pnpm run sync:website:check` detects drift in the client repository.

## CI

`.github/workflows/registry.yml` runs on every push and pull request:

1. `pnpm run generate` validates metadata and writes `dist/plugins.json`.
2. `pnpm run validate` downloads all releases from the public distribution and
   verifies them.
3. `dist/plugins.json` is uploaded as a workflow artifact.

No secrets are required: the public index and ZIPs are credential-free.
