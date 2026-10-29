/**
 * API surface freeze.
 *
 * The documented surface is a promise; this makes it enforceable. A removed or
 * renamed export fails the build, because that is the breaking change a caller
 * actually feels. Additions are allowed but reported, and the snapshot is
 * updated deliberately with `--update`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const snapshotPath = join(root, 'api-surface.json')

const MODULES = ['sdk', 'core', 'memory', 'embed', 'checkpoint', 'persona', 'handoff', 'deliberation', 'retention', 'backup', 'graph', 'fold', 'evolve', 'redact', 'text', 'auth', 'tasks']

async function current() {
  const dir = mkdtempSync(join(tmpdir(), 'acm-api-'))
  const surface = { sdk: [], modules: {} }
  try {
    const { openMemory } = await import('../lib/sdk.mjs')
    const acm = openMemory({ dbPath: join(dir, 'memory.db'), sessionId: 'api-surface', config: { backup: { enabled: false } } })
    try {
      surface.sdk = Object.keys(acm).sort()
    } finally {
      acm.close()
    }
    for (const name of MODULES) {
      const mod = await import(`../lib/${name}.mjs`)
      surface.modules[name] = Object.keys(mod).sort()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return surface
}

const update = process.argv.includes('--update')
const live = await current()

if (update) {
  writeFileSync(snapshotPath, JSON.stringify(live, null, 2) + '\n', 'utf8')
  console.log(`API surface snapshot written (${live.sdk.length} SDK members, ${MODULES.length} modules).`)
  process.exit(0)
}

let recorded
try {
  recorded = JSON.parse(readFileSync(snapshotPath, 'utf8'))
} catch (err) {
  console.error(`API surface check failed: cannot read api-surface.json\n${err?.message ?? err}`)
  process.exit(1)
}

const removed = []
const added = []

for (const name of recorded.sdk) {
  if (!live.sdk.includes(name)) removed.push(`sdk.${name}`)
}
for (const name of live.sdk) {
  if (!recorded.sdk.includes(name)) added.push(`sdk.${name}`)
}
for (const [mod, names] of Object.entries(recorded.modules ?? {})) {
  const now = live.modules[mod] ?? []
  for (const name of names) if (!now.includes(name)) removed.push(`${mod}.${name}`)
  for (const name of now) if (!names.includes(name)) added.push(`${mod}.${name}`)
}

if (added.length) {
  console.log(`API additions (not breaking, update the snapshot with --update):\n${added.join('\n')}`)
}

if (removed.length) {
  console.error(
    `API surface check failed: ${removed.length} export(s) disappeared.\n` +
      `${removed.join('\n')}\n` +
      'Removing an export is a breaking change: restore it, or update api-surface.json as part of a major release.',
  )
  process.exit(1)
}

console.log(`API surface check passed (${recorded.sdk.length} SDK members, ${Object.keys(recorded.modules ?? {}).length} modules frozen).`)
