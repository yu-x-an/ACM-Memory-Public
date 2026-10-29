// \u4E00\u4E2A\u5E93\uFF0Cacm_ \u524D\u7F00\u7684\u8868\u3002\u6253\u5F00\u5373\u5EFA\u8868\uFF0C\u8FC1\u79FB\u6309\u7248\u672C\u53F7\u8D70\u3002

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { ID_KINDS, canonicalPrincipalId, principalId } from './principal-id.mjs'

const SCHEMA = `
create table if not exists acm_meta (
  k text primary key,
  v text not null
);

-- \u539F\u59CB\u4E8B\u4EF6\uFF1A\u4EFB\u4F55\u4E00\u6761\u8BB0\u5FC6\u90FD\u5FC5\u987B\u80FD\u6307\u56DE\u5B83\u4ECE\u54EA\u513F\u6765
create table if not exists acm_source_events (
  id integer primary key autoincrement,
  session_id text,
  seq integer,
  kind text not null,              -- user | assistant | tool | manual | import | compaction
  raw text not null,
  hash text not null,
  created_at integer not null,
  unique (hash)
);

create table if not exists acm_nodes (
  id integer primary key autoincrement,
  scope text not null,             -- 'global' \u6216 session id
  kind text not null,              -- fact | preference | event | task | persona
  subject text,
  predicate text,
  object text,
  key text,                        -- \u4E8B\u5B9E\u952E\uFF1A\u5979.\u8EAB\u9AD8
  text text not null,
  tokens text not null,
  importance real not null default 0.5,
  status text not null default 'active',   -- active | superseded | forgotten
  superseded_by integer,
  created_at integer not null,
  last_used_at integer,
  used_count integer not null default 0,
  expires_at integer
);
create index if not exists acm_nodes_scope on acm_nodes (scope, status);
create index if not exists acm_nodes_key on acm_nodes (key) where key is not null;

create table if not exists acm_node_sources (
  node_id integer not null,
  source_id integer not null,
  primary key (node_id, source_id)
);
create index if not exists acm_node_sources_src on acm_node_sources (source_id);

-- Aliases are per-partition. Uniqueness is enforced in code rather than by a
-- constraint because the legacy partition stores a NULL owner, and NULL values
-- are distinct in a SQLite unique index.
create table if not exists acm_aliases (
  owner text,
  alias text not null,
  canonical text not null
);
create index if not exists acm_aliases_alias on acm_aliases (alias);

create table if not exists acm_edges (
  id integer primary key autoincrement,
  src integer not null,
  dst integer not null,
  rel text not null,
  weight real not null default 1.0,
  created_at integer not null
);
create unique index if not exists acm_edges_uniq on acm_edges (src, dst, rel);
create index if not exists acm_edges_src on acm_edges (src);
create index if not exists acm_edges_dst on acm_edges (dst);

create virtual table if not exists acm_fts using fts5 (
  tokens,
  node_id unindexed,
  tokenize = 'unicode61'
);

-- \u4EFB\u52A1\u72B6\u6001\uFF1A\u548C\u4E8B\u5B9E\u5206\u5F00\u5B58\uFF0C\u56E0\u4E3A\u5B83\u77ED\u547D\u3001\u8981\u80FD\u6574\u4F53\u66FF\u6362
create table if not exists acm_checkpoints (
  id integer primary key autoincrement,
  session_id text not null,
  goal text,
  done text,
  next text,
  files text,
  decisions text,
  turn integer,
  created_at integer not null,
  delivered_at integer,
  superseded_by integer
);
create index if not exists acm_checkpoints_sess on acm_checkpoints (session_id, created_at);

-- \u6062\u590D\u56DE\u6267\uFF1Aprepared -> delivered\uFF0C\u6CA1\u56DE\u6267\u5C31\u4E0D\u7B97\u9001\u56DE\u53BB\u4E86
create table if not exists acm_recovery_receipts (
  id integer primary key autoincrement,
  checkpoint_id integer not null,
  session_id text not null,
  state text not null,
  at integer not null,
  note text
);

-- \u4EBA\u683C\u6539\u52A8\u63D0\u6848\uFF1A\u6587\u4EF6\u662F\u522B\u4EBA\u6539\u7684\uFF0C\u8FD9\u91CC\u53EA\u8D1F\u8D23\u8BB0\u8D26\u548C\u544A\u8B66
create table if not exists acm_persona_proposals (
  id integer primary key autoincrement,
  path text not null,
  base_sha256 text,
  new_sha256 text not null,
  diff_summary text,
  state text not null default 'pending',  -- pending | approved | rejected
  created_at integer not null,
  decided_at integer
);

create table if not exists acm_schema_migrations (
  version integer primary key,
  applied_at integer not null
);
`

