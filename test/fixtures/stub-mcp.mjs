#!/usr/bin/env node
/**
 * A stand-in MCP server for `test/drill-guard.mjs`.
 *
 * The drill script is a manual tool, but its failure handling must be provable
 * without a model. This stub speaks the same line-delimited JSON, advertises the
 * three tools the guard exercises, and can be told to misbehave:
 *
 *   STUB_MODE=ok     normal replies, including a `done` mailbox item and a fact
 *   STUB_MODE=error  every tools/call answers with isError
 *   STUB_MODE=die    exits without replying to tools/call, like a crashed server
 *
 * STUB_DONE_ID and STUB_KEY control what the `ok` mode reports.
 */
import { createInterface } from 'node:readline'

const mode = process.env.STUB_MODE ?? 'ok'
const doneId = Number(process.env.STUB_DONE_ID ?? '1')
const key = process.env.STUB_KEY ?? 'drill.key'

const TOOLS = [
  { name: 'acm_inbox', description: 'stub inbox', inputSchema: { type: 'object', properties: {} } },
  { name: 'acm_search', description: 'stub search', inputSchema: { type: 'object', properties: {} } },
  { name: 'acm_remember', description: 'stub remember', inputSchema: { type: 'object', properties: {} } },
]

const reply = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const ok = (id, result) => reply({ jsonrpc: '2.0', id, result })

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }

  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'drill-stub', version: '0' },
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS })
    case 'tools/call': {
      if (mode === 'die') process.exit(3)
      if (mode === 'error') {
        return ok(msg.id, { content: [{ type: 'text', text: 'boom: injected failure' }], isError: true })
      }
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      if (name === 'acm_inbox') {
        const items = args.state === 'done' ? [{ id: doneId, state: 'done', sender: 'planner', body: 'stub task' }] : []
        return ok(msg.id, { content: [{ type: 'text', text: 'stub inbox' }], structuredContent: { items } })
      }
      if (name === 'acm_search') {
        return ok(msg.id, {
          content: [{ type: 'text', text: 'stub search' }],
          structuredContent: { items: [{ id: 1, key, text: 'stub fact' }] },
        })
      }
      return ok(msg.id, { content: [{ type: 'text', text: 'stub remember' }], structuredContent: { id: 1 } })
    }
    default:
      return reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `stub: ${msg.method}` } })
  }
})
