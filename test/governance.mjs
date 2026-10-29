/**
 * Memory governance: verified hard deletion.
 *
 * `forget` is soft invalidation — the row, its text and its vectors stay in the
 * database. These tests cover `purge`, which removes every row that references a
 * memory, and `verifyPurged`, which reports what is left instead of trusting a
 * boolean.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { conflicts, feedback, forget, gc, history, mergeDuplicates, provenance, purge, purgeRange, remember, resolveConflict, search, sourcesOf, verifyPurged } from '../lib/memory.mjs'
import { saveCheckpoint } from '../lib/checkpoint.mjs'
import { buildInjectionText, mergeConfig } from '../lib/core.mjs'
import { foldToMarkdown } from '../lib/fold.mjs'
import { buildGraph } from '../lib/graph.mjs'
import { buildHandoff } from '../lib/handoff.mjs'
import { claimMessage, completeMessage, sendMessage } from '../lib/deliberation.mjs'
import { putVector } from '../lib/embed.mjs'
import { link } from '../lib/memory.mjs'
import { retentionReport } from '../lib/retention.mjs'
import { openMemory } from '../lib/sdk.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-governance-'))
const dbPath = join(dir, 'memory.db')
const db = openDb(dbPath)
let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

try {
  const victim = remember(db, {
    scope: 's',
    owner: 'alice',
    text: 'alice secret launch code',
    key: 'alice.secret',
    source: { raw: 'alice said the launch code is hunter2' },
  })
  const sibling = remember(db, { scope: 's', owner: 'alice', text: 'alice unrelated note', source: { raw: 'alice unrelated note' } })
  putVector(db, victim.id, new Float32Array(512).fill(0.1))
  link(db, victim.id, sibling.id, 'related')
  feedback(db, victim.id, 'useful', { owner: 'alice' })

  t('purge removes a memory the caller owns', () => {
    const r = purge(db, victim.id, { owner: 'alice' })
    assert.equal(r.ok, true)
    assert.equal(typeof r.droppedSources, 'number')
  })

  t('nothing references the purged memory any more', () => {
    const v = verifyPurged(db, victim.id)
    assert.equal(v.clean, true, JSON.stringify(v.checks))
  })

  t('the text is gone from search and from evidence', () => {
    assert.ok(!search(db, { query: 'launch code', scope: 's', owner: 'alice' }).some((n) => n.id === victim.id))
    const rows = db.prepare("select raw from acm_source_events where raw like '%hunter2%'").all()
    assert.equal(rows.length, 0, 'raw evidence survived the purge')
  })

  t('a sibling memory keeps its shared evidence rules intact', () => {
    assert.equal(sourcesOf(db, sibling.id, 'alice').length, 1)
    assert.ok(search(db, { query: 'unrelated note', scope: 's', owner: 'alice' }).some((n) => n.id === sibling.id))
  })

  t('purge cannot touch another partition', () => {
    const other = remember(db, { scope: 's', owner: 'bob', text: 'bob keeps this', source: { raw: 'bob keeps this' } })
    const r = purge(db, other.id, { owner: 'alice' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-found')
    assert.ok(search(db, { query: 'keeps this', scope: 's', owner: 'bob' }).some((n) => n.id === other.id))
  })

  t('forget stays soft: the row is still there afterwards', () => {
    const soft = remember(db, { scope: 's', owner: 'alice', text: 'soft forgotten fact', source: { raw: 'soft forgotten fact' } })
    assert.equal(forget(db, soft.id, Date.now(), 'alice'), true)
    const row = db.prepare('select status from acm_nodes where id = ?').get(soft.id)
    assert.equal(row.status, 'forgotten')
    assert.equal(purge(db, soft.id, { owner: 'alice' }).ok, true)
    assert.equal(verifyPurged(db, soft.id).clean, true)
  })

  t('the SDK exposes purge only for its own partition', () => {
    const alice = openMemory({ dbPath, sessionId: 's', config: { owner: 'alice', backup: { enabled: false } } })
    const mine = alice.remember({ text: 'sdk owned memory', source: 'sdk owned memory' })
    const bobs = db.prepare("select id from acm_nodes where owner = 'bob' limit 1").get()
    assert.equal(alice.purge(bobs.id).ok, false)
    assert.equal(alice.purge(mine.id).ok, true)
    assert.equal(alice.verifyPurged(mine.id).clean, true)
    alice.close()
  })

  t('range erasure needs an explicit cutoff', () => {
    assert.equal(purgeRange(db, { owner: 'alice' }).reason, 'before-required')
    assert.equal(purgeRange(db, { owner: 'alice', before: 0 }).reason, 'before-required')
    assert.equal(purgeRange(db, { owner: 'alice', before: 'soon' }).reason, 'before-required')
  })

  t('range erasure honours cutoff, partition and dryRun', () => {
    const old = remember(db, { scope: 's', owner: 'alice', text: 'ancient alice fact', source: { raw: 'ancient alice fact' } })
    const fresh = remember(db, { scope: 's', owner: 'alice', text: 'recent alice fact', source: { raw: 'recent alice fact' } })
    const bobOld = remember(db, { scope: 's', owner: 'bob', text: 'ancient bob fact', source: { raw: 'ancient bob fact' } })
    db.prepare('update acm_nodes set created_at = ? where id in (?, ?)').run(1000, old.id, bobOld.id)

    const dry = purgeRange(db, { owner: 'alice', before: 2000, dryRun: true })
    assert.equal(dry.candidates, 1)
    assert.equal(dry.deleted, 0)
    assert.ok(db.prepare('select 1 from acm_nodes where id = ?').get(old.id), 'dry run deleted a row')

    const run = purgeRange(db, { owner: 'alice', before: 2000 })
    assert.equal(run.deleted, 1)
    assert.equal(verifyPurged(db, old.id).clean, true)
    assert.ok(db.prepare('select 1 from acm_nodes where id = ?').get(fresh.id), 'a newer fact was deleted')
    assert.ok(db.prepare('select 1 from acm_nodes where id = ?').get(bobOld.id), 'another partition was touched')
  })

  t('provenance returns node, evidence and revision chain', () => {
    const first = remember(db, { scope: 'prov', owner: 'dave', text: 'database is postgres', key: 'dave.db', source: { raw: 'we run postgres' } })
    const second = remember(db, { scope: 'prov', owner: 'dave', text: 'database is sqlite', key: 'dave.db', source: { raw: 'switched to sqlite' } })
    const p = provenance(db, second.id, { owner: 'dave' })
    assert.ok(p, 'provenance returned null for an owned node')
    assert.equal(p.node.text, 'database is sqlite')
    assert.equal(p.sources.length, 1)
    assert.equal(p.sources[0].raw, 'switched to sqlite')
    assert.ok(p.revisions.length >= 2, 'revision chain missing the superseded version')
    assert.ok(p.revisions.some((r) => r.id === first.id && r.status === 'superseded'))
  })

  t('provenance is not an existence oracle across partitions', () => {
    const bobs = remember(db, { scope: 'prov', owner: 'bob', text: 'bob private fact', source: { raw: 'bob private fact' } })
    assert.equal(provenance(db, bobs.id, { owner: 'dave' }), null)
    assert.ok(provenance(db, bobs.id, { owner: 'bob' }))
  })

  t('churn on one fact key is reported, not averaged away', () => {
    const v1 = remember(db, { scope: 'conf', owner: 'dave', text: 'endpoint is staging', key: 'dave.endpoint', source: { raw: 'staging' } })
    const v2 = remember(db, { scope: 'conf', owner: 'dave', text: 'endpoint is production', key: 'dave.endpoint', source: { raw: 'production' } })
    const list = conflicts(db, { owner: 'dave' })
    const entry = list.find((c) => c.key === 'dave.endpoint')
    assert.ok(entry, 'conflict entry missing')
    assert.equal(entry.revisions, 2)
    assert.equal(entry.active, v2.id)
    assert.equal(entry.history.find((r) => r.id === v1.id).status, 'superseded')
  })

  t('resolving a conflict pins the chosen revision', () => {
    const v1 = remember(db, { scope: 'conf', owner: 'dave', text: 'region is eu', key: 'dave.region', source: { raw: 'eu' } })
    remember(db, { scope: 'conf', owner: 'dave', text: 'region is us', key: 'dave.region', source: { raw: 'us' } })
    const r = resolveConflict(db, { id: v1.id, owner: 'dave' })
    assert.equal(r.ok, true)
    assert.equal(r.superseded.length, 1)
    const row = db.prepare('select status, superseded_by from acm_nodes where id = ?').get(v1.id)
    assert.equal(row.status, 'active')
    assert.equal(row.superseded_by, null)
    // The pinned revision is searchable again and the other one is not.
    const hits = search(db, { query: 'region is', scope: 'conf', owner: 'dave' })
    assert.ok(hits.some((n) => n.id === v1.id), 'pinned revision is not searchable')
    assert.ok(!hits.some((n) => n.text === 'region is us'), 'superseded revision still searchable')
  })

  t('conflict review cannot cross partitions', () => {
    const bobs = remember(db, { scope: 'conf', owner: 'bob', text: 'bob endpoint', key: 'dave.endpoint', source: { raw: 'bob endpoint' } })
    assert.ok(!conflicts(db, { owner: 'bob' }).some((c) => c.scope === 'conf' && c.key === 'dave.endpoint' && c.active !== bobs.id))
    assert.equal(resolveConflict(db, { id: bobs.id, owner: 'dave' }).reason, 'not-found')
    const keyless = remember(db, { scope: 'conf', owner: 'dave', text: 'a fact without a key', source: { raw: 'no key' } })
    assert.equal(resolveConflict(db, { id: keyless.id, owner: 'dave' }).reason, 'no-key')
  })

  t('retention counts only what the policy would remove', () => {
    remember(db, { scope: 'ret', owner: 'frank', text: 'retired value', key: 'dave.ret', source: { raw: 'retired' } })
    remember(db, { scope: 'ret', owner: 'frank', text: 'current value', key: 'dave.ret', source: { raw: 'current' } })
    const relaxed = retentionReport(db, { owner: 'frank', policy: { staleDays: 120 } })
    assert.equal(relaxed.eligible.nodes, 0, 'a fresh superseded row is not eligible yet')
    assert.equal(relaxed.totals.activeNodes, 1)
    const eager = retentionReport(db, { owner: 'frank', policy: { staleDays: 0 }, now: Date.now() + 60000 })
    assert.ok(eager.eligible.nodes >= 1, 'an expired superseded row is eligible')
    // The active row is never a candidate, whatever the window is.
    assert.equal(eager.totals.activeNodes, 1)
  })

  t('retention reports backup overflow against the keep count', () => {
    const backupDir = join(dir, 'retention-backups')
    mkdirSync(backupDir, { recursive: true })
    for (const name of ['memory-20260101-000000.db', 'memory-20260102-000000.db', 'memory-20260103-000000.db']) {
      writeFileSync(join(backupDir, name), 'placeholder')
    }
    const r = retentionReport(db, { owner: 'frank', policy: { backupKeep: 1 }, backupDir })
    assert.equal(r.totals.backups, 3)
    assert.equal(r.eligible.backups, 2)
  })

  t('a purged memory is absent from every read surface', () => {
    saveCheckpoint(db, { sessionId: 'gone', owner: 'dave', goal: 'purge boundary check' })
    const target = remember(db, {
      scope: 'gone',
      owner: 'dave',
      text: 'erased payload about secret sauce',
      key: 'gone.secret',
      importance: 0.9,
      source: { raw: 'erased payload about secret sauce' },
    })
    remember(db, { scope: 'gone', owner: 'dave', text: 'kept note about the schedule', source: { raw: 'kept note' } })
    const purged = purge(db, target.id, { owner: 'dave' })
    assert.equal(purged.ok, true)

    const cfg = mergeConfig({ dbPath: join(dir, 'memory.db'), budget: 4000 })
    assert.ok(!search(db, { query: 'secret sauce', scope: 'gone', owner: 'dave' }).some((n) => n.id === target.id))
    assert.ok(!buildInjectionText({ db, config: cfg, sessionId: 'gone', query: 'secret sauce' }).text.includes('secret sauce'))
    assert.ok(!foldToMarkdown(db, { sessionId: 'gone', owner: 'dave' }).includes('secret sauce'))
    assert.ok(!buildGraph(db, { scope: 'gone', owner: 'dave' }).nodes.some((n) => n.id === target.id))
    const handoff = buildHandoff(db, { sessionId: 'gone', owner: 'dave' })
    assert.ok(handoff.ok, JSON.stringify(handoff))
    assert.ok(!handoff.facts.some((f) => f.id === target.id))
    assert.equal(provenance(db, target.id, { owner: 'dave' }), null)
    assert.equal(history(db, { key: 'gone.secret', owner: 'dave' }).length, 0)
    assert.equal(verifyPurged(db, target.id).clean, true)
  })

  t('completed mailbox entries age out; open work never does', () => {
    const done = sendMessage(db, { to: 'worker', from: 'lead', body: 'finished task', owner: 'dave' })
    assert.equal(claimMessage(db, { id: done.id, agent: 'worker', owner: 'dave' }).ok, true)
    assert.equal(completeMessage(db, { id: done.id, agent: 'worker', owner: 'dave' }).ok, true)
    const open = sendMessage(db, { to: 'worker', from: 'lead', body: 'still waiting', owner: 'dave' })
    db.prepare('update acm_mailbox set done_at = ? where id = ?').run(1000, done.id)

    const report = retentionReport(db, { owner: 'dave', policy: { mailboxDays: 0 }, now: Date.now() + 60000 })
    assert.equal(report.eligible.mailbox, 1)
    assert.equal(report.totals.openMail, 1)

    const preview = gc(db, { dryRun: true, mailboxDays: 0, now: Date.now() + 60000, owner: 'dave' })
    assert.equal(preview.mailbox, 1)
    assert.ok(db.prepare('select 1 from acm_mailbox where id = ?').get(done.id), 'dry run deleted a message')

    gc(db, { mailboxDays: 0, now: Date.now() + 60000, owner: 'dave' })
    assert.equal(db.prepare('select 1 from acm_mailbox where id = ?').get(done.id), undefined, 'a completed message survived')
    assert.ok(db.prepare('select 1 from acm_mailbox where id = ?').get(open.id), 'open work was deleted')
  })

  t('gc stays inside a partition unless it is asked to sweep everything', () => {
    const mine = remember(db, { scope: 'gcx', owner: 'gina', text: 'gina stale fact', key: 'gina.old', source: { raw: 'gina' } })
    const theirs = remember(db, { scope: 'gcx', owner: 'hank', text: 'hank stale fact', key: 'hank.old', source: { raw: 'hank' } })
    for (const id of [mine.id, theirs.id]) {
      db.prepare("update acm_nodes set status = 'superseded', created_at = ?, last_used_at = ? where id = ?").run(1000, 1000, id)
    }
    const scoped = gc(db, { owner: 'gina', days: 0, now: Date.now() + 60000 })
    assert.equal(scoped.nodes, 1)
    assert.equal(db.prepare('select 1 from acm_nodes where id = ?').get(mine.id), undefined)
    assert.ok(db.prepare('select 1 from acm_nodes where id = ?').get(theirs.id), "another partition's row was deleted")
    const swept = gc(db, { all: true, days: 0, now: Date.now() + 60000 })
    assert.ok(swept.nodes >= 1, `the sweep removed nothing: ${JSON.stringify(swept)}`)
    assert.equal(db.prepare('select 1 from acm_nodes where id = ?').get(theirs.id), undefined)
  })
  t('a session-scoped purge leaves global memories alone unless asked', () => {
    const ghost = Math.floor(Date.now() / 1000) - 86400 * 10
    const globalOld = remember(db, { scope: 'global', owner: 'gina', text: 'shared old fact', source: { raw: 'g' } })
    const sessionOld = remember(db, { scope: 'purge-s', owner: 'gina', text: 'session old fact', source: { raw: 's' } })
    for (const id of [globalOld.id, sessionOld.id]) {
      db.prepare('update acm_nodes set created_at = ? where id = ?').run(ghost, id)
    }
    const dry = purgeRange(db, { owner: 'gina', scope: 'purge-s', before: ghost + 1, dryRun: true })
    assert.equal(dry.candidates, 1, JSON.stringify(dry))
    const done = purgeRange(db, { owner: 'gina', scope: 'purge-s', before: ghost + 1 })
    assert.equal(done.deleted, 1)
    assert.ok(db.prepare('select 1 from acm_nodes where id = ?').get(globalOld.id), 'global row was swept by a session purge')
    const withGlobal = purgeRange(db, { owner: 'gina', scope: 'purge-s', before: ghost + 1, includeGlobal: true, dryRun: true })
    assert.equal(withGlobal.candidates, 1, 'the global row is only eligible when explicitly requested')
  })
  t('duplicate merging never pairs the unnamed partition with an empty-named owner', () => {
    const text = 'the same sentence lives in two partitions'
    const unnamed = remember(db, { scope: 'dup', text, key: 'dup.key', source: { raw: 'n' } })
    const emptyName = remember(db, { scope: 'dup', owner: '', text, key: 'dup.key', source: { raw: 'e' } })
    // Identical vectors, so only the owner comparison can keep them apart:
    // comparing owners as `owner ?? ""` made the two partitions look identical.
    putVector(db, unnamed.id, new Float32Array(512).fill(0.02))
    putVector(db, emptyName.id, new Float32Array(512).fill(0.02))
    const merged = mergeDuplicates(db, { dryRun: true })
    const pairs = merged.pairs ?? merged
    assert.ok(!pairs.some((p) => p.includes(Number(unnamed.id)) && p.includes(Number(emptyName.id))), JSON.stringify(pairs))
  })
  console.log(`\ngovernance: ${pass} passed`)
} finally {
  try { db.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
}