/** \u5E93\u7ED3\u6784\u8FC1\u79FB\uFF1A\u53EA\u52A0\u4E0D\u5220\uFF0C\u52A0\u4E4B\u524D\u5148\u770B\u6709\u6CA1\u6709 */
const MIGRATIONS = [
  {
    version: 13,
    // Asynchronous coordination: agents arrive at different times, so work is
    // handed over through a mailbox instead of a live conversation. A message is
    // claimed by exactly one agent and completed by that agent.
    sql: `
      create table if not exists acm_mailbox (
        id integer primary key autoincrement,
        owner text,
        recipient text not null,
        sender text not null,
        kind text not null,
        decision_id integer,
        body text not null,
        state text not null default 'pending',
        created_at integer not null,
        claimed_at integer,
        claimed_by text,
        done_at integer
      );
      create index if not exists acm_mailbox_inbox on acm_mailbox (owner, recipient, state);
    `,
  },
  {
    version: 17,
    // Principals were keyed by `kind:name`, so the same agent name in two owner
    // partitions shared one row - and therefore one set of grants. The key now
    // embeds the owner.
    //
    // This migration rewrites what it can and refuses to invent what it cannot:
    // the old rows kept only the last owner that touched them, so a grant that was
    // really made for another owner cannot be recovered. Those must be re-issued;
    // this migration does not guess an owner it never recorded.
    //
    // Every row here is a v1 row: this migration runs exactly once, on a database
    // whose principals were all written by the code that created the table. The
    // previous versions of this migration tried to detect "already migrated" rows
    // from the key's string shape - first `/^(user|agent|device):\d+:/`, which
    // skipped a v1 agent *named* `3:foo`; then a full parse, which a v1 name like
    // `6:runner:~` also satisfies. Guessing is unnecessary: the migration version
    // already guarantees the input format, so every row is read as v1 and rewritten
    // unconditionally. Version 18 repairs any database that ran a broken version.
    fn: (db) => {
      const rows = db.prepare('select id, kind, owner, project, created_at, revoked_at from acm_principals').all()
      const mapping = new Map()
      for (const row of rows) {
        const stored = String(row.id)
        const cut = stored.indexOf(':')
        const kind = ID_KINDS.includes(stored.slice(0, cut)) ? stored.slice(0, cut) : (row.kind ?? 'agent')
        const name = kind === stored.slice(0, cut) ? stored.slice(cut + 1) : stored
        if (!name) continue
        const next = principalId({ kind, id: name, owner: row.owner ?? null })
        mapping.set(stored, next)
        if (next === stored) continue
        db.prepare('delete from acm_principals where id = ?').run(stored)
        const clash = db.prepare('select 1 from acm_principals where id = ?').get(next)
        if (!clash) {
          db.prepare('insert into acm_principals (id, kind, owner, project, created_at, revoked_at) values (?, ?, ?, ?, ?, ?)')
            .run(next, kind, row.owner ?? null, row.project ?? null, row.created_at ?? Date.now(), row.revoked_at ?? null)
        }
      }
      for (const [oldId, next] of mapping) {
        if (oldId === next) continue
        db.prepare('update acm_grants set principal_id = ? where principal_id = ?').run(next, oldId)
      }
    },
  },
  {
    version: 19,
    // The user's final confirmation. `verified` says "a second AI accepted the
    // work"; it says nothing about whether the person the work was for has seen it.
    // `confirmed` is that act, and it is deliberately **not** reachable from a tool
    // or the SDK - `acm task confirm` on the CLI is the only surface, so an agent
    // cannot approve its own work through the machinery it uses to do the work.
    columns: [
      ['acm_tasks', 'confirmed_by', 'text'],
      ['acm_tasks', 'confirmed_at', 'integer'],
    ],
    sql: '',
  },
  {
    version: 18,
    // The owner part of a principal key is length-prefixed, and "no owner" has its
    // own marker (`~`). Two defects are repaired in one pass, because both are the
    // same bug seen twice - the key did not say unambiguously who it was:
    //
    // 1. `owner = null` and `owner = ''` produced the same key, so a grant written
    //    for one partition authorised the other. Every SQL predicate in this
    //    repository already keeps those apart (`owner IS ?`, the owner-partition fix);
    //    the key stopped doing so one layer up.
    // 2. A v1 principal *named* `3:foo` was skipped by the previous version of
    //    migration 17, leaving its grants on a key nothing looks up any more.
    //
    // How this reads a row: the name comes from the shape a v17 key has (a
    // length-prefixed name followed by a separator), with a v1 fallback for rows
    // the broken v17 skipped - and the owner comes from the row's own `owner`
    // column, never from the key's tail. Reading the owner from the tail is how an
    // already-migrated NULL-owner row (`agent:6:runner:`) was renamed
    // `agent:9:6:runner::~` and its grants stranded - the empty tail failed the
    // v17 reader's owner check, so the v1 reader swallowed `6:runner:` as the name.
    //
    // Stated limit, not a hidden one: a v1 principal whose name looks exactly like
    // `3:foo:` is indistinguishable from a v17 `name = foo` with an empty owner -
    // both produce the key `agent:3:foo:`. No field in the row settles it. Such a
    // name has to be re-created by hand; the alternative - guessing - would re-key
    // a grant onto the wrong partition, which is the defect being fixed.
    fn: (db) => {
      const rows = db.prepare('select id, kind, owner, project, created_at, revoked_at from acm_principals').all()
      const mapping = new Map()
      for (const row of rows) {
        const stored = String(row.id)
        const next = canonicalPrincipalId(stored, row)
        if (!next || next === stored) continue
        mapping.set(stored, next)
        const clash = db.prepare('select 1 from acm_principals where id = ?').get(next)
        if (!clash) {
          db.prepare('insert into acm_principals (id, kind, owner, project, created_at, revoked_at) values (?, ?, ?, ?, ?, ?)')
            .run(next, row.kind, row.owner ?? null, row.project ?? null, row.created_at ?? Date.now(), row.revoked_at ?? null)
        }
        db.prepare('delete from acm_principals where id = ?').run(stored)
      }
      for (const [oldId, next] of mapping) {
        db.prepare('update acm_grants set principal_id = ? where principal_id = ?').run(next, oldId)
      }
    },
  },
  {
    version: 15,
    // Principals and grants. A principal is a declaration, not a proof: this table
    // exists so a decision can be written down and revoked, not so a caller can be
    // believed. `acm/auth.mjs` says which mode enforces what.
    sql: `
      create table if not exists acm_principals (
        id text primary key,
        kind text not null,
        owner text,
        project text,
        created_at integer not null,
        revoked_at integer
      );
      create table if not exists acm_grants (
        id integer primary key autoincrement,
        principal_id text not null,
        action text not null,
        target text,
        granted_by text,
        created_at integer not null,
        expires_at integer,
        revoked_at integer,
        revoked_by text
      );
      create index if not exists acm_grants_principal on acm_grants (principal_id, action);
    `,
  },
  {
    version: 16,
    // Durable task state. The mailbox carries messages; this carries work: states,
    // attempts, leases, dependencies, a required result with evidence, and a
    // separate verifier. The event table is append-only, enforced by triggers, so
    // the trail cannot be edited into agreeing with the row.
    sql: `
      create table if not exists acm_tasks (
        id integer primary key autoincrement,
        task_key text not null unique,
        owner text,
        project text,
        title text not null,
        detail text,
        state text not null,
        priority integer not null default 0,
        created_by text not null,
        assignee text,
        attempts integer not null default 0,
        max_attempts integer not null default 3,
        lease_until integer,
        result text,
        result_evidence text,
        verified_by text,
        depends_on text,
        last_reason text,
        created_at integer not null,
        updated_at integer not null,
        closed_at integer,
        version integer not null default 1
      );
      create index if not exists acm_tasks_owner_state on acm_tasks (owner, state, priority);
      create index if not exists acm_tasks_assignee on acm_tasks (owner, assignee, state);
      create table if not exists acm_task_events (
        id integer primary key autoincrement,
        task_key text not null,
        from_state text,
        to_state text not null,
        action text not null,
        actor text not null,
        at integer not null,
        payload text
      );
      create index if not exists acm_task_events_key on acm_task_events (task_key, id);
      create trigger if not exists acm_task_events_no_update before update on acm_task_events
        begin select raise(abort, 'task events are append-only'); end;
      create trigger if not exists acm_task_events_no_delete before delete on acm_task_events
        begin select raise(abort, 'task events are append-only'); end;
    `,
  },
  {
    version: 12,
    // Local agent registry. This is an attribution label, not authentication:
    // anyone who can open the database can claim any name here. It exists so a
    // decision record can say who said what and so roles can be enforced once
    // an operator has registered participants.
    sql: `
      create table if not exists acm_agents (
        id integer primary key autoincrement,
        owner text,
        name text not null,
        role text not null,
        created_at integer not null
      );
      create index if not exists acm_agents_owner on acm_agents (owner, name);
    `,
  },
  {
    version: 11,
    // Shared decision records. Both coordination modes (a leader calling others,
    // and independent agents arriving at different times) need one auditable
    // place to propose, argue and decide, with the evidence each claim cites.
    sql: `
      create table if not exists acm_decisions (
        id integer primary key autoincrement,
        owner text,
        scope text not null,
        topic text not null,
        proposal text not null,
        state text not null default 'open',
        proposer text not null,
        decided_by text,
        rationale text,
        created_at integer not null,
        decided_at integer,
        superseded_by integer
      );
      create index if not exists acm_decisions_scope on acm_decisions (scope, state);

      create table if not exists acm_arguments (
        id integer primary key autoincrement,
        decision_id integer not null,
        actor text not null,
        stance text not null,
        text text not null,
        evidence text,
        at integer not null
      );
      create index if not exists acm_arguments_decision on acm_arguments (decision_id);
    `,
  },
  {
    version: 10,
    // Quarantine and release are trust decisions. Without an append-only trail
    // nobody can answer "who hid this memory, when, and why".
    sql: `
      create table if not exists acm_trust_events (
        id integer primary key autoincrement,
        node_id integer not null,
        owner text,
        action text not null,
        reason text,
        actor text,
        at integer not null
      );
      create index if not exists acm_trust_events_node on acm_trust_events (node_id);
      create index if not exists acm_trust_events_owner on acm_trust_events (owner);
    `,
  },
  {
    version: 9,
    // Aliases were one global namespace: any owner could rewrite a mapping and
    // change every owner's query expansion. Rebuild the table with an owner.
    fn: (raw) => {
      const cols = new Set(raw.prepare('pragma table_info(acm_aliases)').all().map((r) => r.name))
      if (cols.has('owner')) return
      raw.exec('create table acm_aliases_new (owner text, alias text not null, canonical text not null)')
      raw.exec('insert into acm_aliases_new (owner, alias, canonical) select null, alias, canonical from acm_aliases')
      raw.exec('drop table acm_aliases')
      raw.exec('alter table acm_aliases_new rename to acm_aliases')
      raw.exec('create index if not exists acm_aliases_alias on acm_aliases (alias)')
    },
  },
  {
    version: 8,
    // Persona proposals become attributable: which partition raised the change
    // and which principal approved or rejected it. Without these columns an
    // approval has no owner and no actor, so it cannot be audited.
    columns: [
      ['acm_persona_proposals', 'owner', 'text'],
      ['acm_persona_proposals', 'decided_by', 'text'],
    ],
  },
  {
    version: 7,
    // \u4E2D\u6587\u8BF4\u6CD5\uFF1A\u8282\u70B9\u6B63\u6587\u662F\u82F1\u6587\u77ED\u8BED\uFF08\u4FBF\u4E8E agent \u8FDE\uFF09\uFF0C\u4F46\u7528\u6237\u662F\u7528\u4E2D\u6587\u95EE\u7684\u3002
    // \u5149\u9760\u8DE8\u8BED\u8A00\u4F59\u5F26\u5339\u914D\u7387\u53EA\u6709\u4E09\u6210\uFF0C\u628A\u4E2D\u6587\u8BF4\u6CD5\u4E00\u8D77\u5B58\u3001\u4E00\u8D77\u7D22\u5F15\u3001\u4E00\u8D77\u7B97\u5411\u91CF\uFF0C\u624D\u635E\u5F97\u5230\u3002
    columns: [['acm_nodes', 'gloss', 'text']],
  },
  {
    version: 6,
    // \u5411\u91CF\u8868\u4E00\u5F00\u59CB\u628A\u8282\u70B9 id \u5199\u6210\u4E86 '1.0'\uFF08\u9A71\u52A8\u7ED9\u7684\u662F\u6D6E\u70B9\uFF09\uFF0C\u8DDF\u6574\u578B\u4E3B\u952E join \u4E0D\u4E0A\uFF0C\u7EDF\u4E00\u56DE\u6574\u6570\u4E32
    columns: [],
    sql: 'update acm_vectors set node_id = cast(cast(node_id as real) as integer);',
  },
  {
    version: 5,
    // \u8BED\u4E49\u53EC\u56DE\uFF1A\u4E00\u6761\u8282\u70B9\u4E00\u4E2A\u5411\u91CF\uFF0C\u6A21\u578B\u6362\u4E86\u5C31\u6574\u6761\u91CD\u7B97\uFF08model \u8BB0\u7740\u662F\u8C01\u7B97\u7684\uFF09
    columns: [],
    sql: `
      create table if not exists acm_vectors (
        node_id text primary key,
        model text not null,
        dim integer not null,
        vec blob not null,
        at integer not null
      );
    `,
  },
  {
    version: 2,
    // \u65F6\u95F4\u8F74 + \u591A\u79DF\u6237\uFF1A\u4E8B\u5B9E\u4EC0\u4E48\u65F6\u5019\u6210\u7ACB\u3001\u4EC0\u4E48\u65F6\u5019\u9000\u573A\uFF1B\u8FD9\u6761\u8BB0\u5FC6\u662F\u8C01\u7684
    columns: [
      ['acm_nodes', 'owner', 'text'],
      ['acm_nodes', 'valid_from', 'integer'],
      ['acm_nodes', 'valid_to', 'integer'],
      ['acm_checkpoints', 'owner', 'text'],
      ['acm_source_events', 'owner', 'text'],
    ],
  },
  {
    version: 4,
    // \u540C\u6E90\u5173\u7CFB\u7EDF\u4E00\u8D70 acm_node_sources \u7684 join\uFF0C\u8001\u7684\u4E24\u4E24\u8FDE\u8FB9\u4E0D\u518D\u9700\u8981\uFF0C\u987A\u624B\u6E05\u6389
    columns: [],
    sql: "delete from acm_edges where rel = 'co_source'",
  },
  {
    version: 3,
    // \u8FDB\u5316\uFF1A\u7528\u5F97\u597D\u4E0D\u597D\u8981\u8BB0\u4E0B\u6765\uFF0C\u624D\u6709\u4E1C\u897F\u53EF\u8C03
    columns: [],
    sql: `
      create table if not exists acm_feedback (
        id integer primary key autoincrement,
        node_id integer not null,
        verdict text not null,          -- useful | wrong
        note text,
        at integer not null
      );
      create index if not exists acm_feedback_node on acm_feedback (node_id);
      create table if not exists acm_evolutions (
        id integer primary key autoincrement,
        at integer not null,
        report text not null
      );
    `,
  },
]

