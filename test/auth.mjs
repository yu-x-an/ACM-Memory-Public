// \u4E3B\u4F53\u3001\u6388\u6743\u4E0E\u62D2\u7EDD\uFF1A\u4E24\u79CD\u6A21\u5F0F\u90FD\u8981\u6709\u8BC1\u636E
//
// The authentication gap is not closed by this file - a principal is still a declaration. What it
// closes is the contract: one place decides, the decision carries a reason, a grant
// can expire and be revoked, and turning enforcement on actually changes behaviour.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { openDb } from '../lib/db.mjs'
import { TOOLS, mergeConfig } from '../lib/core.mjs'
import {
  ACTIONS, authorize, grant, holdsGrant, listGrants, listPrincipals, normalizePrincipal,
  principalFromConfig, principalKey, requireAction, revokeGrant, upsertPrincipal,
} from '../lib/auth.mjs'

const work = mkdtempSync(join(tmpdir(), 'acm-auth-'))
const db = openDb(join(work, 'memory.db'))

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const t0 = 1_800_000_000_000
const planner = normalizePrincipal({ kind: 'agent', id: 'planner', owner: 'team' })
const reviewer = normalizePrincipal({ kind: 'agent', id: 'reviewer', owner: 'team' })

ok('a principal needs an id', normalizePrincipal({ kind: 'agent' }) === null)
ok('an unknown kind degrades to agent, not to a privilege', normalizePrincipal({ kind: 'root', id: 'x' }).kind === 'agent')
ok('the storage key is typed, owner-bound and unambiguous', principalKey(planner) === 'agent:7:planner:4:team', principalKey(planner))
ok('a principal can be built from config',
  principalFromConfig({ agent: 'planner', owner: 'team', project: 'p1' }).project === 'p1')

// 1. Local mode: allowed, and honest about why
const local = authorize(db, planner, 'task:verify', { mode: 'local' })
ok('local mode allows the action', local.ok === true)
ok('and says it was trust in the machine, not a grant', local.reason === 'local-trust', local.reason)

// 2. Scoped mode: denied until a grant exists
const before = authorize(db, planner, 'task:verify', { mode: 'scoped' })
ok('scoped mode denies without a grant', before.ok === false && before.reason === 'no-grant', JSON.stringify(before))
ok('the refusal names the principal and the action',
  before.action === 'task:verify' && before.principal === principalKey(planner), JSON.stringify(before))

const granted = grant(db, { principal: planner, action: 'task:verify', grantedBy: 'owner', at: t0 })
ok('a grant can be written', granted.ok === true && Number.isFinite(granted.id), JSON.stringify(granted))
ok('the principal is recorded so the grant has a referent',
  listPrincipals(db).some((p) => p.id === principalKey(planner)))

const after = authorize(db, planner, 'task:verify', { mode: 'scoped', at: t0 + 1 })
ok('the grant turns the same decision around', after.ok === true && after.reason === 'granted', JSON.stringify(after))
ok('the grant does not leak to another action',
  authorize(db, planner, 'task:create', { mode: 'scoped', at: t0 + 1 }).ok === false)
ok('the grant does not leak to another principal',
  authorize(db, reviewer, 'task:verify', { mode: 'scoped', at: t0 + 1 }).ok === false)

// 3. Revocation and expiry
ok('grant state is queryable', holdsGrant(db, planner, 'task:verify', { at: t0 + 1 }) === true)
const revoked = revokeGrant(db, { id: granted.id, by: 'owner', at: t0 + 2 })
ok('a grant can be revoked', revoked.ok === true)
ok('revocation takes effect immediately',
  authorize(db, planner, 'task:verify', { mode: 'scoped', at: t0 + 3 }).reason === 'no-grant')
ok('the revoked row is kept as evidence',
  listGrants(db, { principal: planner, includeRevoked: true }).some((g) => Number(g.id) === granted.id && g.revoked_at != null))
ok('revoking twice is idempotent', revokeGrant(db, { id: granted.id, at: t0 + 4 }).already === true)

