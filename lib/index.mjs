// DSH ACM \u8BB0\u5FC6 - \u5BBF\u4E3B\u534A\u8FB9
//
// \u4E00\u6761\u6D41\u6C34\u7EBF\uFF0C\u4E09\u6837\u4E1C\u897F\u5206\u5F00\u653E\uFF1A
//   \u4EBA\u683C   ->\u53EA\u8BFB AGENT.md / \u4EBA\u8BBE\u6587\u4EF6\uFF0C\u6539\u52A8\u8BB0\u63D0\u6848\uFF08\u4E0D\u8FDB DB \u5B58\u539F\u6587\u5F53\u4EBA\u683C\uFF09
//   \u4E8B\u5B9E   ->SQLite \u8282\u70B9 + \u6765\u6E90 + \u8FB9\uFF0C\u6BCF\u6761\u90FD\u80FD\u56DE\u7B54"\u51ED\u4EC0\u4E48\u8BB0\u5F97"
//   \u4EFB\u52A1   ->checkpoint\uFF0C\u538B\u7F29\u540E\u5B9A\u5411\u635E\u56DE\u6765\uFF0C\u5E26\u56DE\u6267
//
// \u6CE8\u5165\u53EA\u6709\u4E00\u4E2A\u5165\u53E3\uFF08systemPrompt.context\uFF09\uFF0C\u4EBA\u683C\u662F\u9759\u6001 section\uFF08\u524D\u7F00\u4E0D\u5403\u7F13\u5B58\uFF09\u3002

