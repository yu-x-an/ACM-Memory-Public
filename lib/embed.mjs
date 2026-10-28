/**
 * \u8BED\u4E49\u53EC\u56DE\uFF08\u672C\u5730\u5C0F\u6A21\u578B\uFF09\u3002
 *
 * FTS \u53EA\u8BA4\u5B57\u9762\uFF0C\u540C\u4E49\u6539\u5199\u5C31\u6F0F\u3002\u8FD9\u91CC\u585E\u4E00\u4E2A bge-small-zh\uFF08\u91CF\u5316 23MB\uFF09\uFF0C
 * \u7EAF\u672C\u5730\u8DD1\uFF0C\u6A21\u578B\u4E0E\u8FD0\u884C\u65F6\u5C31\u653E\u5728 lib/vendor \u4E0B\uFF0C\u4E0D\u8054\u7F51\u3001\u4E0D\u88C5\u989D\u5916\u4F9D\u8D56\u3002
 *
 * \u7528\u5B83\u7684\u5730\u65B9\u53EA\u6709\u300C\u5019\u9009\u6392\u5E8F\u300D\uFF1A\u547D\u4E2D\u8FD8\u662F\u9760 FTS + \u522B\u540D\uFF0C\u5411\u91CF\u8D1F\u8D23\u628A
 * \u300C\u5B57\u9762\u4E0D\u91CD\u5408\u4F46\u610F\u601D\u76F8\u8FD1\u300D\u7684\u6761\u76EE\u635E\u4E0A\u6765\uFF0C\u5E76\u7ED9\u540C\u4E49\u547D\u4E2D\u52A0\u4E00\u70B9\u5206\u3002
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { metaGet, metaSet } from './db.mjs'
import { decodeVector, vecToBuf } from './vec.mjs'
import { nodesByIds, search, touch } from './memory.mjs'

export const EMBED_DEFAULT = {
  enabled: true,
  model: 'bge-small-zh-v1.5',
  dim: 512,
  // Lower bound only, not a relevance guarantee. Measured with the bundled
  // model: unrelated same-language pairs sit near 0.33-0.50, so no absolute
  // cosine cleanly separates "related" from "unrelated". Semantic scores are
  // therefore used to rank candidates, never to certify relevance.
  minCos: 0.25,
  // Weight of the semantic term added to the lexical score (lexical itself
  // lands around 0.6 for a direct hit).
  weight: 0.5,
  topK: 24,
  maxLen: 160,
  batch: 32,
  // Automatic injection uses the same hybrid ranker as the search tool.
  // Set false to keep injection lexical-only (no model load per refresh).
  inject: true,
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const MODEL_DIR = join(HERE, 'vendor', 'bge-small-zh')
const ORT_DIR = join(HERE, 'vendor', 'ort', 'node_modules', 'onnxruntime-web', 'dist')

let rt = null        // { ort, session, vocab }
let loading = null

function wordpieceVocab() {
  const file = join(MODEL_DIR, 'vocab.base64.txt')
  if (!existsSync(file)) throw new Error('embed: vocab.txt \u4E0D\u5728')
  const map = new Map()
  Buffer.from(readFileSync(file, 'utf8').trim(), 'base64').toString('utf8').split(/\r?\n/).forEach((w, i) => {
    if (w) map.set(w, i)
  })
  return map
}

async function runtime() {
  if (rt) return rt
  if (loading) return loading
  loading = (async () => {
    const modelFile = join(MODEL_DIR, 'model_quantized.onnx')
    if (!existsSync(modelFile)) throw new Error('embed: \u6A21\u578B\u4E0D\u5728')
    // \u8FD0\u884C\u65F6\u662F vendored \u7684\uFF1A\u4E0D\u4F9D\u8D56 npm\uFF0C\u4E0D\u8054\u7F51
    const ort = await import(new URL('./vendor/ort/node_modules/onnxruntime-web/dist/ort.node.min.mjs', import.meta.url).href)
    ort.env.wasm.wasmPaths = new URL('./vendor/ort/node_modules/onnxruntime-web/dist/', import.meta.url).href
    ort.env.wasm.numThreads = 1
    const session = await ort.InferenceSession.create(modelFile, { executionProviders: ['wasm'] })
    rt = { ort, session, vocab: wordpieceVocab() }
    return rt
  })()
  return loading
}

const isCjk = (ch) => /[\u3400-\u9fff\uf900-\ufaff]/.test(ch)
const isPunct = (ch) => /[\s\p{P}\p{S}]/u.test(ch)

/** \u7C97\u5207\uFF1A\u4E2D\u6587\u6309\u5B57\uFF0C\u5176\u4F59\u6309\u5B57\u6BCD\u6570\u5B57\u4E32\uFF08bge \u5C31\u662F\u8FD9\u4E48\u5582\u7684\uFF09 */
export function basicTokens(text) {
  const out = []
  let buf = ''
  for (const ch of String(text ?? '').toLowerCase()) {
    if (isCjk(ch)) {
      if (buf) { out.push(buf); buf = '' }
      out.push(ch)
    } else if (isPunct(ch)) {
      if (buf) { out.push(buf); buf = '' }
    } else {
      buf += ch
    }
  }
  if (buf) out.push(buf)
  return out
}

