// Distillation: refine raw conversation into nodes.
//
// Rules (all three must hold):
//   - Run only after a turn ends, never on the hot path, never blocking the user's next sentence
//   - Keep the source after extraction (verbatim original); the line from node back to raw text
//     must not break
//   - Do not guess relations: edges grow only within one source passage (co_source); never emit
//     subject/predicate/object

import { remember } from './memory.mjs'
import { normalize } from './text.mjs'
import { REDACT_DEFAULT, redact } from './redact.mjs'

export const DISTILL_DEFAULT = {
  enabled: true,
  maxFacts: 5,
  maxChars: 2400,
  minChars: 24,
  minConfidence: 0.5,
  maxTokens: 500,
  delayMs: 1200,
}

function systemPrompt(maxFacts) {
  return [
    '\u4F60\u662F\u8BB0\u5FC6\u62BD\u53D6\u5668\uFF1A\u4ECE\u4E00\u6BB5\u5BF9\u8BDD\u91CC\u6311\u51FA\u300C\u4EE5\u540E\u8FD8\u4F1A\u7528\u5230\u300D\u7684\u4E8B\u5B9E\u3001\u504F\u597D\u3001\u51B3\u5B9A\u3001\u7EA6\u5B9A\uFF0C\u5199\u6210\u8BB0\u5FC6\u8282\u70B9\u3002',
    '',
    '\u89C4\u77E9\uFF1A',
    '- \u53EA\u62BD\u539F\u6587\u91CC\u660E\u8BF4\u8FC7\u7684\u3002\u4E0D\u63A8\u65AD\u3001\u4E0D\u8865\u5168\u3001\u4E0D\u731C\u5173\u7CFB\u3001\u4E0D\u5408\u5E76\u4E24\u53E5\u8BDD\u3002',
    '- text \u7528\u82F1\u6587\u77ED\u8BED\uFF0C\u4E00\u53E5\u4E00\u4E2A\u4E8B\u5B9E\uFF0C\u77ED\uFF1B\u4EBA\u540D\u3001\u8DEF\u5F84\u3001\u547D\u4EE4\u3001\u4E13\u540D\u7167\u6284\u539F\u6587\u3002',
    '- zh \u662F\u540C\u4E00\u4EF6\u4E8B\u7684\u4E2D\u6587\u8BF4\u6CD5\uFF0C\u5C3D\u91CF\u7528\u63D0\u95EE\u65F6\u4F1A\u7528\u7684\u8BCD\uFF08\u5982\u300C\u8001\u5927\u7761\u89C9\u65F6\u95F4\u300D\uFF09\uFF0C\u4E0D\u8D85\u8FC7 20 \u5B57\u3002',
    '- key \u53EA\u5728\u6709\u660E\u786E\u552F\u4E00\u952E\u7684\u65F6\u5019\u7ED9\uFF08\u5982 master.bedtime\u3001project.name\uFF09\uFF0C\u5426\u5219\u4E0D\u8981\u8FD9\u4E2A\u5B57\u6BB5\u3002',
    '- kind \u53D6 fact / preference / decision \u4E4B\u4E00\u3002',
    '- confidence \u662F\u8FD9\u6761\u5728\u539F\u6587\u91CC\u7684\u786E\u5B9A\u7A0B\u5EA6 0-1\uFF1B\u5BD2\u6684\u3001\u53E3\u5934\u7985\u3001\u4E34\u65F6\u60C5\u7EEA\u3001\u4E00\u6B21\u6027\u64CD\u4F5C\u90FD\u4E0D\u62BD\u3002',
    `- \u6700\u591A ${maxFacts} \u6761\u3002\u5B9E\u5728\u6CA1\u6709\u5C31\u8F93\u51FA []\u3002`,
    '',
    '\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u4E0D\u52A0\u89E3\u91CA\uFF1A',
    '[{"text":"...","zh":"...","key":"...","kind":"fact","confidence":0.8}]',
  ].join('\n')
}

/**
 * Parse model output into a clean fact list, keeping the reason when it fails.
 *
 * `parseFacts` returns an array and never throws, which is convenient but loses
 * one distinction that matters: "the model replied []" and "the model replied
 * junk" both come back empty. The distillation cursor must not advance on the
 * second case, or that span is never retried, so this variant reports which
 * one happened.
 */
