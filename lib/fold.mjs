// \u843D\u76D8\u4E00\u4EFD\u4EBA\u53EF\u8BFB\u7684 Markdown —— \u65B9\u4FBF\u8001\u5927\u7528\u7F16\u8F91\u5668\u770B"\u6211\u5230\u5E95\u8BB0\u4F4F\u4E86\u4EC0\u4E48"\uFF0C
// \u4E5F\u65B9\u4FBF\u4E22\u8FDB git \u770Bdiff\u3002\u6570\u636E\u5E93\u4ECD\u662F\u552F\u4E00\u771F\u76F8\uFF0C\u8FD9\u4EFD\u53EA\u662F\u89C6\u56FE\u3002

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { activeCheckpoint } from './checkpoint.mjs'
import { sourcesOf } from './memory.mjs'

const mmdd = (ts) => {
  const t = new Date(Number(ts))
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

export function foldToMarkdown(db, { sessionId, outPath, owner = null }) {
  const cp = activeCheckpoint(db, sessionId, owner)
  const rows = db
    .prepare(
      `select id, key, kind, text, importance, created_at from acm_nodes
        where status = 'active' and (scope = 'global' or scope = ?)
          and owner IS ?
        order by created_at desc limit 200`,
    )
    .all(sessionId, owner)

  const lines = [`# \u8BB0\u5FC6\u89C6\u56FE · ${sessionId}`, `_\u5BFC\u51FA\u65F6\u95F4 ${new Date().toISOString()}_`, '']
  if (cp) {
    lines.push('## \u4EFB\u52A1\u72B6\u6001', '')
    if (cp.goal) lines.push(`- \u76EE\u6807\uFF1A${cp.goal}`)
    if (cp.done) lines.push(`- \u5DF2\u5B8C\u6210\uFF1A${cp.done}`)
    if (cp.next) lines.push(`- \u4E0B\u4E00\u6B65\uFF1A${cp.next}`)
    if (cp.files) lines.push(`- \u6587\u4EF6\uFF1A${cp.files}`)
    if (cp.decisions) lines.push(`- \u5DF2\u5B9A\uFF1A${cp.decisions}`)
    lines.push('')
  }
  lines.push('## \u4E8B\u5B9E', '')
  for (const r of rows) {
    const src = sourcesOf(db, Number(r.id), owner).map((s) => s.kind).join(',')
    lines.push(`- \`#${r.id}\` [${mmdd(r.created_at)}]${r.key ? ` **${r.key}** =` : ''} ${r.text}  <sub>${src || '\u65E0\u6765\u6E90'}</sub>`)
  }
  lines.push('')

  const text = lines.join('\n')
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, text, 'utf8')
  }
  return text
}
