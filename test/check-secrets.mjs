/**
 * The secret scan has to work on the thing that actually ships.
 *
 * `check-secrets.mjs` used to call `git ls-files` unconditionally, so in a tree without
 * `.git` - an npm tarball, or an exported directory before `git init` - it threw. A
 * scanner that throws reports nothing, and "nothing" reads like "clean" in a log
 * someone skims. It now falls back to walking the directory, and says which list it
 * used, so the evidence is about the bytes that were shipped.
 *
 * This test builds both worlds in a temporary directory: with a repository (only the
 * index is scanned, so untracked scratch files stay out of the result) and without one
 * (the directory is scanned).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/check-secrets.mjs', import.meta.url))

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const base = mkdtempSync(join(tmpdir(), 'acm-secret-scan-'))
const fixture = (name) => {
  const dir = join(base, name)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(script, join(dir, 'scripts', 'check-secrets.mjs'))
  return dir
}
const run = (dir) => spawnSync(process.execPath, [join(dir, 'scripts', 'check-secrets.mjs')], { cwd: dir, encoding: 'utf8' })

// A credential shape that is never written literally in this file.
const fakeKey = ['AKIA', 'Q'.repeat(16)].join('')

try {
  {
    const dir = fixture('no-git-clean')
    writeFileSync(join(dir, 'README.md'), '# nothing to hide\n')
    const r = run(dir)
    ok('a tree without .git is scanned instead of skipped', r.status === 0 && /directory tree/.test(r.stdout), r.stdout + r.stderr)
  }
  {
    const dir = fixture('no-git-secret')
    writeFileSync(join(dir, 'config.mjs'), `export const key = '${fakeKey}'\n`)
    const r = run(dir)
    ok('a credential in a tree without .git is still found',
      r.status === 1 && /aws-access-key/.test(r.stderr), (r.stdout + r.stderr).slice(0, 240))
  }
  {
    const dir = fixture('with-git')
    writeFileSync(join(dir, 'README.md'), '# tracked and clean\n')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: dir })
    writeFileSync(join(dir, 'scratch.mjs'), `export const key = '${fakeKey}'\n`)
    const r = run(dir)
    ok('with a repository, only the committed list is scanned',
      r.status === 0 && /git index/.test(r.stdout), (r.stdout + r.stderr).slice(0, 240))
  }
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

console.log(failures.length
  ? `\ncheck-secrets: ${pass} passed, ${failures.length} failed`
  : `\ncheck-secrets: ${pass} passed`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
