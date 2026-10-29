/**
 * Principals, grants and the decisions built on them.
 *
 * The authentication contract asks for an authenticated principal. This module does not provide that:
 * a principal here is still a **declaration** made by a local process, not proof
 * of who is calling. What it does provide is the missing contract - one place that
 * says which actor, in which partition, is allowed to do which thing - so the task
 * engine and the mailbox are not built on an unqualified agent-name string.
 *
 * Two modes, deliberately:
 *
 * - `local` (default) - a single trusted machine. Every action is allowed, so
 *   existing installs keep working, and the decision is recorded as `local-trust`
 *   rather than silently treated as authorized.
 * - `scoped` - an action needs a live grant naming the principal and the action.
 *   This is what a shared store or a paired device would need; it is opt-in
 *   because turning it on without grants in place would break every caller.
 *
 * Neither mode authenticates. Binding a principal to a device key or a host
 * session is the remaining half, and it is not in this file.
 */
import { tx } from './db.mjs'
import { normalize } from './text.mjs'
import { ID_KINDS, principalId } from './principal-id.mjs'

export const PRINCIPAL_KINDS = ID_KINDS
export const AUTH_MODES = ['local', 'scoped']

/**
 * Actions a grant can name. A typo in a grant is a missing grant, never a wildcard.
 *
 * One verb per operation: `task:renew` and `task:reject` are here because the MCP
 * surface exposes them, and a verb that exists in the state machine but not in this
 * list is a tool that fails on a trusted install.
 */
export const ACTIONS = [
  'memory:write-global',
  'memory:read',
  'mailbox:claim',
  'mailbox:complete',
  'task:create',
  'task:assign',
  'task:accept',
  'task:renew',
  'task:return',
  'task:verify',
  'task:reject',
  'task:fail',
  'task:cancel',
  'task:retry',
]

/**
 * A principal is `{ kind, id, owner, project }`. `owner` and `project` narrow
 * where the principal may act; they are not credentials either, which is why the
 * authorization decision is a separate, visible step.
 */
export function normalizePrincipal(input = {}) {
  const id = normalize(input.id ?? input.agent ?? '')
  if (!id) return null
  const kind = PRINCIPAL_KINDS.includes(input.kind) ? input.kind : 'agent'
  return {
    kind,
    id,
    owner: input.owner ?? null,
    project: input.project ?? null,
  }
}

/**
 * Stable key for storage and grants.
 *
 * The format lives in `lib/principal-id.mjs` so the migration that repairs old rows
 * and the code that writes new ones cannot drift apart. In short: the owner is part
 * of the key (a name alone is not unique across partitions), and both the name and
 * the owner are length-prefixed so a name containing `:` cannot be re-read as a
 * different (name, owner) pair.
 *
 *   agent:6:runner:~        (no owner - the legacy single-user partition)
 *   agent:6:runner:4:team   (owner `team`)
 */
export function principalKey(principal) {
  return principalId({ kind: principal.kind, id: principal.id, owner: principal.owner ?? null })
}

export function principalFromConfig(config = {}) {
  return normalizePrincipal({
    kind: config.principalKind ?? 'agent',
    id: config.agent ?? 'agent',
    owner: config.owner ?? null,
    project: config.project ?? null,
  })
}

/** Record a principal so a grant can reference it and the trail can resolve it. */
export function upsertPrincipal(db, principal, at = Date.now()) {
  if (!principal) return { ok: false, reason: 'principal-required' }
  const key = principalKey(principal)
  return tx(db, () => {
    const row = db.prepare('select id, owner from acm_principals where id = ?').get(key)
    if (row) {
      // The key already contains the owner, so this is the same principal. Refuse
      // anyway if the stored owner disagrees: a row that changed owner underneath
      // this key would mean the key scheme is not what the caller thinks.
      if ((row.owner ?? null) !== (principal.owner ?? null)) {
        return { ok: false, reason: 'owner-mismatch', stored: row.owner, given: principal.owner }
      }
      db.prepare('update acm_principals set kind = ?, project = ? where id = ?')
        .run(principal.kind, principal.project, key)
      return { ok: true, id: key, updated: true }
    }
    db.prepare('insert into acm_principals (id, kind, owner, project, created_at) values (?, ?, ?, ?, ?)')
      .run(key, principal.kind, principal.owner, principal.project, at)
    return { ok: true, id: key }
  })
}

export function listPrincipals(db, { owner = null } = {}) {
  const rows = owner === null
    ? db.prepare('select id, kind, owner, project, created_at, revoked_at from acm_principals order by id').all()
    : db.prepare('select id, kind, owner, project, created_at, revoked_at from acm_principals where owner IS ? order by id').all(owner)
  return rows.map((r) => ({ ...r }))
}

/**
 * Grant one action to one principal. `target` optionally narrows the grant to a
 * project or an owner; `ttlMs` makes it expire, which is the only revocation that
 * works without the granting process being alive.
 */
