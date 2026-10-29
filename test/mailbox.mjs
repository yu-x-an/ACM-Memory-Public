/**
 * Asynchronous mailbox: the Mode B hand-off primitive. Agents arrive at
 * different times, so work has to survive between runs.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { claimMessage, completeMessage, inbox, openDecision, sendMessage } from '../lib/deliberation.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-mailbox-'))
const db = openDb(join(dir, 'memory.db'))
let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

try {
  t('a message needs a recipient, a sender and a body', () => {
    assert.equal(sendMessage(db, { from: 'a', body: 'x' }).reason, 'to-from-body-required')
    assert.equal(sendMessage(db, { to: 'b', body: 'x' }).reason, 'to-from-body-required')
    assert.equal(sendMessage(db, { to: 'b', from: 'a' }).reason, 'to-from-body-required')
    assert.equal(sendMessage(db, { to: 'b', from: 'a', body: 'x', kind: 'shout' }).reason, 'unknown-kind')
  })

  const decision = openDecision(db, { topic: 'deploy window', proposal: 'sunday', actor: 'lead', scope: 'm' })
  const sent = sendMessage(db, { to: 'reviewer', from: 'lead', kind: 'review', body: 'review the deploy window', decisionId: decision.id })
  t('a message lands in the recipient inbox only', () => {
    assert.equal(sent.ok, true)
    assert.equal(inbox(db, { agent: 'reviewer' }).length, 1)
    assert.equal(inbox(db, { agent: 'lead' }).length, 0)
    const msg = inbox(db, { agent: 'reviewer' })[0]
    assert.equal(msg.kind, 'review')
    assert.equal(msg.decisionId, decision.id)
    assert.equal(msg.state, 'pending')
  })

  t('only the addressee can claim a message', () => {
    assert.equal(claimMessage(db, { id: sent.id, agent: 'stranger' }).reason, 'not-your-inbox')
    const claimed = claimMessage(db, { id: sent.id, agent: 'reviewer' })
    assert.equal(claimed.ok, true)
    assert.equal(inbox(db, { agent: 'reviewer', state: 'claimed' }).length, 1)
  })

  t('a claimed message cannot be claimed twice', () => {
    const again = claimMessage(db, { id: sent.id, agent: 'reviewer' })
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'not-pending')
  })

  t('only the claim holder can complete it', () => {
    assert.equal(completeMessage(db, { id: sent.id, agent: 'intruder' }).reason, 'claimed-by-someone-else')
    assert.equal(completeMessage(db, { id: sent.id, agent: 'reviewer' }).ok, true)
    assert.equal(inbox(db, { agent: 'reviewer' }).length, 0)
    assert.equal(inbox(db, { agent: 'reviewer', state: 'done' }).length, 1)
  })

  t('completed work can only be acknowledged again by its original claimant', () => {
    const retry = completeMessage(db, { id: sent.id, agent: 'reviewer' })
    assert.equal(retry.ok, true)
    assert.equal(retry.already, true)
    const foreign = completeMessage(db, { id: sent.id, agent: 'stranger' })
    assert.equal(foreign.ok, false)
    assert.equal(foreign.reason, 'claimed-by-someone-else')
  })

  t('an unclaimed message cannot be completed', () => {
    const second = sendMessage(db, { to: 'reviewer', from: 'lead', body: 'second task' })
    assert.equal(completeMessage(db, { id: second.id, agent: 'reviewer' }).reason, 'not-claimed')
  })

  t('mailboxes are partition-scoped', () => {
    const mine = sendMessage(db, { to: 'reviewer', from: 'lead', body: 'alice only', owner: 'alice' })
    assert.ok(mine.ok)
    assert.ok(inbox(db, { agent: 'reviewer', owner: 'alice' }).some((m) => m.id === mine.id))
    assert.ok(!inbox(db, { agent: 'reviewer', owner: 'bob' }).some((m) => m.id === mine.id))
    assert.equal(claimMessage(db, { id: mine.id, agent: 'reviewer', owner: 'bob' }).reason, 'not-found')
  })

  t('a message reports whether the decision it points at still exists', () => {
    const linked = sendMessage(db, { to: 'reviewer', from: 'lead', body: 'see the decision', decisionId: decision.id })
    const orphan = sendMessage(db, { to: 'reviewer', from: 'lead', body: 'see nothing', decisionId: 999999 })
    const rows = inbox(db, { agent: 'reviewer' })
    assert.equal(rows.find((m) => m.id === linked.id).decisionExists, true)
    assert.equal(rows.find((m) => m.id === orphan.id).decisionExists, false)
  })

  console.log(`\nmailbox: ${pass} passed`)
} finally {
  try { db.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
}
