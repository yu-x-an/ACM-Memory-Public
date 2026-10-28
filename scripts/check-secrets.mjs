/**
 * Secret and local-data scan over the tracked files.
 *
 * "We never commit secrets" is a claim until something checks it. This walks the
 * committed file list (not the working tree) so untracked scratch files cannot
 * produce false alarms, and it fails on credential-shaped strings and on data
 * files that should never be committed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

const RULES = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'long-secret-assignment', re: /\b(?:api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*["'][A-Za-z0-9/+_-]{24,}["']/i },
]

// Files that must never be committed regardless of content.
const FORBIDDEN = [
  { id: 'sqlite-database', re: /\.(?:db|sqlite|sqlite3)$/i },
  { id: 'log-file', re: /\.log$/i },
  { id: 'env-file', re: /(?:^|\/)\.env(?:\.|$)/ },
  { id: 'key-material', re: /\.(?:pem|p12|pfx|key)$/i },
]

const BINARY_SKIP = [
  /^lib\/vendor\/.*\.(?:onnx|wasm)$/,
  /^lib\/vendor\/.*\.txt$/,
  /^lib\/vendor\/.*\.(?:js|mjs)$/,
]

/**
 * The file list.
 *
 * Normally the committed list, so untracked scratch files cannot produce false alarms.
 * But an exported tree can arrive without `.git` - an npm tarball, or a directory
 * copied out of the exporter before `git init` - and a scanner that throws there is a
 * scanner whose result is "not run", which must never be mistaken for "clean". In that
 * case it walks the directory instead and says so, so the evidence is about the bytes
 * that were actually shipped.
 */
function treeFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const abs = join(dir, name)
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) treeFiles(abs, acc)
    else if (st.isFile()) acc.push(relative(root, abs).split(sep).join('/'))
  }
  return acc
}

let files
let scannedFrom = 'git index'
try {
  files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
} catch {
  files = treeFiles(root)
  scannedFrom = 'directory tree (no git repository here)'
}

const problems = []

for (const rel of files) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(rel)) problems.push(`${rel}: ${rule.id}`)
  }
  if (BINARY_SKIP.some((re) => re.test(rel))) continue
  const abs = join(root, rel)
  if (!existsSync(abs)) continue
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    continue // binary files cannot be scanned as text
  }
  if (text.includes('\u0000')) continue
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    // Test fixtures for the redactor are real-shaped by design. The marker has to
    // be on the line or immediately above it, so it cannot silence a whole file.
    const allowed = lines[i].includes('secret-scan:allow') || (lines[i - 1] ?? '').includes('secret-scan:allow')
    if (allowed) continue
    for (const rule of RULES) {
      if (rule.re.test(lines[i])) problems.push(`${rel}:${i + 1}: ${rule.id}`)
    }
  }
}

if (problems.length) {
  console.error(`Secret scan failed (${problems.length}):\n` + problems.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Secret scan passed (${files.length} files, from ${scannedFrom}).`)
}
