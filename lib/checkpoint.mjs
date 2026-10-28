// \u4EFB\u52A1\u72B6\u6001\uFF1A\u77ED\u547D\u3001\u53EF\u6574\u4F53\u66FF\u6362\u3001\u538B\u7F29\u540E\u5FC5\u987B\u80FD\u539F\u6837\u635E\u56DE\u6765\u3002
//
// \u538B\u7F29\u4E8B\u4EF6\u5728 DSH \u91CC\u662F\u300C\u4EC5\u65E5\u5FD7\u7684 SessionEvent\u300D\uFF0C\u4E0D\u662F Cordis \u4E8B\u4EF6\uFF0C\u6240\u4EE5\u6CA1\u6CD5 ctx.on('compaction/end')\u3002
// \u53EA\u80FD\u81EA\u5DF1\u626B\u4F1A\u8BDD\u4E8B\u4EF6\u65E5\u5FD7\uFF0C\u627E start/end \u914D\u5BF9 —— end \u6CA1\u5E26 error \u624D\u7B97\u8FD9\u4E00\u6B21\u538B\u7F29\u6210\u529F\u3002

import { normalize } from './text.mjs'
import { metaGet, metaSet, tx } from './db.mjs'

export function saveCheckpoint(db, { sessionId, goal, done, next, files, decisions, turn = null, owner = null, at = Date.now(), guard = null }) {
  // Checkpoint text is injected into the prompt every turn and exported by
  // fold, so it must pass through the same redaction as remembered facts.
  const red = typeof guard === 'function' ? guard : (v) => v
  const prev = activeCheckpoint(db, sessionId, owner)
  db.exec('begin immediate')
  try {
    const r = db
      .prepare(
        `insert into acm_checkpoints (session_id, owner, goal, done, next, files, decisions, turn, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, owner, red(normalize(goal ?? '')), red(normalize(done ?? '')), red(normalize(next ?? '')), red(files ?? ''), red(decisions ?? ''), turn, at)
    const id = Number(r.lastInsertRowid)
    if (prev) db.prepare('update acm_checkpoints set superseded_by = ? where id = ?').run(id, prev.id)
    db.prepare('insert into acm_recovery_receipts (checkpoint_id, session_id, state, at) values (?, ?, ?, ?)')
      .run(id, sessionId, 'prepared', at)
    db.exec('commit')
    return id
  } catch (err) {
    try { db.exec('rollback') } catch {}
    throw err
  }
}

export function activeCheckpoint(db, sessionId, owner = null) {
  const row = db
    .prepare(
      `select * from acm_checkpoints
        where session_id = ? and superseded_by is null
          and owner IS ?
        order by created_at desc limit 1`,
    )
    .get(sessionId, owner)
  if (!row) return null
  return {
    id: Number(row.id),
    goal: row.goal ?? '',
    done: row.done ?? '',
    next: row.next ?? '',
    files: row.files ?? '',
    decisions: row.decisions ?? '',
    turn: row.turn ?? null,
    createdAt: Number(row.created_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
  }
}

export function markDelivered(db, checkpointId, sessionId, note = null, owner = null, at = Date.now()) {
  // Scoped by owner: marking by bare id let one partition write delivery
  // receipts onto another partition's checkpoint.
  return tx(db, () => {
    const cp = db
      .prepare("select id from acm_checkpoints where id = ? and owner IS ?")
      .get(checkpointId, owner)
    if (!cp) return false
    // Delivery is recorded once. A crash between injecting the context and
    // marking it must not produce a second 'delivered' receipt on retry.
    const already = db
      .prepare("select 1 from acm_recovery_receipts where checkpoint_id = ? and state = 'delivered' limit 1")
      .get(checkpointId)
    if (already) return true
    db.prepare('update acm_checkpoints set delivered_at = ? where id = ?').run(at, checkpointId)
    db.prepare('insert into acm_recovery_receipts (checkpoint_id, session_id, state, at, note) values (?, ?, ?, ?, ?)')
      .run(checkpointId, sessionId, 'delivered', at, note)
    return true
  })
}

/**
 * \u626B\u4E00\u904D\u4F1A\u8BDD\u4E8B\u4EF6\uFF0C\u6570\u51FA\u5DF2\u7ECF\u5B8C\u6210\u7684\u538B\u7F29\u6B21\u6570\u4E0E\u6700\u540E\u4E00\u6B21\u7684\u65F6\u95F4\u3002
 * \u517C\u5BB9\u51E0\u79CD\u53D6\u4E8B\u4EF6\u7684\u5165\u53E3\u540D\uFF0C\u53D6\u4E0D\u5230\u5C31\u8FD4\u56DE null\uFF08\u964D\u7EA7\u6210"\u4E0D\u68C0\u6D4B\u538B\u7F29"\uFF09\u3002
 */
export function scanCompactions(events) {
  if (!Array.isArray(events) || !events.length) return { completed: 0, lastAt: null, open: false }
  let completed = 0
  let lastAt = null
  let open = false
  for (const ev of events) {
    const type = ev?.type ?? ev?.kind
    if (type === 'session/end-seed') {
      open = false // \u4E0A\u4E00\u751F\u547D\u5468\u671F\u6B8B\u7559\u7684\u672A\u95ED\u5408 start \u5230\u8FD9\u91CC\u4F5C\u5E9F
      continue
    }
    if (type === 'compaction/start') { open = true; continue }
    if (type === 'compaction/end') {
      if (ev?.data?.error === undefined) {
        completed++
        lastAt = ev.time ?? ev.at ?? null
      }
      open = false
    }
  }
  return { completed, lastAt, open }
}

export function receiptState(db, checkpointId, owner = null) {
  // Receipts carry no owner of their own, so ownership is checked through the
  // checkpoint they belong to before anything is returned.
  const owned = db
    .prepare("select 1 from acm_checkpoints where id = ? and owner IS ?")
    .get(checkpointId, owner)
  if (!owned) return { states: [], delivered: false, prepared: false }
  const rows = db
    .prepare('select state, at from acm_recovery_receipts where checkpoint_id = ? order by at asc')
    .all(checkpointId)
  const states = rows.map((r) => r.state)
  return { states, delivered: states.includes('delivered'), prepared: states.includes('prepared') }
}

/** \u6BCF\u8F6E\u672B\u5C3E\u81EA\u52A8\u5B58\u4E00\u6761"\u521A\u624D\u5728\u95EE\u4EC0\u4E48"\u3002\u624B\u52A8\u5B58\u8FC7\u7684\u90A3\u6761\u4E0D\u4F1A\u88AB\u81EA\u52A8\u7684\u76D6\u6389\u3002 */
export function saveOrUpdateAuto(db, { sessionId, goal, turn = null, owner = null, guard = null }) {
  const red = typeof guard === 'function' ? guard : (v) => v
  const text = red(normalize(goal ?? ''))
  if (!text) return null
  const cur = activeCheckpoint(db, sessionId, owner)
  const autoKey = `auto_cp:${owner ?? ''}:${sessionId}`
  const autoId = Number(metaGet(db, autoKey, 0) || 0)
  if (cur && cur.id === autoId) {
    db.prepare('update acm_checkpoints set goal = ?, turn = ?, created_at = ? where id = ?')
      .run(text, turn, Date.now(), cur.id)
    return cur.id
  }
  if (cur) return cur.id
  const id = saveCheckpoint(db, { sessionId, goal: text, turn, owner })
  metaSet(db, autoKey, id)
  return id
}

/**
 * Verify the recovery ledger for a session.
 *
 * "Restored exactly once" is a property of the receipts, not of the prose that
 * claims a restore happened: one 'prepared' receipt per checkpoint, at most one
 * 'delivered' receipt, and no receipt pointing at a checkpoint that is gone.
 */
export function verifyRecovery(db, { sessionId = null, owner = null } = {}) {
  const cp = sessionId ? activeCheckpoint(db, sessionId, owner) : null
  const rows = cp
    ? db.prepare('select state, at, note from acm_recovery_receipts where checkpoint_id = ? order by id asc').all(cp.id)
    : []
  const prepared = rows.filter((r) => r.state === 'prepared').length
  const delivered = rows.filter((r) => r.state === 'delivered').length
  const orphans = Number(
    db
      .prepare(
        'select count(*) c from acm_recovery_receipts r where not exists (select 1 from acm_checkpoints c where c.id = r.checkpoint_id)',
      )
      .get().c,
  )
  const checks = {
    checkpoint: cp ? 'ok' : 'missing',
    prepared: prepared === 1 ? 'ok' : prepared === 0 ? 'none' : 'duplicate',
    delivered: delivered <= 1 ? 'ok' : 'duplicate',
    orphans: orphans === 0 ? 'ok' : String(orphans),
  }
  return {
    ok: Object.values(checks).every((v) => v === 'ok'),
    checks,
    checkpointId: cp ? cp.id : null,
    receipts: rows.length,
    prepared,
    delivered,
    orphans,
  }
}

/** One line per check, for CLI output. */
export function renderRecoveryReport(result) {
  const lines = Object.entries(result.checks ?? {}).map(([key, value]) => `${value === 'ok' ? 'ok  ' : 'FAIL'} ${key}: ${value}`)
  return `${result.ok ? 'recovery verified' : 'recovery has problems'}\n${lines.join('\n')}`
}
