import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { metaSet, openDb } from '../lib/db.mjs'
import { remember, search } from '../lib/memory.mjs'
import {
  basicTokens,
  cosine,
  embedMissing,
  embedQuery,
  embedText,
  encode,
  getVector,
  hybridSearch,
  putVector,
  reembedAll,
  semanticCandidates,
  vectorStats,
  warmup,
} from '../lib/embed.mjs'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; 

console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  XX  ${name} ${extra}`) }
}

// 1. \u5207\u8BCD\uFF1A\u4E2D\u6587\u6309\u5B57\uFF0C\u82F1\u6587\u6309\u4E32
ok('\u4E2D\u6587\u6309\u5B57\u5207', JSON.stringify(basicTokens('\u770B\u6D77')) === '["\u770B","\u6D77"]', JSON.stringify(basicTokens('\u770B\u6D77')))
ok('\u82F1\u6587\u6309\u4E32\u5207', JSON.stringify(basicTokens('whale  Habitat')) === '["whale","habitat"]', JSON.stringify(basicTokens('whale  Habitat')))

// 2. \u6A21\u578B\u80FD\u8D77\u6765\uFF0C\u5411\u91CF\u662F\u5F52\u4E00\u5316\u7684
const t0 = Date.now()
await warmup()
const loadMs = Date.now() - t0
ok('\u6A21\u578B\u52A0\u8F7D', loadMs > 0)
const v = await embedText('\u8001\u5927\u51CC\u6668\u4E24\u70B9\u7761')
ok('\u7EF4\u5EA6 512', v.length === 512, String(v.length))
let norm = 0
for (const x of v) norm += x * x
ok('\u5411\u91CF\u5F52\u4E00', Math.abs(norm - 1) < 0.01, norm.toFixed(4))
const same = await embedText('\u8001\u5927\u51CC\u6668\u4E24\u70B9\u7761')
ok('\u540C\u4E00\u53E5\u8BDD\u5411\u91CF\u4E00\u81F4', cosine(v, same) > 0.999, cosine(v, same).toFixed(4))

// 3. \u610F\u601D\u76F8\u8FD1\u7684\u5206\u6570\u66F4\u9AD8\uFF08\u8DE8\u8BED\u8A00\u4E5F\u7B97\uFF0C\u4F46 bge-small \u8DE8\u8BED\u8A00\u53EA\u662F\u300C\u6709\u70B9\u7528\u300D\uFF0C\u522B\u6307\u671B\u6EE1\u5206\uFF09
const bed = await embedText('master sleeps at 2am')
const sea = await embedText('the whale lives in the deep sea')
// Query side goes through embedQuery: it applies the retrieval instruction that
// semanticCandidates uses, so the test measures the vector production uses.
const q = await embedQuery('\u7761\u89C9\u65F6\u95F4')
ok('\u4E2D\u6587\u95EE\u53E5\u66F4\u80FD\u5BF9\u4E0A\u4F5C\u606F', cosine(q, bed) > cosine(q, sea), `${cosine(q, bed).toFixed(3)} vs ${cosine(q, sea).toFixed(3)}`)
const qen = await embedQuery('where does the whale live')
ok('\u82F1\u6587\u95EE\u53E5\u5BF9\u4E0A\u82F1\u6587\u4E8B\u5B9E', cosine(qen, sea) > cosine(qen, bed), `${cosine(qen, sea).toFixed(3)} vs ${cosine(qen, bed).toFixed(3)}`)

// 4. \u5411\u91CF\u5B58\u53D6
const root = mkdtempSync(join(tmpdir(), 'acm-embed-'))
const db = openDb(join(root, 'memory.db'))
const a = remember(db, { scope: 'global', text: 'master sleeps at 2am', kind: 'fact' })
putVector(db, a.id, v)
const back = getVector(db, a.id)
ok('\u5411\u91CF\u80FD\u5B58\u80FD\u8BFB', back && back.length === 512 && Math.abs(cosine(back, v) - 1) < 0.001)
// \u9A71\u52A8\u53EF\u80FD\u628A id \u7ED9\u6210\u6D6E\u70B9\uFF0C\u5B58\u8FDB\u53BB\u5FC5\u987B\u662F\u6574\u6570\u4E32\uFF0C\u5426\u5219\u8DDF\u6574\u578B\u4E3B\u952E join \u4E0D\u4E0A
const rawId = db.prepare('select node_id from acm_vectors where node_id = ?').get(String(a.id))
ok('node_id \u5B58\u6210\u6574\u6570\u4E32', !!rawId && !rawId.node_id.includes('.'), JSON.stringify(rawId))

// 5. \u8865\u5411\u91CF
const b = remember(db, { scope: 'global', text: 'the whale lives in the deep sea', kind: 'fact' })
const c = remember(db, { scope: 'global', text: 'she likes rainy nights', kind: 'fact' })
const before = vectorStats(db)
ok('\u7EDF\u8BA1\u8BA4\u5F97\u6CA1\u8865\u7684', before.missing >= 2, JSON.stringify(before))
const added = await embedMissing(db, { limit: 10 })
ok('\u8865\u9F50\u4E86', added === 2, String(added))
const after = vectorStats(db)
ok('\u8865\u5B8C\u4E0D\u7F3A\u4E86', after.missing === 0 && after.done === 3, JSON.stringify(after))

// 6. \u6362\u4E86\u4E2A\u8BF4\u6CD5\u4E5F\u80FD\u635E\u4E0A\u6765\uFF08FTS \u635E\u4E0D\u5230\u7684\u90A3\u6761\uFF09
const literal = search(db, { query: '\u4F5C\u606F', scope: 'global', limit: 3 })
ok('\u5B57\u9762\u68C0\u7D22\u786E\u5B9E\u635E\u4E0D\u5230', literal.length === 0, JSON.stringify(literal.map((n) => n.text)))
const sem = await semanticCandidates(db, '\u4F5C\u606F', { scope: 'global' })
ok('\u8BED\u4E49\u80FD\u635E\u5230', sem.some((n) => n.id === a.id), JSON.stringify(sem.map((n) => [n.text, n.cos.toFixed(3)])))
const hybrid = await hybridSearch(db, '\u4F5C\u606F', { scope: 'global', limit: 3 })
ok('\u6DF7\u5408\u6392\u5E8F\u5E26\u4E0A\u5B83', hybrid[0]?.id === a.id, JSON.stringify(hybrid.map((n) => [n.text, n.score.toFixed(3)])))

// 7. \u5B57\u9762\u547D\u4E2D\u7684\u4E0D\u80FD\u88AB\u8BED\u4E49\u6324\u4E0B\u53BB
const hitLiteral = await hybridSearch(db, 'rainy nights', { scope: 'global', limit: 3 })
ok('\u5B57\u9762\u5F3A\u7684\u8FD8\u662F\u7B2C\u4E00', hitLiteral[0]?.text.includes('rainy'), JSON.stringify(hitLiteral.map((n) => [n.text, n.score.toFixed(3)])))

// 8. \u522B\u7684 scope \u4E0D\u63BA\u548C
const other = await semanticCandidates(db, '\u4F5C\u606F', { scope: 'another-session' })
ok('\u540C owner \u7684 global \u8BB0\u5FC6\u80FD\u88AB\u5176\u4ED6\u4F1A\u8BDD\u53EC\u56DE', other.some((n) => n.id === a.id), JSON.stringify(other))

// 9. Ranking signal, not a relevance gate. Measured with the bundled model,
// unrelated pairs sit near 0.50, so an out-of-domain English query still scores
// above a 0.45 bound. Only a bound above the observed maximum is guaranteed
// empty; absolute-cosine relevance gating is unsupported.
const noise = await semanticCandidates(db, 'quantum chromodynamics lattice gauge', { scope: 'global', minCos: 0 })
const topNoise = noise[0]?.cos ?? 0
const related = await semanticCandidates(db, '\u7761\u89c9\u65f6\u95f4', { scope: 'global', minCos: 0 })
const topRelated = related[0]?.cos ?? 0
ok('\u4e0d\u76f8\u5173\u7684\u786e\u5b9e\u66f4\u4f4e', topNoise < topRelated, `noise ${topNoise.toFixed(3)} < related ${topRelated.toFixed(3)}`)
ok('\u9608\u503c\u9ad8\u4e8e\u6700\u9ad8\u5206\u65f6\u4e3a\u7a7a', (await semanticCandidates(db, 'quantum chromodynamics lattice gauge', { scope: 'global', minCos: 0.99 })).length === 0)
ok('\u9608\u503c 0.45 \u4ecd\u62e6\u4e0d\u4f4f\u57df\u5916\u95ee\u53e5\uff08\u5df2\u8bb0\u5f55\u7684\u6a21\u578b\u5c40\u9650\uff09', (await semanticCandidates(db, 'quantum chromodynamics lattice gauge', { scope: 'global', minCos: 0.45 })).length > 0)

// 10. \u5411\u91CF\u6309 float16 \u5B58\uFF1A\u4F53\u79EF\u51CF\u534A\uFF0C\u7CBE\u5EA6\u4E0D\u6389
{
  const dim = 512
  const original = new Float32Array(dim)
  for (let i = 0; i < dim; i += 1) original[i] = Math.sin(i * 0.37) * 0.7
  putVector(db, a.id, original)
  const row = db.prepare('select vec, dim from acm_vectors where node_id = ?').get(String(a.id))
  ok('\u6309 float16 \u5B58\uFF08\u6BCF\u7EF4 2 \u5B57\u8282\uFF09', row.vec.byteLength === dim * 2, `${row.vec.byteLength} \u5B57\u8282`)
  const back = getVector(db, a.id)
  const err = Math.max(...Array.from(original, (v, i) => Math.abs(v - back[i])))
  ok('\u8BFB\u56DE\u6765\u7684\u6700\u5927\u8BEF\u5DEE < 0.001', err < 0.001, err.toExponential(2))
  ok('\u4F59\u5F26\u4ECD\u7136\u63A5\u8FD1 1', cosine(original, back) > 0.9999, cosine(original, back).toFixed(6))
  // \u8001\u5E93\u91CC\u7684 float32 \u4E5F\u5F97\u8BFB\u5F97\u51FA\u6765
  db.prepare('update acm_vectors set vec = ? where node_id = ?').run(Buffer.from(original.buffer), String(a.id))
  const mixed = getVector(db, a.id)
  ok('\u8001 float32 \u6570\u636E\u8FD8\u8BFB\u5F97\u51FA\u6765', cosine(original, mixed) > 0.9999, cosine(original, mixed).toFixed(6))
  putVector(db, a.id, original)
}

void b
void c
void encode

// 11. Multilingual recall must survive the English-only maintenance policy:
// the policy only constrains maintained text, not the model or the tokenizer.
// Chinese query -> matching Chinese fact must rank first in its own store.
{
  const zhDb = openDb(join(root, 'zh.db'))
  const zhSleep = remember(zhDb, { scope: 'global', text: '\u8001\u5927\u51cc\u6668\u4e24\u70b9\u624d\u7761', kind: 'fact' })
  remember(zhDb, { scope: 'global', text: '\u9cb8\u9c7c\u751f\u6d3b\u5728\u6df1\u6d77', kind: 'fact' })
  remember(zhDb, { scope: 'global', text: '\u5979\u559c\u6b22\u4e0b\u96e8\u7684\u591c\u665a', kind: 'fact' })
  await embedMissing(zhDb, { limit: 10 })
  const zhHits = await semanticCandidates(zhDb, '\u4ec0\u4e48\u65f6\u5019\u7761\u89c9', { scope: 'global' })
  ok('\u4e2d\u6587\u95ee\u53e5\u547d\u4e2d\u4e2d\u6587\u4e8b\u5b9e', zhHits[0]?.id === zhSleep.id, JSON.stringify(zhHits.slice(0, 3).map((n) => [n.text, n.cos.toFixed(3)])))
  const zhTokens = basicTokens('\u770b\u6d77 hello')
  ok('\u4e2d\u6587\u5207\u8bcd\u4e0d\u53d7\u653f\u7b56\u5f71\u54cd', JSON.stringify(zhTokens) === JSON.stringify(['\u770b', '\u6d77', 'hello']), JSON.stringify(zhTokens))
  zhDb.close()
}

// 12. Vector-space fingerprint. Changing pooling or the model changes the
// space, so an old database must be reported as stale rather than silently
// mixed with new query vectors, and reembedAll() must be able to migrate it.
{
  const fpDb = openDb(join(root, 'fp.db'))
  remember(fpDb, { scope: 'global', text: 'fingerprint probe fact', kind: 'fact' })
  await embedMissing(fpDb, { limit: 5 })
  const fresh = vectorStats(fpDb)
  ok('\u65b0\u5e93\u5199\u5165\u540e\u6307\u7eb9\u5339\u914d', fresh.stale === false, JSON.stringify(fresh))
  metaSet(fpDb, 'embed_fingerprint', 'bge-small-zh-v1.5|pool=mean|dim=512')
  const legacy = vectorStats(fpDb)
  ok('\u65e7\u7f16\u7801\u5e93\u88ab\u6807\u8bb0\u4e3a\u9648\u65e7', legacy.stale === true, JSON.stringify(legacy))
  const migrated = await reembedAll(fpDb, { batch: 4 })
  ok('\u91cd\u5efa\u540e\u4e0d\u518d\u9648\u65e7', vectorStats(fpDb).stale === false, `rewrote ${migrated}`)
  fpDb.close()
}

// A vector written by a different encoding must not be ranked: the scores are not
// comparable, and a silent wrong ordering is worse than a lexical fallback.
{
  const staleDb = openDb(join(root, 'stale.db'))
  try {
    const node = remember(staleDb, { scope: 's', text: 'the stale space marker is cobalt-9', source: { raw: 'cobalt' } })
    putVector(staleDb, node.id, new Float32Array(512).fill(0.1))
    metaSet(staleDb, 'embed_fingerprint', 'an-older-encoding')
    const refused = await semanticCandidates(staleDb, 'cobalt-9 marker', { scope: 's', minCos: 0 })
    ok('stale vectors are refused', refused.length === 0, String(refused.length))
    const forced = await semanticCandidates(staleDb, 'cobalt-9 marker', { scope: 's', minCos: -1, allowStale: true })
    ok('diagnostics can still see them', forced.length === 1, String(forced.length))
  } finally {
    staleDb.close()
  }
}

console.log(`\nsemantic: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
