#!/usr/bin/env node
/**
 * Two independent AIs, one store, one task: the local closed loop, runnable.
 *
 * Three **separate processes**, each its own MCP stdio server, each its own agent
 * name and session, all on one database, authorization in `scoped` mode with real
 * grants. Nothing here is a mock: the planner, the worker and the reviewer only
 * learn about each other through the store, and every transition below is a tool
 * call that a foreign MCP client could make.
 *
 *   planner  creates a task and assigns it
 *   worker   accepts it, opens a lease, renews it, returns a result with evidence
 *   reviewer rejects the first return with a reason, then verifies the second
 *   operator confirms through the CLI (a different surface), not through a tool
 *
 * With `--crash` a second task is added: the worker is killed with `SIGKILL` while
 * it holds a lease, a *different* process runs the sweep, the task becomes
 * `expired`, the planner retries it, and a **new** worker process finishes it.
 *
 * Why a script and not only a test: a test asserts what we thought of. This prints
 * a transcript a reviewer can read, and its exit code is the assertion. `--json`
 * gives the same content to `test/two-agent-loop.mjs`, which is what runs in CI.
 *
 *   node scripts/two-agent-loop.mjs --json
 *   node scripts/two-agent-loop.mjs --crash --json
 *
 * Options:
 *   --db <path>        database file (default: a fresh temporary directory)
 *   --json             print one JSON object on stdout, transcript on stderr
 *   --crash            include the kill-and-recover phase
 *   --keep             keep the temporary database and print its path
 *   --allow-live-db    permit a database inside the configured ACM store
 *   --lease-ms <n>     lease for the working phase (default 60000)
 *   --rpc-timeout <n>  per-request timeout in ms (default 30000)
 *
 * Exit codes: 0 every step passed, 1 a step failed, 2 usage or configuration error.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDb } from '../lib/db.mjs'
import { grant, principalFromConfig, ACTIONS } from '../lib/auth.mjs'
import { mergeConfig } from '../lib/core.mjs'
import { storeRefusal } from './store-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const mcpPath = join(here, '..', 'lib', 'host', 'mcp.mjs')
const cliPath = join(here, '..', 'lib', 'host', 'cli.mjs')

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const jsonOut = flag('json')
const withCrash = flag('crash')
const keep = flag('keep')
const allowLiveDb = flag('allow-live-db')
const leaseMs = Number(arg('lease-ms', 60_000))
const rpcTimeout = Number(arg('rpc-timeout', 30_000))
const project = 'alpha'

const say = (line) => { if (!jsonOut) console.log(line); else console.error(line) }

class UsageError extends Error {}
function usage(message) {
  const err = new UsageError(message)
  err.usage = true
  return err
}

/**
 * Refuse anything that might be real data unless the operator says so.
 *
 * The rules live in `scripts/store-guard.mjs` so the model drill uses the same ones
 *; this function only phrases the refusal for this script.
 */
function assertNotLiveStore(dbPath) {
  const refusal = storeRefusal(dbPath, { allowLiveDb })
  if (refusal) throw usage(`${refusal}; pass --allow-live-db only if that data is disposable`)
}

let tempDir = null
function databasePath() {
  const given = arg('db')
  if (given) { assertNotLiveStore(given); return resolve(given) }
  tempDir = mkdtempSync(join(tmpdir(), 'acm-two-agent-'))
  return join(tempDir, 'memory.db')
}

/**
 * One MCP client, one agent name. Requests are strictly sequential - the server
 * guarantees ordering, and a driver that pipeline-sent would be testing a race it
 * did not intend.
 */
let dbPath = null