export function encode(text, vocab, { maxLen = EMBED_DEFAULT.maxLen } = {}) {
  const cls = vocab.get('[CLS]') ?? 101
  const sep = vocab.get('[SEP]') ?? 102
  const unk = vocab.get('[UNK]') ?? 100
  const ids = [cls]
  outer: for (const word of basicTokens(text)) {
    let start = 0
    while (start < word.length) {
      let end = word.length
      let id = -1
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + word.slice(start, end)
        const hit = vocab.get(piece)
        if (hit !== undefined) { id = hit; break }
        end -= 1
      }
      if (id < 0) id = unk
      ids.push(id)
      if (ids.length >= maxLen - 1) break outer
      start = end
    }
  }
  ids.push(sep)
  return ids
}

/**
 * Pool `last_hidden_state` into one sentence vector.
 *
 * bge-v1.5 is trained with CLS pooling: the first token carries the sentence
 * embedding. The previous mean pooling over all tokens measurably compressed
 * the similarity range (unrelated pairs sat around 0.5) and reordered results.
 * Measured with the bundled bge-small-zh model, a Chinese query against its
 * matching English fact scored 0.334 under mean pooling and 0.448 under CLS.
 */
function pool(lastHidden, { dim }) {
  const vec = new Float32Array(dim)
  for (let d = 0; d < dim; d += 1) vec[d] = lastHidden[d]
  let norm = 0
  for (let d = 0; d < dim; d += 1) norm += vec[d] * vec[d]
  norm = Math.sqrt(norm) || 1
  for (let d = 0; d < dim; d += 1) vec[d] /= norm
  return vec
}

export async function embedText(text, { maxLen } = {}) {
  const { ort, session, vocab } = await runtime()
  const ids = encode(text, vocab, { maxLen })
  const mask = new Array(ids.length).fill(1)
  const i64 = (arr) => new ort.Tensor('int64', BigInt64Array.from(arr.map((n) => BigInt(n))), [1, arr.length])
  const out = await session.run({
    input_ids: i64(ids),
    attention_mask: i64(mask),
    token_type_ids: i64(new Array(ids.length).fill(0)),
  })
  const h = out.last_hidden_state
  return pool(h.data, { ids, dim: h.dims[2] })
}

// bge-v1.5 retrieval: queries carry an instruction prefix, documents do not.
// The prefix is stored as escapes so the maintained tree stays ASCII-clean.
const QUERY_INSTRUCTION =
  '\u4e3a\u8fd9\u4e2a\u53e5\u5b50\u751f\u6210\u8868\u793a\u4ee5\u7528\u4e8e\u68c0\u7d22\u76f8\u5173\u6587\u7ae0\uff1a'

/**
 * Embed a search query. Retrieval queries use the model's instruction prefix;
 * documents are embedded with `embedText` and no prefix.
 */
export async function embedQuery(text, opts = {}) {
  return embedText(QUERY_INSTRUCTION + text, opts)
}