import { mkdirSync, appendFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { openDb, metaGet, metaSet } from './db.mjs'
import { backupIfDue } from './backup.mjs'
import { foldToMarkdown } from './fold.mjs'
import { gc, stats, touch } from './memory.mjs'
import { markDelivered, saveOrUpdateAuto, scanCompactions } from './checkpoint.mjs'
import { decideProposal, loadPersona, pendingProposals } from './persona.mjs'
import { normalize } from './text.mjs'
import { redact } from './redact.mjs'
import { collectTurn, distillOnce, DISTILL_DEFAULT } from './distill.mjs'
import { loadHostDeps } from './hostdeps.mjs'
import { embedMissing } from './embed.mjs'
import { expireLeases } from './tasks.mjs'
import { buildGraph, renderGraphHtml } from './graph.mjs'
import { evolve, evolutionLog, renderEvolution } from './evolve.mjs'
import { CONFIG_DEFAULT as CORE_DEFAULT, TOOLS, buildInjectionText, buildInjectionTextAsync, mergeConfig } from './core.mjs'

export const name = 'acm-memory'
export const inject = ['systemPrompt', 'agents', 'timer', 'tools', 'llm']

// webServer is deliberately not injected: a profile without an HTTP surface
// (headless, tui) would otherwise keep this plugin pending forever and the
// memory tools would simply not exist there. Routes are registered only when
// the host exposes the service and the operator opted in.

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool

// \u5BBF\u4E3B\u76F8\u5173\u7684\u90A3\u51E0\u9879\uFF1B\u5176\u4F59\u9ED8\u8BA4\u503C\u90FD\u5728 core.mjs\uFF0C\u522B\u5728\u4E24\u5904\u5404\u5199\u4E00\u4EFD
const HOST_DEFAULT = {
  autoCheckpoint: true,
  distill: { ...DISTILL_DEFAULT },
  mountOrderDynamic: 900,
  mountOrderStatic: 89990,
}

const CONFIG_DEFAULT = { ...CORE_DEFAULT, ...HOST_DEFAULT }

/**
 * Redaction for text that reaches the prompt. Module-level because both the
 * turn hooks and the HTTP handlers need it; a per-apply closure left the
 * auto-checkpoint path referencing an undefined name, and its try/catch hid it.
 */
const redactValue = (v) => (CONFIG.redact?.enabled ? redact(v, CONFIG.redact).text : v)

function diag(msg) {
  try {
    appendFileSync(CONFIG.diagPath, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

let CONFIG = { ...CONFIG_DEFAULT }

function readConfig(overrides = {}) {
  const o = overrides ?? {}
  CONFIG = {
    ...mergeConfig(o),
    ...HOST_DEFAULT,
    autoCheckpoint: o.autoCheckpoint ?? HOST_DEFAULT.autoCheckpoint,
    distill: { ...DISTILL_DEFAULT, ...(o.distill ?? {}) },
    mountOrderDynamic: o.mountOrderDynamic ?? HOST_DEFAULT.mountOrderDynamic,
    mountOrderStatic: o.mountOrderStatic ?? HOST_DEFAULT.mountOrderStatic,
  }
  // Create only the directories this configuration actually uses. The old line
  // created the operator's default store on every apply, even when dbPath and
  // diagPath pointed somewhere disposable - which is how a suite that names its own
  // database still touched the real store.
  try { mkdirSync(dirname(CONFIG.diagPath), { recursive: true }) } catch {}
  return CONFIG
}

// Do not open a database at module import time: DSH configuration arrives in apply(ctx).
let db = null

// \u6BCF\u4E2A agent \u5B9E\u4F8B\u7684\u72B6\u6001\uFF08\u5B9E\u4F8B\u4F1A\u88AB\u6362\u6389\uFF0C\u6240\u4EE5\u6309\u5B9E\u4F8B\u91CD\u6302\uFF09
const mounted = new Map()
let rootCtx = null
let appliedCleanup = null
const routeDisposers = []

function sessionIdOf(agent) {
  return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id ?? 'unknown'
}

function eventsOf(agent) {
  const s = agent?.session
  if (!s) return null
  for (const fn of ['snapshotEvents', 'events', 'log', 'getEvents']) {
    try {
      if (typeof s[fn] === 'function') {
        const got = s[fn]()
        if (Array.isArray(got)) return got
      }
    } catch {}
  }
  return null
}

function lastUserText(agent) {
  const events = eventsOf(agent)
  if (!events) return ''
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if ((ev?.type ?? ev?.kind) !== 'user/message') continue
    const msg = ev?.data?.message ?? ev?.data ?? ev?.message
    const content = msg?.content
    if (typeof content === 'string') return normalize(content)
    if (Array.isArray(content)) {
      const text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ')
      if (text.trim()) return normalize(text)
    }
  }
  return ''
}

function publishDynamic(state, { text, cp, recovering, hits }) {
  // A re-apply unmounts the old state before closing its database. An async
  // refresh that was already in flight could otherwise register a block on an
  // agent that no longer exists, using a closed handle.
  if (mounted.get(state.agent) !== state) return false
  if (text === state.lastText) return true
  const previous = state.disposeDynamic
  let previousDisposed = false
  const disposePrevious = () => {
    if (previousDisposed) return
    previousDisposed = true
    if (typeof previous !== 'function') return
    try { previous() } catch {}
  }
  const register = (value = text) => state.agent.ctx.systemPrompt.context({
    name: 'acm-memory',
    order: CONFIG.mountOrderDynamic,
    text: value,
  })

  let installed = null
  if (text) {
    try {
      // Swap, do not clear first: a host that refuses the new block must not cost
      // the turn the block it already had.
      installed = register()
    } catch (err) {
      state.publishFailures = (state.publishFailures ?? 0) + 1
      if (previous) {
        // Keep what is installed and retry on the next refresh. On a host that
        // refuses a second block under the same name this means the injected
        // block stays one version behind rather than disappearing; the operator
        // can force remove-then-add with ACM_CONTEXT_FORCE_REPLACE=1.
        diag(`context swap refused: ${err?.message ?? err} failures=${state.publishFailures}; keeping the previous block`)
        if (process.env.ACM_CONTEXT_FORCE_REPLACE === '1') {
          disposePrevious()
          state.disposeDynamic = null
          try {
            installed = register()
            diag('context replaced after a forced remove-then-add')
          } catch (err2) {
            diag(`context replace failed: ${err2?.message ?? err2}`)
            return false
          }
        } else {
          return false
        }
      } else {
        // Nothing was installed, so there is nothing to preserve or remove.
        diag(`context register failed: ${err?.message ?? err} failures=${state.publishFailures}`)
        return false
      }
    }
  }

  state.disposeDynamic = installed
  disposePrevious()
  state.lastText = text
  state.publishFailures = 0
  if (hits?.length) { try { touch(db, hits.map((h) => h.id)) } catch {} }
  // Remember which checkpoint the notice is about. Delivery is recorded at the
  // turn boundary, not here: publishing is immediately followed by this same
  // refresh's async result, which rebuilds the text without the notice and
  // replaces it inside the same tick. Marking it delivered here claimed a
  // delivery the model had not read yet.
  if (recovering && cp) state.recoveryCpId = cp.id
  return true
}

/** Lexical-only build, synchronous: used to seed the very first turn. */
function buildContextTextSync(state) {
  try {
    const r = buildInjectionText({
      db,
      config: CONFIG,
      sessionId: state.sessionId,
      query: lastUserText(state.agent),
      recovering: state.needsRecovery,
    })
    if (r.hits.length) state.lastRecalled = r.hits.map((h) => h.id)
    return { text: r.text, cp: r.checkpoint, recovering: r.recovering, hits: r.hits }
  } catch (err) {
    diag(`injection seed failed: ${err?.message ?? err}`)
    // A failed build is not "there is nothing to inject". Returning an empty
    // string here used to retract the block that was already installed, which
    // turned a transient read error into silent memory loss.
    return null
  }
}

async function buildContextText(state, agent) {
  const sid = state.sessionId
  try {
    const args = {
      db,
      config: CONFIG,
      sessionId: sid,
      query: lastUserText(agent),
      recovering: state.needsRecovery,
    }
    // The tool surface ranks with hybrid recall; injection now uses the same
    // ranker unless the operator opts out. Missing model files or a broken
    // runtime degrade to lexical recall inside buildInjectionTextAsync.
    const useHybrid = CONFIG.embed?.enabled === true && CONFIG.embed?.inject !== false
    const r = useHybrid ? await buildInjectionTextAsync(args) : buildInjectionText(args)
    if (r.hits.length) state.lastRecalled = r.hits.map((h) => h.id)
    return { text: r.text, cp: r.checkpoint, recovering: r.recovering, hits: r.hits }
  } catch (err) {
    diag(`injection build failed: ${err?.message ?? err}`)
    return null
  }
}

/**
 * Rebuild the injected context. Async because hybrid recall may load the model.
 *
 * Refreshes can overlap (an inbox event and a turn-end can both fire), so each
 * run takes a sequence number and only the newest one is allowed to publish.
 * Without that guard a slower lexical result could overwrite a newer hybrid one.
 */
async function refreshDynamic(state) {
  const seq = (state.refreshSeq = (state.refreshSeq ?? 0) + 1)
  const r = await buildContextText(state, state.agent)
  if (seq !== state.refreshSeq) return
  if (!r) {
    diag('injection rebuild failed; keeping the installed block')
    return
  }
  publishDynamic(state, r)
}

/**
 * Refresh the injected block. Publishes a lexical result immediately so the
 * current turn always sees memory, then upgrades to hybrid ranking in the
 * background. Fire-and-forget because host hooks cannot await us, and a failed
 * refresh must never break a turn.
 */
function requestRefresh(state) {
  const seeded = buildContextTextSync(state)
  if (seeded) publishDynamic(state, seeded)
  refreshDynamic(state).catch((err) => diag(`refresh failed: ${err?.message ?? err}`))
}

function mountStatic(state) {
  const persona = loadPersona(db, CONFIG.personaFiles, { owner: CONFIG.owner ?? null })
  if (persona.changed.length) {
    for (const c of persona.changed) diag(`persona changed: ${c.path} ${c.diff}`)
  }
  if (!persona.text) return
  const lines = ['\u3010\u4EBA\u683C\u6587\u4EF6\uFF08\u53EA\u8BFB\uFF09\u3011', persona.text]
  if (persona.changed.length) lines.unshift('\uFF08\u4EBA\u8BBE\u6587\u4EF6\u521A\u88AB\u6539\u8FC7\uFF0C\u7B49\u4F60\u786E\u8BA4\u3002\uFF09')
  try {
    state.disposeStatic = state.agent.ctx.systemPrompt.section({
      name: 'acm-persona',
      order: CONFIG.mountOrderStatic,
      text: lines.join('\n'),
    })
  } catch (err) {
    diag(`section register failed: ${err?.message ?? err}`)
  }
}

// \u5DE5\u5177\u53EA\u5728 core.mjs \u5B9A\u4E49\u4E00\u6B21\uFF0C\u8FD9\u91CC\u53EA\u628A\u5B83\u63A5\u4E0A\u53BB + \u52A0\u4E00\u4E2A\u53EA\u6709 DSH \u80FD\u505A\u7684\u84B8\u998F

/**
 * Turn the tool's declared parameters into the JSON Schema the host validates.
 *
 * The host rejects a non-schema outright (JsonSchemaError), so the shape has to
 * be built rather than passed through.
 */
function jsonSchemaOf(parameters = {}) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(parameters)) {
    properties[k] = { type: v.type ?? 'string', ...(v.description ? { description: v.description } : {}) }
    if (v.items) properties[k].items = v.items
    if (v.required) required.push(k)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

let pluginToolsRegistered = false

/**
 * Register the tool surface on the plugin-level service, once per apply.
 *
 * A host that creates its agent after apply() freezes its tool list at agent
 * creation, so a per-agent registration never reaches the model - a real
 * headless run showed exactly that. Registering here happens before any agent
 * exists, and the handler resolves the live session when it is called.
 */
function registerPluginTools(ctx) {
  if (pluginToolsRegistered) return
  const registry = ctx?.tools
  if (!registry || typeof registry.register !== 'function') return
  pluginToolsRegistered = true
  for (const spec of TOOLS) {
    try {
      const off = registry.register({
        name: spec.name,
        description: spec.description,
        parameters: jsonSchemaOf(spec.parameters),
        // The host validates the returned value against this schema and renders
        // it through the function below; a bare array fails validation.
        output: {
          schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
          render: (args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        execute: async (args) => {
          const state = [...mounted.values()][0] ?? null
          const sessionId = state?.sessionId ?? 'unknown'
          const out = await spec.run(args ?? {}, { db, config: CONFIG, sessionId })
          return { text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }
        },
      })
      if (typeof off === 'function') routeDisposers.push(off)
    } catch (err) {
      diag(`tool register failed: ${err?.message ?? err}`)
    }
  }
  diag(`plugin tools registered: ${TOOLS.length}`)
}

function registerTools(state) {
  const agent = state.agent
  const reg = (tool) => {
    try {
      // Register on the plugin-level service when the host exposes one: a host
      // that creates its agent after apply() would otherwise build the first turn
      // without these tools. The disposer semantics are the same.
      const registry = (rootCtx && typeof rootCtx.tools?.register === 'function') ? rootCtx.tools : agent.ctx.tools
      const off = registry.register(tool)
      if (typeof off === 'function') state.disposers.push(off)
    } catch (err) {
      diag(`tool register failed: ${err?.message ?? err}`)
    }
  }

  for (const spec of TOOLS) {
    reg(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: spec.output,
      async execute(args) {
        const r = await spec.run(args ?? {}, { db, config: CONFIG, sessionId: state.sessionId })
        requestRefresh(state)
        return r
      },
    }))
  }

  reg(defineTool({
    name: 'acm_distill',
    description: '\u624B\u52A8\u84B8\u998F\u4E00\u6B21\uFF1A\u628A\u8FD8\u6CA1\u70BC\u8FC7\u7684\u539F\u8BDD\u4EA4\u7ED9\u6A21\u578B\u62BD\u6210\u8BB0\u5FC6\u8282\u70B9\uFF08\u5E73\u65F6\u6BCF\u8F6E\u6536\u5C3E\u81EA\u52A8\u8DD1\uFF0C\u8FD9\u4E2A\u7528\u6765\u7ACB\u523B\u8865\u4E00\u6B21\uFF09\u3002',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          facts: { type: 'number' },
          written: { type: 'number' },
          error: { type: 'string' },
          skipped: { type: 'string' },
        },
      },
      render(_a, v) {
        if (v.skipped) return `\u6CA1\u62BD\uFF1A${v.skipped}`
        if (v.error) return `\u6CA1\u62BD\u6210\uFF1A${v.error}`
        return `\u62BD\u5230 ${v.facts} \u6761\uFF0C\u5199\u8FDB ${v.written} \u6761`
      },
    },
    async execute() {
      const r = await runDistill(state)
      return {
        facts: r.facts?.length ?? 0,
        written: r.written ?? 0,
        error: r.error ?? '',
        skipped: r.skipped ?? '',
      }
    },
  }))
}

