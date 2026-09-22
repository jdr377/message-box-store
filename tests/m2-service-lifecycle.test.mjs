import assert from 'node:assert/strict'
import { test } from 'node:test'

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'

function baseConfig(overrides = {}) {
  return {
    serverSecret: SECRET,
    mysql: { host: '127.0.0.1', port: 3306, user: 'mbs_test', password: PASSWORD, database: 'message_box_store_test' },
    retention: 'permanent',
    ...overrides,
  }
}

function fakeKnex() {
  return {
    raw: async () => [[{ ok: 1 }]],
    destroy: async () => {},
  }
}

function fakeStore() {
  return {
    archiveBatch: async () => ({ epoch: 'gen-1', committed: true, outcomes: [] }),
    getUsage: async () => ({ recordCount: 0, byteCount: 0, epoch: 'gen-1', nextSequence: '1' }),
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options)
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body, headers: response.headers }
}

test('M2.1a service constructs, gates readiness on migrations, and disposes', async (t) => {
  const { createService } = await import('../dist/server.js')
  const service = await createService({
    config: baseConfig(),
    knex: fakeKnex(),
    store: fakeStore(),
    migrate: async () => ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'],
  })
  t.after(() => service.close())
  assert.equal(service.ownsKnex, false)
  assert.equal(service.checkReadiness().ready, false)

  const server = await service.start(0, '127.0.0.1')
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`

  // Liveness has no dependency checks.
  const live = await fetchJson(`${base}/healthz`)
  assert.equal(live.status, 200)
  assert.equal(live.body.status, 'ok')

  // Readiness is 503 until migrations are verified, with no connection details.
  const notReady = await fetchJson(`${base}/ready`)
  assert.equal(notReady.status, 503)
  assert.equal(notReady.body.code, 'ERR_UNAVAILABLE')
  assert.ok(!JSON.stringify(notReady.body).includes(PASSWORD))
  assert.ok(!JSON.stringify(notReady.body).includes('127.0.0.1'))

  const versions = await service.migrate()
  assert.deepEqual(versions, ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
  assert.equal(service.checkReadiness().ready, true)

  const ready = await fetchJson(`${base}/ready`)
  assert.equal(ready.status, 200)
  assert.equal(ready.body.status, 'ready')

  // M2.1c/d: mutation and retrieval routes sit behind auth;
  // unauthenticated callers get 401 before route resolution (no existence
  // oracle). Capability placeholder remains open 501 until .3.1.5.
  for (const [method, path] of [
    ['GET', '/v1/history/capabilities'],
  ]) {
    const result = await fetchJson(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })
    assert.equal(result.status, 501, `${method} ${path}`)
    assert.equal(result.body.code, 'ERR_UNAVAILABLE')
  }
  for (const [method, path] of [
    ['POST', '/v1/history/records'],
    ['PATCH', '/v1/history/records/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/state'],
    ['DELETE', '/v1/history/records/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['DELETE', '/v1/history/records'],
    ['GET', '/v1/history/records'],
    ['GET', '/v1/history/changes'],
    ['GET', '/v1/history/snapshot?snapshotId=snap_ab000000000000000000000000000000'],
    ['POST', '/v1/history/snapshot'],
    ['GET', '/v1/history/usage'],
  ]) {
    const result = await fetchJson(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })
    // Unsigned requests are rejected by the public auth middleware itself,
    // which carries its own stable code; the boundary still holds.
    assert.equal(result.status, 401, `${method} ${path} requires auth`)
  }

  // M2.1b: unknown protected paths reject unauthenticated callers with 401
  // before route resolution (no existence oracle). Authenticated 404 is
  // covered by the auth-context suite.
  const unknown = await fetchJson(`${base}/v1/history/nope`)
  assert.equal(unknown.status, 401)

  await service.stop()
  await service.close()
})

test('M2.1a invalid or missing configuration fails typed and redacted', async () => {
  const { validateServiceConfig, loadServiceConfigFromEnv } = await import('../dist/server.js')
  const cases = [
    [{}, 'missing object'],
    [{ serverSecret: 'short', mysql: { user: 'u', password: 'p', database: 'd' } }, 'short secret'],
    [{ serverSecret: SECRET }, 'missing mysql'],
    [{ serverSecret: SECRET, mysql: { user: 'u', password: '', database: 'd' } }, 'missing password'],
    [{ serverSecret: SECRET, mysql: { user: 'u', password: PASSWORD, database: 'd' }, retention: '6' }, 'retention below 7'],
    [{ serverSecret: SECRET, mysql: { user: 'u', password: PASSWORD, database: 'd' }, retention: 'sometimes' }, 'bad retention'],
  ]
  for (const [input, label] of cases) {
    await assert.rejects(async () => validateServiceConfig(input), (error) => {
      assert.ok(error instanceof Error, label)
      assert.ok(typeof error.code === 'string' && error.code.length > 0, `${label} typed`)
      const text = `${error.message} ${error.code}`
      assert.ok(!text.includes(SECRET), `${label} redacts secret`)
      assert.ok(!text.includes(PASSWORD), `${label} redacts password`)
      return true
    }, label)
  }

  // Env loader never echoes secrets either.
  const loaded = loadServiceConfigFromEnv({
    MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'mbs_test',
    MYSQL_PASSWORD: PASSWORD,
    MYSQL_DATABASE: 'message_box_store_test',
    MESSAGE_BOX_STORE_RETENTION_DAYS: 'permanent',
  })
  assert.equal(loaded.retention, 'permanent')
  assert.equal(loaded.mysql.host, '127.0.0.1')
  await assert.rejects(async () => loadServiceConfigFromEnv({}), /serverSecret|mysql/i)
})

test('M2.1a migration failure keeps readiness closed and redacted', async (t) => {
  const { createService } = await import('../dist/server.js')
  const service = await createService({
    config: baseConfig(),
    knex: fakeKnex(),
    store: fakeStore(),
    migrate: async () => {
      const error = new Error('migration history tampered')
      error.code = 'ERR_MIGRATION_CHECKSUM'
      throw error
    },
  })
  t.after(() => service.close())
  await assert.rejects(() => service.migrate(), /tampered/)
  assert.equal(service.checkReadiness().ready, false)

  const server = await service.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  const notReady = await fetchJson(`${base}/ready`)
  assert.equal(notReady.status, 503)
  assert.ok(!JSON.stringify(notReady.body).includes(PASSWORD))
})

test('M2.1a browser-safe entrypoints do not import the service graph', async () => {
  const { readFileSync } = await import('node:fs')
  for (const rel of ['mod.ts', 'src/protocol.ts', 'src/client.ts', 'src/canonical.ts']) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    assert.ok(!source.includes('service'), `${rel} must not import service`)
    assert.ok(!source.includes("from 'express"), `${rel} must not import express`)
  }
})
