// \u4E3B\u4F53 key \u7684\u7F16\u7801\u4E0E\u8BFB\u56DE\uFF1A\u4E00\u4E2A\u4E3B\u4F53\u5FC5\u987B\u80FD\u88AB\u552F\u4E00\u5730\u8BFB\u6210\u5B83\u81EA\u5DF1
//
// \u8FD9\u4E2A\u6587\u4EF6\u5B58\u5728\u7684\u539F\u56E0\u5F88\u5177\u4F53\uFF1Akey \u662F\u201C\u8FD9\u6761 grant \u7ED9\u7684\u662F\u8C01\u201D\u7684\u552F\u4E00\u4F9D\u636E\uFF0C\u800C\u5B83\u7684\u4E24\u79CD\u53E4\u8001\u5F62\u5F0F\u4F1A\u78B0\u649E\uFF1A
// `agent:3:foo` \u65E2\u53EF\u4EE5\u662F v1 \u91CC\u4E00\u4E2A\u53EB `3:foo` \u7684 agent\uFF0C\u4E5F\u53EF\u4EE5\u770B\u8D77\u6765\u50CF v17 \u91CC
// \u53EB `foo`\u3001owner \u4E3A\u7A7A\u7684\u4E3B\u4F53\u3002\u8BFB\u9519\u4E00\u4E2A\u5B57\u7B26\uFF0Cgrant \u5C31\u843D\u5230\u4E86\u53E6\u4E00\u4E2A\u5206\u533A\u3002
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db.mjs'
import { grant, holdsGrant, listGrants, normalizePrincipal, principalKey, upsertPrincipal } from '../lib/auth.mjs'
import { canonicalPrincipalId, parsePrincipalId, parseV17PrincipalId, principalId, sameOwner } from '../lib/principal-id.mjs'

const work = mkdtempSync(join(tmpdir(), 'acm-principal-id-'))
const db = openDb(join(work, 'memory.db'))

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

// 1. The shape, including the three owner cases
ok('no owner is marked, not left blank', principalId({ kind: 'agent', id: 'runner', owner: null }) === 'agent:6:runner:~')
ok('the empty owner is a different key from no owner',
  principalId({ kind: 'agent', id: 'runner', owner: '' }) === 'agent:6:runner:0:')
ok('an owner is length-prefixed', principalId({ kind: 'agent', id: 'runner', owner: 'team' }) === 'agent:6:runner:4:team')
ok('a separator inside a name cannot be re-read as a pair',
  principalId({ kind: 'agent', id: 'a:b', owner: null }) !== principalId({ kind: 'agent', id: 'a', owner: 'b' }))
ok('an unknown kind is refused rather than written',
  (() => { try { principalId({ kind: 'root', id: 'x', owner: null }); return false } catch { return true } })())

// 2. Round trip: everything written is read back as itself
for (const [id, owner] of [['runner', null], ['runner', ''], ['runner', 'team'], ['a:b', null], ['a:b', 'x:y'], ['3:foo', null], ['', 'x']]) {
  if (!id) continue
  const key = principalId({ kind: 'agent', id, owner })
  const back = parsePrincipalId(key)
  ok(`reads back ${JSON.stringify(id)} / ${JSON.stringify(owner)}`,
    back && back.name === id && sameOwner(back.owner, owner), JSON.stringify(back))
}

// 3. The v17 form is still readable, and its ambiguity is resolved by structure
ok('a v17 key with an owner is read as that owner',
  parseV17PrincipalId('agent:6:runner:4:team', { ownerHint: '4:team' })?.owner === '4:team')
ok('a v1 key for an agent named `3:foo` is not read as v17',
  parseV17PrincipalId('agent:3:foo', { ownerHint: null }) === null,
  'no separator after the length-prefixed name means v1')
ok('a v17 key for `foo` with an empty owner is not read as v1',
  parseV17PrincipalId('agent:3:foo:', { ownerHint: '' })?.name === 'foo')
ok('a current key is not misread by the v17 reader',
  parsePrincipalId('agent:6:runner:6:4:team')?.owner === '4:team' &&
  parseV17PrincipalId('agent:6:runner:6:4:team', { ownerHint: '4:team' }) === null,
  'the v17 reader takes everything after the name as the owner, so the hint rejects it')

// 4. canonicalPrincipalId: the migration's one decision
ok('a v1 name beginning with `digits:` is re-keyed with its real name',
  canonicalPrincipalId('agent:3:foo', { owner: null }) === 'agent:5:3:foo:~',
  canonicalPrincipalId('agent:3:foo', { owner: null }))
ok('a v17 key gains a length-prefixed owner',
  canonicalPrincipalId('agent:6:runner:4:team', { owner: '4:team' }) === 'agent:6:runner:6:4:team',
  canonicalPrincipalId('agent:6:runner:4:team', { owner: '4:team' }))
ok('an already-current key is left alone',
  canonicalPrincipalId('agent:6:runner:4:team', { owner: 'team' }) === 'agent:6:runner:4:team')
ok('a null-owner key is left alone',
  canonicalPrincipalId('agent:6:runner:~', { owner: null }) === 'agent:6:runner:~')

// 5. The consequence that made this worth fixing: a grant is not shared across
//    the partition boundary that the SQL layer already keeps apart.
{
  const nullOwner = normalizePrincipal({ kind: 'agent', id: 'runner', owner: null })
  const emptyOwner = normalizePrincipal({ kind: 'agent', id: 'runner', owner: '' })
  ok('null-owner and empty-owner are different keys', principalKey(nullOwner) !== principalKey(emptyOwner))
  const issued = grant(db, { principal: nullOwner, action: 'task:verify', grantedBy: 'owner' })
  ok('a grant for the null partition is not visible to the empty partition',
    issued.ok === true && holdsGrant(db, nullOwner, 'task:verify') === true &&
    holdsGrant(db, emptyOwner, 'task:verify') === false)
  const empty = grant(db, { principal: emptyOwner, action: 'task:verify', grantedBy: 'owner' })
  ok('and the empty partition can hold its own grant separately',
    empty.ok === true && listGrants(db, { principal: emptyOwner }).length === 1 &&
    listGrants(db, { principal: nullOwner }).length === 1)
}

// 6. `grant()` must not write onto a key whose stored owner disagrees with the
//    caller's principal. It used to ignore that answer.
{
  const moved = normalizePrincipal({ kind: 'agent', id: 'clash', owner: 'team-b' })
  // A row that exists under the key but disagrees with it about the owner. With
  // the owner inside the key that can only happen from a hand-edited row or a
  // key-scheme change - which is exactly when the store must refuse to guess.
  db.prepare('insert into acm_principals (id, kind, owner, project, created_at) values (?, ?, ?, ?, ?)')
    .run(principalKey(moved), 'agent', 'team-a', null, 1)
  const refused = grant(db, { principal: moved, action: 'task:verify', grantedBy: 'owner' })
  ok('grant refuses when the stored owner disagrees instead of writing anyway',
    refused.ok === false && refused.reason === 'owner-mismatch', JSON.stringify(refused))
  ok('and the refusal left no grant behind',
    db.prepare('select count(*) c from acm_grants where principal_id = ?').get(principalKey(moved))?.c === 0)
}

db.close()
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

console.log(failures.length
  ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25`
  : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
