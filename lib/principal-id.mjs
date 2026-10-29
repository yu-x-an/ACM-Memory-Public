/**
 * The identity string a principal is stored under.
 *
 * It lived in `lib/auth.mjs` until the format had to be read a second time — by a
 * migration that repairs old rows. Keeping the writer and the reader in one file is
 * what stops them from disagreeing, and a disagreement here does not fail loudly:
 * it silently stops finding a principal's grants.
 *
 * Shape:
 *
 *   <kind>:<name length>:<name>:<owner part>
 *   owner part = `~`                      when there is no owner
 *              = <owner length>:<owner>   otherwise
 *
 *   agent:6:runner:~        no owner (the single-user partition)
 *   agent:6:runner:0:       owner is the empty string - a different partition
 *   agent:6:runner:4:team   owner is `team`
 *
 * Three things are deliberate.
 *
 * 1. The name is length-prefixed, so a name containing `:` cannot be re-read as a
 *    different (name, owner) pair.
 * 2. The owner is length-prefixed too, and `null` has its own marker. Without the
 *    marker, `owner = null` and `owner = ''` produced the same string, while every
 *    SQL predicate in this repository (`owner IS ?`) treats them as different
 *    partitions - so a collapse removed at the SQL layer came back at
 *    the key layer, which is where it decides whose grants apply.
 * 3. Old keys are read, never guessed at. There are two legacy shapes and a
 *    structural test separates them, because the same string can be both.
 */

export const ID_KINDS = ['user', 'agent', 'device']

const KIND_PATTERN = ID_KINDS.join('|')

const kindThenCount = new RegExp(`^(${KIND_PATTERN}):(\\d+):`)
const kindThenRest = new RegExp(`^(${KIND_PATTERN}):(.*)$`)

/** Length in code units, counted one way so the writer and the reader agree. */
const unitLength = (text) => String(text).length

/** Owner equality that keeps `null` and `''` apart, like `owner IS ?` does. */
export function sameOwner(a, b) {
  if (a == null || b == null) return a == null && b == null
  return String(a) === String(b)
}

export function principalId({ kind, id, owner }) {
  const name = String(id ?? '')
  if (!ID_KINDS.includes(kind)) throw new Error(`unknown principal kind: ${kind}`)
  if (!name) throw new Error('principal id required')
  const ownerPart = owner == null ? '~' : `${unitLength(owner)}:${String(owner)}`
  return `${kind}:${unitLength(name)}:${name}:${ownerPart}`
}

/**
 * Read the current format, or return `null`.
 *
 * Strictness is the point: a lenient reader would accept a legacy key and hand back
 * a different owner, which is the failure this file exists to prevent.
 */
export function parsePrincipalId(value) {
  const text = String(value)
  const head = kindThenCount.exec(text)
  if (!head) return null
  const kind = head[1]
  const nameLength = Number(head[2])
  let at = head[0].length
  if (!Number.isSafeInteger(nameLength) || nameLength <= 0) return null
  if (text.length < at + nameLength + 1) return null
  const name = text.slice(at, at + nameLength)
  at += nameLength
  if (text[at] !== ':') return null
  at += 1
  const ownerPart = text.slice(at)
  if (ownerPart === '~') return { kind, name, owner: null, format: 2 }
  const ownerHead = /^(\d+):/.exec(ownerPart)
  if (!ownerHead) return null
  const owner = ownerPart.slice(ownerHead[0].length)
  if (owner.length !== Number(ownerHead[1])) return null
  return { kind, name, owner, format: 2 }
}

/**
 * Read a v17 key: `<kind>:<name length>:<name>:<raw owner>`.
 *
 * `agent:3:foo` is ambiguous between this and a v1 `kind:name` key for an agent
 * called `3:foo`. The structural discriminator: a v17 key always has a separator
 * after the length-prefixed name, so `agent:3:foo` - nothing after `foo` - cannot
 * be v17. The reverse case, a v17 owner that happens to look like a length prefix
 * (`4:team`), is settled by comparing with the row's own `owner` column.
 */
export function parseV17PrincipalId(value, { ownerHint = undefined } = {}) {
  const text = String(value)
  const head = kindThenCount.exec(text)
  if (!head) return null
  const kind = head[1]
  const nameLength = Number(head[2])
  let at = head[0].length
  if (!Number.isSafeInteger(nameLength) || nameLength <= 0) return null
  if (text.length < at + nameLength + 1) return null
  const name = text.slice(at, at + nameLength)
  at += nameLength
  if (text[at] !== ':') return null
  const owner = text.slice(at + 1)
  if (ownerHint !== undefined && !sameOwner(owner, ownerHint)) return null
  return { kind, name, owner, format: 1 }
}

/** Read a v1 key: `<kind>:<name>`, with no owner in the key at all. */
export function parseV1PrincipalId(value, { ownerHint = undefined } = {}) {
  const bare = kindThenRest.exec(String(value))
  if (!bare) return null
  return { kind: bare[1], name: bare[2], owner: ownerHint === undefined ? null : ownerHint, format: 0 }
}

/**
 * The key this row should carry now, given what is stored and what the row says
 * about itself.
 *
 * This deliberately does **not** ask "does this string already look like a current
 * key?". A migration runs once, at a known version, so the input format is known by
 * construction - and guessing from the string is how a NULL-owner v17 key ended up
 * renamed `agent:9:6:runner::~`: the v17 reader refused the empty suffix against a
 * NULL owner, and the v1 reader then swallowed `6:runner:` as the *name*.
 *
 * So: read the name from the shape the migration expects (v17, with a v1 fallback
 * for rows the broken v17 skipped), and take the owner from the row's own `owner`
 * column, which is authoritative. The key's tail is never consulted for the owner.
 */
export function canonicalPrincipalId(stored, row = {}) {
  const v17 = parseV17PrincipalId(stored)
  const v1 = v17 ? null : parseV1PrincipalId(stored)
  const name = v17?.name ?? v1?.name
  if (!name) return null
  const kind = ID_KINDS.includes(row.kind) ? row.kind : (v17?.kind ?? v1?.kind ?? 'agent')
  return principalId({ kind, id: name, owner: row.owner ?? null })
}
