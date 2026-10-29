// \u4E24\u4E2A\u65B0\u5BBF\u4E3B\uFF1A\u547D\u4EE4\u884C\uFF08cli.mjs\uFF09\u548C MCP\uFF08mcp.mjs\uFF09\u3002
// \u90FD\u4E0D\u4F9D\u8D56 DSH\uFF0C\u8DD1\u7684\u662F\u540C\u4E00\u5957 core\u3002

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cliPath = join(here, '..', 'lib', 'host', 'cli.mjs')
const mcpPath = join(here, '..', 'lib', 'host', 'mcp.mjs')
const dir = mkdtempSync(join(tmpdir(), 'acm-hosts-'))
const dbPath = join(dir, 'memory.db')

const env = { ...process.env, ACM_DB: dbPath, ACM_SESSION: 'hosts-test' }

function cli(args) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} \u9000\u51FA ${r.status}: ${r.stderr || r.error?.message}`)
  return r.stdout.trim()
}

function mcpIn(e, lines) {
  const r = spawnSync(process.execPath, [mcpPath], { env: e, input: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`mcp \u9000\u51FA ${r.status}: ${r.stderr || r.error?.message}`)
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function cliAs(agent, args) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { env: { ...env, ACM_AGENT: agent }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} \u9000\u51FA ${r.status}: ${r.stderr || r.error?.message}`)
  return JSON.parse(r.stdout)
}

function mcp(lines) {
  return mcpIn(env, lines)
}

// One MCP client, one name. `undefined` means "do not set ACM_AGENT", which is
// how a single-client setup runs.
function mcpResult(agent, name, args, session) {
  const e = { ...env }
  if (agent !== undefined) e.ACM_AGENT = agent
  if (session !== undefined) e.ACM_SESSION = session
  const out = mcpIn(e, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hosts-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ])
  return out.find((m) => m.id === 2)?.result ?? null
}

function mcpCall(agent, name, args, session) {
  return mcpResult(agent, name, args, session)?.structuredContent ?? null
}