class Agent {
  constructor(name, extraEnv = {}) {
    this.name = name
    this.pending = new Map()
    this.nextId = 1
    this.stderr = ''
    this.dead = null
    this.env = {
      ...process.env,
      ACM_DB: dbPath,
      ACM_SESSION: `loop-${name}`,
      ACM_AGENT: name,
      ACM_AUTH_MODE: 'scoped',
      ACM_PROJECT: extraEnv.project ?? project,
      ...(extraEnv.env ?? {}),
    }
    this.child = spawn(process.execPath, [mcpPath], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk) })
    this.child.on('exit', (code, signal) => {
      this.dead = `exit ${code ?? signal}`
      for (const [, entry] of this.pending) entry.reject(new Error(`${this.name} died: ${this.dead}`))
      this.pending.clear()
    })
    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let msg
      try { msg = JSON.parse(text) } catch { return }
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else entry.resolve(msg.result)
    })
  }

  rpc(method, params) {
    if (this.dead) return Promise.reject(new Error(`${this.name} is gone (${this.dead})`))
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`${this.name} timed out on ${method} after ${rpcTimeout}ms`))
      }, rpcTimeout)
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async start() {
    const info = await this.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'two-agent-loop', version: '1' },
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return info
  }

  /** One tool call. Returns `{ok:true, value}` or `{ok:false, error}`; never throws. */
  async tool(name, args = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args })
    if (result?.isError) return { ok: false, error: String(result.content?.[0]?.text ?? 'isError') }
    return { ok: true, value: result?.structuredContent ?? null }
  }

  kill(signal = 'SIGKILL') {
    if (!this.dead) { try { this.child.kill(signal) } catch {} }
  }

  async stop() {
    if (this.dead) return
    try { this.child.stdin.end() } catch {}
    await new Promise((r) => { const t = setTimeout(r, 1500); this.child.once('exit', () => { clearTimeout(t); r() }) })
    this.kill()
  }
}

// ── Transcript and assertions
const steps = []
function record(name, ok, detail) {
  steps.push({ name, ok, detail: detail ?? null })
  say(`  ${ok ? 'ok  ' : 'NO  '} ${name}${detail ? `  ${detail}` : ''}`)
  return ok
}

try {
  dbPath = databasePath()
} catch (err) {
  // A usage error is not a failed assertion: exit 2 so a caller can tell "you asked
  // for something unsafe" from "the loop broke".
  console.error(err?.usage ? `usage: ${err.message}` : String(err?.message ?? err))
  process.exit(2)
}
say(`two-agent loop on ${dbPath}`)

// ── Setup: identities and grants. This is the operator's act, not an agent's.
{
  const db = openDb(dbPath)
  const identities = [
    ['planner', 'alpha', ['task:create', 'task:assign', 'task:retry', 'task:cancel']],
    ['worker', 'alpha', ['task:accept', 'task:renew', 'task:return']],
    ['reviewer', 'alpha', ['task:verify', 'task:reject']],
    ['reviewer-beta', 'beta', ['task:verify']],
  ]
  for (const [agent, target, actions] of identities) {
    const principal = principalFromConfig(mergeConfig({ agent, project: target }))
    for (const action of actions) {
      if (!ACTIONS.includes(action)) throw new Error(`granting an action that does not exist: ${action}`)
      const issued = grant(db, { principal, action, target, grantedBy: 'operator' })
      if (!issued.ok) throw new Error(`could not grant ${action} to ${agent}: ${issued.reason}`)
    }
  }
  db.close()
}

const planner = new Agent('planner')
const worker = new Agent('worker')
const reviewer = new Agent('reviewer')
const agents = [planner, worker, reviewer]

