// SDK\uFF1A\u7ED9\u522B\u7684\u7A0B\u5E8F\u7528\u7684\u95E8\u9762\u3002\u4E0D\u8BA4\u5BBF\u4E3B\uFF0C\u53EA\u8BA4\u4E00\u4E2A\u5E93\u8DEF\u5F84\u548C\u4F1A\u8BDD id\u3002
//
//   import { openMemory } from 'dsh-acm-memory/lib/sdk.mjs'
//   const acm = openMemory({ dbPath: 'C:/x/memory.db', sessionId: 'work' })
//   acm.remember({ text: 'master prefers short replies', key: 'master.style' })
//   acm.inject({ query: '\u4ED6\u559C\u6B22\u4EC0\u4E48\u6837\u7684\u56DE\u590D' })   // \u76F4\u63A5\u62FC\u8FDB system prompt
//   acm.checkpoint({ goal: '...', next: '...' })
//   acm.graphHtml()                               // \u5B58\u6210 html \u770B

import { openDb } from './db.mjs'
import { backupDirFor, backupIfDue, listBackups, restoreBackup, verifyBackups } from './backup.mjs'
import { conflicts, feedback, feedbackStats, gc, history, loadWeights, mergeDuplicates, provenance, purge, purgeRange, quarantine, releaseQuarantine, remember, resolveConflict, search, forget, setAlias, aliasesOf, sourcesOf, stats, suspects, trustEvents, verifyPurged, weightsNow } from './memory.mjs'
import { evolve, evolutionLog, renderEvolution } from './evolve.mjs'
import { activeCheckpoint, markDelivered, receiptState, saveCheckpoint, saveOrUpdateAuto, scanCompactions, verifyRecovery } from './checkpoint.mjs'
import { decideProposal, loadPersona, pendingProposals } from './persona.mjs'
import { foldToMarkdown } from './fold.mjs'
import { redact } from './redact.mjs'
import { buildGraph, renderGraphHtml } from './graph.mjs'
import { buildInjectionText, mergeConfig, statusOf } from './core.mjs'
import { retentionReport } from './retention.mjs'
import { buildHandoff, verifyHandoff } from './handoff.mjs'
import { argue, claimMessage, completeMessage, decide as decideRecord, decisionView, decisions as listDecisions, inbox, openDecision, sendMessage } from './deliberation.mjs'
import { embedMissing, embedText, hybridSearch, vectorStats } from './embed.mjs'
import { acceptTask, assignTask, cancelTask, createTask, expireLeases, failTask, getTask, listTasks, rejectTask, renewTask, retryTask, returnTask, taskEvents, verifyTask } from './tasks.mjs'

