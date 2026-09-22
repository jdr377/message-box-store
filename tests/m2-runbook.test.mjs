// M2.2b.4 runbook (mbs-8g5.3.2.2.4): package scripts and docs/RUNBOOK.md stay
// aligned with scripts/ops.mjs; config failures exit non-zero and stay redacted.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const runbook = readFileSync(new URL('../docs/RUNBOOK.md', import.meta.url), 'utf8')
const opsSource = readFileSync(new URL('../scripts/ops.mjs', import.meta.url), 'utf8')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'runbook-sentinel-password-qq42'
const HOSTILE = [
  PASSWORD,
  'mysql://db-user:db-password@secret-host/private-database',
  'SELECT ciphertext FROM history_records WHERE owner = identity-key',
  'x-bsv-auth-signature wallet-private-material',
].join(' | ')

function runOps(args, env = {}) {
  return spawnSync(process.execPath, ['scripts/ops.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
    windowsHide: true,
  })
}

test('M2.2b.4 package scripts expose start, migrate, and config:check via scripts/ops.mjs', () => {
  assert.equal(packageJson.scripts?.start, 'node scripts/ops.mjs start')
  assert.equal(packageJson.scripts?.migrate, 'node scripts/ops.mjs migrate')
  assert.equal(packageJson.scripts?.['config:check'], 'node scripts/ops.mjs check-config')
  assert.ok(existsSync(new URL('../scripts/ops.mjs', import.meta.url)), 'ops entrypoint exists')
  for (const subcommand of ['start', 'migrate', 'check-config']) {
    assert.ok(opsSource.includes(`'${subcommand}'`) || opsSource.includes(`"${subcommand}"`), `ops.mjs handles ${subcommand}`)
  }
})

test('M2.2b.4 runbook documents the verified Bun commands that match package scripts', () => {
  for (const command of [
    'bun install --frozen-lockfile',
    'bun run build',
    'bun run config:check',
    'bun run migrate',
    'bun run start',
    'bun run typecheck',
    'bun run lint',
    'bun run test:pack',
    'bun run test',
    'bun run test:m0',
    'bun run test:m1',
  ]) {
    assert.ok(runbook.includes(command), `runbook includes ${command}`)
  }
  assert.ok(runbook.includes('/healthz'), 'runbook documents liveness')
  assert.ok(runbook.includes('/ready'), 'runbook documents readiness')
  assert.ok(runbook.includes('SIGTERM'), 'runbook documents graceful stop')
  assert.ok(runbook.includes('ERR_UNAVAILABLE'), 'runbook documents the admission/readiness failure')
  assert.ok(runbook.includes('ERR_RATE_LIMITED'), 'runbook documents the rate failure')
  assert.ok(runbook.includes('ERR_STORAGE_CONFIGURATION'), 'runbook documents the config failure')
  assert.ok(runbook.includes('permanent'), 'runbook states permanent-only retention')
  assert.ok(runbook.includes('private standalone topology'), 'runbook states the single topology')

  const scripted = [...runbook.matchAll(/bun run ([a-z0-9:]+)/g)].map((match) => match[1])
  assert.ok(scripted.length > 0, 'runbook references bun run scripts')
  for (const name of new Set(scripted)) {
    assert.ok(packageJson.scripts?.[name], `runbook script ${name} exists in package.json`)
  }
})

