// \u9A8C\u8BC1\u81EA\u5199\u6F14\u7EC3\u811A\u672C\u7684\u5931\u8D25\u8DEF\u5F84\uFF0C\u4E0D\u9760\u6A21\u578B\u4E5F\u4E0D\u9760\u7F51\u7EDC
//
// The drill is a manual tool, so an independent review pointed out the obvious
// hole: nothing tested the drill. It incremented its counter for every reply,
// including `isError`, and exited 0 - it could "pass" without the task ever being
// claimed or completed. These cases run it against a stub MCP server and a stub
// model endpoint, so the guard logic is exercised on every CI run.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'agent-drill.mjs')
const stubMcp = join(here, 'fixtures', 'stub-mcp.mjs')
const work = mkdtempSync(join(tmpdir(), 'acm-drill-guard-'))
const db = join(work, 'drill.db')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

// A model endpoint that replays a scripted sequence of assistant messages.
function startModel(script) {
  let turn = 0
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      const message = script[turn] ?? { role: 'assistant', content: 'finished' }
      turn += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message }] }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const tool = (name, args = {}) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const said = (text) => ({ role: 'assistant', content: text })

function drill({ modelPort, args, mode = 'ok', env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      script,
      '--agent', 'runner',
      '--session', 'sR',
      '--prompt', 'do the task',
      '--mcp', stubMcp,
      '--url', `http://127.0.0.1:${modelPort}/v1`,
      '--rpc-timeout', '2000',
      '--model-timeout', '5000',
      ...args,
    ], {
      env: { ...process.env, ACM_DB: db, STUB_MODE: mode, ...env },
      encoding: 'utf8',
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', (code) => resolve({ code, out, err }))
    // The guard test must not hang if the drill itself hangs.
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 20000)
  })
}

// 1. A completed task verifies.
{
  const { server, port } = await startModel([tool('acm_inbox', { state: 'done' }), said('done')])
  const r = await drill({ modelPort: port, args: ['--expect-done', '1'] })
  server.close()
  ok('a verified run exits 0', r.code === 0, `code=${r.code} ${r.err.slice(0, 120)}`)
  ok('the verification is reported, not assumed', /expect-done 1: done/.test(r.out), r.out.slice(-160))
}

// 2. A tool call that returned isError is not a success.
{
  const { server, port } = await startModel([tool('acm_inbox'), said('done')])
  const r = await drill({ modelPort: port, args: ['--expect-done', '1'], mode: 'error' })
  server.close()
  ok('one failed tool call fails the drill', r.code === 1, `code=${r.code}`)
  ok('the failed call is counted as failed, not executed', /0 tool call\(s\) executed, 1 failed/.test(r.out), r.out.slice(-160))
  ok('the isError text is carried into the report', /isError/.test(r.err), r.err.slice(0, 160))
}

// 3. An MCP server that dies mid-call must fail fast, not hang.
{
  const { server, port } = await startModel([tool('acm_inbox'), said('done')])
  const started = Date.now()
  const r = await drill({ modelPort: port, args: ['--expect-done', '1'], mode: 'die' })
  server.close()
  const elapsed = Date.now() - started
  ok('a server that exits mid-call fails the drill', r.code === 1, `code=${r.code}`)
  ok('it fails instead of waiting for the timeout', elapsed < 8000, `${elapsed}ms`)
  ok('the reason names the dead server', /exited|aborted/.test(r.err), r.err.slice(0, 160))
}

// 4. A model that calls an unrelated tool and stops has not finished the task.
{
  const { server, port } = await startModel([tool('acm_remember', { text: 'unrelated' }), said('all done')])
  const r = await drill({ modelPort: port, args: ['--expect-done', '99'] })
  server.close()
  ok('a model that never finishes the task fails the drill', r.code === 1, `code=${r.code}`)
  ok('the unmet expectation is named', /mailbox item 99 is not done/.test(r.err), r.err.slice(0, 200))
}

// 5. A fact that was never published is caught the same way.
{
  const { server, port } = await startModel([tool('acm_search', { query: 'x' }), said('done')])
  const r = await drill({ modelPort: port, args: ['--expect-key', 'absent.key'], env: { STUB_KEY: 'present.key' } })
  server.close()
  ok('a missing fact fails the drill', r.code === 1 && /fact key absent\.key is not retrievable/.test(r.err), r.err.slice(0, 200))
}

// 6. The store guard refuses anything that might be real data.
//
//    Both cases run the child with a **disposable home**, so the product's own
//    default resolves under tmp. The earlier version pointed the drill straight at
//    the operator's real `~/.dsh/acm-memory/memory.db` and counted on the stub MCP
//    never opening SQLite; a guard regression would have written there for real
//    rather than assumed to work.
{
  const home = mkdtempSync(join(tmpdir(), 'acm-drill-home-'))
  const { server, port } = await startModel([said('done')])
  const defaultPath = join(home, '.dsh', 'acm-memory', 'memory.db')
  const r = await drill({
    modelPort: port,
    args: [],
    env: { ACM_DB: defaultPath, USERPROFILE: home, HOME: home },
  })
  ok('the default store path is refused by default', r.code === 2, `code=${r.code}`)
  ok('the refusal names the flag that overrides it', /--allow-live-db/.test(r.err), r.err.slice(0, 160))
  ok('and nothing was created at that path', !existsSync(defaultPath))

  // Not the default path, but somebody's file all the same.
  const existing = join(home, 'copy-of-real.db')
  writeFileSync(existing, 'not a drill', 'utf8')
  const r2 = await drill({ modelPort: port, args: [], env: { ACM_DB: existing, USERPROFILE: home, HOME: home } })
  ok('an existing database anywhere is refused', r2.code === 2 && /already exists/.test(r2.err), `code=${r2.code} ${r2.err.slice(0, 120)}`)
  ok('and the existing file was not modified', readFileSync(existing, 'utf8') === 'not a drill')
  server.close()
}

// 7. Malformed tool arguments are a failure, not something to execute anyway.
{
  const bad = { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'acm_inbox', arguments: '{"state":' } }] }
  const { server, port } = await startModel([bad, said('done')])
  const r = await drill({ modelPort: port, args: ['--expect-done', '1'] })
  server.close()
  ok('malformed arguments fail the drill', r.code === 1 && /malformed arguments/.test(r.err), r.err.slice(0, 200))
}

mkdirSync(work, { recursive: true })
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

console.log(failures.length ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25` : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) process.exitCode = 1
