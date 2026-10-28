/**
 * Shared decision records with an evidence chain.
 *
 * Two coordination modes need the same substrate: a leader convening other
 * agents in one session, and independent agents arriving at different times.
 * Both propose, argue and decide against one auditable record, and every claim
 * can cite memory ids that the reader can re-check.
 */
import { tx } from './db.mjs'
import { normalize } from './text.mjs'

export const OUTCOMES = ['approved', 'rejected']
export const ROLES = ['proposer', 'reviewer', 'decider', 'observer']
export const MAIL_KINDS = ['notice', 'proposal', 'review']
export const STANCES = ['support', 'oppose', 'question']


/**
 * Register a participant. Identity here is an attribution label, not
 * authentication: whoever can open the database can claim any name. Once any
 * agent is registered for a partition, unregistered actors are rejected so the
 * records cannot silently claim unknown participants.
 */
export function registerAgent(db, { name, role = 'reviewer', owner = null, at = Date.now() } = {}) {
  const n = normalize(name ?? '')
  if (!n) return { ok: false, reason: 'name-required' }
  if (!ROLES.includes(role)) return { ok: false, reason: 'unknown-role', roles: ROLES }
  return tx(db, () => {
    const existing = db.prepare('select id from acm_agents where owner IS ? and name = ?').get(owner, n)
    if (existing) {
      db.prepare('update acm_agents set role = ? where id = ?').run(role, existing.id)
      return { ok: true, id: Number(existing.id), updated: true }
    }
    const r = db.prepare('insert into acm_agents (owner, name, role, created_at) values (?, ?, ?, ?)').run(owner, n, role, at)
    return { ok: true, id: Number(r.lastInsertRowid) }
  })
}

export function agents(db, { owner = null } = {}) {
  return db
    .prepare('select id, name, role, created_at from acm_agents where owner IS ? order by role, name')
    .all(owner)
    .map((r) => ({ id: Number(r.id), name: r.name, role: r.role, at: Number(r.created_at) }))
}

/**
 * Check what an actor may do. With no registered agents the store stays in the
 * permissive legacy mode; once a partition has a registry, every actor must be
 * known and hold a role that allows the action.
 */
function authorize(db, { owner, actor, action }) {
  const count = Number(db.prepare('select count(*) c from acm_agents where owner IS ?').get(owner).c)
  if (!count) return { ok: true, mode: 'open' }
  const row = db.prepare('select role from acm_agents where owner IS ? and name = ?').get(owner, actor)
  if (!row) return { ok: false, reason: 'unknown-agent', actor }
  const allowed = {
    propose: ['proposer', 'decider'],
    argue: ['proposer', 'reviewer', 'decider'],
    decide: ['decider'],
  }[action] ?? []
  if (!allowed.includes(row.role)) return { ok: false, reason: 'role-not-allowed', role: row.role, allowed }
  return { ok: true, role: row.role }
}


