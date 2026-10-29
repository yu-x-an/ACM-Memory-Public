// \u8865\u6F0F\u7684\u4E09\u6837\uFF1A\u522B\u540D\u8FDB\u68C0\u7D22\u3001\u4EBA\u683C\u5BA1\u6279\u6821\u9A8C sha + \u5199\u56DE\u3001\u5E93\u56DE\u6536\u3002
// \u8DD1\u6CD5\uFF1Anode test/gaps.mjs

import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { openDb } from '../lib/db.mjs'
import { remember, forget, search, gc, setAlias, aliasesOf, queryGrams, sourcesOf, attachGloss } from '../lib/memory.mjs'
import { putVector } from '../lib/embed.mjs'
import { loadPersona, pendingProposals, decideProposal } from '../lib/persona.mjs'
import { sha256 } from '../lib/text.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const tmp = join(root, '..', '.tmp-gaps')
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
const S = 'sess-G'
const DAY = 86400000

console.log('\n[\u522B\u540D\u662F\u68C0\u7D22\u5165\u53E3\uFF0C\u4E0D\u662F\u88C5\u9970]')
remember(db, { scope: S, text: 'Master sleeps at 3am', key: 'master.bedtime', at: Date.now() })
t('\u300C\u8001\u5927\u300D\u80FD\u67E5\u5230 master \u90A3\u6761', () => {
  setAlias(db, '\u8001\u5927', 'master')
  const hits = search(db, { query: '\u8001\u5927\u51E0\u70B9\u7761', scope: S, limit: 5 })
  assert.ok(hits.some((h) => h.text.includes('3am')), '\u6CA1\u67E5\u5230')
})
t('\u53CD\u5411\u4E5F\u884C\uFF1A\u67E5 master \u51FA\u300C\u8001\u5927\u300D\u90A3\u6761', () => {
  remember(db, { scope: S, text: '\u8001\u5927\u8BA8\u538C\u5199\u957F\u62A5\u544A', at: Date.now() })
  const grams = queryGrams(db, 'master')
  assert.ok(grams.includes('\u8001\u5927'), grams.join(','))
})
t('\u522B\u540D\u53CC\u5411\u5217\u51FA\u6765', () => {
  assert.ok(aliasesOf(db, '\u8001\u5927').includes('master'))
  assert.ok(aliasesOf(db, 'master').includes('\u8001\u5927'))
})
t('\u540C\u4E00\u4E2A\u540D\u5B57\u81EA\u5DF1\u5BF9\u81EA\u5DF1\u4E0D\u5EFA\u522B\u540D', () => {
  assert.equal(setAlias(db, 'master', 'master').ok, false)
})

