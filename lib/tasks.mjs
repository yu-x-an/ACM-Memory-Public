/**
 * A durable task state machine.
 *
 * A mailbox carries messages; it does not carry work. Before this file, "task" in
 * ACM meant a free-form message with a `claimed_by` column, so "done" was a bit an
 * agent could set for itself and there was no way to say a task depends on another,
 * expired, was rejected, or was verified by someone other than its author.
 *
 * Every transition here is a conditional update on `(state, version)` inside one
 * transaction, with an append-only event appended in the same transaction. A lost
 * race therefore reports `state-changed` instead of overwriting a newer state, and
 * the event log cannot describe a transition the row did not make.
 *
 * What this is not: a scheduler and not an identity system. It does not choose who
 * runs a task, it does not spawn anything, and `assignee` is still a declared name
 * (see lib/auth.mjs for what a principal can and cannot prove).
 */
import { tx } from './db.mjs'
import { normalize } from './text.mjs'

export const TASK_STATES = ['open', 'assigned', 'running', 'returned', 'verified', 'confirmed', 'failed', 'cancelled', 'expired']

export const EVIDENCE_KINDS = ['commit', 'test', 'file', 'command', 'note', 'url']

/** Allowed transitions, in one table so "what may follow what" is readable at once. */
export const TRANSITIONS = {
  assign: { from: ['open', 'assigned', 'expired', 'failed'], to: 'assigned' },
  accept: { from: ['assigned'], to: 'running' },
  renew: { from: ['running'], to: 'running' },
  return: { from: ['running'], to: 'returned' },
  verify: { from: ['returned'], to: 'verified' },
  // The user's final word. Only a person may say it - see `confirmTask`.
  confirm: { from: ['verified'], to: 'confirmed' },
  reject: { from: ['returned'], to: 'assigned' },
  fail: { from: ['assigned', 'running', 'returned'], to: 'failed' },
  cancel: { from: ['open', 'assigned'], to: 'cancelled' },
  retry: { from: ['failed', 'expired'], to: 'assigned' },
  expire: { from: ['running'], to: 'expired' },
}

const DEFAULT_LEASE_MS = 15 * 60 * 1000
// A lease is a deadline, so it has to be bounded on both ends: a zero lease is an
// instant expiry dressed up as a successful accept, and an unbounded one is the
// "never expires" behaviour this state machine exists to replace.
const MIN_LEASE_MS = 1000
const MAX_LEASE_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 3

/** `null` when the value is not a usable lease; the caller reports the bounds. */
function leaseWindow(leaseMs) {
  if (leaseMs == null) return DEFAULT_LEASE_MS
  const n = Number(leaseMs)
  if (!Number.isFinite(n) || n < MIN_LEASE_MS || n > MAX_LEASE_MS) return null
  return Math.round(n)
}

/** Columns a transition may write. Anything else is a bug, not a feature. */
const WRITABLE = new Set([
  'assignee', 'lease_until', 'attempts', 'result', 'result_evidence',
  'verified_by', 'closed_at', 'last_reason', 'priority', 'depends_on',
  'confirmed_by', 'confirmed_at',
])

const now = (at) => (Number.isFinite(Number(at)) ? Number(at) : Date.now())

