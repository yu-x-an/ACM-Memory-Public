import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Automatic backup.
 *
 * The database is the single source of truth, but it is one file: one wrong delete wipes it out.
 * Use `vacuum into` to take a snapshot: it locks and tidies itself, and the X-ray is complete.
 * No need to checkpoint then copy: a write midway through a copy yields a database torn in half.
 */
export const BACKUP_DEFAULT = { enabled: true, everyHours: 6, keep: 7, dir: null }

export const BACKUP_PREFIX = 'memory-'

function stamp(at) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function backupDirFor(dbPath, dir = null) {
  return dir || join(dirname(dbPath), 'backups')
}

export function listBackups(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.db'))
    .sort()
    .map((f) => join(dir, f))
}

export function pruneBackups(dir, keep = BACKUP_DEFAULT.keep) {
  const n = Number(keep)
  if (!(n >= 0)) return 0
  const files = listBackups(dir)
  const extra = files.length - n
  if (extra <= 0) return 0
  const doomed = files.slice(0, extra)
  let pruned = 0
  for (const f of doomed) {
    try {
      unlinkSync(f)
      pruned += 1
    } catch {}
  }
  return pruned
}

/**
 * Back up when due; when not due, do nothing at all (no copying, no directory creation).
 * Returns { created?, pruned?, skipped? }; callers need not handle failure - backup must not
 * drag down the main flow.
 */
export function backupIfDue(db, dbPath, opts = {}, now = Date.now()) {
  const cfg = { ...BACKUP_DEFAULT, ...(opts ?? {}) }
  if (!cfg.enabled) return { skipped: 'disabled' }
  if (!dbPath || !existsSync(dbPath)) return { skipped: 'no-db' }
  const dir = backupDirFor(dbPath, cfg.dir)
  const files = listBackups(dir)
  const last = files.length ? files[files.length - 1] : null
  if (last) {
    let age = Infinity
    try { age = now - statSync(last).mtimeMs } catch {}
    if (age < Number(cfg.everyHours) * 3600e3) {
      return { skipped: 'recent', last: basename(last) }
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${BACKUP_PREFIX}${stamp(now)}.db`)
    const tmp = `${target}.tmp`
    // vacuum into does not allow an existing target, so write under a temporary name, then rename;
    // rename is atomic, so no half snapshot is left behind
    try { unlinkSync(tmp) } catch {}
    db.exec(`vacuum into '${tmp.replace(/'/g, "''")}'`)
    renameSync(tmp, target)
    // Prove the new snapshot before it can cause an older one to be deleted:
    // pruning first would let a broken snapshot evict the last good recovery point.
    const proof = checkBackup(target)
    if (!proof.ok) {
      // Leaving it would make the next run treat this file as the most recent
      // snapshot and skip, so one bad write would stall backups until it aged out.
      try { unlinkSync(target) } catch {}
      return { skipped: 'unverified', error: proof.reason ?? 'check-failed', target: basename(target), dir }
    }
    const pruned = pruneBackups(dir, cfg.keep)
    return { created: basename(target), pruned, dir, nodes: proof.nodes }
  } catch (err) {
    return { skipped: 'error', error: String(err?.message ?? err), dir }
  }
}

/**
 * Prove that a backup file is a real recovery point.
 *
 * A file on disk is not a backup until it opens, passes SQLite's integrity
 * check and still contains the schema. Corrupted or truncated copies must be
 * reported, not discovered during an incident.
 */
export function checkBackup(path) {
  if (!existsSync(path)) return { ok: false, path, reason: 'missing' }
  let raw = null
  try {
    raw = new DatabaseSync(path, { readOnly: true })
    const verdictRow = raw.prepare('pragma integrity_check').get()
    const verdict = verdictRow ? Object.values(verdictRow)[0] : null
    if (verdict !== 'ok') return { ok: false, path, reason: `integrity:${verdict}` }
    const nodes = Number(raw.prepare("select count(*) c from acm_nodes where status = 'active'").get().c)
    const version = Number(raw.prepare('select max(version) v from acm_schema_migrations').get()?.v ?? 0)
    const stat = statSync(path)
    return { ok: true, path, nodes, schema: version, at: Number(stat.mtimeMs), bytes: stat.size }
  } catch (err) {
    return { ok: false, path, reason: `open:${err?.message ?? err}` }
  } finally {
    try { raw?.close() } catch {}
  }
}

/** Check every backup in a directory, newest first, as recovery evidence. */
export function verifyBackups(dir) {
  return listBackups(dir)
    .map((file) => checkBackup(file))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/**
 * Restore a snapshot to a target path.
 *
 * Recovery is a copy followed by proof: the copy is written to a temporary name,
 * renamed into place (so a half-written file never looks like a database), then
 * opened and integrity-checked before the caller is told it worked. Restoring
 * over an existing database requires `force`, because silently replacing the
 * live file is the kind of mistake that turns one incident into two.
 */
export function restoreBackup(source, target, { force = false, allowLive = false } = {}) {
  if (!source || !existsSync(source)) return { ok: false, reason: 'source-missing' }
  if (!target) return { ok: false, reason: 'target-required' }
  // A non-empty write-ahead log means a connection is (or was) mid-flight on the
  // target. Replacing the file under it loses that WAL and can corrupt both
  // sides, so restoring into a live database needs an explicit opt-in after a
  // clean shutdown.
  if (!allowLive) {
    const wal = `${target}-wal`
    try {
      if (existsSync(wal) && statSync(wal).size > 0) return { ok: false, reason: 'live-database', wal }
    } catch {}
  }
  if (existsSync(target) && !force) return { ok: false, reason: 'target-exists' }
  const tmp = `${target}.restore-tmp`
  try {
    mkdirSync(join(target, '..'), { recursive: true })
  } catch {}
  try {
    try { unlinkSync(tmp) } catch {}
  } catch {}
  try {
    copyFileSync(source, tmp)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    return { ok: false, reason: `copy-failed:${err?.message ?? err}` }
  }

  // Prove the staged copy before it can touch the destination. The old order
  // renamed it into place first and only then checked it, so a corrupt source
  // destroyed a good target and reported 'restored-copy-unusable' afterwards.
  const staged = checkBackup(tmp)
  if (!staged.ok) {
    try { unlinkSync(tmp) } catch {}
    return { ok: false, reason: 'source-unusable', detail: staged, target }
  }

  // Keep the previous target until the new file has been proven in place.
  let previous = null
  if (existsSync(target)) {
    previous = `${target}.replaced-${Date.now()}`
    try {
      renameSync(target, previous)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      return { ok: false, reason: `preserve-failed:${err?.message ?? err}` }
    }
  }

  try {
    renameSync(tmp, target)
  } catch (err) {
    if (previous) { try { renameSync(previous, target) } catch {} }
    try { unlinkSync(tmp) } catch {}
    return { ok: false, reason: `copy-failed:${err?.message ?? err}` }
  }

  // A stale write-ahead log belongs to the file that just left.
  for (const suffix of ['-wal', '-shm']) {
    try { unlinkSync(`${target}${suffix}`) } catch {}
  }

  const check = checkBackup(target)
  if (!check.ok) {
    // Roll back to the file the operator already had.
    try { unlinkSync(target) } catch {}
    if (previous) { try { renameSync(previous, target) } catch {} }
    return { ok: false, reason: 'restored-copy-unusable', detail: check, target, rolledBack: Boolean(previous) }
  }
  if (previous) { try { unlinkSync(previous) } catch {} }
  return { ok: true, target, source, nodes: check.nodes, schema: check.schema, bytes: check.bytes }
}
