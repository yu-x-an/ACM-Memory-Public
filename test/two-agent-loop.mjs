// \u4E24\u4E2A\u72EC\u7ACB\u7684 AI \u5728\u540C\u4E00\u4E2A\u5E93\u4E0A\u628A\u4E00\u4EFB\u4E8B\u505A\u5B8C\uFF1A\u5206\u914D\u3001\u6267\u884C\u3001\u4EA4\u56DE\u3001\u9000\u56DE\u3001\u9A8C\u6536\u3001\u5D29\u6E83\u540E\u6062\u590D
//
// \u8FD9\u4E2A\u6D4B\u8BD5\u4E0D\u81EA\u5DF1\u53D1\u660E\u987A\u5E8F\uFF1A\u5B83\u8DD1 `scripts/two-agent-loop.mjs`\uFF0C\u4E09\u4E2A\u771F\u5B9E\u7684 MCP \u8FDB\u7A0B\uFF0C\u7136\u540E\u770B\u90A3\u4EFD
// \u8F93\u51FA\u3002\u4E00\u4E2A\u6D4B\u8BD5\u80FD\u8BC1\u660E\u201C\u6211\u4EEC\u60F3\u5230\u7684\u90A3\u6761\u8DEF\u201D\uFF1B\u8FD9\u91CC\u8981\u8BC1\u660E\u7684\u662F\u201C\u4E00\u4E2A\u5916\u90E8\u5BA2\u6237\u7AEF\u771F\u7684\u80FD\u8DD1\u5B8C\u201D\u3002
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { storeRefusal } from '../scripts/store-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'two-agent-loop.mjs')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

function run(extraArgs = []) {
  const r = spawnSync(process.execPath, [script, '--json', ...extraArgs], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env },
  })
  let report = null
  try { report = JSON.parse(r.stdout) } catch {}
  return { status: r.status, report, stdout: r.stdout, stderr: r.stderr }
}

const EXPECTED = 'create,accept,renew,return,reject,accept,return,verify'

// 1. The plain loop
{
  const { status, report, stderr } = run()
  ok('the loop exits 0', status === 0, `exit ${status} ${String(stderr).slice(-300)}`)
  ok('and reports itself as ok', report?.ok === true,
    JSON.stringify(report?.failed ?? report).slice(0, 200) + ` | stderr: ${JSON.stringify(report?.workerStderr ?? [])}`.slice(0, 600))
  ok('every step passed', report?.steps?.length > 0 && report.steps.every((s) => s.ok),
    (report?.steps ?? []).filter((s) => !s.ok).map((s) => `${s.name} -> ${String(s.detail ?? '').slice(0, 200)}`).join('; '))
  ok('the trail is create -> assign -> accept -> renew -> return -> reject -> accept -> return -> verify',
    report?.trail?.join(',') === EXPECTED, report?.trail?.join(','))
  ok('a caller with no grant was refused inside the run',
    (report?.steps ?? []).some((s) => s.name === 'an agent with no grant cannot create a task' && s.ok))
  ok('a reviewer scoped to another project was refused inside the run, for that reason',
    (report?.steps ?? []).some((s) => s.name.includes('cannot tell the task from a key that does not exist') && s.ok))
  ok('and the refusal left the task untouched',
    (report?.steps ?? []).some((s) => s.name.includes('left the task untouched') && s.ok))
  ok('the loop stopped at verified instead of confirming itself',
    (report?.steps ?? []).some((s) => s.name.includes('ends at verified') && s.ok))
  ok('no MCP tool exists that could confirm the task',
    (report?.steps ?? []).some((s) => s.name.includes('no MCP tool exists') && s.ok))
  ok('the report names the command a person must run, and claims nobody confirmed',
    typeof report?.awaitingUserConfirmation === 'string' && report.awaitingUserConfirmation.includes('task confirm')
      && report.confirmedByAnyone === false,
    String(report?.awaitingUserConfirmation).slice(0, 80))
  ok('the run used three separate processes and said so',
    (report?.steps ?? []).filter((s) => s.name.includes('starts its own MCP server')).length === 3)
}

// 2. Kill the worker mid-lease and require the loop to recover
{
  const { status, report } = run(['--crash'])
  ok('the crash variant exits 0', status === 0, `exit ${status}`)
  const names = (report?.steps ?? []).map((s) => s.name)
  ok('the worker really was killed', names.some((n) => n.includes('killed while it holds the lease')))
  ok('a different process swept the dead lease',
    (report?.steps ?? []).some((s) => s.name.includes('sweeps the dead lease into expired') && s.ok))
  ok('the task was expired rather than left running',
    (report?.steps ?? []).some((s) => s.name.includes('expired, not silently still running') && s.ok))
  ok('a new process finished it',
    (report?.steps ?? []).some((s) => s.name.includes('the reviewer verifies the recovered work') && s.ok))
  ok('the recovered trail contains the expiry and the retry',
    (report?.steps ?? []).some((s) => s.name.includes('the recovered task has the whole story') && s.ok))
  ok('no step failed in the crash run', (report?.steps ?? []).every((s) => s.ok),
    (report?.steps ?? []).filter((s) => !s.ok).map((s) => s.name).join('; '))
}

