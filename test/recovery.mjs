/**
 * Checkpoint recovery verification: "the work was restored" is a claim; the
 * receipt ledger is the evidence. These tests cover the exactly-once property
 * and the cases that must fail loudly.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { markDelivered, receiptState, renderRecoveryReport, saveCheckpoint, verifyRecovery } from '../lib/checkpoint.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-recovery-'))
const db = openDb(join(dir, 'memory.db'))
let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

try {
  const cp = saveCheckpoint(db, { sessionId: 'r', goal: 'restore the task', next: 'continue' })

  t('a fresh checkpoint has exactly one prepared receipt', () => {
    const v = verifyRecovery(db, { sessionId: 'r' })
    assert.equal(v.ok, true, JSON.stringify(v.checks))
    assert.equal(v.prepared, 1)
    assert.equal(v.delivered, 0)
    assert.equal(v.checkpointId, cp)
  })

  t('delivery is recorded once and verification still passes', () => {
    assert.equal(markDelivered(db, cp, 'r', 'turn'), true)
    const v = verifyRecovery(db, { sessionId: 'r' })
    assert.equal(v.delivered, 1)
    assert.equal(v.ok, true)
    assert.match(renderRecoveryReport(v), /recovery verified/)
  })

  t('marking the same checkpoint again does not duplicate the receipt', () => {
    assert.equal(markDelivered(db, cp, 'r', 'turn again'), true)
    const v = verifyRecovery(db, { sessionId: 'r' })
    assert.equal(v.delivered, 1, 'duplicate delivered receipt')
    assert.equal(v.ok, true)
    assert.deepEqual(receiptState(db, cp).states, ['prepared', 'delivered'])
  })

  t('a delivery from another partition is refused', () => {
    const other = saveCheckpoint(db, { sessionId: 'r', goal: 'other', next: 'x' })
    assert.equal(markDelivered(db, other, 'r', 'nope', 'someone-else'), false)
    assert.equal(receiptState(db, other, null).delivered, false)
  })

  t('a session without a checkpoint is reported, not assumed healthy', () => {
    const v = verifyRecovery(db, { sessionId: 'nobody' })
    assert.equal(v.ok, false)
    assert.equal(v.checks.checkpoint, 'missing')
  })

  t('an orphan receipt fails the ledger', () => {
    db.prepare("insert into acm_recovery_receipts (checkpoint_id, session_id, state, at) values (?, ?, ?, ?)")
      .run(999999, 'r', 'delivered', Date.now())
    const v = verifyRecovery(db, { sessionId: 'r' })
    assert.equal(v.ok, false)
    assert.ok(v.orphans >= 1)
    assert.equal(v.checks.orphans, String(v.orphans))
  })

  console.log(`\nrecovery: ${pass} passed`)
} finally {
  try { db.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
}