export function openMemory({ dbPath, sessionId = 'default', config = {} } = {}) {
  const cfg = mergeConfig({ ...config, ...(dbPath ? { dbPath } : {}) })
  const db = openDb(cfg.dbPath)
  try { backupIfDue(db, cfg.dbPath, cfg.backup) } catch {}
  const sid = sessionId
  // The owner boundary is a closure constant. It used to be read from the
  // published `config` object on every call, so a holder of an owner-bound
  // handle could assign `handle.config.owner = "someone-else"` and then read or
  // delete that partition through the same handle.
  const owner = cfg.owner ?? null
  // The actor is fixed for the life of the handle as well: a task recorded as
  // created by `sdk` must not be creatable as `someone-else` by passing a field.
  const actor = cfg.agent ?? 'sdk'
  // A frozen deep copy: callers may inspect the configuration but cannot steer
  // the handle by mutating it.
  const publicConfig = Object.freeze(JSON.parse(JSON.stringify(cfg)))
  // Same redaction the tool and distillation paths apply: secrets written
  // through the SDK must not land in the database in clear text.
  const guard = (v) => (cfg.redact?.enabled ? redact(v, cfg.redact).text : v)

  const acm = {
    config: publicConfig,
    sessionId: sid,

    remember(input) {
      const { source: rawSource, ...rest } = input
      return remember(db, {
        ...rest,
        text: guard(input.text),
        gloss: input.gloss ? guard(input.gloss) : input.gloss,
        scope: input.scope ?? sid,
        owner: owner,
        source: { sessionId: sid, kind: 'sdk', raw: guard(rawSource ?? input.text) },
      })
    },

    search(query, { limit = cfg.recallLimit } = {}) {
      return search(db, { query, scope: sid, limit, owner: owner })
    },

    // \u5E26\u8BED\u4E49\u7684\u68C0\u7D22\uFF1A\u8981 await\uFF08\u6A21\u578B\u9996\u6B21\u52A0\u8F7D ~0.4s\uFF09
    async searchAsync(query, { limit = cfg.recallLimit } = {}) {
      if (!cfg.embed?.enabled) return search(db, { query, scope: sid, limit, owner })
      return hybridSearch(db, query, { scope: sid, limit, owner, weight: cfg.embed.weight, minCos: cfg.embed.minCos })
    },

    embedText(text) { return embedText(text) },
    embedMissing(opts = {}) { return embedMissing(db, opts) },
    vectorStats() { return vectorStats(db, { owner: owner }) },

    forget(id, at) { return forget(db, id, at, owner) },

    /** Physically delete one memory in this partition. Irreversible. */
    purge(id) { return purge(db, id, { owner: owner }) },
    /** Physically delete every memory created before a cutoff in this partition. */
    purgeRange(opts = {}) { return purgeRange(db, { ...opts, owner: owner }) },
    /** Row counts that still reference an id after a purge, as evidence. */
    verifyPurged(id) { return verifyPurged(db, id) },

    history(opts = {}) {
      return history(db, { ...opts, scope: sid, owner: owner })
    },

    alias(alias, canonical) { return setAlias(db, alias, canonical, owner) },
    aliases(term) { return aliasesOf(db, term, owner) },
    sources(nodeId) { return sourcesOf(db, nodeId, owner) },

    /** Fact keys that changed more than once, newest first. */
    conflicts(opts = {}) { return conflicts(db, { ...opts, owner: owner }) },
    /** Pin one revision as the active answer and close the others. */
    resolveConflict(id) { return resolveConflict(db, { id, owner: owner }) },

    /** Node, raw evidence, votes and revision chain for one memory. */
    provenance(id) { return provenance(db, id, { owner: owner }) },

    checkpoint(input = {}) {
      // Declared fields only: spreading the caller object let it carry its own
      // owner or sessionId into the trusted checkpoint record.
      const { goal, done, next, files, decisions, turn } = input
      return { id: saveCheckpoint(db, { sessionId: sid, owner: owner, goal, done, next, files, decisions, turn, guard }) }
    },
    autoCheckpoint(goal, turn = null) {
      return saveOrUpdateAuto(db, { sessionId: sid, goal, turn, owner: owner, guard })
    },
    checkpointNow() { return activeCheckpoint(db, sid, owner) },
    markDelivered(checkpointId, note = 'sdk') { return markDelivered(db, checkpointId, sid, note, owner) },
    receipts(checkpointId) { return receiptState(db, checkpointId, owner) },
    /** Verify the recovery ledger for this session (exactly-once delivery). */
    verifyRecovery() { return verifyRecovery(db, { sessionId: sid, owner: owner }) },

    /** \u538B\u7F29\u68C0\u6D4B\uFF1A\u628A\u5BBF\u4E3B\u7684\u4E8B\u4EF6\u65E5\u5FD7\u4E22\u8FDB\u6765\uFF0C\u8FD4\u56DE\u6210\u529F\u538B\u7F29\u4E86\u51E0\u6B21 */
    scan(events) { return scanCompactions(events) },

    /** \u8BE5\u6CE8\u5165\u7684\u90A3\u6BB5\u6587\u672C + \u91CC\u9762\u7528\u4E86\u54EA\u4E9B\u8BB0\u5FC6 */
    inject({ query = '', recovering = false } = {}) {
      return buildInjectionText({ db, config: cfg, sessionId: sid, query, recovering })
    },

    persona(paths) {
      return loadPersona(db, paths ?? cfg.personaFiles, { owner: owner, confineTo: cfg.personaFiles })
    },
    proposals() { return pendingProposals(db, owner) },
    decide(id, approve) { return decideProposal(db, id, approve, { actor: cfg.owner ? `sdk:${cfg.owner}` : 'sdk:local', owner: owner }) },

    /** \u7ED9\u4E00\u6761\u8BB0\u5FC6\u6295\u7968\uFF0C\u9519\u7684\u6512\u591A\u4E86\u4F1A\u81EA\u5DF1\u5931\u6548 */
    feedback(id, verdict, note = null) { return feedback(db, id, verdict, { note, owner: owner }) },

    /** \u8DD1\u4E00\u8F6E\u8FDB\u5316\uFF1A\u5408\u5E76\u91CD\u590D + \u6309\u53CD\u9988\u8C03\u6743\u91CD */
    evolve(opts = {}) {
      if (cfg.owner != null) throw new Error('evolve requires trusted single-user administrative mode')
      return evolve(db, opts)
    },
    evolutions(limit = 10) { return evolutionLog(db, limit) },
    weights() { return weightsNow() },
    feedbackStats(opts = {}) { return feedbackStats(db, { ...opts, owner: owner }) },
    mergeDuplicates(opts = {}) {
      if (cfg.owner != null) throw new Error('mergeDuplicates requires trusted single-user administrative mode')
      return mergeDuplicates(db, opts)
    },
    loadWeights() { return loadWeights(db) },
    // \u7ACB\u523B\u5907\u4EFD\uFF08everyHours \u5F52\u96F6\uFF09\uFF0C\u8FD4\u56DE { created } / { skipped }
    backup(opts = {}) {
      return backupIfDue(db, cfg.dbPath, { ...cfg.backup, ...opts, everyHours: 0 })
    },
    backups() { return listBackups(backupDirFor(cfg.dbPath, cfg.backup?.dir)) },
    /** Heuristic scan for instruction-like memories in this partition. */
    suspects(opts = {}) { return suspects(db, { ...opts, owner: owner }) },
    /** Hide a memory from retrieval without deleting it. */
    quarantine(id, opts = {}) { return quarantine(db, id, { ...opts, owner: owner }) },
    /** Restore a quarantined memory. */
    release(id, opts = {}) { return releaseQuarantine(db, id, { ...opts, owner: owner }) },
    /** Audit trail for quarantine and release decisions. */
    trustEvents(opts = {}) { return trustEvents(db, { ...opts, owner: owner }) },

    /** Shared decision records: propose, argue with evidence, decide. */
    openDecision(input = {}) { return openDecision(db, { ...input, owner: owner }) },
    argue(decisionId, input = {}) { return argue(db, decisionId, { ...input, owner: owner }) },
    decideOutcome(decisionId, input = {}) { return decideRecord(db, decisionId, { ...input, owner: owner }) },
    decisions(opts = {}) { return listDecisions(db, { ...opts, owner: owner }) },
    /** Post a message to another agent's mailbox. */
    send(input = {}) { return sendMessage(db, { ...input, owner: owner }) },
    /** Work addressed to one agent; defaults to everything not yet done. */
    inbox(opts = {}) { return inbox(db, { ...opts, owner: owner }) },
    claim(messageId, agent) { return claimMessage(db, { id: messageId, agent, owner: owner }) },
    complete(messageId, agent) { return completeMessage(db, { id: messageId, agent, owner: owner }) },
    decision(decisionId) { return decisionView(db, decisionId, { owner: owner }) },

    /** Evidence-backed handoff package for this session. */
    handoff(opts = {}) { return buildHandoff(db, { ...opts, sessionId: sid, owner }) },
    /** Re-check a handoff package against the live database. */
    verifyHandoff(pkg) { return verifyHandoff(db, pkg, { owner: owner }) },

    /** What the current retention policy would delete, and what stays. */
    retention() { return retentionReport(db, { owner: owner, backupDir: backupDirFor(cfg.dbPath, cfg.backup?.dir), policy: { backupKeep: cfg.backup?.keep } }) },

    /** Restore a snapshot to a path and prove the copy is usable. */
    restore(from, to, opts = {}) { return restoreBackup(from, to, opts) },
    /** Integrity and contents of every backup, newest first. */
    verifyBackups() { return verifyBackups(backupDirFor(cfg.dbPath, cfg.backup?.dir)) },
    gc(opts = {}) {
      if (cfg.owner != null) throw new Error('gc requires trusted single-user administrative mode')
      return gc(db, {
        days: cfg.gc.days,
        checkpointDays: cfg.gc.checkpointDays,
        proposalDays: cfg.gc.proposalDays,
        ...opts,
      })
    },

    // Caller options are spread first and scope/owner are pinned afterwards, so
    // a caller cannot widen the partition by passing its own owner or scope.
    graph(opts = {}) { return buildGraph(db, { ...opts, scope: sid, owner: owner }) },
    graphHtml(opts = {}) {
      return renderGraphHtml(acm.graph(opts), { sessionId: sid })
    },

    fold(outPath) { return foldToMarkdown(db, { sessionId: sid, outPath, owner: owner }) },

    stats() { return stats(db, sid, owner) },
    status() { return statusOf({ db, config: cfg, sessionId: sid }) },

    /** \u6362\u4F1A\u8BDD\uFF08\u540C\u4E00\u4E2A\u5E93\uFF09 */
    forSession(nextSessionId) {
      return openMemory({ dbPath: cfg.dbPath, sessionId: nextSessionId, config: cfg })
    },

    // Durable tasks.
    //
    // Every argument that decides *where* or *who* is bound **after** the caller's
    // options are read. An owner-bound handle must not be steerable by passing
    // `{ owner: 'someone-else' }`, and a caller must not be able to name an actor
    // other than the one this handle was opened with - that is the same closure
    // invariant the rest of this file already keeps for the owner. Operations take
    // only the fields they actually use, so anything else is ignored rather than
    // forwarded, and `allowSelfVerify` is not reachable from here at all.
    taskCreate(input = {}) {
      const { title, detail, assignee, dependsOn, priority, maxAttempts } = input
      return createTask(db, {
        title, detail, assignee, dependsOn, priority, maxAttempts,
        owner, project: cfg.project ?? null, createdBy: actor,
      })
    },
    tasks(filter = {}) {
      const { state, assignee, limit } = filter
      return listTasks(db, { state, assignee, limit, owner })
    },
    task(key) {
      const task = getTask(db, { key, owner })
      return task ? { task, events: taskEvents(db, { key, owner }) } : null
    },
    taskAssign(key, assignee) {
      return assignTask(db, { key, owner, assignee, actor })
    },
    taskAccept(key, opts = {}) {
      return acceptTask(db, { key, owner, actor, leaseMs: opts.leaseMs })
    },
    taskRenew(key, opts = {}) {
      return renewTask(db, { key, owner, actor, leaseMs: opts.leaseMs })
    },
    taskReturn(key, opts = {}) {
      return returnTask(db, { key, owner, actor, result: opts.result, evidence: opts.evidence })
    },
    taskVerify(key, opts = {}) {
      return verifyTask(db, { key, owner, actor, note: opts.note })
    },
    taskReject(key, reason) {
      return rejectTask(db, { key, owner, actor, reason })
    },
    taskFail(key, reason) {
      return failTask(db, { key, owner, actor, reason })
    },
    taskCancel(key, reason = null) {
      return cancelTask(db, { key, owner, actor, reason })
    },
    taskRetry(key, assignee = null) {
      return retryTask(db, { key, owner, actor, assignee })
    },
    taskExpireLeases(at) {
      return expireLeases(db, { owner, at })
    },

    close() { try { db.close() } catch {} },
  }

  return acm
}