let exitCode = 0
let trail = []
let confirmCommand = null
try {
  for (const agent of agents) {
    const info = await agent.start()
    record(`${agent.name} starts its own MCP server`, Boolean(info?.serverInfo?.name),
      `${info?.serverInfo?.name ?? '?'} ${info?.serverInfo?.version ?? ''}`.trim())
  }

  // ── A caller with no grant is refused by the store, not by convention
  {
    const stranger = new Agent('stranger', { project: 'alpha' })
    try {
      await stranger.start()
      const denied = await stranger.tool('acm_task_create', { title: 'should not exist' })
      const text = denied.error ?? ''
      record('an agent with no grant cannot create a task',
        denied.ok === false && /not authorized|no-grant/i.test(text), text.slice(0, 120))
    } finally {
      await stranger.stop()
    }
  }

  // ── 1. The planner creates and assigns
  const created = await planner.tool('acm_task_create', {
    title: 'summarise the deploy policy for the release note',
    detail: 'one paragraph, cite the paragraph number',
    assignee: 'worker',
    priority: 5,
  })
  const key = created.value?.task?.key
  record('planner creates a task and assigns it to the worker',
    created.ok === true && created.value?.task?.state === 'assigned' && Boolean(key),
    `${key ?? '?'} [${created.value?.task?.state ?? '?'}] project=${created.value?.task?.project ?? '?'}`)

  // ── 2. The worker accepts and holds a lease
  const accepted = await worker.tool('acm_task_accept', { key, leaseMs })
  record('worker accepts it and opens a lease',
    accepted.ok === true && accepted.value?.task?.state === 'running' && accepted.value?.task?.attempts === 1,
    `lease until ${accepted.value?.task?.leaseUntil ?? '?'}`)

  // ── 3. A long job extends its own lease
  const renewed = await worker.tool('acm_task_renew', { key, leaseMs: leaseMs * 2 })
  record('worker renews the lease instead of letting it lapse',
    renewed.ok === true && Number(renewed.value?.task?.leaseUntil) > Number(accepted.value?.task?.leaseUntil),
    `lease until ${renewed.value?.task?.leaseUntil ?? '?'}`)

  // ── 4. The worker returns a result with evidence
  const firstReturn = await worker.tool('acm_task_return', {
    key,
    result: 'the deploy window is Wednesday 03:00 UTC, per paragraph 4',
    evidence: 'commit:9f2c1ab\nfile:docs/deploy-policy.md#paragraph-4\ntest:node test/tasks.mjs',
  })
  record('worker returns a result with three pieces of evidence',
    firstReturn.ok === true && firstReturn.value?.task?.state === 'returned' &&
    firstReturn.value?.task?.evidence?.length === 3,
    `${firstReturn.value?.task?.evidence?.length ?? 0} evidence items`)

  // ── 5. A reviewer scoped to another project cannot touch it
  {
    // Snapshot before the attempt, so the refusal can be checked against what the
    // task actually looks like afterwards - a gate that refused *after* mutating
    // would pass a check that only looks at the answer.
    const before = await planner.tool('acm_task_get', { key })
    const beta = new Agent('reviewer-beta', { project: 'beta' })
    try {
      await beta.start()
      const crossed = await beta.tool('acm_task_verify', { key })
      // Probing a key that does not exist and comparing the two answers is the only
      // way to assert the refusal is not a directory. `project-mismatch` used to say
      // "this key exists, elsewhere"; in scoped mode both must be the
      // same answer, or a caller can enumerate task keys across projects.
      const unknown = await beta.tool('acm_task_verify', { key: 'T-nosuchkey-0000' })
      const shape = (r) => (r.ok === false ? `transport:${r.error}` : `value:${JSON.stringify(r.value)}`)
      record('a reviewer granted only in another project cannot tell the task from a key that does not exist',
        shape(crossed) === shape(unknown) && /not-found/.test(shape(crossed)),
        `${shape(crossed)} vs ${shape(unknown)}`)
    } finally {
      await beta.stop()
    }
    const after = await planner.tool('acm_task_get', { key })
    record('and the refused call left the task untouched',
      JSON.stringify(before.value?.task) === JSON.stringify(after.value?.task) &&
      before.value?.events?.length === after.value?.events?.length,
      `state ${after.value?.task?.state ?? '?'}, events ${before.value?.events?.length ?? '?'} -> ${after.value?.events?.length ?? '?'}`)
  }

  // ── 6. The reviewer rejects the first attempt, with a reason the worker can act on
  const rejected = await reviewer.tool('acm_task_reject', {
    key, reason: 'the evidence does not show the paragraph number was checked against the source',
  })
  record('reviewer rejects the return and the task goes back to assigned',
    rejected.ok === true && rejected.value?.task?.state === 'assigned' &&
    String(rejected.value?.task?.lastReason ?? '').includes('paragraph number'),
    `[${rejected.value?.task?.state ?? '?'}] attempt ${rejected.value?.task?.attempts ?? '?'}`)
  record('the rejected result is kept for the next attempt',
    String(firstReturn.ok ? rejected.value?.task?.result ?? '' : '').includes('Wednesday'))

  // ── 7. The worker takes it again and answers the objection
  const secondAccept = await worker.tool('acm_task_accept', { key, leaseMs })
  record('worker accepts the second attempt',
    secondAccept.ok === true && secondAccept.value?.task?.attempts === 2,
    `attempt ${secondAccept.value?.task?.attempts ?? '?'}`)
  const secondReturn = await worker.tool('acm_task_return', {
    key,
    result: 'the deploy window is Wednesday 03:00 UTC; paragraph 4 of docs/deploy-policy.md says so',
    evidence: 'commit:9f2c1ab\nfile:docs/deploy-policy.md#paragraph-4\ntest:node test/tasks.mjs\nnote:cross-checked paragraph 4 against the source table',
  })
  record('worker returns again with the objection addressed',
    secondReturn.ok === true && secondReturn.value?.task?.evidence?.length === 4,
    `${secondReturn.value?.task?.evidence?.length ?? 0} evidence items`)

  // ── 8. The reviewer verifies
  const verified = await reviewer.tool('acm_task_verify', { key, note: 'paragraph 4 checked against the source table' })
  record('reviewer verifies it and the task is closed',
    verified.ok === true && verified.value?.task?.state === 'verified' &&
    verified.value?.task?.verifiedBy === 'reviewer',
    `${verified.value?.task?.state ?? '?'} by ${verified.value?.task?.verifiedBy ?? '?'}`)

  // ── 9. The loop stops here, on purpose
  // A previous version of this script wrote `accepted by the operator` into memory
  // by itself and called that the user's confirmation. It was not: it was a
  // scripted approval wearing the operator's name. Confirmation is a real act by a
  // person - `acm task confirm` - so this driver ends at `verified`, states that
  // nobody has confirmed anything, and prints the command a human must run.
  {
    const state = verified.value?.task?.state
    record('the loop ends at verified, with nobody having confirmed it yet',
      state === 'verified' && verified.value?.task?.confirmedBy == null, state ?? '?')
    const listed = await planner.rpc('tools/list', {})
    const names = (listed?.tools ?? []).map((t) => t.name)
    record('no MCP tool exists that could confirm it', !names.includes('acm_task_confirm'),
      names.filter((n) => n.startsWith('acm_task')).join(' '))
    const env = { ...process.env, ACM_DB: dbPath, ACM_SESSION: 'operator' }
    confirmCommand = `ACM_DB=${JSON.stringify(dbPath)} node ${cliPath} task confirm --key ${key} --actor <your-name>`
    const preview = spawnSync(process.execPath, [cliPath, 'task', 'show', '--key', key], { env, encoding: 'utf8' })
    record('the trail is readable by the person who will decide',
      preview.status === 0 && preview.stdout.includes('"state": "verified"'),
      `exit ${preview.status}`)
  }

  // ── 10. The trail is the evidence, read by a process that did none of the work
  {
    const shown = await planner.tool('acm_task_get', { key })
    trail = (shown.value?.events ?? []).map((e) => e.action)
    record('the planner reads the whole trail from another process',
      shown.ok === true &&
      trail.join(',') === 'create,accept,renew,return,reject,accept,return,verify',
      trail.join(','))
  }

  // ── 11. Crash and recovery: a lease held by a dead process
  if (withCrash) {
    const crashTask = await planner.tool('acm_task_create', {
      title: 'a job that outlives its worker', assignee: 'worker',
    })
    const crashKey = crashTask.value?.task?.key
    const holding = await worker.tool('acm_task_accept', { key: crashKey, leaseMs: 1200 })
    record('a second task is accepted with a one-second lease',
      holding.ok === true && holding.value?.task?.state === 'running', `lease ${holding.value?.task?.leaseUntil ?? '?'}`)

    const deadPid = worker.child.pid
    worker.kill('SIGKILL')
    await new Promise((r) => worker.child.once('exit', r))
    record('the worker process is killed while it holds the lease', Boolean(deadPid), `pid ${deadPid} gone`)

    // Wait out the lease, then let a *different* process run the sweep.
    await new Promise((r) => setTimeout(r, 1400))
    const sweepEnv = { ...process.env, ACM_DB: dbPath, ACM_SESSION: 'planner', ACM_AGENT: 'planner', ACM_AUTH_MODE: 'scoped', ACM_PROJECT: project }
    const sweep = spawnSync(process.execPath, [cliPath, 'task', 'expire'], { env: sweepEnv, encoding: 'utf8' })
    let swept = []
    try { swept = JSON.parse(sweep.stdout).expired ?? [] } catch {}
    record('a different process sweeps the dead lease into expired',
      sweep.status === 0 && swept.includes(crashKey), JSON.stringify(swept))
    const afterSweep = await planner.tool('acm_task_get', { key: crashKey })
    record('the task is expired, not silently still running',
      afterSweep.value?.task?.state === 'expired', afterSweep.value?.task?.state ?? '?')

    const retried = await planner.tool('acm_task_retry', { key: crashKey })
    record('the planner puts it back into the queue',
      retried.ok === true && retried.value?.task?.state === 'assigned', retried.value?.task?.state ?? '?')

    // A brand-new worker process, same name: nothing is inherited but the name.
    const reborn = new Agent('worker')
    try {
      await reborn.start()
      record('a new worker process starts with the same name',
        reborn.child.pid !== deadPid, `pid ${reborn.child.pid}`)
      const reaccept = await reborn.tool('acm_task_accept', { key: crashKey, leaseMs })
      record('the new process can accept the recovered task',
        reaccept.ok === true && reaccept.value?.task?.state === 'running', reaccept.value?.task?.state ?? '?')
      const finish = await reborn.tool('acm_task_return', {
        key: crashKey, result: 'finished after the restart',
        evidence: 'command:node scripts/two-agent-loop.mjs --crash\nnote:result survived a SIGKILL',
      })
      record('it returns the work with evidence',
        finish.ok === true && finish.value?.task?.state === 'returned', finish.value?.task?.state ?? '?')
      const closeIt = await reviewer.tool('acm_task_verify', { key: crashKey, note: 'recovered attempt checked' })
      record('the reviewer verifies the recovered work',
        closeIt.ok === true && closeIt.value?.task?.state === 'verified', closeIt.value?.task?.state ?? '?')
      const crashTrail = (await planner.tool('acm_task_get', { key: crashKey })).value?.events?.map((e) => e.action) ?? []
      record('the recovered task has the whole story, including the expiry',
        crashTrail.includes('expire') && crashTrail.includes('retry') && crashTrail.at(-1) === 'verify',
        crashTrail.join(','))
    } finally {
      await reborn.stop()
    }
  }
} catch (err) {
  record('the loop ran without throwing', false, String(err?.message ?? err).slice(0, 200))
} finally {
  for (const agent of agents) await agent.stop()
}

const failed = steps.filter((s) => !s.ok)
if (failed.length) exitCode = 1
const summary = {
  ok: failed.length === 0,
  db: dbPath,
  crash: withCrash,
  trail,
  awaitingUserConfirmation: confirmCommand,
  confirmedByAnyone: false,
  checked: steps.length,
  failed: failed.map((s) => s.name),
  steps,
  workerStderr: agents.flatMap((a) => (a.stderr.trim() ? [`${a.name}: ${a.stderr.trim().slice(0, 400)}`] : [])),
  at: new Date().toISOString(),
}

if (jsonOut) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
else {
  say('')
  say(failed.length
    ? `${failed.length} of ${steps.length} steps failed: ${failed.map((s) => s.name).join('; ')}`
    : `all ${steps.length} steps passed`)
  if (trail.length) say(`trail: ${trail.join(' -> ')}`)
  if (confirmCommand) {
    say('')
    say('NOT CONFIRMED. A person must run:')
    say(`  ${confirmCommand}`)
  }
}

if (tempDir && !keep) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
if (keep && tempDir) say(`kept ${dbPath}`)

process.exitCode = exitCode
