# Known limits

This file is the honest list of what ACM Memory does **not** do. It is written for
someone about to put their own notes into it, and it is deliberately blunt: every
item below is a property of the current code, not a bug we are about to fix.

## Retrieval

- Recall is **similarity-based**. A query that shares vocabulary with an unrelated
  fact can surface that fact, and the injected text has a fixed budget, so an
  unhelpful result can crowd out a useful one. There is no absolute relevance
  threshold you can tune; the ranking is relative.
- Extraction from conversation is **best effort**. The store remembers what it is
  told to remember, and what a model chose to write. It does not guarantee that the
  right sentence was extracted from a long conversation.
- Nothing here is a search engine over your files. It searches what was written to
  the store.

## Deletion

- `acm forget` is **soft invalidation**: the row stops being returned, but the text
  can remain in the SQLite file's free pages, in `-wal` segments, in backups already
  written, and in anything you exported (handoff JSON, folded markdown).
- `acm purge` is the operator-only hard delete of rows. It still does not rewrite
  every page, and it does not reach backups or exports.
- If you need "this text is gone from this machine", delete the database file and
  every backup beside it. That is the only operation with that meaning today.

## Identity and isolation

- There is **no authentication and no read permission model**. `ACM_AGENT`,
  `ACM_OWNER` and `acm task --actor` are labels, not credentials: any process that
  can read the database file can read every fact in it.
- One store is one trust boundary: one person, one machine. Do not share a store
  between people, do not put it on a network share, and do not enable the optional
  HTTP surface on a network you do not control (it is off by default).
- A task's `confirmed` state is a record of what a person typed, not a
  cryptographic proof that a person approved anything.

## Durability

- The database is a single SQLite file. Corrupt it (or lose the disk) and the
  memories are gone unless you have a backup. Take one; `acm backup` verifies what
  it writes.
- Two processes writing the same store at once is not a supported pattern. SQLite
  will serialise most of it, and the second writer can fail with a `busy` error
  rather than retrying indefinitely.
- A schema upgrade writes a verified snapshot beside the database first, and
  **refuses to migrate** if it cannot. If you see that refusal, your store is not
  half-migrated - but you need disk space or a writable directory to proceed.

## Host integration

- The **DSH host plugin is experimental**: it is covered by scripted host tests, not
  by a long live session. The supported surfaces are the CLI (`acm`) and the MCP
  server (`acm-mcp`).
- The optional HTTP routes are an integration point, not a service. They are off
  unless configured, and they are not hardened for untrusted clients.

## Collaboration features

- Mailbox (send/inbox/claim/complete) and tasks (create/assign/accept/return/verify)
  are present in the build and **out of scope** for a single-user memory install.
  They exist to support an agent-to-agent workflow that is not finished.
- Nothing schedules work. A task is a record, not a queue.

## What has never been tested

- Windows 11 with Node 22 is where this build was exercised; Linux and macOS are
  covered by the project's test suite but not by a release run on every commit.
- No real model has been used to grade retrieval quality. There is no published
  accuracy number, and you should not assume one.
