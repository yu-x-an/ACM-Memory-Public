// Persona: the Markdown files stay the source of truth, and an approved copy of
// each body is also kept in acm_meta under persona_body:<path> so an unapproved
// edit cannot change what the agent is told before someone approves it.
//
// \u8001\u5927\u7684\u539F\u5219——\u8BA9 AI \u53BB\u8BFB AGENT.md / \u4EBA\u8BBE\u6587\u4EF6\u3002\u8BFB\u8FDB\u6765\u8FDB\u7CFB\u7EDF\u63D0\u793A\u8BCD\u524D\u7F00\uFF0Cprompt cache \u4E00\u76F4\u547D\u4E2D\u3002
// \u8FD9\u91CC\u505A\u56DB\u4EF6\u4E8B\uFF1A\u8BFB\u3001\u7B97 sha\u3001\u53D1\u73B0\u6539\u52A8\u5C31\u8BB0\u4E00\u6761\u5F85\u5BA1\u63D0\u6848\u6302\u544A\u8B66\u3001\u6279\u51C6/\u9A73\u56DE\u65F6\u52A8\u624B\uFF08\u539F\u5B50\u5199\uFF09\u3002
//
// \u6279\u51C6\uFF1A\u5148\u6838 base_sha256 —— \u6587\u4EF6\u5728\u5BA1\u6279\u671F\u95F4\u53C8\u88AB\u6539\u8FC7\u5C31\u4E0D\u8BA9\u6279\uFF08\u6807 stale\uFF09\uFF0C\u514D\u5F97\u6279\u7684\u662F\u522B\u4EBA\u6CA1\u770B\u8FC7\u7684\u90A3\u4EFD\u3002
// \u9A73\u56DE\uFF1A\u628A\u6587\u4EF6\u8FD8\u539F\u6210\u4E0A\u4E00\u7248\u5DF2\u6279\u51C6\u7684\u5185\u5BB9\u3002\u65E2\u7136\u300C\u9A73\u56DE\u300D\u4E86\uFF0C\u6587\u4EF6\u5C31\u4E0D\u8BE5\u8FD8\u662F\u90A3\u4EFD\u88AB\u9A73\u56DE\u7684\u4E1C\u897F\u3002

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { sha256 } from './text.mjs'
import { metaGet, metaSet } from './db.mjs'

function diffStat(prev, next) {
  const a = String(prev ?? '').split('\n')
  const b = String(next ?? '').split('\n')
  const aset = new Map()
  for (const line of a) aset.set(line, (aset.get(line) ?? 0) + 1)
  let added = 0
  for (const line of b) {
    const n = aset.get(line) ?? 0
    if (n > 0) aset.set(line, n - 1)
    else added++
  }
  let removed = 0
  for (const n of aset.values()) removed += n
  return { added, removed, lines: b.length }
}

/** \u539F\u5B50\u5199\uFF1A\u5148\u5199\u540C\u76EE\u5F55\u4E34\u65F6\u6587\u4EF6\u518D rename\uFF0C\u5199\u5230\u4E00\u534A\u65AD\u7535\u4E5F\u4E0D\u4F1A\u7559\u4E0B\u534A\u4E2A\u6587\u4EF6\u3002 */
export function atomicWrite(path, text) {
  const tmp = `${path}.acm-${process.pid}-${Date.now()}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

function readRaw(path) {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Approved persona state is keyed per partition.
 *
 * The original keys were `persona_sha:<path>` and `persona_body:<path>`, so two
 * owners pointed at the same file shared one enrollment and one approved body:
 * owner A could approve a body and owner B would silently serve it. Named
 * partitions now use their own keys, and the legacy keys are honoured only for
 * the unnamed partition an existing install already runs as.
 */
function personaKey(kind, owner, path) {
  return owner == null ? `${kind}:${path}` : `${kind}:owner:${owner}:${path}`
}

function readPersonaMeta(db, kind, owner, path, fallback) {
  const scoped = metaGet(db, personaKey(kind, owner, path), null)
  if (scoped != null) return scoped
  // Only the unnamed partition inherits the pre-partition state.
  if (owner == null) return metaGet(db, `${kind}:${path}`, fallback)
  return fallback
}

function writePersonaMeta(db, kind, owner, path, value) {
  metaSet(db, personaKey(kind, owner, path), value)
}

export function loadPersona(db, paths, { owner = null, confineTo = null } = {}) {
  const entries = []
  const changed = []
  const parts = []
  const denied = []

  for (const path of paths) {
    // A caller may name any path; only configured persona files are readable.
    // Without this, persona() could read arbitrary files and trust-enroll them.
    if (Array.isArray(confineTo) && !confineTo.includes(path)) {
      denied.push(path)
      continue
    }
    const raw = readRaw(path)
    const text = raw?.trim() ?? ''
    const sha = sha256(text)
    const prevSha = readPersonaMeta(db, 'persona_sha', owner, path, null)

    if (prevSha == null) {
      // Enroll even when the file is absent or empty. Skipping enrollment meant
      // the first non-empty content that appeared later counted as a "first
      // load" and was trusted with no proposal and no approval, while being
      // injected into the system prompt.
      writePersonaMeta(db, 'persona_sha', owner, path, sha)
      writePersonaMeta(db, 'persona_body', owner, path, text)
    } else if (prevSha !== sha) {
      const dup = db
        .prepare("select id from acm_persona_proposals where path = ? and state = 'pending' and new_sha256 = ? and owner IS ?")
        .get(path, sha, owner)
      if (!dup) {
        const prevText = readPersonaMeta(db, 'persona_body', owner, path, '')
        const d = diffStat(prevText, text)
        db.prepare(
          `insert into acm_persona_proposals (path, base_sha256, new_sha256, diff_summary, state, created_at, owner)
           values (?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(path, prevSha, sha, `+${d.added} -${d.removed}\uFF08\u5171 ${d.lines} \u884C\uFF09`, Date.now(), owner)
        changed.push({ path, sha, diff: `+${d.added} -${d.removed}` })
      }
    }
    const approved = readPersonaMeta(db, 'persona_body', owner, path, '')
    if (approved) parts.push(approved)
    entries.push({ path, sha: prevSha ?? sha, chars: approved.length, pending: prevSha != null && prevSha !== sha })
  }

  return { text: parts.join('\n\n'), entries, changed, denied }
}