let pass = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { fails.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

// An installed package must expose the host-independent SDK without importing
// private repository paths or replacing the existing DSH default entry point.
const exposed = await import('dsh-acm-memory/sdk')
ok('package subpath exposes the host-independent SDK', typeof exposed.openMemory === 'function')

// ── CLI
ok('cli remember \u8BF4\u5F97\u56DE\u4EBA\u8BDD', cli(['remember', '--text', 'master prefers short replies', '--key', 'master.style', '--source', '\u8001\u5927\u8981\u77ED']).includes('\u8BB0\u597D\u4E86'))
ok('cli search \u627E\u5F97\u5230', cli(['search', 'replies']).includes('master.style'))
ok('cli \u4E2D\u6587\u539F\u8BDD\u5F53\u522B\u540D\u67E5\u5F97\u5230', cli(['alias', '--alias', '\u8001\u5927', '--canonical', 'master']).includes('\u8001\u5927 = master'))
ok('cli checkpoint', cli(['checkpoint', '--goal', '\u88C5\u5BBF\u4E3B\u9002\u914D\u5C42', '--next', '\u8DD1\u6D4B\u8BD5']).includes('\u68C0\u67E5\u70B9 #'))
const inject = cli(['inject'])
ok('cli inject \u91CC\u65E2\u6709\u4EFB\u52A1\u53C8\u6709\u8BB0\u5FC6', inject.includes('\u3010\u4EFB\u52A1\u72B6\u6001\u3011') && inject.includes('\u88C5\u5BBF\u4E3B\u9002\u914D\u5C42') && inject.includes('\u3010\u8BB0\u5F97\u7684\u4E8B\u3011'), inject.slice(0, 80))
ok('cli status \u662F JSON', (() => { try { return !!JSON.parse(cli(['status'])).stats } catch { return false } })())
ok('cli gc --dry-run \u4E0D\u5220', cli(['gc', '--dry-run']).includes('\u4F1A\u5220'))
ok('cli fold \u5199\u6587\u4EF6', (() => {
  const out = join(dir, 'memory.md')
  const msg = cli(['fold', '--out', out])
  return msg.includes('memory.md') && readFileSync(out, 'utf8').includes('master.style')
})())

// \u522B\u5904\u6A21\u578B\u62BD\u597D\u7684\u4E8B\u5B9E
const factsFile = join(dir, 'facts.json')
writeFileSync(factsFile, JSON.stringify([{ text: 'whale-girl lives in the sea', confidence: 0.9, kind: 'fact' }]), 'utf8')
ok('cli ingest \u628A\u5916\u90E8 JSON \u5199\u8FDB\u5E93', cli(['ingest', '--file', factsFile]).includes('\u5199\u8FDB 1 \u6761'))

// ── MCP
const res = mcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acm_search', arguments: { query: 'sea' } } },
  { jsonrpc: '2.0', id: 4, method: 'resources/list' },
  { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'acm://injection' } },
  { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'acm://nope' } },
  { jsonrpc: '2.0', id: 7, method: 'ping' },
])
const byId = new Map(res.filter((r) => r.id != null).map((r) => [r.id, r]))
ok('mcp \u901A\u77E5\u4E0D\u56DE\u5305\uFF087 \u6761\u8BF7\u6C42 7 \u4E2A\u56DE\u5E94\uFF09', res.filter((r) => r.id != null).length === 7, String(res.length))
ok('mcp initialize \u62A5\u534F\u8BAE\u548C\u80FD\u529B', byId.get(1)?.result?.serverInfo?.name === 'acm-memory' && !!byId.get(1)?.result?.capabilities?.tools)
const tools = byId.get(2)?.result?.tools ?? []
ok('mcp tools/list \u6709 inputSchema', tools.length >= 6 && tools.every((t) => t.inputSchema?.type === 'object'))
ok('mcp tools/call \u80FD\u67E5', (byId.get(3)?.result?.content?.[0]?.text ?? '').includes('whale-girl'))
ok('mcp resources/list \u4E09\u9879', (byId.get(4)?.result?.resources ?? []).length === 3)
ok('mcp \u8BFB\u6CE8\u5165\u62FF\u5230\u4EFB\u52A1\u72B6\u6001', (byId.get(5)?.result?.contents?.[0]?.text ?? '').includes('\u3010\u4EFB\u52A1\u72B6\u6001\u3011'))
ok('mcp \u672A\u77E5\u8D44\u6E90\u62A5 -32602', byId.get(6)?.error?.code === -32602)
ok('mcp ping \u56DE\u7A7A\u5BF9\u8C61', JSON.stringify(byId.get(7)?.result) === '{}')

// \u574F JSON \u4E0D\u8BE5\u628A\u670D\u52A1\u6253\u6302
// A batch must run in order: the write has to land before the read that follows
// it, otherwise the read answers with the pre-batch state.
const ordered = mcp([
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'acm_remember', arguments: { text: 'batch ordering marker is violet-77', key: 'batch.marker', source: 'batch test' } } },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'acm_search', arguments: { query: 'violet-77' } } },
])
ok('mcp batch lands the write before the read', (ordered.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? '').includes('violet-77'))
// The external surface is bilingual on purpose: a Chinese-speaking operator and
// an English-speaking reviewer both use the same MCP server.
const bilingualTools = tools.every((t) => /[A-Za-z]/.test(t.description) && /[\u4e00-\u9fff]/.test(t.description))
ok('mcp tool descriptions carry both languages', bilingualTools, JSON.stringify(tools[0]?.description))
const titles = byId.get(4)?.result?.resources ?? []
ok('mcp resource titles carry both languages', titles.length === 3 && titles.every((r) => /[A-Za-z]/.test(r.title) && /[\u4e00-\u9fff]/.test(r.title)), JSON.stringify(titles.map((r) => r.title)))
// Cross-adapter acceptance baseline. Every call starts a new process, so the
// result tests durable CLI/MCP/SDK coordination and a fresh session, not just
// one in-process mailbox. This is NOT authenticated cross-provider execution.
const assigned = JSON.parse(cli([
  'send', '--from', 'leader', '--to', 'agent', '--kind', 'review',
  '--body', 'Check synthetic staging release and report evidence',
]))
ok('CLI leader assigns persistent work', assigned.ok === true && assigned.id > 0)

