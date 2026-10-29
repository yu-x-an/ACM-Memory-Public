import { mkdtempSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { remember, stats } from '../lib/memory.mjs'
import { BACKUP_PREFIX, backupIfDue, backupDirFor, checkBackup, listBackups, pruneBackups, verifyBackups } from '../lib/backup.mjs'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  XX  ${name} ${extra}`) }
}

const root = mkdtempSync(join(tmpdir(), 'acm-backup-'))
const dbPath = join(root, 'memory.db')
const db = openDb(dbPath)
remember(db, { scope: 'global', text: 'lives in the sea', kind: 'fact' })
remember(db, { scope: 'global', text: 'likes rainy nights', kind: 'fact' })

const t0 = Date.UTC(2026, 9, 27, 10, 0, 0)

// 1. \u5230\u70B9\u5907\u4EFD
const first = backupIfDue(db, dbPath, { everyHours: 6, keep: 7 }, t0)
ok('\u5230\u70B9\u4F1A\u5907\u4E00\u4EFD', !!first.created, JSON.stringify(first))
ok('\u6587\u4EF6\u540D\u5E26 memory- \u524D\u7F00', typeof first.created === 'string' && first.created.startsWith(BACKUP_PREFIX))
ok('\u843D\u5728 backups \u76EE\u5F55', first.dir === backupDirFor(dbPath) && existsSync(first.dir))

// 2. \u521A\u5907\u8FC7\u5C31\u8DF3\u8FC7
const again = backupIfDue(db, dbPath, { everyHours: 6, keep: 7 }, t0 + 60_000)
ok('\u521A\u5907\u8FC7\u4E0D\u91CD\u590D\u5907', again.skipped === 'recent', JSON.stringify(again))

// 3. \u5FEB\u7167\u662F\u5B8C\u6574\u53EF\u8BFB\u7684\u5E93
const snap = listBackups(first.dir)[0]
const snapDb = openDb(snap)
const snapStats = stats(snapDb)
ok('\u5FEB\u7167\u91CC\u6570\u636E\u9F50\u5168', snapStats.nodes === 2 && snapStats.sources === 2, JSON.stringify(snapStats))
snapDb.close()

// 4. \u539F\u5E93\u6CA1\u88AB\u52A8\u8FC7
ok('\u539F\u5E93\u8FD8\u5728', stats(db).nodes === 2)

// 5. \u4FDD\u7559\u4EFD\u6570
for (const n of ['20200101-000000', '20200102-000000', '20200103-000000']) {
  writeFileSync(join(first.dir, `${BACKUP_PREFIX}${n}.db`), 'x')
}
const pruned = pruneBackups(first.dir, 2)
const left = listBackups(first.dir).length
ok('\u6309\u4FDD\u7559\u4EFD\u6570\u5220\u65E7\u5907\u4EFD', left === 2, `left=${left} pruned=${pruned}`)
ok('\u5177\u4F53\u5220\u4E86\u51E0\u4EFD\u5BF9\u5F97\u4E0A', pruned === 2, `pruned=${pruned}`)

// 6. \u5173\u6389\u5C31\u4E0D\u52A8
const off = backupIfDue(db, dbPath, { enabled: false }, t0 + 10 * 3600e3)
ok('\u5173\u6389\u540E\u4E0D\u5907\u4EFD', off.skipped === 'disabled', JSON.stringify(off))

// 7. \u5E93\u4E0D\u5B58\u5728\u65F6\u8DF3\u8FC7
const missing = backupIfDue(db, join(root, 'nope', 'none.db'), {}, t0)
ok('\u5E93\u4E0D\u5B58\u5728\u4E5F\u4E0D\u70B8', missing.skipped === 'no-db', JSON.stringify(missing))

// 8. \u5931\u8D25\u4E0D\u5F80\u5916\u629B\uFF08\u6743\u9650/\u8DEF\u5F84\u574F\u6389\u4E5F\u4E0D\u8BE5\u62D6\u57AE\u4E3B\u6D41\u7A0B\uFF09
const bad = backupIfDue(db, dbPath, { dir: join(root, 'x', 'y'), everyHours: 0 }, t0 + 20 * 3600e3)
ok('\u6B63\u5E38\u76EE\u5F55\u4E0B\u80FD\u5907', !!bad.created || bad.skipped === 'recent', JSON.stringify(bad))

// 9. Recovery evidence: a backup must open, pass SQLite's integrity check and
// still hold data. These cases deliberately include a corrupted copy.
{
  const dir = backupDirFor(dbPath)
  const report = verifyBackups(dir)
  ok('backups can be verified', report.length > 0, JSON.stringify(report))
  const healthy = report.find((r) => r.ok)
  ok('a healthy backup reports its schema and row count', !!healthy && healthy.schema >= 1 && healthy.nodes >= 0, JSON.stringify(healthy))
  ok('verification is newest first', report.every((r, i) => i === 0 || (report[i - 1].at ?? 0) >= (r.at ?? 0)))

  const source = report[0]?.path
  const broken = join(root, 'broken.db')
  writeFileSync(broken, 'this is not a sqlite database')
  const badCheck = checkBackup(broken)
  ok('a corrupted file is reported, not trusted', badCheck.ok === false, JSON.stringify(badCheck))
  ok('a missing file is reported as missing', checkBackup(join(root, 'nope.db')).reason === 'missing')
  ok('the healthy backup still exists next to the broken one', !!source && existsSync(source))
}

db.close()
rmSync(root, { recursive: true, force: true })

console.log(`\n\u5907\u4EFD ${pass + fail} \u9879\uFF1A${pass} \u901A\u8FC7\uFF0C${fail} \u5931\u8D25`)
process.exit(fail ? 1 : 0)
