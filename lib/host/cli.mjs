#!/usr/bin/env node
// CLI \u5BBF\u4E3B\uFF1A\u4EFB\u4F55\u4E00\u4E2A\u4F1A\u7528\u547D\u4EE4\u884C\u7684 agent \u90FD\u80FD\u7528\uFF0C\u4E0D\u7528\u88C5 SDK\u3002
//
// \u7528\u6CD5\uFF1A
//   acm inject [--query "\u73B0\u5728\u95EE\u7684\u8FD9\u53E5"]     → \u6253\u5370\u8981\u62FC\u8FDB prompt \u7684\u90A3\u6BB5
//   acm persona                            → \u6253\u5370\u4EBA\u683C\u6587\u4EF6\u5168\u6587
//   acm remember --text "..." [--key k] [--source "\u539F\u8BDD"]
//   acm search "\u5173\u952E\u8BCD"
//   acm checkpoint --goal "..." --next "..."
//   acm ingest --file facts.json           → \u628A\u522B\u5904\u6A21\u578B\u62BD\u597D\u7684 JSON \u4E8B\u5B9E\u5199\u8FDB\u5E93
//   acm forget --id 3 / acm alias --alias \u8001\u5927 --canonical master / acm gc [--dry-run]
//   acm status / acm fold --out memory.md
//
// \u73AF\u5883\u53D8\u91CF\uFF1AACM_SESSION\uFF08\u4F1A\u8BDD id\uFF0C\u9ED8\u8BA4 cli\uFF09\u3001ACM_DB\uFF08\u5E93\u8DEF\u5F84\uFF09

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDb } from '../db.mjs'
import { redact } from '../redact.mjs'
import { backupDirFor, backupIfDue, restoreBackup, verifyBackups } from '../backup.mjs'
import { conflicts, forget, history, provenance, purge, purgeRange, quarantine, releaseQuarantine, resolveConflict, setAlias, sourcesOf, suspects, trustEvents, verifyPurged } from '../memory.mjs'
import { activeCheckpoint, renderRecoveryReport, saveCheckpoint, verifyRecovery } from '../checkpoint.mjs'
import { loadPersona, pendingProposals } from '../persona.mjs'
import { foldToMarkdown } from '../fold.mjs'
import { parseFacts } from '../distill.mjs'
import { buildGraph, renderGraphHtml } from '../graph.mjs'
import { evolve, evolutionLog, renderEvolution } from '../evolve.mjs'
import { buildInjectionText, mergeConfig, sessionIdFromEnv, statusOf, toolByName, TOOLS } from '../core.mjs'
import { retentionReport } from '../retention.mjs'
import { buildHandoff, renderHandoffReport, verifyHandoff } from '../handoff.mjs'
import { agents as listAgents, argue, claimMessage, completeMessage, decide as decideRecord, decisionView, decisions as listDecisions, escalateConflict, inbox, openDecision, registerAgent, sendMessage } from '../deliberation.mjs'
import { embedMissing, vectorStats } from '../embed.mjs'
import { acceptTask, assignTask, cancelTask, confirmTask, createTask, expireLeases, failTask, getTask, listTasks, rejectTask, renewTask, retryTask, returnTask, taskEvents, verifyTask } from '../tasks.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[k] = true
    else { out[k] = next; i++ }
  }
  return out
}

function env() {
  const overrides = {}
  if (process.env.ACM_DB) overrides.dbPath = process.env.ACM_DB
  if (process.env.ACM_OWNER) overrides.owner = process.env.ACM_OWNER
  if (process.env.ACM_AGENT) overrides.agent = process.env.ACM_AGENT
  if (process.env.ACM_PROJECT) overrides.project = process.env.ACM_PROJECT
  const config = mergeConfig(overrides)
  // The CLI runs on behalf of the operator who typed the command, so destructive
  // maintenance tools are allowed here and only here by default.
  config.adminTools = true
  try { mkdirSync(dirname(config.dbPath), { recursive: true }) } catch {}
  const db = openDb(config.dbPath)
try { backupIfDue(db, config.dbPath, config.backup) } catch {}
  return { db, config, sessionId: sessionIdFromEnv() }
}

