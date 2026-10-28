# ACM Memory

Local-first memory for AI agents. One SQLite file on your disk; no account, no
network service, no telemetry.

**The npm package is not published yet.** `npm install -g dsh-acm-memory` is the
intended install once it is; today, run it from a checkout of this repository:

```bash
node lib/host/cli.mjs remember --text "the deploy window is 03:00 UTC" --key deploy.window
node lib/host/cli.mjs search deploy
node lib/host/cli.mjs inject   # the text a host would put in a system prompt
```

(If you prefer a global command, `npm link` in the checkout gives you `acm` and
`acm-mcp` with the same code.)

An MCP server ships in the same package, for hosts that speak MCP:

```bash
acm-mcp                    # stdio; tools: acm_remember, acm_search, acm_inject, ...
```

## What it actually does

- **Stores facts** in a SQLite database you can copy, back up and inspect. Default
  location: `~/.dsh/acm-memory/memory.db` (override with `ACM_DB`).
- **Recalls by meaning**, with a vendored Chinese/English embedding model
  (`bge-small-zh-v1.5`, ONNX) so it works offline. Keyword search is always on;
  embeddings can be disabled.
- **Keeps provenance**: every fact has a source, a revision and an event trail; a
  rewritten fact keeps both versions.
- **Survives interruption**: checkpoints, recovery receipts and a handoff format let
  a new session continue instead of starting from nothing.
- **Backs up and restores**, verifying the copy it writes.

Surfaces: a CLI (`acm`, 30+ verbs), an MCP server (`acm-mcp`), a Node SDK, and an
experimental DSH host plugin.

## What it does not do

Read [docs/LIMITS.md](docs/LIMITS.md) before trusting it with anything you cannot
retype. The short version:

- No authentication and no read permissions: any process that can read the file can
  read the memory. One store, one person, one machine.
- `forget` is soft invalidation, not physical erasure; `purge` is a row delete that
  still does not reach backups or exports.
- Recall is similarity-based and can surface an unrelated fact.
- Mailbox and task tools are in the build but out of scope for a memory install.

## Backup and privacy

`acm backup` writes a verified copy next to the database; `acm backups` lists them;
`acm restore` reads one back. Nothing is uploaded anywhere. Redaction of obvious
secrets before storage is best effort - do not rely on it.

## Install notes

Node.js 22 or newer. No runtime dependencies: the embedding runtime and model are
vendored, and their licences are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Installation detail, including
where data lives and how to uninstall, is in [docs/INSTALL.md](docs/INSTALL.md).

MIT licensed. Security reports: see [SECURITY.md](SECURITY.md).
