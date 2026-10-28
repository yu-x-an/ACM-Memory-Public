# Installing and running ACM Memory

ACM Memory is a local-first memory, agent messaging and task-continuity layer.
Its JavaScript package has **no npm dependencies**: the core needs Node.js
and a writable directory. DSH is optional for the local CLI, MCP and SDK.

## Requirements

- Node.js **22 or newer** (`engines.node` in `package.json`). Node 24 is what CI
  exercises alongside 22.
- SQLite is used through the built-in `node:sqlite` module, so no native build
  step and no compiler toolchain are needed.
- Roughly 60 MB of disk for the repository, most of it the bundled embedding
  model (24 MB) and ONNX Runtime WASM (15 MB).

The repository is private. Install from a checkout:

```bash
git clone https://github.com/yu-x-an/ACM-Memory.git
cd ACM-Memory
node --version          # must be >= 22
node test/run.mjs       # optional smoke check
```

There is no build step. `lib/index.mjs` is the DSH plugin, `lib/sdk.mjs` the
library entry point, and the two binaries are `acm` (CLI) and `acm-mcp` (MCP
server over stdio).

## First run

The CLI creates the database and its backups directory on first use.

```bash
node lib/host/cli.mjs remember --text "the project ships on fridays" --key release.day --source "we agreed on fridays"
node lib/host/cli.mjs search fridays
node lib/host/cli.mjs status
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `ACM_DB` | database path, default `~/.dsh/acm-memory/memory.db` |
| `ACM_SESSION` | session id used by the CLI, default `cli` |
| `ACM_OWNER` | owner partition; a **trusted local configuration value**, not an identity supplied by a remote caller |
| `ACM_AGENT` | the MCP host's agent name, default `agent`. It decides which mailbox tasks this client may claim and close, so two MCP clients that should not share work need two values. It is a name, not a credential |

`ACM_OWNER` selects a partition, it does not authenticate anyone. Anyone who can
read the database file can read every partition; see
[SECURITY.md](../SECURITY.md).

## Configuration

The DSH adapter reads its configuration from the host context. Representative
options:

```js
{
  dbPath: '/path/to/memory.db',
  owner: null,                 // null = legacy single-user partition
  budget: 1400,                // context budget in characters
  recallLimit: 6,
  personaFiles: ['/path/to/AGENTS.md'],
  embed: { enabled: true, minCos: 0.25, weight: 0.5, inject: true },
  distill: { enabled: true, maxFacts: 5, minConfidence: 0.5, delayMs: 1200 },
  http: { enabled: false, token: null },
  adminTools: false,           // acm_gc / acm_evolve stay disabled
}
```

The HTTP routes are **off by default**. Enabling them requires
`http.enabled = true` and a bearer token of at least 16 characters; writes
additionally require `POST`. Bind the host to localhost or a trusted network.

## Installing into a DSH profile

The current package **does provide** `dsh.bundle.yml` and declares
`dsh.bundle` in `package.json`. The old instructions saying "plain
dependency" and adding a second manual `insert` are obsolete: using both
may double-register the plugin.

With DSH 0.2.1-rc.3, an isolated profile was used to exercise installation,
actual model tool calls, bilingual memory recall and a two-agent mailbox drill.
That is a documented host test, not a general compatibility guarantee.

```bash
dsh plugin --profile <profile> add <path-to-this-repository>
```

The bundle installs an `acm-memory` entry at boot. **Do not insert a second
`acm-memory` node manually.** Put the operator-specific settings (database
path, agent identity, optional HTTP configuration) on the existing profile
entry through the host's supported configuration/patch mechanism. Keep
`http.enabled: false` for local friend testing unless an HTTP test is
specifically required; do not store a real token in a tracked patch.

Before first use, inspect the composed profile with DSH's `--dump-config`
command and verify there is exactly one `acm-memory` entry and the expected
`dbPath`. Follow DSH's own profile documentation for the exact patch
operation required by the installed host version.

Two details matter when running more than one instance on a machine:

- `dbPath`, `diagPath` and the default `personaFiles` come from the user
  home, **not** from `DSH_HOME`. Testers should override `dbPath` to a
  disposable directory rather than touching their real memories.
- A profile without a web server (`headless`, `tui`) still gets memory
  tools; only the optional HTTP routes are skipped.

For tests that do not use DSH, use the [CLI and SDK examples](../README.md)
or the bundled MCP stdio endpoint, `node lib/host/mcp.mjs`.

## Backups and recovery

A snapshot is taken every six hours into `backups/` next to the database, and the
newest seven are kept.

```bash
node lib/host/cli.mjs backup                 # take one now
node lib/host/cli.mjs backups                # verify each snapshot
node lib/host/cli.mjs restore --from backups/memory-YYYYMMDD-HHMMSS.db --to /tmp/restored.db
```

`restore` verifies the staged copy first, keeps the previous file until the new
one is proven in place, and rolls back if either step fails. It refuses to
overwrite an existing database without `--force`, and it refuses outright when
the target has a non-empty `-wal` sibling, because that means a connection is
mid-flight.

**Stop the writer before restoring over a live database.** The `-wal` check
catches an in-flight connection, but an open handle with an empty log is
invisible to it. Closing DSH (or any process holding the file) first is the only
safe procedure; `allowLive` exists for a controlled recovery, not for routine
use.

## Upgrading

Pull, then run the tests. Schema migrations run automatically when the database
is opened and are additive; the current schema version is recorded in
`acm_schema_migrations` and reported by `acm status`.

**Rolling back code does not roll back the schema.** Most migrations are
additive (8, 10, 11 and 12 add columns or tables), but **version 9 rebuilt
`acm_aliases`** by dropping and recreating it, and that cannot be undone by
reverting the commit. Before upgrading across a version line:

1. `acm backup` and confirm it with `acm backups`.
2. Keep the snapshot until the new version has been exercised.

If a rollback is required, restore the pre-upgrade snapshot with `acm restore`
rather than only reverting the code.

## Packaging

`npm pack --dry-run --json` is what the published artifact would be, and
`npm run test:package` asserts it: the two entry points, both vendored binaries
and both license texts must be included, while tests, CI files and scripts must
not be. The unpacked size is expected around 38 MB; a large deviation means an
asset went missing or something unreviewed was swept in.

There is no publish step in this repository while it stays private.

## Running the test suite

```bash
npm run test:all          # language policy, doc links, third-party audit, all suites
npm run test:security     # owner/persona/checkpoint isolation
npm run test:migration    # schema upgrade paths
npm run test:restore      # full recovery drill
```

CI runs the same command on Node 22 and 24 from a clean checkout, so a green
local run and a green CI run use the same entry point.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot find module 'node:sqlite'` | Node is older than 22, or the runtime was built without SQLite. |
| `fatal: unable to access ... port 443` during install | The clone needs network access; if a system proxy is required, configure git separately from the system proxy setting. |
| `embed: model not found` in logs | The vendored model is missing; verify with `npm run test:third-party`. Retrieval falls back to lexical search. |
| `restore` returns `target-exists` | Pass `--force` only when the target really should be replaced. |
| `restore` returns `restored-copy-unusable` | The snapshot is corrupt; pick another one from `acm backups`. |

## What is not covered here

Real DSH headless model turns and a two-agent mailbox handoff have been
observed on DSH 0.2.1-rc.3. A process-level compaction/restart/crash drill and one
two-provider round trip (cloud model to local model, over MCP) have been run;
`scripts/agent-drill.mjs` re-runs the second one against any OpenAI-compatible
endpoint. A TLS reverse proxy, untrusted remote principals, long-running real
compaction and multi-process concurrency remain unverified. See
[LIMITS.md](LIMITS.md) for the current testing boundary.
