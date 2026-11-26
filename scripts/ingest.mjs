import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { parseArgs } from "node:util"
import semver from "semver"
import { inspectArchive, verifyArchive } from "./lib/artifacts.mjs"
import {
  DIST_DIR,
  DIST_INDEX,
  PLUGINS_DIR,
  buildIndex,
  serializeJson,
} from "./lib/registry.mjs"
import {
  OFFICIAL_ID_PREFIX,
  OFFICIAL_REPOSITORY,
  PLATFORMS,
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  TRUST_LEVELS,
  expectedZipUrl,
  isNonEmptyString,
  isPlainObject,
  releaseArtifactPath,
  reportError,
} from "./lib/rules.mjs"

const USAGE = `Usage: pnpm run ingest <path/to/plugin.zip> [options]

Ingest a built API v1 plugin ZIP into the registry: copies the exact bytes to
dist/plugins/<id>/<version>.zip, updates or creates plugins/<id>.json from the
ZIP manifest, regenerates dist/plugins.json, and verifies the archive.

Options:
  --changelog <text>       Release note for this version
  --platforms <a,b>        Comma-separated platforms (default: previous release or web,android)
  --published-at <iso>     ISO-8601 UTC timestamp (default: current UTC time)
  --trust <level>          official | community (new plugin; inferred from repository/id)
  --repository <owner/repo> GitHub repository slug (new plugin; inferred from homepage or official repo)
  --name <text>            Display name (new plugin; default: manifest.name)
  --summary <text>         Short summary (new plugin; default: manifest.description)
  --author <text>          Author name (new plugin; default: manifest.author)
  --homepage <url>         HTTPS homepage URL (new plugin; default: manifest.homepage)
  --categories <a,b>       Comma-separated categories (new plugin; default: manifest.categories or kind)
  --source-path <path>     Source path inside repository (required for official; optional for community)
  --order <int>            Positive display order (new plugin; default: max order + 1)
  --dry-run                Validate and print planned changes without writing any files
  -h, --help               Show this help message
`

function parseCli(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv
  const { values, positionals } = parseArgs({
    args: normalized,
    allowPositionals: true,
    options: {
      changelog: { type: "string" },
      platforms: { type: "string" },
      "published-at": { type: "string" },
      trust: { type: "string" },
      repository: { type: "string" },
      name: { type: "string" },
      summary: { type: "string" },
      author: { type: "string" },
      homepage: { type: "string" },
      categories: { type: "string" },
      "source-path": { type: "string" },
      order: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  if (values.help) {
    console.log(USAGE)
    return null
  }
  if (positionals.length !== 1) {
    throw new Error(`Expected exactly one <zip-path> argument.\n\n${USAGE}`)
  }
  return { zipPath: path.resolve(positionals[0]), options: values }
}

function parseList(value, label) {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (items.length === 0) {
    throw new Error(`--${label} must contain at least one non-empty value`)
  }
  return items
}

function nowIsoUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}

function inferGitHubSource(homepage) {
  if (!isNonEmptyString(homepage)) return {}
  const match = homepage.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/tree\/[^/]+\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*))?\/?$/
  )
  if (!match) return {}
  return {
    repository: match[1],
    sourcePath: match[2],
  }
}

function nextPluginOrder() {
  let maxOrder = 0
  if (!fs.existsSync(PLUGINS_DIR)) return 1
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, entry.name), "utf8"))
      if (Number.isSafeInteger(parsed?.order) && parsed.order > maxOrder) {
        maxOrder = parsed.order
      }
    } catch {
      // Existing metadata issues will be surfaced by buildIndex().
    }
  }
  return maxOrder + 1
}

