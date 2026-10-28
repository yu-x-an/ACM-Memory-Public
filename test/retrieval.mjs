/**
 * Retrieval quality baseline (Memory CI).
 *
 * A fixed corpus plus fixed queries, scored on hit@1 and hit@3. The thresholds
 * sit below the numbers measured on this commit, so the check fails when ranking
 * regresses rather than when the model drifts by a thousandth:
 *
 *   English keyword  hit@1 1.00  hit@3 1.00
 *   Chinese gloss    hit@1 0.88  hit@3 1.00
 *   paraphrase       hit@1 1.00  hit@3 1.00
 *
 * The corpus strings are real escapes (single backslash). An earlier revision
 * double-escaped them, so the tokenizer indexed the literal text "u9879" and
 * every query matched that same gibberish: the scores were consistent and
 * meaningless. The numbers above are from the corrected strings.
 *
 * Scope note: this harness runs the lexical path only, because that path is
 * deterministic across machines and needs no model load. Embedding quality has
 * its own suite (test/semantic.mjs), which does load the model.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { remember, search } from '../lib/memory.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-retrieval-'))
const db = openDb(join(dir, 'memory.db'))
const SCOPE = 'ci'

/** English fact + the Chinese phrasing a user would actually type. */
const corpus = [
  { key: 'project.database', text: 'the project stores data in sqlite', gloss: '\u9879\u76EE\u7528 sqlite \u5B58\u6570\u636E' },
  { key: 'project.deploy', text: 'deployment runs on a single staging node', gloss: '\u90E8\u7F72\u8DD1\u5728\u5355\u53F0\u9884\u53D1\u673A\u5668' },
  { key: 'master.bedtime', text: 'master sleeps at two in the morning', gloss: '\u8001\u5927\u51CC\u6668\u4E24\u70B9\u624D\u7761' },
  { key: 'master.style', text: 'master prefers short and direct replies', gloss: '\u8001\u5927\u559C\u6B22\u7B80\u77ED\u76F4\u63A5\u7684\u56DE\u7B54' },
  { key: 'team.backend', text: 'the backend is written in node.js with es modules', gloss: '\u540E\u7AEF\u7528 node \u6A21\u5757\u5199' },
  { key: 'team.review', text: 'every change needs one reviewer before merge', gloss: '\u5408\u5E76\u524D\u9700\u8981\u4E00\u4E2A\u4EBA\u5BA1\u67E5' },
  { key: 'ops.backup', text: 'backups are taken every six hours and keep seven copies', gloss: '\u6BCF\u516D\u5C0F\u65F6\u5907\u4EFD\u4E00\u6B21\u4FDD\u7559\u4E03\u4EFD' },
  { key: 'ops.alert', text: 'alerts go to the on-call phone at night', gloss: '\u591C\u91CC\u62A5\u8B66\u6253\u503C\u73ED\u624B\u673A' },
  { key: 'pet.whale', text: 'the whale lives in the deep sea', gloss: '\u9CB8\u9C7C\u751F\u6D3B\u5728\u6DF1\u6D77' },
  { key: 'pet.rain', text: 'she likes rainy nights by the window', gloss: '\u5979\u559C\u6B22\u7A97\u8FB9\u7684\u96E8\u591C' },
  { key: 'note.coffee', text: 'coffee consumption peaks before noon', gloss: '\u5496\u5561\u5728\u4E2D\u5348\u524D\u559D\u5F97\u6700\u591A' },
  { key: 'note.graph', text: 'the graph view shows source edges between facts', gloss: '\u56FE\u89C6\u56FE\u663E\u793A\u4E8B\u5B9E\u4E4B\u95F4\u7684\u6765\u6E90\u8FB9' },
]

for (const item of corpus) {
  remember(db, { scope: 'global', text: item.text, gloss: item.gloss, key: item.key, source: { raw: item.text } })
}

const queries = [
  { q: 'sqlite', expect: 'project.database' },
  { q: 'staging node', expect: 'project.deploy' },
  { q: 'reviewer merge', expect: 'team.review' },
  { q: 'es modules', expect: 'team.backend' },
  { q: 'on-call phone', expect: 'ops.alert' },
  { q: 'deep sea whale', expect: 'pet.whale' },
  { q: 'rainy nights window', expect: 'pet.rain' },
  { q: 'coffee noon', expect: 'note.coffee' },
]

const zhQueries = [
  { q: '\u9879\u76EE \u6570\u636E\u5E93', expect: 'project.database' },
  { q: '\u90E8\u7F72 \u9884\u53D1', expect: 'project.deploy' },
  { q: '\u8001\u5927 \u7761\u89C9', expect: 'master.bedtime' },
  { q: '\u5BA1\u67E5 \u5408\u5E76', expect: 'team.review' },
  { q: '\u5907\u4EFD \u4FDD\u7559', expect: 'ops.backup' },
  { q: '\u9CB8\u9C7C \u6DF1\u6D77', expect: 'pet.whale' },
  { q: '\u5496\u5561 \u4E2D\u5348', expect: 'note.coffee' },
  { q: '\u56FE \u6765\u6E90', expect: 'note.graph' },
]

