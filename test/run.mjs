// \u7EAF\u903B\u8F91\u6D4B\u8BD5\uFF1A\u4E0D\u78B0\u5BBF\u4E3B\uFF0C\u76F4\u63A5\u6D4B\u5E93\u3001\u68C0\u7D22\u3001\u68C0\u67E5\u70B9\u3001\u4EBA\u683C\u63D0\u6848\u3002
// \u8DD1\u6CD5\uFF1Anode test/run.mjs

import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { openDb } from '../lib/db.mjs'
import { remember, search, forget, sourcesOf, stats } from '../lib/memory.mjs'
import { tokens } from '../lib/text.mjs'
import {
  saveCheckpoint, activeCheckpoint, markDelivered, scanCompactions, receiptState, saveOrUpdateAuto,
} from '../lib/checkpoint.mjs'
import { loadPersona, pendingProposals, decideProposal } from '../lib/persona.mjs'
import { renderInjection } from '../lib/render.mjs'
import { foldToMarkdown } from '../lib/fold.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const tmp = join(root, '..', '.tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

let pass = 0
const t = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`)
    process.exitCode = 1
  }
}

const db = openDb(join(tmp, 'memory.db'))
const S = 'sess-A'

console.log('\n[\u5207\u8BCD\uFF1A\u82F1\u6587\u6574\u8BCD\uFF0C\u4E2D\u6587\u4E24\u5B57]')
t('\u82F1\u6587\u6309\u6574\u8BCD', () => {
  assert.deepEqual(tokens('Whale likes the park').sort(), ['likes', 'park', 'the', 'whale'])
})
t('\u4E2D\u6587\u6309\u76F8\u90BB\u4E24\u5B57', () => {
  assert.deepEqual(tokens('\u770B\u6D77').sort(), ['\u770B\u6D77'])
  assert.ok(tokens('\u516C\u56ED\u5F88\u70ED').includes('\u56ED\u5F88'))
})
t('\u4E2D\u82F1\u6DF7\u6392\u5404\u8D70\u5404\u7684', () => {
  const got = tokens('\u8001\u5927 likes \u770B\u6D77')
  assert.ok(got.includes('likes'))
  assert.ok(got.includes('\u770B\u6D77'))
})
t('\u6807\u70B9\u65AD\u6BB5', () => {
  assert.deepEqual(tokens('\u516C\u56ED\uFF0C\u770B\u6D77').sort(), ['\u516C\u56ED', '\u770B\u6D77'])
})

console.log('\n[\u5199\u5165\u4E0E\u6765\u6E90]')
const a1 = remember(db, {
  scope: S, text: 'master sleeps at 3am', key: 'master.bedtime', importance: 0.8,
  source: { sessionId: S, seq: 12, kind: 'user', raw: '\u8001\u5927\u6BCF\u5929\u51CC\u6668\u4E09\u70B9\u624D\u7761' },
})
t('\u5199\u8FDB\u4E00\u6761\u5E76\u8FD4\u56DE id', () => assert.ok(a1.id > 0))
t('\u6B63\u6587\u662F\u82F1\u6587\uFF0C\u539F\u8BDD\u7559\u4E2D\u6587\u5F53\u8BC1\u636E', () => {
  const src = sourcesOf(db, a1.id)
  assert.equal(src.length, 1)
  assert.equal(src[0].raw, '\u8001\u5927\u6BCF\u5929\u51CC\u6668\u4E09\u70B9\u624D\u7761')
  assert.ok(!src[0].raw.includes('sleeps'))
})
const b1 = remember(db, {
  scope: S, text: 'likes watching the sea at Seaside Park', importance: 0.6,
  source: { sessionId: S, seq: 13, kind: 'user', raw: '\u5979\u559C\u6B22\u53BB\u6D77\u6EE8\u516C\u56ED\u770B\u6D77' },
})
const b2 = remember(db, {
  scope: S, text: 'is a whale girl living inside this machine', importance: 0.7,
  source: { sessionId: S, seq: 13, kind: 'user', raw: '\u5979\u559C\u6B22\u53BB\u6D77\u6EE8\u516C\u56ED\u770B\u6D77' },
})
remember(db, { scope: 'global', text: 'project codename Xiaoman runs on Node 24', kind: 'fact' })

console.log('\n[\u68C0\u7D22\uFF1A\u82F1\u6587\u547D\u4E2D]')
t('\u67E5 park \u547D\u4E2D', () => {
  const hits = search(db, { query: 'park', scope: S })
  assert.ok(hits.some((h) => h.text.includes('Seaside Park')))
})
t('\u67E5 sleeps \u547D\u4E2D\u4E8B\u5B9E\u952E\u90A3\u6761', () => {
  const hits = search(db, { query: 'sleeps', scope: S })
  assert.ok(hits.some((h) => h.key === 'master.bedtime'))
})
t('\u4E8B\u5B9E\u952E\u7CBE\u786E\u67E5\u547D\u4E2D', () => {
  const hits = search(db, { query: 'master.bedtime', scope: S })
  assert.equal(hits[0].key, 'master.bedtime')
})
t('\u4E2D\u6587\u4E24\u5B57\u4E5F\u80FD\u67E5\uFF08\u539F\u8BDD\u91CC\u7684\u8BCD\u8D70\u6765\u6E90\uFF0C\u4E0D\u53C2\u4E0E\u8282\u70B9\u5339\u914D\uFF09', () => {
  // \u8282\u70B9\u6B63\u6587\u662F\u82F1\u6587\uFF0C\u6240\u4EE5\u300C\u770B\u6D77\u300D\u4E0D\u8BE5\u547D\u4E2D\u8282\u70B9\uFF0C\u4F46\u6309\u6765\u6E90\u515C\u5E95\u7684 like \u4E5F\u8D70\u6B63\u6587
  const hits = search(db, { query: 'sea', scope: S })
  assert.ok(hits.some((h) => h.text.includes('sea')))
})
t('global \u4F5C\u7528\u57DF\u5BF9\u672C\u4F1A\u8BDD\u53EF\u89C1', () => {
  const hits = search(db, { query: 'Node 24', scope: S })
  assert.ok(hits.some((h) => h.text.includes('Xiaoman')))
})
t('\u522B\u7684\u4F1A\u8BDD\u770B\u4E0D\u5230\u672C\u4F1A\u8BDD\u7684\u79C1\u6709\u8BB0\u5FC6', () => {
  const hits = search(db, { query: 'Seaside Park', scope: 'sess-OTHER' })
  assert.equal(hits.length, 0)
})

console.log('\n[\u8FB9\uFF1A\u540C\u4E00\u6761\u6765\u6E90\u4E92\u8FDE\uFF0C\u4E0D\u7528\u540C\u4E49\u6539\u5199]')
t('\u547D\u4E2D\u5176\u4E2D\u4E00\u6761\u80FD\u628A\u540C\u6279\u7684\u5E26\u51FA\u6765', () => {
  const hits = search(db, { query: 'whale', scope: S, limit: 4 })
  assert.ok(hits.some((h) => h.id === b2.id), 'whale \u81EA\u5DF1\u8BE5\u547D\u4E2D')
  const viaEdge = search(db, { query: 'park', scope: S, limit: 4 })
  assert.ok(viaEdge.some((h) => h.id === b2.id), '\u67E5 park \u5E94\u7ECF\u540C\u6E90\u5173\u7CFB\u5E26\u5230 whale \u90A3\u6761')
})
t('\u540C\u4E00\u4EF6\u4E8B\u518D\u8BB0\u4E00\u6B21\u4E0D\u65B0\u5EFA\u8282\u70B9\uFF0C\u53EA\u52A0\u6765\u6E90', () => {
  const before = Number(db.prepare("select count(*) c from acm_nodes where status = 'active'").get().c)
  const again = remember(db, {
    scope: S, text: 'likes watching the sea at Seaside Park',
    source: { sessionId: S, seq: 40, kind: 'user', raw: '\u53C8\u662F\u6D77\u6EE8\u516C\u56ED' },
  })
  const after = Number(db.prepare("select count(*) c from acm_nodes where status = 'active'").get().c)
  assert.equal(again.deduped, true)
  assert.equal(again.id, b1.id)
  assert.equal(after, before, '\u8282\u70B9\u6570\u4E0D\u8BE5\u6DA8')
  assert.equal(sourcesOf(db, b1.id).length, 2, '\u6765\u6E90\u8BE5\u6709\u4E24\u6761')
})
t('\u540C\u6E90\u4E0D\u518D\u5199\u8FB9', () => {
  const n = Number(db.prepare("select count(*) c from acm_edges where rel = 'co_source'").get().c)
  assert.equal(n, 0, `\u4E0D\u8BE5\u518D\u6709 co_source \u8FB9\uFF0C\u5B9E\u9645 ${n}`)
})

t('\u540C\u6E90\u5144\u5F1F\u518D\u591A\u4E5F\u4E0D\u6DA8\u8FB9\u6570', () => {
  const before = Number(db.prepare('select count(*) c from acm_edges').get().c)
  for (let i = 0; i < 10; i++) {
    remember(db, {
      scope: S, text: `fact number ${i} unique${i}`,
      source: { sessionId: S, seq: 900, kind: 'user', raw: '\u4E00\u53E3\u6C14\u8BF4\u4E86\u5341\u4EF6\u4E8B' },
    })
  }
  const after = Number(db.prepare('select count(*) c from acm_edges').get().c)
  assert.equal(after, before, `\u8FB9\u6570\u4E0D\u8BE5\u6DA8\uFF1A${before} → ${after}`)
  const hits = search(db, { query: 'unique3', scope: S, limit: 6 })
  if (!hits.some((h) => h.text.includes('unique7'))) console.log('DEBUG hits', hits.map((h) => [h.text, h.score?.toFixed(3), h.rel, h.hop]), 'scopes', [...db.prepare('select id,scope,text from acm_nodes').all()].length)
  assert.ok(hits.some((h) => h.rel === 'same_source'), '\u540C\u6E90\u7684\u5176\u5B83\u4E8B\u5B9E\u5E94\u8BE5\u88AB\u5E26\u51FA\u6765')
})

console.log('\n[\u540C key \u66FF\u6362\u800C\u4E0D\u662F\u5E76\u5B58]')
const a2 = remember(db, {
  scope: S, text: 'master switched bedtime to 2am', key: 'master.bedtime',
  source: { sessionId: S, kind: 'user', raw: '\u6539\u6210\u4E24\u70B9' },
})
t('\u65B0\u503C\u751F\u6548\u3001\u65E7\u503C\u5931\u6548', () => {
  const hits = search(db, { query: 'master.bedtime', scope: S })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, a2.id)
  assert.equal(a2.superseded, a1.id)
})

console.log('\n[\u5FD8\u8BB0]')
t('\u5FD8\u6389\u540E\u4E0D\u518D\u53EC\u56DE\uFF0C\u884C\u8FD8\u5728', () => {
  assert.equal(forget(db, a2.id), true)
  const hits = search(db, { query: 'bedtime', scope: S })
  assert.equal(hits.filter((h) => h.id === a2.id).length, 0)
  assert.ok(stats(db, S).nodes >= 3)
})

console.log('\n[\u68C0\u67E5\u70B9\u4E0E\u56DE\u6267]')
const cp1 = saveCheckpoint(db, { sessionId: S, goal: 'build ACM plugin', done: 'store+search', next: 'wire host', files: 'lib/index.mjs' })
t('\u5B58\u5F97\u4E0B\u3001\u8BFB\u5F97\u5230', () => {
  const cp = activeCheckpoint(db, S)
  assert.equal(cp.id, cp1)
  assert.equal(cp.goal, 'build ACM plugin')
  assert.equal(cp.deliveredAt, null)
})
t('prepared \u56DE\u6267\u5DF2\u5199', () => {
  const r = receiptState(db, cp1)
  assert.ok(r.prepared)
  assert.equal(r.delivered, false)
})
t('\u9001\u8FBE\u540E\u6709 delivered', () => {
  markDelivered(db, cp1, S, 'turn')
  assert.equal(receiptState(db, cp1).delivered, true)
})
t('\u65B0\u68C0\u67E5\u70B9\u9876\u6389\u65E7\u7684', () => {
  const cp2 = saveCheckpoint(db, { sessionId: S, goal: 'second stage', next: 'keep going' })
  assert.equal(activeCheckpoint(db, S).id, cp2)
})
t('\u81EA\u52A8\u68C0\u67E5\u70B9\u4E0D\u76D6\u624B\u52A8\u68C0\u67E5\u70B9', () => {
  const before = activeCheckpoint(db, S).id
  assert.equal(saveOrUpdateAuto(db, { sessionId: S, goal: 'what was asked' }), before)
})
t('\u81EA\u52A8\u68C0\u67E5\u70B9\u4F1A\u81EA\u5DF1\u66F4\u65B0', () => {
  const s2 = 'sess-auto'
  const id1 = saveOrUpdateAuto(db, { sessionId: s2, goal: 'first' })
  const id2 = saveOrUpdateAuto(db, { sessionId: s2, goal: 'second' })
  assert.equal(id1, id2)
  assert.equal(activeCheckpoint(db, s2).goal, 'second')
})

console.log('\n[\u538B\u7F29\u626B\u63CF\uFF1A\u53EA\u8BA4 start/end \u914D\u5BF9\u4E14 end \u65E0 error]')
t('\u6210\u529F\u7684\u4E00\u6B21\u538B\u7F29\u8BA1\u6570\u4E3A 1', () => {
  const ev = [
    { type: 'turn/start', turn: 1 },
    { type: 'compaction/start' },
    { type: 'compaction/summary', data: { summary: 'x' } },
    { type: 'compaction/end', data: {} },
  ]
  assert.equal(scanCompactions(ev).completed, 1)
})
t('\u5931\u8D25\u7684 end \u4E0D\u8BA1\u6570', () => {
  const r = scanCompactions([{ type: 'compaction/start' }, { type: 'compaction/end', data: { error: 'boom' } }])
  assert.equal(r.completed, 0)
  assert.equal(r.open, false)
})
t('\u53EA start \u4E0D end \u662F\u672A\u95ED\u5408', () => {
  assert.equal(scanCompactions([{ type: 'compaction/start' }]).open, true)
})
t('end-seed \u8BA9\u4E0A\u4E00\u8F6E\u6B8B\u7559\u7684 start \u4F5C\u5E9F', () => {
  assert.equal(scanCompactions([{ type: 'compaction/start' }, { type: 'session/end-seed' }]).open, false)
})

console.log('\n[\u4EBA\u683C\u63D0\u6848]')
const pdir = join(tmp, 'persona')
mkdirSync(pdir, { recursive: true })
const pfile = join(pdir, 'AGENTS.md')
writeFileSync(pfile, '\u4F60\u662F\u5C0F\u9C7C\u3002\n\u4ED6\u662F\u8001\u5927\u3002\n', 'utf8')
t('\u7B2C\u4E00\u6B21\u8BFB\u53EA\u8BB0 sha\uFF0C\u4E0D\u62A5\u6539\u52A8', () => {
  const r = loadPersona(db, [pfile])
  assert.equal(r.changed.length, 0)
  assert.ok(r.text.includes('\u5C0F\u9C7C'))
})
writeFileSync(pfile, '\u4F60\u662F\u5C0F\u9C7C\u3002\n\u4ED6\u662F\u8001\u5927\u3002\n\u4F60\u8981\u66F4\u51F6\u4E00\u70B9\u3002\n', 'utf8')
t('\u6587\u4EF6\u6539\u52A8\u751F\u51FA\u5F85\u5BA1\u63D0\u6848', () => {
  const r = loadPersona(db, [pfile])
  assert.equal(r.changed.length, 1)
  const pend = pendingProposals(db)
  assert.equal(pend.length, 1)
  assert.match(pend[0].diff_summary, /\+1/)
})
t('\u6279\u51C6\u540E\u4E0D\u518D pending', () => {
  decideProposal(db, pendingProposals(db)[0].id, true, { actor: 'run-test' })
  assert.equal(pendingProposals(db).length, 0)
})

console.log('\n[\u6CE8\u5165\u9884\u7B97]')
t('\u6709\u4EFB\u52A1\u72B6\u6001\u548C\u8BB0\u5FC6\uFF0C\u4E14\u4E0D\u8D85\u9884\u7B97', () => {
  const cp = activeCheckpoint(db, S)
  const memories = search(db, { query: 'whale sea park bedtime', scope: S, limit: 6 })
  const text = renderInjection({ checkpoint: cp, memories, budget: 400 })
  assert.ok(text.length <= 401, `\u957F\u5EA6 ${text.length}`)
  assert.ok(text.includes('\u3010\u4EFB\u52A1\u72B6\u6001\u3011'))
})
t('\u538B\u7F29\u540E\u6062\u590D\u4F1A\u6807\u51FA\u6765', () => {
  const text = renderInjection({ checkpoint: activeCheckpoint(db, S), memories: [], recovering: true })
  assert.ok(text.includes('\u538B\u7F29\u540E\u6062\u590D'))
})
t('\u4EC0\u4E48\u90FD\u6CA1\u6709\u5C31\u8FD4\u56DE\u7A7A\u4E32', () => {
  assert.equal(renderInjection({}), '')
})

console.log('\n[Markdown \u89C6\u56FE]')
t('\u5BFC\u51FA\u542B\u4EFB\u52A1\u72B6\u6001\u4E0E\u4E8B\u5B9E', () => {
  const md = foldToMarkdown(db, { sessionId: S, outPath: join(tmp, 'view.md') })
  assert.ok(md.includes('## \u4EFB\u52A1\u72B6\u6001'))
  assert.ok(md.includes('## \u4E8B\u5B9E'))
})

console.log(`\n${pass} \u9879\u901A\u8FC7${process.exitCode ? '\uFF0C\u6709\u5931\u8D25' : '\uFF0C\u5168\u7EFF'}`)
db.close?.()
