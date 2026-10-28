# API surface and stability policy

This document says what is supported, what may still change, and what callers may
rely on. It is deliberately conservative: a small supported surface that holds is
worth more than a large one that drifts.

The current line is a release candidate (`1.0.0-rc.2`). The surface is frozen
mechanically by `api-surface.json`, but a 1.0 release still depends on gates that
are tracked with the release process rather than in this document.

## Supported entry points

| Entry point | Audience | Stability |
| --- | --- | --- |
| `lib/sdk.mjs` (`openMemory`) | Applications embedding the store | **Stable** for the methods listed below |
| `lib/host/cli.mjs` (`acm`) | Operators | **Stable** for documented commands |
| `lib/host/mcp.mjs` (`acm-mcp`) | MCP clients | **Stable** for the documented tools and resources |
| `lib/index.mjs` (`apply`) | DSH host | **Experimental**: the host contract itself is unverified |
| every other `lib/*.mjs` export | Internal use, tests | **Internal**: may change in any release |

`openMemory()` takes `{ dbPath, sessionId, config }` and returns a handle bound to
one database, one session and one owner partition. `config.owner` is fixed for the
life of the handle; per-call owner overrides are not accepted anywhere.

The MCP server reads six environment variables - `ACM_DB`, `ACM_SESSION`,
`ACM_OWNER`, `ACM_PROJECT`, `ACM_AGENT` and `ACM_AUTH_MODE` - and exposes twenty-five tools plus the
`acm://injection`, `acm://persona` and `acm://status` resources: thirteen
memory/mailbox tools and twelve task tools (`acm_task_create`, `list`, `get`,
`assign`, `accept`, `renew`, `return`, `verify`, `reject`, `fail`, `cancel`,
`retry`). There is deliberately **no** `acm_task_confirm`: the user's own
confirmation is not something an agent may perform on its behalf - see
"Durable tasks" below. Two of its parameters carry meaning
worth stating here: `acm_remember` accepts `scope: global` (only that value; an
arbitrary scope string is ignored rather than honoured, so one caller cannot write
into another session's partition), and the agent name from `ACM_AGENT` decides who
may claim and close a mailbox task. Neither is an authorization mechanism.

`ACM_AUTH_MODE=scoped` makes the tool path consult grants (`lib/auth.mjs`) before a
task verb, a mailbox claim/complete or a global memory write. It is **not** a
store-wide enforcement layer: the CLI and the SDK call the task and mailbox
modules directly, so a `scoped` store still relies on those surfaces being trusted
processes. Read authorization does not exist on any surface yet.

## SDK methods by area

Every method below is bound to the configured owner and session.

### Memory

| Method | Notes |
| --- | --- |
| `remember({ text, key, kind, importance, gloss, source, scope })` | Redacted before persistence |
| `search(query, { limit })` | Lexical ranking |
| `searchAsync(query, { limit })` | Hybrid ranking when embeddings are enabled |
| `history(opts)` | Revision chain for a key |
| `sources(nodeId)` | Evidence rows for one memory |
| `provenance(id)` | Node, evidence, votes and revisions in one call |
| `forget(id)` | Soft invalidation: the row stays |
| `purge(id)` / `purgeRange({ before, scope, dryRun })` | Physical deletion, irreversible |
| `verifyPurged(id)` | Per-table residue counts |
| `conflicts(opts)` / `resolveConflict(id)` | Fact-key churn and pinning a revision |

### Checkpoints and recovery

| Method | Notes |
| --- | --- |
| `checkpoint({ goal, done, next, files, decisions })` | Replaces the active checkpoint |
| `checkpointNow()` | The active checkpoint or null |
| `markDelivered(id, note)` | Idempotent |
| `receipts(id)` / `verifyRecovery()` | Consistency of the receipt ledger |
| `scan(events)` | Compaction detection over host events |
| `inject({ query })` | The text that would be injected |

### Persona

| Method | Notes |
| --- | --- |
| `persona(paths)` | Loads files and raises proposals for changes |
| `proposals()` | Pending proposals for this partition |
| `decide(id, approve)` | Requires a principal; recorded as `decided_by` |

### Immunity and coordination

| Method | Notes |
| --- | --- |
| `suspects()` / `quarantine(id)` / `release(id)` | Heuristic flagging plus reversible hiding |
| `trustEvents(opts)` | Audit trail for the two calls above |
| `openDecision(input)` / `argue(id, input)` / `decideOutcome(id, input)` | One shared decision record |
| `decisions(opts)` / `decision(id)` | Listing and full view with evidence checks |
| agent registry via `registerAgent` (module export) | Roles gate propose/argue/decide once registered |

### Durable tasks

| Method | Notes |
| --- | --- |
| `taskCreate({ title, detail, assignee, dependsOn, priority })` | Returns `{ ok, task }`; the key is a stable `T-...` |
| `tasks({ state, assignee, limit })` | Partition-scoped listing |
| `task(key)` | `{ task, events }`, or null outside the partition |
| `taskAssign(key, assignee)` / `taskAccept(key, { leaseMs })` | `accept` is conditional on the task being assigned to this actor |
| `taskReturn(key, { result, evidence })` | Both are required; evidence is `[{ kind, ref }]` |
| `taskVerify(key, { note })` | Refuses when the verifier is the assignee |
| `taskFail` / `taskCancel` / `taskRetry` | Reasons required where they matter; retry is explicit |
| `taskExpireLeases(at)` | Turns leases past their deadline into `expired` |

**`confirmed` is not in this table on purpose.** States run
`open -> assigned -> running -> returned -> verified`, and `verified` means *a
second agent accepted the work*. Whether the person the work was for has read it
is a different fact, so it is a separate terminal state, `confirmed`, written by
`acm task confirm --key T-... --actor <name>` on the **CLI only**. There is no MCP
tool and no SDK method for it: an agent that could set it would be signing off its
own work through the machinery it uses to do the work. The assignee is refused
even on the CLI (`self-confirmation-refused`), a second person cannot overwrite the
first (`confirmed-by-someone-else`), and repeating the same person's confirmation
is idempotent (`already: true`).

Every call returns `{ ok, task?, reason? }`. `reason` values are part of the
contract: `bad-state`, `state-changed`, `not-assignee`, `lease-expired`,
`evidence-required`, `self-verification-refused`, `attempts-exhausted`,
`dependency-open`, `self-confirmation-refused`, `confirmed-by-someone-else`.

The handle decides **where** and **who**: `owner`, `actor` and `project` are bound
from the configuration this handle was opened with and are not accepted as
per-call options, the same rule the rest of the SDK already keeps for `owner`.
`allowSelfVerify` is a module-level option for tests, not something a handle
exposes.

### Handoff, backup and operations

| Method | Notes |
| --- | --- |
| `handoff(opts)` / `verifyHandoff(pkg)` | Evidence-backed handoff package |
| `backup()`, `backups()`, `verifyBackups()` | Snapshot, list, integrity check |
| `restore(from, to, { force })` | Restores and proves the copy |
| `retention()` | What the policy would delete |
| `stats()` / `status()` | Partition-scoped counters |
| `graph()` / `graphHtml()` / `fold()` | Views and exports |
| `evolve()` / `mergeDuplicates()` / `gc()` | Administrative; refuse in named-owner mode |
| `close()` | Releases the database handle |

## Compatibility rules

1. **Additive by default.** New methods, new columns and new tables are expected
   between minor versions. Existing behaviour does not change silently.
2. **Migrations are forward-only.** Version 9 rebuilt `acm_aliases` by dropping
   and recreating the table; the others are additive. Reverting a commit does not
   undo any of them, so restore a snapshot instead of only reverting the commit —
   see [INSTALL.md](INSTALL.md).
3. **Removal or renaming needs a major version** and a CHANGELOG entry that names
   the replacement.
4. **Owner and session are never per-call options.** A method that accepted one
   would be a bug, not an API.
5. **Errors are values where recovery is expected.** Deletion, verification and
   decision calls return `{ ok, reason }` rather than throwing; unexpected states
   throw.

## What is explicitly not stable

- The DSH adapter's host contract: configuration precedence, `apply()` lifecycle
  and route registration are implemented against an unverified host.
- The HTTP endpoints' shape. They are opt-in and protected, but the JSON is not a
  promise yet.
- The MCP resource payloads beyond the documented resources.
- Anything under `lib/vendor/`: those are third-party artifacts, recorded in
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Verifying the surface

`api-surface.json` records the SDK members and the module exports, and
`scripts/check-api.mjs` compares the live modules against it on every run:

- a **removed or renamed** export fails the build, because that is the breaking
  change a caller feels;
- an **addition** is reported and does not fail, since adding is compatible;
- `npm run api:update` rewrites the snapshot, and is the deliberate step a major
  release takes.

`test/hosts.mjs`, `test/smoke.mjs` and the per-area suites exercise these methods
directly, and CI runs them on Node 22 and 24. If a documented method has no test,
that is an omission to fix rather than a second class of API.