function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`pragma table_info(${table})`).all().map((r) => r.name))
  } catch {
    return new Set()
  }
}

/**
 * Does this database hold anything the operator would miss?
 *
 * This used to ask `select count(*) from acm_nodes`, which answers "does it hold
 * memories" - so a store with tasks, grants or checkpoints but no memory nodes got
 * no pre-migration snapshot at all. The question has to be asked of every table that
 * carries user state, and a table that does not exist yet simply counts as empty.
 */
function hasOperatorData(db) {
  // `acm_meta` and `acm_source_events` were missing from the first version of this
  // list, and both hold user state: approved persona bodies are stored in `acm_meta`
  // under `persona_body:<path>`, and raw source text lands in `acm_source_events`. A
  // store whose only content was one of those upgraded with no snapshot at all
  // - the same failure as before, one table further in.
  const tables = [
    'acm_nodes', 'acm_checkpoints', 'acm_principals', 'acm_grants', 'acm_tasks',
    'acm_task_events', 'acm_mailbox', 'acm_agents', 'acm_decisions', 'acm_arguments',
    'acm_trust_events', 'acm_persona_proposals', 'acm_edges', 'acm_aliases',
    'acm_source_events', 'acm_feedback', 'acm_recovery_receipts',
  ]
  for (const table of tables) {
    try {
      if (Number(db.prepare(`select count(*) c from ${table}`).get()?.c ?? 0) > 0) return true
    } catch {}
  }
  // `acm_meta` always has rows (schema bookkeeping), so it cannot be asked "is it
  // non-empty". Ask the question that matters instead: does it hold records that
  // only exist because the operator used this store?
  try {
    const keys = db.prepare("select count(*) c from acm_meta where k like 'persona_body:%' or k like 'persona_sha:%'").get()?.c
    if (Number(keys ?? 0) > 0) return true
  } catch {}
  return false
}

