// \u8BB0\u5FC6\u672C\u4F53\uFF1A\u5199\u5C31\u5E26\u6765\u6E90\uFF0C\u8BFB\u5C31\u5E26\u7406\u7531\uFF0C\u8FB9\u53EA\u8FDE\u6709\u8BC1\u636E\u7684\u5173\u7CFB\u3002

import { tokenText, tokens, normalize, sha256 } from './text.mjs'
import { metaGet, metaSet, tx } from './db.mjs'
import { decodeVector } from './vec.mjs'

const DEFAULT_HALF_LIFE_DAYS = 90

/** Escape LIKE metacharacters so a query matches literally, not as a pattern. */
/**
 * Encode an owner for hashing and grouping.
 *
 * The previous format used `owner ?? ''`, so the unnamed partition (null) and an
 * owner literally named '' produced the same evidence hash and could share one
 * source event. The encoding is typed and length-prefixed so no pair of owners
 * collides.
 */
export function ownerKey(owner) {
  if (owner == null) return 'n:'
  const s = String(owner)
  return `s:${s.length}:${s}`
}

export const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`)

export function recordSource(db, { sessionId = null, seq = null, kind = 'manual', raw, owner = null, at = Date.now() }) {
  // \u539F\u8BDD\u5F53\u8BC1\u636E\uFF1A\u53EA\u88C1\u9996\u5C3E\u7A7A\u767D\u3001\u9650\u957F\uFF0C\u4E0D\u6298\u884C\u4E0D\u91CD\u6392 —— \u8BC1\u636E\u8981\u80FD\u539F\u6837\u5BF9\u56DE\u53BB
  const text = String(raw ?? '').trim().slice(0, 8000)
  const hash = sha256(`${kind}|${ownerKey(owner)}|${sessionId ?? ''}|${normalize(text).toLowerCase()}`)
  const found = db.prepare('select id from acm_source_events where hash = ?').get(hash)
  if (found) return found.id
  const r = db
    .prepare(
      'insert into acm_source_events (session_id, seq, kind, raw, hash, owner, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(sessionId, seq, kind, text, hash, owner, at)
  return Number(r.lastInsertRowid)
}

function ftsDelete(db, nodeId) {
  db.prepare('delete from acm_fts where node_id = ?').run(nodeId)
}
function ftsInsert(db, nodeId, text) {
  db.prepare('insert into acm_fts (tokens, node_id) values (?, ?)').run(tokenText(text), nodeId)
}

/** \u540C\u4E00\u4E2A key \u5DF2\u6709 active \u4E8B\u5B9E\u65F6\u8D70\u5931\u6548\uFF0C\u4E0D\u8986\u76D6 —— \u8FD9\u6837"\u5979\u8EAB\u9AD8\u591A\u5C11"\u6C38\u8FDC\u53EA\u5269\u4E00\u4E2A\u7B54\u6848 */
function supersedeByKey(db, { scope, key, owner = null, at }) {
  if (!key) return null
  const old = db
    .prepare(
      "select id from acm_nodes where scope = ? and key = ? and status = 'active' and owner IS ?",
    )
    .get(scope, key, owner)
  return old ? old.id : null
}

export function attachGloss(db, nodeId, gloss, indexText, owner = null) {
  // Owner-scoped: an in-process caller must not rewrite another partition's row
  // (which also drops its vector and re-indexes the text).
  const cur = db.prepare('select gloss from acm_nodes where id = ? and owner IS ?').get(nodeId, owner)
  if (!cur) return false
  if (cur.gloss === gloss) return true
  db.prepare('update acm_nodes set gloss = ?, tokens = ? where id = ? and owner IS ?')
    .run(gloss, tokenText(indexText), nodeId, owner)
  ftsDelete(db, nodeId)
  ftsInsert(db, nodeId, indexText)
  db.prepare('delete from acm_vectors where node_id = ?').run(String(Math.trunc(Number(nodeId))))
  return true
}

export function remember(db, input) {
  const text = normalize(input.text)
  if (!text) throw new Error('empty memory text')
  const scope = input.scope ?? 'global'
  const kind = input.kind ?? 'fact'
  const owner = input.owner ?? null
  const at = input.at ?? Date.now()
  const importance = clamp01(input.importance ?? 0.5)
  // \u4E2D\u6587\u8BF4\u6CD5\uFF1A\u6B63\u6587\u662F\u82F1\u6587\u77ED\u8BED\uFF08\u4FBF\u4E8E agent \u8FDE\uFF09\uFF0C\u7528\u6237\u5374\u7528\u4E2D\u6587\u95EE\u3002\u4E24\u53E5\u62FC\u4E00\u8D77\u7D22\u5F15\u3001\u7B97\u5411\u91CF\u3002
  const gloss = input.gloss ? normalize(input.gloss) : null
  const indexText = gloss ? `${text} ${gloss}` : text

  return tx(db, () => {
    const sourceId = recordSource(db, {
      sessionId: input.source?.sessionId ?? (scope === 'global' ? null : scope),
      seq: input.source?.seq ?? null,
      kind: input.source?.kind ?? 'manual',
      raw: input.source?.raw ?? text,
      owner,
      at,
    })

    // \u540C\u4E00\u4EF6\u4E8B\u518D\u63D0\u4E00\u6B21\u4E0D\u65B0\u5EFA\u8282\u70B9 —— \u6302\u56DE\u539F\u6765\u90A3\u6761\uFF0C\u53EA\u52A0\u6765\u6E90\u3002
    // \u94FE\u5F0F\u5B58\u50A8\u9760\u7684\u5C31\u662F\u8FD9\u4E2A\uFF1A\u8282\u70B9\u5C11\u3001\u8FB9\u5BC6\uFF0C\u800C\u4E0D\u662F\u6BCF\u6B21\u90FD\u957F\u4E00\u6761\u65B0\u7684\u3002
    // The key is part of the identity: two facts with identical text but
    // different keys are different facts, and without it the query returned an
    // arbitrary row and turned an insert into a revision.
    const same = db
      .prepare("select id, key from acm_nodes where scope = ? and text = ? and status = 'active' and owner IS ? and key IS ?")
      .get(scope, text, owner, input.key ?? null)
    if (same) {
      const dupId = Number(same.id)
      db.prepare('insert or ignore into acm_node_sources (node_id, source_id) values (?, ?)').run(dupId, sourceId)
      db.prepare('update acm_nodes set importance = max(importance, ?), last_used_at = ?, used_count = used_count + 1 where id = ?')
        .run(importance, at, dupId)
      if (gloss) attachGloss(db, dupId, gloss, indexText, owner)
      return { id: dupId, superseded: null, deduped: true }
    }

    const oldId = supersedeByKey(db, { scope, key: input.key ?? null, owner, at })
    const r = db
      .prepare(
        `insert into acm_nodes
         (scope, kind, subject, predicate, object, key, text, tokens, importance, owner, valid_from, created_at, last_used_at, used_count)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        scope,
        kind,
        input.subject ?? null,
        input.predicate ?? null,
        input.object ?? null,
        input.key ?? null,
        text,
        tokenText(indexText),
        importance,
        owner,
        at,
        at,
        null,
      )
    const id = Number(r.lastInsertRowid)
    if (gloss) db.prepare("update acm_nodes set gloss = ? where id = ?").run(gloss, id)
    ftsInsert(db, id, indexText)
    db.prepare('insert or ignore into acm_node_sources (node_id, source_id) values (?, ?)').run(id, sourceId)


    if (oldId) {
      // \u65F6\u95F4\u8F74\uFF1A\u65E7\u7684\u4E0D\u662F\u5220\u6389\uFF0C\u662F"\u5230\u8FD9\u5C31\u7ED3\u675F\u4E86"\uFF0C\u4EC0\u4E48\u65F6\u5019\u7ED3\u675F\u7684\u4E5F\u8BB0\u4E0B\u6765
      db.prepare("update acm_nodes set status = 'superseded', superseded_by = ?, valid_to = ? where id = ?").run(id, at, oldId)
      ftsDelete(db, oldId)
      link(db, oldId, id, 'superseded_by', 1.0, at)
    }

    // \u522B\u540D\uFF1A\u4E8B\u5B9E\u952E\u62C6\u51FA\u6765\u7684\u89C4\u8303\u540D\uFF0C\u65B9\u4FBF\u4E0B\u6B21\u7528\u522B\u7684\u8BF4\u6CD5\u627E\u56DE\u6765
    if (input.key) {
      const alias = input.key.split('.').pop()
      if (alias && alias !== input.key) {
        db.prepare(
          'insert into acm_aliases (owner, alias, canonical) ' +
            'select ?, ?, ? where not exists (select 1 from acm_aliases where alias = ? and owner IS ?)',
        ).run(owner, alias, input.key, alias, owner)
      }
    }

    metaSet(db, 'writes', metaValue(db, 'writes', 0) + 1)
    return { id, superseded: oldId }
  })
}