// \u84B8\u998F\uFF1A\u8F6E\u6B21\u6536\u5C3E\u540E\u8FC7\u4E00\u4F1A\u513F\u518D\u8DD1\uFF0C\u4E0D\u5728\u70ED\u8DEF\u5F84\u4E0A\uFF0C\u4E0D\u6321\u4E0B\u4E00\u53E5\u8BDD
function scheduleDistill(state) {
  const cfg = CONFIG.distill
  if (!cfg?.enabled) return
  if (state.distillTimer) { try { clearTimeout(state.distillTimer) } catch {} }
  state.distillTimer = setTimeout(() => {
    state.distillTimer = null
    runDistill(state).catch((err) => diag(`distill: ${err?.message ?? err}`))
  }, Math.max(0, Number(cfg.delayMs ?? 1200)))
  try { state.distillTimer?.unref?.() } catch {}
}

async function runDistill(state) {
  const cfg = CONFIG.distill
  if (!cfg?.enabled) return { skipped: 'off' }
  if (state.distilling) return { skipped: 'busy' }

  let events
  try { events = eventsOf(state.agent) } catch { return { skipped: 'no-events' } }
  if (!events) return { skipped: 'no-events' }

  const { text, seq, cursor } = collectTurn(events, state.distillCursor, cfg)
  if (!text) return { skipped: 'empty' }
  if (!state.lastDistill?.error && state.lastDistill?.text === text) return { skipped: 'same' }

  state.distilling = true
  try {
    const r = await distillOnce({
    owner: CONFIG.owner ?? null,
      ctx: rootCtx,
      agent: state.agent,
      db,
      sessionId: state.sessionId,
      snippet: text,
      seq,
      createUserMessage: hostDeps.createUserMessage,
      config: cfg,
      redact: CONFIG.redact,
      diag,
    })
    // Commit only after a successful LLM call and all fact writes. A malformed
    // reply is not a success: advancing the cursor there would drop that span
    // for good, because nothing would ever retry it.
    const failed = Boolean(r.error) || r.ok === false
    if (!failed) {
      state.distillCursor = cursor
      metaSet(db, `distill_cursor:${CONFIG.owner ?? ''}:${state.sessionId}`, cursor)
    }
    state.lastDistill = {
      at: Date.now(),
      chars: text.length,
      facts: r.facts?.length ?? 0,
      written: r.written ?? 0,
      error: r.error ?? r.reason ?? null,
      text, // \u53EA\u7528\u6765\u6BD4\u5BF9\u6709\u6CA1\u6709\u65B0\u8BDD
    }
    if (r.written) requestRefresh(state)
    return r
  } finally {
    state.distilling = false
  }
}

