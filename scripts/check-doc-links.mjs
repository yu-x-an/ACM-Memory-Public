/**
 * Verify that every relative Markdown link resolves.
 *
 * GitHub silently renders a broken relative link as plain text, so a moved or
 * renamed document is invisible in review. This check fails the build instead.
 * External URLs are not fetched: the check must work offline and must not
 * turn a network hiccup into a red build.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const skip = new Set(['.git', 'node_modules', 'lib/vendor', '.tmp'])
const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const rel = relative(root, abs).replace(/\\/g, '/')
    if ([...skip].some((s) => rel === s || rel.startsWith(`${s}/`))) continue
    if (entry.isDirectory()) walk(abs, out)
    else if (entry.isFile() && extname(entry.name) === '.md') out.push(abs)
  }
  return out
}

/** GitHub-style heading slug: lowercase, drop punctuation, spaces to dashes. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]()#!.,:;'"<>|+~?/\\]/g, '')
    .replace(/\s+/g, '-')
}

function headingsOf(file) {
  const text = readFileSync(file, 'utf8')
  const set = new Set()
  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) set.add(slug(m[2]))
  }
  return set
}

const headingCache = new Map()
function headingsFor(file) {
  if (!headingCache.has(file)) headingCache.set(file, headingsOf(file))
  return headingCache.get(file)
}

const problems = []
const files = walk(root).filter((f) => !f.includes(join('lib', 'vendor')))

for (const file of files) {
  const relFile = relative(root, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(linkRe)) {
    const raw = match[1]
    if (/^(?:https?:|mailto:|tel:|data:)/i.test(raw)) continue
    const [target, anchor] = raw.split('#')
    if (!target && anchor) {
      // Same-file anchor.
      if (!headingsFor(file).has(slug(anchor)) && !headingsFor(file).has(anchor.toLowerCase())) {
        problems.push(`${relFile}: missing local anchor #${anchor}`)
      }
      continue
    }
    const abs = resolve(dirname(file), decodeURI(target))
    if (!existsSync(abs)) {
      problems.push(`${relFile}: missing target ${target}`)
      continue
    }
    if (anchor && statSync(abs).isFile() && extname(abs) === '.md') {
      if (!headingsFor(abs).has(slug(anchor)) && !headingsFor(abs).has(anchor.toLowerCase())) {
        problems.push(`${relFile}: missing anchor #${anchor} in ${target}`)
      }
    }
  }
}

if (problems.length) {
  console.error(`Documentation link check failed (${problems.length}):\n` + problems.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Documentation link check passed (${files.length} files).`)
}