/**
 * \u540C\u4E00\u6761\u6765\u6E90\u91CC\u51FA\u6765\u7684\u8282\u70B9\uFF0C\u7B97"\u540C\u6E90\u5144\u5F1F"\u3002
 *
 * \u4EE5\u524D\u662F\u4E24\u4E24\u8FDE\u4E00\u6761 co_source \u8FB9\uFF1A\u4E00\u53E5\u8BDD\u4EA7\u51FA 10 \u6761\u4E8B\u5B9E\u5C31\u662F 45 \u6839\u8FB9\uFF0C\u8D8A\u8BB0\u8D8A\u5BC6\uFF0C
 * \u8FD8\u5F97\u5199\u4E24\u4EFD\uFF08\u53CC\u5411\uFF09\u3002\u53EF"\u540C\u6E90"\u8FD9\u4EF6\u4E8B\u672C\u6765\u5C31\u8BB0\u5728 acm_node_sources \u91CC\uFF0C
 * \u8FB9\u662F\u5197\u4F59\u7684 —— \u67E5\u7684\u65F6\u5019 join \u4E00\u4E0B\u5C31\u884C\uFF0C\u8FB9\u6570\u4ECE O(n²) \u6389\u5230 0\u3002
 */
function sourceSiblings(db, ids, scope, owner, limit) {
  if (!ids.length || limit <= 0) return []
  const marks = ids.map(() => '?').join(',')
  return db
    .prepare(
      `select distinct n.id, n.scope, n.kind, n.key, n.text, n.importance, n.owner,
              n.valid_from, n.valid_to, n.created_at, n.used_count
         from acm_node_sources a
         join acm_node_sources b on b.source_id = a.source_id and b.node_id <> a.node_id
         join acm_nodes n on n.id = b.node_id
        where a.node_id in (${marks}) and n.status = 'active'
          and (n.scope = 'global' or n.scope = ?)
          and n.owner IS ?
        order by n.importance desc
        limit ?`,
    )
    .all(...ids, scope, owner, limit)
}
function metaValue(db, k, fallback = 0) {
  const row = db.prepare('select v from acm_meta where k = ?').get(k)
  return row ? Number(row.v) : fallback
}

export function link(db, src, dst, rel, weight = 1.0, at = Date.now()) {
  db.prepare('insert or ignore into acm_edges (src, dst, rel, weight, created_at) values (?, ?, ?, ?, ?)')
    .run(src, dst, rel, weight, at)
}

function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0.5
  return Math.min(1, Math.max(0, x))
}

function recencyBoost(createdAt, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  const ageDays = Math.max(0, (Date.now() - Number(createdAt)) / 86_400_000)
  return Math.pow(0.5, ageDays / halfLifeDays)
}

function rowToNode(r) {
  return {
    id: Number(r.id),
    scope: r.scope,
    kind: r.kind,
    key: r.key ?? null,
    text: r.text,
    gloss: r.gloss ?? null,
    importance: Number(r.importance ?? 0.5),
    owner: r.owner ?? null,
    validFrom: r.valid_from != null ? Number(r.valid_from) : Number(r.created_at),
    validTo: r.valid_to != null ? Number(r.valid_to) : null,
    createdAt: Number(r.created_at),
    usedCount: Number(r.used_count ?? 0),
  }
}

function ftsCandidates(db, grams, scope, owner, limit = 80) {
  if (!grams?.length) return []
  const expr = grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ')
  const rows = db
    .prepare(
      `select n.id, n.scope, n.kind, n.key, n.text, n.importance, n.owner, n.valid_from, n.valid_to, n.created_at, n.used_count, f.tokens,
              bm25(acm_fts) as rank
         from acm_fts f
         join acm_nodes n on n.id = f.node_id
        where acm_fts match ? and n.status = 'active' and (n.scope = 'global' or n.scope = ?)
          and n.owner IS ?
        order by rank asc
        limit ?`,
    )
    .all(expr, scope, owner, limit)
  return rows.map((r) => ({ ...rowToNode(r), tokens: r.tokens, rank: Number(r.rank ?? 0) }))
}

function likeCandidates(db, terms, scope, owner, limit = 40) {
  const list = (terms ?? []).map((t) => normalize(t)).filter((t) => t.length >= 2).slice(0, 6)
  if (!list.length) return []
  const where = list.map(() => "(text like ? escape '\\' or key like ? escape '\\')").join(' or ')
  const args = []
  for (const t of list) { const p = `%${likeEscape(t)}%`; args.push(p, p) }
  const rows = db
    .prepare(
      `select id, scope, kind, key, text, importance, owner, valid_from, valid_to, created_at, used_count
         from acm_nodes
        where status = 'active' and (scope = 'global' or scope = ?) and owner IS ? and (${where})
        order by created_at desc
        limit ?`,
    )
    .all(scope, owner, ...args, limit)
  return rows.map((r) => ({ ...rowToNode(r), tokens: tokenText(r.text), rank: 1 }))
}

/** \u58F0\u660E\u4E00\u4E2A\u522B\u540D\uFF1Aalias \u548C canonical \u4EE5\u540E\u4E92\u76F8\u80FD\u627E\u5230\uFF08\u8001\u5927 ↔ master\uFF09\u3002 */
export function setAlias(db, alias, canonical, owner = null) {
  const a = normalize(alias)
  const c = normalize(canonical)
  if (!a || !c || a === c) return { ok: false }
  // Delete-then-insert keeps one mapping per (owner, alias) without a unique
  // constraint, which the legacy NULL owner would defeat.
  tx(db, () => {
    db.prepare('delete from acm_aliases where alias = ? and owner IS ?').run(a, owner)
    db.prepare('insert into acm_aliases (owner, alias, canonical) values (?, ?, ?)').run(owner, a, c)
  })
  return { ok: true, alias: a, canonical: c }
}

export function aliasesOf(db, term, owner = null) {
  const t = normalize(term)
  if (!t) return []
  const rows = db
    .prepare('select alias, canonical from acm_aliases where (alias = ? or canonical = ?) and owner IS ?')
    .all(t, t, owner)
  const out = new Set()
  for (const r of rows) { out.add(r.alias); out.add(r.canonical) }
  out.delete(t)
  return [...out]
}

