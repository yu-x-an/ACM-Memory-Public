// \u5BBF\u4E3B\u65E0\u5173\u7684\u90A3\u4E00\u534A\uFF1A\u914D\u7F6E\u3001\u6CE8\u5165\u6587\u672C\u600E\u4E48\u62FC\u3001\u5DE5\u5177\u6709\u54EA\u4E9B\u3002
//
// \u8FD9\u91CC\u4E0D import \u4EFB\u4F55\u5BBF\u4E3B SDK\uFF0C\u4E5F\u4E0D\u8BA4\u8BC6 agent \u5BF9\u8C61 —— \u8C01\u6765\u8DD1\u90FD\u80FD\u7528\u3002
// \u5404\u5BBF\u4E3B\u5404\u81EA\u4E00\u8FB9\uFF1Adsh \u8D70 systemPrompt\uFF0Ccli \u6253\u5370\u5230 stdout\uFF0Cmcp \u8D70 resources/tools\u3002

import { homedir } from 'node:os'
import { join } from 'node:path'
import { feedback, gc, history, loadWeights, remember, search, forget, setAlias, sourceKindsFor, sourcesOf, stats } from './memory.mjs'
import { evolve, renderEvolution } from './evolve.mjs'
import { saveCheckpoint, activeCheckpoint } from './checkpoint.mjs'
import { pendingProposals } from './persona.mjs'
import { renderInjection } from './render.mjs'
import { normalize } from './text.mjs'
import { BACKUP_DEFAULT } from './backup.mjs'
import { claimMessage, completeMessage, inbox, sendMessage } from './deliberation.mjs'
import { EMBED_DEFAULT, hybridSearch, vectorStats } from './embed.mjs'
import { REDACT_DEFAULT, redact } from './redact.mjs'
import { principalFromConfig, requireAction } from './auth.mjs'
import { EVIDENCE_KINDS, acceptTask, assignTask, cancelTask, createTask, expireLeases, failTask, getTask, listTasks, rejectTask, renewTask, retryTask, returnTask, taskEvents, verifyTask } from './tasks.mjs'

export const CONFIG_DEFAULT = {
  dbPath: join(homedir(), '.dsh', 'acm-memory', 'memory.db'),
  diagPath: join(homedir(), '.dsh', 'acm-memory', 'diag.log'),
  personaFiles: [
    join(homedir(), '.dsh', 'AGENTS.md'),
    join(homedir(), '.dsh', 'whale-loli.md'),
  ],
  budget: 1400,
  recallLimit: 6,
  owner: null,          // null = single-user legacy partition, NEVER a wildcard
  project: null,        // narrows grants and task grouping; not a credential either
  auth: { mode: 'local' }, // 'local' = trust the machine; 'scoped' = require a live grant
  adminTools: false,    // acm_gc / acm_evolve are opt-in; a model must not delete data
  http: { enabled: false, token: null }, // host routes require an opt-in secret
  gc: { enabled: true, everyHours: 6, days: 120, checkpointDays: 30, proposalDays: 90, mailboxDays: 30 },
  backup: { ...BACKUP_DEFAULT },   // \u5E93\u662F\u552F\u4E00\u771F\u76F8\uFF0C\u5F97\u7559\u51E0\u5F20\u65E7\u5E95\u7247
  embed: { ...EMBED_DEFAULT },     // \u8BED\u4E49\u53EC\u56DE\uFF0C\u6A21\u578B\u672C\u4F53\u5728 lib/vendor \u91CC
  redact: { ...REDACT_DEFAULT },   // \u8FDB\u5E93\u4E4B\u524D\u5148\u6253\u7801
}

export function mergeConfig(overrides = {}) {
  const o = overrides ?? {}
  return {
    ...CONFIG_DEFAULT,
    ...o,
    gc: { ...CONFIG_DEFAULT.gc, ...(o.gc ?? {}) },
    http: { ...CONFIG_DEFAULT.http, ...(o.http ?? {}) },
    backup: { ...CONFIG_DEFAULT.backup, ...(o.backup ?? {}) },
    embed: { ...CONFIG_DEFAULT.embed, ...(o.embed ?? {}) },
    redact: { ...CONFIG_DEFAULT.redact, ...(o.redact ?? {}) },
  }
}

export function sessionIdFromEnv() {
  return process.env.ACM_SESSION || process.env.DSH_SESSION_ID || 'cli'
}

/**
 * \u6CA1\u95EE\u51FA\u4E1C\u897F\u7684\u65F6\u5019\u522B\u7A7A\u624B\uFF1A\u91CD\u8981 + \u65B0\u8FD1\u7684\u51E0\u6761\uFF0C\u7B97"\u6700\u8FD1\u60E6\u8BB0\u7684\u4E8B"\u3002
 * \u4E0D\u7136\u6362\u4E86\u8BDD\u9898\u5C31\u6574\u6BB5\u8BB0\u5FC6\u6D88\u5931\uFF0C\u7B49\u4E8E\u6CA1\u6709\u8BB0\u5FC6\u3002
 */
function recentMemories(db, scope, limit, owner = null) {
  if (limit <= 0) return []
  const rows = db
    .prepare(
      `select id, scope, kind, key, text, importance, created_at
         from acm_nodes
        where status = 'active' and (scope = 'global' or scope = ?)
          and owner IS ?
        order by importance desc, coalesce(last_used_at, created_at) desc
        limit ?`,
    )
    .all(scope, owner, limit)
  return rows.map((r) => ({
    id: Number(r.id),
    key: r.key ?? null,
    text: r.text,
    createdAt: Number(r.created_at),
    importance: Number(r.importance),
    score: 0,
    recent: true,
  }))
}

/**
 * \u6CE8\u5165\u6587\u672C\uFF1A\u4EFB\u52A1\u72B6\u6001\u5728\u524D\u3001\u8BB0\u5F97\u7684\u4E8B\u5728\u540E\uFF1B\u8D85\u9884\u7B97\u5148\u780D\u8BB0\u5FC6\uFF0C\u4E0D\u780D\u4EFB\u52A1\u72B6\u6001\u3002
 * \u552F\u4E00\u5165\u53E3 —— \u6240\u6709\u5BBF\u4E3B\u90FD\u4ECE\u8FD9\u91CC\u53D6\uFF0C\u522B\u5404\u62FC\u4E00\u5957\u3002
 */