test('M2.2b.4 ops.mjs rejects unknown commands and redacts invalid configuration', () => {
  const unknown = runOps(['nope'])
  assert.notEqual(unknown.status, 0, 'unknown command fails')
  const unknownOut = `${unknown.stdout ?? ''}${unknown.stderr ?? ''}`
  assert.ok(unknownOut.includes('ERR_INVALID_RECORD'), 'unknown command is typed')
  assert.ok(!unknownOut.includes(PASSWORD), 'unknown command never prints secrets')

  const badSecret = runOps(['check-config'], {
    MESSAGE_BOX_STORE_SERVER_SECRET: 'short',
    MYSQL_USER: 'mbs_test',
    MYSQL_PASSWORD: PASSWORD,
    MYSQL_DATABASE: 'message_box_store_test',
  })
  assert.notEqual(badSecret.status, 0, 'invalid configuration fails')
  const badOut = `${badSecret.stdout ?? ''}${badSecret.stderr ?? ''}`
  assert.ok(badOut.includes('ERR_STORAGE_CONFIGURATION') || badOut.includes('serverSecret'), 'config failure is typed')
  assert.ok(!badOut.includes(PASSWORD), 'config failure never echoes the password')
  assert.ok(!badOut.includes(SECRET), 'config failure never echoes a secret')

  const missingMysql = runOps(['check-config'], {
    MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
    MYSQL_USER: '',
    MYSQL_PASSWORD: '',
    MYSQL_DATABASE: '',
  })
  assert.notEqual(missingMysql.status, 0, 'missing mysql configuration fails')
  const missingOut = `${missingMysql.stdout ?? ''}${missingMysql.stderr ?? ''}`
  assert.ok(missingOut.includes('ERR_MYSQL_CONFIG') || missingOut.includes('MySQL'), 'mysql failure is typed')
  assert.ok(!missingOut.includes(SECRET), 'mysql failure never echoes the secret')
})

test('M2.2b.4 check-config succeeds on valid env with a redacted summary only', () => {
  const valid = runOps(['check-config'], {
    MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
    MYSQL_USER: 'mbs_test',
    MYSQL_PASSWORD: PASSWORD,
    MYSQL_DATABASE: 'message_box_store_test',
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
  })
  assert.equal(valid.status, 0, `valid config exits 0: ${valid.stderr ?? ''}`)
  const lines = (valid.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
  assert.ok(lines.length >= 1, 'prints a status line')
  const parsed = JSON.parse(lines[lines.length - 1])
  assert.equal(parsed.status, 'ok')
  assert.equal(parsed.retention, 'permanent')
  assert.equal(typeof parsed.maxConcurrentRequests, 'number')
  assert.equal(typeof parsed.pool, 'object')
  const text = valid.stdout
  assert.ok(!text.includes(PASSWORD), 'summary never prints the password')
  assert.ok(!text.includes(SECRET), 'summary never prints the server secret')
  assert.ok(!text.includes('message_box_store_test'), 'summary never prints the database name')
})

test('M2.2b.4.1 migrate and startup failure formatting never serializes hostile errors', async () => {
  const { formatOperationalFailure } = await import('../scripts/ops.mjs')
  const cases = [
    Object.assign(new Error(HOSTILE), { code: 'ERR_MIGRATION_STRUCTURE' }),
    Object.assign(new Error(HOSTILE), { code: 'ERR_MIGRATION_CHECKSUM' }),
    Object.assign(new Error(HOSTILE), { code: 'ERR_UNAVAILABLE' }),
    Object.assign(new Error(HOSTILE), { code: 'ERR_ATTACKER_CONTROLLED' }),
    new Error(HOSTILE),
    { code: 'ERR_MIGRATION_STRUCTURE', message: HOSTILE },
  ]
  for (const error of cases) {
    const fatal = formatOperationalFailure(error)
    const startup = {
      status: 'error', level: 'warn', event: 'startup',
      fields: { ready: false, ...formatOperationalFailure(error) },
    }
    for (const [label, value] of [['migrate', fatal], ['startup', startup]]) {
      const text = JSON.stringify(value)
      assert.doesNotMatch(text, /db-user|db-password|secret-host|private-database|SELECT|ciphertext|identity-key|auth-signature|wallet-private|runbook-sentinel/iu, `${label} redacts external text`)
      assert.match(value.code ?? value.fields.code, /^ERR_[A-Z0-9_]+$/u)
      assert.equal(typeof (value.description ?? value.fields.description), 'string')
    }
  }
})