function buildReleaseEntry(manifest, { sha256, size, platforms, publishedAt, changelog }) {
  const release = {
    version: manifest.version,
    apiVersion: manifest.apiVersion,
  }
  if (isNonEmptyString(manifest.minAppVersion)) {
    release.minAppVersion = manifest.minAppVersion
  }
  if (Array.isArray(manifest.nativeCapabilities) && manifest.nativeCapabilities.length > 0) {
    release.nativeCapabilities = [...manifest.nativeCapabilities]
  }
  if (Array.isArray(manifest.inject) && manifest.inject.length > 0) {
    release.inject = [...manifest.inject]
  }
  if (Array.isArray(manifest.provides) && manifest.provides.length > 0) {
    release.provides = [...manifest.provides]
  }
  if (isPlainObject(manifest.requires) && Object.keys(manifest.requires).length > 0) {
    release.requires = { ...manifest.requires }
  }
  release.platforms = platforms
  release.zipUrl = expectedZipUrl(manifest.id, manifest.version)
  release.sha256 = sha256
  release.size = size
  release.publishedAt = publishedAt
  if (isNonEmptyString(changelog)) {
    release.changelog = changelog
  }
  return release
}

function buildNewPluginMetadata(manifest, release, options) {
  const name = options.name ?? manifest.name
  const summary = options.summary ?? manifest.description
  const author = options.author ?? manifest.author
  const homepage = options.homepage ?? manifest.homepage
  const categories = options.categories
    ? parseList(options.categories, "categories")
    : Array.isArray(manifest.categories) && manifest.categories.length > 0
      ? [...manifest.categories]
      : isNonEmptyString(manifest.kind)
        ? [manifest.kind]
        : undefined
  const inferred = inferGitHubSource(homepage)
  const inferredRepo = options.repository ?? inferred.repository
  const trust =
    options.trust ??
    (inferredRepo && inferredRepo !== OFFICIAL_REPOSITORY
      ? "community"
      : manifest.id.startsWith(OFFICIAL_ID_PREFIX) || inferredRepo === OFFICIAL_REPOSITORY
        ? "official"
        : "community")

  if (!TRUST_LEVELS.includes(trust)) {
    throw new Error(`--trust must be one of ${TRUST_LEVELS.join(", ")}`)
  }

  const repository = inferredRepo ?? (trust === "official" ? OFFICIAL_REPOSITORY : undefined)
  const sourcePath = options["source-path"] ?? inferred.sourcePath

  let order
  if (options.order !== undefined) {
    const parsed = Number(options.order)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("--order must be a positive integer")
    }
    order = parsed
  } else {
    order = nextPluginOrder()
  }

  const missing = []
  if (!isNonEmptyString(name)) missing.push("--name (or manifest.name)")
  if (!isNonEmptyString(summary)) missing.push("--summary (or manifest.description)")
  if (!isNonEmptyString(author)) missing.push("--author (or manifest.author)")
  if (!Array.isArray(categories) || categories.length === 0) {
    missing.push("--categories (or manifest.categories)")
  }
  if (!isNonEmptyString(repository)) {
    missing.push("--repository <owner/repo>")
  }
  if (trust === "official" && !isNonEmptyString(sourcePath)) {
    missing.push("--source-path (e.g. plugins/<dir>)")
  }
  if (missing.length > 0) {
    throw new Error(
      `New plugin ${manifest.id} is missing required metadata: ${missing.join(", ")}`
    )
  }

  return {
    id: manifest.id,
    name,
    summary,
    author,
    ...(isNonEmptyString(homepage) ? { homepage } : {}),
    ...(isNonEmptyString(manifest.icon) ? { icon: manifest.icon } : {}),
    categories,
    repository,
    ...(isNonEmptyString(sourcePath) ? { sourcePath } : {}),
    trust,
    order,
    versions: [release],
  }
}

function updateExistingPluginMetadata(existing, manifest, release) {
  if (existing.versions.some((entry) => entry.version === release.version)) {
    throw new Error(
      `Release ${manifest.id}@${release.version} already exists in plugins/${manifest.id}.json; published versions are immutable`
    )
  }
  const versions = [release, ...existing.versions].sort((left, right) =>
    semver.rcompare(left.version, right.version)
  )
  const updated = { ...existing, versions }
  if (isNonEmptyString(manifest.icon)) {
    updated.icon = manifest.icon
  }
  return updated
}