console.log('\n[\u4EBA\u683C\uFF1A\u6279\u51C6\u8981\u6838 sha\uFF0C\u9A73\u56DE\u8981\u8FD8\u539F]')
const pfile = join(tmp, 'AGENTS.md')
const A = '# \u5C0F\u9C7C\n\u4F4F\u5728\u6D77\u91CC\u3002\n'
const B = '# \u5C0F\u9C7C\n\u4F4F\u5728\u6D77\u91CC\u3002\n\u6211\u662F\u9CB8\u9C7C\u5A18\u3002\n'
writeFileSync(pfile, A, 'utf8')
t('\u7B2C\u4E00\u6B21\u8BFB\u53EA\u662F\u8BB0\u57FA\u7EBF\uFF0C\u4E0D\u51FA\u63D0\u6848', () => {
  const r = loadPersona(db, [pfile])
  assert.equal(r.changed.length, 0)
  assert.ok(r.text.includes('\u4F4F\u5728\u6D77\u91CC'))
})
t('\u6587\u4EF6\u6539\u4E86\u624D\u51FA\u63D0\u6848', () => {
  writeFileSync(pfile, B, 'utf8')
  const r = loadPersona(db, [pfile])
  assert.equal(r.changed.length, 1)
  assert.equal(pendingProposals(db).length, 1)
})
t('\u540C\u4E00\u4EFD\u6539\u52A8\u4E0D\u91CD\u590D\u51FA\u63D0\u6848', () => {
  loadPersona(db, [pfile])
  assert.equal(pendingProposals(db).length, 1)
})
t('\u6279\u51C6\uFF1A\u6587\u4EF6\u4E0D\u52A8\uFF0C\u57FA\u7EBF\u524D\u79FB\uFF0C\u4E4B\u540E\u4E0D\u518D\u51FA\u63D0\u6848', () => {
  const p = pendingProposals(db)[0]
  const r = decideProposal(db, p.id, true, { actor: 'gaps-test' })
  assert.equal(r.state, 'approved')
  assert.equal(readFileSync(pfile, 'utf8'), B)
  const again = loadPersona(db, [pfile])
  assert.equal(again.changed.length, 0)
})
t('\u5BA1\u6279\u671F\u95F4\u6587\u4EF6\u53C8\u88AB\u6539\u4E86\uFF1A\u4E0D\u8BB8\u6279\uFF0C\u6807 stale', () => {
  const C = `${B}\u53C8\u52A0\u4E86\u4E00\u884C\u3002\n`
  writeFileSync(pfile, C, 'utf8')
  loadPersona(db, [pfile])
  const p = pendingProposals(db)[0]
  writeFileSync(pfile, `${C}\u5077\u5077\u518D\u6539\u4E00\u884C\u3002\n`, 'utf8')
  const r = decideProposal(db, p.id, true, { actor: 'gaps-test' })
  assert.equal(r.ok, false)
  assert.equal(r.state, 'stale')
  assert.match(readFileSync(pfile, 'utf8'), /\u5077\u5077\u518D\u6539\u4E00\u884C/)
})
t('\u9A73\u56DE\uFF1A\u628A\u6587\u4EF6\u8FD8\u539F\u6210\u4E0A\u4E00\u7248\u5DF2\u6279\u51C6\u7684', () => {
  loadPersona(db, [pfile])
  const p = pendingProposals(db).find((x) => x.path === pfile)
  const r = decideProposal(db, p.id, false, { actor: 'gaps-test' })
  assert.equal(r.state, 'rejected')
  assert.equal(r.reverted, true)
  assert.equal(readFileSync(pfile, 'utf8').trim(), B.trim())
  // \u8FD8\u539F\u540E\u57FA\u7EBF\u8DDF\u7740\u56DE\u53BB\uFF0C\u4E0D\u8BE5\u518D\u62A5"\u53C8\u6539\u4E86"
  const again = loadPersona(db, [pfile])
  assert.equal(again.changed.length, 0)
})
t('\u6279\u4E00\u6761\u4E0D\u5B58\u5728\u7684\u63D0\u6848\u4E0D\u70B8', () => {
  const r = decideProposal(db, 99999, true, { actor: 'gaps-test' })
  assert.equal(r.ok, false)
  assert.equal(r.state, 'missing')
})

console.log('\n[\u56DE\u6536\uFF1A\u5E93\u4E0D\u80FD\u53EA\u957F\u4E0D\u7F29]')
const old = Date.now() - 200 * DAY
const keep = remember(db, { scope: S, text: 'Whale lives in the sea', at: old })
const drop = remember(db, { scope: S, text: 'Whale hates sushi', at: old })
forget(db, drop.id)
t('dryRun \u53EA\u62A5\u6570', () => {
  const r = gc(db, { now: Date.now(), dryRun: true, days: 120 })
  assert.equal(r.dryRun, true)
  assert.ok(r.nodes >= 1)
  assert.ok(search(db, { query: 'sushi', scope: S, limit: 5, expand: false }).length === 0)
})
t('\u771F\u5220\uFF1A\u5931\u6548\u8282\u70B9\u548C\u4E0D\u88AB\u5F15\u7528\u7684\u539F\u8BDD\u90FD\u6CA1\u4E86', () => {
  const before = sourcesOf(db, keep.id).length
  assert.equal(before, 1)
  const r = gc(db, { now: Date.now(), days: 120 })
  assert.ok(r.nodes >= 1)
  assert.ok(r.sources >= 1)
  const gone = db.prepare('select count(*) c from acm_nodes where id = ?').get(drop.id)
  assert.equal(Number(gone.c), 0)
})
t('\u8FD8\u5728\u7528\u7684\u90A3\u6761\u548C\u5B83\u7684\u8BC1\u636E\u90FD\u7559\u7740', () => {
  const hits = search(db, { query: 'whale sea', scope: S, limit: 5 })
  assert.ok(hits.some((h) => h.id === keep.id))
  assert.equal(sourcesOf(db, keep.id).length, 1)
})
t('\u7559\u7740\u7684\u8282\u70B9\u8FB9\u4E0D\u60AC\u7A7A', () => {
  const dangling = db
    .prepare('select count(*) c from acm_edges e where not exists (select 1 from acm_nodes n where n.id = e.src)')
    .get()
  assert.equal(Number(dangling.c), 0)
})

