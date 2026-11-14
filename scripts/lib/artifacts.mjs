import crypto from "node:crypto"
import { unzipSync } from "fflate"
import semver from "semver"
import { isNonEmptyString, isPlainObject, isSafePackagePath } from "./rules.mjs"

export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_FILES = 512
const MAX_MANIFEST_BYTES = 64 * 1024

/**
 * Verify a downloaded plugin archive against its curated release metadata.
 *
 * Mirrors the client installer checks: exact size and SHA-256, safe archive
 * paths, no duplicates, manifest id/version/apiVersion/minAppVersion, and the
 * declared entry, styles and icon files.
 */
export function verifyArchive(bytes, plugin, release) {
  const label = `${plugin.id}@${release.version}`

  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`${label}: archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
  }
  if (bytes.byteLength !== release.size) {
    throw new Error(
      `${label}: size mismatch (registry ${release.size}, downloaded ${bytes.byteLength})`
    )
  }

  const digest = crypto.createHash("sha256").update(bytes).digest("hex")
  if (digest !== release.sha256) {
    throw new Error(`${label}: sha256 mismatch (registry ${release.sha256}, downloaded ${digest})`)
  }

  const files = extractArchive(bytes, label)
  const manifestFile = files.get("manifest.json")
  if (manifestFile === undefined) {
    throw new Error(`${label}: archive is missing manifest.json`)
  }
  const manifest = parseManifest(manifestFile, label)
  verifyManifest(manifest, plugin, release, files, label)
}

function extractArchive(bytes, label) {
  const seen = new Set()
  let declaredTotal = 0
  let entries
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        if (file.name.endsWith("/")) return false
        if (!isSafePackagePath(file.name)) {
          throw new Error(`unsafe archive path: ${file.name}`)
        }
        if (seen.has(file.name)) {
          throw new Error(`duplicate archive path: ${file.name}`)
        }
        seen.add(file.name)
        if (seen.size > MAX_FILES) {
          throw new Error(`archive contains more than ${MAX_FILES} files`)
        }
        declaredTotal += file.originalSize
        if (declaredTotal > MAX_TOTAL_BYTES) {
          throw new Error(`archive expands beyond ${MAX_TOTAL_BYTES} bytes`)
        }
        return true
      },
    })
  } catch (error) {
    throw new Error(
      `${label}: invalid ZIP (${error instanceof Error ? error.message : String(error)})`
    )
  }

  const files = new Map(Object.entries(entries))
  let actualTotal = 0
  for (const [filePath, data] of files) {
    if (!isSafePackagePath(filePath)) {
      throw new Error(`${label}: unsafe archive path: ${filePath}`)
    }
    actualTotal += data.byteLength
  }
  if (actualTotal > MAX_TOTAL_BYTES) {
    throw new Error(`${label}: archive expands beyond ${MAX_TOTAL_BYTES} bytes`)
  }
  return files
}

function parseManifest(data, label) {
  if (data.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`${label}: manifest.json exceeds ${MAX_MANIFEST_BYTES} bytes`)
  }
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data)
  } catch {
    throw new Error(`${label}: manifest.json is not valid UTF-8`)
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error(`${label}: manifest.json is not valid JSON`)
  }
  if (!isPlainObject(manifest)) throw new Error(`${label}: manifest.json must be a JSON object`)
  return manifest
}

function requireManifestFile(manifest, field, files, label) {
  const filePath = manifest[field]
  if (!isNonEmptyString(filePath) || !isSafePackagePath(filePath)) {
    throw new Error(`${label}: manifest ${field} must be a safe package-relative path`)
  }
  if (!files.has(filePath)) {
    throw new Error(`${label}: manifest ${field} is missing from the archive: ${filePath}`)
  }
}

function verifyManifest(manifest, plugin, release, files, label) {
  if (manifest.id !== plugin.id) {
    throw new Error(
      `${label}: manifest id ${JSON.stringify(manifest.id)} does not match ${plugin.id}`
    )
  }
  if (manifest.version !== release.version) {
    throw new Error(
      `${label}: manifest version ${JSON.stringify(manifest.version)} does not match ${release.version}`
    )
  }
  if (manifest.apiVersion !== release.apiVersion) {
    throw new Error(
      `${label}: manifest apiVersion ${JSON.stringify(manifest.apiVersion)} does not match ${release.apiVersion}`
    )
  }

  if (manifest.minAppVersion !== undefined && !semver.valid(manifest.minAppVersion)) {
    throw new Error(`${label}: manifest minAppVersion must be a valid SemVer`)
  }
  if (release.minAppVersion !== undefined && manifest.minAppVersion !== release.minAppVersion) {
    throw new Error(
      `${label}: manifest minAppVersion ${JSON.stringify(manifest.minAppVersion)} does not match registry ${release.minAppVersion}`
    )
  }

  requireManifestFile(manifest, "entry", files, label)

  if (manifest.styles !== undefined) {
    if (!Array.isArray(manifest.styles)) {
      throw new Error(`${label}: manifest styles must be an array`)
    }
    for (const style of manifest.styles) {
      if (!isNonEmptyString(style) || !isSafePackagePath(style)) {
        throw new Error(`${label}: manifest styles must contain safe package-relative paths`)
      }
      if (!files.has(style)) {
        throw new Error(`${label}: manifest style is missing from the archive: ${style}`)
      }
    }
  }

  if (manifest.icon !== undefined) {
    requireManifestFile(manifest, "icon", files, label)
  }
}
