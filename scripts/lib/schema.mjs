import semver from "semver"
import {
  PLATFORMS,
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  RegistryError,
  SCHEMA_VERSION,
  SHA256_PATTERN,
  TRUST_LEVELS,
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

const INDEX_FIELDS = new Set(["schemaVersion", "updatedAt", "plugins", "bundles"])
const PLUGIN_FIELDS = new Set([
  "id",
  "name",
  "summary",
  "author",
  "trust",
  "homepage",
  "icon",
  "categories",
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

/**
 * Validate a marketplace index against schemaVersion 1 of the public contract.
 *
 * Internal registry fields (`repository`, `sourcePath`, `trust`, `order`) are
 * rejected because the published index must only contain display and release
 * data understood by the client.
 */
export function validatePublicIndex(input) {
  const issues = []
  if (!isPlainObject(input)) throw new RegistryError(["index: must be a JSON object"])

  for (const key of Object.keys(input)) {
    if (!INDEX_FIELDS.has(key)) issues.push(`index: unknown field "${key}"`)
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    issues.push(`index: schemaVersion must be ${SCHEMA_VERSION}`)
  }
  if (!isIsoTimestamp(input.updatedAt)) {
    issues.push("index: updatedAt must be an ISO-8601 UTC timestamp")
  }

  if (!Array.isArray(input.plugins)) {
    issues.push("index: plugins must be an array")
  } else if (input.plugins.length === 0) {
    issues.push("index: plugins must not be empty")
  } else {
    const ids = new Set()
    input.plugins.forEach((plugin, pluginIndex) => {
      validatePlugin(plugin, `index: plugins[${pluginIndex}]`, ids, issues)
    })
  }

  if (input.bundles !== undefined) validateBundles(input.bundles, issues)

  if (issues.length > 0) throw new RegistryError(issues)
  return input
}

function validatePlugin(plugin, where, ids, issues) {
  if (!isPlainObject(plugin)) {
    issues.push(`${where}: must be an object`)
    return
  }
  const label = isNonEmptyString(plugin.id) ? `${where} (${plugin.id})` : where
  for (const key of Object.keys(plugin)) {
    if (!PLUGIN_FIELDS.has(key)) issues.push(`${label}: unknown field "${key}"`)
  }

  if (!isNonEmptyString(plugin.id) || !PLUGIN_ID_PATTERN.test(plugin.id)) {
    issues.push(`${label}: id must be lowercase DNS-like labels separated by dots`)
  } else if (ids.has(plugin.id)) {
    issues.push(`${label}: duplicate plugin id ${plugin.id}`)
  } else {
    ids.add(plugin.id)
  }

  for (const field of ["name", "summary", "author"]) {
    if (!isNonEmptyString(plugin[field])) {
      issues.push(`${label}: ${field} must be a non-empty string`)
    }
  }
  if (!TRUST_LEVELS.includes(plugin.trust)) {
    issues.push(`${label}: trust must be one of ${TRUST_LEVELS.join(", ")}`)
  }
  if (plugin.homepage !== undefined && !isHttpsUrl(plugin.homepage)) {
    issues.push(`${label}: homepage must be an absolute https URL`)
  }
  if (plugin.icon !== undefined && !isSafePackagePath(plugin.icon)) {
    issues.push(`${label}: icon must be a safe package-relative path`)
  }
  if (!Array.isArray(plugin.categories) || plugin.categories.length === 0) {
    issues.push(`${label}: categories must be a non-empty array`)
  } else if (plugin.categories.some((category) => !isNonEmptyString(category))) {
    issues.push(`${label}: categories must contain non-empty strings`)
  }

  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
    issues.push(`${label}: versions must be a non-empty array`)
    return
  }
  const versions = new Set()
  plugin.versions.forEach((release, releaseIndex) => {
    validateRelease(release, `${label}: versions[${releaseIndex}]`, plugin.id, versions, issues)
  })
}

function validateRelease(release, where, pluginId, versions, issues) {
  if (!isPlainObject(release)) {
    issues.push(`${where}: must be an object`)
    return
  }
  for (const key of Object.keys(release)) {
    if (!RELEASE_FIELDS.has(key)) issues.push(`${where}: unknown field "${key}"`)
  }

  if (!isNonEmptyString(release.version) || !semver.valid(release.version)) {
    issues.push(`${where}: version must be a valid SemVer`)
  } else if (versions.has(release.version)) {
    issues.push(`${where}: duplicate release version ${release.version}`)
  } else {
    versions.add(release.version)
  }
  if (release.apiVersion !== PLUGIN_API_VERSION) {
    issues.push(`${where}: apiVersion must be ${PLUGIN_API_VERSION}`)
  }
  if (release.minAppVersion !== undefined && !semver.valid(release.minAppVersion)) {
    issues.push(`${where}: minAppVersion must be a valid SemVer when present`)
  }
  if (release.nativeCapabilities !== undefined) {
    if (
      !Array.isArray(release.nativeCapabilities) ||
      release.nativeCapabilities.length === 0
    ) {
      issues.push(`${where}: nativeCapabilities must be a non-empty array when present`)
    } else if (
      release.nativeCapabilities.some((capability) => !isNativeCapabilityId(capability)) ||
      new Set(release.nativeCapabilities).size !== release.nativeCapabilities.length
    ) {
      issues.push(
        `${where}: nativeCapabilities must be unique versioned capability ids such as native.geolocation@1`
      )
    }
  }
  if (release.inject !== undefined) {
    validateServiceNameList(release.inject, "inject", where, issues)
  }
  if (release.provides !== undefined) {
    validateServiceNameList(release.provides, "provides", where, issues)
  }
  if (release.requires !== undefined) {
    validatePluginDependencies(release.requires, pluginId, where, issues)
  }
  if (!Array.isArray(release.platforms) || release.platforms.length === 0) {
    issues.push(`${where}: platforms must be a non-empty array`)
  } else if (
    release.platforms.some((platform) => !PLATFORMS.includes(platform)) ||
    new Set(release.platforms).size !== release.platforms.length
  ) {
    issues.push(`${where}: platforms must be unique values from ${PLATFORMS.join(", ")}`)
  }
  if (!isNonEmptyString(release.zipUrl) || !isHttpsUrl(release.zipUrl)) {
    issues.push(`${where}: zipUrl must be an absolute https URL`)
  }
  if (!isNonEmptyString(release.sha256) || !SHA256_PATTERN.test(release.sha256)) {
    issues.push(`${where}: sha256 must be a lowercase hex digest`)
  }
  if (!isPositiveInteger(release.size)) {
    issues.push(`${where}: size must be a positive integer`)
  }
  if (!isIsoTimestamp(release.publishedAt)) {
    issues.push(`${where}: publishedAt must be an ISO-8601 UTC timestamp`)
  }
  if (release.changelog !== undefined && !isNonEmptyString(release.changelog)) {
    issues.push(`${where}: changelog must be a non-empty string when present`)
  }

  if (isNonEmptyString(pluginId) && isNonEmptyString(release.version)) {
    const expected = expectedZipUrl(pluginId, release.version)
    if (release.zipUrl !== expected) issues.push(`${where}: zipUrl must be ${expected}`)
  }
}

function validateBundles(bundles, issues) {
  if (!Array.isArray(bundles)) {
    issues.push("index: bundles must be an array when present")
    return
  }
  const ids = new Set()
  bundles.forEach((bundle, bundleIndex) => {
    const where = `index: bundles[${bundleIndex}]`
    if (!isPlainObject(bundle)) {
      issues.push(`${where}: must be an object`)
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
    if (isNonEmptyString(bundle.id)) {
      if (ids.has(bundle.id)) issues.push(`${where}: duplicate bundle id ${bundle.id}`)
      ids.add(bundle.id)
    }
    if (!Array.isArray(bundle.pluginIds)) {
      issues.push(`${where}: pluginIds must be an array`)
      return
    }
    const pluginIds = new Set()
    for (const pluginId of bundle.pluginIds) {
      if (!isNonEmptyString(pluginId) || !PLUGIN_ID_PATTERN.test(pluginId)) {
        issues.push(`${where}: pluginIds must contain valid plugin IDs`)
        continue
      }
      if (pluginIds.has(pluginId)) {
        issues.push(`${where}: duplicate plugin id ${pluginId}`)
        continue
      }
      pluginIds.add(pluginId)
    }
  })
}