/**
 * \u67E5\u8BE2\u8BCD\u6269\u5F00\uFF1A\u539F\u540D\u5207\u51FA\u6765\u7684\u8BCD\uFF0C\u52A0\u4E0A\u522B\u540D\u8868\u91CC\u53CC\u5411\u80FD\u5BF9\u4E0A\u7684\u4E00\u5207\u3002
 * \u300C\u8001\u5927\u300D\u8FDB\u5F97\u6765\u5C31\u4E5F\u8981\u80FD\u67E5\u5230 master \u90A3\u6761\u4E8B\u5B9E —— \u522B\u540D\u4E0D\u662F\u88C5\u9970\uFF0C\u662F\u68C0\u7D22\u5165\u53E3\u3002
 */
export function queryGrams(db, q, owner = null) {
  const base = tokens(normalize(q))
  const out = new Set(base)
  for (const g of base) {
    for (const other of aliasesOf(db, g, owner)) {
      for (const t of [other, ...tokens(other)]) if (t) out.add(t)
    }
  }
  return [...out]
}

function keyHits(db, query, scope, owner) {
  const q = normalize(query)
  const alias = db.prepare('select canonical from acm_aliases where alias = ? and owner IS ?').get(q, owner)
  const canon = alias ? alias.canonical : q
  const rows = db
    .prepare(
      `select id, scope, kind, key, text, importance, owner, valid_from, valid_to, created_at, used_count
         from acm_nodes
        where status = 'active' and (scope = 'global' or scope = ?) and owner IS ? and (key = ? or key like ? escape '\\')`,
    )
    .all(scope, owner, canon, `${likeEscape(canon)}%`)
  return rows.map((r) => ({ ...rowToNode(r), tokens: tokenText(r.text), rank: 0 }))
}

function scoreOf(node, queryGrams) {
  const has = new Set(String(node.tokens ?? '').split(' ').filter(Boolean))
  let hit = 0
  for (const g of queryGrams) if (has.has(g)) hit++
  const coverage = queryGrams.length ? hit / queryGrams.length : 0
  return (
    W.coverage * coverage +
    W.importance * clamp01(node.importance) +
    W.recency * recencyBoost(node.createdAt)
  )
}

/**
 * bounded_expand\uFF1A\u4ECE\u547D\u4E2D\u7684\u8282\u70B9\u6CBF\u8FB9\u6269\uFF0C\u4F46\u6700\u591A maxHops \u8DF3\u3001\u6BCF\u8DF3\u6700\u591A maxNeighbors \u4E2A\u3001
 * \u603B\u6570\u4E0D\u8D85 maxCandidates\uFF1B\u6BCF\u591A\u4E00\u8DF3\u5206\u6570\u6309 hopPenalty \u8870\u51CF\uFF0C\u9632\u6B62\u731C\u51FA\u6765\u7684\u8FB9\u6C61\u67D3\u68C0\u7D22\u3002
 */
function expand(db, seeds, scope, opts) {
  const { maxHops = 2, maxNeighbors = 10, hopPenalty = 0.55, owner = null } = opts
  const seen = new Set(seeds.map((s) => s.id))
  let frontier = [...seen]
  const out = []
  for (let hop = 1; hop <= maxHops; hop++) {
    const next = []
    for (const id of frontier) {
      const rows = db
        .prepare(
          `select e.rel, e.weight, n.id, n.scope, n.kind, n.key, n.text, n.importance, n.owner, n.valid_from, n.valid_to, n.created_at, n.used_count
             from acm_edges e
             join acm_nodes n on n.id = case when e.src = ? then e.dst else e.src end
            where (e.src = ? or e.dst = ?) and n.status = 'active' and (n.scope = 'global' or n.scope = ?)
              and n.owner IS ?
            order by e.weight desc
            limit ?`,
        )
        .all(id, id, id, scope, owner, maxNeighbors)
      const sib = sourceSiblings(db, [id], scope, owner, maxNeighbors).map((r) => ({ ...r, rel: 'same_source' }))
      for (const r of rows.concat(sib)) {
        const nid = Number(r.id)
        if (seen.has(nid)) continue
        seen.add(nid)
        next.push(nid)
        out.push({ ...rowToNode(r), hop, rel: r.rel, tokens: tokenText(r.text), rank: 2 })
        if (seen.size > (opts.maxCandidates ?? 60)) return out
      }
    }
    frontier = next
    if (!frontier.length) break
  }
  return out
}

/** \u6309 id \u635E\u8282\u70B9\uFF08\u8BED\u4E49\u53EC\u56DE\u53EA\u62FF\u5230 id \u4E0E\u5206\u6570\uFF0C\u6B63\u6587\u8981\u56DE\u8868\uFF09 */
export function nodesByIds(db, ids, owner = null) {
  const list = (ids ?? []).filter((id) => id != null)
  if (!list.length) return []
  const marks = list.map(() => '?').join(',')
  const rows = db
    .prepare(
      `select id, scope, kind, key, text, importance, created_at, used_count, owner, valid_from, valid_to
       from acm_nodes where id in (${marks}) and status = 'active' and owner IS ?`,
    )
    .all(...list, owner)
  return rows.map(rowToNode)
}

/**
 * Source kind per node, for the injected block's provenance label.
 *
 * One query for the whole page. Injection runs on the host tick and on the
 * first-turn seed, so a per-row lookup would be an N+1 on the hot path.
 *
 * A node with several sources reports the strongest claim: a fact that also has a
 * distilled source is reported as distilled, because that is the path that could
 * have invented it. Owner is re-checked here as well - the caller's ids are
 * already scoped, but a second predicate costs nothing and keeps the rule local.
 */
const SOURCE_KIND_RANK = { plugin: 3, distill: 3, import: 2, tool: 2, manual: 1 }

export function sourceKindsFor(db, ids, owner = null) {
  const out = new Map()
  if (!Array.isArray(ids) || ids.length === 0) return out
  const marks = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `select ns.node_id as id, s.kind as kind
         from acm_node_sources ns
         join acm_source_events s on s.id = ns.source_id
         join acm_nodes n on n.id = ns.node_id and n.owner IS ?
        where ns.node_id in (${marks})`,
    )
    .all(owner, ...ids)
  for (const row of rows) {
    const prev = out.get(row.id)
    if (prev === undefined || (SOURCE_KIND_RANK[row.kind] ?? 0) > (SOURCE_KIND_RANK[prev] ?? 0)) out.set(row.id, row.kind)
  }
  return out
}

export function search(db, { query, scope = 'global', limit = 6, expand: doExpand = true, owner = null, opts = {} }) {
  loadWeights(db)
  const q = normalize(query)
  const grams = queryGrams(db, q, owner)
  let pool = []
  if (q) {
    pool = [...keyHits(db, q, scope, owner), ...ftsCandidates(db, grams, scope, owner)]
    if (pool.length === 0) pool = likeCandidates(db, [q, ...aliasesOf(db, q, owner), ...grams], scope, owner)
  }
  const byId = new Map()
  for (const n of pool) {
    const s = scoreOf(n, grams) + (n.rank === 0 ? 0.25 : 0)
    const prev = byId.get(n.id)
    if (!prev || s > prev.score) byId.set(n.id, { ...n, score: s })
  }
  const ranked = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(limit, 3))

  if (doExpand && ranked.length) {
    for (const nb of expand(db, ranked, scope, { maxHops: 2, maxNeighbors: 10, maxCandidates: 60, ...opts, owner })) {
      const base = ranked[0]?.score ?? 0.3
      const s = base * Math.pow(opts.hopPenalty ?? W.hopPenalty, nb.hop) * clamp01(nb.importance + 0.2)
      if (!byId.has(nb.id)) byId.set(nb.id, { ...nb, score: s })
    }
  }

  const out = [...byId.values()]
    // 0.12 \u662F\u7ED9\u5B57\u9762\u547D\u4E2D\u7684\u566A\u58F0\u515C\u5E95\uFF1B\u6CBF\u8FB9/\u540C\u6E90\u635E\u56DE\u6765\u7684\u4E0D\u6309\u8FD9\u4E2A\u780D\uFF0C
    // \u4E0D\u7136 hopPenalty \u4E00\u538B\u5C31\u628A\u540C\u6E90\u7684\u5176\u5B83\u4E8B\u5B9E\u5168\u7B5B\u6389\u4E86
    .filter((n) => !grams.length || n.hop > 0 || n.score > 0.12)
    // \u522B\u4EBA\u7684\u8BB0\u5FC6\u5C31\u5F53\u4E0D\u5B58\u5728\uFF1Aowner \u4E3A null \u7684\u7B97\u516C\u5171
    .filter((n) => (n.owner ?? null) === (owner ?? null))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return out
}

