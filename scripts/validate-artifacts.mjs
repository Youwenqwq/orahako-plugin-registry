import { readFile } from "node:fs/promises"
import path from "node:path"
import { verifyArchive } from "./lib/artifacts.mjs"
import { DIST_DIR, buildIndex } from "./lib/registry.mjs"
import { releaseArtifactPath, reportError } from "./lib/rules.mjs"

async function main() {
  const index = buildIndex()
  const releases = index.plugins.flatMap((plugin) =>
    plugin.versions.map((release) => ({ plugin, release }))
  )
  console.log(`Validating ${releases.length} committed artifacts`)

  let failures = 0
  for (const { plugin, release } of releases) {
    const label = `${plugin.id}@${release.version}`
    const relativePath = releaseArtifactPath(plugin.id, release.version)
    try {
      const bytes = await readFile(path.join(DIST_DIR, relativePath))
      verifyArchive(bytes, plugin, release)
      console.log(`ok ${label} -> dist/${relativePath}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${releases.length} committed artifacts failed validation`)
  }
  console.log(`Validated ${releases.length} committed artifacts`)
}

main().catch(reportError)
