/**
 * Extraction gold set: the parser's acceptance rules.
 *
 * Scope note: this measures what `parseFacts` accepts from a model response, not
 * how good the model is at extracting. A real extraction-quality set needs
 * human-reviewed conversations and a model run; MCI-01 records that gap. What is
 * pinned here is the contract: which shapes of model output become memories.
 */
import assert from 'node:assert/strict'

import { parseFacts } from '../lib/distill.mjs'

let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

/** A well-formed response, the shape the prompt asks for. */
const good = JSON.stringify([
  { text: 'the project ships on fridays', zh: '\u9879\u76ee\u5468\u4e94\u53d1\u5e03', key: 'release.day', kind: 'fact', confidence: 0.9 },
  { text: 'master prefers short replies', zh: '\u8001\u5927\u559c\u6b22\u7b80\u77ed\u56de\u590d', kind: 'preference', confidence: 0.75 },
  { text: 'we decided to use sqlite', zh: '\u51b3\u5b9a\u7528 sqlite', key: 'project.database', kind: 'decision', confidence: 0.8 },
])

try {
  t('a well-formed response yields every fact with its fields intact', () => {
    const facts = parseFacts(good)
    assert.equal(facts.length, 3)
    assert.equal(facts[0].text, 'the project ships on fridays')
    assert.equal(facts[0].key, 'release.day')
    assert.equal(facts[0].kind, 'fact')
    assert.equal(facts[0].confidence, 0.9)
    assert.equal(facts[0].gloss, '\u9879\u76ee\u5468\u4e94\u53d1\u5e03')
    assert.equal(facts[1].key, null)
    assert.equal(facts[1].kind, 'preference')
  })

  t('a fenced block and surrounding prose are tolerated', () => {
    const facts = parseFacts('Sure. Here is the JSON:\n```json\n' + good + '\n```\nLet me know.')
    assert.equal(facts.length, 3)
  })

  t('truncated json is rejected rather than half-parsed', () => {
    assert.deepEqual(parseFacts(good.slice(0, good.length - 40)), [])
    assert.deepEqual(parseFacts('[{"text": "ends with a comma",}]'), [])
  })

  t('the confidence floor is inclusive and configurable', () => {
    const at = JSON.stringify([{ text: 'exactly at the floor', confidence: 0.5 }])
    assert.equal(parseFacts(at).length, 1, 'a fact at the floor was dropped')
    assert.equal(parseFacts(at, { minConfidence: 0.55 }).length, 0)
  })

  t('a missing confidence defaults rather than dropping the fact', () => {
    const facts = parseFacts(JSON.stringify([{ text: 'no confidence given' }]))
    assert.equal(facts.length, 1)
    assert.equal(facts[0].confidence, 0.6, 'default confidence changed')
  })

  t('length boundaries are enforced on both ends', () => {
    const short = parseFacts(JSON.stringify([{ text: 'abc' }]))
    assert.equal(short.length, 0, 'a 3-character fact was accepted')
    const atLimit = parseFacts(JSON.stringify([{ text: 'x'.repeat(240) }]))
    assert.equal(atLimit.length, 1)
    const overLimit = parseFacts(JSON.stringify([{ text: 'x'.repeat(241) }]))
    assert.equal(overLimit.length, 0, 'a 241-character fact was accepted')
  })

  t('the fact count is capped', () => {
    const many = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ text: `fact number ${i} with enough length` })))
    assert.equal(parseFacts(many, { maxFacts: 5 }).length, 5)
    assert.equal(parseFacts(many).length, 5, 'the default cap changed')
  })

  t('a gloss is kept only when it looks like Chinese phrasing', () => {
    const raw = JSON.stringify([
      { text: 'fact with a good gloss', zh: '\u8fd9\u662f\u4e00\u53e5\u4e2d\u6587', confidence: 0.8 },
      { text: 'fact with an english gloss', zh: 'this is english', confidence: 0.8 },
      { text: 'fact whose gloss copies the text', zh: 'fact whose gloss copies the text', confidence: 0.8 },
      { text: 'fact with a tiny gloss', zh: '\u5bf9', confidence: 0.8 },
      { text: 'fact with an overlong gloss', zh: '\u8fd9\u662f\u4e00\u53e5\u975e\u5e38\u957f\u7684\u4e2d\u6587\u8bf4\u6cd5\u7528\u6765\u6d4b\u8bd5\u957f\u5ea6\u9650\u5236\u7684\u60c5\u51b5', confidence: 0.8 },
    ])
    const facts = parseFacts(raw)
    assert.equal(facts.length, 5)
    assert.equal(facts[0].gloss, '\u8fd9\u662f\u4e00\u53e5\u4e2d\u6587')
    assert.equal(facts[1].gloss, null, 'an English gloss was kept')
    assert.equal(facts[2].gloss, null, 'a copied gloss was kept')
    assert.equal(facts[3].gloss, null, 'a too-short gloss was kept')
    assert.equal(facts[4].gloss, null, 'an overlong gloss was kept')
  })

  t('unknown kinds fall back to fact and numbers survive', () => {
    const facts = parseFacts(JSON.stringify([
      { text: 'a fact with an odd kind', kind: 'rumour', confidence: 0.7 },
      { text: 2026, confidence: 0.7 },
    ]))
    assert.equal(facts[0].kind, 'fact')
    assert.equal(facts[1].text, '2026', 'a numeric fact above the length floor is kept')
  })

  t('an empty response yields nothing without throwing', () => {
    for (const raw of ['', '   ', 'null', '{}', '[]', 'no json here']) {
      assert.deepEqual(parseFacts(raw), [], `input ${JSON.stringify(raw)} produced facts`)
    }
  })

  console.log(`\nextraction: ${pass} passed`)
} finally {
  // nothing to clean up
}
