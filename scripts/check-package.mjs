/**
 * Packaging guard.
 *
 * What `npm pack` emits is the artifact anyone else receives, so it is checked
 * rather than assumed: the binaries and the license texts must be in it, and
 * tests, CI files and scratch files must not.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

function pack() {
  // A fixed command string: npm is a .cmd shim on Windows, which Node refuses to
  // spawn as a file, and there is no caller input here to escape.
  const raw = execSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const parsed = JSON.parse(raw)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!entry || !Array.isArray(entry.files)) throw new Error('npm pack returned no file list')
  return entry
}

// The public mirror ships the same code but not the internal records, so the set of
// documents a package must contain depends on which profile is being packed. The
// profile is an explicit argument, not an environment variable, so it appears in the
// command that ran it and cannot be inherited by accident.
const profileArg = process.argv.find((a) => a.startsWith('--profile='))
const profile = profileArg ? profileArg.split('=')[1] : 'private'
if (!['private', 'public'].includes(profile)) throw new Error(`unknown --profile=${profile}`)

// The private profile's document list lives in a file the mirror does not ship, so
// this script never names a private document in published code. The public profile
// needs nothing from it; running `--profile=private` in the mirror fails with the
// reason instead of pretending the documents are optional.
const privateDocuments = () => {
  const p = join(root, 'docs', 'package-required.private.json')
  if (!existsSync(p)) {
    throw new Error('--profile=private needs docs/package-required.private.json, which exists only in the development repository')
  }
  const parsed = JSON.parse(readFileSync(p, 'utf8'))
  if (!Array.isArray(parsed.required) || !parsed.required.length) throw new Error('package-required.private.json has no required array')
  return parsed.required
}

const required = [
  'lib/index.mjs',
  'lib/sdk.mjs',
  'lib/host/cli.mjs',
  'lib/host/mcp.mjs',
  'lib/vendor/bge-small-zh/model_quantized.onnx',
  'lib/vendor/bge-small-zh/vocab.base64.txt',
  'lib/vendor/ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'lib/vendor/ort/LICENSE',
  'lib/vendor/bge-small-zh/LICENSE',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  ...(profile === 'private'
    ? privateDocuments()
    : ['docs/INSTALL.md', 'docs/API.md', 'docs/LIMITS.md']),
]

const forbidden = [
  /^test\//,
  /^\.github\//,
  /^scripts\//,
  /^docs\/reviews\//,
  /\.log$/,
  /^\.tmp/,
  /^tmp-/,
]

let entry
try {
  entry = pack()
} catch (err) {
  console.error(`Packaging check failed: could not run npm pack\n${err?.message ?? err}`)
  process.exitCode = 1
}

if (entry) {
  const files = entry.files.map((f) => f.path.replace(/\\/g, '/'))
  const problems = []

  for (const rel of required) {
    if (!files.includes(rel)) problems.push(`missing from the package: ${rel}`)
  }
  for (const path of files) {
    for (const pattern of forbidden) {
      if (pattern.test(path)) problems.push(`should not be packaged: ${path}`)
    }
  }

  // The vendored assets dominate the unpacked size; a jump means something new
  // and unreviewed got swept in, a drop means an asset is missing from the list.
  const MB = 1024 * 1024
  const unpacked = entry.unpackedSize ?? 0
  const tarball = entry.size ?? 0
  if (unpacked < 35 * MB) problems.push(`package looks incomplete: ${(unpacked / MB).toFixed(1)} MB unpacked (assets missing?)`)
  if (unpacked > 64 * MB) problems.push(`package is unexpectedly large: ${(unpacked / MB).toFixed(1)} MB unpacked`)
  if (tarball > 40 * MB) problems.push(`tarball is unexpectedly large: ${(tarball / MB).toFixed(1)} MB`)

  if (problems.length) {
    console.error(`Packaging check failed (${problems.length}):\n` + problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log(
      `Packaging check passed (${files.length} files, ${(tarball / MB).toFixed(1)} MB tarball, ${(unpacked / MB).toFixed(1)} MB unpacked).`,
    )
  }
}
