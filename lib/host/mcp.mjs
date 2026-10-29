#!/usr/bin/env node
// MCP \u5BBF\u4E3B\uFF1Astdio \u4E0A\u7684 JSON-RPC\uFF08\u4E00\u884C\u4E00\u6761\u6D88\u606F\uFF09\uFF0C\u7ED9 MCP \u5BA2\u6237\u7AEF\u7528\u3002
// \u5DE5\u5177\u8D70 tools/*\uFF0C\u6CE8\u5165\u6587\u672C\u4E0E\u4EBA\u683C\u8D70 resources\uFF08\u5BA2\u6237\u7AEF\u53EF\u4EE5\u5F53\u4E0A\u4E0B\u6587\u8D44\u6E90\u8BFB\uFF09\u3002
//
// \u73AF\u5883\u53D8\u91CF\uFF1AACM_SESSION\u3001ACM_DB\u3001ACM_OWNER\u3001ACM_PROJECT\u3001ACM_AGENT\u3001ACM_AUTH_MODE

import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDb } from '../db.mjs'
import { backupIfDue } from '../backup.mjs'
import { loadPersona, pendingProposals } from '../persona.mjs'
import { activeCheckpoint } from '../checkpoint.mjs'
import {
  buildInjectionText,
  mergeConfig,
  sessionIdFromEnv,
  statusOf,
  TOOLS,
} from '../core.mjs'

const PROTOCOL = '2024-11-05'
// The version the client sees must be the version that is installed. A hardcoded
// string drifts silently, and a client caching it cannot tell builds apart.
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0-unknown'
  }
})()

const SERVER = { name: 'acm-memory', version: PACKAGE_VERSION }

// The agent name is what decides who may claim a mailbox task and who may close
// it. Leaving it undefined made every MCP client the constant "agent", so two
// clients on one machine were indistinguishable: either neither could collect a
// task addressed to a named peer, or both shared one name and either could finish
// the other's work. It comes from configuration now; the default is unchanged, so
// a single-client setup behaves exactly as before.
const config = mergeConfig({
  ...(process.env.ACM_DB ? { dbPath: process.env.ACM_DB } : {}),
  ...(process.env.ACM_OWNER ? { owner: process.env.ACM_OWNER } : {}),
  ...(process.env.ACM_AGENT ? { agent: process.env.ACM_AGENT } : {}),
  ...(process.env.ACM_PROJECT ? { project: process.env.ACM_PROJECT } : {}),
  // `scoped` turns the authorization contract into refusals. It is opt-in because
  // turning it on without grants in place would stop every caller.
  ...(process.env.ACM_AUTH_MODE ? { auth: { mode: process.env.ACM_AUTH_MODE } } : {}),
})
try { mkdirSync(dirname(config.dbPath), { recursive: true }) } catch {}
const db = openDb(config.dbPath)
try { backupIfDue(db, config.dbPath, config.backup) } catch {}
const sessionId = sessionIdFromEnv()

