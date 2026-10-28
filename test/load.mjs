// \u538B\u6D4B\uFF1A\u5199\u5F97\u591A\u5FEB\u3001\u67E5\u5F97\u591A\u5FEB\u3001\u4E24\u4E2A\u8FDE\u63A5\u540C\u65F6\u5199\u4F1A\u4E0D\u4F1A SQLITE_BUSY
// \u4E0D\u662F\u57FA\u51C6\u6D4B\u8BD5\uFF0C\u662F"\u4F1A\u4E0D\u4F1A\u5361\u4F4F"\u7684\u4F53\u68C0\u3002

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { openDb } from '../lib/db.mjs'
import { remember, search, stats } from '../lib/memory.mjs'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  XX  ${name} ${extra}`) }
}

const root = mkdtempSync(join(tmpdir(), 'acm-load-'))
const dbPath = join(root, 'memory.db')
const db = openDb(dbPath)

const WORDS = 'sea whale night rain tea window glass paper stone river cloud sugar ladder engine harbor meadow candle feather mirror pocket copper'.split(' ')
const pick = (i) => `${WORDS[i % WORDS.length]} ${WORDS[(i * 7 + 3) % WORDS.length]} ${i}`

// ── 1. \u5199\u5165\u541E\u5410\uFF1A3000 \u6761
const N = 3000
const t0 = Date.now()
for (let i = 0; i < N; i += 1) {
  remember(db, { scope: 'load', text: pick(i), kind: 'fact', source: { sessionId: 'load', seq: i, raw: `\u7B2C ${i} \u6761` } })
}
const writeMs = Date.now() - t0
ok(`\u5199\u5165 ${N} \u6761\u4E0D\u8D85 60s`, writeMs < 60000, `${writeMs}ms`)
ok('\u6761\u6570\u5BF9\u5F97\u4E0A', stats(db).nodes === N, JSON.stringify(stats(db).nodes))
const perWrite = writeMs / N
console.log(`     \u6BCF\u6B21\u5199\u5165 ${perWrite.toFixed(2)}ms`)

// ── 2. \u68C0\u7D22\u5EF6\u8FDF\uFF1A50 \u6B21
const t1 = Date.now()
let hits = 0
for (let i = 0; i < 50; i += 1) {
  const r = search(db, { query: `${WORDS[i % WORDS.length]} ${WORDS[(i * 5 + 1) % WORDS.length]}`, scope: 'load', limit: 6 })
  hits += r.length
}
const searchMs = Date.now() - t1
ok('50 \u6B21\u68C0\u7D22\u90FD\u5728 6s \u5185', searchMs < 6000, `${searchMs}ms`)
ok('\u68C0\u7D22\u6709\u7ED3\u679C', hits > 0, String(hits))
console.log(`     \u5355\u6B21\u68C0\u7D22 ${(searchMs / 50).toFixed(2)}ms`)

// ── 3. \u534A\u4E2A\u5E93\u7684\u91CF\u7EA7\u4E0B gc / \u5408\u5E76\u8FD8\u80FD\u8DD1
const t2 = Date.now()
const st = stats(db)
ok('stats \u4FBF\u5B9C\uFF08<200ms\uFF09', Date.now() - t2 < 200, `${Date.now() - t2}ms`)
ok('\u7D22\u5F15\u90FD\u5728', st.nodes === N && st.sources === N, JSON.stringify(st))

// ── 4. \u4E24\u4E2A\u8FDE\u63A5\u771F\u5E76\u53D1\u5199\uFF1AWAL + busy_timeout \u5E94\u8BE5\u81EA\u5DF1\u7B49\uFF0C\u4E0D\u8BE5\u62A5 BUSY
const workerErrors = []
const worker = new Worker(new URL('./_load-writer.mjs', import.meta.url), { workerData: { dbPath, scope: 'c', count: 300 } })
worker.on('error', (err) => workerErrors.push(String(err?.message ?? err)))
const workerDone = new Promise((resolve) => worker.on('exit', resolve))
const t3 = Date.now()
for (let i = 0; i < 300; i += 1) {
  remember(db, { scope: 'c', text: `main writes ${i}`, kind: 'fact', source: { sessionId: 'c', seq: i, raw: `\u4E3B\u7EBF ${i}` } })
}
await workerDone
const concurrentMs = Date.now() - t3
ok('\u5E76\u53D1\u5199\u4E0D\u62A5 BUSY', workerErrors.length === 0, workerErrors.join('; '))
ok('\u4E24\u8FB9\u5404 300 \u6761\u90FD\u8FDB\u53BB\u4E86', Number(db.prepare("select count(*) c from acm_nodes where scope = 'c'").get().c) === 600, String(Number(db.prepare("select count(*) c from acm_nodes where scope = 'c'").get().c)))
console.log(`     600 \u6761\u5E76\u53D1\u5199 ${concurrentMs}ms`)

// ── 5. \u4E07\u6761\u89C4\u6A21\u7684\u4E24\u8DF3\u6269\u6563\uFF1A\u6BCF 10 \u6761\u4E8B\u5B9E\u5171\u7528\u4E00\u4E2A\u6765\u6E90\uFF0Cexpand \u4F1A\u628A 9 \u4E2A\u5144\u5F1F\u62C9\u56DE\u6765
const BIG = 12000
const t4 = Date.now()
for (let i = 0; i < BIG; i += 1) {
  remember(db, {
    scope: 'big',
    text: `big corpus item ${i} ${WORDS[i % WORDS.length]}`,
    kind: 'fact',
    source: { sessionId: 'big', seq: Math.floor(i / 10), raw: `\u7B2C ${Math.floor(i / 10)} \u7EC4\u539F\u8BDD` },
  })
}
const bigWriteMs = Date.now() - t4
console.log(`     ${BIG} \u6761\u5199\u5165 ${bigWriteMs}ms\uFF08${(bigWriteMs / BIG).toFixed(2)}ms/\u6761\uFF09`)

// A p95 of 30 samples is the second-largest value, not a percentile: one GC pause
// on a shared runner fails the gate while identical code measures 2.4x faster on
// the next run. Same commit, same runner image: p50 24 / p95 45 in one run and
// p50 38 / p95 96 in the next. So measure more samples,
// discard the warm-up, and gate on three things instead of one number:
//   - the median, which moves when the code gets slower;
//   - a ceiling on the tail, which catches a catastrophe without pretending a
//     shared runner can certify a latency SLA;
//   - the ratio to the same corpus searched without expansion, which is the part
//     that does not depend on how fast the machine happens to be.
const SAMPLES = 60
const WARMUP = 6
const lat = []
for (let i = 0; i < SAMPLES + WARMUP; i += 1) {
  const t5 = Date.now()
  search(db, { query: `${WORDS[i % WORDS.length]}`, scope: 'big', limit: 6, expand: true })
  if (i >= WARMUP) lat.push(Date.now() - t5)
}
lat.sort((a, b) => a - b)
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]
const p50 = pct(0.5)
const p90 = pct(0.9)
const p95 = pct(0.95)
const worst = lat[lat.length - 1]

const noExpand = []
for (let i = 0; i < SAMPLES; i += 1) {
  const t6 = Date.now()
  search(db, { query: `${WORDS[i % WORDS.length]}`, scope: 'big', limit: 6, expand: false })
  noExpand.push(Date.now() - t6)
}
noExpand.sort((a, b) => a - b)
const baseP50 = Math.max(1, noExpand[Math.floor(noExpand.length * 0.5)])
const ratio = p50 / baseP50

ok('12k two-hop expansion: median within 60ms', p50 <= 60, `p50 ${p50}ms`)
ok('12k two-hop expansion: tail within 150ms', p95 <= 150, `p95 ${p95}ms / max ${worst}ms`)
ok('expansion costs at most 8x the same search without it', ratio <= 8, `ratio ${ratio.toFixed(1)}x (${p50}/${baseP50}ms)`)
console.log(`     12k expand p50 ${p50} / p90 ${p90} / p95 ${p95} / max ${worst}ms; no-expand p50 ${baseP50}ms; ratio ${ratio.toFixed(1)}x`)

// ── 6. \u5E93\u6709\u591A\u5927\uFF1A\u6BCF\u6761\u8282\u70B9\u5360\u591A\u5C11\u5B57\u8282\uFF08\u542B\u6765\u6E90\u3001\u7D22\u5F15\u3001\u5411\u91CF\u4E3A\u7A7A\uFF09
const size = statSync(dbPath).size
ok('\u6BCF\u6761\u8BB0\u5F55\uFF08\u8282\u70B9+\u6765\u6E90\uFF09\u4E0D\u8D85\u8FC7 2KB', size / stats(db).nodes < 2048, `${(size / 1024).toFixed(0)}KB / ${stats(db).nodes} \u6761`)
console.log(`     \u5E93 ${(size / 1024 / 1024).toFixed(1)}MB\uFF0C${stats(db).nodes} \u6761\uFF0C\u6BCF\u6761\u7EA6 ${(size / stats(db).nodes).toFixed(0)}B`)

db.close()
rmSync(root, { recursive: true, force: true })

console.log(`\n\u538B\u6D4B ${pass + fail} \u9879\uFF1A${pass} \u901A\u8FC7\uFF0C${fail} \u5931\u8D25`)
if (fail) process.exit(1)