// 3. The script refuses the configured store unless told otherwise. This is the
//    same guard `agent-drill` learned to have after it nearly ran against live data.
//
//    One rule shapes every case here: **a test of the guard may never point the
//    drill at real data.** The first version of this block did - it asserted that
//    `--db <the real default>` was refused - which meant that the day the guard
//    regressed, the check would not fail, it would succeed by writing synthetic
//    grants, principals and a task into the live store. It happened while this very
//    fix was being reverted for evidence: 4 principals, 10 grants, 1 task and a
//    schema upgrade landed in `~/.dsh/acm-memory/memory.db`, and the store was
//    restored from its pre-migration snapshot. So the child now runs with a
//    disposable home: "the product's own default" resolves under tmp, and a
//    regression writes there, where nothing is at stake.
{
  const fakeHome = mkdtempSync(join(tmpdir(), 'acm-loop-home-'))
  const childEnv = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome }
  const defaultPath = join(fakeHome, '.dsh', 'acm-memory', 'memory.db')
  // 1. The default the product computes for itself, with that home.
  const realDefault = spawnSync(process.execPath, [script, '--json', '--db', defaultPath], {
    encoding: 'utf8', timeout: 30_000, env: childEnv,
  })
  ok('the product default database path is refused without --allow-live-db',
    realDefault.status === 2 && /live store/.test(realDefault.stderr + realDefault.stdout),
    `exit ${realDefault.status} for ${defaultPath}`)
  // 2. A neighbour of the default (same store directory, different file name).
  const neighbour = join(dirname(defaultPath), 'drill-target.db')
  const nearDefault = spawnSync(process.execPath, [script, '--json', '--db', neighbour], {
    encoding: 'utf8', timeout: 30_000, env: childEnv,
  })
  ok('a file in the default store directory is refused too',
    nearDefault.status === 2 && /live store/.test(nearDefault.stderr + nearDefault.stdout), `exit ${nearDefault.status}`)
  ok('and neither path was created', !existsSync(defaultPath) && !existsSync(neighbour),
    `default ${existsSync(defaultPath)}, neighbour ${existsSync(neighbour)}`)
  // 3. An already-existing database anywhere: not the default path, but somebody's
  //    data all the same.
  const existing = join(fakeHome, 'somebody-data.db')
  writeFileSync(existing, 'not a drill', 'utf8')
  const existingRun = spawnSync(process.execPath, [script, '--json', '--db', existing], {
    encoding: 'utf8', timeout: 30_000, env: childEnv,
  })
  ok('any already-existing database is refused without --allow-live-db',
    existingRun.status === 2 && /already exists/.test(existingRun.stderr + existingRun.stdout),
    `exit ${existingRun.status} ${String(existingRun.stderr).slice(0, 120)}`)
  ok('and the existing file was not modified', readFileSync(existing, 'utf8') === 'not a drill')
  // 4. ACM_HOME is still honoured as a store root.
  const store = join(fakeHome, 'store-guard')
  const target = join(store, 'memory.db')
  const r = spawnSync(process.execPath, [script, '--json', '--db', target], {
    encoding: 'utf8', timeout: 30_000, env: { ...childEnv, ACM_HOME: store },
  })
  ok('a database inside ACM_HOME is refused without --allow-live-db',
    r.status === 2 && /allow-live-db/.test(r.stderr + r.stdout), `exit ${r.status} ${String(r.stderr).slice(0, 160)}`)
  ok('and nothing was created at that path', !existsSync(target))
  rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

// 4. The path comparison itself, not just the drill that calls it.
//
//    Both shortcuts are wrong on a machine whose store is a symlink - this one is
//    (~/.dsh -> D://DSH//.dsh). Resolving only the final path let realpath(root) and a
//    raw child path span drives, relative() returned an absolute path, and the guard
//    passed every candidate inside the store while its spawned-drill tests stayed
//    green. And root/..scratch.db is a child whose *name* begins with dots, not a
//    traversal, which startsWith('..') also got wrong.
{
  const base = mkdtempSync(join(tmpdir(), 'acm-guard-path-'))
  const store = join(base, 'store')
  mkdirSync(store)
  ok('a plain new file inside the store root is refused',
    typeof storeRefusal(join(store, 'new.db'), { acmHome: store }) === 'string',
    String(storeRefusal(join(store, 'new.db'), { acmHome: store })))
  ok('a child whose name begins with dots is not mistaken for a traversal',
    typeof storeRefusal(join(store, '..scratch.db'), { acmHome: store }) === 'string',
    String(storeRefusal(join(store, '..scratch.db'), { acmHome: store })))
  ok('a real traversal out of the store is allowed',
    storeRefusal(join(base, 'outside.db'), { acmHome: store }) === null,
    String(storeRefusal(join(base, 'outside.db'), { acmHome: store })))
  let linked = null
  try {
    symlinkSync(store, join(base, 'link'), 'junction')
    linked = join(base, 'link')
  } catch {}
  if (linked) {
    ok('a new file under a symlinked store root is refused',
      typeof storeRefusal(join(linked, 'new.db'), { acmHome: linked }) === 'string',
      String(storeRefusal(join(linked, 'new.db'), { acmHome: linked })))
  }
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

console.log(failures.length
  ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25`
  : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
