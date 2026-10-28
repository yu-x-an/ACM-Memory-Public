/**
 * Syntax-check every maintained script.
 *
 * The CI workflow used a bash for-loop, which cannot run on the Windows runner and
 * quietly limited the matrix to one operating system. This does the same walk in
 * Node so the same step works everywhere.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dirs = ['lib', 'lib/host', 'test', 'scripts']
let checked = 0
const failures = []

for (const dir of dirs) {
  let entries = []
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { continue }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    const file = join(dir, entry.name)
    try {
      execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
      checked += 1
    } catch (err) {
      failures.push(`${file}: ${String(err?.stderr ?? err?.message ?? err).trim().split('\n')[0]}`)
    }
  }
}

if (failures.length) {
  console.error('Syntax check failed:\n' + failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Syntax check passed (${checked} files).`)
}