function score(list) {
  let hit1 = 0
  let hit3 = 0
  const misses = []
  for (const { q, expect } of list) {
    const rows = search(db, { query: q, scope: SCOPE, limit: 3 })
    const keys = rows.map((r) => r.key)
    if (keys[0] === expect) hit1 += 1
    if (keys.includes(expect)) hit3 += 1
    else misses.push(`${q} -> ${JSON.stringify(keys)}`)
  }
  return { total: list.length, hit1: hit1 / list.length, hit3: hit3 / list.length, misses }
}

let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

try {
  const en = score(queries)
  const zh = score(zhQueries)
  console.log(
    `\n lexical hit@1 en=${en.hit1.toFixed(2)} zh=${zh.hit1.toFixed(2)}` +
      ` | hit@3 en=${en.hit3.toFixed(2)} zh=${zh.hit3.toFixed(2)}`,
  )

  t('English keyword queries land on the right fact', () => {
    assert.ok(en.hit3 >= 0.9, `hit@3 ${en.hit3} below 0.9; misses: ${en.misses.join('; ')}`)
    assert.ok(en.hit1 >= 0.85, `hit@1 ${en.hit1} below 0.85`)
  })

  t('Chinese phrasing retrieves the English fact through its gloss', () => {
    assert.ok(zh.hit3 >= 0.9, `hit@3 ${zh.hit3} below 0.9; misses: ${zh.misses.join('; ')}`)
    assert.ok(zh.hit1 >= 0.7, `hit@1 ${zh.hit1} below 0.7`)
  })

  t('an unrelated query returns nothing', () => {
    assert.equal(search(db, { query: 'zzzqx wwvbn', scope: SCOPE }).length, 0)
  })

  t('ranking is deterministic for the same query', () => {
    const a = search(db, { query: 'backup copies', scope: SCOPE, limit: 5 }).map((n) => n.id)
    const b = search(db, { query: 'backup copies', scope: SCOPE, limit: 5 }).map((n) => n.id)
    assert.deepEqual(a, b)
  })

  t('retrieval never crosses the owner partition', () => {
    remember(db, { scope: 'global', owner: 'someone-else', text: 'sqlite secret of another owner', key: 'other.database' })
    const rows = search(db, { query: 'sqlite', scope: SCOPE, owner: null, limit: 10 })
    assert.ok(!rows.some((r) => r.key === 'other.database'))
  })

  // --- Paraphrase robustness: a different subset of the same gloss. ---
  const zhAlt = [
    { q: '\u9879\u76ee \u6570\u636e', expect: 'project.database' },
    { q: 'sqlite \u5b58', expect: 'project.database' },
    { q: '\u90e8\u7f72 \u5355\u53f0', expect: 'project.deploy' },
    { q: '\u9884\u53d1 \u673a\u5668', expect: 'project.deploy' },
    { q: '\u51cc\u6668 \u7761', expect: 'master.bedtime' },
    { q: '\u7b80\u77ed \u56de\u7b54', expect: 'master.style' },
    { q: '\u5408\u5e76 \u5ba1\u67e5', expect: 'team.review' },
    { q: '\u6df1\u6d77 \u9cb8\u9c7c', expect: 'pet.whale' },
  ]
  const alt = score(zhAlt)
  console.log(` paraphrase hit@1=${alt.hit1.toFixed(2)} hit@3=${alt.hit3.toFixed(2)}`)

  t('a paraphrase outside the original phrasing still finds the fact', () => {
    assert.ok(alt.hit3 >= 0.85, `hit@3 ${alt.hit3} below 0.85; misses: ${alt.misses.join('; ')}`)
    assert.ok(alt.hit1 >= 0.6, `hit@1 ${alt.hit1} below 0.6; misses: ${alt.misses.join('; ')}`)
  })

  // --- False positives: an unrelated question must return nothing. ---
  t('unrelated questions return nothing', () => {
    for (const q of ['quantum chromodynamics', 'zkzk zkzk', '\u91cf\u5b50\u8272\u52a8\u529b\u5b66']) {
      assert.equal(search(db, { query: q, scope: SCOPE }).length, 0, `query "${q}" returned rows`)
    }
  })

  // --- Temporal updates: the newest value wins, the old one stops being served. ---
  const tv1 = remember(db, { scope: 'temporal', text: 'the region is eu west', key: 'cloud.region', source: { raw: 'eu west' } })
  const tv2 = remember(db, { scope: 'temporal', text: 'the region is us east', key: 'cloud.region', source: { raw: 'us east' } })

  t('a superseded value is no longer returned', () => {
    const hits = search(db, { query: 'region eu west', scope: 'temporal', limit: 5 })
    assert.ok(hits.some((n) => n.id === tv2.id), 'the newer value was not found')
    assert.ok(!hits.some((n) => n.id === tv1.id), 'the superseded value is still being returned')
  })

  t('the current value is reachable by its own wording', () => {
    const hits = search(db, { query: 'region us east', scope: 'temporal', limit: 5 })
    assert.equal(hits[0]?.id, tv2.id, JSON.stringify(hits.map((n) => n.text)))
  })

  console.log(`\nretrieval: ${pass} passed`)
} finally {
  try { db.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
}