function mount(agent) {
  const sessionId = sessionIdOf(agent)
  const state = {
    agent,
    sessionId,
    turn: null,
    lastText: null,
    lastRecalled: [],
    needsRecovery: false,
    recoveryCpId: null,
    recoverySetTurn: 0,
    // Receipts that could not be written yet, oldest first. A single slot lost
    // the earlier receipt when a second compaction was detected while the store
    // was still failing.
    pendingDeliveries: [],
    lastDeliveryAttempt: 0,
    publishFailures: 0,
    compactionCount: null,
    lastEventCount: -1,
    distillCursor: 0,
    distillTimer: null,
    distilling: false,
    lastDistill: null,
    disposeDynamic: null,
    disposeStatic: null,
    disposers: [],
  }
  mounted.set(agent, state)
  try {
    const cursorKey = `distill_cursor:${CONFIG.owner ?? ''}:${sessionId}`
    const recorded = metaGet(db, cursorKey, null)
    const currentLength = eventsOf(agent)?.length ?? 0
    state.distillCursor = recorded == null ? currentLength : Math.min(Number(recorded) || 0, currentLength)
    if (recorded == null) metaSet(db, cursorKey, state.distillCursor)
  } catch { state.distillCursor = 0 }

  try { mountStatic(state) } catch (err) { diag(`mountStatic: ${err?.message ?? err}`) }
  // Only when the host gave the plugin no service to register on: the
  // plugin-level path is what the model actually sees.
  if (!pluginToolsRegistered) {
    try { registerTools(state) } catch (err) { diag(`registerTools: ${err?.message ?? err}`) }
  }
  diag(`mounted ${sessionId}: tools=${state.disposers.length}`)
  // Publish the block once at mount. A one-shot host builds its prompt shortly
  // after this and fires turn events only afterwards, so waiting for an event
  // meant the first (and only) turn ran with no injected memory at all.
  try {
    const seeded = buildContextTextSync(state)
    if (seeded?.text) {
      publishDynamic(state, seeded)
      diag(`seeded ${sessionId}: chars=${seeded.text.length}`)
    } else {
      diag(`seed empty ${sessionId}`)
    }
  } catch (err) { diag(`seed failed: ${err?.message ?? err}`) }

  try {
    const off = agent.ctx.on('agent/inbox/inserted', () => {
      requestRefresh(state)
    })
    if (typeof off === 'function') state.disposers.push(off)
  } catch (err) { diag(`inbox hook: ${err?.message ?? err}`) }

  try {
    const off = agent.ctx.on('agent/turn-stopping', () => {
      state.turn = (state.turn ?? 0) + 1
      // A turn that ended after the compaction was detected is a turn whose prompt
      // could have carried the recovery notice, so this is where delivery is
      // recorded and the notice is retracted. Keeping the flag until now is what
      // stops an in-flight async refresh from silently replacing the notice before
      // the model reads it.
      if (state.needsRecovery && (state.turn ?? 0) > (state.recoverySetTurn ?? 0)) {
        // The notice has now had a full turn in front of the model, so it is
        // retracted here. Retracting it and recording the receipt are two
        // different facts: the retraction is certain, the write is not. Hand the
        // receipt to the retry path instead of assuming it landed.
        state.needsRecovery = false
        if (state.recoveryCpId) {
          state.pendingDeliveries.push({ cpId: state.recoveryCpId, note: 'compaction', attempts: 0 })
          state.recoveryCpId = null
          flushPendingDelivery(state, { force: true })
        }
      }
      if (CONFIG.autoCheckpoint) {
        const ask = lastUserText(agent)
        if (ask) {
          try { saveOrUpdateAuto(db, { sessionId, goal: ask.slice(0, 400), turn: state.turn, owner: CONFIG.owner ?? null, guard: redactValue }) } catch (err) { diag(`auto cp: ${err}`) }
        }
      }
      requestRefresh(state)
      // \u538B\u7F29\u53EA\u53D1\u751F\u5728\u8F6E\u6B21\u4E4B\u95F4\uFF1A\u8F6E\u6B21\u5C3E\u5DF4\u626B\u4E00\u6B21\uFF0C\u6BD4 500ms \u8F6E\u8BE2\u51C6\uFF0C\u4E5F\u4FBF\u5B9C
      try { watchCompactions() } catch {}
      scheduleDistill(state)
    })
    if (typeof off === 'function') state.disposers.push(off)
  } catch (err) { diag(`turn hook: ${err?.message ?? err}`) }

  // Seed the first turn immediately; the async upgrade follows inside.
  requestRefresh(state)
  return state
}