function usage() {
  return [
    'acm inject [--query ..] | persona | status | fold --out <path>',
    'acm remember --text <\u82F1\u6587\u77ED\u8BED> [--key k] [--kind fact|preference|decision|event] [--importance 0.6] [--source <\u539F\u8BDD>]',
    'acm search <\u5173\u952E\u8BCD> [--limit 6]',
    'acm checkpoint [--goal ..] [--done ..] [--next ..] [--files ..] [--decisions ..]',
    'acm ingest --file <facts.json>      \u628A\u522B\u5904\u6A21\u578B\u62BD\u597D\u7684\u4E8B\u5B9E\u5199\u8FDB\u5E93',
    'acm forget --id <n> | alias --alias <\u522B\u540D> --canonical <\u6B63\u540D> | gc [--days 120] [--dry-run]',
  ].join('\n')
}

export async function runCli(argv) {
  const args = parseArgs(argv)
  const cmd = args._[0] ?? 'inject'
  const { db, config, sessionId } = env()
  // --owner selects a partition for this invocation. It is a filter, not an
  // identity check: anyone who can read the database file can pass it.
  if (typeof args.owner === 'string') config.owner = args.owner

  const call = async (name, raw) => {
    const spec = toolByName(name)
    if (!spec) throw new Error(`\u6CA1\u6709\u8FD9\u4E2A\u5DE5\u5177\uFF1A${name}`)
    const r = await spec.run(raw, { db, config, sessionId })
    return spec.output.render(raw, r)
  }

  switch (cmd) {
    case 'inject': {
      const r = buildInjectionText({ db, config, sessionId, query: args.query ?? '' })
      return r.text || '\uFF08\u73B0\u5728\u8FD8\u4E0D\u7528\u6CE8\u5165\u4EC0\u4E48\uFF09'
    }

    case 'persona': {
      const p = loadPersona(db, config.personaFiles, { owner: config.owner ?? null })
      const lines = []
      if (p.changed.length) lines.push('\uFF08\u4EBA\u8BBE\u6587\u4EF6\u521A\u88AB\u6539\u8FC7\uFF0C\u7B49\u4F60\u786E\u8BA4\u3002\uFF09')
      lines.push(p.text || '\uFF08\u6CA1\u627E\u5230\u4EBA\u8BBE\u6587\u4EF6\uFF09')
      const pend = pendingProposals(db, config.owner ?? null)
      if (pend.length) {
        lines.push('')
        lines.push(`\u672A\u5BA1\u6279\u6539\u52A8 ${pend.length} \u6761\uFF1A`)
        for (const x of pend) lines.push(`  #${x.id} ${x.path} ${x.diff_summary}`)
      }
      return lines.join('\n')
    }

    case 'remember':
      if (!args.text) throw new Error('\u8981 --text')
      return call('acm_remember', {
        text: String(args.text),
        key: args.key && args.key !== true ? String(args.key) : undefined,
        kind: args.kind && args.kind !== true ? String(args.kind) : undefined,
        importance: args.importance && args.importance !== true ? Number(args.importance) : undefined,
        source: args.source && args.source !== true ? String(args.source) : undefined,
      })

    case 'search':
      return call('acm_search', {
        query: args.query && args.query !== true ? String(args.query) : args._.slice(1).join(' '),
        limit: args.limit && args.limit !== true ? Number(args.limit) : undefined,
      })

    case 'checkpoint': {
      const id = saveCheckpoint(db, {
        sessionId,
        owner: config.owner ?? null,
        goal: args.goal && args.goal !== true ? String(args.goal) : undefined,
        done: args.done && args.done !== true ? String(args.done) : undefined,
        next: args.next && args.next !== true ? String(args.next) : undefined,
        files: args.files && args.files !== true ? String(args.files) : undefined,
        decisions: args.decisions && args.decisions !== true ? String(args.decisions) : undefined,
        guard: (v) => (config.redact?.enabled ? redact(v, config.redact).text : v),
      })
      return `\u68C0\u67E5\u70B9 #${id} \u5B58\u597D\u4E86`
    }

    case 'ingest': {
      if (!args.file || args.file === true) throw new Error('\u8981 --file')
      const raw = readFileSync(String(args.file), 'utf8')
      let facts = parseFacts(raw, {})
      if (!facts.length) {
        try { facts = parseFacts(JSON.stringify(JSON.parse(raw).facts ?? []), {}) } catch {}
      }
      const spec = toolByName('acm_remember')
      let written = 0
      for (const f of facts) {
        spec.run({ text: f.text, key: f.key, kind: f.kind, importance: f.confidence, source: `ingested from ${args.file}` }, { db, config, sessionId })
        written++
      }
      return `\u62BD\u5230 ${facts.length} \u6761\uFF0C\u5199\u8FDB ${written} \u6761`
    }

    case 'feedback':
      return call('acm_feedback', {
        id: Number(args.id ?? 0),
        verdict: String(args.verdict ?? (args.wrong ? 'wrong' : 'useful')),
        note: args.note && args.note !== true ? String(args.note) : undefined,
      })

    case 'evolve':
      return call('acm_evolve', { dryRun: !!args['dry-run'] })

    case 'evolutions': {
      const list = evolutionLog(db, args.limit && args.limit !== true ? Number(args.limit) : 10)
      if (!list.length) return '\u8FD8\u6CA1\u8FDB\u5316\u8FC7\u3002'
      return list
        .map((e) => `#${e.id} ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')}\n${renderEvolution(e.report)}`)
        .join('\n\n')
    }
    case 'forget':
      return call('acm_forget', { id: Number(args.id ?? 0) })

    case 'conflicts': {
      const days = args['since-days'] && args['since-days'] !== true ? Number(args['since-days']) : null
      const since = days ? Date.now() - days * 86400e3 : null
      const scope = args.scope && args.scope !== true ? String(args.scope) : null
      return JSON.stringify(conflicts(db, { owner: config.owner ?? null, since, scope }), null, 2)
    }

    case 'resolve': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('resolve needs --id <n>')
      return JSON.stringify(resolveConflict(db, { id, owner: config.owner ?? null }), null, 2)
    }

    case 'provenance': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('provenance needs --id <n>')
      const p = provenance(db, id, { owner: config.owner ?? null })
      if (!p) throw new Error(`no such memory in this partition: ${id}`)
      return JSON.stringify(p, null, 2)
    }

    case 'purge': {
      // Deliberately not a model-facing tool: erasure is an operator action.
      const owner = config.owner ?? null
      if (args.before !== undefined && args.before !== true) {
        const raw = String(args.before)
        const before = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
        if (!Number.isFinite(before)) throw new Error('purge --before needs YYYY-MM-DD or epoch milliseconds')
        const scope = args.scope && args.scope !== true ? String(args.scope) : null
        return JSON.stringify(purgeRange(db, { owner, before, scope, dryRun: !!args['dry-run'] }), null, 2)
      }
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('purge needs --id <n> or --before <date>')
      const r = purge(db, id, { owner })
      const evidence = verifyPurged(db, id)
      return JSON.stringify({ ...r, evidence }, null, 2)
    }

    case 'alias':
      return call('acm_alias', { alias: String(args.alias ?? ''), canonical: String(args.canonical ?? '') })

    case 'gc':
      return call('acm_gc', {
        days: args.days && args.days !== true ? Number(args.days) : undefined,
        all: !!args.all,
        dryRun: !!args['dry-run'],
      })

    case 'backup': {
      const r = backupIfDue(db, config.dbPath, { ...config.backup, everyHours: 0 }, Date.now())
      return JSON.stringify(r, null, 2)
    }
    case 'send': {
      const r = sendMessage(db, {
        to: args.to && args.to !== true ? String(args.to) : '',
        from: args.from && args.from !== true ? String(args.from) : (process.env.ACM_AGENT ?? 'cli'),
        kind: args.kind && args.kind !== true ? String(args.kind) : 'notice',
        body: args.body && args.body !== true ? String(args.body) : '',
        decisionId: args.decision && args.decision !== true ? Number(args.decision) : null,
        owner: config.owner ?? null,
      })
      return JSON.stringify(r, null, 2)
    }

    case 'inbox':
      return JSON.stringify(inbox(db, {
        agent: args.agent && args.agent !== true ? String(args.agent) : (process.env.ACM_AGENT ?? 'cli'),
        state: args.state && args.state !== true ? String(args.state) : null,
        owner: config.owner ?? null,
      }), null, 2)

    case 'claim': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('claim needs --id <message>')
      return JSON.stringify(claimMessage(db, {
        id,
        agent: args.agent && args.agent !== true ? String(args.agent) : (process.env.ACM_AGENT ?? 'cli'),
        owner: config.owner ?? null,
      }), null, 2)
    }

    case 'complete': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('complete needs --id <message>')
      return JSON.stringify(completeMessage(db, {
        id,
        agent: args.agent && args.agent !== true ? String(args.agent) : (process.env.ACM_AGENT ?? 'cli'),
        owner: config.owner ?? null,
      }), null, 2)
    }

    case 'task': {
      // One command with subcommands: ten flat verbs would collide with the existing
      // mailbox commands and read worse in a trace.
      const sub = args._[1] ?? 'list'
      const key = args.key && args.key !== true ? String(args.key) : null
      const actor = args.actor && args.actor !== true ? String(args.actor) : (process.env.ACM_AGENT ?? 'cli')
      const owner = config.owner ?? null
      const show = (r) => JSON.stringify(r, null, 2)
      const needKey = () => {
        if (!key) throw new Error(`task ${sub} needs --key <task>`)
        return key
      }
      const evidence = () => {
        const raw = args.evidence && args.evidence !== true ? String(args.evidence) : ''
        const out = []
        for (const piece of raw.split(/[\n,]/)) {
          const line = piece.trim()
          if (!line) continue
          const cut = line.indexOf(':')
          if (cut < 0) { out.push({ kind: 'note', ref: line }); continue }
          out.push({ kind: line.slice(0, cut).trim(), ref: line.slice(cut + 1).trim() })
        }
        return out.length ? out : null
      }
      switch (sub) {
        case 'create': {
          const title = args.title && args.title !== true ? String(args.title) : null
          if (!title) throw new Error('task create needs --title')
          return show(createTask(db, {
            title,
            detail: args.detail && args.detail !== true ? String(args.detail) : null,
            assignee: args.assignee && args.assignee !== true ? String(args.assignee) : null,
            dependsOn: args.depends && args.depends !== true ? String(args.depends).split(',').map((x) => x.trim()).filter(Boolean) : [],
            priority: args.priority,
            owner,
            project: args.project && args.project !== true ? String(args.project) : (config.project ?? null),
            createdBy: actor,
          }))
        }
        case 'list':
          return show({ items: listTasks(db, {
            owner,
            state: args.state && args.state !== true ? String(args.state) : null,
            assignee: args.assignee && args.assignee !== true ? String(args.assignee) : null,
            limit: args.limit,
          }) })
        case 'show': {
          const t = getTask(db, { key: needKey(), owner })
          if (!t) throw new Error(`no such task: ${key}`)
          return show({ task: t, events: taskEvents(db, { key, owner }) })
        }
        case 'assign':
          return show(assignTask(db, { key: needKey(), owner, assignee: args.assignee, actor }))
        case 'accept':
          return show(acceptTask(db, { key: needKey(), owner, actor, leaseMs: args['lease-ms'] }))
        case 'renew':
          return show(renewTask(db, { key: needKey(), owner, actor, leaseMs: args['lease-ms'] }))
        case 'return':
          return show(returnTask(db, {
            key: needKey(), owner, actor,
            result: args.result && args.result !== true ? String(args.result) : null,
            evidence: evidence(),
          }))
        case 'verify':
          return show(verifyTask(db, { key: needKey(), owner, actor, note: args.note && args.note !== true ? String(args.note) : null }))
        case 'confirm':
          // The user's own act, and the only surface for it: no MCP tool, no SDK
          // method. The actor is whoever ran this command - `--actor`, else
          // `ACM_AGENT`, else `operator` - and not a constant: with a constant, an
          // agent could confirm the work it had just done by calling the CLI under
          // a different name, and the assignee check would never fire. The state
          // machine, not this line, is what refuses self-confirmation.
          return show(confirmTask(db, {
            key: needKey(), owner,
            actor: args.actor && args.actor !== true ? String(args.actor) : (process.env.ACM_AGENT ?? 'operator'),
            note: args.note && args.note !== true ? String(args.note) : null,
          }))
        case 'reject':
          return show(rejectTask(db, {
            key: needKey(), owner, actor,
            reason: args.reason && args.reason !== true ? String(args.reason) : null,
          }))
        case 'fail':
          return show(failTask(db, { key: needKey(), owner, actor, reason: args.reason }))
        case 'cancel':
          return show(cancelTask(db, { key: needKey(), owner, actor, reason: args.reason && args.reason !== true ? String(args.reason) : null }))
        case 'retry':
          return show(retryTask(db, { key: needKey(), owner, actor, assignee: args.assignee && args.assignee !== true ? String(args.assignee) : null }))
        case 'expire':
          return show(expireLeases(db, { owner, at: args.at }))
        default:
          throw new Error(`unknown task subcommand: ${sub}`)
      }
    }

    case 'agents':
      return JSON.stringify(listAgents(db, { owner: config.owner ?? null }), null, 2)

    case 'agent': {
      const r = registerAgent(db, {
        name: args.name && args.name !== true ? String(args.name) : '',
        role: args.role && args.role !== true ? String(args.role) : 'reviewer',
        owner: config.owner ?? null,
      })
      return JSON.stringify(r, null, 2)
    }

    case 'escalate': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('escalate needs --id <memory>')
      return JSON.stringify(escalateConflict(db, {
        nodeId: id,
        actor: args.actor && args.actor !== true ? String(args.actor) : 'cli',
        owner: config.owner ?? null,
      }), null, 2)
    }

    case 'decide-open': {
      const r = openDecision(db, {
        topic: args.topic && args.topic !== true ? String(args.topic) : '',
        proposal: args.proposal && args.proposal !== true ? String(args.proposal) : '',
        actor: args.actor && args.actor !== true ? String(args.actor) : 'cli',
        scope: args.scope && args.scope !== true ? String(args.scope) : sessionId,
        owner: config.owner ?? null,
      })
      return JSON.stringify(r, null, 2)
    }

    case 'argue': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('argue needs --id <decision>')
      const evidence = args.evidence && args.evidence !== true ? String(args.evidence).split(',').map(Number) : []
      return JSON.stringify(argue(db, id, {
        actor: args.actor && args.actor !== true ? String(args.actor) : 'cli',
        stance: args.stance && args.stance !== true ? String(args.stance) : 'support',
        text: args.text && args.text !== true ? String(args.text) : '',
        evidence,
        owner: config.owner ?? null,
      }), null, 2)
    }

    case 'decide': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('decide needs --id <decision>')
      return JSON.stringify(decideRecord(db, id, {
        actor: args.actor && args.actor !== true ? String(args.actor) : 'cli',
        outcome: args.outcome && args.outcome !== true ? String(args.outcome) : 'approved',
        rationale: args.rationale && args.rationale !== true ? String(args.rationale) : null,
        owner: config.owner ?? null,
      }), null, 2)
    }

    case 'decisions':
      return JSON.stringify(listDecisions(db, {
        owner: config.owner ?? null,
        scope: args.scope && args.scope !== true ? String(args.scope) : null,
        state: args.state && args.state !== true ? String(args.state) : null,
      }), null, 2)

    case 'decision': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('decision needs --id <n>')
      const view = decisionView(db, id, { owner: config.owner ?? null })
      if (!view) throw new Error(`no such decision in this partition: ${id}`)
      return JSON.stringify(view, null, 2)
    }

    case 'recovery': {
      const r = verifyRecovery(db, { sessionId, owner: config.owner ?? null })
      return `${renderRecoveryReport(r)}\n${JSON.stringify(r, null, 2)}`
    }

    case 'suspects':
      return JSON.stringify(suspects(db, { owner: config.owner ?? null }), null, 2)

    case 'quarantine': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('quarantine needs --id <n>')
      return JSON.stringify(quarantine(db, id, {
        owner: config.owner ?? null,
        reason: args.reason && args.reason !== true ? String(args.reason) : null,
        actor: args.actor && args.actor !== true ? String(args.actor) : 'cli',
      }), null, 2)
    }

    case 'release': {
      const id = Number(args.id ?? 0)
      if (!id) throw new Error('release needs --id <n>')
      return JSON.stringify(releaseQuarantine(db, id, {
        owner: config.owner ?? null,
        reason: args.reason && args.reason !== true ? String(args.reason) : null,
        actor: args.actor && args.actor !== true ? String(args.actor) : 'cli',
      }), null, 2)
    }

    case 'trust-events': {
      const nodeId = args.id && args.id !== true ? Number(args.id) : null
      return JSON.stringify(trustEvents(db, { nodeId, owner: config.owner ?? null }), null, 2)
    }

    case 'handoff': {
      const pkg = buildHandoff(db, { sessionId, owner: config.owner ?? null })
      if (args.out && args.out !== true) writeFileSync(String(args.out), JSON.stringify(pkg, null, 2), 'utf8')
      return JSON.stringify(pkg, null, 2)
    }

    case 'handoff-verify': {
      if (!args.file || args.file === true) throw new Error('handoff-verify needs --file <package.json>')
      const pkg = JSON.parse(readFileSync(String(args.file), 'utf8'))
      const v = verifyHandoff(db, pkg, { owner: config.owner ?? null })
      return `${renderHandoffReport(v)}\n${JSON.stringify(v, null, 2)}`
    }

    case 'restore': {
      if (!args.from || args.from === true || !args.to || args.to === true) {
        throw new Error('restore needs --from <backup file> and --to <database path>')
      }
      return JSON.stringify(restoreBackup(String(args.from), String(args.to), { force: !!args.force }), null, 2)
    }

    case 'retention': {
      const dir = backupDirFor(config.dbPath, config.backup?.dir)
      return JSON.stringify(retentionReport(db, { owner: config.owner ?? null, backupDir: dir }), null, 2)
    }

    case 'backups': {
      const dir = backupDirFor(config.dbPath, config.backup?.dir)
      return JSON.stringify({ dir, backups: verifyBackups(dir) }, null, 2)
    }

    case 'embed': {
      const limit = args.limit && args.limit !== true ? Number(args.limit) : 200
      // \u8865\u5230\u6CA1\u6709\u53EF\u8865\u7684\u4E3A\u6B62\uFF08\u6700\u591A 10 \u8F6E\uFF09\uFF0C\u522B\u7559\u4E0B\u300C\u8DD1\u5B8C\u4E86\u5374\u6CA1\u8865\u5B8C\u300D
      let embedded = 0
      const step = Math.min(limit, 20)
      for (let round = 0; round < 10; round += 1) {
        const n = await embedMissing(db, { limit: step })
        embedded += n
        if (n < step) break
      }
      return JSON.stringify({ embedded, ...vectorStats(db, { owner: config.owner ?? null }) }, null, 2)
    }
    case 'status': {
      const st = statusOf({ db, config, sessionId })
      const cp = activeCheckpoint(db, sessionId, config.owner ?? null)
      return JSON.stringify({ ...st, checkpoint: cp, tools: TOOLS.map((t) => t.name) }, null, 2)
    }

    case 'sources':
      return JSON.stringify(sourcesOf(db, Number(args.id ?? 0), config.owner ?? null), null, 2)

    case 'history': {
      const items = history(db, {
        key: args.key && args.key !== true ? String(args.key) : null,
        scope: sessionId,
        owner: config.owner ?? null,
        limit: args.limit && args.limit !== true ? Number(args.limit) : 50,
      })
      if (!items.length) return '\u8FD8\u6CA1\u6709\u5386\u53F2\u3002'
      const day = (t) => new Date(Number(t)).toISOString().slice(0, 10)
      return items
        .map((i) => `#${i.id} ${day(i.from)} → ${i.to ? day(i.to) : '\u73B0\u5728'} [${i.status}]${i.key ? ` ${i.key}` : ''}\uFF1A${i.text}`)
        .join('\n')
    }

    case 'graph': {
      const out = args.out && args.out !== true ? String(args.out) : 'memory.html'
      writeFileSync(out, renderGraphHtml(buildGraph(db, { scope: sessionId, owner: config.owner ?? null }), { sessionId }), 'utf8')
      return `\u5199\u51FA ${out}`
    }

    case 'fold': {
      const out = args.out && args.out !== true ? String(args.out) : 'memory.md'
      foldToMarkdown(db, { sessionId, outPath: out, owner: config.owner ?? null })
      return `\u5199\u51FA ${out}`
    }

    case 'help':
    case '--help':
      return usage()

    default:
      throw new Error(`\u4E0D\u8BA4\u8BC6\u7684\u547D\u4EE4\uFF1A${cmd}\n${usage()}`)
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('cli.mjs')) {
  Promise.resolve()
    .then(() => runCli(process.argv.slice(2)))
    .then((out) => process.stdout.write(`${out}\n`))
    .catch((err) => {
      process.stderr.write(`${err?.message ?? err}\n`)
      process.exit(1)
    })
}