/** Proposals belong to the partition that raised them. */
export function pendingProposals(db, owner = null) {
  return db
    .prepare("select id, path, diff_summary, created_at from acm_persona_proposals where state = 'pending' and owner IS ? order by created_at desc")
    .all(owner)
}

/**
 * \u6279 / \u9A73\u4E00\u6761\u63D0\u6848\u3002\u4E24\u4E2A\u90FD\u8981\u52A8\u6587\u4EF6\uFF0C\u6240\u4EE5\u5148\u6838 sha\u3002
 * \u8FD4\u56DE { ok, state, reason?, reverted? }
 */
/**
 * Whether this partition may write the file at `path`.
 *
 * Persona files live on disk, but approval state is per owner. When two owners
 * name the same path, either one writing it changes the other's source of truth
 * and raises a proposal the other never asked for. In that case the decision is
 * recorded in the database and the shared file is left alone.
 */
function personaPathIsShared(db, owner, path) {
  // The path is user data: matching it with a LIKE pattern let a name containing
  // `%` or `_` match other files. Scan the key prefix and compare the suffix exactly.
  const prefix = 'persona_sha:owner:'
  const suffix = ':' + path
  const rows = db.prepare("select k from acm_meta where k like ?").all(`${prefix}%`)
  const owners = new Set()
  for (const r of rows) {
    const k = String(r.k)
    if (!k.endsWith(suffix)) continue
    const who = k.slice(prefix.length, k.length - suffix.length)
    if (who !== String(owner ?? '')) owners.add(who)
  }
  return owners.size > 0
}

export function decideProposal(db, id, approve, { actor = null, owner = null } = {}) {
  // Approval is a privileged state change: it needs a named principal, and it
  // may only decide proposals raised by the caller's own partition. Returning
  // an explicit denial keeps callers fail-closed instead of silently trusting.
  if (typeof actor !== 'string' || !actor.trim()) {
    return { ok: false, state: 'denied', reason: 'principal-required' }
  }
  const row = db.prepare('select * from acm_persona_proposals where id = ?').get(Number(id))
  if (!row) return { ok: false, state: 'missing', reason: 'no-such-proposal' }
  if ((row.owner ?? null) !== (owner ?? null)) {
    return { ok: false, state: 'denied', reason: 'owner-mismatch' }
  }
  if (row.state !== 'pending') return { ok: false, state: row.state, reason: 'already-decided' }

  const decidedBy = actor.trim().slice(0, 120)
  const raw = readRaw(row.path)
  const curSha = raw == null ? null : sha256(raw.trim())
  const at = Date.now()

  if (approve) {
    if ((curSha ?? sha256('')) !== row.new_sha256) {
      // The file changed again while the proposal waited: refuse, mark stale,
      // and let a fresh proposal be raised for the content nobody reviewed.
      db.prepare("update acm_persona_proposals set state = 'stale', decided_at = ?, decided_by = ? where id = ?")
        .run(at, decidedBy, row.id)
      return { ok: false, state: 'stale', reason: 'file-changed-since-proposal' }
    }
    const sharedPath = personaPathIsShared(db, owner, row.path)
    if (!sharedPath) {
      try {
        if (raw != null) atomicWrite(row.path, raw)
      } catch (err) {
        return { ok: false, state: 'pending', reason: `write-failed:${err?.message ?? err}` }
      }
    }
    writePersonaMeta(db, 'persona_sha', owner, row.path, curSha ?? sha256(''))
    writePersonaMeta(db, 'persona_body', owner, row.path, raw?.trim() ?? '')
    db.prepare("update acm_persona_proposals set state = 'approved', decided_at = ?, decided_by = ? where id = ?")
      .run(at, decidedBy, row.id)
    return { ok: true, state: 'approved', decidedBy, fileWritten: !sharedPath }
  }

  // Reject: restore the last approved body, so the file never keeps content
  // that a reviewer explicitly refused.
  const body = readPersonaMeta(db, 'persona_body', owner, row.path, null)
  if (body == null) {
    db.prepare("update acm_persona_proposals set state = 'rejected', decided_at = ?, decided_by = ? where id = ?")
      .run(at, decidedBy, row.id)
    return { ok: true, state: 'rejected', reverted: false, decidedBy }
  }
  const sharedPath = personaPathIsShared(db, owner, row.path)
  if (!sharedPath) {
    try {
      atomicWrite(row.path, body.endsWith('\n') ? body : `${body}\n`)
    } catch (err) {
      return { ok: false, state: 'pending', reason: `write-failed:${err?.message ?? err}` }
    }
  }
  writePersonaMeta(db, 'persona_sha', owner, row.path, sha256(body))
  db.prepare("update acm_persona_proposals set state = 'rejected', decided_at = ?, decided_by = ? where id = ?")
    .run(at, decidedBy, row.id)
  return { ok: true, state: 'rejected', reverted: !sharedPath, decidedBy, fileWritten: !sharedPath }
}
