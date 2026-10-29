/**
 * Schema migration tests.
 *
 * `openDb` creates the base schema and then applies numbered migrations on top
 * of whatever is already there. These tests build an older database by hand,
 * open it with the current code, and assert that the upgrade is additive, keeps
 * existing rows and is idempotent on a second open.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openDb, preMigrationSnapshot } from '../lib/db.mjs'
import { holdsGrant } from '../lib/auth.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-migration-'))
let pass = 0
function t(label, check) {
  check()
  pass += 1
  console.log(` ok ${label}`)
}

function columns(db, table) {
  return new Set(db.prepare(`pragma table_info(${table})`).all().map((r) => r.name))
}

function versionOf(db) {
  return db.prepare('select max(version) as v from acm_schema_migrations').get()?.v ?? 0
}

/** A v7-era database: persona proposals without owner/decided_by, one pending row. */
function makeLegacyDb(path) {
  const raw = new DatabaseSync(path)
  raw.exec(`
    create table acm_meta (k text primary key, v text not null);
    create table acm_persona_proposals (
      id integer primary key autoincrement,
      path text not null,
      base_sha256 text,
      new_sha256 text not null,
      diff_summary text,
      state text not null default 'pending',
      created_at integer not null,
      decided_at integer
    );
    create table acm_schema_migrations (version integer primary key, applied_at integer not null);
    insert into acm_schema_migrations (version, applied_at) values (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0), (7, 0);
    insert into acm_persona_proposals (path, base_sha256, new_sha256, diff_summary, state, created_at)
      values ('C:/agents/AGENTS.md', 'old', 'newer', '+1 -0', 'pending', 1);
  `)
  raw.close()
}

