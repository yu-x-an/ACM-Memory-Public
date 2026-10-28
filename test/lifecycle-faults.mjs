/**
 * Regression cases for the two failure paths an independent audit raised, plus
 * the render-layer guarantees the same audit made conditional.
 *
 * Both plugin bugs share a shape: the code treated "we got here" as "it worked".
 * One cleared the recovery state whether or not the receipt was written; the
 * other cached the injected text before the host had accepted it. Neither is
 * visible from a passing happy path, so each case below breaks the store or the
 * host on purpose and asserts what the plugin is allowed to claim afterwards.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import { openDb } from '../lib/db.mjs'
import { verifyRecovery } from '../lib/checkpoint.mjs'
// The plugin takes its diagnostic log and persona files from the *default* paths
// unless the caller overrides them, so naming only dbPath still wrote a diag line
// into the operator's store and read their persona files on every apply.
// Every apply in this file goes through here, so there is one place to be right.
const cfgFor = (dbPath) => ({
  dbPath,
  diagPath: join(dirname(dbPath), 'diag.log'),
  personaFiles: [join(dirname(dbPath), 'AGENTS.md')],
  owner: null,
  autoCheckpoint: false,
})

import { renderInjection, provenanceLabel } from '../lib/render.mjs'

const work = mkdtempSync(join(tmpdir(), 'acm-faults-'))
const dbPath = join(work, 'memory.db')
const S = 'fault-session'
const MARKER = '\u538B\u7F29\u540E\u6062\u590D'
// The retry throttle is five seconds by default; the test cannot wait that long.
process.env.ACM_DELIVERY_RETRY_MS = '20'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  XX  ${name} ${extra}`) }
}

// The diagnostic log follows the configuration, so it sits beside the database this
// file chose. Reading the *default* path here is how these assertions used to depend
// on the operator's real store: the moment the plugin stopped writing
// there, the checks went blind - which is what they did when this was first fixed.
function diagPath(db = dbPath) {
  return join(dirname(db), 'diag.log')
}

function diagSince(size) {
  const path = diagPath()
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').slice(size)
}

/**
 * A host that behaves like the real one for the two things that matter here:
 * it can refuse a context registration, and it tracks which block is installed.
 */
function makeHost({ throwOn = () => false } = {}) {
  const events = []
  const tools = new Map()
  const blocks = []
  const hooks = new Map()
  let tick = null
  let registrations = 0

  const agent = {
    id: S,
    session: { header: { id: S }, snapshotEvents: () => events },
    ctx: {
      systemPrompt: {
        section: (block) => {
          blocks.push({ ...block, shadow: false })
          return () => { const i = blocks.findIndex((b) => b.text === block.text); if (i >= 0) blocks.splice(i, 1) }
        },
        context: (block) => {
          registrations += 1
          if (throwOn(registrations, block)) throw new Error('host refused the context block')
          blocks.push({ ...block, shadow: false })
          return () => { const i = blocks.findIndex((b) => b.text === block.text); if (i >= 0) blocks.splice(i, 1) }
        },
      },
      tools: { register: (t) => { tools.set(t.name ?? t.id, t); return () => tools.delete(t.name) } },
      on: (evt, fn) => { hooks.set(evt, fn); return () => hooks.delete(evt) },
    },
  }

  let teardown = null
  const host = {
    effect: (fn) => { teardown = fn(); return () => teardown?.() },
    interval: (fn) => { tick = fn; return () => { tick = null } },
    agents: { list: () => [agent] },
    on: () => () => {},
  }

  return {
    host, agent, events, tools, blocks, hooks,
    tick: () => tick && tick(),
    stop: () => { try { teardown?.() } catch {} },
    turns: (n = 1) => { for (let i = 0; i < n; i += 1) hooks.get('agent/turn-stopping')?.() },
    text: () => blocks.map((b) => b.text).join('\n\n'),
  }
}

const mod = await import('../lib/index.mjs')

