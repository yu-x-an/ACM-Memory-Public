/**
 * Retention policy: one place that answers "what would be deleted, and by which
 * rule?" before anything is deleted.
 *
 * The numbers come from the same configuration that `gc` and the backup pruner
 * use, and the eligibility queries mirror theirs exactly. A report that drifts
 * from the enforcement is worse than no report.
 *
 * Active memories are never aged out automatically: only superseded or forgotten
 * rows are. Erasing a live fact is an explicit `purge`.
 */
import { existsSync, statSync } from 'node:fs'

import { listBackups } from './backup.mjs'
import { metaGet } from './db.mjs'

export const RETENTION_DEFAULT = {
  staleDays: 120,
  checkpointDays: 30,
  proposalDays: 90,
  backupKeep: 7,
  mailboxDays: 30,
}

const DAY = 86400000

export function retentionOf(config = {}) {
  const gc = config.gc ?? {}
  const backup = config.backup ?? {}
  return {
    staleDays: Number(gc.days ?? RETENTION_DEFAULT.staleDays),
    checkpointDays: Number(gc.checkpointDays ?? RETENTION_DEFAULT.checkpointDays),
    proposalDays: Number(gc.proposalDays ?? RETENTION_DEFAULT.proposalDays),
    backupKeep: Number(backup.keep ?? RETENTION_DEFAULT.backupKeep),
    mailboxDays: Number(gc.mailboxDays ?? RETENTION_DEFAULT.mailboxDays),
  }
}

/** What the current policy would remove right now, plus what stays. */
export function retentionReport(db, { owner = null, policy = {}, now = Date.now(), backupDir = null } = {}) {
  const p = { ...retentionOf(), ...policy }
  const at = Number(now)
  const staleCutoff = at - p.staleDays * DAY
  const cpCutoff = at - p.checkpointDays * DAY
  const propCutoff = at - p.proposalDays * DAY
  const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c ?? 0)

  const staleNodes = one(
    "select count(*) c from acm_nodes where owner IS ? and status <> 'active' and coalesce(last_used_at, created_at) < ?",
    owner,
    staleCutoff,
  )
  const activeNodes = one("select count(*) c from acm_nodes where owner IS ? and status = 'active'", owner)
  // Same predicate gc uses: an evidence row older than the cutoff that no
  // surviving node still points at.
  const orphanSources = one(
    `select count(*) c from acm_source_events s
      where s.owner IS ? and s.created_at < ?
        and not exists (
          select 1 from acm_node_sources ns join acm_nodes n on n.id = ns.node_id
           where ns.source_id = s.id
             and not (n.status <> 'active' and coalesce(n.last_used_at, n.created_at) < ?))`,
    owner,
    staleCutoff,
    staleCutoff,
  )
  const retiredCheckpoints = one(
    'select count(*) c from acm_checkpoints where owner IS ? and superseded_by is not null and created_at < ?',
    owner,
    cpCutoff,
  )
  const checkpoints = one('select count(*) c from acm_checkpoints where owner IS ?', owner)
  const mailCutoff = at - p.mailboxDays * DAY
  const doneMail = one(
    "select count(*) c from acm_mailbox where owner IS ? and state = 'done' and coalesce(done_at, created_at) < ?",
    owner,
    mailCutoff,
  )
  const openMail = one("select count(*) c from acm_mailbox where owner IS ? and state <> 'done'", owner)
  const retiredProposals = one(
    "select count(*) c from acm_persona_proposals where owner IS ? and state <> 'pending' and created_at < ?",
    owner,
    propCutoff,
  )

  let backups = 0
  let backupBytes = 0
  if (backupDir && existsSync(backupDir)) {
    const files = listBackups(backupDir)
    backups = files.length
    for (const file of files) {
      try { backupBytes += statSync(file).size } catch {}
    }
  }

  return {
    policy: p,
    eligible: {
      nodes: staleNodes,
      sources: orphanSources,
      checkpoints: retiredCheckpoints,
      proposals: retiredProposals,
      mailbox: doneMail,
      backups: Math.max(0, backups - Math.max(0, p.backupKeep)),
    },
    totals: { activeNodes, staleNodes, checkpoints, backups, backupBytes, openMail },
    note: 'Only superseded or forgotten rows age out. Active memories are erased only by an explicit purge.',
    meta: { writes: Number(metaGet(db, 'writes', 0) ?? 0), at },
  }
}
