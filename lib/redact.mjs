/**
 * Redaction.
 *
 * Distillation turns "what the user said" into long-term memory, but speech often contains things
 * that should not be kept long-term: keys, phone numbers, ID cards, card numbers, passwords.
 * Writing them down writes secrets into a database injected into every turn's prompt, so mask before
 * they go in.
 *
 * Mask only values, not structure: `phone 138****0000` still shows the user left a phone number.
 */

export const MASK = '[\u5DF2\u9690\u53BB]'

const RULES = [
  // Whole private key block
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Common token prefixes
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Explicitly written passwords / secrets: keep the label, mask the value
  {
    name: 'password',
    re: /((?:\u5BC6\u7801|\u53E3\u4EE4|password|passwd|pwd|secret|token|apikey|api[-_ ]?key)\s*[:=\uFF1A\u662F]\s*)([^\s\uFF0C\u3002,;\uFF1B]{3,})/gi,
    replace: (_m, head) => `${head}${MASK}`,
  },
  // ID card (18 digits, the last may be X)
  { name: 'id-card', re: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },
  // Bank card (16-19 digits, spaces/hyphens allowed)
  { name: 'bank-card', re: /\b(?:\d[ -]?){15,18}\d\b/g },
  // Chinese mobile number
  { name: 'phone', re: /\b1[3-9]\d{9}\b/g },
  // Email (kept, but masked: no point storing it long-term)
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
]

export function redact(text, { extra = [] } = {}) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', hits: [] }
  let out = text
  const hits = []
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m) => {
      hits.push(rule.name)
      // Some rules keep the label ("password:" must still be visible); mask the value only
      return rule.replace ? rule.replace(...m) : MASK
    })
  }
  for (const item of extra) {
    const re = item instanceof RegExp ? item : new RegExp(String(item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    out = out.replace(re, () => { hits.push('custom'); return MASK })
  }
  return { text: out, hits: [...new Set(hits)] }
}

/** Answers only "does this contain any", for tests and logs; returns no original text */
export function hasSensitive(text, opts) {
  return redact(text, opts).hits.length > 0
}

export const REDACT_DEFAULT = { enabled: true, extra: [] }
