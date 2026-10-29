// \u5BBF\u4E3B\u5192\u70DF\uFF1A\u7528\u4E00\u4E2A\u5047\u7684 ctx \u628A apply() \u8DD1\u8D77\u6765\uFF0C\u770B\u6302\u8F7D/\u6CE8\u5165/\u5DE5\u5177/\u538B\u7F29\u6062\u590D\u662F\u5426\u6B63\u5E38\u3002
// \u8DD1\u6CD5\uFF1Anode test/smoke.mjs

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = dirname(fileURLToPath(import.meta.url))
const tmp = join(root, '..', '.tmp-smoke')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

// The database and the diagnostic log belong to this test, not to the operator's
// store. This file used to call apply() with no overrides at all, so every
// `npm run test:all` opened ~/.dsh/acm-memory/memory.db, applied any pending
// migration to it and appended two `sess-smoke` checkpoints to the real memory.
// That was a test-isolation defect: a test suite quietly writing to live data,
// which is the same class as a guard defect - the difference is that this one ran
// commit.
const smokeDb = join(tmp, 'memory.db')
const smokeDiag = join(tmp, 'diag.log')
const smokeConfig = {
  dbPath: smokeDb,
  diagPath: smokeDiag,
  // A fixture persona file, so the test does not read the operator's own.
  personaFiles: [join(tmp, 'AGENTS.md')],
}
// Only diagnostics written by THIS run count: the log is append-only and shared.
const diagPath = smokeDiag
const diagStart = existsSync(diagPath) ? statSync(diagPath).size : 0

const S = 'sess-smoke'
const events = []
const tools = new Map()
const sections = []
const contexts = []
let intervalFn = null

const agent = {
  id: S,
  session: {
    header: { id: S },
    snapshotEvents: () => events,
  },
  ctx: {
    systemPrompt: {
      section: (b) => { sections.push(b); return () => { const i = sections.indexOf(b); if (i >= 0) sections.splice(i, 1) } },
      context: (b) => { contexts.push(b); return () => { const i = contexts.indexOf(b); if (i >= 0) contexts.splice(i, 1) } },
    },
    tools: {
      register: (t) => { tools.set(t.name ?? t.id, t); return () => tools.delete(t.name) },
    },
    on: (evt, fn) => { (agent._hooks ??= {})[evt] = fn; return () => { delete agent._hooks[evt] } },
  },
}

const live = [agent]
const web = new Map()
const ctx = {
  effect: (fn) => fn(),
  interval: (fn, ms) => { intervalFn = fn; return () => { intervalFn = null } },
  agents: { list: () => live },
  webServer: { register: (r) => { web.set(r.path, r) } },
  on: () => () => {},
}

const mod = await import('../lib/index.mjs')
assert.equal(mod.name, 'acm-memory')
mod.apply(ctx, smokeConfig)
assert.equal(typeof intervalFn, 'function', 'interval \u5E94\u6302\u4E0A')
// The override is the assertion, not a hope: if a later edit drops it, the plugin
// writes to the default store and this fails on the same run instead of being
// discovered in the operator's memory months later.
assert.ok(existsSync(smokeDb), `the plugin opened ${smokeDb}`)
assert.ok(readFileSync(smokeDiag, 'utf8').includes('apply: db='), 'the diagnostic log is the test\'s own')

// \u8D70\u4E00\u8F6E tick\uFF1A\u5E94\u628A agent \u6302\u4E0A
intervalFn()
assert.ok(sections.length >= 0)
assert.ok(tools.size >= 4, `\u5DE5\u5177\u5E94\u6CE8\u518C >=4\uFF0C\u5B9E\u9645 ${tools.size}`)
console.log('  ok  \u6302\u8F7D\u540E\u5DE5\u5177:', [...tools.keys()].join(', '))

// apply() must fail fast without a host context instead of creating a database
// and then throwing a TypeError.
assert.throws(() => mod.apply(undefined), /host context/, 'apply() rejected an empty context')
assert.throws(() => mod.apply({}), /host context/, 'apply() rejected a context without hooks')

// A host reload calls apply again: the previous installation must be torn down
// first, or timers, mounts and HTTP routes stack up one level per reload.
const mountedTools = tools.size
mod.apply(ctx, smokeConfig)
// The first sweep is synchronous now, so a live agent is mounted immediately:
// a one-shot host builds its tool list before apply returns. The count must not
// grow, which is what proves the previous installation was torn down first.
assert.equal(tools.size, mountedTools, `re-apply stacked tools: ${tools.size} vs ${mountedTools}`)
intervalFn()
assert.equal(tools.size, mountedTools, 're-apply remounted a different number of tools')
console.log('  ok  re-apply tears down before mounting')

// \u9020\u4E00\u6761\u7528\u6237\u6D88\u606F + \u8BB0\u5FC6\uFF0C\u770B\u6CE8\u5165
events.push({ type: 'user/message', data: { message: { content: '\u5979\u559C\u6B22\u53BB\u6D77\u6EE8\u516C\u56ED\u770B\u6D77' } } })
const rememberTool = tools.get('acm_remember')
assert.ok(rememberTool, '\u9700\u8981\u6709 acm_remember')
await rememberTool.execute({ text: '\u5979\u559C\u6B22\u53BB\u6D77\u6EE8\u516C\u56ED\u770B\u6D77', importance: 0.7, source: '\u5979\u8BF4\u7684' })

