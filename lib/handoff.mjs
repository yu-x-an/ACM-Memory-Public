/**
 * Verifiable handoff.
 *
 * A handoff is not a summary: it is a claim plus the evidence needed to check
 * the claim. The package carries a digest over a canonical manifest, and
 * `verifyHandoff` re-reads the database to confirm that every claimed memory is
 * still present, unchanged and still active, and that the checkpoint it points
 * at is still the current one.
 *
 * The receiver must be able to reject a package that no longer matches reality,
 * which is exactly what prose cannot offer.
 */
import { sha256 } from './text.mjs'
import { activeCheckpoint } from './checkpoint.mjs'
import { conflicts, nodesByIds, search } from './memory.mjs'
import { pendingProposals } from './persona.mjs'
import { decisions as listDecisions, inbox } from './deliberation.mjs'

/** Deterministic JSON: sorted keys, no whitespace, so a digest is stable. */
export function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const key of Object.keys(v).sort()) out[key] = walk(v[key])
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}

function checkpointDigest(cp) {
  if (!cp) return null
  return sha256(canonicalJson({ goal: cp.goal, done: cp.done, next: cp.next, files: cp.files, decisions: cp.decisions }))
}

/**
 * Build a handoff package for a session.
 *
 * `facts` are the memories that would be injected into the successor, each with
 * the hash of its text; `conflicts` and `proposals` are surfaced because they
 * are the parts a successor must not silently trust.
 */
export function buildHandoff(db, { sessionId, owner = null, limit = 8, now = Date.now(), agent = null } = {}) {
  const cp = activeCheckpoint(db, sessionId, owner)
  if (!cp) return { ok: false, reason: 'no-checkpoint' }
  const query = cp.goal || cp.next || sessionId
  const hits = search(db, { query, scope: sessionId, limit, owner })
  const facts = hits.map((n) => ({
    id: Number(n.id),
    key: n.key ?? null,
    text: n.text,
    sha: sha256(n.text),
  }))
  // Open decisions and open mailbox work are what the successor has to act on;
  // a package that lists only facts hands over the past without the future.
  const openDecisions = listDecisions(db, { owner, scope: sessionId, state: 'open', limit: 20 })
  // Mail is addressed to a named agent, so it is only counted when the caller
  // says who the successor is.
  const openMail = agent ? inbox(db, { agent, owner }).length : null

  const checkpointOut = { id: cp.id, goal: cp.goal ?? null, done: cp.done ?? null, next: cp.next ?? null, files: cp.files ?? null, decisions: cp.decisions ?? null }
  const decisionsOut = openDecisions.map((d) => ({ id: d.id, topic: d.topic, state: d.state, arguments: d.arguments }))

  // Everything the successor can read is hashed, not just the manifest: a
  // digest over the manifest alone let a package show edited text while every
  // check passed, because the checks only compared the database to the SHA the
  // package claimed.
  const conflictsOut = conflicts(db, { owner, scope: sessionId }).slice(0, 5)
  const proposalsOut = pendingProposals(db, owner).length

  const payload = {
    version: 2,
    sessionId,
    checkpoint: checkpointOut,
    facts,
    openDecisions: decisionsOut,
    conflicts: conflictsOut,
    openMail,
    proposals: proposalsOut,
  }
  const manifest = {
    sessionId,
    owner: owner ?? null,
    checkpointId: cp.id,
    checkpointSha: checkpointDigest(cp),
    facts: facts.map((f) => ({ id: f.id, sha: f.sha })),
    decisions: openDecisions.map((d) => d.id),
    at: Number(now),
    payloadSha: sha256(canonicalJson(payload)),
  }

  return {
    ok: true,
    version: 2,
    sessionId,
    checkpoint: checkpointOut,
    facts,
    conflicts: conflictsOut,
    openDecisions: decisionsOut,
    openMail,
    proposals: proposalsOut,
    manifest,
    digest: sha256(canonicalJson(manifest)),
  }
}

/**
 * Re-check a package against the live database.
 *
 * Every check reports its own verdict so a failure names the broken link
 * instead of returning a bare boolean.
 */
