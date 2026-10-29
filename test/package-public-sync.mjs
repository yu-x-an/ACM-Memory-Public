/**
 * The public tree ships a different `package.json`.
 *
 * The mirror cannot run the private suite: the history checks need the private
 * history and its baseline, so a package.json copied unchanged into the mirror
 * advertises commands that fail there. Rather than export the private file and hope
 * nobody runs `npm run test:all`, the mirror carries `package.public.json`, which the
 * exporter **renames to `package.json`** - so in the mirror only one of the two files
 * exists, and this test has two modes:
 *
 *   private tree: compare the two manifests, allowing only the documented differences
 *   mirror:       there is nothing to compare; assert the single manifest is the
 *                 public one (no history command, public suite, tree verification)
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const a = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const variantPath = `${root}package.public.json`
const b = existsSync(variantPath) ? JSON.parse(readFileSync(variantPath, 'utf8')) : null

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

/** Keys allowed to differ between the private manifest and the public variant.
 *  `mirror:*` is private-only on purpose: those commands drive the local mirror from
 *  the development tree, and in the mirror there is neither a mirror to drive nor an
 *  exporter to run. Advertising them there would be a command that always fails. */
const ALLOWED_SCRIPT_DIFF = new Set([
  'test:all',
  'test:public',
  'test:package',
  'mirror:check',
  'mirror:hooks',
  'mirror:sync',
  'mirror:dry-run',
])

const strip = (pkg) => {
  const copy = JSON.parse(JSON.stringify(pkg))
  copy.scripts = { ...copy.scripts }
  for (const key of ALLOWED_SCRIPT_DIFF) delete copy.scripts[key]
  delete copy.scripts['test:history']
  delete copy.files
  return copy
}

/** The mirror ships the public variant; the development tree ships both. */
const inMirror = a.scripts['test:history'] === undefined

if (inMirror) {
  ok('the mirror does not advertise the private history command',
    a.scripts['test:history'] === undefined, String(a.scripts['test:history']))
  ok('the mirror full suite is the public suite',
    a.scripts['test:all'] === a.scripts['test:public'], `${a.scripts['test:all']}\n---\n${a.scripts['test:public']}`)
  ok('the mirror package check runs the public profile',
    /check-package\.mjs --profile=public/.test(a.scripts['test:package'] ?? ''), String(a.scripts['test:package']))
  ok('the mirror verifies its own tree against the manifest',
    /verify-export\.mjs --require/.test(a.scripts['test:all']), a.scripts['test:all'].slice(-90))
  ok('every path the mirror packages exists here',
    a.files.every((f) => existsSync(join(root, f))), a.files.join(', '))
  ok('the mirror does not ship the private variant as a second file', b === null, 'package.public.json should have been renamed')
} else {
  ok('every field outside the documented set is identical',
    JSON.stringify(strip(a)) === JSON.stringify(strip(b)),
    'name, version, bin, engines, dependencies, dsh and the other scripts must match')
  ok('the public variant does not advertise the private history command',
    b.scripts['test:history'] === undefined, String(b.scripts['test:history']))
  ok('the public variant does not advertise the mirror commands',
    !Object.keys(b.scripts).some((k) => k.startsWith('mirror:')),
    Object.keys(b.scripts).filter((k) => k.startsWith('mirror:')).join(', '))
  ok('the public full suite is the public suite',
    b.scripts['test:all'] === b.scripts['test:public'], `${b.scripts['test:all']}\n---\n${b.scripts['test:public']}`)
  ok('the package check runs the public profile',
    /check-package\.mjs --profile=public/.test(b.scripts['test:package'] ?? ''), String(b.scripts['test:package']))
  ok('the public suite verifies the tree against its manifest',
    /verify-export\.mjs --require/.test(b.scripts['test:all']), b.scripts['test:all'].slice(-90))
  ok('every path the public package lists exists in the mirror',
    b.files.every((f) => existsSync(join(root, f))), b.files.join(', '))
  ok('the private package ships more documents than the mirror',
    a.files.length > b.files.length, `${a.files.length} vs ${b.files.length}`)
  ok('the private suite is longer than the public one',
    a.scripts['test:all'].split(' && ').length > b.scripts['test:all'].split(' && ').length,
    `${a.scripts['test:all'].split(' && ').length} vs ${b.scripts['test:all'].split(' && ').length}`)
}

console.log(failures.length
  ? `\npackage-public-sync: ${pass} passed, ${failures.length} failed`
  : `\npackage-public-sync: ${pass} passed`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