export function touch(db, ids) {
  if (!ids.length) return
  const stmt = db.prepare('update acm_nodes set last_used_at = ?, used_count = used_count + 1 where id = ?')
  const now = Date.now()
  for (const id of ids) stmt.run(now, id)
}

export function forget(db, id, at = Date.now(), owner = null) {
  return tx(db, () => {
    const row = db.prepare("select id from acm_nodes where id = ? and owner IS ?").get(id, owner)
    if (!row) return false
    // \u65F6\u95F4\u8F74\uFF1A\u5931\u6548\u4E0D\u662F\u6D88\u5931\uFF0C\u662F\u4ECE\u8FD9\u4E00\u523B\u8D77\u4E0D\u518D\u6210\u7ACB
    db.prepare("update acm_nodes set status = 'forgotten', valid_to = ? where id = ?").run(at, id)
    ftsDelete(db, id)
    return true
  })
}

/**
 * Remove every row that belongs to one memory. Runs inside the caller's
 * transaction and assumes the node is already known to be authorized.
 */
function purgeCascade(db, key) {
  const sourceIds = db
    .prepare('select source_id from acm_node_sources where node_id = ?')
    .all(key)
    .map((r) => r.source_id)
  db.prepare('delete from acm_edges where src = ? or dst = ?').run(key, key)
  db.prepare('delete from acm_feedback where node_id = ?').run(key)
  // The trust trail references the node by id; leaving it behind means the
  // erased memory is still named by an audit row.
  db.prepare('delete from acm_trust_events where node_id = ?').run(key)
  db.prepare('delete from acm_node_sources where node_id = ?').run(key)
  db.prepare('delete from acm_fts where node_id = ?').run(key)
  db.prepare('delete from acm_vectors where node_id = ?').run(String(key))
  db.prepare('delete from acm_nodes where id = ?').run(key)
  // Evidence with no surviving node is unreachable and still holds the raw
  // text that was just erased, so it goes too.
  let droppedSources = 0
  for (const sid of sourceIds) {
    const still = db.prepare('select 1 from acm_node_sources where source_id = ? limit 1').get(sid)
    if (!still) droppedSources += Number(db.prepare('delete from acm_source_events where id = ?').run(sid).changes ?? 0)
  }
  return droppedSources
}

/**
 * Physically delete one memory and every row that references it.
 *
 * `forget` only invalidates: the text stays in the node table, in FTS and in any
 * backup. Purge removes the node, its full-text row, its vectors, evidence links,
 * feedback and the evidence rows that no surviving node still references.
 *
 * Backups, exported Markdown and copies outside this database are NOT rewritten.
 */
export function purge(db, id, { owner = null } = {}) {
  const key = Number(id)
  return tx(db, () => {
    const row = db.prepare('select id from acm_nodes where id = ? and owner IS ?').get(key, owner)
    if (!row) return { ok: false, reason: 'not-found' }
    const droppedSources = purgeCascade(db, key)
    return { ok: true, id: key, droppedSources }
  })
}

/**
 * Physically delete every memory created before a cutoff in the caller's
 * partition, optionally limited to one scope (global scope is always included
 * because it belongs to the same owner).
 *
 * A cutoff is mandatory: there is no "erase everything" shorthand, so a caller
 * cannot wipe a partition by omitting an argument. `dryRun` reports what would
 * go without deleting anything.
 */
export function purgeRange(db, { owner = null, before = null, scope = null, dryRun = false, includeGlobal = false } = {}) {
  const cutoff = Number(before)
  if (!Number.isFinite(cutoff) || cutoff <= 0) return { ok: false, reason: 'before-required' }
  const where = ["owner IS ?", 'created_at < ?']
  const args = [owner, cutoff]
  if (scope) {
    // `global` rows are shared with every session, so a session-scoped cleanup
    // must not sweep them by default. That default deleted more than the caller
    // named; it now needs `includeGlobal: true`.
    where.push(includeGlobal ? "(scope = ? or scope = 'global')" : 'scope = ?')
    args.push(String(scope))
  }
  const rows = db.prepare(`select id from acm_nodes where ${where.join(' and ')} order by id`).all(...args)
  const ids = rows.map((r) => Number(r.id))
  if (dryRun) return { ok: true, dryRun: true, deleted: 0, candidates: ids.length, ids, includeGlobal: Boolean(includeGlobal) }
  return tx(db, () => {
    let droppedSources = 0
    for (const id of ids) droppedSources += purgeCascade(db, id)
    return { ok: true, dryRun: false, deleted: ids.length, droppedSources, ids }
  })
}

/**
 * Fact keys whose value changed more than once, newest first.
 *
 * A superseded revision is not an error, but repeated churn on one key is where
 * contradictory evidence shows up, so it is surfaced instead of being averaged
 * away. The caller reviews the chain and pins the answer it trusts.
 */
export function conflicts(db, { owner = null, scope = null, since = null, minRevisions = 2, limit = 50 } = {}) {
  const floor = Number(since ?? 0)
  const where = ["owner IS ?", 'key is not null', "status in ('active','superseded')"]
  const args = [owner]
  if (scope) { where.push('scope = ?'); args.push(String(scope)) }
  if (Number.isFinite(floor) && floor > 0) { where.push('created_at >= ?'); args.push(floor) }
  const groups = db
    .prepare(
      `select scope, key, count(*) c, max(created_at) last from acm_nodes
        where ${where.join(' and ')}
        group by scope, key having c >= ? order by last desc limit ?`,
    )
    .all(...args, Math.max(2, Number(minRevisions) || 2), Math.max(1, Number(limit) || 50))
  const revisionStmt = db.prepare(
    "select id, text, status, importance, created_at, superseded_by from acm_nodes where scope = ? and key = ? and owner IS ? order by created_at desc",
  )
  return groups.map((g) => {
    const revisions = revisionStmt.all(g.scope, g.key, owner).map((r) => ({
      id: Number(r.id),
      text: r.text,
      status: r.status,
      importance: Number(r.importance),
      at: Number(r.created_at),
      supersededBy: r.superseded_by ?? null,
    }))
    return {
      scope: g.scope,
      key: g.key,
      revisions: revisions.length,
      last: Number(g.last),
      active: revisions.find((r) => r.status === 'active')?.id ?? null,
      history: revisions,
    }
  })
}

/**
 * Pin one revision of a fact key as the answer and close the others.
 *
 * Re-activating an older revision is the "we were right before" correction:
 * the chosen row becomes active again (its FTS entry is rebuilt) and every other
 * row for that scope+key is superseded in its favour.
 */