function unmount(agent) {
  const state = mounted.get(agent)
  if (!state) return
  if (state.distillTimer) { try { clearTimeout(state.distillTimer) } catch {} }
  for (const fn of [state.disposeDynamic, state.disposeStatic, ...state.disposers]) {
    try { if (typeof fn === 'function') fn() } catch {}
  }
  mounted.delete(agent)
}

/** \u538B\u7F29\u68C0\u6D4B\uFF1A\u5BBF\u4E3B\u4E0D\u8BA9\u76D1\u542C compaction \u4E8B\u4EF6\uFF0C\u53EA\u80FD\u626B\u65E5\u5FD7\u3002 */
function watchCompactions() {
  for (const [agent, state] of mounted) {
    let events
    try { events = eventsOf(agent) } catch { continue }
    if (!events) continue
    // \u957F\u5EA6\u6CA1\u53D8\u5C31\u522B\u91CD\u65B0\u626B\uFF1A\u4E00\u6574\u4E2A\u4F1A\u8BDD\u7684\u4E8B\u4EF6\u6570\u7EC4\u626B\u4E00\u904D\u4E0D\u4FBF\u5B9C\uFF0C500ms \u4E00\u6B21\u66F4\u4E0D\u4FBF\u5B9C
    if (state.lastEventCount === events.length) continue
    state.lastEventCount = events.length
    const { completed } = scanCompactions(events)
    if (state.compactionCount === null) state.compactionCount = completed
    else if (completed > state.compactionCount) {
      state.compactionCount = completed
      state.needsRecovery = true
      // The turn counter at detection time: the notice is retracted at the end of
      // the first turn that began after this point, which is the first prompt that
      // could have carried it.
      state.recoverySetTurn = state.turn ?? 0
      state.recoveryCpId = null
      diag(`compaction detected in ${state.sessionId} (${completed})`)
      requestRefresh(state)
    } else {
      state.compactionCount = completed
    }
  }
}