/** Node ids that exist in this partition, whatever their status. */
function ownedNodeIds(db, ids, owner) {
  const list = [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
  if (!list.length) return []
  const marks = list.map(() => '?').join(',')
  return db
    .prepare(`select id from acm_nodes where id in (${marks}) and owner IS ?`)
    .all(...list, owner)
    .map((r) => Number(r.id))
}

function ownedDecision(db, id, owner) {
  return db.prepare('select * from acm_decisions where id = ? and owner IS ?').get(Number(id), owner)
}

/** Open a decision for a topic. The proposal is the text under consideration. */
export function openDecision(db, { topic, proposal, actor, scope = 'global', owner = null, at = Date.now() } = {}) {
  const t = normalize(topic ?? '')
  const p = normalize(proposal ?? '')
  const a = normalize(actor ?? '')
  if (!t || !p || !a) return { ok: false, reason: 'topic-proposal-actor-required' }
  return tx(db, () => {
    const allowed = authorize(db, { owner, actor: a, action: 'propose' })
    if (!allowed.ok) return allowed
    const r = db
      .prepare('insert into acm_decisions (owner, scope, topic, proposal, state, proposer, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(owner, normalize(scope), t, p, 'open', a, at)
    return { ok: true, id: Number(r.lastInsertRowid) }
  })
}

/**
 * Add an argument with optional evidence.
 *
 * Evidence ids must exist, be active and belong to the same partition: an
 * argument that cites memories the reader cannot verify is not evidence.
 */
export function argue(db, decisionId, { actor, stance = 'support', text, evidence = [], owner = null, at = Date.now() } = {}) {
  const a = normalize(actor ?? '')
  const body = normalize(text ?? '')
  if (!a || !body) return { ok: false, reason: 'actor-and-text-required' }
  if (!STANCES.includes(stance)) return { ok: false, reason: 'unknown-stance' }
  const ids = [...new Set((Array.isArray(evidence) ? evidence : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
  return tx(db, () => {
    const allowed = authorize(db, { owner, actor: a, action: 'argue' })
    if (!allowed.ok) return allowed
    const decision = ownedDecision(db, decisionId, owner)
    if (!decision) return { ok: false, reason: 'not-found' }
    if (decision.state !== 'open') return { ok: false, reason: 'not-open', state: decision.state }
    if (ids.length) {
      const live = ownedNodeIds(db, ids, owner)
      const missing = ids.filter((id) => !live.includes(id))
      if (missing.length) return { ok: false, reason: 'evidence-not-found', missing }
    }
    const r = db
      .prepare('insert into acm_arguments (decision_id, actor, stance, text, evidence, at) values (?, ?, ?, ?, ?, ?)')
      .run(Number(decisionId), a, stance, body, ids.length ? JSON.stringify(ids) : null, at)
    return { ok: true, id: Number(r.lastInsertRowid) }
  })
}

/** Close a decision. Approval needs a named actor, like every privileged change. */
export function decide(db, decisionId, { actor, outcome, rationale = null, owner = null, at = Date.now() } = {}) {
  const a = normalize(actor ?? '')
  if (!a) return { ok: false, reason: 'actor-required' }
  if (!OUTCOMES.includes(outcome)) return { ok: false, reason: 'unknown-outcome' }
  return tx(db, () => {
    const allowed = authorize(db, { owner, actor: a, action: 'decide' })
    if (!allowed.ok) return allowed
    const decision = ownedDecision(db, decisionId, owner)
    if (!decision) return { ok: false, reason: 'not-found' }
    if (decision.state !== 'open') return { ok: false, reason: 'already-decided', state: decision.state }
    db.prepare('update acm_decisions set state = ?, decided_by = ?, rationale = ?, decided_at = ? where id = ?')
      .run(outcome, a, rationale ? normalize(rationale) : null, at, Number(decisionId))
    // An approval replaces the earlier approval on the same topic and scope. The
    // superseded_by column existed from the start but nothing ever wrote it, so a
    // topic could accumulate several "current" decisions.
    let superseded = []
    if (outcome === 'approved') {
      const previous = db
        .prepare("select id from acm_decisions where owner IS ? and scope = ? and topic = ? and state = 'approved' and id <> ?")
        .all(owner, decision.scope, decision.topic, Number(decisionId))
        .map((r) => Number(r.id))
      if (previous.length) {
        const marks = previous.map(() => '?').join(',')
        db.prepare(`update acm_decisions set state = 'superseded', superseded_by = ? where id in (${marks})`)
          .run(Number(decisionId), ...previous)
        superseded = previous
      }
    }
    return { ok: true, id: Number(decisionId), state: outcome, decidedBy: a, superseded }
  })
}

/** Open decisions, newest first, with their argument counts. */
export function decisions(db, { owner = null, scope = null, state = null, limit = 50 } = {}) {
  const where = ['owner IS ?']
  const args = [owner]
  if (scope) { where.push('scope = ?'); args.push(String(scope)) }
  if (state) { where.push('state = ?'); args.push(String(state)) }
  return db
    .prepare(
      `select d.*, (select count(*) from acm_arguments a where a.decision_id = d.id) arguments
         from acm_decisions d where ${where.join(' and ')} order by d.id desc limit ?`,
    )
    .all(...args, Math.max(1, Number(limit) || 50))
    .map((r) => ({
      id: Number(r.id),
      scope: r.scope,
      topic: r.topic,
      proposal: r.proposal,
      state: r.state,
      proposer: r.proposer,
      decidedBy: r.decided_by,
      rationale: r.rationale,
      arguments: Number(r.arguments),
      supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
      at: Number(r.created_at),
    }))
}

/** One decision with its arguments, plus whether each cited memory still exists. */
export function decisionView(db, decisionId, { owner = null } = {}) {
  const row = ownedDecision(db, decisionId, owner)
  if (!row) return null
  const args = db
    .prepare('select id, actor, stance, text, evidence, at from acm_arguments where decision_id = ? order by id asc')
    .all(Number(decisionId))
  const cited = [...new Set(args.flatMap((a) => (a.evidence ? JSON.parse(a.evidence) : [])))]
  const live = new Set(ownedNodeIds(db, cited, owner))
  return {
    decision: {
      id: Number(row.id),
      scope: row.scope,
      topic: row.topic,
      proposal: row.proposal,
      state: row.state,
      proposer: row.proposer,
      decidedBy: row.decided_by,
      rationale: row.rationale,
      at: Number(row.created_at),
      decidedAt: row.decided_at === null ? null : Number(row.decided_at),
      supersededBy: row.superseded_by === null ? null : Number(row.superseded_by),
    },
    arguments: args.map((a) => ({
      id: Number(a.id),
      actor: a.actor,
      stance: a.stance,
      text: a.text,
      evidence: a.evidence ? JSON.parse(a.evidence).map((id) => ({ id, ok: live.has(Number(id)) })) : [],
      at: Number(a.at),
    })),
    missingEvidence: cited.filter((id) => !live.has(Number(id))),
  }
}

/**
 * Turn a fact-key conflict into a decision record.
 *
 * The conflicting revisions become the evidence, so whoever decides sees the
 * actual values rather than a description of them.
 */
export function escalateConflict(db, { nodeId, actor, owner = null, at = Date.now() } = {}) {
  const id = Number(nodeId)
  const node = db.prepare('select id, scope, key, text from acm_nodes where id = ? and owner IS ?').get(id, owner)
  if (!node) return { ok: false, reason: 'not-found' }
  if (!node.key) return { ok: false, reason: 'no-key' }
  const revisions = db
    .prepare("select id, text, status from acm_nodes where scope = ? and key = ? and owner IS ? order by created_at desc")
    .all(node.scope, node.key, owner)
  const opened = openDecision(db, {
    topic: `conflict on ${node.key}`,
    proposal: `keep revision #${id}: ${node.text}`,
    actor,
    scope: node.scope,
    owner,
    at,
  })
  if (!opened.ok) return opened
  const argued = argue(db, opened.id, {
    actor,
    stance: 'question',
    text: `${revisions.length} revisions disagree; see the cited evidence`,
    evidence: revisions.map((r) => Number(r.id)),
    owner,
    at,
  })
  if (!argued.ok) return { ok: false, reason: 'evidence-rejected', detail: argued }
  return { ok: true, decisionId: opened.id, revisions: revisions.length }
}

/**
 * Post a message to another agent's mailbox.
 *
 * This is the asynchronous half of coordination: work is handed over as a durable
 * record rather than as a live conversation, so the recipient can pick it up
 * hours later and the sender does not need to stay running.
 */
export function sendMessage(db, { to, from, kind = 'notice', body, decisionId = null, owner = null, at = Date.now() } = {}) {
  const recipient = normalize(to ?? '')
  const sender = normalize(from ?? '')
  const text = normalize(body ?? '')
  if (!recipient || !sender || !text) return { ok: false, reason: 'to-from-body-required' }
  if (!MAIL_KINDS.includes(kind)) return { ok: false, reason: 'unknown-kind', kinds: MAIL_KINDS }
  return tx(db, () => {
    const r = db
      .prepare('insert into acm_mailbox (owner, recipient, sender, kind, decision_id, body, state, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(owner, recipient, sender, kind, decisionId == null ? null : Number(decisionId), text, 'pending', at)
    return { ok: true, id: Number(r.lastInsertRowid) }
  })
}

/** Messages addressed to one agent, oldest first. */
export function inbox(db, { agent, state = null, owner = null, limit = 50 } = {}) {
  const name = normalize(agent ?? '')
  if (!name) return []
  const where = ['owner IS ?', 'recipient = ?']
  const args = [owner, name]
  // The default view is work still to do; pass state: 'done' to audit history.
  if (state) { where.push('state = ?'); args.push(String(state)) }
  else where.push("state <> 'done'")
  return db
    .prepare(
      `select m.id, m.sender, m.kind, m.decision_id, m.body, m.state, m.created_at, m.claimed_by, m.done_at,
              exists (select 1 from acm_decisions d where d.id = m.decision_id and d.owner IS ?) as decision_exists
         from acm_mailbox m
        where ${where.map((w) => w.replace(/(owner|recipient|state)/g, 'm.$1')).join(' and ')}
        order by m.id asc limit ?`,
    )
    .all(owner, ...args, Math.max(1, Number(limit) || 50))
    .map((r) => ({
      id: Number(r.id),
      sender: r.sender,
      kind: r.kind,
      decisionId: r.decision_id == null ? null : Number(r.decision_id),
      // A message can outlive the decision it points at: report it instead of
      // handing the caller a dangling id.
      decisionExists: Boolean(r.decision_exists),
      body: r.body,
      state: r.state,
      at: Number(r.created_at),
      claimedBy: r.claimed_by ?? null,
      doneAt: r.done_at == null ? null : Number(r.done_at),
    }))
}

/**
 * Take ownership of a message. Exactly one agent can claim it: the update is
 * conditional on the message still being pending, so a race is decided by the
 * database rather than by timing on the caller's side.
 */
export function claimMessage(db, { id, agent, owner = null, at = Date.now() } = {}) {
  const key = Number(id)
  const name = normalize(agent ?? '')
  if (!name) return { ok: false, reason: 'agent-required' }
  return tx(db, () => {
    const row = db.prepare('select id, recipient, state from acm_mailbox where id = ? and owner IS ?').get(key, owner)
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.recipient !== name) return { ok: false, reason: 'not-your-inbox' }
    if (row.state !== 'pending') return { ok: false, reason: 'not-pending', state: row.state }
    const changed = db
      .prepare("update acm_mailbox set state = 'claimed', claimed_by = ?, claimed_at = ? where id = ? and state = 'pending'")
      .run(name, at, key).changes
    if (!changed) return { ok: false, reason: 'raced' }
    return { ok: true, id: key, claimedBy: name }
  })
}

/** Close a message. Only the agent holding the claim may complete it. */
export function completeMessage(db, { id, agent, owner = null, at = Date.now() } = {}) {
  const key = Number(id)
  const name = normalize(agent ?? '')
  if (!name) return { ok: false, reason: 'agent-required' }
  return tx(db, () => {
    const row = db.prepare('select id, state, claimed_by from acm_mailbox where id = ? and owner IS ?').get(key, owner)
    if (!row) return { ok: false, reason: 'not-found' }
    // A done message remains attributable to its claim holder on retry.
    // The old ordering acknowledged any caller once the work was done.
    if (row.state === 'done') {
      if (row.claimed_by !== name) return { ok: false, reason: 'claimed-by-someone-else', claimedBy: row.claimed_by }
      return { ok: true, already: true, id: key }
    }
    if (row.state !== 'claimed') return { ok: false, reason: 'not-claimed', state: row.state }
    if (row.claimed_by !== name) return { ok: false, reason: 'claimed-by-someone-else', claimedBy: row.claimed_by }
    db.prepare("update acm_mailbox set state = 'done', done_at = ? where id = ?").run(at, key)
    return { ok: true, id: key }
  })
}