const pickedUp = mcp([
  { jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name: 'acm_inbox', arguments: {} } },
  { jsonrpc: '2.0', id: 82, method: 'tools/call', params: { name: 'acm_claim', arguments: { id: assigned.id } } },
])
const assignedInbox = pickedUp.find((x) => x.id === 81)?.result?.structuredContent?.items ?? []
ok('independent MCP recipient finds and exclusively claims CLI work',
  assignedInbox.some((m) => m.id === assigned.id && m.state === 'pending') &&
  pickedUp.find((x) => x.id === 82)?.result?.structuredContent?.ok === true)

const executed = mcp([
  { jsonrpc: '2.0', id: 83, method: 'tools/call', params: { name: 'acm_remember', arguments: {
    text: 'cross-adapter staging review passed', key: 'interop.review',
    source: 'synthetic CLI-MCP restart acceptance test',
  } } },
  { jsonrpc: '2.0', id: 84, method: 'tools/call', params: { name: 'acm_complete', arguments: { id: assigned.id } } },
  { jsonrpc: '2.0', id: 85, method: 'tools/call', params: { name: 'acm_send', arguments: {
    to: 'leader', body: 'Review complete: interop.review; staging passed',
  } } },
])
ok('restarted MCP recipient persists evidence, completes and replies',
  executed.find((x) => x.id === 83)?.result?.structuredContent?.id > 0 &&
  executed.find((x) => x.id === 84)?.result?.structuredContent?.ok === true &&
  executed.find((x) => x.id === 85)?.result?.structuredContent?.ok === true)
const replies = JSON.parse(cli(['inbox', '--agent', 'leader']))
const completedWork = JSON.parse(cli(['inbox', '--agent', 'agent', '--state', 'done']))
ok('fresh CLI leader receives reply and verifies recipient task state',
  replies.some((m) => m.body.includes('interop.review')) &&
  completedWork.some((m) => m.id === assigned.id && m.claimedBy === 'agent'))
const freshSdk = exposed.openMemory({
  dbPath, sessionId: 'hosts-test', config: { backup: { enabled: false } },
})
ok('reopened SDK handle retrieves cross-adapter memory',
  freshSdk.search('cross-adapter staging review').some((m) => m.key === 'interop.review'))
freshSdk.close()

// \u2500\u2500 Shared scope: a task handed over must carry the context it refers to
// Without a way to publish a fact to the whole owner partition, an agent that
// receives a task cannot read the fact the task is about: every write was pinned
// to the writer's session. The widening is deliberately limited to `global`.
const shared = mcpCall('planner', 'acm_remember', { text: 'the staging token rotates weekly', key: 'staging.token', scope: 'global' }, 'sP')
const sharedLookup = mcpCall('runner', 'acm_search', { query: 'staging token' }, 'sR')
ok('a fact written as global is readable from another session',
  typeof shared?.id === 'number' && (sharedLookup?.items ?? []).some((i) => i.key === 'staging.token'),
  JSON.stringify(sharedLookup).slice(0, 140))

const privateWrite = mcpCall('planner', 'acm_remember', { text: 'a private note inside the planner session', key: 'planner.private' }, 'sP')
const privateLookup = mcpCall('runner', 'acm_search', { query: 'private note inside the planner session' }, 'sR')
ok('a default write still stays inside its own session',
  typeof privateWrite?.id === 'number' && !(privateLookup?.items ?? []).some((i) => i.key === 'planner.private'),
  JSON.stringify(privateLookup).slice(0, 140))

// Naming someone else's session is refused outright rather than quietly
// downgraded to a private write: a caller that believes it shared something and
// did not will hand over a task whose evidence the successor cannot read.
const escapeWrite = mcpResult('planner', 'acm_remember', { text: 'an attempt to write into the runner session', key: 'escape.attempt', scope: 'sR' }, 'sP')
ok('scope cannot be used to write into another session',
  escapeWrite?.isError === true && /invalid scope/.test(escapeWrite?.content?.[0]?.text ?? ''),
  JSON.stringify(escapeWrite).slice(0, 160))

// The same hazard as a typo: the intent was `global`, the write would land in the
// session, and nothing would report the difference.
const typoWrite = mcpResult('planner', 'acm_remember', { text: 'a fact meant to be shared', key: 'typo.scope', scope: 'globla' }, 'sP')
ok('a misspelled global scope is refused, not silently made private',
  typoWrite?.isError === true && /invalid scope/.test(typoWrite?.content?.[0]?.text ?? ''),
  JSON.stringify(typoWrite).slice(0, 160))
