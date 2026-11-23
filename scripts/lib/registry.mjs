import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import semver from "semver"
import {
  PLATFORMS,
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  REPOSITORY,
  RegistryError,
  SCHEMA_VERSION,
  SHA256_PATTERN,
  TRUST,
  isHttpsUrl,
  isIsoTimestamp,
  isNativeCapabilityId,
  isNonEmptyString,
  isPlainObject,
  isPositiveInteger,
  isSafePackagePath,
  expectedZipUrl,
  validatePluginDependencies,
  validateServiceNameList,
} from "./rules.mjs"
import { validatePublicIndex } from "./schema.mjs"

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
export const PLUGINS_DIR = path.join(REPO_ROOT, "plugins")
export const BUNDLES_FILE = path.join(REPO_ROOT, "bundles.json")
export const DIST_DIR = path.join(REPO_ROOT, "dist")
export const DIST_INDEX = path.join(DIST_DIR, "plugins.json")

const PLUGIN_FIELDS = new Set([
  "id",
  "name",
  "summary",
  "author",
  "homepage",
  "icon",
  "categories",
  "repository",
  "sourcePath",
  "trust",
  "order",
  "versions",
])
const RELEASE_FIELDS = new Set([
  "version",
  "apiVersion",
  "minAppVersion",
  "nativeCapabilities",
  "inject",
  "provides",
  "requires",
  "platforms",
  "zipUrl",
  "sha256",
  "size",
  "publishedAt",
  "changelog",
])
const BUNDLE_FIELDS = new Set(["id", "name", "schoolId", "pluginIds"])

/** Serialize JSON with the registry's canonical two-space formatting. */
export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Read every `plugins/*.json` file and `bundles.json`, validate the curated
 * metadata, and return the public schemaVersion 1 marketplace index.
 *
 * Internal registry fields are intentionally dropped here: the result only
 * contains fields declared by `packages/core/sdk/src/market.ts`.
 */
export function buildIndex() {
  const issues = []
  const plugins = loadPlugins(issues)
  const bundles = loadBundles(issues)

  const orders = new Set()
  const ids = new Set()
  for (const { order, plugin } of plugins) {
    if (orders.has(order)) issues.push(`plugins: duplicate order ${order}`)
    orders.add(order)
    if (ids.has(plugin.id)) issues.push(`plugins: duplicate plugin id ${plugin.id}`)
    ids.add(plugin.id)
  }
  plugins.sort((left, right) => left.order - right.order)

  let updatedAt
  for (const { plugin } of plugins) {
    for (const release of plugin.versions) {
      if (updatedAt === undefined || release.publishedAt > updatedAt) {
        updatedAt = release.publishedAt
      }
    }
  }
  if (updatedAt === undefined) issues.push("plugins: registry must publish at least one release")

  if (issues.length > 0) throw new RegistryError(issues)

  const index = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt,
    plugins: plugins.map(({ plugin }) => plugin),
  }
  if (bundles.length > 0) index.bundles = bundles

  return validatePublicIndex(index)
}

