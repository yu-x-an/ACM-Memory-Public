// \u65F6\u95F4\u8F74\u3001\u591A\u79DF\u6237\u3001\u53EF\u89C6\u5316\u3001SDK \u56DB\u6837

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../lib/db.mjs'
import { history, mergeDuplicates, remember, search, forget, sourcesOf, touch } from '../lib/memory.mjs'
import { buildGraph, renderGraphHtml } from '../lib/graph.mjs'
import { openMemory } from '../lib/sdk.mjs'

const here = dirname(fileURLToPath(import.meta.url))
void here
const dir = mkdtempSync(join(tmpdir(), 'acm-extras-'))
const db = openDb(join(dir, 'memory.db'))

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { fails.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const t0 = Date.UTC(2026, 0, 1)
const t1 = Date.UTC(2026, 1, 1)

// ── \u65F6\u95F4\u8F74
const a = remember(db, { scope: 's1', text: 'master goes to bed at 23:00', key: 'master.bedtime', at: t0 })
const b = remember(db, { scope: 's1', text: 'master goes to bed at 01:00', key: 'master.bedtime', at: t1 })
ok('\u6362\u4E86\u4E2A\u8BF4\u6CD5\u540C key \u4F1A\u65B0\u5F00\u4E00\u6761', b.id !== a.id && b.superseded === a.id, `${a.id}/${b.id}`)
const tl = history(db, { key: 'master.bedtime', scope: 's1' })
ok('\u5386\u53F2\u91CC\u6709\u4E24\u6761', tl.length === 2, String(tl.length))
const oldRow = tl.find((x) => x.id === a.id)
const newRow = tl.find((x) => x.id === b.id)
ok('\u65E7\u7684\u90A3\u6761\u6709\u7ED3\u675F\u65F6\u95F4', oldRow?.to === t1 && oldRow?.status === 'superseded', JSON.stringify(oldRow))
ok('\u65B0\u7684\u90A3\u6761\u5230\u73B0\u5728\u8FD8\u6210\u7ACB', newRow?.to === null && newRow?.from === t1, JSON.stringify(newRow))

const f = remember(db, { scope: 's1', text: 'master likes iced coffee', key: 'master.drink', at: t0 })
forget(db, f.id, t1)
const fh = history(db, { key: 'master.drink', scope: 's1' })
ok('\u5FD8\u6389\u4E5F\u7559\u7ED3\u675F\u65F6\u95F4', fh[0]?.status === 'forgotten' && fh[0]?.to === t1, JSON.stringify(fh[0]))

// ── \u591A\u79DF\u6237
remember(db, { scope: 's2', text: 'alice prefers terse answers', owner: 'alice', at: t0 })
remember(db, { scope: 's2', text: 'bob prefers long essays', owner: 'bob', at: t0 })
const asAlice = search(db, { query: 'terse answers', scope: 's2', owner: 'alice' })
const asBob = search(db, { query: 'terse answers', scope: 's2', owner: 'bob' })
ok('alice \u67E5\u5F97\u5230\u81EA\u5DF1\u7684', asAlice.some((h) => h.text.includes('alice')))
ok('bob \u67E5\u4E0D\u5230 alice \u7684', !asBob.some((h) => h.text.includes('alice')), JSON.stringify(asBob.map((h) => h.text)))
remember(db, { scope: 's2', text: 'shared server runs node 24', at: t0 })
ok('legacy \u8BB0\u5FC6\u4E0D\u5411\u5176\u4ED6 owner \u5171\u4EAB', !search(db, { query: 'node 24', scope: 's2', owner: 'bob' }).some((h) => h.text.includes('node 24')))

// ── \u53EF\u89C6\u5316
touch(db, [b.id])
const graph = buildGraph(db, { scope: 's1' })
ok('\u56FE\u91CC\u6709\u8282\u70B9', graph.nodes.length >= 2, String(graph.nodes.length))
ok('\u56FE\u91CC\u5E26\u4E0D\u4E0A\u522B\u7684\u4F1A\u8BDD', graph.nodes.every((n) => n.scope === 's1' || n.scope === 'global'))
const html = renderGraphHtml(graph, { sessionId: 's1' })
ok('html \u91CC\u6709 svg', html.includes('<svg'))
ok('html \u91CC\u6709\u8282\u70B9\u6587\u5B57', html.includes('bedtime'))
ok('html \u81EA\u5E26\u6837\u5F0F\u6CA1\u6709\u5916\u94FE', !html.includes('<script src'))
ok('\u5931\u6548\u7684\u8282\u70B9\u4E5F\u5728\u56FE\u4E0A\uFF08\u7070\u7684\uFF09', html.includes('#a1a1aa') || html.includes('#52525b'))

// ── SDK
const sdkPath = join(dir, 'sdk.db')
const acm = openMemory({ dbPath: sdkPath, sessionId: 'job' })
acm.remember({ text: 'deploy goes through staging first', key: 'deploy.flow', source: '\u5148\u8FC7\u9884\u53D1' })
ok('sdk \u8BB0\u5F97\u4F4F\u4E5F\u641C\u5F97\u5230', acm.search('staging').some((h) => h.text.includes('staging')))
acm.checkpoint({ goal: '\u53D1\u7248', next: '\u8DD1 smoke' })
const inj = acm.inject({ query: 'staging' })
ok('sdk \u6CE8\u5165\u91CC\u6709\u4EFB\u52A1\u72B6\u6001\u548C\u8BB0\u5FC6', inj.text.includes('\u3010\u4EFB\u52A1\u72B6\u6001\u3011') && inj.text.includes('staging'), inj.text.slice(0, 60))
ok('sdk \u5386\u53F2\u80FD\u67E5', acm.history({ key: 'deploy.flow' }).length === 1)
ok('sdk \u56FE\u51FA\u5F97\u6765', acm.graphHtml().includes('<svg'))
const sdk2 = acm.forSession('job2')
ok('\u6362\u4F1A\u8BDD\u4E0D\u5F00\u65B0\u5E93', sdk2.stats().nodes === acm.stats().nodes, `${sdk2.stats().nodes}/${acm.stats().nodes}`)
acm.close()
sdk2.close()

// ── \u540C\u4E00\u4E2A key \u4E0A\u7684\u4E24\u6761\u4E8B\u5B9E\uFF0C\u79DF\u6237\u4E4B\u95F4\u4E0D\u80FD\u4E92\u76F8\u9876\u6389
const aliceKey = remember(db, { scope: 's3', text: 'alice bedtime is 22:00', key: 'bedtime', owner: 'alice', at: t0 })
const bobKey = remember(db, { scope: 's3', text: 'bob bedtime is 02:00', key: 'bedtime', owner: 'bob', at: t0 })
const aliceAfter = db.prepare('select status from acm_nodes where id = ?').get(aliceKey.id)
ok('\u522B\u4EBA\u7684\u540C key \u9876\u4E0D\u6389\u81EA\u5DF1\u7684', aliceAfter.status === 'active' && bobKey.superseded === null, JSON.stringify({ a: aliceAfter.status, s: bobKey.superseded }))

// ── \u540C\u8BCD\u4E0D\u540C key \u4E0D\u8BE5\u5408\u5E76\uFF08\u90A3\u662F\u4E24\u4EF6\u4E8B\uFF09
const k1 = remember(db, { scope: 's3', text: 'owner prefers email', key: 'contact.channel', at: t0 })
const k2 = remember(db, { scope: 's3', text: 'prefers owner email', key: 'alerts.channel', at: t0 })
const beforeMerge = db.prepare("select count(*) c from acm_nodes where status = 'active'").get().c
const mergeRes = mergeDuplicates(db)
const afterMerge = db.prepare("select count(*) c from acm_nodes where status = 'active'").get().c
ok('\u4E0D\u540C key \u7684\u4E24\u6761\u90FD\u8FD8\u5728', (() => {
  const rows = db.prepare('select id, status from acm_nodes where id in (?, ?)').all(k1.id, k2.id)
  return rows.every((r) => r.status === 'active')
})(), `${beforeMerge} → ${afterMerge}, merged=${mergeRes.merged}`)

// ── SDK \u4F20\u8FDB\u6765\u7684\u4E2D\u6587\u539F\u8BDD\u8981\u771F\u7684\u8FDB\u8BC1\u636E\uFF0C\u4E0D\u80FD\u88AB text \u9876\u6389
const acm3 = openMemory({ dbPath: join(dir, 'sdk-src.db'), sessionId: 'src' })
const srcNode = acm3.remember({ text: 'deploy goes through staging first', source: '\u5148\u8FC7\u9884\u53D1\u73AF\u5883' })
const srcRows = acm3.sources(srcNode.id)
ok('sdk \u7684\u539F\u8BDD\u8FDB\u4E86\u8BC1\u636E\u8868', srcRows.some((s) => s.raw.includes('\u5148\u8FC7\u9884\u53D1')), JSON.stringify(srcRows.map((s) => s.raw)))
acm3.close()

console.log(`\n${fails.length ? '\u6709\u5931\u8D25' : '\u5168\u7EFF'}  ${pass} \u9879\u901A\u8FC7${fails.length ? `\uFF0C${fails.length} \u9879\u5931\u8D25` : ''}`)
if (fails.length) { for (const x of fails) console.log(`  - ${x}`); process.exitCode = 1 }
try { rmSync(dir, { recursive: true, force: true }) } catch {}