/**
 * Write the delivery receipt, and keep trying when the store will not take it.
 *
 * Reaching the turn boundary proves the prompt could carry the notice; it does
 * not prove the receipt was stored. The old code cleared the in-memory recovery
 * state whether or not the write landed, so a busy store left the receipt at
 * `prepared` with nothing scheduled to try again - a silent lost acknowledgement.
 *
 * Three outcomes are kept distinct on purpose: `returned false` means the
 * checkpoint is gone for this owner and no retry can help, while a thrown error
 * is treated as transient and retried with a throttle.
 */
const DELIVERY_ATTEMPT_LIMIT = 20

function flushPendingDelivery(state, { force = false } = {}) {
  const queue = state.pendingDeliveries
  if (!Array.isArray(queue) || queue.length === 0) return true
  const at = Date.now()
  // Read per call: operators can slow the retry down on a busy store, and tests
  // need it fast without waiting on a hard-coded five seconds.
  const retryMs = Number(process.env.ACM_DELIVERY_RETRY_MS ?? 5000)
  if (!force && at - (state.lastDeliveryAttempt ?? 0) < (Number.isFinite(retryMs) ? retryMs : 5000)) return false
  state.lastDeliveryAttempt = at
  // Drain from the head: a later receipt must not overtake an earlier one.
  while (queue.length) {
    const pending = queue[0]
    pending.attempts = (pending.attempts ?? 0) + 1
    try {
      const ok = markDelivered(db, pending.cpId, state.sessionId, pending.note ?? 'compaction', CONFIG.owner ?? null)
      if (ok === true) {
        queue.shift()
        diag(`recovery receipt persisted: cp=${pending.cpId} attempts=${pending.attempts}`)
        continue
      }
      // Not an error: the checkpoint no longer exists for this owner, so marking
      // it delivered is impossible. Say so instead of retrying forever.
      queue.shift()
      diag(`recovery receipt unrecorded: cp=${pending.cpId} checkpoint missing for this owner`)
      continue
    } catch (err) {
      if (pending.attempts >= DELIVERY_ATTEMPT_LIMIT) {
        queue.shift()
        diag(`recovery receipt abandoned: cp=${pending.cpId} attempts=${pending.attempts} err=${err?.message ?? err}`)
        continue
      }
      diag(`recovery receipt deferred: cp=${pending.cpId} attempts=${pending.attempts} err=${err?.message ?? err}`)
      return false
    }
  }
  return true
}

let lastGcAt = 0
// \u5907\u4EFD\u68C0\u67E5\u522B\u8DDF\u7740 500ms \u8DD1\uFF1A\u6BCF 10 \u5206\u949F\u95EE\u4E00\u6B21"\u5230\u70B9\u6CA1\u6709"\u5C31\u591F\uFF0C\u771F\u6B63\u5199\u76D8\u7531 everyHours \u7BA1\u3002
let lastBackupCheck = 0
function maybeBackup() {
  const now = Date.now()
  if (now - lastBackupCheck < 10 * 60 * 1000) return
  lastBackupCheck = now
  try { backupIfDue(db, CONFIG.dbPath, CONFIG.backup, now) } catch {}
}

// \u5411\u91CF\u662F\u6162\u6162\u8865\u7684\uFF1A\u65B0\u5199\u7684\u5148\u6CA1\u5411\u91CF\uFF0C\u540E\u53F0\u6BCF\u6B21\u8865\u4E00\u5C0F\u628A\uFF0C\u522B\u5728\u70ED\u8DEF\u5F84\u4E0A\u7B97
let lastEmbedAt = 0
function maybeEmbed() {
  const cfg = CONFIG.embed
  if (!cfg?.enabled) return
  if (Date.now() - lastEmbedAt < 60000) return
  lastEmbedAt = Date.now()
  // \u8865\u5230\u8FFD\u5E73\u4E3A\u6B62\uFF0C\u4F46\u4E00\u6B21\u6700\u591A 200 \u6761\uFF0C\u522B\u628A tick \u62D6\u4F4F
  ;(async () => {
    let total = 0
    for (let round = 0; round < 10; round += 1) {
      const n = await embedMissing(db, { limit: 20 })
      total += n
      if (n < 20) break
    }
    if (total) diag(`embed: +${total}`)
  })().catch((err) => diag(`embed failed: ${err?.message ?? err}`))
}
function maybeGc() {
  const cfg = CONFIG.gc
  if (!cfg?.enabled || CONFIG.owner != null) return
  const everyMs = Math.max(1, Number(cfg.everyHours ?? 6)) * 3600000
  if (Date.now() - lastGcAt < everyMs) return
  lastGcAt = Date.now()
  try {
    const r = gc(db, { days: cfg.days, checkpointDays: cfg.checkpointDays, proposalDays: cfg.proposalDays })
    if (r.nodes || r.sources || r.checkpoints || r.proposals) diag(`gc: ${JSON.stringify(r)}`)
  } catch (err) {
    diag(`gc failed: ${err?.message ?? err}`)
  }
}

