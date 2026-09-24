import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const mode = process.argv[2] ?? 'all'
const prefix = mode === 'm1' ? 'm1-' : mode === 'm0' ? 'm0-' : ''
const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter((name) => name.endsWith('.test.mjs') && name.startsWith(prefix))
  .sort()
  .map((name) => `tests/${name}`)

// Release evidence must not depend on cross-file scheduling. Several suites
// intentionally exercise process-wide HTTP/auth resources; serialize files
// while preserving each file's own explicit concurrency.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, MESSAGE_BOX_STORE_MYSQL: '0' },
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