function taskKey(db) {
  for (let i = 0; i < 20; i += 1) {
    const candidate = `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    if (!db.prepare('select 1 from acm_tasks where task_key = ?').get(candidate)) return candidate
  }
  throw new Error('could not allocate a task key')
}

function readRow(db, key, owner) {
  return db.prepare('select * from acm_tasks where task_key = ? and owner IS ?').get(String(key), owner)
}

function toTask(row) {
  if (!row) return null
  const evidence = safeJson(row.result_evidence, [])
  const depends = safeJson(row.depends_on, [])
  return {
    id: Number(row.id),
    key: row.task_key,
    owner: row.owner,
    project: row.project,
    title: row.title,
    detail: row.detail,
    state: row.state,
    priority: Number(row.priority),
    createdBy: row.created_by,
    assignee: row.assignee,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseUntil: row.lease_until,
    result: row.result,
    evidence,
    verifiedBy: row.verified_by,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    dependsOn: depends,
    lastReason: row.last_reason,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    closedAt: row.closed_at,
    version: Number(row.version),
  }
}

function safeJson(text, fallback) {
  if (!text) return fallback
  try { return JSON.parse(text) } catch { return fallback }
}

/**
 * Evidence is the difference between "the agent said it finished" and a claim a
 * successor can re-check. It is required on `return` and validated here rather than
 * stored as free text.
 */
export function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return null
  const out = []
  for (const item of evidence) {
    if (!item || typeof item !== 'object') return null
    const kind = String(item.kind ?? '')
    const ref = normalize(item.ref ?? '')
    if (!EVIDENCE_KINDS.includes(kind) || !ref) return null
    out.push({ kind, ref, note: item.note ? String(item.note).slice(0, 500) : null })
  }
  return out
}

function appendEvent(db, { key, from, to, action, actor, at, payload = null }) {
  db.prepare(
    'insert into acm_task_events (task_key, from_state, to_state, action, actor, at, payload) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(key, from, to, action, actor, at, payload ? JSON.stringify(payload) : null)
}

/**
 * The one write path. Callers describe an action; this decides whether it is legal
 * from the current state and refuses to overwrite a state that moved underneath it.
 */
function move(db, { key, owner, action, actor, patch = {}, payload = null, at = Date.now(), allowSame = false, leaseUntilAtMost = null }) {
  const spec = TRANSITIONS[action]
  if (!spec) return { ok: false, reason: 'unknown-action' }
  const when = now(at)
  return tx(db, () => {
    const row = readRow(db, key, owner)
    if (!row) return { ok: false, reason: 'not-found' }
    if (!spec.from.includes(row.state)) {
      // Verifying something already verified is the one idempotent case: a retry
      // after a lost reply must not look like a conflict.
      if (action === 'verify' && row.state === 'verified' && allowSame) {
        return { ok: true, already: true, task: toTask(row) }
      }
      return { ok: false, reason: 'bad-state', state: row.state, allowed: spec.from }
    }
    // A lease is a deadline on the work, not a decoration. Checking it here rather
    // than in each caller means renew/return/fail cannot act on an expired lease
    // just because the sweep has not run yet. `expire` is the one action allowed
    // to act on an expired lease, because that is what it is for.
    const guardsLease = action !== 'expire' && spec.from.includes('running')
    if (guardsLease && row.state === 'running' && row.lease_until != null && Number(row.lease_until) <= when) {
      return { ok: false, reason: 'lease-expired', state: row.state, leaseUntil: Number(row.lease_until) }
    }

    const columns = Object.entries(patch).filter(([k]) => WRITABLE.has(k))
    if (columns.length !== Object.keys(patch).length) return { ok: false, reason: 'unwritable-column' }
    const sets = columns.map(([k]) => `${k} = ?`).join(', ')
    const values = columns.map(([, v]) => v)
    // The deadline is also in the WHERE clause: a lease that expires between this
    // read and this write must not be extended by a transition that just checked it.
    const where = ['task_key = ?', 'owner IS ?', 'state = ?', 'version = ?']
    const whereArgs = [String(key), owner, row.state, Number(row.version)]
    if (guardsLease && row.state === 'running') {
      where.push('(lease_until is null or lease_until > ?)')
      whereArgs.push(when)
    }
    // `expire` skips the deadline guard above because it is the action that acts on
    // an expired lease - but it must still assert *which* deadline it decided on.
    // Without this, a sweep that selected the row and then lost the race to a
    // renewal expired a task whose lease was by then in the future.
    if (leaseUntilAtMost != null) {
      where.push('lease_until is not null and lease_until <= ?')
      whereArgs.push(Number(leaseUntilAtMost))
    }
    const sql = `update acm_tasks set state = ?, ${sets ? `${sets}, ` : ''}version = version + 1, updated_at = ?`
      + ` where ${where.join(' and ')}`
    const res = db.prepare(sql).run(spec.to, ...values, when, ...whereArgs)
    if (!res.changes) {
      const after = readRow(db, key, owner)
      if (leaseUntilAtMost != null && after && after.state === 'running'
        && (after.lease_until == null || Number(after.lease_until) > Number(leaseUntilAtMost))) {
        return { ok: false, reason: 'lease-renewed', state: after.state, leaseUntil: after.lease_until }
      }
      if (guardsLease && after && after.state === 'running' && after.lease_until != null && Number(after.lease_until) <= when) {
        return { ok: false, reason: 'lease-expired', state: after.state, leaseUntil: Number(after.lease_until) }
      }
      return { ok: false, reason: 'state-changed' }
    }
    appendEvent(db, { key: String(key), from: row.state, to: spec.to, action, actor, at: when, payload })
    return { ok: true, task: toTask(readRow(db, key, owner)) }
  })
}

export function createTask(db, input = {}) {
  const title = normalize(input.title ?? '')
  const owner = input.owner ?? null
  const at = now(input.at)
  if (!title) return { ok: false, reason: 'title-required' }
  const createdBy = normalize(input.createdBy ?? '')
  if (!createdBy) return { ok: false, reason: 'actor-required' }
  const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn.map(String) : []
  const assignee = input.assignee ? normalize(input.assignee) : null
  return tx(db, () => {
    for (const dep of dependsOn) {
      if (!readRow(db, dep, owner)) return { ok: false, reason: 'dependency-not-found', dependency: dep }
    }
    const key = taskKey(db)
    const state = assignee ? 'assigned' : 'open'
    db.prepare(
      `insert into acm_tasks (task_key, owner, project, title, detail, state, priority, created_by, assignee,
        attempts, max_attempts, depends_on, created_at, updated_at, version)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)`,
    ).run(
      key, owner, input.project ?? null, title, input.detail ? String(input.detail) : null, state,
      Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
      createdBy, assignee, Number(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      JSON.stringify(dependsOn), at, at,
    )
    appendEvent(db, { key, from: null, to: state, action: 'create', actor: createdBy, at, payload: { dependsOn } })
    return { ok: true, task: toTask(readRow(db, key, owner)) }
  })
}

export function getTask(db, { key, owner = null } = {}) {
  return toTask(readRow(db, key, owner))
}

export function listTasks(db, { owner = null, state = null, assignee = null, project = null, limit = 20 } = {}) {
  const where = ['owner IS ?']
  const args = [owner]
  if (state) { where.push('state = ?'); args.push(state) }
  if (assignee) { where.push('assignee = ?'); args.push(normalize(assignee)) }
  if (project) { where.push('project = ?'); args.push(project) }
  const rows = db.prepare(
    `select * from acm_tasks where ${where.join(' and ')} order by priority desc, updated_at desc limit ?`,
  ).all(...args, Math.min(200, Math.max(1, Number(limit))))
  return rows.map(toTask)
}

export function taskEvents(db, { key, owner = null } = {}) {
  const row = readRow(db, key, owner)
  if (!row) return []
  return db.prepare('select * from acm_task_events where task_key = ? order by id').all(String(key)).map((e) => ({
    id: Number(e.id),
    from: e.from_state,
    to: e.to_state,
    action: e.action,
    actor: e.actor,
    at: Number(e.at),
    payload: safeJson(e.payload, null),
  }))
}

export function assignTask(db, { key, owner = null, assignee, actor, at } = {}) {
  const target = normalize(assignee ?? '')
  if (!target) return { ok: false, reason: 'assignee-required' }
  if (!normalize(actor ?? '')) return { ok: false, reason: 'actor-required' }
  return move(db, { key, owner, action: 'assign', actor: normalize(actor), patch: { assignee: target }, at })
}

/** Dependencies must be verified before work starts, not before it is assigned. */
export function acceptTask(db, { key, owner = null, actor, leaseMs = null, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  const lease = leaseWindow(leaseMs)
  if (lease == null) return { ok: false, reason: 'lease-out-of-range', min: MIN_LEASE_MS, max: MAX_LEASE_MS }
  const when = now(at)
  const row = readRow(db, key, owner)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.assignee && row.assignee !== who) return { ok: false, reason: 'not-assignee', assignee: row.assignee }
  // A task whose lease ran out but which no sweep has touched yet is still `running`.
  // Saying "lease-expired" is more useful than "bad-state": the holder is gone and
  // the next step is an explicit expire or retry, not a guess.
  if (row.state === 'running' && row.lease_until != null && Number(row.lease_until) <= when) {
    return { ok: false, reason: 'lease-expired', leaseUntil: Number(row.lease_until), hint: 'expire or retry the task' }
  }
  const deps = safeJson(row.depends_on, [])
  for (const dep of deps) {
    const d = readRow(db, dep, owner)
    // `confirmed` is a *stronger* state than `verified`, not a different branch: a
    // confirmation the user gave cannot un-finish the work. Testing only `verified`
    // here made every confirmed parent an unsatisfiable dependency, so the child
    // could never be accepted - found by review of the round that added `confirmed`.
    if (!d || (d.state !== 'verified' && d.state !== 'confirmed')) {
      return { ok: false, reason: 'dependency-open', dependency: dep, dependencyState: d?.state ?? null }
    }
  }
  const attempts = Number(row.attempts) + 1
  if (attempts > Number(row.max_attempts)) return { ok: false, reason: 'attempts-exhausted', attempts: Number(row.attempts) }
  return move(db, {
    key,
    owner,
    action: 'accept',
    actor: who,
    patch: { assignee: who, lease_until: when + lease, attempts },
    at: when,
    payload: { attempts, leaseMs: lease },
  })
}

/**
 * Extend a lease on work that is still running.
 *
 * The host already exported this, but no MCP tool, CLI verb or SDK method reached
 * it - so a legitimate job that outlived the default 15 minutes became `expired`
 * while its worker was still executing, and the worker had no supported way to say
 * "still working". Extensions are explicit and bounded; nothing renews by itself.
 */
export function renewTask(db, { key, owner = null, actor, leaseMs = null, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  const lease = leaseWindow(leaseMs)
  if (lease == null) return { ok: false, reason: 'lease-out-of-range', min: MIN_LEASE_MS, max: MAX_LEASE_MS }
  const row = readRow(db, key, owner)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.assignee !== who) return { ok: false, reason: 'not-assignee', assignee: row.assignee }
  const when = now(at)
  return move(db, {
    key, owner, action: 'renew', actor: who,
    patch: { lease_until: when + lease },
    at: when,
    payload: { leaseMs: lease },
  })
}

/**
 * Returning work requires a result and evidence. Without both, a successor cannot
 * tell "finished" from "believes it finished", which is the failure mode this
 * whole module exists to make visible.
 */
export function returnTask(db, { key, owner = null, actor, result, evidence, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  const text = normalize(result ?? '')
  if (!text) return { ok: false, reason: 'result-required' }
  const checked = normalizeEvidence(evidence)
  if (!checked) return { ok: false, reason: 'evidence-required', kinds: EVIDENCE_KINDS }
  const row = readRow(db, key, owner)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.assignee && row.assignee !== who) return { ok: false, reason: 'not-assignee', assignee: row.assignee }
  return move(db, {
    key,
    owner,
    action: 'return',
    actor: who,
    patch: { result: text, result_evidence: JSON.stringify(checked) },
    at,
    payload: { evidence: checked },
  })
}

/**
 * Verification is a separate act by a different principal. Self-verification is
 * refused by default because "I checked my own work" is exactly the claim that
 * turns a done bit back into an assertion.
 */
export function verifyTask(db, { key, owner = null, actor, note = null, allowSelfVerify = false, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  const row = readRow(db, key, owner)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.state === 'verified') {
    if (row.verified_by && row.verified_by !== who) return { ok: false, reason: 'verified-by-someone-else', verifiedBy: row.verified_by }
    return { ok: true, already: true, task: toTask(row) }
  }
  if (!allowSelfVerify && row.assignee && row.assignee === who) {
    return { ok: false, reason: 'self-verification-refused' }
  }
  return move(db, {
    key,
    owner,
    action: 'verify',
    actor: who,
    patch: { verified_by: who, closed_at: now(at) },
    at,
    payload: note ? { note: String(note).slice(0, 500) } : null,
    allowSame: true,
  })
}

/**
 * The user's final confirmation, on work a second AI has already verified.
 *
 * This is the one transition with **no tool and no SDK method**: it exists on the
 * CLI (`acm task confirm`) so that "the user accepted this" is an act a person
 * performed, not a step a script performed on their behalf. The assignee is refused
 * for the same reason self-verification is - "I confirmed my own work" is the claim
 * this whole file exists to make auditable rather than assumed.
 */
export function confirmTask(db, { key, owner = null, actor, note = null, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  const row = readRow(db, key, owner)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.state === 'confirmed') {
    if (row.confirmed_by && row.confirmed_by !== who) {
      return { ok: false, reason: 'confirmed-by-someone-else', confirmedBy: row.confirmed_by }
    }
    return { ok: true, already: true, task: toTask(row) }
  }
  if (row.assignee && row.assignee === who) {
    return { ok: false, reason: 'self-confirmation-refused' }
  }
  return move(db, {
    key,
    owner,
    action: 'confirm',
    actor: who,
    patch: { confirmed_by: who, confirmed_at: now(at) },
    at,
    payload: note ? { note: String(note).slice(0, 500) } : null,
  })
}

/**
 * Rejection sends the task back for another attempt, or fails it when the attempts
 * are gone. It never deletes the previous result: the next attempt needs to see what
 * was wrong with the last one.
 */
export function rejectTask(db, { key, owner = null, actor, reason, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  const why = normalize(reason ?? '')
  if (!why) return { ok: false, reason: 'reason-required' }
  const row = readRow(db, key, owner)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.state !== 'returned') return { ok: false, reason: 'bad-state', state: row.state, allowed: ['returned'] }
  const exhausted = Number(row.attempts) >= Number(row.max_attempts)
  return move(db, {
    key,
    owner,
    action: exhausted ? 'fail' : 'reject',
    actor: who,
    patch: { last_reason: why, ...(exhausted ? { closed_at: now(at) } : {}) },
    at,
    payload: { reason: why, attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts) },
  })
}

export function failTask(db, { key, owner = null, actor, reason, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  const why = normalize(reason ?? '')
  if (!why) return { ok: false, reason: 'reason-required' }
  return move(db, {
    key, owner, action: 'fail', actor: who,
    patch: { last_reason: why, closed_at: now(at) },
    at,
    payload: { reason: why },
  })
}

export function cancelTask(db, { key, owner = null, actor, reason = null, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  return move(db, {
    key, owner, action: 'cancel', actor: who,
    patch: { closed_at: now(at), ...(reason ? { last_reason: normalize(reason) } : {}) },
    at,
    payload: reason ? { reason: normalize(reason) } : null,
  })
}

/** Retry is explicit: an expired or failed task does not silently come back. */
export function retryTask(db, { key, owner = null, actor, assignee = null, at } = {}) {
  const who = normalize(actor ?? '')
  if (!who) return { ok: false, reason: 'actor-required' }
  const row = readRow(db, key, owner)
  if (!row) return { ok: false, reason: 'not-found' }
  if (Number(row.attempts) >= Number(row.max_attempts)) {
    return { ok: false, reason: 'attempts-exhausted', attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts) }
  }
  return move(db, {
    key, owner, action: 'retry', actor: who,
    patch: { assignee: assignee ? normalize(assignee) : row.assignee },
    at,
    payload: { previous: row.state },
  })
}

/**
 * Expire one lease, asserting the deadline the caller decided on.
 *
 * The sweep cannot be a plain "select, then expire": between its SELECT and its
 * UPDATE another connection can renew the lease, and `expire` is exempt from the
 * deadline guard (it is the action for an expired lease), so it would expire a task
 * whose lease is now in the future. `at` is the moment the caller judged the lease
 * dead; the transition only applies while `lease_until` still agrees with it.
 */
export function expireLease(db, { key, owner = null, actor = 'system', at = Date.now() } = {}) {
  const when = now(at)
  const res = move(db, {
    key, owner, action: 'expire', actor,
    patch: { last_reason: 'lease-expired' },
    at: when,
    leaseUntilAtMost: when,
    payload: { reason: 'lease-expired' },
  })
  return res
}

/**
 * Expire leases that have run out. Called by the host tick and by the CLI, so a
 * task whose agent died becomes visibly reclaimable instead of looking busy
 * forever - which is what a `claimed_by` column alone cannot tell you.
 *
 * `raced` is the interesting number in a live system: rows that were expired when
 * the sweep looked and alive when it acted. They stay running, which is correct -
 * the worker renewed, so it is still working.
 */
export function expireLeases(db, { owner = null, at = Date.now(), actor = 'system' } = {}) {
  const when = now(at)
  const rows = db.prepare(
    "select task_key, version, lease_until from acm_tasks where owner IS ? and state = 'running' and lease_until is not null and lease_until <= ?",
  ).all(owner, when)
  const expired = []
  const raced = []
  for (const r of rows) {
    // An expired lease is not a failure: the agent may have died, the machine may
    // have slept. It lands in `expired` so an explicit `retry` decides what next.
    const res = expireLease(db, { key: r.task_key, owner, actor, at: when })
    if (res.ok) expired.push(r.task_key)
    else if (res.reason === 'lease-renewed') raced.push(r.task_key)
  }
  return { ok: true, expired, raced, at: when }
}
