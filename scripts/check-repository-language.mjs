/**
 * Enforce the English-only policy for the maintained repository tree.
 * Multilingual functionality is preserved through Unicode-escaped fixtures
 * and a losslessly base64-encoded tokenizer resource.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['.git', 'node_modules', '.tmp', '.tmp-gaps', '.tmp-distill'])
const eligible = /\.(?:md|mjs|js|json|txt|yaml|yml)$/i
const chinese = /[\u3400-\u9fff\uf900-\ufaff]/u
const retired = new RegExp('agent' + '[\\s_-]*' + 'soul', 'i')
// A doubled backslash before 'u' means the runtime string holds a literal
// escape sequence instead of the character. That silently turned a whole test
// corpus into 'u9879' gibberish once; the needle is assembled so this file does
// not trip its own check.
const doubleEscape = '\\\\' + 'u'
const problems = []

function visit(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(item.name)) continue
    const path = join(dir, item.name)
    const name = relative(root, path)
    if (chinese.test(name) || retired.test(name)) problems.push(name + ': filename')
    if (item.isDirectory()) visit(path)
    else if (item.isFile() && eligible.test(item.name)) {
      const content = readFileSync(path, 'utf8')
      if (chinese.test(content)) problems.push(name + ': CJK text')
      if (retired.test(content)) problems.push(name + ': retired branding')
      if (content.includes(doubleEscape)) problems.push(name + ': doubled unicode escape (runtime string keeps a backslash)')
    }
  }
}
visit(root)
if (problems.length) {
  console.error('Maintained-tree language policy failed:\n' + problems.join('\n'))
  process.exitCode = 1
} else {
  console.log('Maintained-tree language policy passed.')
}
