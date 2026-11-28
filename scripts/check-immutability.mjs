import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DIST_DIR } from "./lib/registry.mjs"
import { reportError } from "./lib/rules.mjs"

const ROOT_DIR = path.resolve(DIST_DIR, "..")

const IMMUTABLE_RELEASE_FIELDS = [
  "version",
  "apiVersion",
  "minAppVersion",
  "platforms",
  "nativeCapabilities",
  "inject",
  "provides",
  "requires",
  "zipUrl",
  "sha256",
  "size",
  "publishedAt",
]

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function readJsonAtRef(ref, repoPath) {
  const raw = git(["show", `${ref}:${repoPath}`])
  return JSON.parse(raw)
}

function stableEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function main() {
  const baseRef = process.argv[2] || "origin/main"
  let mergeBase
  try {
    mergeBase = git(["merge-base", baseRef, "HEAD"])
  } catch (error) {
    throw new Error(
      `Unable to resolve merge-base against ${baseRef}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const failures = []

  // 1. Committed ZIP bytes under dist/plugins/ are immutable once published.
  const diffOutput = git([
    "diff",
    "--name-status",
    "--diff-filter=MDCR",
    mergeBase,
    "HEAD",
    "--",
    "dist/plugins/",
  ])
  if (diffOutput) {
    for (const line of diffOutput.split("\n")) {
      if (!line.trim()) continue
      failures.push(`Published archive cannot be modified or removed: ${line}`)
    }
  }

  // 2. Published release entries in dist/plugins.json cannot be mutated in place
  //    (archiving an entire plugin moves its metadata to archived/ and is allowed).
  const baseIndex = readJsonAtRef(mergeBase, "dist/plugins.json")
  const headIndex = JSON.parse(readFileSync(path.join(ROOT_DIR, "dist/plugins.json"), "utf8"))
  const headPlugins = new Map(headIndex.plugins.map((plugin) => [plugin.id, plugin]))

  for (const basePlugin of baseIndex.plugins) {
    const headPlugin = headPlugins.get(basePlugin.id)
    if (!headPlugin) continue
    const headVersions = new Map(headPlugin.versions.map((release) => [release.version, release]))
    for (const baseRelease of basePlugin.versions) {
      const label = `${basePlugin.id}@${baseRelease.version}`
      const headRelease = headVersions.get(baseRelease.version)
      if (!headRelease) {
        failures.push(`Published release was removed from index: ${label}`)
        continue
      }
      for (const field of IMMUTABLE_RELEASE_FIELDS) {
        if (!stableEqual(baseRelease[field], headRelease[field])) {
          failures.push(
            `Published release ${label} mutated immutable field "${field}" (${JSON.stringify(baseRelease[field])} -> ${JSON.stringify(headRelease[field])})`
          )
        }
      }
    }
  }

  if (failures.length > 0) {
    for (const message of failures) {
      console.error(`FAIL ${message}`)
    }
    throw new Error(
      `${failures.length} immutability violation(s) detected. Bump the plugin version instead of editing published releases.`
    )
  }

  console.log(`Immutability check passed against ${baseRef} (${mergeBase.slice(0, 7)})`)
}

try {
  main()
} catch (error) {
  reportError(error)
}
