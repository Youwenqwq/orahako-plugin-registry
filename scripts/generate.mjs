import fs from "node:fs"
import {
  DIST_DIR,
  DIST_INDEX,
  buildIndex,
  serializeJson,
} from "./lib/registry.mjs"
import { reportError } from "./lib/rules.mjs"

function main() {
  const index = buildIndex()
  const text = serializeJson(index)
  fs.mkdirSync(DIST_DIR, { recursive: true })
  fs.writeFileSync(DIST_INDEX, text)

  const releases = index.plugins.reduce((count, plugin) => count + plugin.versions.length, 0)
  console.log(
    `Generated dist/plugins.json: ${index.plugins.length} plugins, ${releases} releases, updatedAt ${index.updatedAt}`
  )
}

try {
  main()
} catch (error) {
  reportError(error)
}