export function buildInjectionText({ db, config, sessionId, query = '', recovering = false, now }) {
  return assembleInjection({ db, config, sessionId, query, recovering, now, hits: lexicalHits(db, config, sessionId, query) })
}

/**
 * Same injection, but the recall half is the hybrid ranker the `acm_search`
 * tool uses. Both engines share `assembleInjection`, so ranking and rendering
 * cannot drift apart; only the candidate ordering differs.
 *
 * Callers must tolerate a rejection-free, best-effort result: a missing model
 * or a broken runtime degrades to lexical recall instead of failing the turn.
 */
export async function buildInjectionTextAsync({ db, config, sessionId, query = '', recovering = false, now, engine = 'hybrid' }) {
  let hits = null
  if (engine === 'hybrid' && config.embed?.enabled !== false) {
    const q = normalize(query) || activeCheckpoint(db, sessionId, config.owner ?? null)?.goal || ''
    if (q) {
      try {
        hits = await hybridSearch(db, q, {
          scope: sessionId,
          owner: config.owner ?? null,
          limit: config.recallLimit,
          weight: config.embed?.weight,
          minCos: config.embed?.minCos,
        })
      } catch {
        hits = null // fall back to the lexical path below
      }
    } else {
      hits = []
    }
  }
  if (hits === null) hits = lexicalHits(db, config, sessionId, query)
  // The hybrid ranker has no "nothing matched" fallback, while the lexical path
  // offers the most important recent facts in that case. Without this, a query
  // that matched nothing produced an empty async result that replaced - and so
  // silently retracted - the block the synchronous seed had just published.
  if (!hits.length) hits = lexicalHits(db, config, sessionId, query)
  return assembleInjection({ db, config, sessionId, query, recovering, now, hits })
}

function lexicalHits(db, config, sessionId, query) {
  const cp = activeCheckpoint(db, sessionId, config.owner ?? null)
  const q = normalize(query) || cp?.goal || ''
  let hits = []
  try {
    hits = q ? search(db, { query: q, scope: sessionId, limit: config.recallLimit, owner: config.owner ?? null }) : []
  } catch {
    hits = []
  }
  if (!hits.length) {
    try {
      hits = recentMemories(db, sessionId, Math.min(3, config.recallLimit), config.owner ?? null)
    } catch {
      hits = []
    }
  }
  return hits
}

function assembleInjection({ db, config, sessionId, query, recovering, now, hits }) {
  loadWeights(db)
  const cp = activeCheckpoint(db, sessionId, config.owner ?? null)
  const warns = []
  try {
    for (const p of pendingProposals(db, config.owner ?? null).slice(0, 2)) {
      warns.push(`\u4EBA\u8BBE\u6587\u4EF6 ${p.path} \u6709\u672A\u5BA1\u6279\u6539\u52A8\uFF08${p.diff_summary}\uFF09`)
    }
  } catch {}
  // Provenance comes from the recorded source kind, in one query for the page.
  // `kind` is caller-supplied, so the renderer only ever prints a whitelisted,
  // authorship-neutral label - never "you said".
  let provenance = null
  try {
    provenance = sourceKindsFor(db, hits.map((h) => h.id), config.owner ?? null)
  } catch {}
  const text = renderInjection({
    checkpoint: cp,
    memories: hits,
    warns,
    recovering: recovering && !!cp,
    budget: config.budget,
    now,
    provenance,
  })
  return { text, checkpoint: cp, hits, recovering: recovering && !!cp }
}

const tool = (spec) => spec

/**
 * \u5DE5\u5177\u7684\u552F\u4E00\u5B9A\u4E49\u5904\u3002\u5BBF\u4E3B\u53EA\u8D1F\u8D23\u628A render/parameters \u7FFB\u6210\u81EA\u5DF1\u7684\u6837\u5B50\u3002
 * run(args, { db, config, sessionId }) → \u7ED3\u679C\u5BF9\u8C61
 */
/**
 * Declare this host's principal and require an action for it.
 *
 * In `local` mode the decision is `local-trust` and always passes - one trusted
 * machine, existing installs unchanged. In `scoped` mode the same call throws
 * unless a live grant names this principal and this action. Either way the answer
 * is a value, and the refusal message names the principal and the action.
 */
function requireActionFor(db, config, action, target = null, opts = {}) {
  const principal = principalFromConfig(config)
  return requireAction(db, principal, action, { mode: config.auth?.mode ?? 'local', target, ...opts })
}

/**
 * Authorize a transition against the task it actually touches.
 *
 * The caller's configured project decides where it may act; the task's own project
 * decides what it is acting on. Authorizing with the former alone let a grant
 * scoped to `beta` verify a task in `alpha`, because the task was then loaded by
 * owner only and nothing compared the two. So: a coarse check first (a store should
 * not tell a caller with no grant whether a key exists), then load, then a precise
 * check whose target is the task's project, and a plain refusal when the caller's
 * declared project is not the task's.
 *
 * `NULL` is not a wildcard and not "whatever the caller declared": a caller that
 * names a project may act only on tasks in that same project, and a task with no
 * project belongs to none of them. Conversely, a caller that declares no project is
 * governed by its grants alone - an untargeted grant still covers any target, which
 * is the grant's own documented semantics.
 *
 * `project` is not in the state machine's writable columns, so a task cannot change
 * project between this read and the transition that follows it.
 */
