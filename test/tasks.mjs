// \u4EFB\u52A1\u72B6\u6001\u673A\uFF1A\u8F6C\u79FB\u3001\u7ADE\u6001\u3001\u4F9D\u8D56\u3001\u79DF\u7EA6\u4E0E\u8BC1\u636E
//
// The claim this state machine makes: a task is not a message with a `done` flag. These cases
// are the difference: an illegal transition is refused, a lost race reports itself,
// a dependency blocks work rather than being a comment, an expired lease is
// visible, and returning work without evidence is not accepted.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db.mjs'
import {
  acceptTask, assignTask, cancelTask, confirmTask, createTask, expireLease, expireLeases, failTask, getTask,
  listTasks, rejectTask, renewTask, retryTask, returnTask, taskEvents, verifyTask,
} from '../lib/tasks.mjs'

const work = mkdtempSync(join(tmpdir(), 'acm-tasks-'))
const dbPath = join(work, 'memory.db')
const db = openDb(dbPath)

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const t0 = 1_800_000_000_000

// 1. Creation, assignment and acceptance
const created = createTask(db, { title: 'summarise the deploy policy', createdBy: 'planner', at: t0 })
ok('a new task starts open', created.ok && created.task.state === 'open', JSON.stringify(created).slice(0, 120))
const key = created.task.key
ok('the key is addressable and unique-shaped', /^T-[a-z0-9]+-[a-z0-9]{4}$/.test(key), key)

ok('assigning sets the assignee', assignTask(db, { key, assignee: 'runner', actor: 'planner', at: t0 + 1 }).ok)
const accepted = acceptTask(db, { key, actor: 'runner', leaseMs: 60_000, at: t0 + 2 })
ok('accepting starts the work and counts the attempt',
  accepted.ok && accepted.task.state === 'running' && accepted.task.attempts === 1 && accepted.task.leaseUntil === t0 + 2 + 60_000,
  JSON.stringify(accepted.task ?? accepted).slice(0, 160))

// 2. Only the assignee may act
const outsider = returnTask(db, { key, actor: 'someone-else', result: 'done', evidence: [{ kind: 'note', ref: 'x' }], at: t0 + 3 })
ok('an agent that does not hold the task cannot return it',
  outsider.ok === false && outsider.reason === 'not-assignee', JSON.stringify(outsider))

// 3. Evidence is required, and so is a result
const noEvidence = returnTask(db, { key, actor: 'runner', result: 'all good', at: t0 + 4 })
ok('returning without evidence is refused',
  noEvidence.ok === false && noEvidence.reason === 'evidence-required', JSON.stringify(noEvidence))
const badEvidence = returnTask(db, { key, actor: 'runner', result: 'all good', evidence: [{ kind: 'vibes', ref: 'x' }], at: t0 + 4 })
ok('evidence of an unknown kind is refused',
  badEvidence.ok === false && badEvidence.reason === 'evidence-required', JSON.stringify(badEvidence))

// 4. Return, self-verification refusal, verification by someone else
const returned = returnTask(db, {
  key, actor: 'runner', result: 'the window is Wednesday 03:00 UTC',
  evidence: [{ kind: 'test', ref: 'npm run test:all' }, { kind: 'commit', ref: 'abc1234' }],
  at: t0 + 5,
})
ok('returning stores the result and its evidence',
  returned.ok && returned.task.state === 'returned' && returned.task.evidence.length === 2,
  JSON.stringify(returned.task?.evidence))

const selfVerify = verifyTask(db, { key, actor: 'runner', at: t0 + 6 })
ok('the author cannot verify their own work',
  selfVerify.ok === false && selfVerify.reason === 'self-verification-refused', JSON.stringify(selfVerify))

const verified = verifyTask(db, { key, actor: 'reviewer', note: 'checked the commit', at: t0 + 7 })
ok('a different principal verifies it', verified.ok && verified.task.state === 'verified' && verified.task.verifiedBy === 'reviewer')
ok('verification closes the task', verified.task.closedAt === t0 + 7)

const again = verifyTask(db, { key, actor: 'reviewer', at: t0 + 8 })
ok('re-verifying by the same principal is idempotent', again.ok && again.already === true, JSON.stringify(again))
const otherVerify = verifyTask(db, { key, actor: 'intruder', at: t0 + 8 })
ok('a second principal cannot re-verify someone else\u2019s approval',
  otherVerify.ok === false && otherVerify.reason === 'verified-by-someone-else', JSON.stringify(otherVerify))

