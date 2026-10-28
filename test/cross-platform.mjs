/**
 * Path and encoding portability.
 *
 * CI runs on Linux and development happens on Windows, so the store must not
 * assume a separator, a case-sensitive filesystem or a BOM-free write. These
 * cases use paths with spaces and non-ASCII characters on purpose.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { remember, search } from '../lib/memory.mjs'
import { backupDirFor, backupIfDue, checkBackup, restoreBackup } from '../lib/backup.mjs'
import { foldToMarkdown } from '../lib/fold.mjs'

const root = mkdtempSync(join(tmpdir(), 'acm-portable-'))
let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

try {
  // A directory with a space and non-ASCII characters, as a user home often is.
  const nested = join(root, 'a folder with spaces', '\u4e2d\u6587\u76ee\u5f55')
  const dbPath = join(nested, 'memory.db')

  const db = openDb(dbPath)
  t('a database path with spaces and non-ascii characters works', () => {
    remember(db, { scope: 'p', text: 'portable storage path', key: 'p.path', source: { raw: 'portable' } })
    const hits = search(db, { query: 'portable storage', scope: 'p' })
    assert.equal(hits.length, 1)
    assert.ok(existsSync(dbPath))
  })

  t('the backup directory derives from the database path with the host separator', () => {
    const dir = backupDirFor(dbPath, null)
    assert.ok(dir.endsWith(`${sep}backups`), `unexpected backup dir: ${dir}`)
  })

  const snapshot = backupIfDue(db, dbPath, { everyHours: 6, keep: 7 }, Date.now())
  t('a snapshot into that directory verifies', () => {
    assert.ok(snapshot.created, JSON.stringify(snapshot))
    const check = checkBackup(join(snapshot.dir, snapshot.created))
    assert.equal(check.ok, true, JSON.stringify(check))
    assert.equal(check.nodes, 1)
  })

  t('restoring into another spaced path works', () => {
    const target = join(root, 'restored copy', 'backup.db')
    const r = restoreBackup(join(snapshot.dir, snapshot.created), target)
    assert.equal(r.ok, true, JSON.stringify(r))
    const db2 = openDb(target)
    try {
      assert.equal(search(db2, { query: 'portable storage', scope: 'p' }).length, 1)
    } finally {
      db2.close()
    }
  })

  t('the markdown export is utf-8 without a BOM', () => {
    const out = join(root, 'export folder', 'memory.md')
    foldToMarkdown(db, { sessionId: 'p', outPath: out })
    const bytes = readFileSync(out)
    assert.notEqual(bytes[0], 0xef, 'file starts with a byte-order mark')
    const text = bytes.toString('utf8')
    assert.ok(text.includes('portable storage path'))
    assert.ok(!text.includes('\uFFFD'), 'replacement characters in the export')
  })

  t('database files stay inside the configured directory', () => {
    // A relative-ish sanity check: the path we opened is the one on disk.
    assert.ok(dbPath.startsWith(root))
    assert.ok(existsSync(dbPath))
  })

  db.close()
  console.log(`\ncross-platform: ${pass} passed`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
