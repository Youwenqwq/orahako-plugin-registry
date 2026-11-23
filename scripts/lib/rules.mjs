import semver from "semver"

/**
 * Shared schema constants and predicates for the Orahako plugin registry.
 *
 * The public index shape mirrors `packages/core/sdk/src/market.ts` in
 * Youwenqwq/ysu-client. Package path rules mirror the client kernel so
 * archives accepted here are also accepted by the installer.
 */

export const SCHEMA_VERSION = 1
export const PLUGIN_API_VERSION = 1
export const REPOSITORY = "Youwenqwq/orahako-official-plugins"
export const TRUST = "official"
export const PLATFORMS = ["web", "android"]
export const DISTRIBUTION_BASE_URL =
  "https://raw.githubusercontent.com/Youwenqwq/orahako-plugin-registry/main/dist"
export const MARKET_INDEX_URL = `${DISTRIBUTION_BASE_URL}/plugins.json`

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/
export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
export const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function releaseArtifactPath(pluginId, version) {
  return `plugins/${pluginId}/${version}.zip`
}

export function expectedZipUrl(pluginId, version) {
  return `${DISTRIBUTION_BASE_URL}/${releaseArtifactPath(pluginId, version)}`
}
/**
 * Versioned runtime capability references such as `native.geolocation@1`.
 * The id uses lowercase DNS-like labels; the version is a positive integer.
 * Mirrors the `id@version` references accepted by `lib/native/native-plugin.ts`.
 */
export const NATIVE_CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*@[1-9][0-9]*$/

const MAX_PACKAGE_PATH_LENGTH = 255
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

export class RegistryError extends Error {
  constructor(issues) {
    super(`Registry metadata is invalid:\n${issues.join("\n")}`)
    this.name = "RegistryError"
    this.issues = issues
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A capability reference is a dotted id followed by `@<positive integer>`. */
export function isNativeCapabilityId(value) {
  return typeof value === "string" && NATIVE_CAPABILITY_PATTERN.test(value)
}

/**
 * Validate an optional root-service list (`inject` or `provides`).
 *
 * Returns a copy of the list when every entry is a unique non-empty service
 * name; otherwise records issues and returns `undefined`.
 */
export function validateServiceNameList(value, field, where, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${where}: ${field} must be a non-empty array when present`)
    return undefined
  }
  const seen = new Set()
  let valid = true
  for (const name of value) {
    if (!isNonEmptyString(name)) {
      issues.push(`${where}: ${field} must contain non-empty service names`)
      valid = false
    } else if (seen.has(name)) {
      issues.push(`${where}: duplicate ${field} service "${name}"`)
      valid = false
    } else {
      seen.add(name)
    }
  }
  return valid ? [...value] : undefined
}

/**
 * Validate an optional `requires` map of plugin IDs to SemVer ranges.
 *
 * Returns a copy of the map when every key is a plugin ID other than the
 * release's own plugin and every value is a valid SemVer range; otherwise
 * records issues and returns `undefined`.
 */
export function validatePluginDependencies(value, pluginId, where, issues) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    issues.push(`${where}: requires must be a non-empty object when present`)
    return undefined
  }
  let valid = true
  for (const [id, range] of Object.entries(value)) {
    if (!PLUGIN_ID_PATTERN.test(id)) {
      issues.push(`${where}: requires keys must be plugin IDs`)
      valid = false
    } else if (id === pluginId) {
      issues.push(`${where}: plugin must not require itself`)
      valid = false
    }
    if (!isNonEmptyString(range) || semver.validRange(range) === null) {
      issues.push(`${where}: requires["${id}"] must be a valid SemVer range`)
      valid = false
    }
  }
  return valid ? { ...value } : undefined
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
}

/** A package-relative path is safe when every segment is a plain file name. */
export function isSafePackagePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PACKAGE_PATH_LENGTH
  ) {
    return false
  }
  if (!SAFE_PATH.test(value)) return false
  return value.split("/").every((segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment))
}

export function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

export function isHttpsUrl(value) {
  if (typeof value !== "string" || /\s/.test(value) || !value.startsWith("https://")) return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

export function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/** Print registry validation issues and mark a non-zero exit code. */
export function reportError(error) {
  if (error instanceof RegistryError) {
    for (const issue of error.issues) console.error(`error: ${issue}`)
    process.exitCode = 1
    return
  }
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