// 5. The trail is append-only and describes every transition
const events = taskEvents(db, { key })
ok('every transition is in the trail',
  events.map((e) => e.action).join(',') === 'create,assign,accept,return,verify', events.map((e) => e.action).join(','))
ok('the trail records who acted', events.every((e) => typeof e.actor === 'string' && e.actor.length > 0))
let tamper = 'accepted'
try {
  db.prepare("update acm_task_events set action = 'create' where task_key = ?").run(key)
  tamper = 'the row changed'
} catch { tamper = 'refused' }
ok('the trail cannot be edited', tamper === 'refused', tamper)
let removed = 'accepted'
try {
  db.prepare('delete from acm_task_events where task_key = ?').run(key)
  removed = 'the row was deleted'
} catch { removed = 'refused' }
ok('the trail cannot be deleted', removed === 'refused', removed)

// 6. A lost race is reported, not overwritten
{
  const second = createTask(db, { title: 'race me', createdBy: 'planner', assignee: 'runner', at: t0 + 10 })
  const stale = getTask(db, { key: second.task.key })
  const first = acceptTask(db, { key: second.task.key, actor: 'runner', at: t0 + 11 })
  ok('the first acceptance wins', first.ok === true, JSON.stringify(first))
  // Simulate a caller that read the row before the winner committed.
  const racer = acceptTask(db, { key: second.task.key, actor: 'runner', at: t0 + 12 })
  ok('a second acceptance from the same state is refused by the state machine',
    racer.ok === false && racer.reason === 'bad-state' && racer.state === 'running', JSON.stringify(racer))
  ok('the stale read is visible as stale', stale.version === 1 && first.task.version === 2, `${stale.version} -> ${first.task.version}`)
}

// 7. Dependencies gate the start, not the assignment
{
  const a = createTask(db, { title: 'produce the evidence', createdBy: 'planner', at: t0 + 20 })
  const b = createTask(db, { title: 'review the evidence', createdBy: 'planner', dependsOn: [a.task.key], assignee: 'runner', at: t0 + 21 })
  ok('a task may depend on another', b.ok === true, JSON.stringify(b).slice(0, 140))
  const blocked = acceptTask(db, { key: b.task.key, actor: 'runner', at: t0 + 22 })
  ok('work cannot start while a dependency is unverified',
    blocked.ok === false && blocked.reason === 'dependency-open', JSON.stringify(blocked))

  assignTask(db, { key: a.task.key, assignee: 'runner', actor: 'planner', at: t0 + 23 })
  acceptTask(db, { key: a.task.key, actor: 'runner', at: t0 + 24 })
  returnTask(db, { key: a.task.key, actor: 'runner', result: 'evidence attached', evidence: [{ kind: 'note', ref: 'n1' }], at: t0 + 25 })
  verifyTask(db, { key: a.task.key, actor: 'reviewer', at: t0 + 26 })
  const unblocked = acceptTask(db, { key: b.task.key, actor: 'runner', at: t0 + 27 })
  ok('the dependency stops blocking once it is verified', unblocked.ok === true, JSON.stringify(unblocked))
}

// 8. Lease expiry makes a dead agent's work reclaimable
{
  const t = createTask(db, { title: 'long job', createdBy: 'planner', assignee: 'runner', at: t0 + 30 })
  acceptTask(db, { key: t.task.key, actor: 'runner', leaseMs: 1000, at: t0 + 31 })
  const early = expireLeases(db, { at: t0 + 31 + 500 })
  ok('a live lease is not expired', early.expired.length === 0, JSON.stringify(early))
  const late = expireLeases(db, { at: t0 + 31 + 2000 })
  ok('an expired lease is reported', late.expired.includes(t.task.key), JSON.stringify(late))
  const after = getTask(db, { key: t.task.key })
  ok('expiry is its own state, not a failure', after.state === 'expired' && after.lastReason === 'lease-expired', after.state)
  const retried = retryTask(db, { key: t.task.key, actor: 'planner', at: t0 + 40 })
  ok('an expired task can be explicitly retried', retried.ok && retried.task.state === 'assigned', JSON.stringify(retried).slice(0, 120))
  const renewed = renewTask(db, { key: key.replace('x', 'x'), actor: 'nobody', at: t0 + 41 })
  ok('renewing someone else\u2019s lease is refused', renewed.ok === false, JSON.stringify(renewed))
}