export function parseFactsDetailed(raw, opts = {}) {
  const maxFacts = opts.maxFacts ?? DISTILL_DEFAULT.maxFacts
  const minConfidence = opts.minConfidence ?? DISTILL_DEFAULT.minConfidence
  let s = String(raw ?? '').trim()
  if (!s) return { ok: false, reason: 'empty', facts: [] }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return { ok: false, reason: 'no-json', facts: [] }
  let arr
  try {
    arr = JSON.parse(s.slice(a, b + 1))
  } catch {
    return { ok: false, reason: 'invalid-json', facts: [] }
  }
  if (!Array.isArray(arr)) return { ok: false, reason: 'not-an-array', facts: [] }
  const out = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    // Only scalars: String({}) is "[object Object]", which would otherwise be
    // stored as a fact with that literal text.
    if (typeof it.text !== 'string' && typeof it.text !== 'number') continue
    const text = normalize(String(it.text))
    if (text.length < 4 || text.length > 240) continue
    if (text === '[object Object]' || text === 'undefined' || text === 'null') continue
    const conf = Number(it.confidence)
    const confidence = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.6
    if (confidence < minConfidence) continue
    const key = it.key && (typeof it.key === 'string' || typeof it.key === 'number')
      ? normalize(String(it.key)).slice(0, 80)
      : null
    const kind = ['fact', 'preference', 'decision', 'event'].includes(it.kind) ? it.kind : 'fact'
    // Chinese phrasing: users ask in Chinese while the node body is English - store one Chinese
    // phrasing and attach it to both the index and the vector.
    // The model's zh is not always reliable: missing Chinese, too long, or the English body copied
    // straight back - all are dropped.
    // A junk gloss is worse than no gloss; it pollutes the index and the vectors.
    const zh = cleanGloss(it.zh, text)
    out.push({ text, key, kind, confidence, gloss: zh })
    if (out.length >= maxFacts) break
  }
  return { ok: true, facts: out }
}

/** Array-shaped view of `parseFactsDetailed`, for callers that only need the facts. */
export function parseFacts(raw, opts = {}) {
  return parseFactsDetailed(raw, opts).facts
}

/** Accept only glosses that look like Chinese phrasing: contain Han characters, at most 24
 * characters, and are not identical to the English text */
function cleanGloss(raw, text) {
  if (!raw) return null
  const g = normalize(String(raw)).replace(/\s+/g, ' ').trim()
  if (!g || g.length > 18) return null
  if (!/[\u4e00-\u9fff]/.test(g)) return null
  if (g.toLowerCase() === String(text).toLowerCase()) return null
  // One or two characters ("yes", "correct") are useless
  if (g.replace(/[\s\p{P}]/gu, '').length < 3) return null
  return g
}

/** Pull a distillable span of raw text from the events. Returns { text, seq, cursor }. */
export function collectTurn(events, cursor, opts = {}) {
  const maxChars = opts.maxChars ?? DISTILL_DEFAULT.maxChars
  const from = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
  const parts = []
  let seq = null
  let len = 0
  let cursorOut = from
  for (let i = from; i < events.length; i++) {
    const ev = events[i]
    const type = ev?.type ?? ev?.kind
    if (type !== 'user/message' && type !== 'assistant/message') { cursorOut = i + 1; continue }
    const msg = ev?.data?.message ?? ev?.data ?? ev?.message
    const content = msg?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ')
    }
    text = normalize(text)
    if (!text) { cursorOut = i + 1; continue }
    // Keep only the start of the assistant side: decisions are usually in the first few sentences;
    // feeding it all in just wastes tokens
    if (type === 'assistant/message' && text.length > 500) text = `${text.slice(0, 500)}…`
    const line = `${type === 'user/message' ? '\u7528\u6237' : '\u52A9\u624B'}\uFF1A${text}`
    // An oversized first event is processed alone, never silently dropped.
    if (parts.length && len + line.length > maxChars) break
    if (seq === null) seq = ev?.seq ?? null
    parts.push(line)
    len += line.length
    cursorOut = i + 1
  }
  return { text: parts.join('\n'), seq, cursor: cursorOut }
}

