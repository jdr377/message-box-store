// M2.2b.4 saturation (mbs-8g5.3.2.2.4): one representative bounded proof that
// configured admission, pre-auth rate, and pool bounds hold under concurrent
// load, that liveness and recovery remain available, and that responses/logs
// never leak secrets or ciphertext.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { LIMITS } = await import('../src/protocol.mjs')
const { createMemoryStore } = await import('../src/repository.mjs')

const {
  createService,
  createServiceApp,
  createFixedWindowRateLimiter,
} = await import('../dist/server.js')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-saturation'
const IDENTITY_A = `02${'cd'.repeat(32)}`
const CAPABILITIES_PATH = '/v1/history/capabilities'
const CIPHERTEXT_SENTINEL = 'SENTINEL_SATURATION_CIPHERTEXT_zz88'
const DRIVER_SENTINEL = 'ER_ACCESS_DENIED_ERROR sat@10.0.0.9'

function mysqlBase() {
  return { host: '127.0.0.1', port: 3306, user: 'mbs_test', password: PASSWORD, database: 'message_box_store_test' }
}

function baseConfig(overrides = {}) {
  return {
    serverSecret: SECRET,
    mysql: mysqlBase(),
    retention: 'permanent',
    ...overrides,
  }
}

function fakeKnex() {
  return { raw: async () => [[{ ok: 1 }]], destroy: async () => {} }
}

const SENTINELS = [SECRET, PASSWORD, CIPHERTEXT_SENTINEL, DRIVER_SENTINEL, IDENTITY_A, 'BEGIN', 'x-bsv-auth-signature', 'message_box_store_test', 'mbs_test']

function assertRedacted(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const sentinel of SENTINELS) {
    assert.ok(!text.includes(sentinel), `${label} must not leak ${sentinel.slice(0, 24)}`)
  }
}

function fakeClock(start = 1_000_000_000_000) {
  return { now: () => start, advance: (ms) => { start += ms } }
}

async function plainJson(url, options = {}) {
  const response = await fetch(url, options)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body, headers: response.headers }
}

let requestSeq = 0
function spyHeaders(extra = {}) {
  requestSeq += 1
  return {
    'content-type': 'application/json',
    'x-bsv-auth-signature': '00',
    'x-bsv-auth-request-id': `m22b4-${requestSeq}`,
    ...extra,
  }
}

async function waitFor(condition, label, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`${label} timed out after ${ms}ms`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function collector() {
  const records = []
  return {
    records,
    log(record) { records.push(record) },
    text() { return JSON.stringify(records) },
  }
}

test('M2.2b.4 representative saturation: admission and rate bounds hold, liveness survives, pool bounds are observable, recovery restores service, and nothing leaks', async (t) => {
  const clock = fakeClock()
  const ipRateLimiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now })
  const log = collector()
  const held = []
  const hold = { open: true }

  const { createServiceApp: createApp } = await import('../dist/server.js')
  const app = await createApp({
    checkReadiness: () => ({ ready: true, versions: ['001'] }),
    checkDatabase: async () => true,
    authMiddleware: (req, _res, next) => {
      req.auth = { identityKey: IDENTITY_A }
      if (hold.open) {
        held.push(next)
        return
      }
      next()
    },
    repository: createMemoryStore(),
    serverSecret: SECRET,
    maxConcurrentRequests: 2,
    ipRateLimiter,
    logger: log,
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  }))
  const base = `http://127.0.0.1:${server.address().port}`

  const admitted = [
    plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() }),
    plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() }),
  ]
  await waitFor(() => held.length === 2, 'both slots held at the admission bound')

  const excess = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(excess.status, 503, 'bound+1 fails typed at the admission bound')
  assert.equal(excess.body?.code, 'ERR_UNAVAILABLE')
  assertRedacted(excess.body, 'admission rejection')

  const health = await plainJson(`${base}/healthz`)
  assert.equal(health.status, 200, 'liveness bypasses admission under saturation')
  assert.equal(health.body?.status, 'ok')

  const saturatedReady = await plainJson(`${base}/ready`)
  assert.equal(saturatedReady.status, 503, 'saturated readiness fails typed without probing')
  assert.equal(saturatedReady.body?.code, 'ERR_UNAVAILABLE')
  assertRedacted(saturatedReady.body, 'saturated readiness')

  hold.open = false
  for (const next of held.splice(0)) next()
  const settled = await Promise.all(admitted)
  assert.deepEqual(settled.map((r) => r.status), [200, 200], 'held requests at the bound succeed after release')
  for (const result of settled) assertRedacted(result.body, 'held success')

  const denied = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(denied.status, 429, 'pre-auth rate bound denies the next request after the window budget is spent')
  assert.equal(denied.body?.code, 'ERR_RATE_LIMITED')
  assert.ok(Number.isSafeInteger(denied.body?.retryAfterSeconds) && denied.body.retryAfterSeconds >= 1)
  assertRedacted(denied.body, 'rate denial')

  const healthAfterRate = await plainJson(`${base}/healthz`)
  assert.equal(healthAfterRate.status, 200, 'liveness still bypasses the rate limiter')

  clock.advance(60_000)
  const recovered = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(recovered.status, 200, 'window expiry restores service after saturation')
  assertRedacted(recovered.body, 'recovery success')

  assert.ok(log.records.length >= 4, 'saturation produced structured request logs')
  for (const record of log.records) {
    assert.ok(['debug', 'info', 'warn', 'error'].includes(record.level), 'level is bounded')
    assert.ok(['startup', 'readiness', 'request', 'cleanup', 'shutdown'].includes(record.event), 'event is bounded')
    assertRedacted(record, `${record.event} log`)
  }
  assertRedacted(log.text(), 'saturation logs')

  const service = await createService({
    config: baseConfig({
      maxConcurrentRequests: 5,
      mysql: { ...mysqlBase(), pool: { min: 0, max: 4 } },
    }),
    knex: fakeKnex(),
    store: createMemoryStore(),
    migrate: async () => ['001-init'],
  })
  t.after(() => service.close())
  assert.equal(service.config.maxConcurrentRequests, 5, 'configured admission bound is observable')
  assert.deepEqual(service.config.mysql.pool, { min: 0, max: 4 }, 'configured pool bounds are observable')
  assert.equal(service.config.maxConcurrentRequests <= LIMITS.MAX_CONCURRENT_REQUESTS, true, 'bound stays within the canonical ceiling')
  assert.ok(service.config.mysql.pool.max <= LIMITS.DB_POOL_MAX, 'pool max stays within the canonical ceiling')
  assertRedacted(JSON.stringify({
    maxConcurrentRequests: service.config.maxConcurrentRequests,
    pool: service.config.mysql.pool,
  }), 'observable bounds')
})