// 8b. The lease is a deadline, not a decoration
{
  const t = createTask(db, { title: 'deadline', createdBy: 'planner', assignee: 'runner', at: t0 + 80 })
  acceptTask(db, { key: t.task.key, actor: 'runner', leaseMs: 1000, at: t0 + 81 })
  // No sweep has run, so the row is still `running` with a deadline in the past.
  const late = t0 + 81 + 5000
  const renew = renewTask(db, { key: t.task.key, actor: 'runner', leaseMs: 60000, at: late })
  ok('renewing after the deadline is refused', renew.ok === false && renew.reason === 'lease-expired', JSON.stringify(renew))
  const ret = returnTask(db, { key: t.task.key, actor: 'runner', result: 'late', evidence: [{ kind: 'note', ref: 'x' }], at: late + 1 })
  ok('returning after the deadline is refused', ret.ok === false && ret.reason === 'lease-expired', JSON.stringify(ret))
  const fail = failTask(db, { key: t.task.key, actor: 'runner', reason: 'late', at: late + 2 })
  ok('failing after the deadline is refused too', fail.ok === false && fail.reason === 'lease-expired', JSON.stringify(fail))
  const other = acceptTask(db, { key: t.task.key, actor: 'runner', at: late + 3 })
  ok('the holder cannot re-accept a task whose lease ran out',
    other.ok === false && other.reason === 'lease-expired' && typeof other.hint === 'string', JSON.stringify(other))
  ok('the task is still running until something expires it', getTask(db, { key: t.task.key }).state === 'running')
  const swept = expireLeases(db, { at: late + 4 })
  ok('the sweep then moves it to expired', swept.expired.includes(t.task.key))
  ok('and it is retryable again', retryTask(db, { key: t.task.key, actor: 'planner', at: late + 5 }).ok === true)
}

// 8c. A renewal that lands before the deadline must survive a later sweep.
// This is the interleaving the reviewer asked for: select at T, renew at T+1,
// sweep at T+2 with the *old* deadline.
{
  const t = createTask(db, { title: 'interleaving', createdBy: 'planner', assignee: 'runner', at: t0 + 100 })
  acceptTask(db, { key: t.task.key, actor: 'runner', leaseMs: 1000, at: t0 + 101 })
  const renewed = renewTask(db, { key: t.task.key, actor: 'runner', leaseMs: 60000, at: t0 + 101 + 900 })
  ok('a renewal before the deadline is accepted', renewed.ok === true, JSON.stringify(renewed).slice(0, 100))
  const swept = expireLeases(db, { at: t0 + 101 + 1500 })
  ok('a later sweep does not undo the renewal',
    !swept.expired.includes(t.task.key) && getTask(db, { key: t.task.key }).state === 'running',
    JSON.stringify(swept))
  const lateButValid = returnTask(db, { key: t.task.key, actor: 'runner', result: 'ok', evidence: [{ kind: 'note', ref: 'n' }], at: t0 + 101 + 2000 })
  ok('the renewed holder can still return inside the new window', lateButValid.ok === true, JSON.stringify(lateButValid).slice(0, 100))
}

// 8d. The sweep must not expire a task that was renewed *after* the sweep looked.
// The version of 8c above renews before the SELECT, which is not the interleaving
// the review described. This one is: the row is expired when the sweep reads it,
// the worker renews, and only then does the sweep apply its decision. Without the
// deadline in the UPDATE predicate this transition expires a live task, and its
// worker's next return fails with `bad-state`.
{
  const t = createTask(db, { title: 'renewed under the sweep', createdBy: 'planner', assignee: 'runner', at: t0 + 120 })
  acceptTask(db, { key: t.task.key, actor: 'runner', leaseMs: 1000, at: t0 + 121 })
  const sweepAt = t0 + 121 + 1000
  // The renewal was issued one millisecond before the deadline and arrives late.
  const renewed = renewTask(db, { key: t.task.key, actor: 'runner', leaseMs: 60000, at: sweepAt - 1 })
  ok('a renewal issued before the deadline still lands', renewed.ok === true, JSON.stringify(renewed).slice(0, 120))
  const late = expireLease(db, { key: t.task.key, at: sweepAt })
  ok('the sweep refuses to expire a lease that moved on',
    late.ok === false && late.reason === 'lease-renewed', JSON.stringify(late))
  ok('and the task is still running', getTask(db, { key: t.task.key }).state === 'running')
  const swept = expireLeases(db, { at: sweepAt })
  ok('a fresh select sees nothing to expire',
    swept.expired.length === 0 && getTask(db, { key: t.task.key }).state === 'running', JSON.stringify(swept))
}