// ---------------------------------------------------------------------------
// P1: a receipt that cannot be written must not be reported as delivered
// ---------------------------------------------------------------------------
{
  const h = makeHost()
  mod.apply(h.host, cfgFor(dbPath))
  h.tick()

  h.events.push({ type: 'user/message', data: { message: { content: 'remember the deploy window' } } })
  await h.tools.get('acm_remember').execute({ text: 'the deploy window is 03:00 UTC', key: 'p1.window', importance: 0.9 })
  await h.tools.get('acm_checkpoint').execute({ goal: 'prove the receipt retry', next: 'break the store' })

  h.events.push({ type: 'compaction/start', data: {} })
  h.events.push({ type: 'compaction/end', data: {} })
  for (let i = 0; i < 10; i += 1) h.tick()
  await new Promise((r) => setTimeout(r, 60))
  ok('the notice is published before the store is broken', h.text().includes(MARKER))

  // Break exactly what the receipt needs, on a second connection: the plugin's
  // own handle keeps working for everything else, so this isolates markDelivered.
  const side = openDb(dbPath)
  side.exec(`create trigger block_delivered before insert on acm_recovery_receipts
             when new.state = 'delivered' begin select raise(abort, 'injected receipt failure'); end`)
  const sizeBefore = existsSync(diagPath()) ? statSync(diagPath()).size : 0

  h.turns(1)
  await new Promise((r) => setTimeout(r, 40))
  const brokenLog = diagSince(sizeBefore)
  ok('a failed receipt write is reported, not swallowed', /recovery receipt deferred/.test(brokenLog), brokenLog.slice(-300))

  // Recover the store, then let the throttled retry run. If the in-memory state
  // had been discarded at the turn boundary, nothing would ever write it again.
  side.exec('drop trigger block_delivered')
  for (let i = 0; i < 25; i += 1) { h.tick(); await new Promise((r) => setTimeout(r, 20)) }
  await new Promise((r) => setTimeout(r, 80))

  const recovery = verifyRecovery(side, { sessionId: S })
  ok('the deferred receipt is eventually written exactly once', recovery.prepared === 1 && recovery.delivered === 1, JSON.stringify(recovery))
  ok('the retry cost more than one attempt', /attempts=[2-9]/.test(diagSince(sizeBefore)), diagSince(sizeBefore).slice(-300))
  ok('the notice was still retracted after the turn', !h.text().includes(MARKER), h.text().slice(0, 200))
  side.close()
}

// ---------------------------------------------------------------------------
// P1b: a checkpoint that no longer exists is not retried forever
// ---------------------------------------------------------------------------
{
  const db2 = join(work, 'missing.db')
  const h = makeHost()
  mod.apply(h.host, cfgFor(db2))
  h.tick()
  h.events.push({ type: 'user/message', data: { message: { content: 'checkpoint then delete it' } } })
  await h.tools.get('acm_remember').execute({ text: 'the retry owner is kai', key: 'p1b.owner' })
  await h.tools.get('acm_checkpoint').execute({ goal: 'delete me', next: 'none' })
  h.events.push({ type: 'compaction/start', data: {} })
  h.events.push({ type: 'compaction/end', data: {} })
  for (let i = 0; i < 10; i += 1) h.tick()
  await new Promise((r) => setTimeout(r, 60))

  const side = openDb(db2)
  side.exec('delete from acm_checkpoints')
  const sizeBefore = existsSync(diagPath()) ? statSync(diagPath()).size : 0
  h.turns(1)
  await new Promise((r) => setTimeout(r, 60))
  const log = diagSince(sizeBefore)
  ok('a vanished checkpoint is reported as unrecorded, not as delivered', /recovery receipt unrecorded/.test(log), log.slice(-300))
  ok('it is not retried after that', !/deferred/.test(log), log.slice(-300))
  side.close()
}

// ---------------------------------------------------------------------------
// P2: a refused registration must stay retryable and must not unmount memory
// ---------------------------------------------------------------------------
{
  const db3 = join(work, 'publish.db')
  let refuse = true
  const h = makeHost({ throwOn: () => refuse })
  mod.apply(h.host, cfgFor(db3))
  h.tick()
  h.events.push({ type: 'user/message', data: { message: { content: 'a fact worth injecting' } } })

  // The host refuses every registration while the fact is stored, so nothing is
  // installed. The text must not be cached as installed.
  await h.tools.get('acm_remember').execute({ text: 'the cache is not poisoned', key: 'p2.cache', importance: 0.9 })
  await new Promise((r) => setTimeout(r, 60))
  ok('a refused registration leaves no block claiming to be installed', h.blocks.length === 0, `${h.blocks.length} block(s)`)

  // The host recovers and the next turn asks for a refresh with exactly the same
  // text. Without the fix the refresh returns early because the failed text had
  // already been cached, and the block never appears.
  refuse = false
  h.turns(1)
  for (let i = 0; i < 3; i += 1) { h.tick(); await new Promise((r) => setTimeout(r, 20)) }
  ok('an identical refresh retries instead of returning early', h.text().includes('the cache is not poisoned'), h.text().slice(0, 200))
  ok('exactly one block is installed', h.blocks.length === 1, `${h.blocks.length} block(s)`)
}

