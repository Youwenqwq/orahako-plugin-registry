import { MAX_ARCHIVE_BYTES, verifyArchive } from "./lib/artifacts.mjs"
import { buildIndex } from "./lib/registry.mjs"
import { reportError } from "./lib/rules.mjs"

const DEFAULT_BASE_URL = "https://ysu.welain.com/updates/plugins.json"
const CONCURRENCY = 3
const REQUEST_TIMEOUT_MS = 120_000

async function downloadRelease(plugin, release, baseUrl) {
  const label = `${plugin.id}@${release.version}`
  const url = new URL(release.zipUrl, baseUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label}: zipUrl must resolve to an http(s) URL`)
  }

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "user-agent": "orahako-plugin-registry-validator" },
  })
  if (!response.ok) {
    throw new Error(`${label}: ${url.href} returned HTTP ${response.status}`)
  }

  const declared = Number(response.headers.get("content-length") ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`${label}: archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  verifyArchive(bytes, plugin, release)
  return label
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

async function main() {
  const index = buildIndex()
  const baseUrl = process.env.REGISTRY_BASE_URL ?? DEFAULT_BASE_URL
  new URL(baseUrl)

  const releases = index.plugins.flatMap((plugin) =>
    plugin.versions.map((release) => ({ plugin, release }))
  )
  console.log(`Validating ${releases.length} published artifacts against ${baseUrl}`)

  const results = await mapLimit(releases, CONCURRENCY, async ({ plugin, release }) => {
    const label = `${plugin.id}@${release.version}`
    try {
      await downloadRelease(plugin, release, baseUrl)
      return { label, ok: true }
    } catch (error) {
      return { label, ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  let failures = 0
  for (const result of results) {
    if (result.ok) {
      console.log(`ok ${result.label}`)
    } else {
      failures += 1
      console.error(`FAIL ${result.message}`)
    }
  }

  if (failures > 0) {
    console.error(`error: ${failures} of ${results.length} published artifacts failed validation`)
    process.exitCode = 1
    return
  }
  console.log(`Validated ${results.length} published artifacts`)
}

main().catch(reportError)