export function apply(ctx, overrides = {}) {
  // Validate before touching the filesystem: the old code created the database
  // and the diag log and only then threw on a missing host context.
  if (!ctx || typeof ctx.effect !== 'function' || typeof ctx.interval !== 'function') {
    throw new Error('acm-memory: apply() needs a host context providing effect() and interval()')
  }
  // A host reload calls apply again. Tear the previous installation down first
  // so timers, agent mounts and HTTP routes cannot stack up.
  if (appliedCleanup) {
    try { appliedCleanup() } catch {}
    appliedCleanup = null
  }
  rootCtx = ctx
  let hostConfig = {}
  try { hostConfig = ctx?.config?.get?.('acm-memory') ?? ctx?.config?.get?.('plugins.acm-memory') ?? ctx?.config?.acmMemory ?? {} } catch {}
  readConfig({ ...hostConfig, ...overrides })
  if (db && CONFIG.dbPath !== db._acmPath) { try { db.close() } catch {}; db = null }
  if (!db) { db = openDb(CONFIG.dbPath); db._acmPath = CONFIG.dbPath }
  try { backupIfDue(db, CONFIG.dbPath, CONFIG.backup) } catch {}
  diag(`apply: db=${CONFIG.dbPath} hostdeps=${hostDeps.source}`)
  // Before any agent exists: the host freezes its tool list when it creates the
  // agent, which happens after this function returns.
  try { registerPluginTools(ctx) } catch (err) { diag(`plugin tools: ${err?.message ?? err}`) }

  // agent \u5B9E\u4F8B\u4F1A\u88AB\u6362\u6389\uFF1A\u6BCF 500ms \u5BF9\u4E00\u904D\u540D\u5355\uFF0C\u65B0\u6302\u65E7\u7684\u6458\u3002
  // \u626B\u4F1A\u8BDD\u4E8B\u4EF6\u5F88\u8D35\uFF08500ms \u4E00\u6B21\u7B49\u4E8E\u4E00\u76F4\u8BFB\u540C\u4E00\u4E2A\u6570\u7EC4\uFF09\uFF0C\u6539\u6210\u6BCF 5s \u4E00\u6B21\u3002
  let ticks = 0
  let stop = null
  let disposed = false
  // Teardown is idempotent: the host may dispose the effect after we already
  // replaced this installation during a re-apply.
  const cleanup = () => {
    if (disposed) return
    disposed = true
    try { stop?.() } catch {}
    // The shutdown flush must run before unmounting: unmount() deletes from
    // `mounted`, so flushing afterwards iterated an empty map and the comment
    // claimed a write that never happened.
    for (const state of mounted.values()) { try { flushPendingDelivery(state, { force: true }) } catch {} }
    for (const agent of [...mounted.keys()]) { try { unmount(agent) } catch {} }
    for (const dispose of routeDisposers) { try { dispose() } catch {} }
    routeDisposers.length = 0
    try { if (db) db.close() } catch {}
    db = null
    pluginToolsRegistered = false
    if (appliedCleanup === cleanup) appliedCleanup = null
  }
  appliedCleanup = cleanup
  // The sweep runs once immediately and then on a timer. A one-shot host (the
  // headless profile) builds its tool list before returning from apply, so waiting
  // for the first 500ms tick meant the tools were registered after the only turn
  // had already been planned.
  const sweep = () => {
      ticks += 1
      let list = []
      try { list = ctx.agents.list() ?? [] } catch { return }
      // One line on the first tick: when a host shows no tools, the first question
      // is whether the plugin ever saw an agent.
      if (ticks === 1) diag(`tick1: agents=${list.length}`)
      const live = new Set(list)
      for (const agent of list) if (!mounted.has(agent)) { try { mount(agent) } catch (err) { diag(`mount: ${err?.message ?? err}`) } }
      for (const agent of [...mounted.keys()]) if (!live.has(agent)) unmount(agent)
      if (ticks === 1 || ticks % 10 === 0) {
        watchCompactions()
        // A receipt that failed once must not wait for the next compaction to be
        // retried; the throttle lives inside the call.
        for (const state of mounted.values()) flushPendingDelivery(state)
        // A lease is a deadline, so something has to notice when it passes. The
        // reviewer was right that the earlier claim "the host tick handles expiry"
        // was not supported by this file: it never called it. It does now, and the
        // call is guarded because a failed sweep must not stop the tick.
        try { expireLeases(db, { owner: CONFIG.owner ?? null }) } catch (err) { diag(`lease sweep failed: ${err?.message ?? err}`) }
      }
      if (ticks % 20 === 0) maybeEmbed()
      maybeGc()
      maybeBackup()
  }

  ctx.effect(() => {
    try { sweep() } catch (err) { diag(`first sweep: ${err?.message ?? err}`) }
    const stop = ctx.interval(sweep, 500)
    return cleanup
  })

  // Web endpoints are disabled unless the operator sets an explicit secret.
  // Every endpoint, including reads, is protected; writes additionally require POST.
  // The token and the enabled flag are snapshotted here: reading them from the
  // live CONFIG inside the handler meant a later apply() could leave these
  // routes registered while the gate compared against a new, weaker value.
  const httpSnapshot = { enabled: CONFIG.http?.enabled === true, token: CONFIG.http?.token }
  const webEnabled = httpSnapshot.enabled && typeof httpSnapshot.token === 'string' && httpSnapshot.token.length >= 16
  const expectedAuth = webEnabled ? Buffer.from(`Bearer ${httpSnapshot.token}`) : null
  const webAuthorized = (req, res, write = false) => {
    const disabled = () => {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('Forbidden')
      return false
    }
    if (!webEnabled) return disabled()
    // Fail closed if the host re-applied with different (or no) http config:
    // the routes are still registered, so they must not accept a stale token.
    if (CONFIG.http?.enabled !== true || CONFIG.http?.token !== httpSnapshot.token) return disabled()
    const got = Buffer.from(String(req?.headers?.authorization ?? ''))
    if (got.length !== expectedAuth.length || !timingSafeEqual(got, expectedAuth)) return disabled()
    if (write && req?.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' }); res.end('Method Not Allowed'); return false
    }
    return true
  }
  // A host without a web server has nothing to register routes on.
  // Cordis refuses to hand out a service that was not injected, so the routes
  // are mounted through a dynamic injection: profiles without an HTTP surface
  // never get the callback and the plugin still activates.
  const mountHttpRoutes = (hostCtx) => {
    const registerRoute = (spec) => {
      const dispose = hostCtx.webServer.register(spec)
      if (typeof dispose === 'function') routeDisposers.push(dispose)
      return dispose
    }
    if (webEnabled) {
  try {
    registerRoute({
      kind: 'exact',
      path: '/acm/status',
      handler: async (req, res) => {
        if (!webAuthorized(req, res)) return
        const body = {
          config: { dbPath: CONFIG.dbPath, budget: CONFIG.budget, personaFiles: CONFIG.personaFiles, distill: CONFIG.distill, backup: CONFIG.backup },
          hostdeps: hostDeps.source,
          sessions: [...mounted.values()].map((s) => ({
            sessionId: s.sessionId,
            needsRecovery: s.needsRecovery,
            lastTextChars: s.lastText?.length ?? 0,
            distill: s.lastDistill
              ? { at: s.lastDistill.at, chars: s.lastDistill.chars, facts: s.lastDistill.facts, written: s.lastDistill.written, error: s.lastDistill.error }
              : null,
          })),
          stats: stats(db, null, CONFIG.owner ?? null),
          proposals: pendingProposals(db, CONFIG.owner ?? null),
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body, null, 2))
      },
    })
  } catch (err) { diag(`webServer: ${err?.message ?? err}`) }

  try {
    registerRoute({
      kind: 'exact',
      path: '/acm/graph',
      handler: async (req, res) => {
        if (!webAuthorized(req, res)) return
        try {
          const html = renderGraphHtml(buildGraph(db, { owner: CONFIG.owner ?? null }))
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(html)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(err?.message ?? err))
        }
      },
    })
  } catch (err) { diag(`webServer graph: ${err?.message ?? err}`) }

  // \u8FDB\u5316\uFF1A\u6D4F\u89C8\u5668\u70B9\u4E00\u4E0B\u3001\u6216\u8005 cron \u6BCF\u5929\u6253\u4E00\u6B21
  try {
    registerRoute({
      kind: 'exact',
      path: '/acm/evolve',
      handler: async (req, res) => {
        if (!webAuthorized(req, res, true)) return
        // Evolution rewrites weights and merges clusters across every partition,
        // so it is an administrative operation: the same guard the SDK and the
        // acm_evolve tool apply must hold here too.
        if (CONFIG.owner != null) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'evolve requires trusted single-user administrative mode' }))
          return
        }
        try {
          const url = new URL(req.url, 'http://x')
          const dryRun = url.searchParams.get('dryRun') === '1'
          const r = evolve(db, { dryRun })
          if (!dryRun) diag(`evolve: merged=${r.merged} tuned=${r.tuned}`)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ...r, text: renderEvolution(r), history: evolutionLog(db, 3) }, null, 2))
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
        }
      },
    })
  } catch (err) { diag(`webServer evolve: ${err?.message ?? err}`) }
  try {
    registerRoute({
      kind: 'exact',
      path: '/acm/persona/approve',
      handler: async (req, res) => {
        if (!webAuthorized(req, res, true)) return
        try {
          const url = new URL(req.url, 'http://x')
          const id = Number(url.searchParams.get('id') ?? 0)
          const approve = url.searchParams.get('approve') !== '0'
          const r = decideProposal(db, id, approve, { actor: 'http:bearer', owner: CONFIG.owner ?? null })
          res.writeHead(r.ok ? 200 : 409, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(r))
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
        }
      },
    })
  } catch (err) { diag(`webServer approve: ${err?.message ?? err}`) }

  } // end of opt-in HTTP routes
  }

  const mountRoutes = (hostCtx) => {
    try { mountHttpRoutes(hostCtx) } catch (err) { diag(`webServer: ${err?.message ?? err}`) }
  }
  if (webEnabled) {
    if (typeof ctx.inject === "function") {
      // Cordis refuses to hand out a service that was not injected.
      try { ctx.inject(["webServer"], mountRoutes) } catch (err) { diag(`webServer inject failed: ${err?.message ?? err}`) }
    } else {
      // A plain context (tests, embedded hosts) may expose the service directly.
      try { if (ctx.webServer) mountRoutes(ctx) } catch (err) { diag(`webServer unavailable: ${err?.message ?? err}`) }
    }
  }
  void foldToMarkdown
}
