/**
 * Verifiable handoff: a package must be checkable against the database, and it
 * must fail loudly when the world moved on.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { forget, remember } from '../lib/memory.mjs'
import { saveCheckpoint } from '../lib/checkpoint.mjs'
import { buildHandoff, canonicalJson, renderHandoffReport, verifyHandoff } from '../lib/handoff.mjs'
import { argue, decide, openDecision, sendMessage } from '../lib/deliberation.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-handoff-'))
const db = openDb(join(dir, 'memory.db'))
let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

try {
  t('a session without a checkpoint cannot be handed off', () => {
    const r = buildHandoff(db, { sessionId: 'empty' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-checkpoint')
  })

  const restored = remember(db, { scope: 'hs', text: 'the release runs on node twenty two', key: 'release.runtime', source: { raw: 'node 22' } })
  remember(db, { scope: 'hs', text: 'the deploy target is staging', key: 'deploy.target', source: { raw: 'staging' } })
  saveCheckpoint(db, { sessionId: 'hs', goal: 'ship the release', next: 'run the regression suite' })

  const pkg = buildHandoff(db, { sessionId: 'hs' })
  t('a handoff carries facts, a checkpoint and a digest', () => {
    assert.equal(pkg.ok, true)
    assert.equal(pkg.facts.length >= 2, true)
    assert.match(pkg.digest, /^[0-9a-f]{64}$/)
    assert.equal(pkg.checkpoint.goal, 'ship the release')
    assert.ok(pkg.facts.some((f) => f.id === restored.id))
  })

  t('a fresh package verifies against the database', () => {
    const v = verifyHandoff(db, pkg)
    assert.equal(v.ok, true, JSON.stringify(v.checks))
    assert.match(renderHandoffReport(v), /handoff verified/)
  })

  t('a tampered digest is rejected', () => {
    const tampered = { ...pkg, digest: 'deadbeef' }
    const v = verifyHandoff(db, tampered)
    assert.equal(v.ok, false)
    assert.equal(v.checks.digest, 'tampered')
  })

  t('a package fails when a claimed memory was forgotten', () => {
    forget(db, restored.id, Date.now(), null)
    const v = verifyHandoff(db, pkg)
    assert.equal(v.ok, false)
    assert.equal(v.checks.facts, 'missing')
    assert.ok(v.missing.includes(restored.id))
  })

  t('a package fails when the checkpoint moved on', () => {
    saveCheckpoint(db, { sessionId: 'hs', goal: 'ship the release', next: 'announce it' })
    const v = verifyHandoff(db, pkg)
    assert.equal(v.ok, false)
    assert.equal(v.checks.checkpoint, 'superseded')
  })

  t('a package cannot be verified by another partition', () => {
    const fresh = buildHandoff(db, { sessionId: 'hs' })
    const v = verifyHandoff(db, fresh, { owner: 'someone-else' })
    assert.equal(v.ok, false)
    assert.equal(v.checks.owner, 'owner-mismatch')
  })

  t('canonical json is order independent', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }))
  })

  t('a handoff carries the open decisions and open mail', () => {
    const d = openDecision(db, { topic: 'who ships the release', proposal: 'alice ships it', actor: 'leader', scope: 'hs' })
    sendMessage(db, { to: 'successor', from: 'leader', body: 'take over the release', decisionId: d.id })

    const withAgent = buildHandoff(db, { sessionId: 'hs', agent: 'successor' })
    assert.equal(withAgent.openDecisions.length, 1)
    assert.equal(withAgent.openDecisions[0].id, d.id)
    assert.equal(withAgent.openMail, 1)
    assert.deepEqual(withAgent.manifest.decisions, [d.id])

    // Without an agent the mailbox count is unknown, not zero.
    assert.equal(buildHandoff(db, { sessionId: 'hs' }).openMail, null)
    assert.equal(verifyHandoff(db, withAgent).ok, true, JSON.stringify(verifyHandoff(db, withAgent).checks))
  })

  t('a package goes stale when a decision it carries is resolved', () => {
    const d = openDecision(db, { topic: 'pick the venue', proposal: 'the office', actor: 'leader', scope: 'hs' })
    const pkg = buildHandoff(db, { sessionId: 'hs' })
    assert.ok(pkg.manifest.decisions.includes(d.id))
    decide(db, d.id, { actor: 'owner', outcome: 'approved', rationale: 'decided after the handoff was built' })

    const v = verifyHandoff(db, pkg)
    assert.equal(v.ok, false)
    assert.equal(v.checks.decisions, 'stale')
    assert.ok(v.resolved.includes(d.id))
  })

  t('a package that shows different text than it claims is rejected', () => {
    const pkg = JSON.parse(JSON.stringify(buildHandoff(db, { sessionId: 'hs' })))
    assert.equal(verifyHandoff(db, pkg).ok, true)

    const edited = JSON.parse(JSON.stringify(pkg))
    edited.facts[0].text = 'the successor should trust this instead'
    const v1 = verifyHandoff(db, edited)
    assert.equal(v1.ok, false)
    assert.equal(v1.checks.payload, 'tampered')
    assert.equal(v1.checks.facts, 'text-mismatch')

    const dropped = JSON.parse(JSON.stringify(pkg))
    dropped.facts = []
    const v2 = verifyHandoff(db, dropped)
    assert.equal(v2.ok, false)
    assert.equal(v2.checks.factsList, 'tampered')

    const goal = JSON.parse(JSON.stringify(pkg))
    goal.checkpoint.goal = 'a different goal'
    const v3 = verifyHandoff(db, goal)
    assert.equal(v3.ok, false)
    assert.equal(v3.checks.payload, 'tampered')
  })
  t('every displayed field is bound, not only the facts', () => {
    const d = openDecision(db, { topic: 'who signs off', proposal: 'the lead', actor: 'leader', scope: 'hs' })
    argue(db, d.id, { actor: 'leader', stance: 'support', text: 'because it is his job' })
    const pkg = JSON.parse(JSON.stringify(buildHandoff(db, { sessionId: 'hs', agent: 'successor' })))
    assert.equal(verifyHandoff(db, pkg).ok, true, JSON.stringify(verifyHandoff(db, pkg).checks))

    const mail = JSON.parse(JSON.stringify(pkg))
    mail.openMail = 999
    assert.equal(verifyHandoff(db, mail).ok, false)
    assert.equal(verifyHandoff(db, mail).checks.payload, 'tampered')

    const proposals = JSON.parse(JSON.stringify(pkg))
    proposals.proposals = 42
    assert.equal(verifyHandoff(db, proposals).ok, false)

    // A decision that is still open but whose argument count changed is stale
    // content, and the successor would act on text it never saw.
    argue(db, d.id, { actor: 'reviewer', stance: 'oppose', text: 'a second opinion arrived' })
    const v = verifyHandoff(db, pkg)
    assert.equal(v.ok, false)
    assert.equal(v.checks.decisionContent, 'changed')
  })
  console.log(`\nhandoff: ${pass} passed`)
} finally {
  try { db.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
}