export function grant(db, { principal, action, target = null, grantedBy = null, ttlMs = null, at = Date.now() } = {}) {
  if (!principal) return { ok: false, reason: 'principal-required' }
  if (!ACTIONS.includes(action)) return { ok: false, reason: 'unknown-action', actions: ACTIONS }
  // `upsertPrincipal` refuses a key whose stored owner disagrees with the caller's
  // principal. Ignoring that answer used to write the grant anyway, onto a key that
  // a different partition reads - the grant looked issued and authorised the wrong
  // principal. A refusal here means the store is not what the caller thinks.
  const recorded = upsertPrincipal(db, principal, at)
  if (!recorded.ok) return { ok: false, reason: recorded.reason, stored: recorded.stored, given: recorded.given }
  const key = recorded.id
  return tx(db, () => {
    const expires = ttlMs == null ? null : at + Number(ttlMs)
    const r = db.prepare(
      'insert into acm_grants (principal_id, action, target, granted_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?)',
    ).run(key, action, target, grantedBy, at, expires)
    return { ok: true, id: Number(r.lastInsertRowid), principal: key, expiresAt: expires }
  })
}

/** Revoke by grant id. Revocation is a timestamp, so the row survives as evidence. */
export function revokeGrant(db, { id, by = null, at = Date.now() } = {}) {
  const key = Number(id)
  if (!Number.isFinite(key)) return { ok: false, reason: 'id-required' }
  return tx(db, () => {
    const row = db.prepare('select id, revoked_at from acm_grants where id = ?').get(key)
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.revoked_at != null) return { ok: true, already: true, revokedAt: row.revoked_at }
    db.prepare('update acm_grants set revoked_at = ?, revoked_by = ? where id = ?').run(at, by, key)
    return { ok: true, revokedAt: at }
  })
}

export function listGrants(db, { principal = null, includeRevoked = false, at = Date.now() } = {}) {
  const rows = principal
    ? db.prepare('select * from acm_grants where principal_id = ? order by id').all(principalKey(principal))
    : db.prepare('select * from acm_grants order by id').all()
  const live = (r) => r.revoked_at == null && (r.expires_at == null || Number(r.expires_at) > at)
  return rows.filter((r) => includeRevoked || live(r)).map((r) => ({ ...r, live: live(r) }))
}

/**
 * Does this principal hold a live grant for this action?
 *
 * A grant with `target = null` covers any target; a grant with a target only
 * covers that exact target. That direction matters: forgetting a target would
 * otherwise widen the grant instead of narrowing it.
 *
 * Owner isolation comes from the key: `principalKey` embeds the owner, so a grant
 * written for `agent:runner` in one partition is a different row from the same name
 * in another. `target` narrows further (a project), it does not replace that.
 */
export function holdsGrant(db, principal, action, { target = null, at = Date.now() } = {}) {
  if (!principal) return false
  const rows = db.prepare(
    'select target, expires_at, revoked_at from acm_grants where principal_id = ? and action = ?',
  ).all(principalKey(principal), action)
  return rows.some((r) => {
    if (r.revoked_at != null) return false
    if (r.expires_at != null && Number(r.expires_at) <= at) return false
    if (r.target == null) return true
    return target != null && String(r.target) === String(target)
  })
}

/**
 * The single decision point. Callers get a reason, not a boolean, because the
 * reason is what an operator needs when a scoped store starts refusing work.
 */
/**
 * Does this principal hold *any* live grant for the action, whatever it targets?
 *
 * For a gate that must refuse a caller with no grant **before** it knows what it is
 * acting on, without also refusing a caller whose grant names a target it has not
 * looked up yet. `authorize(..., { target: null })` answers the wrong question there:
 * a grant targeted at `alpha` does not match "no target", so a legitimate caller was
 * refused before the precise check could run.
 */
export function holdsAnyGrant(db, principal, action, { at = Date.now() } = {}) {
  if (!principal) return false
  const rows = db.prepare(
    'select expires_at, revoked_at from acm_grants where principal_id = ? and action = ?',
  ).all(principalKey(principal), action)
  return rows.some((r) => {
    if (r.revoked_at != null) return false
    if (r.expires_at != null && Number(r.expires_at) <= at) return false
    return true
  })
}

export function authorize(db, principal, action, { mode = 'local', target = null, at = Date.now(), anyTarget = false } = {}) {
  if (!principal) return { ok: false, reason: 'principal-required', action, mode }
  if (!ACTIONS.includes(action)) return { ok: false, reason: 'unknown-action', action, mode }
  if (mode === 'local') return { ok: true, reason: 'local-trust', action, mode }
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: 'unknown-mode', action, mode }
  const held = anyTarget ? holdsAnyGrant(db, principal, action, { at }) : holdsGrant(db, principal, action, { target, at })
  if (held) return { ok: true, reason: 'granted', action, mode }
  return { ok: false, reason: 'no-grant', action, mode, principal: principalKey(principal) }
}

/** Throw the structured refusal so a tool surfaces it instead of continuing. */
export function requireAction(db, principal, action, opts = {}) {
  const decision = authorize(db, principal, action, opts)
  if (!decision.ok) {
    const err = new Error(`not authorized: ${action} (${decision.reason})`)
    err.code = 'not-authorized'
    err.decision = decision
    throw err
  }
  return decision
}
