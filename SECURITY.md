# ACM Memory: Security and Trust Boundaries

**Current candidate:** v1.0.0-rc.2. ACM is appropriate for **trusted local
evaluation** within its documented limits, not for untrusted multi-tenant SaaS,
internet-exposed collaboration, or unattended high-stakes decisions.

## Trust model

- **Local SQLite is the authority.** Every process or person with direct
  filesystem access to the DB can bypass the SDK's owner checks. An `owner`
  label is a partition selector, **not authentication**.
- **Agent names are attribution, not credentials.** Mailbox senders, claimants
  and decision roles are not bound to cryptographically verified or host-issued
  principals. An MCP client can carry its own name (`ACM_AGENT`) so two clients
  are *distinguishable* rather than both being `"agent"` - that fixes an
  operational collision, not the trust model: anyone who can set an environment
  variable can claim any name. Do not expose a shared store to mutually untrusted
  agents.
- **MCP stdio/CLI/SDK are local adapters.** An MCP client must explicitly
  invoke tools or integrate prompt lifecycle; tools do not inject memory into
  every provider automatically.
- **HTTP is opt-in.** DSH routes require a bearer token (16+ characters),
  constant-time checking and POST for writes. This is not complete per-agent
  authentication, TLS, reverse-proxy hardening or revocable ACL sharing. Keep
  HTTP disabled unless you have done that work yourself.
- **Handoff integrity is not provenance authentication.** Package payload
  digests and live-store comparisons detect accidental or tampered mismatches
  relative to the current store. A plain SHA-256 digest alone is not an
  authenticated sender signature.

## Verified protections (limited scope)

The code and CI exercise owner-scoped memory reads/writes, SDK owner
immutability, personae and local approval rules, checkpoint ownership,
quarantine, handoff consistency, snapshot verification and recovery mocks.
Automated as well: a process-level compaction/restart/crash drill, injected
failures for the recovery receipt and the injected-block registration path, and
a secret scan over the shipped tree.

Recorded but not automated: DSH 0.2.1-rc.3 model-driven recall (English/Chinese),
a two-agent mailbox handoff, a bearer-protected HTTP status route, and one round
trip between a cloud-hosted model and a locally hosted model over MCP. Those are
observations with a commit and a run, not CI acceptance tests; see
[docs/LIMITS.md](docs/LIMITS.md) for what has and has not been observed.

## Reporting a vulnerability

Open a private security advisory on this repository (Security -> Report a
vulnerability). Please do not file a public issue for something exploitable.

## Scope of these claims

Security claims apply to the tested release and deployment scope only; they
should not be generalized to all host versions or all models. The unsupported
boundaries are listed in [docs/LIMITS.md](docs/LIMITS.md), which is the document
to read before trusting this with anything you cannot retype.