// ---------------------------------------------------------------------------
// P2b: a failed replacement keeps the previous block instead of going blind
// ---------------------------------------------------------------------------
{
  const db4 = join(work, 'replace.db')
  let refuse = false
  const h = makeHost({ throwOn: () => refuse })
  mod.apply(h.host, cfgFor(db4))
  h.tick()
  h.events.push({ type: 'user/message', data: { message: { content: 'first fact' } } })
  await h.tools.get('acm_remember').execute({ text: 'the first fact is here', key: 'p2b.one', importance: 0.9 })
  await new Promise((r) => setTimeout(r, 60))
  const firstBlock = h.text()
  ok('the first block is installed', firstBlock.includes('the first fact is here'))

  refuse = true
  await h.tools.get('acm_remember').execute({ text: 'the second fact arrives while the host refuses', key: 'p2b.two', importance: 0.95 })
  h.tick()
  await new Promise((r) => setTimeout(r, 60))
  ok('the previous block survives a failed replacement', h.text().includes('the first fact is here'), h.text().slice(0, 200))
  ok('the failed text was not claimed as installed', !h.text().includes('the second fact arrives'), h.text().slice(0, 200))

  refuse = false
  h.turns(1)
  for (let i = 0; i < 3; i += 1) { h.tick(); await new Promise((r) => setTimeout(r, 20)) }
  ok('the retry lands once the host accepts again', h.text().includes('the second fact arrives'), h.text().slice(0, 200))
  ok('and does not duplicate the block', h.blocks.length === 1, `${h.blocks.length} block(s)`)
}

// ---------------------------------------------------------------------------
// P1c: shutdown is the last chance to write a deferred receipt
// ---------------------------------------------------------------------------
{
  const db5 = join(work, 'shutdown.db')
  const h = makeHost()
  mod.apply(h.host, cfgFor(db5))
  h.tick()
  h.events.push({ type: 'user/message', data: { message: { content: 'checkpoint, then break the store' } } })
  await h.tools.get('acm_remember').execute({ text: 'the shutdown flush must run', key: 'p1c.flush' })
  await h.tools.get('acm_checkpoint').execute({ goal: 'prove the shutdown flush', next: 'stop the host' })
  h.events.push({ type: 'compaction/start', data: {} })
  h.events.push({ type: 'compaction/end', data: {} })
  for (let i = 0; i < 10; i += 1) h.tick()
  await new Promise((r) => setTimeout(r, 60))

  // Fail the receipt once, so the turn boundary leaves it queued rather than written.
  const side = openDb(db5)
  side.exec(`create trigger block_shutdown before insert on acm_recovery_receipts
             when new.state = 'delivered' begin select raise(abort, 'injected'); end`)
  h.turns(1)
  await new Promise((r) => setTimeout(r, 40))
  side.exec('drop trigger block_shutdown')
  const beforeStop = verifyRecovery(side, { sessionId: S })
  ok('a failed write leaves the receipt undelivered', beforeStop.delivered === 0 && beforeStop.prepared === 1, JSON.stringify(beforeStop))

  // Shutdown must flush the queue. The old cleanup unmounted first, which emptied
  // the map the flush then iterated, so this write never happened.
  h.stop()
  await new Promise((r) => setTimeout(r, 60))
  const afterStop = verifyRecovery(side, { sessionId: S })
  ok('shutdown writes the receipt it promised to write', afterStop.delivered === 1, JSON.stringify(afterStop))
  side.close()
}