export function resolveConflict(db, { id, owner = null, at = Date.now() } = {}) {
  const key = Number(id)
  return tx(db, () => {
    const chosen = db.prepare('select id, scope, key, text from acm_nodes where id = ? and owner IS ?').get(key, owner)
    if (!chosen) return { ok: false, reason: 'not-found' }
    if (!chosen.key) return { ok: false, reason: 'no-key' }
    const others = db
      .prepare('select id from acm_nodes where scope = ? and key = ? and owner IS ? and id <> ?')
      .all(chosen.scope, chosen.key, owner, key)
    for (const other of others) {
      db.prepare("update acm_nodes set status = 'superseded', superseded_by = ?, valid_to = ? where id = ?")
        .run(key, at, other.id)
      ftsDelete(db, other.id)
    }
    db.prepare("update acm_nodes set status = 'active', superseded_by = null, valid_to = null where id = ?").run(key)
    ftsDelete(db, key)
    ftsInsert(db, key, chosen.text)
    return { ok: true, id: key, superseded: others.map((o) => Number(o.id)) }
  })
}

/**
 * Everything behind one memory: the node itself, the raw evidence it was
 * distilled from, the votes it received and its revision chain.
 *
 * Returns null when the id is not in the caller's partition, so a caller cannot
 * use provenance as an existence oracle for another owner.
 */
/**
 * Instruction-like text inside a stored memory.
 *
 * This is a heuristic, not a guarantee: it flags the phrasings a prompt
 * injection uses so a human can review them. It never blocks a write, and a
 * clean verdict means "nothing obvious", not "safe".
 */
const INJECTION_PATTERNS = [
  { id: 'ignore-instructions', re: /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions?/i },
  { id: 'disregard-instructions', re: /disregard\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions?|rules?)/i },
  { id: 'role-switch', re: /\byou are now\b/i },
  { id: 'system-prompt', re: /\bsystem\s+prompt\b|\bsystem:\s/i },
  { id: 'zh-ignore', re: /\u5ffd\u7565(\u4e4b\u524d|\u4ee5\u4e0a|\u524d\u9762)\u7684?(\u6307\u4ee4|\u89c4\u5219)/ },
  { id: 'zh-role-switch', re: /\u4f60\u73b0\u5728\u662f/ },
]

/** Heuristic scan of active memories in one partition. */
export function suspects(db, { owner = null, limit = 100 } = {}) {
  const rows = db
    .prepare("select id, key, text, importance from acm_nodes where owner IS ? and status = 'active' order by id desc limit ?")
    .all(owner, Math.max(1, Number(limit) || 100))
  const out = []
  for (const row of rows) {
    const reasons = []
    for (const p of INJECTION_PATTERNS) if (p.re.test(row.text ?? '')) reasons.push(p.id)
    // A fact asserted with high confidence but parked at near-zero importance is
    // odd enough to look at, not enough to act on.
    if (reasons.length) out.push({ id: Number(row.id), key: row.key ?? null, text: row.text, reasons })
  }
  return out
}

/**
 * Hide a memory from retrieval without deleting it.
 *
 * Quarantine is the reversible middle ground between trusting and erasing: the
 * text stays auditable, retrieval stops using it, and release restores it.
 */
export function quarantine(db, id, { owner = null, reason = null, actor = null, at = Date.now() } = {}) {
  const key = Number(id)
  return tx(db, () => {
    const row = db.prepare("select id, status from acm_nodes where id = ? and owner IS ?").get(key, owner)
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.status === 'quarantined') return { ok: true, already: true, id: key }
    db.prepare("update acm_nodes set status = 'quarantined' where id = ?").run(key)
    ftsDelete(db, key)
    db.prepare('insert into acm_trust_events (node_id, owner, action, reason, actor, at) values (?, ?, ?, ?, ?, ?)')
      .run(key, owner, 'quarantine', reason, actor, at)
    return { ok: true, id: key }
  })
}

/** Restore a quarantined memory to retrieval, with an audit entry. */
export function releaseQuarantine(db, id, { owner = null, reason = null, actor = null, at = Date.now() } = {}) {
  const key = Number(id)
  return tx(db, () => {
    const row = db.prepare("select id, status, text, gloss from acm_nodes where id = ? and owner IS ?").get(key, owner)
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.status !== 'quarantined') return { ok: false, reason: 'not-quarantined', status: row.status }
    db.prepare("update acm_nodes set status = 'active' where id = ?").run(key)
    ftsDelete(db, key)
    // Restore the same bilingual index used by remember()/attachGloss().
    // Indexing only text silently loses the Chinese gloss after quarantine.
    ftsInsert(db, key, row.gloss ? `${row.text} ${row.gloss}` : row.text)
    db.prepare('insert into acm_trust_events (node_id, owner, action, reason, actor, at) values (?, ?, ?, ?, ?, ?)')
      .run(key, owner, 'release', reason, actor, at)
    return { ok: true, id: key }
  })
}

/** Audit trail for quarantine and release decisions. */
export function trustEvents(db, { nodeId = null, owner = null, limit = 50 } = {}) {
  const where = ['owner IS ?']
  const args = [owner]
  if (nodeId != null) { where.push('node_id = ?'); args.push(Number(nodeId)) }
  return db
    .prepare(`select id, node_id, action, reason, actor, at from acm_trust_events where ${where.join(' and ')} order by id desc limit ?`)
    .all(...args, Math.max(1, Number(limit) || 50))
    .map((r) => ({ id: Number(r.id), nodeId: Number(r.node_id), action: r.action, reason: r.reason, actor: r.actor, at: Number(r.at) }))
}

export function provenance(db, id, { owner = null } = {}) {
  const key = Number(id)
  const node = db
    .prepare(
      'select id, scope, kind, key, text, status, owner, importance, used_count, created_at, valid_from, valid_to, superseded_by ' +
        'from acm_nodes where id = ? and owner IS ?',
    )
    .get(key, owner)
  if (!node) return null
  const sources = sourcesOf(db, key, owner).map((s) => ({
    id: Number(s.id),
    kind: s.kind,
    sessionId: s.session_id,
    seq: s.seq,
    at: Number(s.created_at),
    raw: s.raw,
  }))
  const votes = db
    .prepare('select verdict, note, at from acm_feedback where node_id = ? order by at asc')
    .all(key)
    .map((v) => ({ verdict: v.verdict, note: v.note, at: Number(v.at) }))
  const revisions = node.key
    ? history(db, { key: node.key, scope: node.scope, owner, limit: 50 }).map((r) => ({
        id: Number(r.id),
        status: r.status,
        at: Number(r.created_at),
        supersededBy: r.superseded_by ?? null,
      }))
    : []
  return { node, sources, votes, revisions }
}

/**
 * Evidence for a purge: count what still references the id.
 * Callers should report these numbers rather than asserting success.
 */
export function verifyPurged(db, id) {
  const key = Number(id)
  const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c ?? 0)
  const checks = {
    node: one('select count(*) c from acm_nodes where id = ?', key),
    fts: one('select count(*) c from acm_fts where node_id = ?', key),
    vectors: one('select count(*) c from acm_vectors where node_id = ?', String(key)),
    sourceLinks: one('select count(*) c from acm_node_sources where node_id = ?', key),
    edges: one('select count(*) c from acm_edges where src = ? or dst = ?', key, key),
    feedback: one('select count(*) c from acm_feedback where node_id = ?', key),
    trustEvents: one('select count(*) c from acm_trust_events where node_id = ?', key),
  }
  // Scope note: these are the tables a node purge can reach. Decision evidence,
  // mailbox bodies, backups and exports have their own retention, so `clean` means
  // "no row in these tables names this id", not "the text is gone from the machine".
  return { clean: Object.values(checks).every((n) => n === 0), checks, scope: Object.keys(checks) }
}

/**
 * \u65F6\u95F4\u8F74\uFF1A\u540C\u4E00\u4E2A key \u4E0A\u7684\u6240\u6709\u7248\u672C\uFF0C\u6309\u65F6\u95F4\u6392\u3002
 * \u8FD9\u624D\u80FD\u56DE\u7B54\u300C\u5979\u4EE5\u524D\u662F\u8FD9\u4E48\u8BF4\u7684\uFF0C\u4EC0\u4E48\u65F6\u5019\u6539\u7684\u300D\u3002
 */