function taskGate(db, config, action, key) {
  // The pre-load check exists so a store does not tell a caller with no grant
  // whether a key exists. Which grant applies depends on the task's project, and a
  // caller that declares none has no target to check yet - so for that caller the
  // question is "any live grant for this action?", not "a grant for no target".
  // The latter refused a legitimate grant targeted at `alpha` before the precise
  // check below could run. A caller that does declare a project is
  // still refused cheaply when it holds nothing for that project.
  if (config.project != null) requireActionFor(db, config, action, config.project)
  else requireActionFor(db, config, action, null, { anyTarget: true })
  const task = getTask(db, { key, owner: config.owner ?? null })
  if (!task) return { refused: { ok: false, reason: 'not-found' } }
  if (config.project != null && String(task.project ?? '') !== String(config.project)) {
    // `project-mismatch` still answers a question about a task the caller may not
    // touch: "this key exists, in some other project". Pairing it with `not-found`
    // for an unknown key turns the pair into an existence oracle across projects, so
    // in `scoped` mode both answer `not-found`. On a trusted machine
    // (`local` mode) nobody is being probed and the diagnostic is worth keeping.
    if ((config.auth?.mode ?? 'local') === 'local') {
      return { refused: { ok: false, reason: 'project-mismatch', callerProject: config.project } }
    }
    return { refused: { ok: false, reason: 'not-found' } }
  }
  try {
    requireActionFor(db, config, action, task.project ?? null)
  } catch (err) {
    // A caller whose grants do not cover this task's project must not be able to tell
    // "no such task" from "not yours": in `scoped` mode both answer `not-found`
    //. A caller that *is* granted here keeps the precise refusal from the
    // state machine, which is information it is entitled to.
    if (err?.code === 'not-authorized' && err.decision?.reason === 'no-grant') {
      return { refused: { ok: false, reason: 'not-found' } }
    }
    throw err
  }
  return { task }
}

/** Evidence arrives as `kind:ref` lines from a model, or as objects from code. */
function parseEvidence(input) {
  if (Array.isArray(input)) return input
  if (typeof input !== 'string') return null
  const out = []
  for (const raw of input.split('\n')) {
    const line = normalize(raw)
    if (!line) continue
    const cut = line.indexOf(':')
    const kind = cut < 0 ? 'note' : line.slice(0, cut).trim()
    if (!EVIDENCE_KINDS.includes(kind)) { out.push({ kind: 'note', ref: line }); continue }
    const ref = line.slice(cut + 1).trim()
    if (ref) out.push({ kind, ref })
  }
  return out.length ? out : null
}

