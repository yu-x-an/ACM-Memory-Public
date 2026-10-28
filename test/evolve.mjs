// \u8FDB\u5316\uFF1A\u6295\u7968\u3001\u5408\u5E76\u8FD1\u91CD\u590D\u3001\u6309\u53CD\u9988\u8C03\u6743\u91CD\u3001\u7559\u62A5\u544A

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db.mjs'
import { feedback, loadWeights, mergeDuplicates, remember, search, weightsNow } from '../lib/memory.mjs'
import { evolve, evolutionLog, MIN_FEEDBACK, renderEvolution } from '../lib/evolve.mjs'
import { TOOLS } from '../lib/core.mjs'
import { embedText, putVector } from '../lib/embed.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-evolve-'))
const dbPath = join(dir, 'memory.db')
const db = openDb(dbPath)

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { fails.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

// ── \u6295\u7968
const n1 = remember(db, { scope: 's', text: 'master likes iced coffee', key: 'master.drink' })
const up = feedback(db, n1.id, 'useful')
ok('\u6295\u5BF9\u4E86\u91CD\u8981\u5EA6\u4E0A\u5347', up.ok && up.importance > 0.5, String(up.importance))

const n2 = remember(db, { scope: 's', text: 'master drinks whiskey at night', key: 'master.night' })
feedback(db, n2.id, 'wrong')
feedback(db, n2.id, 'wrong')
const third = feedback(db, n2.id, 'wrong')
ok('\u9519\u4E09\u6B21\u5C31\u81EA\u52A8\u5931\u6548', third.retired === true, JSON.stringify(third))
ok('\u5931\u6548\u7684\u4E0D\u518D\u88AB\u641C\u5230', !search(db, { query: 'whiskey', scope: 's' }).some((h) => h.id === n2.id))
ok('\u6295\u4E0D\u5B58\u5728\u7684\u4E0D\u70B8', feedback(db, 99999, 'useful').ok === false)

// ── \u5408\u5E76\u8FD1\u91CD\u590D\u4E4B\u4E00\uFF1A\u8BCD\u888B\u4E00\u6837\u4F46\u53EA\u662F\u6362\u4E86\u8BED\u5E8F —— \u4E0D\u8BB8\u5E76\uFF08\u4F1A\u5E76\u9519\uFF09
const m1 = remember(db, { scope: 's', text: 'deploy goes through staging first', at: Date.now() })
const m2 = remember(db, { scope: 's', text: 'first staging through deploy goes', at: Date.now() + 1 })
ok('\u4E24\u6761\u5148\u90FD\u5728', m1.id !== m2.id)
const shuffled = mergeDuplicates(db, { dryRun: true })
ok('\u53EA\u662F\u6362\u8BED\u5E8F\u4E0D\u5E76', shuffled.merged === 0, JSON.stringify(shuffled))

// ── \u5408\u5E76\u8FD1\u91CD\u590D\u4E4B\u4E8C\uFF1A\u6362\u4E86\u8BF4\u6CD5\u7684\u540C\u4E00\u4EF6\u4E8B —— \u6709\u5411\u91CF\u5C31\u8BE5\u5E76
const p1 = remember(db, { scope: 's2', text: 'deploy goes through staging first', at: Date.now() + 2 })
const p2 = remember(db, { scope: 's2', text: 'every release is staged before production', at: Date.now() + 3 })
putVector(db, p1.id, await embedText('deploy goes through staging first'))
putVector(db, p2.id, await embedText('every release is staged before production'))
const dry = mergeDuplicates(db, { dryRun: true, mergeCos: 0.4 })
ok('\u6362\u8BF4\u6CD5\u7684\u62A5\u5F97\u51FA\u8981\u5E76', dry.merged >= 1 && dry.semantic >= 1, JSON.stringify(dry))
const merged = mergeDuplicates(db, { mergeCos: 0.4 })
ok('\u771F\u5408\u4E86', merged.merged >= 1, String(merged.merged))
const survivor = db.prepare('select id, status from acm_nodes where id in (?, ?)').all(p1.id, p2.id)
ok('\u53EA\u5269\u4E00\u6761\u6D3B\u7684', survivor.filter((r) => r.status === 'active').length === 1, JSON.stringify(survivor))
const droppedId = survivor.find((r) => r.status !== 'active')?.id
const keptId = survivor.find((r) => r.status === 'active')?.id
ok('\u88AB\u5408\u5E76\u7684\u6709\u7ED3\u675F\u65F6\u95F4\u548C merged_into \u8FB9', (() => {
  const row = db.prepare('select valid_to from acm_nodes where id = ?').get(droppedId)
  const edge = db.prepare("select id from acm_edges where src = ? and dst = ? and rel = 'merged_into'").get(droppedId, keptId)
  return row?.valid_to != null && !!edge
})())
ok('\u6765\u6E90\u642C\u5230\u4E86\u7559\u4E0B\u7684\u90A3\u6761', Number(db.prepare('select count(*) c from acm_node_sources where node_id = ?').get(keptId).c) >= 2)

// ── \u6743\u91CD
const before = weightsNow()
ok('feedback \u4E0D\u591F\u65F6\u4E0D\u52A8\u6743\u91CD', (() => {
  const fresh = openDb(join(dir, 'fresh.db'))
  remember(fresh, { scope: 's', text: 'solo fact here' })
  const r = evolve(fresh, {})
  const same = JSON.stringify(r.weightsBefore) === JSON.stringify(r.weightsAfter)
  fresh.close()
  return r.tuned === false && same
})())

// \u8865\u5230\u591F\u9608\u503C\uFF1A\u9519\u8BEF\u7387 > 30% → \u66F4\u4FE1\u91CD\u8981\u5EA6\u3001\u5C11\u4FE1\u5B57\u9762\u3001\u6269\u8FB9\u66F4\u4FDD\u5B88
const nodes = []
for (let i = 0; i < MIN_FEEDBACK; i++) nodes.push(remember(db, { scope: 's', text: `filler fact number ${i}` }))
for (let i = 0; i < 3; i++) feedback(db, nodes[i].id, 'wrong')
for (let i = 3; i < MIN_FEEDBACK; i++) feedback(db, nodes[i].id, 'useful')
const report = evolve(db, {})
const after = weightsNow()
ok('\u53CD\u9988\u591F\u4E86\u5C31\u4F1A\u8C03', report.tuned === true, JSON.stringify({ fb: report.feedback, rate: report.wrongRate }))
ok('\u66F4\u4FE1\u91CD\u8981\u5EA6', after.importance > before.importance, `${before.importance} → ${after.importance}`)
ok('\u5C11\u4FE1\u5B57\u9762\u8986\u76D6', after.coverage < before.coverage, `${before.coverage} → ${after.coverage}`)
ok('\u6269\u8FB9\u66F4\u4FDD\u5B88', after.hopPenalty < before.hopPenalty, `${before.hopPenalty} → ${after.hopPenalty}`)
ok('\u62A5\u544A\u80FD\u8BFB\u6210\u4EBA\u8BDD', renderEvolution(report).includes('feedback'))

// ── \u6301\u4E45\u5316
db.close()
const db2 = openDb(dbPath)
ok('\u6743\u91CD\u91CD\u542F\u8FD8\u5728', JSON.stringify(loadWeights(db2)) === JSON.stringify(after), JSON.stringify(loadWeights(db2)))
ok('\u8FDB\u5316\u65E5\u5FD7\u6709\u8BB0\u5F55', evolutionLog(db2, 5).length >= 1, String(evolutionLog(db2, 5).length))
db2.close()

ok('\u5DE5\u5177\u91CC\u6709 feedback \u548C evolve', TOOLS.some((t) => t.name === 'acm_feedback') && TOOLS.some((t) => t.name === 'acm_evolve'))

console.log(`\n${fails.length ? '\u6709\u5931\u8D25' : '\u5168\u7EFF'}  ${pass} \u9879\u901A\u8FC7${fails.length ? `\uFF0C${fails.length} \u9879\u5931\u8D25` : ''}`)
if (fails.length) { for (const x of fails) console.log(`  - ${x}`); process.exitCode = 1 }
try { rmSync(dir, { recursive: true, force: true }) } catch {}
