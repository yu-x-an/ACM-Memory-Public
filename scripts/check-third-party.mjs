/**
 * Third-party audit guard.
 *
 * Vendored binaries are easy to add and easy to forget: a new package without a
 * license declaration, or an asset swapped out from under a recorded hash, must
 * fail the build instead of shipping silently.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const noticesPath = join(root, 'THIRD_PARTY_NOTICES.md')
const problems = []

if (!existsSync(noticesPath)) {
  console.error('Third-party audit failed: THIRD_PARTY_NOTICES.md is missing')
  process.exitCode = 1
} else {
  const notices = readFileSync(noticesPath, 'utf8').toLowerCase()

  // 1. Every vendored npm package must declare a license and be recorded.
  const vendorRoot = join(root, 'lib', 'vendor')
  const packages = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.name === 'package.json') packages.push(abs)
    }
  }
  walk(vendorRoot)

  for (const file of packages) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      problems.push(`${relative(root, file)}: unreadable package.json`)
      continue
    }
    if (!manifest.name) continue // nested build manifests have no identity
    if (!manifest.license) {
      problems.push(`${manifest.name}: vendored package declares no license`)
      continue
    }
    if (!notices.includes(manifest.name.toLowerCase())) {
      problems.push(`${manifest.name}: missing from THIRD_PARTY_NOTICES.md`)
    }
  }

  // 2. Recorded hashes must match the assets on disk.
  const hashes = [
    ['lib/vendor/bge-small-zh/model_quantized.onnx'],
    ['lib/vendor/bge-small-zh/vocab.base64.txt'],
    ['lib/vendor/ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'],
  ]
  for (const [rel] of hashes) {
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      problems.push(`${rel}: missing, but its hash is recorded`)
      continue
    }
    // Hash the committed blob when available: a Windows checkout may have
    // rewritten line endings, which changes the bytes without changing the
    // artifact anyone else receives.
    let bytes = readFileSync(abs)
    try {
      bytes = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    } catch {}
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (!notices.includes(digest)) {
      problems.push(`${rel}: hash ${digest} is not recorded in THIRD_PARTY_NOTICES.md`)
    }
  }

  // 3. The license texts must actually be present, not just referenced.
  for (const rel of ['lib/vendor/ort/LICENSE', 'lib/vendor/bge-small-zh/LICENSE']) {
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      problems.push(`${rel}: license text is missing`)
      continue
    }
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('MIT License') || !text.includes('Permission is hereby granted')) {
      problems.push(`${rel}: does not contain the MIT text`)
    }
  }

  // 4. The model directory itself must be named in the notices.
  if (!notices.includes('bge-small-zh')) problems.push('the bundled model is not named in the notices')

  if (problems.length) {
    console.error(`Third-party audit failed (${problems.length}):\n` + problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`Third-party audit passed (${packages.length} vendored manifests, 3 recorded hashes).`)
  }
}