const taskRender = (v) => (v?.ok
  ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]`
  : `\u4E0D\u884C\uFF1A${v?.reason ?? 'unknown'}`)

export const TOOLS = [
  tool({
    name: 'acm_remember',
    description: '\u8BB0\u4E00\u6761\u4F1A\u957F\u671F\u6709\u7528\u7684\u4E8B\u5B9E/\u504F\u597D/\u51B3\u5B9A\u3002\u6B63\u6587\u7528\u82F1\u6587\u77ED\u8BED\uFF08\u4E13\u540D\u7167\u6284\u539F\u6587\uFF09\uFF0Csource \u586B\u7528\u6237\u539F\u8BDD\u5F53\u8BC1\u636E\u3002key \u662F\u552F\u4E00\u4E8B\u5B9E\u952E\uFF0C\u6BD4\u5982 master.bedtime\u3002',
    parameters: {
      text: { type: 'string', required: true, description: '\u8981\u8BB0\u7684\u5185\u5BB9\uFF1A\u82F1\u6587\u77ED\u8BED\uFF0C\u4E00\u53E5\u8BDD\u8BF4\u6E05\uFF1B\u4E13\u6709\u540D\u8BCD\u4FDD\u7559\u539F\u6587' },
      key: { type: 'string', required: false, description: '\u4E8B\u5B9E\u952E\uFF0C\u5982 master.bedtime\uFF1B\u540C\u4E00 key \u518D\u8BB0\u4F1A\u66FF\u6362\u65E7\u7684' },
      kind: { type: 'string', required: false, description: 'fact | preference | decision | event' },
      importance: { type: 'number', required: false, description: '0 \u5230 1\uFF0C\u9ED8\u8BA4 0.5' },
      scope: { type: 'string', required: false, description: 'global | session\uFF08\u9ED8\u8BA4 session\uFF09\uFF1Aglobal \u5BF9\u540C\u4E00 owner \u7684\u6240\u6709\u4F1A\u8BDD\u53EF\u89C1' },
      source: { type: 'string', required: false, description: '\u7528\u6237\u539F\u8BDD\uFF08\u4E2D\u6587\u7167\u6284\uFF09\uFF0C\u5F53\u8BC1\u636E\u7528' },
      zh: { type: 'string', required: false, description: '\u540C\u4E00\u4EF6\u4E8B\u7684\u4E2D\u6587\u8BF4\u6CD5\uFF0C\u68C0\u7D22\u65F6\u7528\uFF08\u5982 \u8001\u5927\u7761\u89C9\u65F6\u95F4\uFF09' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'number' }, superseded: { type: 'number' } } },
      render(_a, v) { return `\u8BB0\u597D\u4E86 #${v.id}${v.superseded ? `\uFF08\u65E7\u7684 #${v.superseded} \u5DF2\u5931\u6548\uFF09` : ''}` },
    },
    run(args, { db, config, sessionId }) {
      // \u539F\u8BDD\u91CC\u53EF\u80FD\u6709 key\u3001\u624B\u673A\u53F7\u3001\u5BC6\u7801——\u8FDB\u5E93\u4E4B\u524D\u5148\u6253\u7801\uFF0C\u8BC1\u636E\u4E5F\u522B\u7559\u539F\u6587
      const guard = (v) => (config.redact?.enabled ? redact(v, config.redact).text : v)
      // A scope the caller asked for is validated, not coerced. Silently turning
      // `globla` (or `shared`) into a private write is worse than refusing it: the
      // caller believes the fact was published, hands over a task that refers to
      // it, and the successor finds nothing. Omitting the argument still means
      // "this session", which is the old behaviour.
      const requested = args.scope
      if (requested !== undefined && requested !== null && requested !== 'global' && requested !== 'session') {
        throw new Error(`invalid scope: ${String(requested)} (expected "global" or "session")`)
      }
      // Publishing to the whole owner partition is the one write that reaches other
      // agents, so it is the one that asks for permission. In `local` mode the
      // answer is `local-trust` and nothing changes; in `scoped` mode it needs a
      // live grant, which is what a shared store would demand.
      if (requested === 'global') requireActionFor(db, config, 'memory:write-global', config.project ?? null)
      return remember(db, {
        scope: requested === 'global' ? 'global' : sessionId,
        text: guard(args.text),
        gloss: args.zh ? guard(args.zh) : null,
        key: args.key,
        kind: args.kind ?? 'fact',
        importance: args.importance,
        owner: config.owner ?? null,
        source: { sessionId, kind: 'manual', raw: guard(args.source ?? args.text) },
      })
    },
  }),

  tool({
    name: 'acm_search',
    description: '\u6309\u73B0\u5728\u7684\u95EE\u6CD5\u53BB\u7FFB\u8BB0\u5FC6\uFF0C\u8FD4\u56DE\u547D\u4E2D\u7684\u6761\u76EE\u548C\u5B83\u4ECE\u54EA\u513F\u6765\u3002',
    parameters: {
      query: { type: 'string', required: true, description: '\u67E5\u4EC0\u4E48' },
      limit: { type: 'number', required: false, description: '\u6700\u591A\u51E0\u6761\uFF0C\u9ED8\u8BA4 6' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'number' },
                text: { type: 'string' },
                key: { type: 'string' },
                score: { type: 'number' },
                source: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (!v.items.length) return '\u6CA1\u6709\u76F8\u5173\u7684\u3002'
        return v.items.map((i) => `#${i.id}${i.key ? ` ${i.key}` : ''}\uFF1A${i.text}${i.source ? `\uFF08\u6765\u81EA ${i.source}\uFF09` : ''}`).join('\n')
      },
    },
    async run(args, { db, config, sessionId }) {
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? config.recallLimit)))
      const owner = config.owner ?? null
      // \u6709\u5411\u91CF\u5C31\u6DF7\u5408\u6392\u5E8F\uFF1A\u5B57\u9762\u5206\u7167\u65E7\uFF0C\u8BED\u4E49\u5206\u53EA\u52A0\u4E0D\u6539
      let hits = search(db, { query: args.query, scope: sessionId, limit, owner })
      if (config.embed?.enabled) {
        try {
          hits = await hybridSearch(db, args.query, {
            scope: sessionId,
            owner,
            limit,
            weight: config.embed.weight,
            minCos: config.embed.minCos,
          })
        } catch {
          // \u6A21\u578B\u7F3A\u6587\u4EF6\u3001\u5185\u5B58\u4E0D\u591F\u90FD\u4E0D\u8BE5\u8BA9\u68C0\u7D22\u6574\u4E2A\u5931\u8D25\uFF0C\u9000\u56DE\u5B57\u9762
        }
      }
      return {
        items: hits.map((h) => {
          const src = sourcesOf(db, h.id, owner)[0]
          return {
            id: h.id,
            text: h.text,
            key: h.key ?? '',
            score: Math.round(h.score * 100) / 100,
            source: src ? `${src.kind}${src.seq != null ? ` seq ${src.seq}` : ''}` : '',
          }
        }),
      }
    },
  }),

  tool({
    name: 'acm_checkpoint',
    description: '\u5B58\u4E00\u6B21\u4EFB\u52A1\u68C0\u67E5\u70B9\u3002\u538B\u7F29\u6216\u6362\u4F1A\u8BDD\u4E4B\u540E\u9760\u5B83\u63A5\u7740\u5E72\uFF0C\u6240\u4EE5\u5199\u6E05\u76EE\u6807\u3001\u5DF2\u5B8C\u6210\u3001\u4E0B\u4E00\u6B65\u3002',
    parameters: {
      goal: { type: 'string', required: false, description: '\u73B0\u5728\u8FD9\u4EF6\u4E8B\u7684\u76EE\u6807' },
      done: { type: 'string', required: false, description: '\u5DF2\u7ECF\u505A\u5B8C\u7684' },
      next: { type: 'string', required: false, description: '\u4E0B\u4E00\u6B65\u8BE5\u5E72\u4EC0\u4E48' },
      files: { type: 'string', required: false, description: '\u52A8\u8FC7/\u8981\u52A8\u7684\u6587\u4EF6\uFF0C\u9017\u53F7\u9694\u5F00' },
      decisions: { type: 'string', required: false, description: '\u5DF2\u7ECF\u5B9A\u4E0B\u6765\u7684\u505A\u6CD5' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'number' } } },
      render(_a, v) { return `\u68C0\u67E5\u70B9 #${v.id} \u5B58\u597D\u4E86` },
    },
    run(args, { db, config, sessionId }) {
      // Only declared fields may come from the caller. Spreading `args` after
      // the trusted sessionId/owner let a tool caller write a checkpoint into
      // another owner's partition, which that owner then sees in its prompt.
      return {
        id: saveCheckpoint(db, {
          sessionId,
          owner: config.owner ?? null,
          goal: args.goal,
          done: args.done,
          next: args.next,
          files: args.files,
          decisions: args.decisions,
          guard: (v) => (config.redact?.enabled ? redact(v, config.redact).text : v),
        }),
      }
    },
  }),

  tool({
    name: 'acm_forget',
    description: '\u8BA9\u67D0\u6761\u8BB0\u5FC6\u5931\u6548\u3002\u4E0D\u5220\u884C\uFF0C\u53EA\u6807\u5931\u6548 —— \u8FD9\u6837\u8FD8\u67E5\u5F97\u5230\u300C\u5B83\u66FE\u7ECF\u662F\u8FD9\u4E48\u8BB0\u7684\u300D\u3002',
    parameters: { id: { type: 'number', required: true, description: '\u8BB0\u5FC6\u7F16\u53F7' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render(_a, v) { return v.ok ? '\u5FD8\u6389\u4E86' : '\u6CA1\u8FD9\u6761' },
    },
    run(args, { db, config }) {
      return { ok: forget(db, Number(args.id), Date.now(), config.owner ?? null) }
    },
  }),

  tool({
    name: 'acm_alias',
    description: '\u58F0\u660E\u4E24\u4E2A\u53EB\u6CD5\u6307\u7684\u662F\u540C\u4E00\u4E2A\u4E1C\u897F\uFF08\u4E2D\u6587\u53E3\u8BED ↔ \u82F1\u6587\u8282\u70B9\u6B63\u6587\uFF09\uFF0C\u4EE5\u540E\u67E5\u54EA\u4E2A\u90FD\u80FD\u627E\u5230\u3002',
    parameters: {
      alias: { type: 'string', required: true, description: '\u522B\u540D\uFF0C\u6BD4\u5982 \u8001\u5927' },
      canonical: { type: 'string', required: true, description: '\u6B63\u540D\uFF0C\u6BD4\u5982 master' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, alias: { type: 'string' }, canonical: { type: 'string' } } },
      render(_a, v) { return v.ok ? `${v.alias} = ${v.canonical}` : '\u6CA1\u8BB0\uFF08\u4E24\u4E2A\u540D\u5B57\u4E00\u6837\u6216\u4E3A\u7A7A\uFF09' },
    },
    run(args, { db, config }) {
      const r = setAlias(db, args.alias, args.canonical, config.owner ?? null)
      return { ok: !!r.ok, alias: r.alias ?? '', canonical: r.canonical ?? '' }
    },
  }),

  tool({
    name: 'acm_history',
    description: '\u770B\u67D0\u4E2A\u4E8B\u5B9E\u952E\u7684\u65F6\u95F4\u8F74\uFF1A\u4EE5\u524D\u662F\u4EC0\u4E48\u3001\u4EC0\u4E48\u65F6\u5019\u6539\u7684\u3001\u73B0\u5728\u662F\u4EC0\u4E48\u3002\u5931\u6548\u7684\u4E5F\u7559\u7740\u3002',
    parameters: {
      key: { type: 'string', required: false, description: '\u4E8B\u5B9E\u952E\uFF0C\u5982 master.bedtime\uFF1B\u4E0D\u586B\u5C31\u662F\u5168\u90E8' },
      limit: { type: 'number', required: false, description: '\u6700\u591A\u51E0\u6761\uFF0C\u9ED8\u8BA4 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'number' }, text: { type: 'string' }, status: { type: 'string' },
                from: { type: 'number' }, to: { type: 'number' }, key: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (!v.items.length) return '\u8FD9\u6761\u8FD8\u6CA1\u5386\u53F2\u3002'
        const day = (t) => new Date(Number(t)).toISOString().slice(0, 10)
        return v.items
          .map((i) => `#${i.id} ${day(i.from)} → ${i.to ? day(i.to) : '\u73B0\u5728'} [${i.status}] ${i.text}`)
          .join('\n')
      },
    },
    run(args, { db, config, sessionId }) {
      const items = history(db, {
        key: args.key ?? null,
        scope: sessionId,
        owner: config.owner ?? null,
        limit: Math.min(50, Math.max(1, Number(args.limit ?? 20))),
      })
      return { items }
    },
  }),

  tool({
    name: 'acm_feedback',
    description: '\u7ED9\u4E00\u6761\u8BB0\u5FC6\u6295\u7968\uFF1Auseful = \u8FD9\u6761\u7528\u5BF9\u4E86\uFF0Cwrong = \u8BB0\u9519\u4E86\u6216\u7B54\u504F\u4E86\u3002\u6295\u9519\u591A\u4E86\u5B83\u4F1A\u81EA\u52A8\u5931\u6548\u3002',
    parameters: {
      id: { type: 'number', required: true, description: '\u8BB0\u5FC6\u7F16\u53F7' },
      verdict: { type: 'string', required: true, description: 'useful | wrong' },
      note: { type: 'string', required: false, description: '\u4E3A\u4EC0\u4E48\uFF0C\u4E00\u53E5\u8BDD' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, importance: { type: 'number' }, retired: { type: 'boolean' }, reason: { type: 'string' } },
      },
      render(_a, v) {
        if (!v.ok) return `\u6CA1\u8BB0\u4E0A\uFF1A${v.reason ?? '\u4E0D\u77E5\u9053'}#${''}`
        return `\u8BB0\u4E0B\u4E86 · \u91CD\u8981\u5EA6 ${Number(v.importance).toFixed(2)}${v.retired ? ' · \u5DF2\u7ECF\u5931\u6548' : ''}`
      },
    },
    run(args, { db, config }) {
      return feedback(db, Number(args.id), String(args.verdict), { note: args.note ?? null, owner: config.owner ?? null })
    },
  }),

  tool({
    name: 'acm_evolve',
    description: '\u8DD1\u4E00\u8F6E\u8FDB\u5316\uFF1A\u5408\u5E76\u8FD1\u91CD\u590D\u3001\u6309 feedback \u8C03\u68C0\u7D22\u6743\u91CD\uFF0C\u51FA\u4E00\u4EFD\u62A5\u544A\u3002dryRun \u53EA\u7B97\u4E0D\u6539\u3002',
    parameters: { dryRun: { type: 'boolean', required: false, description: '\u53EA\u7B97\u62A5\u544A\uFF0C\u4E0D\u6539\u5E93' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          merged: { type: 'number' },
          tuned: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render(_a, v) { return v.text },
    },
    run(args, { db, config }) {
      if (config.owner != null) throw new Error('acm_evolve requires trusted single-user administrative mode')
      if (config.adminTools !== true) throw new Error('acm_evolve is disabled; set adminTools = true to allow it')
      const r = evolve(db, { dryRun: !!args.dryRun })
      return { merged: r.merged, tuned: r.tuned, dryRun: r.dryRun, text: renderEvolution(r) }
    },
  }),

  tool({
    name: 'acm_gc',
    description: '\u6E05\u4E00\u6B21\u5E93\uFF1A\u5220\u6389\u8FC7\u4E86\u4FDD\u7559\u671F\u7684\u5931\u6548\u8BB0\u5FC6\u3001\u6CA1\u7528\u7684\u539F\u8BDD\u3001\u65E7\u68C0\u67E5\u70B9\u3002dryRun \u53EA\u62A5\u6570\u91CF\u4E0D\u5220\u3002',
    parameters: {
      days: { type: 'number', required: false, description: '\u5931\u6548\u8BB0\u5FC6\u7559\u51E0\u5929\uFF0C\u9ED8\u8BA4 120' },
      dryRun: { type: 'boolean', required: false, description: '\u53EA\u62A5\u6570\u91CF\uFF0C\u4E0D\u771F\u5220' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean' }, nodes: { type: 'number' }, sources: { type: 'number' },
          edges: { type: 'number' }, checkpoints: { type: 'number' }, receipts: { type: 'number' }, proposals: { type: 'number' },
        },
      },
      render(_a, v) {
        return `${v.dryRun ? '\u4F1A\u5220' : '\u5220\u4E86'} \u8282\u70B9 ${v.nodes}\u3001\u539F\u8BDD ${v.sources}\u3001\u8FB9 ${v.edges}\u3001\u68C0\u67E5\u70B9 ${v.checkpoints}\u3001\u56DE\u6267 ${v.receipts}\u3001\u63D0\u6848 ${v.proposals}`
      },
    },
    run(args, { db, config }) {
      if (config.owner != null) throw new Error('acm_gc requires trusted single-user administrative mode')
      // Destructive maintenance is opt-in: a prompt-injected model must not be
      // able to trigger deletion through the tool surface. The CLI enables it
      // explicitly because the operator typed the command.
      if (config.adminTools !== true) throw new Error('acm_gc is disabled; set adminTools = true to allow it')
      return gc(db, {
        days: Number(args.days ?? config.gc.days),
        checkpointDays: config.gc.checkpointDays,
        proposalDays: config.gc.proposalDays,
        mailboxDays: config.gc.mailboxDays,
        owner: config.owner ?? null,
        all: args.all === true,
        dryRun: !!args.dryRun,
      })
    },
  }),
  tool({
    name: 'acm_send',
    description: '\u7ED9\u53E6\u4E00\u4E2A agent \u6295\u9012\u4E00\u6761\u4EFB\u52A1。\u5BF9\u65B9\u4E0B\u6B21\u4F1A\u8BDD\u7528 acm_inbox \u770B\u5230，\u8BA4\u9886\u540E\u53EA\u6709\u5B83\u80FD\u5B8C\u6210。',
    parameters: {
      to: { type: 'string', required: true, description: '\u6536\u4EF6 agent \u540D\u5B57' },
      body: { type: 'string', required: true, description: '\u8981\u4EA4\u529E\u7684\u4E8B' },
      kind: { type: 'string', required: false, description: 'notice | proposal | review，\u9ED8\u8BA4 notice' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'number' }, ok: { type: 'boolean' } } },
      render(_a, v) {
        return v.ok ? `\u5DF2\u6295\u9012 #${v.id}` : '\u6295\u9012\u5931\u8D25'
      },
    },
    run(args, { db, config }) {
      return sendMessage(db, {
        to: args.to,
        from: config.agent ?? 'agent',
        body: args.body,
        kind: args.kind ?? 'notice',
        owner: config.owner ?? null,
      })
    },
  }),

  tool({
    name: 'acm_inbox',
    description: '\u770B\u81EA\u5DF1\u6536\u5230\u7684、\u8FD8\u6CA1\u5B8C\u6210\u7684\u4EFB\u52A1。',
    parameters: {
      state: { type: 'string', required: false, description: 'pending | claimed | done，\u9ED8\u8BA4\u770B\u672A\u5B8C\u6210' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { items: { type: 'array' } } },
      render(_a, v) {
        if (!v.items.length) return '\u6CA1\u6709\u5F85\u529E'
        return v.items.map((m) => `#${m.id} [${m.state}] ${m.sender}: ${m.body}`).join('\n')
      },
    },
    run(args, { db, config }) {
      const items = inbox(db, { agent: config.agent ?? 'agent', state: args.state ?? null, owner: config.owner ?? null })
      return { items }
    },
  }),

  tool({
    name: 'acm_claim',
    description: '\u8BA4\u9886\u4E00\u6761\u4EFB\u52A1。\u4E00\u6761\u4EFB\u52A1\u53EA\u80FD\u88AB\u4E00\u4E2A agent \u8BA4\u9886。',
    parameters: { id: { type: 'number', required: true, description: '\u6D88\u606F id' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? '\u5DF2\u8BA4\u9886' : `\u8BA4\u9886\u5931\u8D25：${v.reason ?? ''}`
      },
    },
    run(args, { db, config }) {
      requireActionFor(db, config, 'mailbox:claim', config.project ?? null)
      return claimMessage(db, { id: args.id, agent: config.agent ?? 'agent', owner: config.owner ?? null })
    },
  }),

  tool({
    name: 'acm_complete',
    description: '\u5B8C\u6210\u81EA\u5DF1\u8BA4\u9886\u7684\u4EFB\u52A1。',
    parameters: { id: { type: 'number', required: true, description: '\u6D88\u606F id' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? '\u5DF2\u5B8C\u6210' : `\u5B8C\u6210\u5931\u8D25：${v.reason ?? ''}`
      },
    },
    run(args, { db, config }) {
      requireActionFor(db, config, 'mailbox:complete', config.project ?? null)
      return completeMessage(db, { id: args.id, agent: config.agent ?? 'agent', owner: config.owner ?? null })
    },
  }),


  tool({
    name: 'acm_task_create',
    description: '\u5EFA\u4E00\u4E2A\u53EF\u8FFD\u8E2A\u7684\u4EFB\u52A1\uFF1A\u6709\u72B6\u6001\u3001\u6709\u5F52\u5C5E\u3001\u80FD\u88AB\u522B\u4EBA\u9A8C\u6536\u3002\u8FD4\u56DE\u4EFB\u52A1 key\u3002',
    parameters: {
      title: { type: 'string', required: true, description: '\u4E00\u53E5\u8BDD\u8BF4\u6E05\u8981\u505A\u4EC0\u4E48' },
      detail: { type: 'string', required: false, description: '\u7EC6\u8282\u3001\u9A8C\u6536\u6807\u51C6' },
      assignee: { type: 'string', required: false, description: '\u6307\u5B9A\u6267\u884C\u8005\uFF1B\u4E0D\u7ED9\u5C31\u662F\u5F85\u9886\u53D6' },
      dependsOn: { type: 'string', required: false, description: '\u4F9D\u8D56\u7684\u4EFB\u52A1 key\uFF0C\u9017\u53F7\u5206\u9694' },
      priority: { type: 'number', required: false, description: '\u8D8A\u5927\u8D8A\u5148\u505A\uFF0C\u9ED8\u8BA4 0' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { key: { type: 'string' }, state: { type: 'string' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      requireActionFor(db, config, 'task:create', config.project ?? null)
      const deps = typeof args.dependsOn === 'string'
        ? args.dependsOn.split(',').map((x) => x.trim()).filter(Boolean)
        : []
      return createTask(db, {
        title: args.title,
        detail: args.detail ?? null,
        assignee: args.assignee ?? null,
        dependsOn: deps,
        priority: args.priority,
        owner: config.owner ?? null,
        project: config.project ?? null,
        createdBy: config.agent ?? 'agent',
      })
    },
  }),

  tool({
    name: 'acm_task_list',
    description: '\u5217\u51FA\u8FD9\u4E2A\u5206\u533A\u91CC\u7684\u4EFB\u52A1\u3002',
    parameters: {
      state: { type: 'string', required: false, description: 'open | assigned | running | returned | verified | failed | cancelled | expired' },
      assignee: { type: 'string', required: false, description: '\u53EA\u770B\u67D0\u4E2A\u6267\u884C\u8005\u7684' },
      limit: { type: 'number', required: false, description: '\u6700\u591A\u51E0\u6761\uFF0C\u9ED8\u8BA4 20' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { items: { type: 'array' } } },
      render(_a, v) {
        if (!v.items?.length) return '\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u4EFB\u52A1'
        return v.items.map((t) => `${t.key} [${t.state}] ${t.title}${t.assignee ? ` @${t.assignee}` : ''}`).join('\n')
      },
    },
    run(args, { db, config }) {
      return {
        items: listTasks(db, {
          owner: config.owner ?? null,
          state: args.state ?? null,
          assignee: args.assignee ?? null,
          limit: args.limit,
        }),
      }
    },
  }),

  tool({
    name: 'acm_task_get',
    description: '\u770B\u4E00\u4E2A\u4EFB\u52A1\u7684\u5F53\u524D\u72B6\u6001\u548C\u5B83\u7684\u5168\u90E8\u6D41\u8F6C\u8BB0\u5F55\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, events: { type: 'array' }, reason: { type: 'string' } } },
      render(_a, v) {
        if (!v.ok) return `\u6CA1\u6709\u8FD9\u4E2A\u4EFB\u52A1\uFF1A${v.reason ?? ''}`
        const t = v.task
        const head = `${t.key} [${t.state}] ${t.title}`
        const who = `\u8D1F\u8D23\u4EBA\uFF1A${t.assignee ?? '-'}\uFF1B\u5C1D\u8BD5\uFF1A${t.attempts}/${t.maxAttempts}\uFF1B\u8BC1\u636E\uFF1A${t.evidence?.length ?? 0} \u6761`
        const trail = (v.events ?? []).map((e) => `  ${e.action}: ${e.from ?? '-'} -> ${e.to} by ${e.actor}`)
        return [head, who, ...trail].join('\n')
      },
    },
    run(args, { db, config }) {
      const task = getTask(db, { key: args.key, owner: config.owner ?? null })
      if (!task) return { ok: false, reason: 'not-found' }
      return { ok: true, task, events: taskEvents(db, { key: args.key, owner: config.owner ?? null }) }
    },
  }),

  tool({
    name: 'acm_task_assign',
    description: '\u628A\u4EFB\u52A1\u6D3E\u7ED9\u4E00\u4E2A\u6267\u884C\u8005\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      assignee: { type: 'string', required: true, description: '\u6267\u884C\u8005\u540D\u5B57' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:assign', args.key)
      if (gate.refused) return gate.refused
      return assignTask(db, { key: args.key, owner: config.owner ?? null, assignee: args.assignee, actor: config.agent ?? 'agent' })
    },
  }),

  tool({
    name: 'acm_task_accept',
    description: '\u5F00\u59CB\u4E00\u4E2A\u6D3E\u7ED9\u81EA\u5DF1\u7684\u4EFB\u52A1\uFF0C\u5E76\u5F00\u4E00\u4E2A\u79DF\u7EA6\u3002\u79DF\u7EA6\u8FC7\u671F\u540E\u4EFB\u52A1\u4F1A\u53D8\u6210 expired\uFF0C\u522B\u4EBA\u53EF\u4EE5\u91CD\u8BD5\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      leaseMs: { type: 'number', required: false, description: '\u79DF\u7EA6\u65F6\u957F\u6BEB\u79D2\uFF0C\u9ED8\u8BA4 15 \u5206\u949F' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' }, dependency: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:accept', args.key)
      if (gate.refused) return gate.refused
      return acceptTask(db, { key: args.key, owner: config.owner ?? null, actor: config.agent ?? 'agent', leaseMs: args.leaseMs })
    },
  }),

  tool({
    name: 'acm_task_renew',
    description: '\u7EED\u4E00\u4E2A\u81EA\u5DF1\u6B63\u5728\u505A\u7684\u4EFB\u52A1\u7684\u79DF\u7EA6\u3002\u957F\u4EFB\u52A1\u5FC5\u987B\u81EA\u5DF1\u7EED\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u5EF6\u957F\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      leaseMs: { type: 'number', required: false, description: '\u4ECE\u73B0\u5728\u8D77\u518D\u7ED9\u591A\u4E45\uFF08\u6BEB\u79D2\uFF0C1 \u79D2\u5230 24 \u5C0F\u65F6\uFF09\uFF0C\u9ED8\u8BA4 15 \u5206\u949F' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok
          ? `\u7EED\u4E0A\u4E86 ${v.task?.key ?? ''}\uFF0C\u5230 ${new Date(Number(v.task?.leaseUntil ?? 0)).toISOString()}`
          : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:renew', args.key)
      if (gate.refused) return gate.refused
      return renewTask(db, { key: args.key, owner: config.owner ?? null, actor: config.agent ?? 'agent', leaseMs: args.leaseMs })
    },
  }),

  tool({
    name: 'acm_task_return',
    description: '\u4EA4\u56DE\u4EFB\u52A1\uFF0C\u5FC5\u987B\u5E26\u7ED3\u679C\u548C\u8BC1\u636E\u3002\u8BC1\u636E\u6BCF\u884C\u4E00\u6761 kind:ref\uFF0Ckind \u53D6 commit/test/file/command/note/url\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      result: { type: 'string', required: true, description: '\u505A\u5B8C\u4E86\u4EC0\u4E48' },
      evidence: { type: 'string', required: true, description: '\u8BC1\u636E\uFF0C\u6BCF\u884C\u4E00\u6761\uFF0C\u4F8B\u5982 test:npm run test:all' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:return', args.key)
      if (gate.refused) return gate.refused
      return returnTask(db, {
        key: args.key,
        owner: config.owner ?? null,
        actor: config.agent ?? 'agent',
        result: args.result,
        evidence: parseEvidence(args.evidence),
      })
    },
  }),

  tool({
    name: 'acm_task_verify',
    description: '\u9A8C\u6536\u522B\u4EBA\u4EA4\u56DE\u7684\u4EFB\u52A1\u3002\u4F5C\u8005\u4E0D\u80FD\u9A8C\u6536\u81EA\u5DF1\u7684\uFF0C\u8FD9\u662F\u6545\u610F\u7684\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      note: { type: 'string', required: false, description: '\u9A8C\u6536\u5907\u6CE8' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:verify', args.key)
      if (gate.refused) return gate.refused
      return verifyTask(db, { key: args.key, owner: config.owner ?? null, actor: config.agent ?? 'agent', note: args.note ?? null })
    },
  }),

  tool({
    name: 'acm_task_reject',
    description: '\u9000\u56DE\u522B\u4EBA\u4EA4\u56DE\u7684\u4EFB\u52A1\uFF0C\u5FC5\u987B\u5199\u7406\u7531\u3002\u8FD8\u6709\u6B21\u6570\u5C31\u56DE\u5230\u53EF\u6267\u884C\uFF0C\u6B21\u6570\u7528\u5C3D\u5C31\u53D8\u6210\u5931\u8D25\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      reason: { type: 'string', required: true, description: '\u4E3A\u4EC0\u4E48\u4E0D\u884C\uFF0C\u4E0B\u4E00\u4E2A\u4EBA\u8981\u80FD\u7167\u7740\u6539' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u9000\u56DE\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:reject', args.key)
      if (gate.refused) return gate.refused
      return rejectTask(db, { key: args.key, owner: config.owner ?? null, actor: config.agent ?? 'agent', reason: args.reason })
    },
  }),

  tool({
    name: 'acm_task_fail',
    description: '\u628A\u4EFB\u52A1\u6807\u8BB0\u5931\u8D25\uFF0C\u5FC5\u987B\u5199\u539F\u56E0\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      reason: { type: 'string', required: true, description: '\u4E3A\u4EC0\u4E48\u505A\u4E0D\u4E0B\u53BB' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:fail', args.key)
      if (gate.refused) return gate.refused
      return failTask(db, { key: args.key, owner: config.owner ?? null, actor: config.agent ?? 'agent', reason: args.reason })
    },
  }),

  tool({
    name: 'acm_task_cancel',
    description: '\u53D6\u6D88\u4E00\u4E2A\u8FD8\u6CA1\u5F00\u59CB\u7684\u4EFB\u52A1\u3002\u5DF2\u7ECF\u5F00\u59CB\u7684\u4EFB\u52A1\u8981\u8D70\u5931\u8D25\u6216\u4EA4\u56DE\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      reason: { type: 'string', required: false, description: '\u53D6\u6D88\u539F\u56E0' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:cancel', args.key)
      if (gate.refused) return gate.refused
      return cancelTask(db, { key: args.key, owner: config.owner ?? null, actor: config.agent ?? 'agent', reason: args.reason ?? null })
    },
  }),

  tool({
    name: 'acm_task_retry',
    description: '\u628A\u8FC7\u671F\u6216\u5931\u8D25\u7684\u4EFB\u52A1\u653E\u56DE\u53EF\u9886\u53D6\u72B6\u6001\u3002\u6B21\u6570\u7528\u5C3D\u5C31\u4F1A\u62D2\u7EDD\u3002',
    parameters: {
      key: { type: 'string', required: true, description: '\u4EFB\u52A1 key' },
      assignee: { type: 'string', required: false, description: '\u6362\u4E2A\u4EBA\u505A' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, task: { type: 'object' }, reason: { type: 'string' } } },
      render(_a, v) {
        return v.ok ? `\u597D\u4E86 ${v.task?.key ?? ''} [${v.task?.state ?? ''}]` : `\u4E0D\u884C\uFF1A${v.reason ?? 'unknown'}`
      },
    },
    run(args, { db, config }) {
      const gate = taskGate(db, config, 'task:retry', args.key)
      if (gate.refused) return gate.refused
      return retryTask(db, { key: args.key, owner: config.owner ?? null, actor: config.agent ?? 'agent', assignee: args.assignee ?? null })
    },
  }),

]

export function toolByName(name) {
  return TOOLS.find((t) => t.name === name) ?? null
}

export function statusOf({ db, config, sessionId, local = true }) {
  let weights = null
  let evolutions = 0
  let vectors = null
  try {
    weights = loadWeights(db)
    evolutions = Number(db.prepare('select count(*) c from acm_evolutions').get()?.c ?? 0)
    vectors = vectorStats(db, { owner: config.owner ?? null })
  } catch {}
  // `local: false` is for surfaces that hand the payload to a model (MCP): local
  // filesystem paths and partition names are not needed to answer "how much do
  // you remember", and they leak operator layout.
  const configView = local
    ? { dbPath: config.dbPath, budget: config.budget, personaFiles: config.personaFiles, owner: config.owner ?? null, embed: config.embed ?? null, redact: config.redact?.enabled ?? null }
    : { budget: config.budget, embedEnabled: config.embed?.enabled === true, redactEnabled: config.redact?.enabled === true }
  return {
    config: configView,
    sessionId,
    stats: stats(db, null, config.owner ?? null),
    weights,
    evolutions,
    vectors,
    proposals: pendingProposals(db, config.owner ?? null),
  }
}