assert.ok(contexts.length >= 1, '\u5E94\u6709\u52A8\u6001\u6CE8\u5165\u5757')
const joined = contexts.map((c) => c.text).join('\n')
assert.ok(joined.includes('\u6D77\u6EE8\u516C\u56ED'), '\u6CE8\u5165\u91CC\u5E94\u5E26\u4E0A\u521A\u8BB0\u7684\u4E8B')
console.log('  ok  \u52A8\u6001\u6CE8\u5165\u547D\u4E2D\uFF0C\u957F\u5EA6', joined.length)

// \u68C0\u67E5\u70B9
const cpTool = tools.get('acm_checkpoint')
await cpTool.execute({ goal: '\u505A ACM \u63D2\u4EF6', next: '\u63A5\u5BBF\u4E3B' })
assert.ok(contexts.map((c) => c.text).join('\n').includes('\u4EFB\u52A1\u72B6\u6001'), '\u6CE8\u5165\u91CC\u5E94\u6709\u4EFB\u52A1\u72B6\u6001')

// \u538B\u7F29\uFF1A\u8FFD\u52A0 start/summary/end\uFF0C\u518D tick \u4E00\u6B21\uFF0C\u5E94\u89E6\u53D1\u6062\u590D\u6807\u8BB0
events.push({ type: 'compaction/start', data: {} })
events.push({ type: 'compaction/summary', data: { summary: '\u538B\u7F29\u4E86' } })
events.push({ type: 'compaction/end', data: {} })
// \u4E8B\u4EF6\u626B\u63CF\u73B0\u5728\u6BCF 5s\uFF0810 \u4E2A tick\uFF09\u4E00\u6B21\uFF0C\u8F6E\u6B21\u5C3E\u5DF4\u4E5F\u4F1A\u626B\u4E00\u6B21
for (let i = 0; i < 10; i += 1) intervalFn()
const after = contexts.map((c) => c.text).join('\n')
assert.ok(after.includes('\u538B\u7F29\u540E\u6062\u590D'), '\u538B\u7F29\u540E\u5E94\u5E26\u6062\u590D\u6807\u8BB0')
console.log('  ok  \u538B\u7F29\u540E\u6062\u590D\u6CE8\u5165\u751F\u6548')

// \u4E0A\u4E0B\u6587\u53EA\u6302\u4E00\u4EFD\uFF08\u6362\u4E86\u5C31\u6458\u65E7\u7684\uFF0C\u4E0D\u4F1A\u8D8A\u6302\u8D8A\u591A\uFF09
const before = contexts.length
agent._hooks['agent/turn-stopping']()
agent._hooks['agent/turn-stopping']()
assert.equal(contexts.length, 1, `\u52A8\u6001\u5757\u5E94\u53EA\u6709 1 \u4E2A\uFF0C\u5B9E\u9645 ${contexts.length}`)
const afterTurns = contexts.map((c) => c.text).join('\n')
assert.ok(afterTurns.includes('\u4EFB\u52A1\u72B6\u6001'), '\u4E0B\u4E00\u8F6E\u4ECD\u8981\u5E26\u4EFB\u52A1\u72B6\u6001')
assert.ok(!afterTurns.includes('\u538B\u7F29\u540E\u6062\u590D'), '\u6062\u590D\u63D0\u793A\u9001\u8FC7\u4E00\u6B21\u5C31\u8BE5\u64A4\uFF0C\u522B\u6BCF\u8F6E\u91CD\u590D\u5237')
console.log('  ok  \u52A8\u6001\u5757\u53EA\u6302\u4E00\u4EFD\uFF0C\u6062\u590D\u63D0\u793A\u53EA\u9001\u4E00\u6B21')

// \u4F1A\u8BDD\u6D88\u5931 → \u5378\u8F7D
live.length = 0
intervalFn()
assert.equal(tools.size, 0, 'agent \u6CA1\u4E86\u5DE5\u5177\u5E94\u6458\u5E72\u51C0')
console.log('  ok  \u5378\u8F7D\u5E72\u51C0')


// \u88ab try/catch \u541e\u6389\u7684\u63a5\u7ebf\u9519\u8bef\uff08\u672a\u5b9a\u4e49\u53d8\u91cf\u3001\u62fc\u9519\u7684\u65b9\u6cd5\u540d\uff09\u4e0d\u4f1a\u8ba9\u65ad\u8a00\u5931\u8d25\uff0c\u53ea\u4f1a\u5728 diag \u91cc\u7559\u4e00\u884c\u3002
{
  const all = existsSync(diagPath) ? readFileSync(diagPath, 'utf8') : ''
  const fresh = all.slice(diagStart).trim()
  const swallowed = /ReferenceError|is not defined|is not a function|Cannot read properties of undefined/.exec(fresh)
  assert.equal(swallowed, null, `diag contains a swallowed wiring error:\n${fresh}`)
  console.log('  ok  diag \u65e0\u88ab\u541e\u6389\u7684\u63a5\u7ebf\u9519\u8bef')
}

// A host without an HTTP surface (headless, tui) must still get the memory
// tools. webServer used to be a hard injection, so such hosts held the plugin
// pending forever and the tools simply did not exist there.
{
  live.length = 0
  live.push(agent)
  const headlessCtx = {
    effect: (fn) => fn(),
    interval: (fn) => { intervalFn = fn; return () => { intervalFn = null } },
    agents: { list: () => live },
    on: () => () => {},
  }
  mod.apply(headlessCtx, smokeConfig)
  intervalFn()
  assert.ok(tools.size >= 4, `tools must exist without a web server, got ${tools.size}`)
  console.log('  ok  no-webServer host still mounts the tools')
}

console.log('\n\u5192\u70DF\u901A\u8FC7')