export function cosine(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

export function putVector(db, id, vec, model = EMBED_DEFAULT.model, at = Date.now()) {
  // node_id \u5B58\u6210\u6574\u6570\u5B57\u7B26\u4E32\uFF1A\u9A71\u52A8\u53EF\u80FD\u628A 1 \u7ED9\u6210 1.0\uFF0C'1.0' \u548C\u6574\u6570 1 join \u4E0D\u4E0A
  const key = String(Math.trunc(Number(id)))
  db.prepare(
    'insert into acm_vectors (node_id, model, dim, vec, at) values (?, ?, ?, ?, ?) ' +
      'on conflict(node_id) do update set model = excluded.model, dim = excluded.dim, vec = excluded.vec, at = excluded.at',
  ).run(key, model, vec.length, vecToBuf(vec), at)
}

export function getVector(db, id) {
  const row = db.prepare('select vec, dim from acm_vectors where node_id = ?').get(String(Math.trunc(Number(id))))
  if (!row) return null
  return decodeVector(row.vec, row.dim)
}

/** \u7ED9\u8FD8\u6CA1\u5411\u91CF\u7684\u8282\u70B9\u8865\u4E0A\uFF0C\u8FD4\u56DE\u8865\u4E86\u51E0\u6761 */
export async function embedMissing(db, { limit = 50, batch = EMBED_DEFAULT.batch } = {}) {
  const rows = db
    .prepare(
      'select n.id, n.text, n.gloss from acm_nodes n left join acm_vectors v on v.node_id = n.id ' +
        "where n.status = 'active' and v.node_id is null order by n.id limit ?",
    )
    .all(limit)
  // Whether the store was already consistent before this pass decides if the
  // new rows may claim the current fingerprint. Adding new-encoding rows to an
  // old-encoding database would otherwise mix incompatible vector spaces.
  // This pass is global maintenance, so it needs a whole-store count rather
  // than a partition-scoped one.
  const before = {
    done: Number(db.prepare('select count(*) c from acm_vectors').get().c),
    fingerprint: storedFingerprint(db),
  }
  let done = 0
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch)
    for (const row of slice) {
      // Score the Chinese gloss too: a Chinese question against an English fact
      // is only about 30% cosine, but with the gloss it reaches 60% and up.
      const input = row.gloss ? `${row.text} ${row.gloss}` : row.text
      const vec = await embedText(input)
      putVector(db, row.id, vec)
      done += 1
    }
  }
  if (done && (before.done === 0 || before.fingerprint === EMBED_FINGERPRINT)) {
    metaSet(db, 'embed_fingerprint', EMBED_FINGERPRINT)
  }
  return done
}

export async function semanticCandidates(db, query, { scope = 'global', owner = null, limit = EMBED_DEFAULT.topK, minCos = EMBED_DEFAULT.minCos, allowStale = false } = {}) {
  if (!query) return []
  // Vectors written by a different encoding are not comparable with a query
  // embedded by this one. Ranking them anyway returns confident nonsense, so the
  // stale space is refused and hybrid recall falls back to lexical until
  // `reembedAll` rebuilds it. `allowStale` exists only for diagnostics.
  if (!allowStale && storedFingerprint(db) !== null && storedFingerprint(db) !== EMBED_FINGERPRINT) return []
  const rows = db
    .prepare(
      'select v.node_id, v.vec, v.dim from acm_vectors v join acm_nodes n on n.id = v.node_id ' +
        "where n.status = 'active' and (n.scope = 'global' or n.scope = ?) and n.owner IS ?",
    )
    .all(scope, owner)
  if (!rows.length) return []
  const qv = await embedQuery(query)
  const scored = []
  for (const row of rows) {
    const vec = decodeVector(row.vec, row.dim)
    if (!vec) continue
    const cos = cosine(qv, vec)
    if (cos >= minCos) scored.push({ id: Number(row.node_id), cos })
  }
  scored.sort((a, b) => b.cos - a.cos)
  const top = scored.slice(0, limit)
  const nodes = nodesByIds(db, top.map((s) => s.id), owner)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return top.map((s) => ({ ...byId.get(s.id), cos: s.cos })).filter((n) => n.id)
}

/**
 * \u5B57\u9762 + \u8BED\u4E49\u4E00\u8D77\u6392\u3002
 * \u5B57\u9762\u5206\u7167\u65E7\uFF08\u8986\u76D6\u5EA6/\u91CD\u8981\u5EA6/\u65F6\u65B0\u5EA6\uFF09\uFF0C\u8BED\u4E49\u5206\u5F53\u52A0\u6210\uFF0C\u4E0D\u8986\u76D6\u5B57\u9762\u5206\uFF1A
 * \u4E13\u540D\u3001\u77ED\u4E2D\u6587\u8BCD\u4E0A FTS \u66F4\u51C6\uFF0C\u5411\u91CF\u53EA\u8865\u300C\u6362\u4E86\u4E2A\u8BF4\u6CD5\u300D\u3002
 */