// 8e. Renewal is public, bounded, and only the holder may use it
{
  const t = createTask(db, { title: 'long job', createdBy: 'planner', assignee: 'runner', at: t0 + 130 })
  acceptTask(db, { key: t.task.key, actor: 'runner', leaseMs: 1000, at: t0 + 131 })
  const firstDeadline = getTask(db, { key: t.task.key }).leaseUntil
  const extended = renewTask(db, { key: t.task.key, actor: 'runner', leaseMs: 60000, at: t0 + 131 + 500 })
  ok('the holder can extend its own lease',
    extended.ok === true && extended.task.leaseUntil > firstDeadline, JSON.stringify(extended).slice(0, 120))
  ok('someone else cannot extend it',
    renewTask(db, { key: t.task.key, actor: 'intruder', leaseMs: 60000, at: t0 + 131 + 600 }).reason === 'not-assignee')
  ok('a zero lease is refused rather than accepted as instant expiry',
    renewTask(db, { key: t.task.key, actor: 'runner', leaseMs: 0, at: t0 + 131 + 700 }).reason === 'lease-out-of-range')
  ok('a lease longer than a day is refused instead of being unrunnable',
    acceptTask(db, { key: t.task.key, actor: 'runner', leaseMs: 90 * 24 * 60 * 60 * 1000 }).reason === 'lease-out-of-range')
  const afterExpiry = renewTask(db, { key: t.task.key, actor: 'runner', leaseMs: 60000, at: t0 + 131 + 500 + 60001 })
  ok('renewing after the deadline is refused', afterExpiry.ok === false && afterExpiry.reason === 'lease-expired',
    JSON.stringify(afterExpiry))
}

// 9. Rejection returns the task, and attempts are bounded
{
  const t = createTask(db, { title: 'attempt bounded', createdBy: 'planner', assignee: 'runner', maxAttempts: 2, at: t0 + 50 })
  acceptTask(db, { key: t.task.key, actor: 'runner', at: t0 + 51 })
  returnTask(db, { key: t.task.key, actor: 'runner', result: 'first try', evidence: [{ kind: 'note', ref: 'a' }], at: t0 + 52 })
  const rejected = rejectTask(db, { key: t.task.key, actor: 'reviewer', reason: 'not enough evidence', at: t0 + 53 })
  ok('rejection sends it back with the reason kept',
    rejected.ok && rejected.task.state === 'assigned' && rejected.task.lastReason === 'not enough evidence',
    JSON.stringify(rejected).slice(0, 140))
  ok('the previous result is kept for the next attempt', rejected.task.result === 'first try')

  acceptTask(db, { key: t.task.key, actor: 'runner', at: t0 + 54 })
  returnTask(db, { key: t.task.key, actor: 'runner', result: 'second try', evidence: [{ kind: 'note', ref: 'b' }], at: t0 + 55 })
  const exhausted = rejectTask(db, { key: t.task.key, actor: 'reviewer', reason: 'still wrong', at: t0 + 56 })
  ok('rejecting the last allowed attempt fails the task',
    exhausted.ok && exhausted.task.state === 'failed', JSON.stringify(exhausted).slice(0, 140))
  const retry = retryTask(db, { key: t.task.key, actor: 'planner', at: t0 + 57 })
  ok('a task out of attempts cannot be retried', retry.ok === false && retry.reason === 'attempts-exhausted', JSON.stringify(retry))
}

// 10. Illegal transitions and missing inputs
{
  const t = createTask(db, { title: 'cancel me', createdBy: 'planner', at: t0 + 60 })
  ok('cancelling an open task works', cancelTask(db, { key: t.task.key, actor: 'planner', at: t0 + 61 }).ok)
  ok('a cancelled task cannot be accepted', acceptTask(db, { key: t.task.key, actor: 'runner', at: t0 + 62 }).reason === 'bad-state')
  ok('a task needs an actor', createTask(db, { title: 'nobody', at: t0 + 63 }).reason === 'actor-required')
  ok('a task needs a title', createTask(db, { title: '  ', createdBy: 'planner', at: t0 + 63 }).reason === 'title-required')
  ok('a dependency that does not exist is refused',
    createTask(db, { title: 'orphan', createdBy: 'planner', dependsOn: ['T-nope-0000'], at: t0 + 64 }).reason === 'dependency-not-found')
  ok('failing requires a reason', failTask(db, { key: t.task.key, actor: 'planner', at: t0 + 65 }).reason === 'reason-required')
  ok('a cancelled task cannot be failed afterwards',
    failTask(db, { key: t.task.key, actor: 'planner', reason: 'too late', at: t0 + 66 }).reason === 'bad-state')
}