try {
  t('legacy v7 database upgrades to the current schema version', () => {
    const path = join(dir, 'legacy.db')
    makeLegacyDb(path)
    const db = openDb(path)
    try {
      assert.ok(versionOf(db) >= 8, `expected >= 8, got ${versionOf(db)}`)
      const cols = columns(db, 'acm_persona_proposals')
      assert.ok(cols.has('owner'), 'owner column missing')
      assert.ok(cols.has('decided_by'), 'decided_by column missing')
    } finally {
      db.close()
    }
  })

  t('migration keeps existing rows and leaves them in the legacy partition', () => {
    const path = join(dir, 'legacy-rows.db')
    makeLegacyDb(path)
    const db = openDb(path)
    try {
      const row = db.prepare('select * from acm_persona_proposals where id = 1').get()
      assert.equal(row.path, 'C:/agents/AGENTS.md')
      assert.equal(row.state, 'pending')
      assert.equal(row.owner, null)
      assert.equal(row.decided_by, null)
    } finally {
      db.close()
    }
  })

  t('reopening a migrated database applies nothing twice', () => {
    const path = join(dir, 'idempotent.db')
    makeLegacyDb(path)
    const first = openDb(path)
    const after1 = versionOf(first)
    const count1 = first.prepare('select count(*) c from acm_schema_migrations').get().c
    first.close()

    const second = openDb(path)
    try {
      assert.equal(versionOf(second), after1)
      assert.equal(second.prepare('select count(*) c from acm_schema_migrations').get().c, count1)
      assert.equal(second.prepare('select count(*) c from acm_persona_proposals').get().c, 1)
    } finally {
      second.close()
    }
  })

  t('a fresh database lands on the current version with every table', () => {
    const db = openDb(join(dir, 'fresh.db'))
    try {
      assert.ok(versionOf(db) >= 8)
      for (const table of ['acm_nodes', 'acm_source_events', 'acm_vectors', 'acm_checkpoints', 'acm_persona_proposals', 'acm_feedback']) {
        assert.ok(columns(db, table).size > 0, `${table} missing`)
      }
    } finally {
      db.close()
    }
  })

  t('legacy alias table is rebuilt with an owner column', () => {
    const path = join(dir, 'legacy-aliases.db')
    const raw = new DatabaseSync(path)
    raw.exec(`
      create table acm_schema_migrations (version integer primary key, applied_at integer not null);
      insert into acm_schema_migrations (version, applied_at) values (1,0),(2,0),(3,0),(4,0),(5,0),(6,0),(7,0),(8,0);
      create table acm_aliases (alias text primary key, canonical text not null);
      insert into acm_aliases (alias, canonical) values ('boss', 'master');
    `)
    raw.close()
    const db = openDb(path)
    try {
      const cols = columns(db, 'acm_aliases')
      assert.ok(cols.has('owner'), 'owner column missing after rebuild')
      const row = db.prepare("select owner, canonical from acm_aliases where alias = 'boss'").get()
      assert.equal(row.canonical, 'master')
      assert.equal(row.owner, null)
    } finally {
      db.close()
    }
  })

  t('a fresh database includes the mailbox', () => {
    const db = openDb(join(dir, 'fresh-mailbox.db'))
    try {
      assert.ok(versionOf(db) >= 13, `expected >= 13, got ${versionOf(db)}`)
      assert.ok(columns(db, 'acm_mailbox').has('claimed_by'))
    } finally {
      db.close()
    }
  })

  t('a fresh database includes the agent registry', () => {
    const db = openDb(join(dir, 'fresh-agents.db'))
    try {
      assert.ok(versionOf(db) >= 12, `expected >= 12, got ${versionOf(db)}`)
      assert.ok(columns(db, 'acm_agents').has('role'))
    } finally {
      db.close()
    }
  })

  t('a fresh database includes the decision records', () => {
    const db = openDb(join(dir, 'fresh-decisions.db'))
    try {
      assert.ok(versionOf(db) >= 11, `expected >= 11, got ${versionOf(db)}`)
      assert.ok(columns(db, 'acm_decisions').has('state'))
      assert.ok(columns(db, 'acm_arguments').has('evidence'))
    } finally {
      db.close()
    }
  })

  t('a fresh database includes the trust event trail', () => {
    const db = openDb(join(dir, 'fresh-trust.db'))
    try {
      assert.ok(versionOf(db) >= 10, `expected >= 10, got ${versionOf(db)}`)
      const cols = columns(db, 'acm_trust_events')
      assert.ok(cols.has('action'), 'acm_trust_events missing')
      assert.ok(cols.has('actor'), 'actor column missing')
    } finally {
      db.close()
    }
  })

  t('upgrading a populated database leaves a pre-migration snapshot', () => {
    const p = join(dir, 'old-with-data.db')
    {
      const raw = openDb(p)
      raw.exec("insert into acm_nodes (scope, kind, text, tokens, importance, owner, created_at) values ('s', 'fact', 'kept row', 'kept row', 0.5, null, 1)")
      raw.exec('delete from acm_schema_migrations where version > 8')
      raw.close()
    }
    const again = openDb(p)
    again.close()
    // Match this fixture's own snapshot, not "any snapshot in the directory": every
    // fixture in this file lives in one temp dir, and a looser filter began matching
    // a neighbour the moment a store with data but no memory nodes started getting a
    // snapshot of its own.
    const snapshots = readdirSync(dir).filter((f) => f.startsWith('old-with-data.db.pre-migrate-v8'))
    assert.equal(snapshots.length, 1, `expected one snapshot, got ${JSON.stringify(readdirSync(dir))}`)
  })
  // The snapshot rule has to ask every table that holds user state, not just the
  // memory nodes: a store with tasks and grants but nothing remembered is still a
  // store. The old check was `select count(*) from acm_nodes > 0`, so this fixture
  // migrated with no rollback file at all.
  t('a database with tasks but no memories is snapshotted too', () => {
    const p = join(dir, 'tasks-no-memories.db')
    {
      const raw = openDb(p)
      raw.exec("insert into acm_tasks (task_key, title, state, created_by, created_at, updated_at) values ('T-old-0001', 'old task', 'open', 'planner', 1, 1)")
      raw.exec("insert into acm_principals (id, kind, owner, project, created_at) values ('agent:6:runner:~', 'agent', null, null, 1)")
      raw.exec('delete from acm_schema_migrations where version > 16')
      raw.close()
    }
    const again = openDb(p)
    try {
      assert.equal(again.prepare('select count(*) c from acm_tasks').get().c, 1, 'the task survived the upgrade')
    } finally { again.close() }
    const snapshots = readdirSync(dir).filter((f) => f.startsWith('tasks-no-memories.db.pre-migrate-v16'))
    assert.equal(snapshots.length, 1, `expected one snapshot, got ${JSON.stringify(readdirSync(dir))}`)
  })

  // Two tables that the first version of the data gate forgot, each holding real
  // user state on its own: an approved persona body (in `acm_meta`) and the raw
  // source text of an import (in `acm_source_events`). A store whose only content is
  // one of those upgraded with no snapshot at all.
  t('a store whose only content is an approved persona snapshot is still backed up', () => {
    const p = join(dir, 'persona-only.db')
    {
      const raw = openDb(p)
      raw.exec("insert into acm_meta (k, v) values ('persona_body:C:/persona.md', 'the approved persona text')")
      raw.exec('delete from acm_schema_migrations where version > 8')
      raw.close()
    }
    const again = openDb(p)
    again.close()
    const snapshots = readdirSync(dir).filter((f) => f.startsWith('persona-only.db.pre-migrate-v8'))
    assert.equal(snapshots.length, 1, `expected one snapshot, got ${JSON.stringify(readdirSync(dir))}`)
  })

  t('a store whose only content is raw source events is still backed up', () => {
    const p = join(dir, 'source-only.db')
    {
      const raw = openDb(p)
      raw.exec("insert into acm_source_events (session_id, seq, kind, raw, hash, created_at) values ('s', 1, 'manual', 'what the operator actually said', 'h1', 1)")
      raw.exec('delete from acm_schema_migrations where version > 8')
      raw.close()
    }
    const again = openDb(p)
    again.close()
    const snapshots = readdirSync(dir).filter((f) => f.startsWith('source-only.db.pre-migrate-v8'))
    assert.equal(snapshots.length, 1, `expected one snapshot, got ${JSON.stringify(readdirSync(dir))}`)
  })

  // The refusal branch, tested through the helper instead of through a hook in
  // production code (the reviewer's suggestion): a destination whose parent does not
  // exist makes 'vacuum into' fail portably, so the throw and the "no migration
  // happened" property are both observable without touching anything real.
  t('a snapshot that cannot be written refuses, and the schema is left alone', () => {
    const p = join(dir, 'refuse-snapshot.db')
    let db
    {
      const raw = openDb(p)
      raw.exec("insert into acm_nodes (scope, kind, text, tokens, importance, owner, created_at) values ('s', 'fact', 'kept row', 'kept row', 0.5, null, 1)")
      raw.exec('delete from acm_schema_migrations where version > 8')
      raw.close()
    }
    db = openDb(p)
    try {
      const before = db.prepare('select max(version) v from acm_schema_migrations').get().v
      assert.equal(Number(before), 19, 'fixture should already be current after open')
      db.exec('delete from acm_schema_migrations where version > 8')
      let threw = null
      try {
        preMigrationSnapshot(db, join(dir, 'no-such-dir', 'x.db'), 8)
      } catch (err) {
        threw = err
      }
      assert.ok(threw, 'a snapshot that cannot be written must throw, not be skipped')
      assert.match(String(threw.message), /no verified pre-migration snapshot/)
      assert.match(String(threw.message), /ACM_SKIP_PRE_MIGRATION_SNAPSHOT/)
      assert.equal(Number(db.prepare('select max(version) v from acm_schema_migrations').get().v), 8,
        'the refusal must not have advanced the schema')
      assert.equal(db.prepare('select count(*) c from acm_nodes').get().c, 1, 'the row is still there')
    } finally {
      db.close()
    }
  })

  t('the documented opt-out skips the snapshot instead of refusing', () => {
    const p = join(dir, 'skip-snapshot.db')
    {
      const raw = openDb(p)
      raw.exec("insert into acm_nodes (scope, kind, text, tokens, importance, owner, created_at) values ('s', 'fact', 'kept', 'kept', 0.5, null, 1)")
      raw.close()
    }
    const db = openDb(p)
    const previous = process.env.ACM_SKIP_PRE_MIGRATION_SNAPSHOT
    process.env.ACM_SKIP_PRE_MIGRATION_SNAPSHOT = '1'
    try {
      const before = readdirSync(dir).length
      const result = preMigrationSnapshot(db, join(dir, 'no-such-dir', 'y.db'), 8)
      assert.equal(result, null, 'the opt-out returns null rather than a path')
      assert.equal(readdirSync(dir).length, before, 'and leaves no file behind')
    } finally {
      if (previous === undefined) delete process.env.ACM_SKIP_PRE_MIGRATION_SNAPSHOT
      else process.env.ACM_SKIP_PRE_MIGRATION_SNAPSHOT = previous
      db.close()
    }
  })

  // A destination that already exists is a second file, never an overwrite: the older
  // snapshot is the one an operator is more likely to want back. The old code let
  // `vacuum into` fail on the collision and swallowed the error, so the migration ran
  // with no snapshot and nothing said so.
  t('an existing snapshot file is kept, and a second one is written beside it', () => {
    const p = join(dir, 'collide.db')
    {
      const raw = openDb(p)
      raw.exec("insert into acm_nodes (scope, kind, text, tokens, importance, owner, created_at) values ('s', 'fact', 'kept row', 'kept row', 0.5, null, 1)")
      raw.exec('delete from acm_schema_migrations where version > 8')
      raw.close()
    }
    const earlier = `${p}.pre-migrate-v8.db`
    writeFileSync(earlier, 'older snapshot evidence', 'utf8')
    const again = openDb(p)
    again.close()
    assert.equal(readFileSync(earlier, 'utf8'), 'older snapshot evidence', 'the earlier snapshot was overwritten')
    const extra = readdirSync(dir).filter((f) => f.startsWith('collide.db.pre-migrate-v8-'))
    assert.equal(extra.length, 1, `expected one new snapshot beside it, got ${JSON.stringify(readdirSync(dir))}`)
  })

  // ── Principal keys: v16 → v17 → v18
  // The key used to be `kind:name`, then `kind:len:name:owner`, and is now
  // `kind:len:name:<owner part>`. Each step has one way to be wrong that does not
  // throw: the row is re-keyed and its grants are left behind, so nothing can find
  // them and nothing reports it.
  function principalTables(raw) {
    raw.exec(`
      create table acm_principals (
        id text primary key,
        kind text not null,
        owner text,
        project text,
        created_at integer not null,
        revoked_at integer
      );
      create table acm_grants (
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
      -- A database that says it is at v16 has this table: migration 16 created it.
      -- These fixtures only care about principals, but a fixture that claims v16
      -- without it is not a v16 database, and any later migration that alters the
      -- task table fails on it - which is a lie told by the fixture, not a defect
      -- in the migration. Kept to the v16 shape so the ALTERs have real columns.
      create table acm_tasks (
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
    `)
  }

  t('a v16 principal named `digits:...` is re-keyed rather than skipped', () => {
    const p = join(dir, 'v16-digits.db')
    const raw = new DatabaseSync(p)
    principalTables(raw)
    raw.exec(`
      create table acm_schema_migrations (version integer primary key, applied_at integer not null);
      insert into acm_schema_migrations (version, applied_at) values (16, 0);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:3:foo', 'agent', null, null, 1);
      insert into acm_grants (principal_id, action, created_at) values ('agent:3:foo', 'task:verify', 1);
    `)
    raw.close()
    const db = openDb(p)
    try {
      assert.deepEqual(db.prepare('select id from acm_principals').all().map((r) => r.id), ['agent:5:3:foo:~'])
      assert.deepEqual(db.prepare('select principal_id from acm_grants').all().map((r) => r.principal_id), ['agent:5:3:foo:~'])
    } finally {
      db.close()
    }
  })

  t('a v16 principal keeps its owner through both migrations', () => {
    const p = join(dir, 'v16-owner.db')
    const raw = new DatabaseSync(p)
    principalTables(raw)
    raw.exec(`
      create table acm_schema_migrations (version integer primary key, applied_at integer not null);
      insert into acm_schema_migrations (version, applied_at) values (16, 0);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:runner', 'agent', 'team', null, 1);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:solo', 'agent', null, null, 1);
    `)
    raw.close()
    const db = openDb(p)
    try {
      assert.deepEqual(db.prepare('select id from acm_principals order by id').all().map((r) => r.id),
        ['agent:4:solo:~', 'agent:6:runner:4:team'])
    } finally {
      db.close()
    }
  })

  t('a database that ran the broken v17 has its skipped grant repaired by v18', () => {
    const p = join(dir, 'v17-broken.db')
    const raw = new DatabaseSync(p)
    principalTables(raw)
    raw.exec(`
      create table acm_schema_migrations (version integer primary key, applied_at integer not null);
      insert into acm_schema_migrations (version, applied_at) values (15, 0), (16, 0), (17, 0);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:3:foo', 'agent', null, null, 1);
      insert into acm_grants (principal_id, action, created_at) values ('agent:3:foo', 'task:verify', 1);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:6:runner:4:team', 'agent', 'team', null, 1);
    `)
    raw.close()
    const db = openDb(p)
    try {
      const ids = db.prepare('select id from acm_principals order by id').all().map((r) => r.id)
      assert.deepEqual(ids, ['agent:5:3:foo:~', 'agent:6:runner:4:team'])
      assert.deepEqual(db.prepare('select principal_id from acm_grants').all().map((r) => r.principal_id), ['agent:5:3:foo:~'])
    } finally {
      db.close()
    }
  })

  // The case the review found: a database that already ran migration 17, holding
  // a NULL-owner principal in the old v17 shape (`agent:6:runner:`, empty tail).
  // v18 used to read the owner from the key's tail, fail the check against a NULL
  // hint, and hand the row to the v1 reader - which swallowed `6:runner:` as the
  // name and stranded the grants. The assertion that matters is not the key shape
  // but that the runtime principal still finds its grant after the upgrade.
  t('an already-migrated v17 NULL-owner principal keeps its grant usable', () => {
    const p = join(dir, 'v17-null-owner.db')
    const raw = new DatabaseSync(p)
    principalTables(raw)
    raw.exec(`
      create table acm_schema_migrations (version integer primary key, applied_at integer not null);
      insert into acm_schema_migrations (version, applied_at) values (15, 0), (16, 0), (17, 0);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:6:runner:', 'agent', null, null, 1);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:6:runner:4:team', 'agent', 'team', null, 1);
      insert into acm_grants (principal_id, action, created_at) values ('agent:6:runner:', 'task:verify', 1);
      insert into acm_grants (principal_id, action, created_at) values ('agent:6:runner:4:team', 'task:accept', 1);
    `)
    raw.close()
    const db = openDb(p)
    try {
      assert.deepEqual(
        db.prepare('select id from acm_principals order by id').all().map((r) => r.id),
        ['agent:6:runner:4:team', 'agent:6:runner:~'],
      )
      // The end-to-end assertion: what the running code computes must still see
      // the grant, or the upgrade silently revoked the principal.
      const runner = { kind: 'agent', id: 'runner', owner: null, project: null }
      const teamRunner = { kind: 'agent', id: 'runner', owner: 'team', project: null }
      assert.equal(holdsGrant(db, runner, 'task:verify'), true, 'NULL-owner grant lost in upgrade')
      assert.equal(holdsGrant(db, teamRunner, 'task:accept'), true, 'named-owner grant lost in upgrade')
      // And the upgrade must not have granted anything new either.
      assert.equal(holdsGrant(db, runner, 'task:accept'), false, 'upgrade widened a grant')
      assert.equal(db.prepare('select count(*) c from acm_grants').get().c, 2)
    } finally {
      db.close()
    }
  })

  // A v1 name that merely looks like a current key must still be re-keyed by 17.
  // The old code asked the string whether it was already migrated; this name
  // answers yes, so its grants would have been stranded one version later.
  t('a v1 name shaped like a current key is still migrated, not skipped', () => {
    const p = join(dir, 'v16-looks-new.db')
    const raw = new DatabaseSync(p)
    principalTables(raw)
    raw.exec(`
      create table acm_schema_migrations (version integer primary key, applied_at integer not null);
      insert into acm_schema_migrations (version, applied_at) values (16, 0);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:6:runner:~', 'agent', null, null, 1);
      insert into acm_grants (principal_id, action, created_at) values ('agent:6:runner:~', 'task:verify', 1);
    `)
    raw.close()
    const db = openDb(p)
    try {
      assert.deepEqual(db.prepare('select id from acm_principals').all().map((r) => r.id), ['agent:10:6:runner:~:~'])
      assert.deepEqual(db.prepare('select principal_id from acm_grants').all().map((r) => r.principal_id), ['agent:10:6:runner:~:~'])
    } finally {
      db.close()
    }
  })

  t('the key repair is idempotent: a second open changes nothing', () => {
    const p = join(dir, 'v16-idempotent.db')
    const raw = new DatabaseSync(p)
    principalTables(raw)
    raw.exec(`
      create table acm_schema_migrations (version integer primary key, applied_at integer not null);
      insert into acm_schema_migrations (version, applied_at) values (16, 0);
      insert into acm_principals (id, kind, owner, project, created_at) values ('agent:3:foo', 'agent', '', null, 1);
    `)
    raw.close()
    const first = openDb(p)
    const before = first.prepare('select id from acm_principals').all().map((r) => r.id)
    first.close()
    const second = openDb(p)
    try {
      assert.deepEqual(second.prepare('select id from acm_principals').all().map((r) => r.id), before)
      assert.deepEqual(before, ['agent:5:3:foo:0:'], 'the empty owner is kept apart from no owner')
    } finally {
      second.close()
    }
  })

  console.log(`\nmigration: ${pass} passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
