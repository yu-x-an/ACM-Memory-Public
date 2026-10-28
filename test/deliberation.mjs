/**
 * Shared decision records: the substrate both coordination modes use.
 * Mode A (a leader convenes agents) and Mode B (independent agents arrive at
 * different times) must produce the same auditable record.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { purge, remember } from '../lib/memory.mjs'
import { agents, argue, decide, decisionView, decisions, escalateConflict, openDecision, registerAgent } from '../lib/deliberation.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-deliberation-'))
const db = openDb(join(dir, 'memory.db'))
let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

try {
  const evidence = remember(db, { scope: 'd', text: 'the staging deploy failed twice', source: { raw: 'staging failed' } })

  t('opening a decision needs a topic, a proposal and an actor', () => {
    assert.equal(openDecision(db, { proposal: 'x', actor: 'a' }).reason, 'topic-proposal-actor-required')
    assert.equal(openDecision(db, { topic: 'x', actor: 'a' }).reason, 'topic-proposal-actor-required')
    assert.equal(openDecision(db, { topic: 'x', proposal: 'y' }).reason, 'topic-proposal-actor-required')
  })

  const opened = openDecision(db, { topic: 'retry the staging deploy', proposal: 'retry with the new runner', actor: 'leader', scope: 'd' })
  t('an opened decision starts open and is attributed', () => {
    assert.equal(opened.ok, true)
    const list = decisions(db, { state: 'open' })
    const row = list.find((d) => d.id === opened.id)
    assert.equal(row.proposer, 'leader')
    assert.equal(row.arguments, 0)
  })

  t('an argument may cite evidence that exists', () => {
    const r = argue(db, opened.id, { actor: 'reviewer', stance: 'support', text: 'the new runner fixed it', evidence: [evidence.id] })
    assert.equal(r.ok, true)
    const view = decisionView(db, opened.id)
    assert.equal(view.arguments.length, 1)
    assert.deepEqual(view.arguments[0].evidence, [{ id: evidence.id, ok: true }])
    assert.deepEqual(view.missingEvidence, [])
  })

  t('evidence that does not exist is refused, not stored', () => {
    const r = argue(db, opened.id, { actor: 'reviewer', stance: 'support', text: 'trust me', evidence: [999999] })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'evidence-not-found')
    assert.deepEqual(r.missing, [999999])
  })

  t('an unknown stance is refused', () => {
    assert.equal(argue(db, opened.id, { actor: 'x', stance: 'maybe', text: 'hmm' }).reason, 'unknown-stance')
  })

  t('deciding closes the decision and attributes it', () => {
    const r = decide(db, opened.id, { actor: 'owner', outcome: 'approved', rationale: 'evidence is clear' })
    assert.equal(r.ok, true)
    const view = decisionView(db, opened.id)
    assert.equal(view.decision.state, 'approved')
    assert.equal(view.decision.decidedBy, 'owner')
    assert.equal(view.decision.rationale, 'evidence is clear')
  })

  t('a closed decision cannot be re-decided or argued', () => {
    assert.equal(decide(db, opened.id, { actor: 'other', outcome: 'rejected' }).reason, 'already-decided')
    assert.equal(argue(db, opened.id, { actor: 'other', stance: 'oppose', text: 'late' }).reason, 'not-open')
  })

  t('decisions are partition-scoped', () => {
    const mine = openDecision(db, { topic: 'ours', proposal: 'keep', actor: 'alice', owner: 'alice' })
    assert.ok(decisions(db, { owner: 'alice' }).some((d) => d.id === mine.id))
    assert.ok(!decisions(db, { owner: 'bob' }).some((d) => d.id === mine.id))
    assert.equal(decide(db, mine.id, { actor: 'bob', outcome: 'approved', owner: 'bob' }).reason, 'not-found')
    assert.equal(decisionView(db, mine.id, { owner: 'bob' }), null)
  })

  t('the agent registry validates roles and rejects unknown actors', () => {
    assert.equal(registerAgent(db, { name: '', role: 'reviewer' }).reason, 'name-required')
    assert.equal(registerAgent(db, { name: 'x', role: 'king' }).reason, 'unknown-role')
    registerAgent(db, { name: 'lead', role: 'proposer', owner: 'team' })
    registerAgent(db, { name: 'boss', role: 'decider', owner: 'team' })
    assert.equal(openDecision(db, { topic: 't', proposal: 'p', actor: 'stranger', owner: 'team' }).reason, 'unknown-agent')
    assert.equal(agents(db, { owner: 'team' }).length, 2)
  })

  t('roles limit what an actor may do', () => {
    const d = openDecision(db, { topic: 'deploy window', proposal: 'sunday', actor: 'lead', scope: 's', owner: 'team' })
    assert.equal(d.ok, true)
    assert.equal(argue(db, d.id, { actor: 'lead', stance: 'support', text: 'cheap', owner: 'team' }).ok, true)
    assert.equal(decide(db, d.id, { actor: 'lead', outcome: 'approved', owner: 'team' }).reason, 'role-not-allowed')
    assert.equal(decide(db, d.id, { actor: 'boss', outcome: 'approved', owner: 'team' }).ok, true)
  })

  t('a registered observer can neither argue nor decide', () => {
    registerAgent(db, { name: 'watcher', role: 'observer', owner: 'team' })
    const d = openDecision(db, { topic: 'x', proposal: 'y', actor: 'lead', owner: 'team' })
    assert.equal(argue(db, d.id, { actor: 'watcher', stance: 'support', text: 'hi', owner: 'team' }).reason, 'role-not-allowed')
    assert.equal(decide(db, d.id, { actor: 'watcher', outcome: 'approved', owner: 'team' }).reason, 'role-not-allowed')
  })

  t('a conflict escalates into a decision whose evidence survives supersession', () => {
    const v1 = remember(db, { scope: 'esc', text: 'region is eu', key: 'esc.region', source: { raw: 'eu' } })
    const v2 = remember(db, { scope: 'esc', text: 'region is us', key: 'esc.region', source: { raw: 'us' } })
    const r = escalateConflict(db, { nodeId: v2.id, actor: 'lead' })
    assert.equal(r.ok, true, JSON.stringify(r))
    const view = decisionView(db, r.decisionId)
    assert.match(view.decision.topic, /conflict on esc\.region/)
    const evidence = view.arguments[0].evidence
    assert.equal(evidence.length, 2)
    assert.ok(evidence.every((e) => e.ok), JSON.stringify(evidence))
    assert.deepEqual(view.missingEvidence, [])
    assert.ok(evidence.some((e) => e.id === v1.id), 'superseded revision is still valid evidence')
  })

  t('a decision survives its evidence being erased, and says so', () => {
    const doomed = remember(db, { scope: 'ev', text: 'the evidence that will be erased', source: { raw: 'x' } })
    const d = openDecision(db, { topic: 'evidence loss', proposal: 'decide with what is left', actor: 'leader', scope: 'ev' })
    assert.equal(argue(db, d.id, { actor: 'leader', stance: 'support', text: 'this happened', evidence: [doomed.id] }).ok, true)
    assert.deepEqual(decisionView(db, d.id).missingEvidence, [])

    purge(db, doomed.id)
    const view = decisionView(db, d.id)
    assert.equal(view.decision.state, 'open', 'the decision was deleted with its evidence')
    assert.deepEqual(view.missingEvidence, [doomed.id])
    assert.equal(view.arguments[0].evidence[0].ok, false)
  })

  t('a newer approval supersedes the earlier one on the same topic', () => {
    const first = openDecision(db, { topic: 'release cadence', proposal: 'monthly', actor: 'lead', scope: 'sup' })
    decide(db, first.id, { actor: 'owner', outcome: 'approved', rationale: 'start monthly' })
    const second = openDecision(db, { topic: 'release cadence', proposal: 'weekly', actor: 'lead', scope: 'sup' })
    const r = decide(db, second.id, { actor: 'owner', outcome: 'approved', rationale: 'move to weekly' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.superseded, [first.id])

    const old = decisionView(db, first.id)
    assert.equal(old.decision.state, 'superseded')
    assert.equal(old.decision.supersededBy, second.id)
    const current = decisionView(db, second.id)
    assert.equal(current.decision.state, 'approved')
  })

  t('a different topic or scope is not superseded', () => {
    const other = openDecision(db, { topic: 'release cadence', proposal: 'quarterly', actor: 'lead', scope: 'other-scope' })
    decide(db, other.id, { actor: 'owner', outcome: 'approved' })
    const same = decisions(db, { scope: 'sup' }).filter((d) => d.topic === 'release cadence' && d.state === 'approved')
    assert.equal(same.length, 1, JSON.stringify(same))
    assert.equal(decisionView(db, other.id).decision.state, 'approved')
  })

  console.log(`\ndeliberation: ${pass} passed`)
} finally {
  try { db.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
}
