# Orahako plugin registry

Curated metadata and public distribution bytes for the official Orahako plugin
marketplace. The application reads this repository directly through GitHub Raw;
no EdgeOne function, website snapshot, or secondary CDN is involved.

Plugin source and build automation live in
[`Youwenqwq/orahako-official-plugins`](https://github.com/Youwenqwq/orahako-official-plugins).
This registry must be publicly readable for anonymous marketplace access. The
source repository should also be public if its `homepage` links are exposed in
the marketplace.

## Distribution contract

The committed `main` branch is the release channel:

```text
plugins/<plugin-id>.json             Curated display and release metadata
archived/<plugin-id>.json             Hidden plugin metadata excluded from the index
bundles.json                         Curated school bundles
dist/plugins.json                    Generated schema-v1 public index
dist/plugins/<id>/<version>.zip      Exact installable bytes
scripts/generate.mjs                 Regenerate dist/plugins.json offline
scripts/ingest.mjs                   Ingest a built ZIP and update metadata/index
scripts/validate-artifacts.mjs       Validate every committed ZIP offline
```

Public URLs are:

```text
index: https://raw.githubusercontent.com/Youwenqwq/orahako-plugin-registry/main/dist/plugins.json
ZIP:   https://raw.githubusercontent.com/Youwenqwq/orahako-plugin-registry/main/dist/plugins/<id>/<version>.zip
```

`zipUrl` is an absolute URL generated from the plugin ID and version. Index and
ZIPs deliberately share one repository and branch. GitHub Raw permits browser
cross-origin reads; GitHub Release asset downloads are not used because their
redirect target does not provide the CORS contract required by the Web PWA and
Capacitor WebView.

Moving metadata into `archived/` hides a plugin from the generated marketplace
index without deleting its immutable, already published ZIP assets.

The registry and every official plugin currently use **API v1**. The initial
plugin release line restarts at **1.0.0**; older EdgeOne packages and URLs are
not compatibility targets.

## Plugin metadata

Every `plugins/<id>.json` contains public display data, release entries, and
registry-internal bookkeeping. The generator strips `repository`, `sourcePath`,
and `order` from the public index while keeping `trust` (`official` or
`community`) so clients can distinguish official and community plugins.

Trust & repository rules:
- `trust: "official"` plugins must live in `Youwenqwq/orahako-official-plugins`
  with a `sourcePath` under `plugins/`. The `orahako.*` ID prefix is reserved
  exclusively for `official` plugins.
- `trust: "community"` plugins live in their author's own GitHub repository
  (`owner/repo`); `sourcePath` is optional.

Public plugin fields:

| Field | Notes |
| --- | --- |
| `id` | Lowercase DNS-like plugin ID; matches the file name |
| `name`, `summary`, `author` | Non-empty marketplace display strings |
| `trust` | `"official"` or `"community"` |
| `homepage` | Optional absolute HTTPS URL |
| `icon` | Optional safe package-relative path |
| `categories` | Non-empty string array |
| `versions` | Releases, newest first |

Release fields:

| Field | Notes |
| --- | --- |
| `version` | SemVer, exactly matching the ZIP manifest |
| `apiVersion` | Must be `1` |
| `minAppVersion` | Optional minimum app SemVer |
| `nativeCapabilities` | Optional unique versioned capability IDs |
| `inject`, `provides` | Optional unique root service names |
| `requires` | Optional plugin ID to SemVer range map |
| `platforms` | Non-empty subset of `web` and `android` |
| `zipUrl` | Exact GitHub Raw URL for `dist/plugins/<id>/<version>.zip` |
| `sha256`, `size` | Exact SHA-256 and byte size of the committed ZIP |
| `publishedAt` | ISO-8601 UTC timestamp |
| `changelog` | Optional non-empty release note |

`inject`, `provides`, `requires`, and `nativeCapabilities` must match the ZIP
manifest. The offline validator checks these fields as well as archive paths,
entry/style/icon presence, API version, plugin identity, size, and hash.

## Adding or updating a plugin

1. Build the plugin in `orahako-official-plugins`; its packer writes
   `artifacts/<id>-<version>.zip`.
2. In this repository, run `pnpm run ingest` with the built ZIP:

   ```bash
   # Updating an existing plugin
   pnpm run ingest ../orahako-official-plugins/artifacts/<id>-<version>.zip \
     --changelog "Release note"

   # Adding a new plugin (overrides optional when present in manifest.json)
   pnpm run ingest ../orahako-official-plugins/artifacts/<id>-<version>.zip \
     --source-path plugins/<dir> \
     --changelog "API v1 初始版本。"
   ```

   The command inspects the archive, copies the exact bytes to
   `dist/plugins/<id>/<version>.zip`, creates or updates `plugins/<id>.json`
   with the matching `apiVersion`, `zipUrl`, `sha256`, `size`, `publishedAt`,
   and manifest dependency fields, and regenerates `dist/plugins.json`. Pass
   `--dry-run` to preview changes without writing files.
3. Run `pnpm run validate` to verify every committed archive offline, then
   commit the source metadata, generated index, and versioned ZIP together.
4. Merge to `main`. GitHub Raw then serves the new index and assets directly.

A published `<id>@<version>` is immutable: never replace its ZIP or edit its
URL, hash, size, or publication timestamp. Bump the plugin version and add a new
path for changed code. The API-v1 restart uses a new GitHub URL namespace, so it
does not overwrite the former EdgeOne assets.

## Commands

Requires Node.js 20+ and pnpm:

```bash
pnpm install
pnpm run ingest <path/to/plugin.zip> [--changelog "..."]  # ingest ZIP, update metadata & index
pnpm run generate                                         # validate metadata and write dist/plugins.json
pnpm run validate                                         # verify committed ZIPs without network access
```

Generation is deterministic: plugin files are read in file-name order, sorted
by `order`, serialized with two-space JSON indentation and a trailing newline.
`updatedAt` is the latest release `publishedAt`, not the generation time.

## CI

`.github/workflows/registry.yml` installs dependencies, regenerates the index,
fails if `dist/plugins.json` differs from the committed file, and validates all
committed ZIPs offline. It also uploads the generated index as a workflow
artifact for inspection. No deployment credentials or cross-repository tokens
are required.
