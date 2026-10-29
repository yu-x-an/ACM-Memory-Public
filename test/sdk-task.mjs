// SDK \u5F53\u4F5C\u4E1A\u52A1\u5C42\u7684\u8FB9\u754C\uFF1Aowner\u3001actor\u3001project \u4E0D\u80FD\u88AB\u53C2\u6570\u62FF\u8D70
//
// The reviewer found that `{ ...opts }` was spread after the trusted closure values,
// so a handle opened for one owner could target another owner's task, name a
// different verifier, and even re-enable self-verification. These cases are the
// contract: the handle decides where and who, the caller decides what.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemory } from '../lib/sdk.mjs'

const work = mkdtempSync(join(tmpdir(), 'acm-sdk-task-'))
const dbPath = join(work, 'memory.db')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const open = (agent, owner = 'team-a', extra = {}) => openMemory({ dbPath, sessionId: 's', config: { owner, agent, ...extra } })
const planner = open('planner')
const runner = open('runner')
const reviewer = open('reviewer')
const intruder = open('intruder', 'team-b')

// 1. Creation binds the creator; an option cannot rename it
const created = planner.taskCreate({ title: 'owned by team-a', assignee: 'runner', createdBy: 'someone-else' })
ok('a created task records the handle actor, not a passed one', created.ok && created.task.createdBy === 'planner',
  `createdBy=${created.task?.createdBy}`)
const key = created.task.key

// 2. Another owner cannot read, accept, return or verify it - even with a forged owner
ok('another owner cannot read the task', intruder.task(key) === null)
const stolenAccept = intruder.taskAccept(key, { owner: 'team-a', actor: 'runner' })
ok('another owner cannot accept it by passing the real owner', stolenAccept.ok === false && stolenAccept.reason === 'not-found',
  JSON.stringify(stolenAccept))
const stolenReturn = intruder.taskReturn(key, { owner: 'team-a', actor: 'runner', result: 'pwned', evidence: [{ kind: 'note', ref: 'x' }] })
ok('another owner cannot return it', stolenReturn.ok === false && stolenReturn.reason === 'not-found', JSON.stringify(stolenReturn))
const stolenVerify = intruder.taskVerify(key, { owner: 'team-a', actor: 'reviewer' })
ok('another owner cannot verify it', stolenVerify.ok === false && stolenVerify.reason === 'not-found', JSON.stringify(stolenVerify))
ok('nothing was overwritten by the attempts', runner.task(key).task.state === 'assigned', runner.task(key).task.state)

// 3. A forged actor on the right handle is ignored: the handle's name wins
const wrongActor = planner.taskAccept(key, { actor: 'runner' })
ok('an option cannot make the planner act as the runner', wrongActor.ok === false && wrongActor.reason === 'not-assignee',
  JSON.stringify(wrongActor))

// 4. The normal path still works, with the assignee doing the work
const accepted = runner.taskAccept(key)
ok('the assignee accepts through its own handle', accepted.ok === true && accepted.task.state === 'running')
const returned = runner.taskReturn(key, { result: 'checked the window', evidence: [{ kind: 'test', ref: 'npm run test:all' }] })
ok('the assignee returns it', returned.ok === true && returned.task.state === 'returned')

// 5. Self-verification cannot be unlocked from outside
const selfVerify = runner.taskVerify(key, { allowSelfVerify: true })
ok('allowSelfVerify is not reachable through the SDK', selfVerify.ok === false && selfVerify.reason === 'self-verification-refused',
  JSON.stringify(selfVerify))
const verified = reviewer.taskVerify(key, { note: 'looks right' })
ok('a different principal verifies it', verified.ok === true && verified.task.state === 'verified')

// 6. Confirmation does not exist on this surface, by design
// `confirmed` is the user's word, so it is reachable from `acm task confirm` only.
// A programmatic handle that could set it would make "the user accepted this" a
// claim an agent makes about itself - the same defect self-verification had.
ok('the SDK exposes no way to confirm a task',
  typeof planner.taskConfirm !== 'function' && !Object.keys(planner).some((m) => m.toLowerCase().includes('confirm')),
  Object.keys(planner).filter((m) => m.toLowerCase().includes('confirm')).join(','))
ok('the handle still reports an unconfirmed verified task as verified',
  reviewer.task(key).task.state === 'verified' && reviewer.task(key).task.confirmedBy == null,
  `${reviewer.task(key).task.state} confirmedBy=${reviewer.task(key).task.confirmedBy}`)

// 6. Project comes from the handle, not from the input
const pinned = open('planner', 'team-c', { project: 'project-a' })
const pinnedTask = pinned.taskCreate({ title: 'project pinning', project: 'project-b' })
ok('a task takes the handle project, not a passed one', pinnedTask.task.project === 'project-a',
  String(pinnedTask.task.project))

// 7. Listing is partition-scoped even when a filter asks otherwise
const listedForIntruder = intruder.tasks({ owner: 'team-a', limit: 50 })
ok('a listing cannot be widened to another owner', listedForIntruder.length === 0, `${listedForIntruder.length} rows`)
const listedForTeamA = planner.tasks({ limit: 50 })
ok('the owning partition still lists its own work', listedForTeamA.length >= 1, `${listedForTeamA.length} rows`)

for (const handle of [planner, runner, reviewer, intruder, pinned]) handle.close()
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

console.log(failures.length ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25` : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