function jsonSchemaOf(parameters = {}) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(parameters)) {
    properties[k] = { type: v.type ?? 'string', ...(v.description ? { description: v.description } : {}) }
    if (v.items) properties[k].items = v.items
    if (v.required) required.push(k)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/**
 * English half of the external surface.
 *
 * The product has two users: a Chinese-speaking operator and an English-speaking
 * one. The maintained text in this repository is English; the runtime strings
 * are Chinese because the operator reads them. Everything a foreign MCP client
 * sees is therefore bilingual rather than one or the other.
 */
const EN = {
  'acm_remember': 'Store one durable fact, preference or decision',
  'acm_search': 'Search memory by meaning and keywords',
  'acm_checkpoint': 'Save a task checkpoint so a later session can resume',
  'acm_forget': 'Mark one memory as no longer valid',
  'acm_alias': 'Teach a name that maps to another one',
  'acm_history': 'Show the revision history of one fact key',
  'acm_feedback': 'Record whether a recalled memory helped',
  'acm_evolve': 'Rebalance weights from recorded feedback',
  'acm_gc': 'Retire stale rows under the retention policy',
  'acm_send': 'Hand a task to another agent',
  'acm_inbox': 'List the work addressed to you that is not done yet',
  'acm_claim': 'Take ownership of one task; only one agent can hold it',
  'acm_complete': 'Close a task you claimed',
  'acm_task_create': 'Create a durable task with a state, an assignee and dependencies',
  'acm_task_list': 'List durable tasks in this partition',
  'acm_task_get': 'Read one task and its full transition trail',
  'acm_task_assign': 'Assign a task to an agent',
  'acm_task_accept': 'Start a task assigned to you and open a lease',
  'acm_task_return': 'Return a task with a result and evidence (kind:ref per line)',
  'acm_task_renew': 'Extend the lease on work you are still doing; nothing renews by itself',
  'acm_task_verify': 'Verify work someone else returned; the author cannot verify their own',
  'acm_task_reject': 'Send returned work back with a reason; attempts run out into failure',
  'acm_task_fail': 'Fail a task with a reason',
  'acm_task_cancel': 'Cancel a task that has not started',
  'acm_task_retry': 'Put an expired or failed task back to assigned',
}

const EN_RESOURCE = {
  'acm://injection': 'Context that should be injected / \u8981\u6CE8\u5165\u7684\u4E0A\u4E0B\u6587',
  'acm://persona': 'Persona files, read only / \u4EBA\u683C\u6587\u4EF6\uFF08\u53EA\u8BFB\uFF09',
  'acm://status': 'Store status / \u5E93\u72B6\u6001',
}

const bilingual = (english, chinese) => (english ? `${english} / ${chinese}` : chinese)
const resourceTitle = (uri, fallback) => EN_RESOURCE[uri] ?? fallback

const RESOURCES = [
  { uri: 'acm://injection', name: 'acm-injection', title: resourceTitle('acm://injection', '\u8981\u6CE8\u5165\u7684\u4E0A\u4E0B\u6587'), mimeType: 'text/plain' },
  { uri: 'acm://persona', name: 'acm-persona', title: resourceTitle('acm://persona', '\u4EBA\u683C\u6587\u4EF6\uFF08\u53EA\u8BFB\uFF09'), mimeType: 'text/plain' },
  { uri: 'acm://status', name: 'acm-status', title: resourceTitle('acm://status', '\u5E93\u72B6\u6001'), mimeType: 'application/json' },
]

function readResource(uri) {
  if (uri === 'acm://injection') {
    const r = buildInjectionText({ db, config, sessionId, query: '' })
    return r.text || '\uFF08\u73B0\u5728\u8FD8\u4E0D\u7528\u6CE8\u5165\u4EC0\u4E48\uFF09'
  }
  if (uri === 'acm://persona') {
    const p = loadPersona(db, config.personaFiles, { owner: config.owner ?? null })
    const pend = pendingProposals(db, config.owner ?? null)
    return [p.text || '\uFF08\u6CA1\u627E\u5230\u4EBA\u8BBE\u6587\u4EF6\uFF09', ...pend.map((x) => `\u672A\u5BA1\u6279\uFF1A#${x.id} ${String(x.path).split(/[\\/]/).pop()} ${x.diff_summary}`)].join('\n')
  }
  if (uri === 'acm://status') {
    // local: false keeps dbPath, owner and persona paths out of model context.
    return JSON.stringify({ ...statusOf({ db, config, sessionId, local: false }), checkpoint: activeCheckpoint(db, sessionId, config.owner ?? null) }, null, 2)
  }
  return null
}

async function callTool(name, args = {}) {
  const spec = TOOLS.find((t) => t.name === name)
  if (!spec) throw new Error(`no such tool: ${name}`)
  // \u5DE5\u5177\u53EF\u4EE5\u662F\u5F02\u6B65\u7684\uFF08\u8BED\u4E49\u68C0\u7D22\u8981\u7B49\u6A21\u578B\uFF09\uFF0C\u8FD9\u91CC\u7EDF\u4E00 await
  const value = await spec.run(args, { db, config, sessionId })
  const text = spec.output?.render ? spec.output.render(args, value) : JSON.stringify(value)
  return { content: [{ type: 'text', text }], structuredContent: value }
}

async function handle(msg) {
  const { id, method, params } = msg
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: SERVER,
        instructions: bilingual('Memory and task checkpoints. Read acm://injection before starting work, and again after a compaction or a new session.', '\u8BB0\u5FC6\u4E0E\u4EFB\u52A1\u68C0\u67E5\u70B9\u3002\u5F00\u5DE5\u524D\u8BFB acm://injection\uFF0C\u538B\u7F29\u6216\u6362\u4F1A\u8BDD\u540E\u4E5F\u8BFB\u5B83\u3002'),
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: bilingual(EN[t.name], t.description),
          inputSchema: jsonSchemaOf(t.parameters),
        })),
      })
    case 'tools/call': {
      try {
        return ok(await callTool(params?.name, params?.arguments ?? {}))
      } catch (err) {
        return ok({ content: [{ type: 'text', text: `\u5931\u8D25\uFF1A${err?.message ?? err}` }], isError: true })
      }
    }
    case 'resources/list':
      return ok({ resources: RESOURCES })
    case 'resources/read': {
      const text = readResource(params?.uri)
      if (text == null) return fail(-32602, `unknown resource: ${params?.uri}`)
      const mimeType = RESOURCES.find((r) => r.uri === params.uri)?.mimeType ?? 'text/plain'
      return ok({ contents: [{ uri: params.uri, mimeType, text }] })
    }
    default:
      return fail(-32601, `method not found: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin })
// One message at a time across the whole stream. Separately arriving lines used
// to start independent handlers, so a read could answer before the write on the
// previous line had committed. The documented guarantee is strict ordering.
let queue = Promise.resolve()
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try {
    msg = JSON.parse(s)
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`)
    return
  }
  const batch = Array.isArray(msg) ? msg : [msg]
  // \u4E00\u6761\u4E00\u6761\u6309\u987A\u5E8F\u5904\u7406\uFF1A\u8BED\u4E49\u68C0\u7D22\u662F\u5F02\u6B65\u7684\uFF0C\u4E32\u884C\u624D\u4FDD\u8BC1\u56DE\u5E94\u987A\u5E8F
  queue = queue.then(async () => {
    const out = []
    for (const m of batch) {
      try {
        const r = await handle(m)
        if (r) out.push(r)
      } catch (err) {
        out.push({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: String(err?.message ?? err) } })
      }
    }
    if (out.length) process.stdout.write(`${JSON.stringify(Array.isArray(msg) ? out : out[0])}\n`)
  })
})