const typoLookup = mcpCall('runner', 'acm_search', { query: 'a fact meant to be shared' }, 'sR')
ok('the refused write left nothing behind', !(typoLookup?.items ?? []).some((i) => i.key === 'typo.scope'),
  JSON.stringify(typoLookup).slice(0, 120))

// \u2500\u2500 Durable tasks over MCP stdio
// The CLI path calls the task functions directly, so it could not catch a missing
// authorization action on the tool wrapper. These calls go through the MCP server
// exactly like a foreign client would, which is the path that broke.
{
  const created = mcpCall('planner', 'acm_task_create', { title: 'mcp lifecycle', assignee: 'runner' })
  ok('mcp creates a task', created?.ok === true && created.task.state === 'assigned', JSON.stringify(created).slice(0, 140))
  const key = created.task.key
  const accepted = mcpCall('runner', 'acm_task_accept', { key })
  ok('mcp accepts a task (the path that a missing action broke)',
    accepted?.ok === true && accepted.task.state === 'running', JSON.stringify(accepted).slice(0, 160))
  const noEvidence = mcpCall('runner', 'acm_task_return', { key, result: 'done' })
  ok('mcp return refuses a result without evidence', noEvidence?.ok === false && noEvidence.reason === 'evidence-required',
    JSON.stringify(noEvidence).slice(0, 140))
  const returned = mcpCall('runner', 'acm_task_return', { key, result: 'done', evidence: 'test:npm run test:all\ncommit:abc1234' })
  ok('mcp return parses kind:ref lines', returned?.ok === true && returned.task.evidence.length === 2,
    JSON.stringify(returned.task?.evidence))
  const selfVerify = mcpCall('runner', 'acm_task_verify', { key })
  ok('mcp refuses self-verification', selfVerify?.ok === false && selfVerify.reason === 'self-verification-refused',
    JSON.stringify(selfVerify).slice(0, 120))
  const verified = mcpCall('reviewer', 'acm_task_verify', { key, note: 'ok' })
  ok('mcp verifies from a different agent', verified?.ok === true && verified.task.state === 'verified')
  const shown = mcpCall('planner', 'acm_task_get', { key })
  ok('mcp exposes the ordered trail',
    shown?.ok === true && shown.events.map((e) => e.action).join(',') === 'create,accept,return,verify',
    shown?.events?.map((e) => e.action).join(','))
  const listed = mcpCall('planner', 'acm_task_list', {})
  ok('mcp lists tasks', (listed?.items ?? []).some((t) => t.key === key))
}

// \u2500\u2500 Durable tasks through the CLI
// The state machine is tested directly in test/tasks.mjs; this proves the operator
// surface reaches the same code with the same refusals.
{
  const created = cliAs('planner', ['task', 'create', '--title', 'cli lifecycle', '--assignee', 'runner'])
  const taskKey = created.task.key
  ok('cli creates a task', created.ok === true && created.task.state === 'assigned', JSON.stringify(created).slice(0, 120))
  ok('cli refuses to verify before anything was returned',
    cliAs('reviewer', ['task', 'verify', '--key', taskKey]).ok === false)
  const accepted = cliAs('runner', ['task', 'accept', '--key', taskKey])
  ok('the assignee starts it through the cli', accepted.ok === true && accepted.task.state === 'running')
  ok('a returned task needs evidence, and the cli enforces it',
    cliAs('runner', ['task', 'return', '--key', taskKey, '--result', 'done']).ok === false)
  const returned = cliAs('runner', ['task', 'return', '--key', taskKey, '--result', 'done', '--evidence', 'test:npm run test:all,commit:abc1234'])
  ok('evidence is parsed from kind:ref pairs', returned.ok === true && returned.task.evidence.length === 2,
    JSON.stringify(returned.task?.evidence))
  ok('the author cannot verify their own work through the cli',
    cliAs('runner', ['task', 'verify', '--key', taskKey]).reason === 'self-verification-refused')
  const verified = cliAs('reviewer', ['task', 'verify', '--key', taskKey])
  ok('a different principal verifies it', verified.ok === true && verified.task.state === 'verified')
  const shown = cliAs('planner', ['task', 'show', '--key', taskKey])
  ok('the trail is readable and ordered',
    shown.events.map((e) => e.action).join(',') === 'create,accept,return,verify', shown.events.map((e) => e.action).join(','))

  // Confirmation is the user's own act, and the CLI is its only surface. The
  // assignee is refused for the same reason self-verification is: "I confirmed my
  // own work" is the claim the state machine exists to make auditable rather than assumed.
  const selfConfirm = cliAs('runner', ['task', 'confirm', '--key', taskKey])
  ok('the assignee cannot confirm its own work through the cli',
    selfConfirm.ok === false && selfConfirm.reason === 'self-confirmation-refused', JSON.stringify(selfConfirm).slice(0, 120))
  const confirmed = cliAs('operator', ['task', 'confirm', '--key', taskKey, '--actor', 'the-owner', '--note', 'read the trail'])
  ok('the person confirms it, and the trail names them',
    confirmed.ok === true && confirmed.task.state === 'confirmed' && confirmed.task.confirmedBy === 'the-owner',
    JSON.stringify(confirmed).slice(0, 140))
  const afterConfirm = cliAs('planner', ['task', 'show', '--key', taskKey])
  ok('confirmation is the last act in an append-only trail',
    afterConfirm.events.map((e) => e.action).join(',') === 'create,accept,return,verify,confirm',
    afterConfirm.events.map((e) => e.action).join(','))
}

