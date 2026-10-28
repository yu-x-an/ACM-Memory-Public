// Evolution: let the database improve itself a little. No code changes, only data inside it.
//
// One evolution round does three things:
//   1. Merge near-duplicates - phrasings of the same set of words become one entry, with source
//      and edges moved over;
//   2. Tune scoring weights from feedback - more wrong answers means more trust in "confirmed"
//      and less in literal coverage;
//   3. Record a report so one can look back at how it changed.
//
// When not to do it: with too little feedback (<5 entries) do not tune; that is noise.

import {
  feedbackStats,
  loadWeights,
  mergeDuplicates,
  setWeights,
  weightsNow,
} from './memory.mjs'

export const MIN_FEEDBACK = 5
export const FEEDBACK_WINDOW = 100   // Recent votes only, so old history cannot pin the weights to an extreme

function tuneFromFeedback({ useful, wrong }) {
  const total = useful + wrong
  const before = weightsNow()
  if (total < MIN_FEEDBACK) return { changed: false, reason: 'too-little-feedback', weights: before }

  const wrongRate = wrong / total
  let next = { ...before }
  if (wrongRate > 0.3) {
    // Retrieved items are often wrong: trust importance more, literal matching less, do not widen edges
    next.importance = Math.min(0.5, before.importance + 0.03)
    next.coverage = Math.max(0.3, before.coverage - 0.03)
    next.hopPenalty = Math.max(0.2, before.hopPenalty - 0.05)
  } else if (wrongRate < 0.1) {
    // Mostly correct: literal matching and expansion are reliable enough; pull back a little
    // toward conservatism
    next.coverage = Math.min(0.8, before.coverage + 0.02)
    next.importance = Math.max(0.1, before.importance - 0.01)
  }
  const changed = ['coverage', 'importance', 'recency', 'hopPenalty'].some((k) => next[k] !== before[k])
  return { changed, wrongRate, weights: next }
}

/** Run one evolution round. dryRun computes but does not write. */
export function evolve(db, { dryRun = false, at = Date.now() } = {}) {
  loadWeights(db)
  const before = weightsNow()
  const fb = feedbackStats(db, { window: Math.max(MIN_FEEDBACK, FEEDBACK_WINDOW) })
  const merge = mergeDuplicates(db, { dryRun, at })
  const tune = tuneFromFeedback(fb)
  const weights = tune.changed && !dryRun ? setWeights(db, tune.weights) : (tune.weights ?? before)

  const report = {
    at,
    dryRun,
    merged: merge.merged,
    mergedPairs: dryRun ? merge.pairs.slice(0, 20) : undefined,
    feedback: fb,
    feedbackEnough: fb.useful + fb.wrong >= MIN_FEEDBACK,
    weightsBefore: before,
    weightsAfter: weights,
    tuned: !dryRun && !!tune.changed,
    reason: tune.reason ?? null,
    wrongRate: tune.wrongRate ?? null,
  }

  if (!dryRun) {
    try {
      db.prepare('insert into acm_evolutions (at, report) values (?, ?)').run(at, JSON.stringify(report))
    } catch {}
  }
  return report
}

export function evolutionLog(db, limit = 10) {
  return db
    .prepare('select id, at, report from acm_evolutions order by id desc limit ?')
    .all(limit)
    .map((r) => ({ id: Number(r.id), at: Number(r.at), report: JSON.parse(r.report) }))
}

export function renderEvolution(report) {
  const w = (o) => `\u8986\u76D6 ${o.coverage.toFixed(2)} / \u91CD\u8981 ${o.importance.toFixed(2)} / \u65B0\u8FD1 ${o.recency.toFixed(2)} / \u6269\u8FB9\u60E9\u7F5A ${o.hopPenalty.toFixed(2)}`
  const lines = [`\u5408\u5E76 ${report.merged} \u6761\u91CD\u590D`]
  lines.push(`feedback\uFF1A\u5BF9 ${report.feedback.useful} / \u9519 ${report.feedback.wrong}`)
  if (report.tuned) {
    lines.push(`\u6743\u91CD ${w(report.weightsBefore)} → ${w(report.weightsAfter)}`)
  } else if (!report.feedbackEnough) {
    lines.push('feedback \u8FD8\u4E0D\u591F\uFF0C\u5148\u4E0D\u8C03\u6743\u91CD')
  } else {
    lines.push('\u8FD9\u8F6E\u4E0D\u7528\u8C03\u6743\u91CD')
  }
  return lines.join('\n')
}
