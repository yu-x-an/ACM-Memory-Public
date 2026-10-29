#!/usr/bin/env node
/**
 * A manual drill, not a CI test: drive the ACM MCP server with a local model.
 *
 * `test/` proves behaviour with deterministic fixtures and a host this repository
 * wrote itself. Neither can show that a model the repository does not control can
 * discover the tools, call them with valid arguments and act on the result. This
 * script is the smallest thing that can: it speaks MCP to `lib/host/mcp.mjs` the
 * way any third-party host would, hands the advertised schemas to an
 * OpenAI-compatible endpoint, and executes whatever the model asks for.
 *
 * It is excluded from `npm run test:all` because it needs a model endpoint. Its
 * own failure handling *is* tested deterministically in `test/drill-guard.mjs`
 * against a stub server and a stub endpoint.
 *
 *   ACM_DB=/tmp/drill.db node scripts/agent-drill.mjs \
 *     --agent runner --session sR --expect-done 1 \
 *     --prompt "acm_inbox, claim what you find, then complete it"
 *
 * Options:
 *   --agent <name>       value for ACM_AGENT; this is the name that may claim work
 *   --session <id>       value for ACM_SESSION; one process per agent is expected
 *   --prompt <text>      instruction given to the model
 *   --model <name>       model id at the endpoint (default qwen2.5:7b)
 *   --url <base>         OpenAI-compatible base URL (default http://127.0.0.1:11434/v1)
 *   --max-turns <n>      tool-calling rounds before giving up (default 8)
 *   --mcp <path>         MCP server entry point (default lib/host/mcp.mjs)
 *   --expect-done <id>   fail unless that mailbox id ends in state `done`
 *   --expect-key <key>   fail unless that fact key is retrievable
 *   --rpc-timeout <ms>   per-request MCP timeout (default 30000)
 *   --model-timeout <ms> per-request model timeout (default 180000)
 *   --allow-live-db      permit a database under the default store (refused by default)
 *
 * Exit codes: 0 verified, 1 not verified, 2 usage or configuration error.
 *
 * "Verified" means all four of: at least one tool call; no tool call that returned
 * `isError`; every requested expectation met; and no timeout or dead child. An
 * earlier version incremented its counter for *any* reply, so a single failed call
 * exited 0 - it proved that a call was attempted, not that the work was done.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import { storeRefusal } from './store-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const agent = arg('agent', 'agent')
const session = arg('session', 'drill')
const prompt = arg('prompt')
const model = arg('model', 'qwen2.5:7b')
const url = arg('url', 'http://127.0.0.1:11434/v1')
const maxTurns = Number(arg('max-turns', '8'))
const mcpPath = resolve(arg('mcp', join(here, '..', 'lib', 'host', 'mcp.mjs')))
const expectDone = arg('expect-done')
const expectKey = arg('expect-key')
const rpcTimeout = Number(arg('rpc-timeout', '30000'))
const modelTimeout = Number(arg('model-timeout', '180000'))

const usage = (message) => {
  console.error(`${message}\nusage: agent-drill.mjs --agent <name> --session <id> --prompt "<instruction>" [--expect-done <id>] [--expect-key <key>]`)
  process.exit(2)
}
if (!prompt) usage('--prompt is required')
if (expectDone !== null && !Number.isFinite(Number(expectDone))) usage('--expect-done must be a mailbox id')

const dbPath = process.env.ACM_DB
if (!dbPath) usage('ACM_DB must point at a disposable database; a drill must not touch the operator\'s store')

// The drill forwards every advertised tool to a model. Pointed at the live store it
// would let a model rewrite real memory, so the guard is the same one the two-agent
// loop uses (`scripts/store-guard.mjs`): the product's default database, anything
// inside a store root, and any database file that already exists anywhere. The first
// version refused only the default path, so `ACM_DB=/a/copy-of-real.db` passed and a
// model could mutate it.
const refusal = storeRefusal(dbPath, { allowLiveDb: flag('allow-live-db') })
if (refusal) usage(`${refusal}; point ACM_DB at a throwaway file, or pass --allow-live-db if you really mean it`)
else if (flag('allow-live-db')) console.error('warning: drilling against a store the guard would refuse, because --allow-live-db was passed')

if (!existsSync(mcpPath)) usage(`no MCP server at ${mcpPath}`)

const child = spawn(process.execPath, [mcpPath], {
  env: { ...process.env, ACM_DB: dbPath, ACM_SESSION: session, ACM_AGENT: agent },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const pending = new Map()
let seq = 0
let childGone = null

const settleAll = (err) => {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(err)
  }
  pending.clear()
}
child.on('exit', (code, signal) => {
  childGone = `mcp server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) before replying`
  settleAll(new Error(childGone))
})
child.on('error', (err) => {
  childGone = `mcp server failed to start: ${err?.message ?? err}`
  settleAll(new Error(childGone))
})
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id == null) return
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  clearTimeout(entry.timer)
  entry.resolve(msg)
})

const rpc = (method, params, timeoutMs = rpcTimeout) => new Promise((resolvePromise, rejectPromise) => {
  if (childGone) return rejectPromise(new Error(childGone))
  const id = ++seq
  const timer = setTimeout(() => {
    pending.delete(id)
    rejectPromise(new Error(`mcp rpc timed out after ${timeoutMs}ms: ${method}`))
  }, timeoutMs)
  pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})

const callTool = async (name, toolArgs = {}) => {
  const out = await rpc('tools/call', { name, arguments: toolArgs })
  const result = out.result ?? {}
  const text = result.content?.[0]?.text ?? ''
  if (result.isError) return { ok: false, text, structured: null }
  return { ok: true, text, structured: result.structuredContent ?? null }
}

let okCalls = 0
let failedCalls = 0
const failures = []

const main = async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: `drill-${agent}`, version: '1' } })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const listed = await rpc('tools/list', {})
  const tools = (listed.result?.tools ?? []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
  }))
  console.log(`${agent}/${session}: ${tools.length} tools advertised by the server`)

  const messages = [
    { role: 'system', content: 'You are an agent with tools. Call the tools instead of guessing.' },
    { role: 'user', content: prompt },
  ]

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), modelTimeout)
    let body
    try {
      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0 }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`model endpoint refused: ${res.status} ${(await res.text()).slice(0, 200)}`)
      body = await res.json()
    } catch (err) {
      const reason = err?.name === 'AbortError' ? `model timed out after ${modelTimeout}ms` : String(err?.message ?? err)
      failures.push(reason)
      console.error(`model call failed: ${reason}`)
      return
    } finally {
      clearTimeout(timer)
    }

    const message = body.choices?.[0]?.message ?? {}
    messages.push(message)

    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        let toolArgs = null
        try { toolArgs = JSON.parse(call.function.arguments || '{}') } catch {}
        if (toolArgs === null) {
          failedCalls += 1
          failures.push(`malformed arguments for ${call.function.name}`)
          console.log(`  ${call.function.name} <malformed arguments> -> not executed`)
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'error: arguments were not valid JSON' })
          continue
        }
        let out
        try {
          out = await callTool(call.function.name, toolArgs)
        } catch (err) {
          // A dead or silent server is a drill failure, not something to retry
          // forever: the model would otherwise keep calling into a closed pipe.
          failedCalls += 1
          failures.push(String(err?.message ?? err))
          console.error(`  ${call.function.name} -> ${err?.message ?? err}`)
          return
        }
        if (out.ok) {
          okCalls += 1
          console.log(`  ${call.function.name} ${JSON.stringify(toolArgs)} -> ${out.text.slice(0, 140)}`)
        } else {
          failedCalls += 1
          failures.push(`${call.function.name} returned isError: ${out.text.slice(0, 120)}`)
          console.log(`  ${call.function.name} ${JSON.stringify(toolArgs)} -> ERROR ${out.text.slice(0, 120)}`)
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.text })
      }
      continue
    }

    console.log(`model answer: ${(message.content ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
    break
  }

  // The model saying it is finished is not evidence that it is. Ask the store.
  if (expectDone !== null) {
    const inbox = await callTool('acm_inbox', { state: 'done' })
    const items = inbox.structured?.items ?? []
    const hit = items.some((m) => Number(m.id) === Number(expectDone))
    console.log(`expect-done ${expectDone}: ${hit ? 'done' : 'NOT done'}`)
    if (!hit) failures.push(`mailbox item ${expectDone} is not done`)
  }
  if (expectKey !== null) {
    const found = await callTool('acm_search', { query: expectKey, limit: 20 })
    const items = found.structured?.items ?? []
    const hit = items.some((i) => i.key === expectKey)
    console.log(`expect-key ${expectKey}: ${hit ? 'retrievable' : 'NOT retrievable'}`)
    if (!hit) failures.push(`fact key ${expectKey} is not retrievable`)
  }
}

let exitCode = 1
try {
  await main()
  const verified = okCalls > 0 && failedCalls === 0 && failures.length === 0
  console.log(`\n${okCalls} tool call(s) executed, ${failedCalls} failed`)
  if (verified) {
    exitCode = 0
  } else {
    if (okCalls === 0) failures.push('the model never called a tool')
    for (const f of failures) console.error(`  - ${f}`)
    exitCode = 1
  }
} catch (err) {
  console.error(`drill aborted: ${err?.message ?? err}`)
  exitCode = 1
} finally {
  // Never leave the server process behind, on any path out of here.
  settleAll(new Error('drill finished'))
  try { child.kill() } catch {}
}
process.exit(exitCode)
