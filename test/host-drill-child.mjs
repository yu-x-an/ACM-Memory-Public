/**
 * One host lifecycle, executed in its own process by test/host-drill.mjs.
 *
 * This file *is* the host: it supplies effect/interval/agents/systemPrompt/tools
 * and dispatches the turn-boundary hook the way a real host does, so the plugin
 * runs unmodified. Every phase is a separate process, which is the only thing
 * that makes "restart" a restart instead of a function call, and a killed process
 * the only thing that makes a crash a crash.
 *
 * Usage: node test/host-drill-child.mjs <phase> <dbPath> <sessionId> <fact>
 *   phase: seed | resume | crash
 */
import { dirname, join } from 'node:path'

const [phase, dbPath, sessionId, fact] = process.argv.slice(2)

const events = []
const tools = new Map()
const blocks = []
const hooks = new Map()
let tick = null

const agent = {
  id: sessionId,
  session: { header: { id: sessionId }, snapshotEvents: () => events },
  ctx: {
    systemPrompt: {
      section: (block) => {
        blocks.push(block)
        return () => {
          const i = blocks.indexOf(block)
          if (i >= 0) blocks.splice(i, 1)
        }
      },
      context: (block) => {
        blocks.push(block)
        return () => {
          const i = blocks.indexOf(block)
          if (i >= 0) blocks.splice(i, 1)
        }
      },
    },
    tools: {
      register: (t) => {
        tools.set(t.name ?? t.id, t)
        return () => tools.delete(t.name)
      },
    },
    on: (evt, fn) => {
      hooks.set(evt, fn)
      return () => hooks.delete(evt)
    },
  },
}

const host = {
  effect: (fn) => fn(),
  interval: (fn) => {
    tick = fn
    return () => { tick = null }
  },
  agents: { list: () => [agent] },
  on: () => () => {},
}

// A resumed session replays its history, including the compaction that ended it.
// That replay is exactly what a real host hands back after a restart, and it is
// where a "deliver the recovery twice" bug would show up.
if (phase === 'resume' || phase === 'crash') {
  events.push({ type: 'user/message', data: { message: { content: `where did we stop with ${fact}` } } })
}
if (phase === 'resume') {
  events.push({ type: 'compaction/start', data: {} })
  events.push({ type: 'compaction/summary', data: { summary: 'compacted' } })
  events.push({ type: 'compaction/end', data: {} })
}

const mod = await import('../lib/index.mjs')
// Name the diagnostic log and persona files too: dbPath alone still sent the
// plugin's diag line to the operator's default store and read their persona files
// on every apply.
mod.apply(host, {
  dbPath,
  diagPath: join(dirname(dbPath), 'diag.log'),
  personaFiles: [join(dirname(dbPath), 'AGENTS.md')],
  owner: null,
  autoCheckpoint: false,
})
if (typeof tick === 'function') tick()

const text = () => blocks.map((b) => b.text).join('\n')
const settle = () => new Promise((r) => setTimeout(r, 80))
const turn = () => {
  const fn = hooks.get('agent/turn-stopping')
  if (typeof fn === 'function') fn()
}
const done = (payload) => {
  // The plugin logs diagnostics; the driver reads the last line only.
  console.log(JSON.stringify({ phase, ...payload }))
}

if (phase === 'seed') {
  events.push({ type: 'user/message', data: { message: { content: `remember this: ${fact}` } } })
  const remember = tools.get('acm_remember')
  const checkpoint = tools.get('acm_checkpoint')
  if (!remember || !checkpoint) {
    done({ error: 'tools missing', tools: [...tools.keys()] })
    process.exit(0)
  }
  await remember.execute({ text: fact, importance: 0.9, source: 'host drill', key: 'drill.fact' })
  await checkpoint.execute({ goal: 'prove restart continuity', next: 'restart the host' })

  events.push({ type: 'compaction/start', data: {} })
  events.push({ type: 'compaction/summary', data: { summary: 'context compacted' } })
  events.push({ type: 'compaction/end', data: {} })
  for (let i = 0; i < 10; i += 1) tick()
  await settle()

  // What the model would read at the start of the next turn.
  const beforeTurn = text()
  // Let that turn finish; the notice is supposed to be retracted by then.
  turn()
  await settle()
  const afterTurn = text()

  done({
    toolCount: tools.size,
    contexts: blocks.length,
    injection: beforeTurn,
    noticeBeforeTurn: beforeTurn.includes(recoveryMarker()),
    noticeAfterTurn: afterTurn.includes(recoveryMarker()),
    injectionAfterTurn: afterTurn,
  })
} else if (phase === 'resume') {
  for (let i = 0; i < 2; i += 1) tick()
  await settle()
  const first = text()
  const afterCompactionReplay = []
  // Three more turns: a replayed compaction must not raise the notice again, and
  // the injected block must not stack.
  for (let i = 0; i < 3; i += 1) {
    turn()
    for (let j = 0; j < 10; j += 1) tick()
    await settle()
    afterCompactionReplay.push(text())
  }
  done({
    toolCount: tools.size,
    contexts: blocks.length,
    injection: first,
    notice: first.includes(recoveryMarker()),
    noticeLater: afterCompactionReplay.some((t) => t.includes(recoveryMarker())),
    afterTurns: afterCompactionReplay.at(-1) ?? '',
  })
} else if (phase === 'crash') {
  const remember = tools.get('acm_remember')
  if (remember) await remember.execute({ text: fact, importance: 0.9, source: 'crash drill', key: 'drill.crash' })
  // No cleanup, no db.close(), no flush: the host died between two operations.
  process.kill(process.pid, 'SIGKILL')
} else {
  done({ error: `unknown phase ${phase}` })
  process.exit(2)
}

/** The notice wording lives in the renderer; keep the check next to its source. */
function recoveryMarker() {
  return '\u538B\u7F29\u540E\u6062\u590D'
}
