import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { sourcesOf, remember } from '../lib/memory.mjs'
import { MASK, hasSensitive, redact } from '../lib/redact.mjs'
import { distillOnce } from '../lib/distill.mjs'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) }
  else { fail += 1; console.log(`  XX  ${name} ${extra}`) }
}

// 1. \u5404\u7C7B\u578B\u90FD\u80FD\u906E\u4F4F\uFF0C\u4E14\u4E0D\u541E\u6389\u6574\u53E5
const cases = [
  ['sk-abcdefghijklmnop1234', 'openai'],
  ['ghp_0123456789abcdefghijklmnopqrstuvwx', 'github'], // secret-scan:allow (synthetic)
  ['AKIAIOSFODNN7EXAMPLE', 'aws'], // secret-scan:allow (synthetic)
  ['13812345678', 'phone'],
  ['11010119900307123X', 'id-card'],
  ['4111 1111 1111 1111', 'bank'],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'], // secret-scan:allow (synthetic)
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'key'], // secret-scan:allow (synthetic)
]
for (const [raw, label] of cases) {
  const r = redact(`\u8BB0\u4E00\u4E0B ${raw} \u522B\u5F04\u4E22`)
  ok(`\u906E\u6389 ${label}`, r.text.includes(MASK) && !r.text.includes(raw.slice(0, 6)), r.text)
}

const pw = redact('\u6211\u7684\u5BC6\u7801\u662F hunter2\uFF0C\u522B\u8BB0')
ok('\u906E\u6389\u53E3\u4EE4', pw.text.includes(MASK) && !pw.text.includes('hunter2'), pw.text)
ok('\u906E\u5B8C\u8FD8\u7559\u7740\u7ED3\u6784', pw.text.startsWith('\u6211\u7684\u5BC6\u7801\u662F') && pw.text.endsWith('\u522B\u8BB0'), pw.text)

// 2. \u6B63\u5E38\u8BDD\u4E00\u4E2A\u5B57\u90FD\u4E0D\u52A8
const clean = '\u8001\u5927\u51CC\u6668\u4E24\u70B9\u624D\u7761'
ok('\u6B63\u5E38\u5185\u5BB9\u4E0D\u52A8', redact(clean).text === clean)
ok('hits \u4E3A\u7A7A', redact(clean).hits.length === 0)
ok('hasSensitive \u8BA4\u5F97\u51FA\u6765', hasSensitive('token=abcdef123456') && !hasSensitive(clean))

// 3. \u81EA\u5B9A\u4E49\u89C4\u5219
const custom = redact('\u6697\u53F7 ZEBRA-9\uFF0C\u522B\u8BF4\u51FA\u53BB', { extra: ['ZEBRA-9'] })
ok('\u81EA\u5B9A\u4E49\u89C4\u5219\u751F\u6548', custom.text.includes(MASK) && !custom.text.includes('ZEBRA-9'), custom.text)

// 4. \u84B8\u998F\uFF1A\u6A21\u578B\u770B\u5230\u7684\u662F\u6253\u7801\u540E\u7684\uFF0C\u8BC1\u636E\u8868\u5B58\u7684\u4E5F\u662F
const root = mkdtempSync(join(tmpdir(), 'acm-redact-'))
const db = openDb(join(root, 'memory.db'))
let seen = ''
const fakeCtx = {
  llm: {
    stream: ({ messages }) => {
      seen = messages[0].content[0].text
      return (async function* () {
        yield { type: 'text-delta', text: '[{"text":"my password is secret","kind":"fact","confidence":0.9}]' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  },
}
const res = await distillOnce({
  ctx: fakeCtx,
  target: { provider: 'p', model: 'm', from: 'test' },
  db,
  sessionId: 's1',
  snippet: '\u8BB0\u4F4F\uFF0C\u6211\u7684\u5BC6\u7801\u662F hunter2\uFF0C\u8FD8\u6709\u624B\u673A\u53F7 13812345678',
  seq: 1,
  config: { minChars: 5 },
  redact: { enabled: true, extra: [] },
})
ok('\u84B8\u998F\u5199\u8FDB\u53BB\u4E86', res.written === 1, JSON.stringify(res))
ok('\u6A21\u578B\u6CA1\u770B\u5230\u660E\u6587\u53E3\u4EE4', seen.includes(MASK) && !seen.includes('hunter2'), seen)
const src = sourcesOf(db, db.prepare("select id from acm_nodes where status = 'active'").get().id)[0]
ok('\u8BC1\u636E\u8868\u91CC\u4E5F\u6CA1\u6709\u660E\u6587', !src.raw.includes('hunter2') && !src.raw.includes('13812345678'), src.raw)

// 5. \u5173\u6389\u5F00\u5173\u5C31\u539F\u6837\u8FDB\uFF08\u8BF4\u660E\u8FD9\u662F\u914D\u7F6E\uFF0C\u4E0D\u662F\u786C\u7F16\u7801\uFF09
const db2 = openDb(join(root, 'b.db'))
seen = ''
await distillOnce({
  ctx: fakeCtx,
  target: { provider: 'p', model: 'm', from: 'test' },
  db: db2,
  sessionId: 's1',
  snippet: '\u6211\u7684\u5BC6\u7801\u662F hunter2\uFF0C\u8BB0\u4E00\u4E0B',
  seq: 1,
  config: { minChars: 5 },
  redact: { enabled: false },
})
ok('\u5173\u6389\u5C31\u4E0D\u6253\u7801', seen.includes('hunter2'), seen)

// 6. \u624B\u52A8\u8BB0\u4E5F\u4E0D\u7559\u660E\u6587
const { TOOLS } = await import('../lib/core.mjs')
const tool = TOOLS.find((t) => t.name === 'acm_remember')
const out = await tool.run({ text: 'master phone 13812345678', source: '\u8001\u5927\u7535\u8BDD 13812345678' }, { db: db2, config: { redact: { enabled: true }, owner: null }, sessionId: 's1' })
const node = db2.prepare('select text from acm_nodes where id = ?').get(out.id)
ok('acm_remember \u4E5F\u6253\u7801', !node.text.includes('13812345678'), node.text)
const nodeSrc = sourcesOf(db2, out.id)[0]
ok('acm_remember \u7684\u8BC1\u636E\u4E5F\u6253\u7801', !nodeSrc.raw.includes('13812345678'), nodeSrc.raw)
ok('\u8BB0\u7684\u6761\u6570\u5BF9\u5F97\u4E0A', typeof out.id === 'number')
void remember

console.log(`\nredact: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