export function history(db, { key = null, scope = null, owner = null, limit = 50 } = {}) {
  const where = []
  const args = []
  if (key) { where.push("(key = ? or key like ? escape '\\')"); args.push(key, `${likeEscape(key)}%`) }
  if (scope) { where.push("(scope = 'global' or scope = ?)"); args.push(scope) }
  where.push("owner IS ?"); args.push(owner)
  const rows = db
    .prepare(
      `select id, scope, kind, key, text, status, owner, valid_from, valid_to, created_at, superseded_by
         from acm_nodes
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by coalesce(valid_from, created_at) desc
        limit ?`,
    )
    .all(...args, limit)
  return rows.map((r) => ({
    id: Number(r.id),
    key: r.key ?? null,
    text: r.text,
    status: r.status,
    owner: r.owner ?? null,
    from: r.valid_from != null ? Number(r.valid_from) : Number(r.created_at),
    to: r.valid_to != null ? Number(r.valid_to) : null,
    supersededBy: r.superseded_by != null ? Number(r.superseded_by) : null,
  }))
}

/** \u6765\u6E90\uFF1A\u51ED\u4EC0\u4E48\u53EB\u6211\u8BB0\u5F97 */
export function sourcesOf(db, nodeId, owner = null) {
  return db
    .prepare(
      `select s.id, s.kind, s.session_id, s.seq, s.raw, s.created_at
         from acm_node_sources ns join acm_source_events s on s.id = ns.source_id
        where ns.node_id = ? and exists (
          select 1 from acm_nodes n where n.id = ns.node_id and n.owner IS ?
        ) and s.owner IS ?
        order by s.created_at asc`,
    )
    .all(nodeId, owner, owner)
}

/**
 * \u6253\u5206\u6743\u91CD\u4E0D\u662F\u6C38\u8FDC\u4E0D\u53D8\u7684\uFF1Afeedback \u6512\u591A\u4E86\u8981\u80FD\u632A\u3002
 * \u5B58\u5728 acm_meta \u91CC\uFF0C\u91CD\u542F\u8FD8\u5728\uFF1B\u533A\u95F4\u5361\u6B7B\uFF0C\u514D\u5F97\u8C03\u98DE\u3002
 */
export const WEIGHTS_DEFAULT = { coverage: 0.62, importance: 0.23, recency: 0.15, hopPenalty: 0.55 }
let W = { ...WEIGHTS_DEFAULT }

export function loadWeights(db) {
  try {
    const raw = metaGet(db, 'weights')
    if (raw) {
      const o = JSON.parse(raw)
      W = { ...WEIGHTS_DEFAULT, ...o }
    }
  } catch {}
  return { ...W }
}

export function setWeights(db, next) {
  const merged = { ...W, ...(next ?? {}) }
  const clampW = (v) => Math.min(1, Math.max(0, Number(v) || 0))
  W = {
    coverage: clampW(merged.coverage),
    importance: clampW(merged.importance),
    recency: clampW(merged.recency),
    hopPenalty: Math.min(0.95, Math.max(0.2, Number(merged.hopPenalty) || WEIGHTS_DEFAULT.hopPenalty)),
  }
  metaSet(db, 'weights', JSON.stringify(W))
  return { ...W }
}

export function weightsNow() { return { ...W } }

/** \u8BB0\u4E00\u6B21\u300C\u8FD9\u6761\u5BF9\u4E0D\u5BF9\u300D\uFF1A\u5BF9\u4E86\u52A0\u5206\uFF0C\u9519\u4E86\u51CF\u5206\uFF0C\u51CF\u5230\u5F88\u4F4E\u5C31\u81EA\u52A8\u5931\u6548\u3002 */
export function feedback(db, id, verdict, { note = null, at = Date.now(), owner = null } = {}) {
  const v = verdict === 'wrong' ? 'wrong' : 'useful'
  const row = db.prepare("select id, importance, status from acm_nodes where id = ? and owner IS ?").get(Number(id), owner)
  if (!row) return { ok: false, reason: 'no-such-node' }
  return tx(db, () => {
    db.prepare('insert into acm_feedback (node_id, verdict, note, at) values (?, ?, ?, ?)').run(Number(id), v, note, at)
    const delta = v === 'useful' ? 0.08 : -0.15
    const importance = clamp01(Number(row.importance ?? 0.5) + delta)
    db.prepare('update acm_nodes set importance = ? where id = ?').run(importance, Number(id))
    let retired = false
    if (v === 'wrong' && importance <= 0.15 && row.status === 'active') {
      db.prepare("update acm_nodes set status = 'forgotten', valid_to = ? where id = ?").run(at, Number(id))
      ftsDelete(db, Number(id))
      retired = true
    }
    return { ok: true, verdict: v, importance, retired }
  })
}

export function feedbackStats(db, { window = 0, owner = null } = {}) {
  const w = Number(window) || 0
  if (w > 0) {
    // \u53EA\u770B\u6700\u8FD1\u8FD9\u4E9B\u7968\uFF1A\u8001\u8D26\u7FFB\u4E0D\u5B8C\uFF0C\u6743\u91CD\u4F1A\u4E00\u8DEF\u9876\u5230\u8FB9\u754C\u518D\u4E5F\u4E0D\u56DE\u6765
    const rows = db
      .prepare('select f.verdict from acm_feedback f join acm_nodes n on n.id = f.node_id where n.owner IS ? order by f.id desc limit ?')
      .all(owner, w)
    return {
      useful: rows.filter((r) => r.verdict === 'useful').length,
      wrong: rows.filter((r) => r.verdict === 'wrong').length,
      window: w,
    }
  }
  const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c ?? 0)
  return {
    useful: one("select count(*) c from acm_feedback f join acm_nodes n on n.id = f.node_id where f.verdict = 'useful' and n.owner IS ?", owner),
    wrong: one("select count(*) c from acm_feedback f join acm_nodes n on n.id = f.node_id where f.verdict = 'wrong' and n.owner IS ?", owner),
    window: 0,
  }
}

/**
 * \u5408\u5E76\u8FD1\u91CD\u590D\uFF1A\u540C\u4E00 scope\u3001\u540C\u4E00\u5957\u8BCD\u3001\u53C8\u4E0D\u662F\u540C\u4E00\u6761 —— \u5408\u6210\u4E00\u6761\u3002
 * \u6765\u6E90\u548C\u8FB9\u90FD\u642C\u8FC7\u53BB\uFF0C\u88AB\u5408\u5E76\u7684\u6807 merged_into\u3002\u8FD9\u4E5F\u662F"\u8D8A\u7528\u8D8A\u7D27"\u7684\u90A3\u4E00\u534A\uFF1A
 * \u65B0\u5199\u8FDB\u53BB\u7684\u8BF4\u6CD5\u548C\u8001\u8BF4\u6CD5\u649E\u8F66\u65F6\uFF0C\u5E93\u4E0D\u8BE5\u8D8A\u5806\u8D8A\u539A\u3002
 */
function vecOf(db, id) {
  const row = db.prepare('select vec, dim from acm_vectors where node_id = ?').get(String(Math.trunc(Number(id))))
  if (!row) return null
  return decodeVector(row.vec, row.dim)
}

