/**
 * Host lifecycle drill: compaction, restart and crash, across real processes.
 *
 * The live-host gap and the durability gap both need the same missing evidence: what happens to facts
 * and to the recovery handshake when a host compacts the context, shuts down and
 * comes back - and when it dies mid-operation. A single-process test cannot
 * answer that: it reuses module state, an open database handle and an in-memory
 * event log, all three of which a restart destroys.
 *
 * So this file writes down the host contract and runs it: the child process
 * supplies effect/interval/agents/systemPrompt/tools and dispatches the
 * turn-boundary hook, and each phase is a fresh process against the same database.
 *
 * What this proves: the plugin's lifecycle, the durability of SQLite writes, the
 * recovery receipt bookkeeping and the absence of duplicate or late-then-lost
 * injection across a real process boundary.
 * What it does not prove: that a real model turns these facts into model-visible
 * context, or that a specific host emits the same event shapes DSH does. Those
 * stay labelled as a live-host drill in the project's issue log, not in this file.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDb } from '../lib/db.mjs'
import { verifyRecovery } from '../lib/checkpoint.mjs'

const child = fileURLToPath(new URL('./host-drill-child.mjs', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'acm-host-drill-'))
const dbPath = join(work, 'memory.db')
const sessionId = 'drill-session'
const fact = 'the deploy window is 03:00 UTC'
const crashFact = 'the rollback owner is dana'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  XX  ${name} ${extra}`) }
}

function runPhase(phase, text = fact) {
  const res = spawnSync(process.execPath, [child, phase, dbPath, sessionId, text], {
    encoding: 'utf8',
    timeout: 120000,
  })
  const line = (res.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '{}'
  let payload = {}
  try { payload = JSON.parse(line) } catch { payload = { parseError: line.slice(0, 200) } }
  return { status: res.status, signal: res.signal, payload, stderr: (res.stderr ?? '').slice(-400) }
}

function countNodes(text) {
  const db = openDb(dbPath)
  try {
    return Number(db.prepare('select count(*) c from acm_nodes where text = ? and owner is null').get(text).c)
  } finally {
    db.close()
  }
}

function recovery() {
  const db = openDb(dbPath)
  try {
    return verifyRecovery(db, { sessionId })
  } finally {
    db.close()
  }
}

// ---- Phase 1: a session stores a fact and a checkpoint, then gets compacted ---
const seed = runPhase('seed')
ok('the plugin mounts in a host it has never seen', seed.status === 0 && (seed.payload.toolCount ?? 0) >= 4, `status=${seed.status} ${JSON.stringify(seed.payload).slice(0, 200)}`)
ok('the stored fact reaches the injected block', String(seed.payload.injection ?? '').includes(fact), `injection=${String(seed.payload.injection ?? '').slice(0, 200)}`)
ok('the next turn would read the compaction notice', seed.payload.noticeBeforeTurn === true, `notice=${seed.payload.noticeBeforeTurn}`)
ok('the notice is retracted once that turn ends', seed.payload.noticeAfterTurn === false, `notice=${seed.payload.noticeAfterTurn}`)
ok('the retraction does not drop the fact', String(seed.payload.injectionAfterTurn ?? '').includes(fact), String(seed.payload.injectionAfterTurn ?? '').slice(0, 200))
ok('the fact is written once, not twice', countNodes(fact) === 1, `count=${countNodes(fact)}`)
ok('delivery is recorded only after a turn saw the notice', recovery().delivered === 1, JSON.stringify(recovery()))

// ---- Phase 2: the host restarts; the session history is replayed ------------
const resume = runPhase('resume')
ok('the restarting host still gets its tools', resume.status === 0 && (resume.payload.toolCount ?? 0) >= 4, `status=${resume.status}`)
const resumedInjection = String(resume.payload.injection ?? '')
ok('the fact survives a process restart', resumedInjection.includes(fact), `injection=${resumedInjection.slice(0, 300)}`)
ok('the checkpoint survives a process restart', resumedInjection.includes('\u4EFB\u52A1\u72B6\u6001'), resumedInjection.slice(0, 300))
ok('a replayed compaction is not delivered a second time', resume.payload.notice === false && resume.payload.noticeLater === false, `notice=${resume.payload.notice} later=${resume.payload.noticeLater}`)
ok('the injected block is not stacked after a restart', resume.payload.contexts === 1, `contexts=${resume.payload.contexts}`)
ok('the fact is still stored exactly once', countNodes(fact) === 1, `count=${countNodes(fact)}`)

// ---- Receipts: one prepared, at most one delivered, across both processes ---
{
  const state = recovery()
  ok('recovery receipts are consistent after a restart', state.ok && state.prepared === 1 && state.delivered === 1, JSON.stringify(state))
  ok('no receipt points at a checkpoint that no longer exists', state.orphans === 0, JSON.stringify(state))
}

// ---- Phase 3: the host is killed between two operations ---------------------
const crash = runPhase('crash', crashFact)
ok('the crash phase really died instead of exiting', crash.status !== 0 || crash.signal !== null, `status=${crash.status} signal=${crash.signal}`)
const walLeft = existsSync(`${dbPath}-wal`) && statSync(`${dbPath}-wal`).size > 0
{
  const db = openDb(dbPath)
  try {
    const integrity = db.prepare('pragma integrity_check').get()
    ok('the database still opens and passes integrity_check', Object.values(integrity)[0] === 'ok', JSON.stringify(integrity))
  } finally {
    db.close()
  }
  const state = recovery()
  ok('a crash does not fake a completion', state.delivered <= 1 && state.prepared <= 1 && state.orphans === 0, JSON.stringify(state))
  ok('a write committed before the crash survives it', countNodes(crashFact) === 1, `count=${countNodes(crashFact)} walLeft=${walLeft}`)
  ok('the crash did not duplicate the earlier fact', countNodes(fact) === 1, `count=${countNodes(fact)}`)
}

rmSync(work, { recursive: true, force: true })

console.log(`\nhost-drill: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