// \u2500\u2500 Mailbox identity over MCP
// The agent name decides who may claim a task and who may close it. With one
// constant name, either nobody could collect work addressed to a named peer, or
// every client shared the name and either could finish the other's work.
const sent = mcpCall('planner', 'acm_send', { to: 'runner', body: 'review the staging checklist', kind: 'review' })
ok('planner hands work to a named peer over MCP', sent?.ok === true && typeof sent.id === 'number', JSON.stringify(sent))

const runnerInbox = mcpCall('runner', 'acm_inbox', {})
ok('the named peer sees it and the sender is its own name, not the constant "agent"',
  (runnerInbox?.items ?? []).some((m) => m.id === sent.id && m.sender === 'planner'), JSON.stringify(runnerInbox).slice(0, 160))

const strangerClaim = mcpCall('stranger', 'acm_claim', { id: sent.id })
ok('a third agent cannot collect work addressed to the peer',
  strangerClaim?.ok === false && strangerClaim?.reason === 'not-your-inbox', JSON.stringify(strangerClaim))

const claimed = mcpCall('runner', 'acm_claim', { id: sent.id })
ok('the peer claims it', claimed?.ok === true, JSON.stringify(claimed))

const foreignComplete = mcpCall('planner', 'acm_complete', { id: sent.id })
ok('the sender cannot close work it did not do',
  foreignComplete?.ok === false && foreignComplete?.reason === 'claimed-by-someone-else', JSON.stringify(foreignComplete))

const completed = mcpCall('runner', 'acm_complete', { id: sent.id })
ok('the claim holder closes it', completed?.ok === true, JSON.stringify(completed))

// Backwards compatibility: a client with no ACM_AGENT is still the single
// default identity, so nothing changes for a one-client setup.
const legacy = mcpCall(undefined, 'acm_send', { to: 'agent', body: 'legacy default identity' })
const legacyInbox = mcpCall(undefined, 'acm_inbox', {})
ok('with no ACM_AGENT a client keeps the previous single default identity',
  legacy?.ok === true && (legacyInbox?.items ?? []).some((m) => m.id === legacy.id && m.sender === 'agent'),
  JSON.stringify(legacyInbox).slice(0, 140))

const bad = spawnSync(process.execPath, [mcpPath], { env, input: 'not json\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n', encoding: 'utf8' })
const badLines = bad.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
ok('mcp \u574F JSON \u62A5 -32700 \u8FD8\u80FD\u7EE7\u7EED', badLines[0]?.error?.code === -32700 && badLines[1]?.id === 9)

console.log(`\n${failures(!fails.length)}  ${pass} \u9879\u901A\u8FC7${fails.length ? `\uFF0C${fails.length} \u9879\u5931\u8D25` : ''}`)
function failures(clean) { return clean ? '\u5168\u7EFF' : '\u6709\u5931\u8D25' }
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exitCode = 1 }

// \u6E05\u6389\u4E34\u65F6\u5E93
try { rmSync(dir, { recursive: true, force: true }) } catch {}