/**
 * \u8BCD\u888B\u4E00\u6837\u4E0D\u4EE3\u8868\u610F\u601D\u4E00\u6837\uFF1A\u4E2D\u6587\u6362\u4E2A\u8BED\u5E8F\uFF0C\u4E24\u5B57\u6ED1\u7A97\u7684\u8BCD\u888B\u4F1A\u649E\uFF08\u300C\u8001\u5927\u559C\u6B22\u4E0B\u96E8\u300D\u548C
 * \u300C\u4E0B\u96E8\u559C\u6B22\u8001\u5927\u300D\uFF09\u3002\u6709\u5411\u91CF\u5C31\u6BD4\u4F59\u5F26\uFF0C\u6CA1\u6709\u5C31\u9000\u4E00\u6B65\u6BD4\u9996\u4E2A bigram —— \u5B81\u53EF\u5C11\u5E76\uFF0C\u4E0D\u5E76\u9519\u3002
 */
function sameSaying(db, a, b) {
  const va = vecOf(db, a.id)
  const vb = vecOf(db, b.id)
  if (va && vb && va.length === vb.length) {
    let dot = 0
    for (let i = 0; i < va.length; i += 1) dot += va[i] * vb[i]
    return dot >= 0.9
  }
  const first = (r) => String(r.tokens ?? '').split(' ').filter(Boolean)[0]
  const fa = first(a)
  return !!fa && fa === first(b)
}

/**
 * \u8BED\u4E49\u8FD1\u91CD\u590D\uFF1A\u6362\u4E86\u8BF4\u6CD5\u7684\u540C\u4E00\u4EF6\u4E8B\uFF08\u300C\u90E8\u7F72\u5148\u8FC7 staging\u300D\u548C\u300C\u4E0A\u7EBF\u8D70\u9884\u53D1\u300D\uFF09\u3002
 * \u8BCD\u888B\u6CD5\u5BF9\u8FD9\u7C7B\u5B8C\u5168\u65E0\u6548\uFF0C\u53EA\u80FD\u9760\u5411\u91CF\u3002\u53EA\u6BD4\u6700\u8FD1\u7684\u6709\u5411\u91CF\u7684\u8282\u70B9\uFF0C\u4E24\u4E24\u6BD4\uFF0C
 * \u540C\u4E00 scope/owner/key \u4E14\u4F59\u5F26 ≥ mergeCos \u624D\u7B97\u3002
 */
function semanticPairs(db, { limit = 300, mergeCos = 0.94, skip = new Set(), at = Date.now() } = {}) {
  const rows = db
    .prepare(
      `select n.id, n.scope, n.owner, n.key, n.importance, n.created_at, v.vec, v.dim
         from acm_nodes n join acm_vectors v on v.node_id = n.id
        where n.status = 'active'
        order by n.importance desc, n.created_at asc limit ?`,
    )
    .all(limit)
  const vec = rows.map((r) => decodeVector(r.vec, r.dim))
  const taken = new Set()
  const out = []
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]
      const b = rows[j]
      if (a.scope !== b.scope) continue
      if (ownerKey(a.owner) !== ownerKey(b.owner)) continue
      if ((a.key ?? '') !== (b.key ?? '')) continue
      const ida = Number(a.id)
      const idb = Number(b.id)
      if (taken.has(ida) || taken.has(idb)) continue
      if (skip.has(`${ida}:${idb}`) || skip.has(`${idb}:${ida}`)) continue
      const va = vec[i]
      const vb = vec[j]
      if (!va.length || va.length !== vb.length) continue
      let dot = 0
      for (let k = 0; k < va.length; k += 1) dot += va[k] * vb[k]
      if (dot < mergeCos) continue
      taken.add(idb)
      out.push([idb, ida])
    }
  }
  return out
}

export function mergeDuplicates(db, { dryRun = false, limit = 2000, mergeCos = 0.94, at = Date.now() } = {}) {
  const rows = db
    .prepare(
      `select id, scope, key, text, tokens, importance, owner, created_at
         from acm_nodes where status = 'active'
        order by created_at asc limit ?`,
    )
    .all(limit)
  const groups = new Map()
  for (const r of rows) {
    const toks = String(r.tokens ?? '').split(' ').filter(Boolean)
    // \u7B7E\u540D\u91CC\u5E26\u4E0A\u8BCD\u6570\uFF1A\u8BCD\u888B\u76F8\u540C\u4F46\u957F\u77ED\u4E0D\u540C\u7684\u8BF4\u6CD5\u4E0D\u8BE5\u5E76
    // JSON keeps the parts unambiguous: a scope containing the separator used to
    // produce the same signature as a different (scope, key) pair.
    const sig = JSON.stringify([r.scope, ownerKey(r.owner), r.key ?? null, toks.length, [...toks].sort().join(' ')])
    if (!groups.has(sig)) groups.set(sig, [])
    groups.get(sig).push(r)
  }
  const pairs = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => Number(b.importance) - Number(a.importance) || Number(a.created_at) - Number(b.created_at))
    const keep = sorted[0]
    for (const drop of sorted.slice(1)) {
      if (sameSaying(db, keep, drop)) pairs.push([Number(drop.id), Number(keep.id)])
    }
  }
  const bagged = pairs.length
  // \u7B2C\u4E8C\u904D\uFF1A\u6362\u4E86\u8BF4\u6CD5\u7684\u540C\u4E00\u4EF6\u4E8B\uFF0C\u8BCD\u888B\u6CD5\u5B8C\u5168\u770B\u4E0D\u89C1\uFF0C\u53EA\u80FD\u9760\u5411\u91CF
  const taken = new Set(pairs.flat())
  for (const [from, into] of semanticPairs(db, { mergeCos, skip: new Set(pairs.map(([f, t]) => `${f}:${t}`)), at })) {
    if (taken.has(from) || taken.has(into)) continue
    pairs.push([from, into])
    taken.add(from)
    taken.add(into)
  }
  if (dryRun) return { merged: pairs.length, bagged, semantic: pairs.length - bagged, pairs }

  return tx(db, () => {
    for (const [from, into] of pairs) {
      // \u6765\u6E90\u642C\u8FC7\u53BB
      db.prepare('insert or ignore into acm_node_sources (node_id, source_id) select ?, source_id from acm_node_sources where node_id = ?')
        .run(into, from)
      // \u8FB9\u4E24\u7AEF\u90FD\u6539\u6307
      const edges = db.prepare('select src, dst, rel, weight, created_at from acm_edges where src = ? or dst = ?').all(from, from)
      for (const e of edges) {
        const src = Number(e.src) === from ? into : Number(e.src)
        const dst = Number(e.dst) === from ? into : Number(e.dst)
        if (src === dst) continue
        db.prepare('insert or ignore into acm_edges (src, dst, rel, weight, created_at) values (?, ?, ?, ?, ?)')
          .run(src, dst, e.rel, e.weight, e.created_at)
      }
      db.prepare('delete from acm_edges where src = ? or dst = ?').run(from, from)
      db.prepare('delete from acm_node_sources where node_id = ?').run(from)
      db.prepare('delete from acm_vectors where node_id = ?').run(String(Math.trunc(Number(from))))
      ftsDelete(db, from)
      db.prepare("update acm_nodes set status = 'superseded', superseded_by = ?, valid_to = ? where id = ?").run(into, at, from)
      link(db, from, into, 'merged_into', 1.0, at)
    }
    return { merged: pairs.length, bagged, semantic: pairs.length - bagged, pairs }
  })
}

export function stats(db, scope, owner = null) {
  const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c ?? 0)
  // Counts are partition-scoped: a named owner must not learn how much data the
  // legacy partition or another owner holds.
  return {
    nodes: one("select count(*) c from acm_nodes where status = 'active' and owner IS ?", owner),
    scoped: one("select count(*) c from acm_nodes where status = 'active' and scope = ? and owner IS ?", scope ?? '', owner),
    sources: one('select count(*) c from acm_source_events where owner IS ?', owner),
    edges: one('select count(*) c from acm_edges e join acm_nodes s on s.id = e.src where s.owner IS ?', owner),
    checkpoints: one('select count(*) c from acm_checkpoints where owner IS ?', owner),
    writes: metaValue(db, 'writes', 0),
  }
}