// 11. Owner isolation and listing
{
  const other = createTask(db, { title: 'owned elsewhere', createdBy: 'planner', owner: 'team-b', at: t0 + 70 })
  ok('a task in another owner partition is invisible', getTask(db, { key: other.task.key }) === null)
  ok('and cannot be moved', acceptTask(db, { key: other.task.key, actor: 'runner', at: t0 + 71 }).reason === 'not-found')
  const mine = listTasks(db, { limit: 50 })
  ok('listing is partition-scoped', mine.every((t) => t.owner === null), `${mine.length} rows`)
  const running = listTasks(db, { state: 'running', limit: 50 })
  ok('listing filters by state', running.every((t) => t.state === 'running'))
}

// 12. Confirmation: the user's final word, one transition after verification
{
  const t = createTask(db, { title: 'confirm me', createdBy: 'planner', assignee: 'runner', at: t0 + 80 })
  const key = t.task.key
  ok('confirming before verification is refused',
    confirmTask(db, { key, actor: 'operator', at: t0 + 81 }).reason === 'bad-state')
  acceptTask(db, { key, actor: 'runner', at: t0 + 82 })
  returnTask(db, { key, actor: 'runner', result: 'done', evidence: [{ kind: 'note', ref: 'n' }], at: t0 + 83 })
  verifyTask(db, { key, actor: 'reviewer', at: t0 + 84 })
  ok('the assignee cannot confirm its own work',
    confirmTask(db, { key, actor: 'runner', at: t0 + 85 }).reason === 'self-confirmation-refused')
  const confirmed = confirmTask(db, { key, actor: 'operator', note: 'read the trail', at: t0 + 86 })
  ok('the operator confirms verified work',
    confirmed.ok === true && confirmed.task.state === 'confirmed' && confirmed.task.confirmedBy === 'operator',
    JSON.stringify(confirmed).slice(0, 140))
  ok('the confirmation is idempotent for the same person',
    confirmTask(db, { key, actor: 'operator', at: t0 + 87 }).already === true)
  ok('and is not re-openable by someone else',
    confirmTask(db, { key, actor: 'other-operator', at: t0 + 88 }).reason === 'confirmed-by-someone-else')
  ok('a confirmed task is terminal',
    verifyTask(db, { key, actor: 'reviewer', at: t0 + 89 }).reason === 'bad-state')
  const trail = taskEvents(db, { key }).map((e) => e.action)
  ok('the trail records the confirmation as the last act',
    trail.join(',').endsWith('create,accept,return,verify,confirm'), trail.join(','))
}

// 13. A confirmed dependency is stronger than a verified one, not a different branch
{
  const parent = createTask(db, { title: 'parent of a follow-up', createdBy: 'planner', assignee: 'runner', at: t0 + 100 })
  const parentKey = parent.task.key
  acceptTask(db, { key: parentKey, actor: 'runner', at: t0 + 101 })
  returnTask(db, { key: parentKey, actor: 'runner', result: 'done', evidence: [{ kind: 'note', ref: 'n' }], at: t0 + 102 })
  verifyTask(db, { key: parentKey, actor: 'reviewer', at: t0 + 103 })
  const child = createTask(db, {
    title: 'follow-up', createdBy: 'planner', assignee: 'runner', dependsOn: [parentKey], at: t0 + 104,
  })
  const childKey = child.task.key
  ok('a verified dependency lets the next task start',
    acceptTask(db, { key: childKey, actor: 'runner', at: t0 + 105 }).ok === true)
  // The child is already running; check a second one, so the accept is not refused
  // for its own state before the dependency is even consulted.
  confirmTask(db, { key: parentKey, actor: 'operator', at: t0 + 106 })
  const second = createTask(db, {
    title: 'another follow-up', createdBy: 'planner', assignee: 'runner', dependsOn: [parentKey], at: t0 + 107,
  })
  const afterConfirm = acceptTask(db, { key: second.task.key, actor: 'runner', at: t0 + 108 })
  ok('and a confirmed dependency still counts as done',
    afterConfirm.ok === true && afterConfirm.task.state === 'running',
    JSON.stringify(afterConfirm).slice(0, 140))
  const pending = createTask(db, { title: 'unfinished parent', createdBy: 'planner', assignee: 'runner', at: t0 + 109 })
  const blocked = createTask(db, {
    title: 'blocked child', createdBy: 'planner', assignee: 'runner', dependsOn: [pending.task.key], at: t0 + 110,
  })
  const refused = acceptTask(db, { key: blocked.task.key, actor: 'runner', at: t0 + 111 })
  ok('a dependency that is not finished still blocks, and says which one',
    refused.reason === 'dependency-open' && refused.dependency === pending.task.key && refused.dependencyState === 'assigned',
    JSON.stringify(refused).slice(0, 140))
}

db.close()
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

console.log(failures.length ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25` : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