const shortLived = grant(db, { principal: planner, action: 'task:create', grantedBy: 'owner', ttlMs: 1000, at: t0 })
ok('a grant can expire', authorize(db, planner, 'task:create', { mode: 'scoped', at: t0 + 500 }).ok === true)
ok('and stops applying after its ttl',
  authorize(db, planner, 'task:create', { mode: 'scoped', at: t0 + 1500 }).reason === 'no-grant')
ok('the expired grant is not listed as live',
  !listGrants(db, { principal: planner, at: t0 + 1500 }).some((g) => Number(g.id) === shortLived.id))

// 4. Target narrowing must narrow, never widen
const scoped = grant(db, { principal: planner, action: 'memory:write-global', target: 'project-a', grantedBy: 'owner', at: t0 })
ok('a targeted grant covers its target',
  authorize(db, planner, 'memory:write-global', { mode: 'scoped', target: 'project-a', at: t0 + 1 }).ok === true)
ok('and does not cover a different one',
  authorize(db, planner, 'memory:write-global', { mode: 'scoped', target: 'project-b', at: t0 + 1 }).ok === false)
ok('and does not cover an unqualified call',
  authorize(db, planner, 'memory:write-global', { mode: 'scoped', at: t0 + 1 }).ok === false)
ok('the grant row records what it was narrowed to',
  listGrants(db, { principal: planner, at: t0 + 1 }).some((g) => Number(g.id) === scoped.id && g.target === 'project-a'))

// 5. Refusals are structured, and requireAction throws the same decision
const unknown = authorize(db, planner, 'task:everything', { mode: 'scoped', at: t0 })
ok('an unknown action is refused, never treated as a wildcard', unknown.ok === false && unknown.reason === 'unknown-action')
ok('a missing principal is refused', authorize(db, null, 'task:create').reason === 'principal-required')
ok('an unknown mode is refused rather than defaulting to allow',
  authorize(db, planner, 'task:create', { mode: 'yolo', at: t0 }).reason === 'unknown-mode')

let thrown = null
try {
  requireAction(db, reviewer, 'task:verify', { mode: 'scoped', at: t0 })
} catch (err) { thrown = err }
ok('requireAction throws instead of continuing', thrown?.code === 'not-authorized', String(thrown))
ok('the thrown error carries the decision', thrown?.decision?.reason === 'no-grant', JSON.stringify(thrown?.decision))
// The earlier grant was revoked, so this needs a fresh one: a passing path that
// reused a revoked grant would prove nothing.
grant(db, { principal: planner, action: 'task:verify', grantedBy: 'owner', at: t0 + 9 })
ok('and passes when a live grant exists',
  requireAction(db, planner, 'task:verify', { mode: 'scoped', at: t0 + 10 }).reason === 'granted')

// 6. A principal with no owner is its own partition, not a wildcard
const anon = normalizePrincipal({ kind: 'agent', id: 'wanderer' })
ok('no owner means the null partition', anon.owner === null)
ok('a null-owner principal has its own key shape', principalKey(anon) === 'agent:8:wanderer:~', principalKey(anon))
upsertPrincipal(db, anon, t0)
ok('upserting twice updates instead of duplicating',
  upsertPrincipal(db, anon, t0 + 1).updated === true &&
  listPrincipals(db).filter((p) => p.id === principalKey(anon)).length === 1)