/**
 * Write and verify a pre-migration snapshot, or refuse to migrate.
 *
 * The previous version swallowed every failure in an empty `catch {}` and skipped
 * the work entirely when the store had no memory nodes, so an IO error, a full disk
 * or an existing destination file meant the schema changed with no rollback file and
 * no message. A migration is the one moment a user database can be
 * rewritten; if a verified copy cannot be produced, the honest answer is to stop and
 * say so. `ACM_SKIP_PRE_MIGRATION_SNAPSHOT=1` is the deliberate way past it, for a
 * disposable or already-backed-up store.
 */
export function preMigrationSnapshot(db, dbPath, fromVersion) {
  const skip = process.env.ACM_SKIP_PRE_MIGRATION_SNAPSHOT === '1'
  // Never overwrite an earlier snapshot: the suffix counts up. Two migrations from
  // the same version can happen if one is reverted by hand, and the older file is
  // the better one to keep.
  let target = `${dbPath}.pre-migrate-v${fromVersion}.db`
  for (let n = 2; existsSync(target); n++) target = `${dbPath}.pre-migrate-v${fromVersion}-${n}.db`
  try {
    db.exec(`vacuum into '${target.replace(/'/g, "''")}'`)
    // A snapshot nobody opened is a guess. quick_check is cheap and catches the
    // truncated-file case that a size check misses.
    const copy = new DatabaseSync(target, { readOnly: true })
    let verdict = 'unknown'
    try { verdict = copy.prepare('pragma quick_check').get()?.quick_check ?? 'unknown' } finally { copy.close() }
    if (verdict !== 'ok') throw new Error(`snapshot failed quick_check: ${verdict}`)
    return target
  } catch (err) {
    if (skip) {
      try { if (existsSync(target)) rmSync(target, { force: true }) } catch {}
      return null
    }
    throw new Error(
      `refusing to migrate ${dbPath} from v${fromVersion}: no verified pre-migration snapshot (${err?.message ?? err}). `
      + 'Fix the cause, or set ACM_SKIP_PRE_MIGRATION_SNAPSHOT=1 if this store is disposable or already backed up.',
    )
  }
}

