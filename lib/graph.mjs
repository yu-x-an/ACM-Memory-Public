// \u628A\u5E93\u753B\u51FA\u6765\uFF1A\u8282\u70B9\u3001\u8FB9\u3001\u65F6\u95F4\u8F74\u3002\u53EA\u662F\u4E00\u5F20\u56FE\uFF0C\u4E0D\u6539\u4EFB\u4F55\u4E1C\u897F\u3002
//
// \u4E00\u6761\u547D\u4EE4\u5C31\u80FD\u770B\uFF1A`node lib/host/cli.mjs graph --out memory.html`
// DSH \u91CC\u6302\u5728 /acm/graph\u3002

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

export function buildGraph(db, { scope = null, owner = null, limit = 250 } = {}) {
  const where = []
  const args = []
  if (scope) { where.push("(scope = 'global' or scope = ?)"); args.push(scope) }
  where.push("owner IS ?"); args.push(owner)
  // Quarantined rows are hidden until someone reviews them: the graph is a view
  // of what the agent may see, not an audit surface. Use provenance() or the
  // trust trail to inspect a quarantined memory. Superseded and forgotten rows
  // stay visible because the timeline is the point of this view.
  where.push("status <> 'quarantined'")
  const nodes = db
    .prepare(
      `select id, scope, kind, key, text, status, importance, owner, valid_from, valid_to, created_at
         from acm_nodes ${where.length ? `where ${where.join(' and ')}` : ''}
        order by coalesce(valid_from, created_at) desc limit ?`,
    )
    .all(...args, limit)
    .map((r) => ({
      id: Number(r.id),
      scope: r.scope,
      kind: r.kind,
      key: r.key ?? null,
      text: r.text,
      status: r.status,
      importance: Number(r.importance ?? 0.5),
      owner: r.owner ?? null,
      from: r.valid_from != null ? Number(r.valid_from) : Number(r.created_at),
      to: r.valid_to != null ? Number(r.valid_to) : null,
    }))
  const ids = new Set(nodes.map((n) => n.id))
  const edges = db
    .prepare('select src, dst, rel, weight from acm_edges')
    .all()
    .filter((e) => ids.has(Number(e.src)) && ids.has(Number(e.dst)))
    .map((e) => ({ src: Number(e.src), dst: Number(e.dst), rel: e.rel, weight: Number(e.weight) }))
  const cp = scope
    ? db.prepare("select id, goal, done, next, created_at from acm_checkpoints where session_id = ? and owner IS ? order by created_at desc limit 1").get(scope, owner)
    : null
  return {
    nodes,
    edges,
    checkpoint: cp ?? null,
    stats: {
      nodes: nodes.length,
      active: nodes.filter((n) => n.status === 'active').length,
      edges: edges.length,
      scopes: [...new Set(nodes.map((n) => n.scope))].length,
    },
  }
}

/** \u81EA\u5305\u542B HTML\uFF0C\u6CA1\u6709\u5916\u94FE\u3001\u6CA1\u6709\u4F9D\u8D56\uFF0C\u5B58\u4E0B\u6765\u53CC\u51FB\u5C31\u80FD\u770B */
export function renderGraphHtml(graph, { title = 'ACM \u8BB0\u5FC6\u56FE', sessionId = null } = {}) {
  const W = 1100
  const H = 720
  const cx = W / 2
  const cy = H / 2
  const nodes = graph.nodes
  const pos = new Map()
  const rings = new Map()
  for (const n of nodes) rings.set(n.scope, [...(rings.get(n.scope) ?? []), n])
  const order = [...rings.entries()].sort((a, b) => b[1].length - a[1].length)
  order.forEach(([scope, list], ri) => {
    const r = 60 + ri * 70
    list.forEach((n, i) => {
      const a = (i / Math.max(1, list.length)) * Math.PI * 2 + ri * 0.6
      pos.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.72 })
    })
  })

  const color = (n) => (n.status === 'active' ? (n.key ? '#3b82f6' : '#60a5fa') : n.status === 'superseded' ? '#a1a1aa' : '#52525b')
  const nodeSvg = nodes
    .map((n) => {
      const p = pos.get(n.id)
      const rad = 5 + n.importance * 6
      const label = esc(n.key ?? n.text.slice(0, 18))
      return `<g><title>#${n.id} ${esc(n.text)}\n${n.key ? `key=${esc(n.key)} ` : ''}${n.status}${n.to ? ' · \u5DF2\u7ED3\u675F' : ''}</title>
  <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${color(n)}" stroke="${n.to ? '#71717a' : '#1d4ed8'}" stroke-width="0.6" opacity="${n.status === 'active' ? 0.95 : 0.5}"/>
  <text x="${(p.x + rad + 3).toFixed(1)}" y="${(p.y + 3).toFixed(1)}" font-size="9" fill="#a1a1aa">${label}</text></g>`
    })
    .join('\n')

  const edgeSvg = graph.edges
    .map((e) => {
      const a = pos.get(e.src)
      const b = pos.get(e.dst)
      if (!a || !b) return ''
      const dash = e.rel === 'co_source' ? '2 3' : ''
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#3f3f46" stroke-width="${(0.3 + e.weight * 0.8).toFixed(2)}" ${dash ? `stroke-dasharray="${dash}"` : ''}><title>${esc(e.rel)}</title></line>`
    })
    .join('\n')

  const cp = graph.checkpoint
  const cpHtml = cp
    ? `<div class="cp"><b>\u4EFB\u52A1\u72B6\u6001</b> ${esc(cp.goal ?? '')}${cp.next ? `<br>\u4E0B\u4E00\u6B65\uFF1A${esc(cp.next)}` : ''}</div>`
    : ''

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{margin:0;background:#09090b;color:#e4e4e7;font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
  header{padding:12px 16px;border-bottom:1px solid #27272a;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
  header h1{font-size:14px;margin:0;font-weight:600}
  .muted{color:#71717a}
  .cp{margin-left:auto;color:#a1a1aa;font-size:12px;max-width:46ch}
  main{padding:0}
  svg{display:block;width:100%;height:auto}
  footer{padding:8px 16px;border-top:1px solid #27272a;color:#52525b;font-size:11px}
</style></head><body>
<header><h1>${esc(title)}</h1><span class="muted">\u8282\u70B9 ${graph.stats.nodes}\uFF08\u6709\u6548 ${graph.stats.active}\uFF09· \u8FB9 ${graph.stats.edges} · \u4F1A\u8BDD ${graph.stats.scopes}</span>${cpHtml}</header>
<main><svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${edgeSvg}\n${nodeSvg}</svg></main>
<footer>\u5B9E\u7EBF = \u6709\u8BC1\u636E\u7684\u5173\u7CFB\uFF08co_source / superseded_by\uFF09\uFF1B\u865A\u7EBF = \u540C\u4E00\u6761\u539F\u8BDD\u91CC\u4E00\u8D77\u62BD\u51FA\u6765\u7684\u3002\u7070\u70B9 = \u5DF2\u7ECF\u5931\u6548\u6216\u88AB\u66FF\u6362\uFF0C\u4F46\u6CA1\u5220\u3002${sessionId ? ` \u4F1A\u8BDD ${esc(sessionId)}` : ''}</footer>
</body></html>`
}
