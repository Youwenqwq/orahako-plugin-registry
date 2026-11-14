/**
 * Shared schema constants and predicates for the Orahako plugin registry.
 *
 * The public index shape mirrors `packages/plugin-sdk/market.ts` in
 * Youwenqwq/ysu-client. Package path rules mirror
 * `lib/plugins/package-path.ts` so archives accepted here are also accepted
 * by the client installer.
 */

export const SCHEMA_VERSION = 1
export const REPOSITORY = "Youwenqwq/orahako-official-plugins"
export const TRUST = "official"
export const PLATFORMS = ["web", "android"]

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/
export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
export const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const ROOT_RELATIVE_ZIP_URL_PATTERN = /^\/plugins\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.zip$/

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