function migrate(db, dbPath = null) {
  const row = db.prepare('select max(version) as v from acm_schema_migrations').get()
  let current = row?.v ?? 0
  if (!current) {
    db.prepare('insert into acm_schema_migrations (version, applied_at) values (?, ?)').run(1, Date.now())
    current = 1
  }
  const pending = [...MIGRATIONS].sort((a, b) => a.version - b.version).filter((m) => m.version > current)
  // Snapshot before changing the schema. A migration that fails is rolled back by
  // its transaction, but a process killed mid-run is not, and the operator needs a
  // file to go back to that is not the one being rewritten.
  if (pending.length && dbPath && dbPath !== ':memory:' && hasOperatorData(db)) {
    preMigrationSnapshot(db, dbPath, current)
  }

  // \u6309\u7248\u672C\u53F7\u987A\u5E8F\u8DD1\uFF1A\u6570\u7EC4\u987A\u5E8F\u4E0D\u7B49\u4E8E\u7248\u672C\u987A\u5E8F\uFF0C\u63D2\u4E00\u6761\u65B0\u7684\u63D2\u9519\u4F4D\u7F6E\u5C31\u4F1A\u6F0F\u6389\u522B\u4EBA
  for (const m of pending) {
    if (m.version <= current) continue
    // One transaction per migration, including the version row. A crash used to
    // be able to leave half the DDL applied with the version unrecorded, and the
    // next open would then replay the migration over a partially changed schema.
    db.exec('BEGIN')
    try {
      const existing = new Map()
      for (const [table, column, type] of m.columns ?? []) {
        if (!existing.has(table)) existing.set(table, columnsOf(db, table))
        if (existing.get(table).has(column)) continue
        db.exec(`alter table ${table} add column ${column} ${type};`)
      }
      if (m.sql) db.exec(m.sql)
      if (typeof m.fn === 'function') m.fn(db)
      db.prepare('insert into acm_schema_migrations (version, applied_at) values (?, ?)').run(m.version, Date.now())
      db.exec('COMMIT')
      current = m.version
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw new Error(`migration ${m.version} failed and was rolled back: ${err?.message ?? err}`)
    }
  }
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal;')
  db.exec('pragma busy_timeout = 4000;')
  db.exec('pragma foreign_keys = on;')
  db.exec(SCHEMA)
  migrate(db, path)
  return db
}

export function metaGet(db, k, fallback = null) {
  const row = db.prepare('select v from acm_meta where k = ?').get(k)
  return row ? row.v : fallback
}

export function metaSet(db, k, v) {
  db.prepare('insert into acm_meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v')
    .run(k, String(v))
}

/** \u4E8B\u52A1\u5305\u4E00\u5C42\uFF0C\u5199\u6765\u6E90+\u8282\u70B9+\u8FB9\u5FC5\u987B\u540C\u751F\u540C\u6B7B */
export function tx(db, fn) {
  db.exec('begin immediate')
  try {
    const out = fn()
    db.exec('commit')
    return out
  } catch (err) {
    try { db.exec('rollback') } catch {}
    throw err
  }
}