/** Get the model this session is currently using. Return null if unavailable (do not burn money
 * on the default model). */
export function resolveTarget(ctx, agent) {
  try {
    const h = agent?.session?.requestHeader?.()
    const cfg = h?.config
    if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model, from: 'session' }
  } catch {}
  try {
    const o = agent?.options
    if (o?.provider && o?.model) return { provider: o.provider, model: o.model, from: 'agent' }
  } catch {}
  try {
    const svc = ctx.get?.('agentDefaultModel')
    const sel = svc?.currentSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model, from: 'default' }
  } catch {}
  return null
}

async function askModel(ctx, target, auto, user, maxTokens) {
  const chunks = ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    system: auto,
    messages: user,
    maxTokens,
    temperature: 0.1,
  })
  let out = ''
  for await (const chunk of chunks) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text ?? ''
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      const f = chunk.reason.failure ?? {}
      throw new Error(`model error: ${f.message ?? f.code ?? 'unknown'}`)
    }
  }
  return out
}

/**
 * Run one distillation round.
 * deps: { ctx, agent, db, sessionId, snippet, seq, createUserMessage, config, diag }
 * Returns { facts, written, error? }
 */
export async function distillOnce(deps) {
  const cfg = { ...DISTILL_DEFAULT, ...(deps.config ?? {}) }
  const diag = deps.diag ?? (() => {})
  const rawSnippet = String(deps.snippet ?? '').trim()
  if (rawSnippet.length < cfg.minChars) return { facts: [], written: 0, skipped: 'short' }
  // Raw text may carry keys / phone numbers / passwords: what the model sees is masked, and so is
  // what goes into the evidence table
  const guard = deps.redact ?? REDACT_DEFAULT
  const snippet = guard.enabled === false ? rawSnippet : redact(rawSnippet, guard).text

  const target = deps.target ?? resolveTarget(deps.ctx, deps.agent)
  if (!target) {
    diag('distill skipped: no model target')
    return { facts: [], written: 0, error: 'no-model' }
  }

  let messages
  try {
    if (typeof deps.createUserMessage === 'function') {
      messages = [
        deps.createUserMessage({
          content: [{ type: 'text', text: `\u5BF9\u8BDD\u7247\u6BB5\uFF1A\n${snippet}` }],
          source: { kind: 'plugin', plugin: 'dsh-acm-memory' },
        }),
      ]
    } else {
      messages = [{ role: 'user', content: [{ type: 'text', text: `\u5BF9\u8BDD\u7247\u6BB5\uFF1A\n${snippet}` }] }]
    }
  } catch (err) {
    diag(`distill message build failed: ${err?.message ?? err}`)
    return { facts: [], written: 0, error: 'message' }
  }

  let raw
  try {
    raw = await askModel(deps.ctx, target, systemPrompt(cfg.maxFacts), messages, cfg.maxTokens)
  } catch (err) {
    diag(`distill llm failed: ${err?.message ?? err}`)
    return { facts: [], written: 0, error: 'llm' }
  }

  const parsed = parseFactsDetailed(raw, cfg)
  if (!parsed.ok) return { ok: false, reason: `malformed:${parsed.reason}`, facts: [] }
  const facts = parsed.facts
  let written = 0
  let writeFailed = false
  for (const f of facts) {
    try {
      remember(deps.db, {
        scope: deps.sessionId,
        owner: deps.owner ?? null,
        text: f.text,
        gloss: f.gloss ?? null,
        key: f.key,
        kind: f.kind,
        importance: f.confidence,
        source: {
          sessionId: deps.sessionId,
          seq: deps.seq ?? null,
          kind: `distilled:${target.model}`,
          raw: snippet,
        },
      })
      written++
    } catch (err) {
      writeFailed = true
      diag(`distill write failed: ${err?.message ?? err}`)
    }
  }
  diag(`distill ${target.from}/${target.model}: ${facts.length} facts, ${written} written, ${snippet.length} chars`)
  return { facts, written, target, ...(writeFailed ? { error: 'write' } : {}) }
}