function readJsonFile(file, label, issues) {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (error) {
    issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    issues.push(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

function loadPlugins(issues) {
  let entries
  try {
    entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
  } catch (error) {
    issues.push(`plugins: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
  if (files.length === 0) issues.push("plugins: no *.json plugin metadata files found")

  const plugins = []
  for (const fileName of files) {
    const file = path.join(PLUGINS_DIR, fileName)
    const raw = readJsonFile(file, `plugins/${fileName}`, issues)
    if (raw === undefined) continue
    const parsed = validatePluginMetadata(raw, fileName, issues)
    if (parsed !== undefined) plugins.push(parsed)
  }
  return plugins
}

function validatePluginMetadata(raw, fileName, issues) {
  const where = `plugins/${fileName}`
  const start = issues.length
  if (!isPlainObject(raw)) {
    issues.push(`${where}: plugin metadata must be a JSON object`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!PLUGIN_FIELDS.has(key)) issues.push(`${where}: unknown field "${key}"`)
  }

  const { id } = raw
  if (!isNonEmptyString(id)) {
    issues.push(`${where}: id must be a non-empty string`)
  } else if (!PLUGIN_ID_PATTERN.test(id)) {
    issues.push(`${where}: id must be lowercase DNS-like labels separated by dots`)
  } else if (fileName !== `${id}.json`) {
    issues.push(`${where}: file name must be ${id}.json`)
  }

  for (const field of ["name", "summary", "author"]) {
    if (!isNonEmptyString(raw[field])) {
      issues.push(`${where}: ${field} must be a non-empty string`)
    }
  }
  if (raw.homepage !== undefined && !isHttpsUrl(raw.homepage)) {
    issues.push(`${where}: homepage must be an absolute https URL`)
  }
  if (raw.icon !== undefined && !isSafePackagePath(raw.icon)) {
    issues.push(`${where}: icon must be a safe package-relative path`)
  }
  if (!Array.isArray(raw.categories) || raw.categories.length === 0) {
    issues.push(`${where}: categories must be a non-empty array`)
  } else if (raw.categories.some((category) => !isNonEmptyString(category))) {
    issues.push(`${where}: categories must contain non-empty strings`)
  }
  if (raw.repository !== REPOSITORY) {
    issues.push(`${where}: repository must be "${REPOSITORY}"`)
  }
  if (
    !isNonEmptyString(raw.sourcePath) ||
    !isSafePackagePath(raw.sourcePath) ||
    !raw.sourcePath.startsWith("plugins/")
  ) {
    issues.push(`${where}: sourcePath must be a safe path under plugins/`)
  }
  if (raw.trust !== TRUST) issues.push(`${where}: trust must be "${TRUST}"`)
  if (!isPositiveInteger(raw.order)) issues.push(`${where}: order must be a positive integer`)

  if (!Array.isArray(raw.versions) || raw.versions.length === 0) {
    issues.push(`${where}: versions must be a non-empty array`)
    return undefined
  }

  const releases = []
  raw.versions.forEach((release, index) => {
    const validated = validateReleaseMetadata(
      release,
      id,
      `${where}: versions[${index}]`,
      issues
    )
    if (validated !== undefined) releases.push(validated)
  })
  if (releases.length !== raw.versions.length) return undefined

  const versions = new Set()
  let previous
  for (const release of releases) {
    if (versions.has(release.version)) {
      issues.push(`${where}: duplicate release version ${release.version}`)
    }
    versions.add(release.version)
    if (previous !== undefined && semver.rcompare(previous, release.version) >= 0) {
      issues.push(
        `${where}: releases must be ordered newest first (${release.version} follows ${previous})`
      )
    }
    previous = release.version
  }

  if (issues.length > start) return undefined

  const plugin = {
    id: raw.id,
    name: raw.name,
    summary: raw.summary,
    author: raw.author,
    ...(raw.homepage !== undefined ? { homepage: raw.homepage } : {}),
    ...(raw.icon !== undefined ? { icon: raw.icon } : {}),
    categories: [...raw.categories],
    versions: releases,
  }
  return { order: raw.order, plugin }
}

function validateReleaseMetadata(raw, pluginId, where, issues) {
  const start = issues.length
  if (!isPlainObject(raw)) {
    issues.push(`${where}: release must be a JSON object`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!RELEASE_FIELDS.has(key)) issues.push(`${where}: unknown field "${key}"`)
  }

  const version = raw.version
  if (!isNonEmptyString(version) || !semver.valid(version)) {
    issues.push(`${where}: version must be a valid SemVer`)
  }
  if (raw.apiVersion !== PLUGIN_API_VERSION) {
    issues.push(`${where}: apiVersion must be ${PLUGIN_API_VERSION}`)
  }

  let minAppVersion
  if (raw.minAppVersion !== undefined) {
    if (!isNonEmptyString(raw.minAppVersion) || !semver.valid(raw.minAppVersion)) {
      issues.push(`${where}: minAppVersion must be a valid SemVer when present`)
    } else {
      minAppVersion = raw.minAppVersion
    }
  }

  let nativeCapabilities
  if (raw.nativeCapabilities !== undefined) {
    if (!Array.isArray(raw.nativeCapabilities) || raw.nativeCapabilities.length === 0) {
      issues.push(`${where}: nativeCapabilities must be a non-empty array when present`)
    } else {
      const seen = new Set()
      let valid = true
      for (const capability of raw.nativeCapabilities) {
        if (!isNativeCapabilityId(capability)) {
          issues.push(
            `${where}: nativeCapabilities must contain versioned capability ids such as native.geolocation@1`
          )
          valid = false
        } else if (seen.has(capability)) {
          issues.push(`${where}: duplicate native capability "${capability}"`)
          valid = false
        } else {
          seen.add(capability)
        }
      }
      if (valid) nativeCapabilities = [...raw.nativeCapabilities]
    }
  }

  let inject
  if (raw.inject !== undefined) {
    inject = validateServiceNameList(raw.inject, "inject", where, issues)
  }

  let provides
  if (raw.provides !== undefined) {
    provides = validateServiceNameList(raw.provides, "provides", where, issues)
  }

  let requires
  if (raw.requires !== undefined) {
    requires = validatePluginDependencies(raw.requires, pluginId, where, issues)
  }

  let platforms
  if (!Array.isArray(raw.platforms) || raw.platforms.length === 0) {
    issues.push(`${where}: platforms must be a non-empty array`)
  } else {
    const seen = new Set()
    let valid = true
    for (const platform of raw.platforms) {
      if (!PLATFORMS.includes(platform)) {
        issues.push(`${where}: unsupported platform "${platform}"`)
        valid = false
      } else if (seen.has(platform)) {
        issues.push(`${where}: duplicate platform "${platform}"`)
        valid = false
      } else {
        seen.add(platform)
      }
    }
    if (valid) platforms = [...raw.platforms]
  }

  let zipUrl
  if (!isNonEmptyString(raw.zipUrl)) {
    issues.push(`${where}: zipUrl must be a non-empty string`)
  } else {
    const expected =
      isNonEmptyString(pluginId) && isNonEmptyString(version)
        ? expectedZipUrl(pluginId, version)
        : undefined
    if (expected !== undefined && raw.zipUrl !== expected) {
      issues.push(`${where}: zipUrl must be ${expected}`)
    }
    zipUrl = raw.zipUrl
  }

  let sha256
  if (!isNonEmptyString(raw.sha256) || !SHA256_PATTERN.test(raw.sha256)) {
    issues.push(`${where}: sha256 must be a lowercase hex digest`)
  } else {
    sha256 = raw.sha256
  }

  let size
  if (!isPositiveInteger(raw.size)) {
    issues.push(`${where}: size must be a positive integer`)
  } else {
    size = raw.size
  }

  let publishedAt
  if (!isIsoTimestamp(raw.publishedAt)) {
    issues.push(`${where}: publishedAt must be an ISO-8601 UTC timestamp`)
  } else {
    publishedAt = raw.publishedAt
  }

  let changelog
  if (raw.changelog !== undefined) {
    if (!isNonEmptyString(raw.changelog)) {
      issues.push(`${where}: changelog must be a non-empty string when present`)
    } else {
      changelog = raw.changelog
    }
  }

  if (issues.length > start) return undefined

  return {
    version,
    apiVersion: PLUGIN_API_VERSION,
    ...(minAppVersion !== undefined ? { minAppVersion } : {}),
    ...(nativeCapabilities !== undefined ? { nativeCapabilities } : {}),
    ...(inject !== undefined ? { inject } : {}),
    ...(provides !== undefined ? { provides } : {}),
    ...(requires !== undefined ? { requires } : {}),
    platforms,
    zipUrl,
    sha256,
    size,
    publishedAt,
    ...(changelog !== undefined ? { changelog } : {}),
  }
}

function loadBundles(issues) {
  const raw = readJsonFile(BUNDLES_FILE, "bundles.json", issues)
  if (raw === undefined) return []
  if (!isPlainObject(raw)) {
    issues.push("bundles.json: must be a JSON object")
    return []
  }
  for (const key of Object.keys(raw)) {
    if (key !== "bundles") issues.push(`bundles.json: unknown field "${key}"`)
  }
  if (!Array.isArray(raw.bundles)) {
    issues.push("bundles.json: bundles must be an array")
    return []
  }

  const ids = new Set()
  const bundles = []
  raw.bundles.forEach((bundle, index) => {
    const where = `bundles.json: bundles[${index}]`
    const start = issues.length
    if (!isPlainObject(bundle)) {
      issues.push(`${where}: must be a JSON object`)
      return
    }
    for (const key of Object.keys(bundle)) {
      if (!BUNDLE_FIELDS.has(key)) issues.push(`${where}: unknown field "${key}"`)
    }
    for (const field of ["id", "name", "schoolId"]) {
      if (!isNonEmptyString(bundle[field])) {
        issues.push(`${where}: ${field} must be a non-empty string`)
      }
    }

    let pluginIds
    if (!Array.isArray(bundle.pluginIds)) {
      issues.push(`${where}: pluginIds must be an array`)
    } else {
      const seen = new Set()
      let valid = true
      for (const pluginId of bundle.pluginIds) {
        if (!isNonEmptyString(pluginId) || !PLUGIN_ID_PATTERN.test(pluginId)) {
          issues.push(`${where}: pluginIds must contain valid plugin IDs`)
          valid = false
        } else if (seen.has(pluginId)) {
          issues.push(`${where}: duplicate plugin id ${pluginId}`)
          valid = false
        } else {
          seen.add(pluginId)
        }
      }
      if (valid) pluginIds = [...bundle.pluginIds]
    }

    if (issues.length > start) return
    if (ids.has(bundle.id)) {
      issues.push(`${where}: duplicate bundle id ${bundle.id}`)
      return
    }
    ids.add(bundle.id)
    bundles.push({
      id: bundle.id,
      name: bundle.name,
      schoolId: bundle.schoolId,
      pluginIds,
    })
  })
  return bundles
}