export { metaSet }

/**
 * \u56DE\u6536\uFF1A\u5E93\u4E0D\u80FD\u53EA\u957F\u4E0D\u7F29\u3002
 *   - \u5931\u6548\u8282\u70B9\uFF08superseded / forgotten\uFF09\u8FC7\u4E86\u4FDD\u7559\u671F\u624D\u771F\u7684\u5220\u6389 —— \u671F\u95F4\u8FD8\u67E5\u5F97\u5230\u300C\u5B83\u66FE\u7ECF\u8FD9\u4E48\u8BB0\u7684\u300D
 *   - \u6CA1\u4EBA\u6307\u7684\u539F\u59CB\u4E8B\u4EF6\u4E00\u8D77\u5220\uFF08\u8FD8\u6302\u5728\u8282\u70B9\u4E0A\u7684\u4E0D\u5220\uFF0C\u8BC1\u636E\u7EBF\u4E0D\u80FD\u65AD\uFF09
 *   - \u88AB\u9876\u66FF\u7684\u68C0\u67E5\u70B9\u3001\u5DF2\u7ECF\u6279\u8FC7\u7684\u63D0\u6848\uFF0C\u5404\u6309\u81EA\u5DF1\u7684\u4FDD\u9C9C\u671F\u6E05
 * \u9ED8\u8BA4 dryRun=false\uFF0C\u8C03\u7528\u65B9\u60F3\u5148\u770B\u6570\u91CF\u5C31\u4F20 dryRun:true\u3002
 */
export function gc(db, opts = {}) {
  const at = opts.now ?? Date.now()
  const days = opts.days ?? 120
  const cpDays = opts.checkpointDays ?? 30
  const propDays = opts.proposalDays ?? 90
  const mailDays = opts.mailboxDays ?? 30
  // Scoped to one partition by default. A legacy-mode run used to delete every
  // owner's stale rows, which contradicts the partition model; an operator who
  // really wants a whole-store sweep passes all: true.
  const owner = opts.owner ?? null
  const all = opts.all === true
  const ownerClause = all ? '1 = 1' : 'owner IS ?'
  const ownerArgs = all ? [] : [owner]
  const dryRun = !!opts.dryRun
  const day = 86400000
  const cutoff = at - days * day
  const cpCutoff = at - cpDays * day
  const propCutoff = at - propDays * day
  const mailCutoff = at - mailDays * day

  const deadNodes = db
    .prepare(
      `select id from acm_nodes
        where status <> 'active' and coalesce(last_used_at, created_at) < ? and ${ownerClause}`,
    )
    .all(cutoff, ...ownerArgs)
    .map((r) => Number(r.id))

  // \u539F\u8BDD\u80FD\u4E0D\u80FD\u5220\uFF0C\u53D6\u51B3\u4E8E\u5220\u5B8C\u5931\u6548\u8282\u70B9\u4E4B\u540E\u8FD8\u6709\u6CA1\u6709\u4EBA\u6307\u7740\u5B83 —— \u6240\u4EE5\u300C\u5C06\u8981\u5220\u7684\u8282\u70B9\u300D\u8981\u6392\u9664\u5728\u5916
  const deadSourceIds = (excludedNodes) => {
    const notIn = excludedNodes.length
      ? `n.id not in (${excludedNodes.map(() => '?').join(',')})`
      : '1 = 1'
    return db
      .prepare(
        `select s.id from acm_source_events s
          where s.created_at < ? and ${all ? '1 = 1' : 's.owner IS ?'}
            and not exists (
              select 1 from acm_node_sources ns
                join acm_nodes n on n.id = ns.node_id
               where ns.source_id = s.id and ${notIn})`,
      )
      .all(cutoff, ...ownerArgs, ...excludedNodes)
      .map((r) => Number(r.id))
  }
  const deadSources = deadSourceIds(deadNodes)

  const deadCheckpoints = db
    .prepare(`select id from acm_checkpoints where superseded_by is not null and created_at < ? and ${ownerClause}`)
    .all(cpCutoff, ...ownerArgs)
    .map((r) => Number(r.id))

  const deadProposals = db
    .prepare(`select id from acm_persona_proposals where state <> 'pending' and coalesce(decided_at, created_at) < ? and ${ownerClause}`)
    .all(propCutoff, ...ownerArgs)
    .map((r) => Number(r.id))

  // Completed mailbox entries are receipts, not history worth keeping forever.
  // Open work is never touched: an unclaimed task must not silently disappear.
  const deadMail = db
    .prepare(`select id from acm_mailbox where state = 'done' and coalesce(done_at, created_at) < ? and ${ownerClause}`)
    .all(mailCutoff, ...ownerArgs)
    .map((r) => Number(r.id))

  const out = {
    dryRun,
    nodes: deadNodes.length,
    sources: deadSources.length,
    checkpoints: deadCheckpoints.length,
    proposals: deadProposals.length,
    edges: 0,
    vectors: 0,
    receipts: 0,
    mailbox: deadMail.length,
  }
  if (dryRun) return out

  const marks = (arr) => arr.map(() => '?').join(',')

  tx(db, () => {
    if (deadNodes.length) {
      const m = marks(deadNodes)
      out.edges = Number(db.prepare(`select count(*) c from acm_edges where src in (${m}) or dst in (${m})`).get(...deadNodes, ...deadNodes).c)
      // node_id \u662F text\uFF0C\u53C2\u6570\u7ED9\u6570\u5B57\u65F6 SQLite \u4E0D\u505A\u9690\u5F0F\u8F6C\u6362\uFF0C\u4F1A\u4E00\u6761\u90FD\u5339\u914D\u4E0D\u4E0A
      out.vectors = Number(db.prepare(`select count(*) c from acm_vectors where node_id in (${m})`).get(...deadNodes.map(String)).c)
      db.prepare(`delete from acm_edges where src in (${m}) or dst in (${m})`).run(...deadNodes, ...deadNodes)
      db.prepare(`delete from acm_fts where node_id in (${m})`).run(...deadNodes)
      db.prepare(`delete from acm_node_sources where node_id in (${m})`).run(...deadNodes)
      out.feedback = Number(db.prepare(`select count(*) c from acm_feedback where node_id in (${m})`).get(...deadNodes).c)
      db.prepare(`delete from acm_feedback where node_id in (${m})`).run(...deadNodes)
      db.prepare(`delete from acm_vectors where node_id in (${m})`).run(...deadNodes.map(String))
      db.prepare(`delete from acm_nodes where id in (${m})`).run(...deadNodes)
    }
    if (deadSources.length) {
      const m = marks(deadSources)
      db.prepare(`delete from acm_source_events where id in (${m})`).run(...deadSources)
    }
    if (deadCheckpoints.length) {
      const m = marks(deadCheckpoints)
      out.receipts = Number(db.prepare(`select count(*) c from acm_recovery_receipts where checkpoint_id in (${m})`).get(...deadCheckpoints).c)
      db.prepare(`delete from acm_recovery_receipts where checkpoint_id in (${m})`).run(...deadCheckpoints)
      db.prepare(`delete from acm_checkpoints where id in (${m})`).run(...deadCheckpoints)
    }
    if (deadMail.length) {
      const m = marks(deadMail)
      db.prepare(`delete from acm_mailbox where id in (${m})`).run(...deadMail)
    }
    if (deadProposals.length) {
      const m = marks(deadProposals)
      db.prepare(`delete from acm_persona_proposals where id in (${m})`).run(...deadProposals)
    }
  })
  return out
}