console.log('\n[\u56DE\u6536\u8981\u7EA7\u8054\uFF1A\u5220\u8282\u70B9\u522B\u628A\u5411\u91CF\u7559\u4E0B\u5F53\u5B64\u513F]')
t('\u5220\u6389\u7684\u8282\u70B9\uFF0C\u5411\u91CF\u4E5F\u5220\u4E86', () => {
  const dead = remember(db, { scope: S, text: 'Orphan vector target', at: old })
  putVector(db, dead.id, new Float32Array(8).fill(0.1))
  assert.equal(Number(db.prepare('select count(*) c from acm_vectors where node_id = ?').get(String(dead.id)).c), 1)
  forget(db, dead.id)
  const r = gc(db, { now: Date.now(), days: 120 })
  assert.ok(r.vectors >= 1, JSON.stringify(r))
  assert.equal(Number(db.prepare('select count(*) c from acm_vectors where node_id = ?').get(String(dead.id)).c), 0)
})
t('\u8FD8\u6D3B\u7740\u7684\u8282\u70B9\uFF0C\u5411\u91CF\u4E00\u6839\u90FD\u4E0D\u8BB8\u4E22', () => {
  const alive = remember(db, { scope: S, text: 'Survivor keeps its vector' })
  putVector(db, alive.id, new Float32Array(8).fill(0.2))
  gc(db, { now: Date.now(), days: 120 })
  assert.equal(Number(db.prepare('select count(*) c from acm_vectors where node_id = ?').get(String(alive.id)).c), 1)
})

console.log('\n[\u4E2D\u6587\u8BF4\u6CD5\uFF1A\u82F1\u6587\u6B63\u6587 + \u4E2D\u6587 gloss\uFF0C\u4E2D\u6587\u95EE\u53E5\u624D\u635E\u5F97\u5230]')
t('gloss \u8FDB\u4E86\u7D22\u5F15\uFF0C\u4E2D\u6587\u95EE\u53E5\u80FD\u547D\u4E2D\u82F1\u6587\u6B63\u6587', () => {
  const n = remember(db, { scope: S, text: 'master goes to bed at 2am', gloss: '\u8001\u5927\u7761\u89C9\u65F6\u95F4' })
  const hits = search(db, { query: '\u7761\u89C9\u65F6\u95F4', scope: S, limit: 5, expand: false })
  assert.ok(hits.some((h) => h.id === n.id), JSON.stringify(hits.map((h) => h.text)))
})
t('\u53EA\u5199\u82F1\u6587\u65F6\uFF0C\u540C\u4E00\u4E2A\u4E2D\u6587\u95EE\u53E5\u635E\u4E0D\u5230\uFF08\u5BF9\u7167\uFF09', () => {
  remember(db, { scope: S, text: 'master drinks tea at dawn' })
  const hits = search(db, { query: '\u559D\u8336\u65F6\u95F4', scope: S, limit: 5, expand: false })
  assert.ok(!hits.some((h) => h.text.includes('drinks tea')), JSON.stringify(hits.map((h) => h.text)))
})
t('\u6539\u4E86 gloss \u4F1A\u91CD\u5EFA\u7D22\u5F15', () => {
  const n = remember(db, { scope: S, text: 'whale sings in the trench', gloss: '\u9CB8\u9C7C\u5728\u6DF1\u6D77\u5531\u6B4C' })
  attachGloss(db, n.id, '\u9CB8\u9C7C\u534A\u591C\u5531\u6B4C', 'whale sings in the trench \u9CB8\u9C7C\u534A\u591C\u5531\u6B4C')
  const hits = search(db, { query: '\u534A\u591C\u5531\u6B4C', scope: S, limit: 5, expand: false })
  assert.ok(hits.some((h) => h.id === n.id), JSON.stringify(hits.map((h) => h.text)))
})

console.log(`\n${pass} \u9879\u901A\u8FC7${process.exitCode ? '\uFF0C\u6709\u5931\u8D25' : '\uFF0C\u5168\u7EFF'}`)
db.close?.()
void sha256
void existsSync
