/**
 * Verify an exported public tree against its own manifest.
 *
 * This is the public half of the export gate: it runs **inside the exported
 * repository**, needs no access to the private one, and answers a question the test
 * suite cannot - "is this tree exactly the set of files the export claims, byte for
 * byte?" A passing test suite says the code works; it says nothing about whether a
 * file rode along.
 *
 * It checks:
 *   - every file in the tree is in `export-manifest.json`, and nothing is missing;
 *   - every file's sha256 matches, over the final bytes;
 *   - no symlinks, no non-regular files, no duplicate or case-colliding names;
 *   - the manifest does not name a private source commit.
 *
 * `--require` turns a missing manifest into a failure. Without it the tool says so and
 * exits 0, because the same script runs in the private tree as a step of `test:public`
 * and there is nothing to verify there.
 *
 * Usage: node scripts/verify-export.mjs [--require] [--root <dir>] [--json]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const rootArg = argv.indexOf('--root')
const root = resolve(rootArg >= 0 ? argv[rootArg + 1] : fileURLToPath(new URL('../', import.meta.url)))
const requireManifest = argv.includes('--require')
const asJson = argv.includes('--json')

const MANIFEST = 'export-manifest.json'
/** Skipped at the **top level only**. A real `npm install` tree at the root is not part
 *  of the artifact; a `node_modules` deeper down can be, and here it is: the vendored
 *  onnxruntime files the package ships live under `lib/vendor/ort/node_modules/`. The
 *  first version skipped the name at every depth, so verifying an exported directory
 *  with no `.git` reported 26 shipped files as "missing from the tree" - a false
 *  failure that would have made the mirror's own gate untrustworthy. */
const SKIP_DIRS = new Set(['.git', 'node_modules'])

/**
 * The universe being verified is **the set of files that would ship**, not everything
 * on disk in a working copy where a test has just run. In a git checkout that is the
 * committed list plus any file added but not yet ignored; in a tarball it is the tree.
 *
 * The first version walked the directory unconditionally, so `npm run test:all` failed
 * against its own scratch: `.tmp-smoke/`, `.tmp-gaps/` and a diag log are created by
 * the suite and are gitignored, and "not in the manifest" was technically true and
 * practically wrong. A verifier that fails on the artifacts of the thing it verifies
 * teaches people to skip it.
 */
function fileUniverse() {
  try {
    const list = (mode) => execFileSync('git', ['ls-files', ...mode], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n').map((f) => f.trim()).filter(Boolean)
    const tracked = list([])
    const untracked = list(['--others', '--exclude-standard'])
    return { paths: [...new Set([...tracked, ...untracked])], from: 'git index' }
  } catch {
    return { paths: null, from: 'directory tree' }
  }
}

function walk(dir, acc = [], seen = new Map()) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) { acc.push({ path: relative(root, abs).replace(/\\/g, '/'), kind: 'symlink' }); continue }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) && resolve(dir) === resolve(root)) continue
      walk(abs, acc, seen)
      continue
    }
    if (!st.isFile()) { acc.push({ path: relative(root, abs).replace(/\\/g, '/'), kind: 'special' }); continue }
    const path = relative(root, abs).replace(/\\/g, '/')
    const key = path.toLowerCase()
    if (seen.has(key) && seen.get(key) !== path) acc.push({ path, kind: `case-collision-with:${seen.get(key)}` })
    seen.set(key, path)
    acc.push({ path, kind: 'file', abs })
  }
  return acc
}

/** Symlinks and special files are checked in the walked tree; the git list is entries. */
function entriesFrom(paths) {
  const acc = []
  const seen = new Map()
  for (const path of paths) {
    const abs = join(root, path)
    let st
    try { st = lstatSync(abs) } catch { acc.push({ path, kind: 'missing' }); continue }
    if (st.isSymbolicLink()) { acc.push({ path, kind: 'symlink' }); continue }
    if (!st.isFile()) { acc.push({ path, kind: 'special' }); continue }
    const key = path.toLowerCase()
    if (seen.has(key) && seen.get(key) !== path) acc.push({ path, kind: `case-collision-with:${seen.get(key)}` })
    seen.set(key, path)
    acc.push({ path, kind: 'file', abs })
  }
  return acc
}

const problems = []
const manifestPath = join(root, MANIFEST)

if (!readFileSync0(manifestPath)) {
  if (requireManifest) {
    console.error(`verify-export: ${MANIFEST} is missing and --require was passed`)
    process.exit(1)
  }
  console.log('verify-export: no export manifest here, nothing to verify (this is not an exported tree)')
  process.exit(0)
}

function readFileSync0(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`verify-export: ${MANIFEST} is not valid JSON: ${err.message}`)
  process.exit(1)
}

const files = manifest.files && typeof manifest.files === 'object' ? manifest.files : null
if (!files) {
  console.error(`verify-export: ${MANIFEST} has no "files" map`)
  process.exit(1)
}

// A public artifact must not name the private source. Checked by key and by value,
// because the whole point of the export id is that the SHA stays on the other side.
const forbiddenKeys = ['sourceSha', 'privateSha', 'privateCommit', 'sourceCommit']
for (const key of forbiddenKeys) {
  if (JSON.stringify(manifest).includes(`"${key}"`)) problems.push(`manifest names a private source (${key})`)
}
if (/"files"[\s\S]*?\b[0-9a-f]{40}\b/.test(JSON.stringify(manifest))) {
  problems.push('manifest contains a 40-hex value, which looks like a private commit id')
}

const universe = fileUniverse()
const onDisk = (universe.paths ? entriesFrom(universe.paths) : walk(root)).filter((e) => e.path !== MANIFEST)
for (const entry of onDisk) {
  if (entry.kind === 'missing') problems.push(`missing from the tree: ${entry.path}`)
  else if (entry.kind !== 'file') problems.push(`${entry.path}: ${entry.kind} is not a regular file`)
}
const regular = new Map(onDisk.filter((e) => e.kind === 'file').map((e) => [e.path, e]))

for (const path of Object.keys(files)) {
  if (!regular.has(path)) { problems.push(`missing from the tree: ${path}`); continue }
  const actual = createHash('sha256').update(readFileSync(regular.get(path).abs)).digest('hex')
  if (actual !== files[path]) problems.push(`hash mismatch: ${path} (manifest ${files[path].slice(0, 12)}, file ${actual.slice(0, 12)})`)
  regular.delete(path)
}
for (const path of regular.keys()) problems.push(`not in the manifest: ${path}`)

if (asJson) {
  console.log(JSON.stringify({ ok: problems.length === 0, files: Object.keys(files).length, from: universe.from, problems }, null, 2))
} else if (problems.length) {
  console.error(`verify-export: ${problems.length} problem(s) in ${Object.keys(files).length} declared files (checked ${universe.from})`)
  for (const p of problems.slice(0, 40)) console.error(`  - ${p}`)
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`)
} else {
  console.log(`verify-export: ${Object.keys(files).length} files match the manifest byte for byte (${universe.from})`)
}
process.exit(problems.length ? 1 : 0)