function main() {
  const parsed = parseCli(process.argv.slice(2))
  if (parsed === null) return
  const { zipPath, options } = parsed

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Archive not found: ${zipPath}`)
  }
  const bytes = fs.readFileSync(zipPath)
  const { manifest, sha256, size } = inspectArchive(bytes, path.basename(zipPath))

  if (!isNonEmptyString(manifest.id) || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    throw new Error(`Invalid manifest id: ${JSON.stringify(manifest.id)}`)
  }
  if (!isNonEmptyString(manifest.version) || !semver.valid(manifest.version)) {
    throw new Error(`Invalid manifest version: ${JSON.stringify(manifest.version)}`)
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `Unsupported manifest apiVersion ${JSON.stringify(manifest.apiVersion)} (expected ${PLUGIN_API_VERSION})`
    )
  }

  const artifactRelPath = releaseArtifactPath(manifest.id, manifest.version)
  const artifactDest = path.join(DIST_DIR, artifactRelPath)
  if (fs.existsSync(artifactDest)) {
    throw new Error(
      `Artifact already exists at dist/${artifactRelPath}; published versions are immutable`
    )
  }

  const pluginMetaPath = path.join(PLUGINS_DIR, `${manifest.id}.json`)
  const isNewPlugin = !fs.existsSync(pluginMetaPath)
  const existingMeta = isNewPlugin
    ? undefined
    : JSON.parse(fs.readFileSync(pluginMetaPath, "utf8"))

  const platforms = options.platforms
    ? parseList(options.platforms, "platforms")
    : Array.isArray(existingMeta?.versions?.[0]?.platforms) &&
        existingMeta.versions[0].platforms.length > 0
      ? [...existingMeta.versions[0].platforms]
      : [...PLATFORMS]

  const publishedAt = options["published-at"] ?? nowIsoUtc()
  const release = buildReleaseEntry(manifest, {
    sha256,
    size,
    platforms,
    publishedAt,
    changelog: options.changelog,
  })

  const nextMeta = isNewPlugin
    ? buildNewPluginMetadata(manifest, release, options)
    : updateExistingPluginMetadata(existingMeta, manifest, release)

  verifyArchive(bytes, nextMeta, release)

  if (options["dry-run"]) {
    console.log(`[dry-run] ${isNewPlugin ? "Create" : "Update"} plugins/${manifest.id}.json`)
    console.log(`[dry-run] Copy archive -> dist/${artifactRelPath} (${size} bytes, sha256 ${sha256})`)
    console.log(serializeJson(nextMeta))
    return
  }

  const previousMetaText = isNewPlugin ? undefined : fs.readFileSync(pluginMetaPath, "utf8")
  fs.mkdirSync(path.dirname(artifactDest), { recursive: true })
  fs.writeFileSync(artifactDest, bytes)
  fs.mkdirSync(PLUGINS_DIR, { recursive: true })
  fs.writeFileSync(pluginMetaPath, serializeJson(nextMeta))

  try {
    const index = buildIndex()
    fs.mkdirSync(DIST_DIR, { recursive: true })
    fs.writeFileSync(DIST_INDEX, serializeJson(index))
    console.log(
      `Ingested ${manifest.id}@${manifest.version} (${isNewPlugin ? "new plugin" : "new release"})`
    )
    console.log(`  artifact: dist/${artifactRelPath} (${size} bytes)`)
    console.log(`  sha256:   ${sha256}`)
    console.log(`  metadata: plugins/${manifest.id}.json`)
    console.log(`  index:    dist/plugins.json (updatedAt ${index.updatedAt})`)
  } catch (error) {
    // Roll back written files so invalid metadata never leaves a partial state.
    fs.rmSync(artifactDest, { force: true })
    if (previousMetaText === undefined) {
      fs.rmSync(pluginMetaPath, { force: true })
    } else {
      fs.writeFileSync(pluginMetaPath, previousMetaText)
    }
    throw error
  }
}

try {
  main()
} catch (error) {
  reportError(error)
}
