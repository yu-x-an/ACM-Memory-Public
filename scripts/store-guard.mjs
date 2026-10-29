/**
 * One store guard, for every drill that hands tools to a model.
 *
 * Both drills write synthetic principals, grants, tasks and checkpoints, and
 * `agent-drill.mjs` forwards every advertised tool to a **model**, which means a
 * wrong `ACM_DB` is not a bad test run - it is a model editing real memory. The
 * first version of this check hard-coded `~/.acm`, a directory nothing writes to,
 * while the product's default is `~/.dsh/acm-memory/memory.db`; the
 * model drill then kept a weaker copy that refused only the default path
 *. Both now call this module.
 *
 * Three rules, and one rule about how paths are compared:
 *   1. the product's own default database (asked of the product, not guessed);
 *   2. anything inside a configured store root;
 *   3. any database file that already exists, wherever it is.
 *
 * Paths are compared as **segments**, after resolving the deepest existing ancestor
 * of each side, because both obvious shortcuts are wrong on this machine:
 *
 *   - Resolving only the final path leaves an uncreated child of a *symlinked* store
 *     comparing across drives. `~/.dsh` is a symlink to `D:\DSH\.dsh` here, so
 *     `realpath(root)` was `D:\...` while the new file stayed `C:\...`; `relative`
 *     then returned an absolute path, `isAbsolute` called it "outside", and the
 *     guard passed **everything** inside the store - inert on the operator's own
 *     machine while its tests stayed green, because the test root did not exist and
 *     was not a symlink.
 *   - `relative(root, root + '/..scratch.db')` is `'..scratch.db'`: a child whose
 *     *name* begins with two dots, not a traversal. `startsWith('..')` calls that
 *     outside and lets a drill create a file inside the store.
 */
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { mergeConfig } from '../lib/core.mjs'

/** Resolve a path through its deepest *existing* ancestor, without creating it. */
export function canonicalPath(target) {
  let current = resolve(target)
  const tail = []
  for (;;) {
    if (existsSync(current)) {
      const real = realpathSync(current)
      return tail.length ? join(real, ...tail.reverse()) : real
    }
    const parent = dirname(current)
    if (parent === current) return resolve(target)
    tail.push(basename(current))
    current = parent
  }
}

/** True when `target` is `root` itself or lies underneath it, by whole segments. */
export function isInside(root, target) {
  const rel = relative(canonicalPath(root), canonicalPath(target))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** The directories that hold real data for this installation. */
export function liveStoreRoots({ acmHome = process.env.ACM_HOME } = {}) {
  // Ask the product where its default is instead of spelling it out here: the first
  // version of this check hard-coded `~/.acm` and was wrong for months.
  const roots = [dirname(mergeConfig({}).dbPath)]
  if (acmHome) roots.push(resolve(acmHome))
  return roots
}

/**
 * Why this path must not be drilled into, or null when it is safe.
 *
 * Returns a reason instead of throwing so each caller can phrase the refusal in its
 * own vocabulary (`usage()` in one script, `usage()` in the other) - but there is
 * only one set of rules.
 */
export function storeRefusal(dbPath, { allowLiveDb = false, acmHome } = {}) {
  if (allowLiveDb) return null
  for (const root of liveStoreRoots({ acmHome })) {
    if (isInside(root, dbPath)) return `${dbPath} is inside the live store ${root}`
  }
  if (existsSync(dbPath)) {
    return `${dbPath} already exists; this drill writes synthetic data`
  }
  return null
}