export async function hybridSearch(db, query, { scope = 'global', owner = null, limit = 6, weight = EMBED_DEFAULT.weight, minCos = EMBED_DEFAULT.minCos } = {}) {
  const literal = search(db, { query, scope, owner, limit: Math.max(limit * 3, 12) })
  const byId = new Map(literal.map((n) => [n.id, { ...n }]))
  const sem = await semanticCandidates(db, query, { scope, owner, limit: Math.max(limit * 3, EMBED_DEFAULT.topK), minCos })
  for (const n of sem) {
    const prev = byId.get(n.id)
    if (prev) prev.score += weight * n.cos
    else byId.set(n.id, { ...n, score: weight * n.cos, semantic: true })
  }
  const out = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  touch(db, out.map((n) => n.id))
  return out
}

/**
 * Identity of the vector space produced by this build: model, pooling method,
 * query-side prefix and dimension. Vectors recorded under a different identity
 * were produced by a different encoding, so query and document vectors would
 * no longer share a space. Changing pooling without this check would silently
 * degrade recall for every existing database.
 */
export const EMBED_FINGERPRINT = `${EMBED_DEFAULT.model}|pool=cls|query=instruct|dim=${EMBED_DEFAULT.dim}`

export function storedFingerprint(db) {
  return metaGet(db, 'embed_fingerprint', null)
}

export function fingerprintMatches(db) {
  return storedFingerprint(db) === EMBED_FINGERPRINT
}

/** Give `/acm/status` an answer without loading the model: read tables only. */
export function vectorStats(db, { owner = null } = {}) {
  // Counted per partition: the previous version counted every active node and
  // every vector, which leaked another owner's volumes and also made `missing`
  // wrong whenever a stale vector belonged to an inactive row.
  const total = Number(
    db.prepare("select count(*) c from acm_nodes where status = 'active' and owner IS ?").get(owner).c,
  )
  const done = Number(
    db
      .prepare(
        "select count(*) c from acm_vectors v join acm_nodes n on n.id = v.node_id where n.status = 'active' and n.owner IS ?",
      )
      .get(owner).c,
  )
  const orphans = Number(
    db
      .prepare(
        'select count(*) c from acm_vectors v where not exists (select 1 from acm_nodes n where n.id = v.node_id and n.status = \'active\' and n.owner IS ?)',
      )
      .get(owner).c,
  )
  const model = metaGet(db, 'embed_model') ?? null
  const fingerprint = storedFingerprint(db)
  // Existing vectors are stale when they were written by a different encoding.
  const stale = done > 0 && fingerprint !== EMBED_FINGERPRINT
  return { total, done, missing: Math.max(0, total - done), orphans, model, loaded: Boolean(rt), fingerprint, stale }
}

export function markModel(db, model = EMBED_DEFAULT.model) {
  metaSet(db, 'embed_model', model)
}

/**
 * Recompute every active vector with the current encoding.
 *
 * This is the migration path for a pooling or model change: it rewrites rows in
 * place and records the new fingerprint last, so an interrupted run leaves the
 * database marked stale and the operation can simply be repeated.
 */
export async function reembedAll(db, { batch = EMBED_DEFAULT.batch, onProgress = null } = {}) {
  const rows = db
    .prepare("select id, text, gloss from acm_nodes where status = 'active' order by id")
    .all()
  let done = 0
  for (let i = 0; i < rows.length; i += batch) {
    for (const row of rows.slice(i, i + batch)) {
      const input = row.gloss ? `${row.text} ${row.gloss}` : row.text
      putVector(db, row.id, await embedText(input))
      done += 1
    }
    if (onProgress) onProgress(done, rows.length)
  }
  // Recorded only after every row is rewritten.
  metaSet(db, 'embed_fingerprint', EMBED_FINGERPRINT)
  return done
}

export async function warmup() {
  await runtime()
  return true
}

export function isLoaded() {
  return Boolean(rt)
}
