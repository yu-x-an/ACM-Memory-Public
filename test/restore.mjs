/**
 * Recovery drill: a backup is only useful if a restore actually yields a working
 * database. This test performs the whole trip - write, snapshot, restore to a
 * new path, reopen, query - instead of assuming the copy is good.
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { remember, search, stats } from '../lib/memory.mjs'
import { activeCheckpoint, saveCheckpoint } from '../lib/checkpoint.mjs'
import { openDecision } from '../lib/deliberation.mjs'
import { backupIfDue, checkBackup, listBackups, restoreBackup } from '../lib/backup.mjs'

const root = mkdtempSync(join(tmpdir(), 'acm-restore-'))
const dbPath = join(root, 'memory.db')
let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

try {
  const db = openDb(dbPath)
  remember(db, { scope: 'r', text: 'the project ships on fridays', key: 'release.day', source: { raw: 'fridays' } })
  remember(db, { scope: 'global', text: 'backups run every six hours', key: 'ops.backup', source: { raw: 'six hours' } })
  saveCheckpoint(db, { sessionId: 'r', goal: 'ship it', next: 'verify the restore' })
  openDecision(db, { topic: 'ship on friday', proposal: 'keep the schedule', actor: 'lead', scope: 'r' })
  const before = stats(db)
  const snapshot = backupIfDue(db, dbPath, { everyHours: 6, keep: 7 }, Date.now())
  db.close()

  t('the snapshot is taken and passes verification', () => {
    assert.ok(snapshot.created, JSON.stringify(snapshot))
    const check = checkBackup(join(snapshot.dir, snapshot.created))
    assert.equal(check.ok, true, JSON.stringify(check))
    assert.equal(check.nodes, before.nodes)
  })

  const restoredPath = join(root, 'restored', 'memory.db')
  const restored = restoreBackup(join(snapshot.dir, snapshot.created), restoredPath)

  t('a restore reports what it produced', () => {
    assert.equal(restored.ok, true, JSON.stringify(restored))
    assert.equal(restored.nodes, before.nodes)
    assert.ok(restored.schema >= 12, `schema ${restored.schema}`)
  })

  t('the restored database opens and answers queries identically', () => {
    const db2 = openDb(restoredPath)
    try {
      assert.deepEqual(stats(db2), before)
      const hit = search(db2, { query: 'ships on fridays', scope: 'r' })
      assert.ok(hit.some((n) => n.key === 'release.day'), 'restored memory is not searchable')
      const cp = activeCheckpoint(db2, 'r')
      assert.equal(cp.goal, 'ship it')
      const decision = db2.prepare('select topic from acm_decisions limit 1').get()
      assert.equal(decision.topic, 'ship on friday')
    } finally {
      db2.close()
    }
  })

  t('restoring refuses to overwrite a live database without force', () => {
    const blocked = restoreBackup(join(snapshot.dir, snapshot.created), restoredPath)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, 'target-exists')
  })

  t('restore refuses a missing source and an unusable copy', () => {
    assert.equal(restoreBackup(join(root, 'nope.db'), join(root, 'x.db')).reason, 'source-missing')
    const junk = join(root, 'junk.db')
    writeFileSync(junk, 'not a database')
    const bad = restoreBackup(junk, join(root, 'junk-restored.db'))
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'source-unusable')
  })

  t('a corrupt source cannot destroy the database it was restored over', () => {
    const keep = join(root, 'protected.db')
    copyFileSync(join(snapshot.dir, snapshot.created), keep)
    const before = statSync(keep).size
    const junk = join(root, 'rotten.db')
    writeFileSync(junk, 'definitely not sqlite')
    const refused = restoreBackup(junk, keep, { force: true })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'source-unusable')
    // The good file is still the good file.
    assert.equal(statSync(keep).size, before)
    assert.equal(checkBackup(keep).ok, true)
  })

  t('the original database was never touched by the drill', () => {
    const db3 = openDb(dbPath)
    try {
      assert.deepEqual(stats(db3), before)
    } finally {
      db3.close()
    }
    assert.equal(listBackups(join(root, 'backups')).length >= 1, true)
  })

  t('a database with a live write-ahead log is not replaced', () => {
    const live = join(root, 'live.db')
    copyFileSync(join(snapshot.dir, snapshot.created), live)
    // A non-empty -wal next to the file means a connection was mid-flight.
    writeFileSync(`${live}-wal`, 'pending frames')
    const before = statSync(live).size
    const refused = restoreBackup(join(snapshot.dir, snapshot.created), live, { force: true })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'live-database')
    assert.equal(statSync(live).size, before)
  })

  console.log(`\nrestore: ${pass} passed`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