// 7. The same agent name in two partitions is two principals
{
  const a = normalizePrincipal({ kind: 'agent', id: 'runner', owner: 'team-a' })
  const b = normalizePrincipal({ kind: 'agent', id: 'runner', owner: 'team-b' })
  ok('same name, different owner, different key', principalKey(a) !== principalKey(b),
    `${principalKey(a)} vs ${principalKey(b)}`)
  ok('a name may contain the separator without colliding',
    principalKey(normalizePrincipal({ kind: 'agent', id: 'a:b', owner: null })) !== principalKey(normalizePrincipal({ kind: 'agent', id: 'a', owner: 'b' })),
    'length prefix keeps (name, owner) unambiguous')

  const grantedA = grant(db, { principal: a, action: 'task:verify', grantedBy: 'ownerA', at: t0 })
  ok('a grant in one partition does not authorise the same name in another',
    authorize(db, b, 'task:verify', { mode: 'scoped', at: t0 + 1 }).ok === false,
    JSON.stringify(authorize(db, b, 'task:verify', { mode: 'scoped', at: t0 + 1 })))
  ok('and still authorises its own partition',
    authorize(db, a, 'task:verify', { mode: 'scoped', at: t0 + 1 }).ok === true)

  const grantedB = grant(db, { principal: b, action: 'task:verify', grantedBy: 'ownerB', at: t0 })
  revokeGrant(db, { id: grantedA.id, by: 'ownerA', at: t0 + 2 })
  ok('revoking one partition\u2019s grant leaves the other alone',
    authorize(db, a, 'task:verify', { mode: 'scoped', at: t0 + 3 }).ok === false &&
    authorize(db, b, 'task:verify', { mode: 'scoped', at: t0 + 3 }).ok === true,
    `A=${authorize(db, a, 'task:verify', { mode: 'scoped', at: t0 + 3 }).ok} B=${authorize(db, b, 'task:verify', { mode: 'scoped', at: t0 + 3 }).ok}`)
  ok('the two principals are separate rows',
    listPrincipals(db).filter((p) => p.kind === 'agent' && p.owner === 'team-a').length === 1 &&
    listPrincipals(db).filter((p) => p.kind === 'agent' && p.owner === 'team-b').length === 1)
  ok('re-granting for B did not move A\u2019s row',
    listPrincipals(db).find((p) => p.id === principalKey(a))?.owner === 'team-a')
  ok('a grant id from one partition cannot revoke the other',
    revokeGrant(db, { id: grantedB.id, by: 'ownerA', at: t0 + 4 }).ok === true &&
    authorize(db, a, 'task:verify', { mode: 'scoped', at: t0 + 5 }).ok === false)
}

