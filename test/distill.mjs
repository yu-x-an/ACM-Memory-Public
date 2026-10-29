// \u84B8\u998F\u7684\u6D4B\u8BD5\uFF1A\u4E0D\u78B0\u5BBF\u4E3B\uFF0C\u6A21\u578B\u7528\u5047\u7684\u3002
// \u8DD1\u6CD5\uFF1Anode test/distill.mjs

import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { openDb } from '../lib/db.mjs'
import { search, sourcesOf } from '../lib/memory.mjs'
import { parseFacts, collectTurn, distillOnce } from '../lib/distill.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const tmp = join(root, '..', '.tmp-distill')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

let pass = 0
const t = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`)
    process.exitCode = 1
  }
}

const db = openDb(join(tmp, 'memory.db'))
const S = 'sess-D'

const fakeCtx = (reply) => ({
  llm: {
    async *stream(req) {
      fakeCtx.lastReq = req
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  get: () => null,
})
const fakeAgent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm-test' } }) } }
const fakeMsg = (x) => (x)

const ev = (type, text, seq) => ({
  type,
  seq,
  data: { message: { content: [{ type: 'text', text }] } },
})

console.log('\n[\u62BD\u51FA\u6765\u7684 JSON \u5E72\u4E0D\u5E72\u51C0]')
await t('\u4EE3\u7801\u5757\u5305\u7740\u4E5F\u80FD\u6252\u51FA\u6765', async () => {
  const r = parseFacts('```json\n[{"text":"Whale lives in the sea","confidence":0.9}]\n```')
  assert.equal(r.length, 1)
  assert.equal(r[0].text, 'Whale lives in the sea')
})
await t('\u524D\u540E\u6709\u5E9F\u8BDD\u4E5F\u4E0D\u5F71\u54CD', async () => {
  const r = parseFacts('\u597D\u7684\uFF0C\u7ED3\u679C\u5982\u4E0B\uFF1A[{"text":"Master bed time is 3am","confidence":0.8}] \u4EE5\u4E0A\u3002')
  assert.equal(r[0].text, 'Master bed time is 3am')
})
await t('\u4E71\u7801\u76F4\u63A5\u8FD4\u56DE\u7A7A\uFF0C\u4E0D\u629B', async () => {
  assert.deepEqual(parseFacts('\u6A21\u578B\u62BD\u98CE\u4E86\u5199\u4E86\u4E00\u6BB5\u6563\u6587'), [])
  assert.deepEqual(parseFacts(''), [])
  assert.deepEqual(parseFacts(null), [])
})
await t('\u4F4E\u7F6E\u4FE1\u5EA6\u3001\u592A\u77ED\u3001\u8D85\u91CF\u7684\u90FD\u6254\u6389', async () => {
  const r = parseFacts(JSON.stringify([
    { text: 'ok', confidence: 0.9 },
    { text: 'Low confidence guess about stuff', confidence: 0.2 },
    { text: 'Fact one is true and long enough', confidence: 0.9 },
    { text: 'Fact two is true and long enough', confidence: 0.9 },
    { text: 'Fact three is true and long enough', confidence: 0.9 },
    { text: 'Fact four is true and long enough', confidence: 0.9 },
    { text: 'Fact five is true and long enough', confidence: 0.9 },
  ]), { maxFacts: 3 })
  assert.equal(r.length, 3)
  assert.ok(!r.some((x) => x.confidence < 0.5))
})
await t('kind \u4E0D\u8BA4\u8BC6\u5C31\u5F53 fact\uFF0Ckey \u53EF\u6709\u53EF\u65E0', async () => {
  const r = parseFacts(JSON.stringify([
    { text: 'Whale dislikes long reports', kind: '\u778E\u5199\u7684', confidence: 0.7 },
    { text: 'Master goes to bed at 3am', kind: 'preference', key: 'master.bedtime', confidence: 0.7 },
  ]))
  assert.equal(r[0].kind, 'fact')
  assert.equal(r[0].key, null)
  assert.equal(r[1].key, 'master.bedtime')
  assert.equal(r[1].kind, 'preference')
})

console.log('\n[\u6311\u54EA\u4E00\u6BB5\u53BB\u70BC]')
await t('\u53EA\u62FF\u6E38\u6807\u4E4B\u540E\u7684\uFF0C\u4E14\u5148 user \u540E assistant \u90FD\u7B97', async () => {
  const events = [
    ev('user/message', '\u8001\u8BDD\uFF0C\u4E0D\u8BE5\u88AB\u62BD', 1),
    ev('user/message', '\u6211\u4ECA\u5929\u7761\u5230\u4E09\u70B9', 2),
    ev('assistant/message', '\u8BB0\u4E0B\u4E86\u3002', 3),
    ev('compaction/start', '', 4),
  ]
  const r = collectTurn(events, 1)
  assert.ok(!r.text.includes('\u8001\u8BDD'))
  assert.ok(r.text.includes('\u6211\u4ECA\u5929\u7761\u5230\u4E09\u70B9'))
  assert.ok(r.text.includes('\u8BB0\u4E0B\u4E86'))
  assert.equal(r.seq, 2)
  assert.equal(r.cursor, 4)
})
await t('\u8D85\u9884\u7B97\u5C31\u622A\u65AD\uFF0C\u4E0D\u65E0\u5E95\u6D1E', async () => {
  const events = [ev('user/message', 'a'.repeat(300), 1), ev('user/message', 'b'.repeat(300), 2)]
  const r = collectTurn(events, 0, { maxChars: 320 })
  assert.ok(r.text.length <= 340, `\u957F\u5EA6 ${r.text.length}`)
})
await t('\u7A7A\u4E8B\u4EF6\u8FD4\u56DE\u7A7A\u4E32', async () => {
  assert.equal(collectTurn([], 0).text, '')
})

console.log('\n[\u771F\u8DD1\u4E00\u904D\uFF1A\u6A21\u578B → \u8282\u70B9 → \u6765\u6E90]')
await t('\u62BD\u51FA\u6765\u7684\u90FD\u843D\u5E93\uFF0C\u4E14\u6BCF\u6761\u7684\u6765\u6E90\u662F\u539F\u8BDD', async () => {
  const ctx = fakeCtx(JSON.stringify([
    { text: 'Master sleeps at 3am', key: 'master.bedtime', kind: 'fact', confidence: 0.9 },
    { text: 'Whale likes the park', kind: 'preference', confidence: 0.8 },
  ]))
  const snippet = '\u7528\u6237\uFF1A\u6211\u4E00\u822C\u4E09\u70B9\u7761\n\u7528\u6237\uFF1A\u6211\u559C\u6B22\u53BB\u516C\u56ED\u770B\u6D77'
  const r = await distillOnce({
    ctx, agent: fakeAgent, db, sessionId: S, snippet, seq: 7,
    createUserMessage: fakeMsg, config: { minChars: 4 }, diag: () => {},
  })
  assert.equal(r.facts.length, 2)
  assert.equal(r.written, 2)

  const hits = search(db, { query: 'master sleeps 3am', scope: S, limit: 4 })
  assert.ok(hits.length >= 1)
  const src = sourcesOf(db, hits[0].id)[0]
  assert.equal(src.raw, snippet)
  assert.equal(src.kind, 'distilled:m-test')
  assert.equal(src.seq, 7)
})
await t('\u540C\u4E00\u6BB5\u8BDD\u518D\u70BC\u4E00\u6B21\u4E0D\u6DA8\u8282\u70B9', async () => {
  const ctx = fakeCtx(JSON.stringify([{ text: 'Whale likes the park', confidence: 0.9 }]))
  const snippet = '\u7528\u6237\uFF1A\u516C\u56ED\u90A3\u8FB9\u6D77\u6C34\u4E0D\u9519\uFF0C\u5979\u5E38\u53BB\n\u52A9\u624B\uFF1A\u8BB0\u4E0B\u4E86'
  const before = search(db, { query: 'park', scope: S, limit: 10 }).length
  const r = await distillOnce({
    ctx, agent: fakeAgent, db, sessionId: S, snippet, seq: 8,
    createUserMessage: fakeMsg, config: { minChars: 4 }, diag: () => {},
  })
  assert.equal(r.written, 1)
  const after = search(db, { query: 'park', scope: S, limit: 10 }).length
  assert.equal(after, before, '\u8282\u70B9\u6570\u8BE5\u4E00\u6837')
  const id = search(db, { query: 'park', scope: S, limit: 1 })[0].id
  assert.equal(sourcesOf(db, id).length, 2, '\u8BE5\u591A\u4E00\u6761\u6765\u6E90')
  assert.ok(sourcesOf(db, id).some((s) => s.raw === snippet), '\u6765\u6E90\u91CC\u8BE5\u6709\u8FD9\u6B21\u7684\u539F\u8BDD')
})
await t('\u77ED\u7247\u6BB5\u4E0D\u70E7\u6A21\u578B', async () => {
  const ctx = fakeCtx('[]')
  const r = await distillOnce({
    ctx, agent: fakeAgent, db, sessionId: S, snippet: '\u55EF', seq: 9,
    createUserMessage: fakeMsg, config: { minChars: 24 }, diag: () => {},
  })
  assert.equal(r.skipped, 'short')
  assert.equal(ctx.lastReq, undefined)
})
await t('\u62FF\u4E0D\u5230\u6A21\u578B\u5C31\u8DF3\u8FC7\uFF0C\u4E0D\u778E\u82B1\u94B1', async () => {
  const r = await distillOnce({
    ctx: fakeCtx('[]'), agent: { session: {} }, db, sessionId: S,
    snippet: '\u7528\u6237\uFF1A\u8FD9\u662F\u4E00\u6BB5\u8DB3\u591F\u957F\u7684\u3001\u503C\u5F97\u8BB0\u4F4F\u7684\u8BDD\uFF0C\u522B\u6D6A\u8D39\u3002', seq: 10,
    createUserMessage: fakeMsg, config: { minChars: 4 }, diag: () => {},
  })
  assert.equal(r.error, 'no-model')
})
await t('\u6A21\u578B\u62A5\u9519\u4E0D\u62D6\u57AE\u6574\u8F6E', async () => {
  const ctx = {
    llm: { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } } } },
    get: () => null,
  }
  const r = await distillOnce({
    ctx, agent: fakeAgent, db, sessionId: S,
    snippet: '\u7528\u6237\uFF1A\u8FD9\u662F\u4E00\u6BB5\u8DB3\u591F\u957F\u7684\u3001\u503C\u5F97\u8BB0\u4F4F\u7684\u8BDD\uFF0C\u522B\u6D6A\u8D39\u3002', seq: 11,
    createUserMessage: fakeMsg, config: { minChars: 4 }, diag: () => {},
  })
  assert.equal(r.error, 'llm')
})

await t('\u4E2D\u6587\u8BF4\u6CD5\u53EA\u6536\u50CF\u6837\u7684', async () => {
  const raw = JSON.stringify([
    { text: 'master sleeps at 2am', zh: '\u8001\u5927\u7761\u89C9\u65F6\u95F4', confidence: 0.9 },
    { text: 'master likes tea', zh: 'master likes tea', confidence: 0.9 },
    { text: 'master works late', zh: 'this is english', confidence: 0.9 },
    { text: 'master is in beijing', zh: '\u662F', confidence: 0.9 },
    { text: 'master hates noise', zh: '\u8001\u5927\u8BA8\u538C\u566A\u97F3\u8BA8\u538C\u5230\u4E0D\u884C\u6BCF\u6B21\u542C\u5230\u90FD\u8981\u8D70\u5F00\u5F88\u8FDC\u5F88\u8FDC', confidence: 0.9 },
  ])
  const facts = parseFacts(raw, { maxFacts: 10, minConfidence: 0.5 })
  const byText = Object.fromEntries(facts.map((f) => [f.text, f.gloss]))
  assert.equal(byText['master sleeps at 2am'], '\u8001\u5927\u7761\u89C9\u65F6\u95F4')
  assert.equal(byText['master likes tea'], null, '\u628A\u82F1\u6587\u6B63\u6587\u6284\u56DE\u6765\u8981\u4E22\u6389')
  assert.equal(byText['master works late'], null, '\u6CA1\u6709\u6C49\u5B57\u8981\u4E22\u6389')
  assert.equal(byText['master is in beijing'], null, '\u4E00\u4E24\u4E2A\u5B57\u8981\u4E22\u6389')
  assert.equal(byText['master hates noise'], null, '\u8D85\u957F\u8981\u4E22\u6389')
})

  await t('malformed model output is contained, not stored', () => {
    const raw = JSON.stringify([
      { text: { nested: 'object' }, confidence: 0.9 },
      { text: ['array'], confidence: 0.9 },
      { text: 12345, confidence: 0.9 },
      { text: 'valid sentence about the build', key: { bad: 'key' }, confidence: 0.9 },
      null,
      'just a string',
    ])
    const facts = parseFacts(raw)
    assert.equal(facts.length, 2, JSON.stringify(facts))
    assert.ok(facts.every((f) => typeof f.text === 'string'))
    assert.ok(!facts.some((f) => f.text.includes('object Object')))
    assert.ok(facts.every((f) => f.key === null || typeof f.key === 'string'))
  })

// A malformed reply must not look like a successful empty extraction: the cursor
// is only advanced on success, so treating junk as success would drop that span
// for good.
await t('a malformed reply is reported, an empty reply is not', async () => {
  const junk = await distillOnce({
    ctx: fakeCtx('I think the user likes tea, but here is no JSON'), agent: fakeAgent, db, sessionId: S,
    snippet: '\u7528\u6237：\u8FD9\u662F\u4E00\u6BB5\u8DB3\u591F\u957F\u7684、\u503C\u5F97\u8BB0\u4F4F\u7684\u8BDD，\u522B\u6D6A\u8D39。', seq: 20,
    createUserMessage: fakeMsg, config: { minChars: 4 }, diag: () => {},
  })
  assert.equal(junk.ok, false)
  assert.ok(String(junk.reason).startsWith('malformed:'), String(junk.reason))

  const empty = await distillOnce({
    ctx: fakeCtx('[]'), agent: fakeAgent, db, sessionId: S,
    snippet: '\u7528\u6237：\u8FD9\u662F\u4E00\u6BB5\u8DB3\u591F\u957F\u7684、\u503C\u5F97\u8BB0\u4F4F\u7684\u8BDD，\u522B\u6D6A\u8D39。', seq: 21,
    createUserMessage: fakeMsg, config: { minChars: 4 }, diag: () => {},
  })
  assert.notEqual(empty.ok, false, `an empty extraction is still a success: ${JSON.stringify(empty)}`)
})

console.log(`\n${pass} \u9879\u901A\u8FC7${process.exitCode ? '\uFF0C\u6709\u5931\u8D25' : '\uFF0C\u5168\u7EFF'}`)
db.close?.()
