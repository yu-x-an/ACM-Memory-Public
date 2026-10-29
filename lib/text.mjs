// Tokenization: Chinese into bigrams, English as whole words - both go into the same shadow column.
//
// Why Chinese cannot use FTS5 trigram: measured, it indexes only 3-character windows, so queries for
// two-character Chinese terms ("park", "sea", "height") all return 0 - yet the most common Chinese
// search terms are two characters. Why English must not be split into bigrams: it would shatter words
// and create noise for nothing. So handle each character class separately; the index column is called
// tokens, and search uses the same function.

import { createHash } from 'node:crypto'

const ASCII_RUN = /[\x00-\x7f]+/
const RUN = /[\p{L}\p{N}]+/gu

export function normalize(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/** English whole words (>= 2 characters) + sliding windows of two adjacent Chinese characters */
export function tokens(s) {
  const out = new Set()
  const runs = normalize(s).toLowerCase().match(RUN) ?? []
  for (const run of runs) {
    const pieces = run.match(/[\x00-\x7f]+|[^\x00-\x7f]+/g) ?? [run]
    for (const piece of pieces) {
      if (ASCII_RUN.test(piece) && /^[\x00-\x7f]+$/.test(piece)) {
        if (piece.length >= 2) out.add(piece)
        continue
      }
      const chars = [...piece]
      if (chars.length === 1) out.add(chars[0])
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
    }
  }
  return [...out]
}

export const tokenText = (s) => tokens(s).join(' ')

export function sha256(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex')
}

/** Rough token estimate: Chinese counted per character, ASCII at 4 characters per token */
export function roughTokens(s) {
  const t = String(s ?? '')
  let cjk = 0
  let other = 0
  for (const ch of t) {
    if (ch.codePointAt(0) > 0x2e80) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** Truncate to budget, closing at sentence punctuation where possible */
export function clamp(s, maxChars) {
  const t = String(s ?? '')
  if (t.length <= maxChars) return t
  const head = t.slice(0, maxChars)
  const cut = Math.max(
    head.lastIndexOf('\n'),
    head.lastIndexOf('\u3002'),
    head.lastIndexOf('\uFF1B'),
    head.lastIndexOf('. '),
  )
  return (cut > maxChars * 0.5 ? head.slice(0, cut + 1) : head) + '…'
}