export function verifyHandoff(db, pkg, { owner = null } = {}) {
  const checks = {}
  if (!pkg || pkg.ok !== true || !pkg.manifest) {
    return { ok: false, checks: { package: 'missing' } }
  }
  const m = pkg.manifest
  checks.digest = sha256(canonicalJson(m)) === pkg.digest ? 'ok' : 'tampered'
  checks.owner = (m.owner ?? null) === (owner ?? null) ? 'ok' : 'owner-mismatch'

  const cp = activeCheckpoint(db, m.sessionId, owner)
  if (!cp) checks.checkpoint = 'missing'
  else if (cp.id !== m.checkpointId) checks.checkpoint = 'superseded'
  else checks.checkpoint = checkpointDigest(cp) === m.checkpointSha ? 'ok' : 'changed'

  // Bind the visible payload to the digest before trusting any field in it.
  const payload = {
    version: pkg.version ?? 1,
    sessionId: pkg.sessionId ?? m.sessionId,
    checkpoint: pkg.checkpoint ?? null,
    facts: Array.isArray(pkg.facts) ? pkg.facts : [],
    openDecisions: Array.isArray(pkg.openDecisions) ? pkg.openDecisions : [],
    conflicts: Array.isArray(pkg.conflicts) ? pkg.conflicts : [],
    openMail: pkg.openMail ?? null,
    proposals: pkg.proposals ?? null,
  }
  checks.payload = m.payloadSha && sha256(canonicalJson(payload)) === m.payloadSha ? 'ok' : 'tampered'

  const manifestFacts = Array.isArray(m.facts) ? m.facts : []
  checks.factsList =
    manifestFacts.length === payload.facts.length &&
    manifestFacts.every((e, i) => Number(e.id) === Number(payload.facts[i]?.id) && e.sha === payload.facts[i]?.sha)
      ? 'ok'
      : 'tampered'

  const claimed = Array.isArray(pkg.facts) ? pkg.facts : []
  const live = new Map(nodesByIds(db, claimed.map((f) => f.id), owner).map((n) => [Number(n.id), n]))
  const missing = []
  const changed = []
  const retyped = []
  for (const f of claimed) {
    if (sha256(String(f.text ?? '')) !== f.sha) retyped.push(f.id)
    const node = live.get(Number(f.id))
    if (!node) missing.push(f.id)
    else if (sha256(node.text) !== f.sha) changed.push(f.id)
  }
  checks.facts = retyped.length ? 'text-mismatch' : missing.length ? 'missing' : changed.length ? 'changed' : 'ok'

  // An open decision that was resolved after the package was built means the
  // successor would act on stale instructions.
  const claimedDecisions = Array.isArray(m.decisions) ? m.decisions : []
  // Look each claimed id up directly. Reading the newest N decisions meant an id
  // outside that window looked resolved even when it was still open.
  const liveDecision = (id) =>
    db.prepare('select id, topic, state, (select count(*) from acm_arguments a where a.decision_id = d.id) arguments from acm_decisions d where d.id = ? and d.owner IS ?')
      .get(Number(id), owner) ?? null
  const resolved = claimedDecisions.filter((id) => liveDecision(id)?.state !== 'open')
  checks.decisions = resolved.length ? 'stale' : 'ok'

  // The topic and the argument count are what the successor reads; an id that is
  // still open is not enough if the text behind it changed.
  const drifted = (payload.openDecisions ?? []).filter((d) => {
    const current = liveDecision(d?.id)
    if (!current) return false
    return String(current.topic) !== String(d.topic) || Number(current.arguments) !== Number(d.arguments)
  })
  checks.decisionContent = drifted.length ? 'changed' : 'ok'

  // Conflicts are shown to the successor, so a package whose list no longer
  // matches the store is stale even though its digest is intact.
  if (Array.isArray(pkg.conflicts)) {
    const liveConflicts = conflicts(db, { owner, scope: m.sessionId }).slice(0, 5)
    checks.conflicts = canonicalJson(pkg.conflicts) === canonicalJson(liveConflicts) ? 'ok' : 'changed'
  }

  const ok = Object.values(checks).every((v) => v === 'ok')
  return { ok, checks, missing, changed, resolved }
}

/** Human-readable report for a verification result. */
export function renderHandoffReport(result) {
  const lines = Object.entries(result.checks ?? {}).map(([key, value]) => `${value === 'ok' ? 'ok  ' : 'FAIL'} ${key}: ${value}`)
  return `${result.ok ? 'handoff verified' : 'handoff rejected'}\n${lines.join('\n')}`
}
