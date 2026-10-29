// \u7ED9 test/load.mjs \u7528\u7684\u5E76\u53D1\u5199\u7EBF\u7A0B\uFF1A\u81EA\u5DF1\u5F00\u4E00\u4E2A\u8FDE\u63A5\uFF0C\u548C\u4E3B\u7EBF\u7A0B\u62A2\u7740\u5199\u3002
import { parentPort, workerData } from 'node:worker_threads'

import { openDb } from '../lib/db.mjs'
import { remember } from '../lib/memory.mjs'

const { dbPath, scope, count } = workerData
const db = openDb(dbPath)
let n = 0
for (let i = 0; i < count; i += 1) {
  remember(db, { scope, text: `worker writes ${i}`, kind: 'fact', source: { sessionId: scope, seq: i, raw: `\u5E76\u53D1 ${i}` } })
  n += 1
}
db.close()
parentPort?.postMessage({ written: n })