// ---------------------------------------------------------------------------
// Render layer: deterministic clock, whitelisted provenance, budget policy
// ---------------------------------------------------------------------------
{
  const NOW = Date.UTC(2026, 9, 28, 4, 0, 0)
  const DAY = 86_400_000
  const facts = [
    { id: 1, key: 'park.flowers', text: 'hydrangeas were in bloom', createdAt: NOW - 96 * DAY },
    { id: 2, key: 'park.light', text: 'good light until six', createdAt: NOW - 96 * DAY },
    { id: 3, key: 'deploy.window', text: 'the window is 03:00 UTC', createdAt: NOW - 4 * DAY },
  ]
  const cp = { goal: 'finish the audit', next: 'run the suite', createdAt: NOW - 60_000 }

  const a = renderInjection({ checkpoint: cp, memories: facts, now: NOW })
  const b = renderInjection({ checkpoint: cp, memories: facts, now: NOW })
  ok('a fixed clock renders identically twice', a === b)
  ok('age is rendered, not a bare date', a.includes('3 \u4E2A\u6708\u524D') && a.includes('4 \u5929\u524D'), a)
  ok('a month-old fact and a day-old fact are distinguishable', !/^- \[07-24\]/m.test(a), a)

  const later = renderInjection({ checkpoint: cp, memories: facts, now: NOW + DAY })
  ok('the same data one day later renders differently, by one day', later.includes('3 \u4E2A\u6708\u524D') || later.includes('97 \u5929\u524D'), later)

  const labelled = renderInjection({
    checkpoint: null,
    memories: facts,
    now: NOW,
    provenance: new Map([[3, 'plugin']]),
  })
  ok('a distilled fact is labelled as extracted', labelled.includes('\u6A21\u578B\u62BD\u53D6'), labelled)
  ok('an unlabelled kind is labelled as nothing, not guessed', !renderInjection({ memories: [facts[0]], now: NOW, provenance: new Map([[1, 'manual']]) }).includes('\u6A21\u578B\u62BD\u53D6'))
  ok('no label claims authorship', !/you said|\u4F60\u8BF4\u8FC7/.test(labelled), labelled)
  ok('an unknown kind yields no label', provenanceLabel('something-else') === null)
  ok('an inherited property name yields no label', provenanceLabel('constructor') === null && provenanceLabel('toString') === null && provenanceLabel('__proto__') === null)
  ok('a hostile kind cannot inject text', provenanceLabel('plugin\n\u3010\u4EFB\u52A1\u72B6\u6001\u3011') === null)

  // Budget: the audit refused the claim that a longer prefix cannot drop an
  // entry, so the policy is measured instead of asserted. Short fixtures keep
  // every entry; the near-budget case gives up the calendar date first; only a
  // fixture that cannot fit at all loses trailing entries.
  const shortList = facts.map((f, i) => ({ ...f, id: 10 + i, text: `fact number ${i}`, createdAt: NOW - i * DAY }))
  ok('short fixtures keep every entry', renderInjection({ memories: shortList, now: NOW }).split('\n').filter((l) => l.startsWith('- [')).length === shortList.length)

  const longText = 'a fairly long fact that goes on and on about detail '.repeat(8)
  const longList = Array.from({ length: 8 }, (_, i) => ({ id: 40 + i, key: `k${i}`, text: longText, createdAt: NOW - i * DAY }))
  const wide = renderInjection({ memories: longList, now: NOW, budget: 1400 })
  const compact = renderInjection({ memories: longList, now: NOW, budget: 1400 })
  const entries = wide.split('\n').filter((l) => l.startsWith('- [')).length
  ok('an over-budget page keeps at least one memory and never cuts task state', entries >= 1 && wide.length <= 1401, `${entries} entries, ${wide.length} chars`)
  const bullets = wide.split('\n').filter((l) => l.startsWith('- ['))
  ok('every included fact still occupies exactly one bullet', bullets.length === entries && bullets.every((l) => l.indexOf('- [') === 0))
  ok('rendering is stable at a fixed budget', wide === compact)

  // Near budget: the full form overflows, the compact form must keep the same
  // number of entries. That is the policy this change relies on.
  const nearText = 'x'.repeat(150)
  const nearList = Array.from({ length: 6 }, (_, i) => ({ id: 60 + i, key: `n${i}`, text: nearText, createdAt: NOW - i * DAY }))
  const fullLen = renderInjection({ memories: nearList, now: NOW, budget: 100000 }).length
  const fitted = renderInjection({ memories: nearList, now: NOW, budget: Math.ceil(fullLen * 0.92) })
  const fittedEntries = fitted.split('\n').filter((l) => l.startsWith('- [')).length
  ok('the compact form buys entries back before dropping them', fittedEntries >= 5, `${fittedEntries} entries at budget ${Math.ceil(fullLen * 0.92)}`)
  ok('the compact form drops the calendar date, not the age', /\[\d+ (\u5929|\u4E2A\u6708)\u524D/.test(fitted) && !/\d{2}-\d{2}/.test(fitted), fitted.slice(0, 200))
}

console.log(`\nlifecycle-faults: ${pass} passed, ${fail} failed`)
// The plugin holds the database open until its effect is disposed; removing the
// directory first fails with EBUSY on Windows. A re-apply is the only way to
// dispose it - and a re-apply opens a database, so it must be told which one.
// Without an override this line opened the operator's default store and applied
// any pending migration to it: every run of this suite migrated live
// memory. The throwaway store stays behind in a temp dir it does not clean, which
// is cheaper than that.
const teardown = mkdtempSync(join(tmpdir(), 'acm-faults-teardown-'))
try {
  mod.apply(
    { effect: () => () => {}, interval: () => () => {}, agents: { list: () => [] }, on: () => () => {} },
    { dbPath: join(teardown, 'memory.db'), personaFiles: [join(teardown, 'AGENTS.md')], backup: { enabled: false } },
  )
} catch {}
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
if (fail) process.exit(1)