// 8. Every action a tool requires must exist in the allowlist.
// This is the check that would have caught `task:accept` being missing: the tool
// compiled, the tests called the module directly, and only the tool path failed.
{
  const src = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  // Two ways a tool names an action: directly through `requireActionFor`, or through
  // `taskGate`, which authorizes against the task it loaded. A scan that only knew
  // about the first would miss every task verb now that they go through the gate.
  const used = [
    ...[...src.matchAll(/requireActionFor\(db, config, '([a-z:-]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/taskGate\(db, config, '([a-z:-]+)'/g)].map((m) => m[1]),
  ]
  const missing = [...new Set(used)].filter((a) => !ACTIONS.includes(a))
  ok('every action a tool requires is in ACTIONS', missing.length === 0, `missing: ${missing.join(',')}`)
  ok('the core requires the task verbs separately, not borrowed ones',
    ['task:create', 'task:assign', 'task:accept', 'task:renew', 'task:return', 'task:verify', 'task:reject', 'task:fail', 'task:cancel', 'task:retry']
      .every((a) => used.includes(a)),
    `used: ${[...new Set(used)].join(',')}`)
}

// 9. The tool path itself, in both modes.
// Calling the module functions directly is what hid the missing action, so these
// go through TOOLS.find(...).run(), which is what an MCP client actually reaches.
{
  const toolDb = openDb(join(work, 'tools.db'))
  const local = mergeConfig({ dbPath: join(work, 'tools.db'), agent: 'planner' })
  const call = (name, args, config = local) => TOOLS.find((t) => t.name === name).run(args, { db: toolDb, config, sessionId: 's' })

  const created = await call('acm_task_create', { title: 'tool path', assignee: 'runner' })
  ok('the create tool works in local mode', created.ok === true, JSON.stringify(created).slice(0, 100))
  const runnerConfig = mergeConfig({ dbPath: join(work, 'tools.db'), agent: 'runner' })
  const accepted = await call('acm_task_accept', { key: created.task.key }, runnerConfig)
  ok('the accept tool works in local mode', accepted.ok === true && accepted.task.state === 'running',
    JSON.stringify(accepted).slice(0, 140))
  const returned = await call('acm_task_return', {
    key: created.task.key, result: 'done', evidence: 'test:npm run test:all',
  }, runnerConfig)
  ok('the return tool parses kind:ref evidence', returned.ok === true && returned.task.evidence.length === 1,
    JSON.stringify(returned).slice(0, 140))
  const reviewerConfig = mergeConfig({ dbPath: join(work, 'tools.db'), agent: 'reviewer' })
  const verified = await call('acm_task_verify', { key: created.task.key }, reviewerConfig)
  ok('the verify tool works in local mode', verified.ok === true && verified.task.state === 'verified')
  const failed = await call('acm_task_fail', { key: created.task.key, reason: 'too late' }, reviewerConfig)
  ok('the fail tool reports a state refusal instead of succeeding', failed.ok === false && failed.reason === 'bad-state',
    JSON.stringify(failed).slice(0, 120))

  // scoped: the same calls are refused until a grant exists
  const scoped = mergeConfig({ dbPath: join(work, 'tools.db'), agent: 'planner', auth: { mode: 'scoped' } })
  let denied = null
  try { await call('acm_task_create', { title: 'denied' }, scoped) } catch (err) { denied = err }
  ok('scoped mode refuses a tool call without a grant', denied?.code === 'not-authorized', String(denied))
  const scopedPrincipal = principalFromConfig(scoped)
  grant(toolDb, { principal: scopedPrincipal, action: 'task:create', grantedBy: 'owner', at: Date.now() })
  const allowed = await call('acm_task_create', { title: 'granted' }, scoped)
  ok('the same call succeeds once the grant exists', allowed.ok === true, JSON.stringify(allowed).slice(0, 100))
  toolDb.close()
}

// 10. Authorization binds to the task's own project, not the caller's configured one.
// The version before this asked "may this principal do `task:verify` in its own
// project?", then loaded the task by owner only - so a grant scoped to `beta`
// verified a task in `alpha`. Every transition goes through the same gate now, and
// the negative cases are the point of this section.
{
  const projPath = join(work, 'projects.db')
  const projDb = openDb(projPath)
  const base = { dbPath: projPath, owner: null, principalKind: 'agent', budget: 1200, personaFiles: [] }
  const cfg = (agent, project, mode = 'scoped') => mergeConfig({ ...base, agent, project, auth: { mode } })
  const call = (name, args, config) => TOOLS.find((t) => t.name === name).run(args, { db: projDb, config, sessionId: 's' })
  const attempt = async (name, args, config) => {
    try { return await call(name, args, config) } catch (err) { return { thrown: err.message, code: err.code } }
  }

  const planner = cfg('planner', 'alpha')
  const worker = cfg('worker', 'alpha')
  const reviewer = cfg('reviewer', 'alpha')
  grant(projDb, { principal: principalFromConfig(planner), action: 'task:create', target: 'alpha', grantedBy: 'owner' })
  grant(projDb, { principal: principalFromConfig(planner), action: 'task:assign', target: 'alpha', grantedBy: 'owner' })
  for (const action of ['task:accept', 'task:renew', 'task:return']) {
    grant(projDb, { principal: principalFromConfig(worker), action, target: 'alpha', grantedBy: 'owner' })
  }

  const created = await call('acm_task_create', { title: 'alpha work', assignee: 'worker' }, planner)
  ok('the planner creates a task inside its own project', created.ok === true && created.task.project === 'alpha',
    JSON.stringify(created).slice(0, 120))
  const key = created.task.key
  ok('the worker accepts it', (await call('acm_task_accept', { key }, worker)).ok === true)
  const renewed = await call('acm_task_renew', { key, leaseMs: 120000 }, worker)
  ok('the worker can renew over MCP', renewed.ok === true && renewed.task.state === 'running',
    JSON.stringify(renewed).slice(0, 120))
  ok('a lease outside the bounds is refused over MCP',
    (await call('acm_task_renew', { key, leaseMs: 10 }, worker)).reason === 'lease-out-of-range')
  const returned = await call('acm_task_return', { key, result: 'done', evidence: 'test:npm test' }, worker)
  ok('the worker returns with evidence', returned.ok === true && returned.task.state === 'returned')

  // A reviewer granted only in `beta`
  const betaReviewer = cfg('reviewer', 'beta')
  grant(projDb, { principal: principalFromConfig(betaReviewer), action: 'task:verify', target: 'beta', grantedBy: 'owner' })
  const crossed = await attempt('acm_task_verify', { key }, betaReviewer)
  const crossedUnknown = await attempt('acm_task_verify', { key: 'T-unknown-2222' }, betaReviewer)
  ok('a beta-scoped reviewer cannot verify an alpha task',
    crossed.ok === false && crossed.reason === 'not-found', JSON.stringify(crossed).slice(0, 160))
  // `project-mismatch` used to answer "this key exists, somewhere else", which is a
  // directory when paired with `not-found` for a key that does not exist.
  ok('and cannot tell that task apart from a key that does not exist',
    JSON.stringify(crossed) === JSON.stringify(crossedUnknown),
    `${JSON.stringify(crossed)} vs ${JSON.stringify(crossedUnknown)}`)

  // A reviewer with no declared project, and a beta grant: the grant must be matched
  // against the task's project, not against "no target".
  const unscopedReviewer = cfg('reviewer', null)
  grant(projDb, { principal: principalFromConfig(unscopedReviewer), action: 'task:verify', target: 'beta', grantedBy: 'owner' })
  const byTarget = await attempt('acm_task_verify', { key }, unscopedReviewer)
  const unknownKey = await attempt('acm_task_verify', { key: 'T-unknown-0000' }, unscopedReviewer)
  // A refusal that differs from "no such task" is a directory: it tells the caller
  // that this key exists, in a project it may not touch.
  ok('a beta grant cannot cover an alpha task, and the refusal is indistinguishable from an unknown key',
    JSON.stringify(byTarget) === JSON.stringify(unknownKey) && byTarget.reason === 'not-found',
    `${JSON.stringify(byTarget)} vs ${JSON.stringify(unknownKey)}`)

  // A reviewer declared alpha but granted only beta - the same refusal from the other side.
  const wrongGrant = cfg('reviewer', 'alpha')
  grant(projDb, { principal: principalFromConfig(wrongGrant), action: 'task:verify', target: 'beta', grantedBy: 'owner' })
  const byGrant = await attempt('acm_task_verify', { key }, wrongGrant)
  ok('a project-scoped grant does not cover the caller’s own project by accident',
    byGrant.code === 'not-authorized' && /no-grant/.test(byGrant.thrown), JSON.stringify(byGrant))

  const ownGrant = cfg('reviewer', 'alpha')
  grant(projDb, { principal: principalFromConfig(ownGrant), action: 'task:verify', target: 'alpha', grantedBy: 'owner' })
  const verified = await call('acm_task_verify', { key, note: 'checked' }, ownGrant)
  ok('a reviewer granted in the task’s project verifies it', verified.ok === true && verified.task.state === 'verified')

  // A caller that declares **no** project, holding a grant that names the task's
  // project. The gate's pre-load check used to authorize against "no target", which
  // a grant targeted at `alpha` does not satisfy, so the legitimate caller was
  // refused before the task was read - the exact opposite of the documented rule
  // that a caller with no declared project is governed by its grants.
  const anonReviewer = cfg('reviewer-anon', null)
  grant(projDb, { principal: principalFromConfig(anonReviewer), action: 'task:verify', target: 'alpha', grantedBy: 'owner' })
  {
    const fresh = await call('acm_task_create', { title: 'alpha work, second', assignee: 'worker' }, planner)
    await call('acm_task_accept', { key: fresh.task.key }, worker)
    await call('acm_task_return', { key: fresh.task.key, result: 'done', evidence: 'note:x' }, worker)
    const positive = await attempt('acm_task_verify', { key: fresh.task.key }, anonReviewer)
    ok('a caller with no declared project may act through a grant targeted at the task project',
      positive.ok === true && positive.task.state === 'verified', JSON.stringify(positive).slice(0, 160))
  }

  // A task with no project belongs to no project. The version of the gate before
  // this only compared projects when both were non-null, so an alpha-scoped
  // reviewer verified a NULL-project task - the task was "in" whatever project the
  // caller happened to declare. NULL is not a wildcard.
  {
    const freePlanner = cfg('planner-free', null)
    const freeWorker = cfg('worker-free', null)
    grant(projDb, { principal: principalFromConfig(freePlanner), action: 'task:create', grantedBy: 'owner' })
    grant(projDb, { principal: principalFromConfig(freeWorker), action: 'task:accept', target: null, grantedBy: 'owner' })
    grant(projDb, { principal: principalFromConfig(freeWorker), action: 'task:return', target: null, grantedBy: 'owner' })
    const freeTask = await call('acm_task_create', { title: 'no project', assignee: 'worker-free' }, freePlanner)
    ok('a task can exist outside every project', freeTask.ok === true && freeTask.task.project === null,
      JSON.stringify(freeTask).slice(0, 120))
    const freeKey = freeTask.task.key
    await call('acm_task_accept', { key: freeKey }, freeWorker)
    const freeReturned = await call('acm_task_return', { key: freeKey, result: 'r', evidence: 'note:x' }, freeWorker)
    ok('the project-less task reaches returned', freeReturned.ok === true && freeReturned.task.state === 'returned')

    // The alpha reviewer holds an alpha-targeted verify grant from the cases above.
    const before = await call('acm_task_get', { key: freeKey }, reviewer)
    const reachNull = await attempt('acm_task_verify', { key: freeKey }, reviewer)
    const nullUnknown = await attempt('acm_task_verify', { key: 'T-unknown-3333' }, reviewer)
    ok('a project-scoped reviewer cannot verify a NULL-project task, nor tell it from an unknown key',
      reachNull.reason === 'not-found' && JSON.stringify(reachNull) === JSON.stringify(nullUnknown),
      `${JSON.stringify(reachNull)} vs ${JSON.stringify(nullUnknown)}`)
    const after = await call('acm_task_get', { key: freeKey }, reviewer)
    ok('and the refused call changed nothing about the task',
      JSON.stringify(before.task) === JSON.stringify(after.task) &&
      before.events.length === after.events.length,
      `events ${before.events.length} -> ${after.events.length}`)
  }

  // A grant with no target covers any target *for the principal it was issued to* -
  // it does not turn a caller declared for one project into a caller for another.
  // This is the case a caller-configured target check cannot catch: the grant is
  // wide, so authorization succeeds, and only the loaded task's project stops it.
  {
    const wide = cfg('reviewer', 'alpha')
    grant(projDb, { principal: principalFromConfig(wide), action: 'task:verify', grantedBy: 'owner' })
    const betaPlanner = cfg('planner-beta', 'beta')
    const betaWorker = cfg('worker-beta', 'beta')
    grant(projDb, { principal: principalFromConfig(betaPlanner), action: 'task:create', target: 'beta', grantedBy: 'owner' })
    grant(projDb, { principal: principalFromConfig(betaWorker), action: 'task:accept', target: 'beta', grantedBy: 'owner' })
    grant(projDb, { principal: principalFromConfig(betaWorker), action: 'task:return', target: 'beta', grantedBy: 'owner' })
    const betaTask = await call('acm_task_create', { title: 'beta work', assignee: 'worker-beta' }, betaPlanner)
    ok('a beta planner creates a task in beta',
      betaTask.ok === true && betaTask.task.project === 'beta', JSON.stringify(betaTask).slice(0, 120))
    const betaKey = betaTask.task.key
    // Bring it to `returned`, so that a cross-project verify would otherwise succeed:
    // a refusal that only holds because the task is not ready proves nothing.
    await call('acm_task_accept', { key: betaKey }, betaWorker)
    const betaReturned = await call('acm_task_return', { key: betaKey, result: 'beta result', evidence: 'note:beta' }, betaWorker)
    ok('the beta task is ready to be verified', betaReturned.ok === true && betaReturned.task.state === 'returned',
      betaReturned.task?.state ?? JSON.stringify(betaReturned).slice(0, 100))
    const reach = await attempt('acm_task_verify', { key: betaKey }, wide)
    const reachUnknown = await attempt('acm_task_verify', { key: 'T-unknown-4444' }, wide)
    ok('an untargeted grant does not let an alpha caller touch a beta task, and the answer is an unknown key’s answer',
      reach.reason === 'not-found' && JSON.stringify(reach) === JSON.stringify(reachUnknown),
      `${JSON.stringify(reach)} vs ${JSON.stringify(reachUnknown)}`)
    // The project-less caller from the case above is bound by its grant, not
    // unbound by declaring nothing: alpha does not cover beta.
    const anonOnBeta = await attempt('acm_task_verify', { key: betaKey }, anonReviewer)
    const anonOnUnknown = await attempt('acm_task_verify', { key: 'T-unknown-1111' }, anonReviewer)
    ok('a project-less caller cannot tell a task it may not touch from a key that does not exist',
      JSON.stringify(anonOnBeta) === JSON.stringify(anonOnUnknown) && anonOnBeta.reason === 'not-found',
      `${JSON.stringify(anonOnBeta)} vs ${JSON.stringify(anonOnUnknown)}`)
    // The refusal itself must not be the only thing asserted: a check that looks at
    // the answer but not at the task would pass a gate that refused *after* mutating.
    const betaAfter = await call('acm_task_get', { key: betaKey }, betaPlanner)
    ok('the refused verify left the beta task exactly as it was',
      betaAfter.task.state === 'returned' && betaAfter.task.version === betaReturned.task.version,
      `state ${betaAfter.task.state}, version ${betaAfter.task.version} (was ${betaReturned.task.version})`)
  }

  // Declaring a project is a boundary even in local mode: a caller that says it acts
  // in `beta` must not mutate an `alpha` task just because this machine is trusted.
  const localBeta = cfg('reviewer', 'beta', 'local')
  const localCross = await attempt('acm_task_reject', { key, reason: 'nope' }, localBeta)
  ok('a declared project is respected in local mode too',
    localCross.ok === false && localCross.reason === 'project-mismatch', JSON.stringify(localCross).slice(0, 160))
  // The trusted machine keeps the useful diagnostic, and it still does not name the
  // other project: `callerProject` is the caller's own declaration.
  ok('and the local diagnostic still does not name the task’s project',
    localCross.taskProject === undefined, JSON.stringify(localCross).slice(0, 160))

  ok('an unknown task is reported before any transition runs',
    (await attempt('acm_task_verify', { key: 'T-nope-0000' }, ownGrant)).reason === 'not-found')
  projDb.close()
}

// 11. Rejection is reachable from the tool surface, which it was not before.
{
  const rejPath = join(work, 'reject.db')
  const rejDb = openDb(rejPath)
  const plain = mergeConfig({ dbPath: rejPath, agent: 'runner', budget: 1200, personaFiles: [], auth: { mode: 'local' } })
  const reviewerCfg = mergeConfig({ dbPath: rejPath, agent: 'reviewer', budget: 1200, personaFiles: [], auth: { mode: 'local' } })
  const call = (name, args, config) => TOOLS.find((t) => t.name === name).run(args, { db: rejDb, config, sessionId: 's' })
  const created = await call('acm_task_create', { title: 'reject me', assignee: 'runner' }, plain)
  const key = created.task.key
  await call('acm_task_accept', { key }, plain)
  await call('acm_task_return', { key, result: 'first go', evidence: 'note:looks fine' }, plain)
  const rejected = await call('acm_task_reject', { key, reason: 'evidence does not cover the second case' }, reviewerCfg)
  ok('reject over the tool surface sends the task back',
    rejected.ok === true && rejected.task.state === 'assigned' && rejected.task.lastReason.includes('second case'),
    JSON.stringify(rejected).slice(0, 160))
  ok('a rejection without a reason is refused',
    (await call('acm_task_reject', { key }, reviewerCfg)).reason === 'reason-required')
  rejDb.close()
}

db.close()
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

console.log(failures.length ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25` : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
