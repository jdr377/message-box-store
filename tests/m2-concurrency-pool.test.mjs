// M2.2a.2 admission and pool (mbs-8g5.3.2.1.2): a finite configured
// active-request bound enforced before any authentication, replay-window or
// repository work, with a slot released exactly once on response finish or
// connection close (success, typed failure, thrown error, client abort and
// connection close all covered); finite validated observable Knex/MySQL pool
// min/max; only public liveness bypasses admission — readiness sits behind
// it so saturation returns the redacted typed 503 without invoking
// checkDatabase (mbs-8g5.3.2.1.2.1), then follows its ordinary gates after
// a slot releases. Saturation still fails typed 503 ERR_UNAVAILABLE here;
// the typed 429 envelope is owned by m2-rate-limits.test.mjs
// (mbs-8g5.3.2.1.3).
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { LIMITS } = await import('../src/protocol.mjs')
const { createMemoryStore } = await import('../src/repository.mjs')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const OWNER_ID = `02${'cd'.repeat(32)}`
const CAPABILITIES_PATH = '/v1/history/capabilities'
const ALLOWED_ORIGIN = 'https://app.example.com'

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

function assertRedacted(value, label) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, PASSWORD, CLIENT_KEY, OTHER_KEY, OWNER_ID]) {
    assert.ok(!text.includes(secret), `${label} must not leak secret material`)
  }
  assert.ok(!text.includes('BEGIN'), `${label} must not echo key material`)
  assert.ok(!text.includes('x-bsv-auth-signature'), `${label} must not echo auth headers`)
}

async function waitFor(condition, label, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`${label} timed out after ${ms}ms`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

let requestSeq = 0
function spyHeaders(extra = {}) {
  requestSeq += 1
  return {
    'content-type': 'application/json',
    'x-bsv-auth-signature': '00',
    'x-bsv-auth-request-id': `m22a2-${requestSeq}`,
    ...extra,
  }
}

async function plainJson(url, options = {}) {
  const response = await fetch(url, options)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body, headers: response.headers }
}

async function listenApp(t, app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  }))
  return `http://127.0.0.1:${server.address().port}`
}

// createServiceApp with a counting repository proxy and an auth middleware
// that HOLDS admitted requests mid-flight (unless a custom middleware is
// supplied), so the active-request bound can be pinned deterministically:
// held requests occupy slots until releaseAll() continues them into the
// unsigned-route 401.
async function createAdmissionHarness(t, { maxConcurrentRequests, authMiddleware, allowedOrigins = [], checkReadiness, checkDatabase } = {}) {
  const { createServiceApp } = await import('../dist/server.js')
  const auth = { calls: 0, held: [], hold: true }
  const repoCalls = []
  const inner = createMemoryStore()
  const repository = new Proxy(inner, {
    get(target, prop) {
      const value = target[prop]
      if (typeof value === 'function') {
        return (...args) => {
          repoCalls.push(String(prop))
          return value.apply(target, args)
        }
      }
      return value
    },
  })
  const middleware = authMiddleware ?? ((req, _res, next) => {
    auth.calls += 1
    if (auth.hold) {
      auth.held.push(next)
      return
    }
    next()
  })
  const app = await createServiceApp({
    checkReadiness: checkReadiness ?? (() => ({ ready: false, versions: null })),
    ...(checkDatabase ? { checkDatabase } : {}),
    version: 'm2.2a.2-probe',
    authMiddleware: middleware,
    repository,
    serverSecret: SECRET,
    allowedOrigins,
    ...(maxConcurrentRequests !== undefined ? { maxConcurrentRequests } : {}),
  })
  const base = await listenApp(t, app)
  t.after(() => { auth.held.splice(0) })
  return {
    base,
    auth,
    repoCalls,
    releaseAll: () => {
      for (const next of auth.held.splice(0)) {
        try { next() } catch { /* held continuation of a dead request */ }
      }
    },
  }
}

test('M2.2a.2 exact active-request bound proceeds; bound+1 fails typed 503 before authentication or repository work', async (t) => {
  const h = await createAdmissionHarness(t, { maxConcurrentRequests: 2, allowedOrigins: [ALLOWED_ORIGIN] })
  const atBound = [
    plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() }),
    plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() }),
  ]
  await waitFor(() => h.auth.held.length === 2, 'both requests at the exact bound reach authentication')
  assert.equal(h.auth.calls, 2, 'requests at the exact bound are admitted')

  const rejected = await plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(rejected.status, 503)
  assert.equal(rejected.body?.status, 'error')
  assert.equal(rejected.body?.code, 'ERR_UNAVAILABLE')
  assert.equal(rejected.body?.description, 'service unavailable')
  assertRedacted(rejected.body, 'bound+1 rejection')
  assert.equal(h.auth.calls, 2, 'bound+1 never reaches authentication')
  assert.equal(h.repoCalls.length, 0, 'bound+1 never reaches the repository')

  // Earlier ingress gates still run before admission and consume no slot:
  // a disallowed Origin gets the CORS 403 even while the service is saturated.
  const cors = await plainJson(`${h.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({ Origin: 'https://evil.example.com' }),
  })
  assert.equal(cors.status, 403)
  assert.equal(cors.body?.code, 'ERR_FORBIDDEN')
  assert.equal(h.auth.calls, 2, 'CORS rejection consumes no admission slot')

  h.releaseAll()
  const results = await withTimeout(Promise.all(atBound), 5000, 'bound requests settle after release')
  assert.deepEqual(results.map((r) => r.status), [401, 401], 'both bound requests proceed behind authentication to the unsigned route 401')
  assert.equal(h.repoCalls.length, 0, 'route 401 at owner resolution never touches the repository')
})

test('M2.2a.2 default bound admits exactly LIMITS.MAX_CONCURRENT_REQUESTS and rejects the rest typed', async (t) => {
  const h = await createAdmissionHarness(t)
  const bound = LIMITS.MAX_CONCURRENT_REQUESTS
  const fired = Array.from({ length: bound + 1 }, () =>
    plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() }))
  await waitFor(() => h.auth.held.length === bound, `default bound ${bound} admits`)
  // Admitted requests are held at the auth middleware, so the only response
  // that can settle first is the bound+1 rejection.
  const rejection = await withTimeout(Promise.race(fired), 5000, 'bound+1 rejects while saturated')
  assert.equal(rejection.status, 503)
  assert.equal(rejection.body?.code, 'ERR_UNAVAILABLE')
  assert.equal(h.auth.calls, bound, 'only bound requests reach authentication')

  h.releaseAll()
  const settled = await withTimeout(Promise.all(fired), 5000, 'default-bound batch settles after release')
  assert.equal(settled.filter((r) => r.status === 503).length, 1, 'exactly one request beyond the default bound is rejected')
  const admitted = settled.filter((r) => r.status !== 503)
  assert.equal(admitted.length, bound, 'every request at the default bound was admitted')
  assert.ok(admitted.every((r) => r.status === 401), 'admitted requests settle at the unsigned route 401')
  assert.equal(h.repoCalls.length, 0)
})

test('M2.2a.2.1 only liveness bypasses admission; saturated /ready returns redacted 503 without checkDatabase, then recovers', async (t) => {
  const probe = { calls: 0 }
  const h = await createAdmissionHarness(t, {
    maxConcurrentRequests: 1,
    checkReadiness: () => ({ ready: true, versions: ['001'] }),
    checkDatabase: async () => {
      probe.calls += 1
      return true
    },
  })
  const heldRequest = plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  await waitFor(() => h.auth.held.length === 1, 'single slot occupied')

  const saturated = await plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(saturated.status, 503, 'service is saturated for application routes')

  // Only /healthz bypasses admission (mbs-8g5.3.2.1.2.1).
  const health = await plainJson(`${h.base}/healthz`)
  assert.equal(health.status, 200)
  assert.equal(health.body?.status, 'ok')

  // Saturated /ready never reaches its handler: no checkDatabase, no
  // checkReadiness, the stable redacted admission envelope.
  const saturatedReady = await plainJson(`${h.base}/ready`)
  assert.equal(saturatedReady.status, 503)
  assert.equal(saturatedReady.body?.status, 'error')
  assert.equal(saturatedReady.body?.code, 'ERR_UNAVAILABLE')
  assert.equal(saturatedReady.body?.description, 'service unavailable')
  assertRedacted(saturatedReady.body, 'saturated readiness')
  assert.equal(probe.calls, 0, 'saturation never invokes checkDatabase')

  // Capacity release restores ordinary readiness: migrations verified gate
  // passes (stubbed ready) and the database probe runs its normal path.
  h.releaseAll()
  assert.equal((await withTimeout(heldRequest, 5000, 'held request settles')).status, 401)
  const ready = await withTimeout(plainJson(`${h.base}/ready`), 5000, 'readiness after release')
  assert.equal(ready.status, 200, 'ordinary readiness follows after capacity is released')
  assert.equal(ready.body?.status, 'ready')
  assert.equal(probe.calls, 1, 'checkDatabase invoked exactly once after release')
})

test('M2.2a.2 a typed pre-route failure releases the admission slot', async (t) => {
  const h = await createAdmissionHarness(t, { maxConcurrentRequests: 1 })
  // Header-less request: admitted by the counter, then rejected by the
  // unsigned gate (before the auth middleware) with the typed 401 — the
  // response finish must release the slot.
  const unsigned = await plainJson(`${h.base}${CAPABILITIES_PATH}`)
  assert.equal(unsigned.status, 401)
  assert.equal(h.auth.calls, 0, 'unsigned gate rejects before the auth middleware')
  assert.equal(h.repoCalls.length, 0)

  const next = plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  await withTimeout(waitFor(() => h.auth.held.length === 1, 'slot released after typed failure'), 5000, 'typed-failure release')
  h.releaseAll()
  assert.equal((await withTimeout(next, 5000, 'request after typed failure')).status, 401)
})

test('M2.2a.2 a thrown middleware error releases the admission slot', async (t) => {
  let throwCalls = 0
  const h = await createAdmissionHarness(t, {
    maxConcurrentRequests: 1,
    authMiddleware: () => {
      throwCalls += 1
      throw new Error('probe boom')
    },
  })
  const first = await plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(first.status, 500, 'thrown error reaches the error boundary')
  assert.equal(first.body?.code, 'ERR_INTERNAL')
  assertRedacted(first.body, 'thrown error response')
  assert.equal(throwCalls, 1)

  // If the slot leaked, this would be rejected 503 without reaching auth.
  const second = await withTimeout(plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() }), 5000, 'request after thrown error')
  assert.equal(second.status, 500, 'slot released after the thrown error; next request reaches auth')
  assert.equal(throwCalls, 2)
  assert.equal(h.repoCalls.length, 0)
})

test('M2.2a.2 a client abort releases the admission slot', async (t) => {
  const h = await createAdmissionHarness(t, { maxConcurrentRequests: 1 })
  const controller = new AbortController()
  const aborted = fetch(`${h.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders(),
    signal: controller.signal,
  }).then(
    () => ({ aborted: false }),
    () => ({ aborted: true }),
  )
  await waitFor(() => h.auth.held.length === 1, 'aborted request admitted')
  controller.abort()
  assert.equal((await withTimeout(aborted, 5000, 'client abort observed')).aborted, true)
  // The held continuation belongs to a dead connection; drop it. The
  // connection close must have released the slot on the server.
  h.auth.hold = false
  h.auth.held.splice(0)

  // Rejected probes consume nothing; the first admitted probe proves release
  // and completes the 401 path (hold is now off), releasing again.
  let probe = null
  await withTimeout((async () => {
    for (;;) {
      probe = await plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
      if (probe.status !== 503) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })(), 5000, 'slot released after client abort')
  assert.equal(probe.status, 401, 'probe admitted after abort released the slot')
  assert.equal(probe.body?.code, 'ERR_AUTHENTICATION_REQUIRED')
  assert.equal(h.repoCalls.length, 0)
})

test('M2.2a.2 a successful authenticated response releases the admission slot', async (t) => {
  const customAuth = { calls: 0 }
  const h = await createAdmissionHarness(t, {
    maxConcurrentRequests: 1,
    authMiddleware: (req, _res, next) => {
      customAuth.calls += 1
      req.auth = { identityKey: OWNER_ID }
      next()
    },
  })
  const first = await withTimeout(plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() }), 5000, 'first capabilities')
  assert.equal(first.status, 200, 'authenticated success')
  assert.equal(first.body?.protocolVersion, '1')

  // If success leaked the slot, this would be rejected 503.
  const second = await withTimeout(plainJson(`${h.base}${CAPABILITIES_PATH}`, { headers: spyHeaders() }), 5000, 'second capabilities')
  assert.equal(second.status, 200, 'slot released after success; next request admits')
  assert.ok(h.repoCalls.includes('getUsage'), 'capabilities consults the repository')
  assert.equal(customAuth.calls, 2, 'both requests reach the auth middleware')
})

test('M2.2a.2 concurrency and pool configuration validate finitely, redacted, with accepted defaults', async () => {
  const { validateServiceConfig, loadServiceConfigFromEnv, SERVICE_CONFIG_CODE, SERVICE_MYSQL_CODE } = await import('../dist/server.js')

  const defaults = validateServiceConfig(baseConfig())
  assert.equal(defaults.maxConcurrentRequests, LIMITS.MAX_CONCURRENT_REQUESTS)
  assert.deepEqual(defaults.mysql.pool, { min: 0, max: LIMITS.DB_POOL_MAX })

  const configured = validateServiceConfig(baseConfig({
    maxConcurrentRequests: 3,
    mysql: { ...mysqlBase(), pool: { min: 1, max: 5 } },
  }))
  assert.equal(configured.maxConcurrentRequests, 3)
  assert.deepEqual(configured.mysql.pool, { min: 1, max: 5 })

  const coerced = validateServiceConfig(baseConfig({
    maxConcurrentRequests: '6',
    mysql: { ...mysqlBase(), pool: { min: '1', max: '9' } },
  }))
  assert.equal(coerced.maxConcurrentRequests, 6, 'env-style string bounds coerce')
  assert.deepEqual(coerced.mysql.pool, { min: 1, max: 9 })

  for (const bad of [0, -1, 1.5, NaN, Infinity, 'abc', true, {}, [], Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => validateServiceConfig(baseConfig({ maxConcurrentRequests: bad })), (error) => {
      assert.equal(error.code, SERVICE_CONFIG_CODE, `concurrency ${String(bad)} rejects typed`)
      assert.equal(error.message, 'maxConcurrentRequests must be a positive integer')
      assertRedacted({ message: error.message }, `concurrency ${String(bad)} rejection`)
      return true
    })
  }

  const poolCases = [
    { pool: { min: -1 }, message: 'mysql pool min must be a non-negative integer' },
    { pool: { max: 0 }, message: 'mysql pool max must be a positive integer' },
    { pool: { min: 1.5 }, message: 'mysql pool min must be a non-negative integer' },
    { pool: { max: 'abc' }, message: 'mysql pool max must be a positive integer' },
    { pool: { min: Infinity }, message: 'mysql pool min must be a non-negative integer' },
    { pool: { min: NaN, max: 7 }, message: 'mysql pool min must be a non-negative integer' },
    { pool: { min: 5, max: 2 }, message: 'mysql pool must be finite integers with 0 <= min <= max' },
    { pool: 'nope', message: 'mysql pool must be finite integers with 0 <= min <= max' },
    { pool: [], message: 'mysql pool must be finite integers with 0 <= min <= max' },
  ]
  for (const { pool, message } of poolCases) {
    assert.throws(() => validateServiceConfig(baseConfig({ mysql: { ...mysqlBase(), pool } })), (error) => {
      assert.equal(error.code, SERVICE_MYSQL_CODE, `pool ${JSON.stringify(pool)} rejects typed`)
      assert.equal(error.message, message)
      assertRedacted({ message: error.message }, `pool ${JSON.stringify(pool)} rejection`)
      return true
    })
  }

  const envBase = {
    MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
    MYSQL_USER: 'mbs_test',
    MYSQL_PASSWORD: PASSWORD,
    MYSQL_DATABASE: 'message_box_store_test',
  }
  const fromEnv = loadServiceConfigFromEnv({
    ...envBase,
    MESSAGE_BOX_STORE_MAX_CONCURRENT_REQUESTS: '6',
    MYSQL_POOL_MIN: '2',
    MYSQL_POOL_MAX: '9',
  })
  assert.equal(fromEnv.maxConcurrentRequests, 6)
  assert.deepEqual(fromEnv.mysql.pool, { min: 2, max: 9 })

  const envDefaults = loadServiceConfigFromEnv(envBase)
  assert.equal(envDefaults.maxConcurrentRequests, LIMITS.MAX_CONCURRENT_REQUESTS)
  assert.deepEqual(envDefaults.mysql.pool, { min: 0, max: LIMITS.DB_POOL_MAX })

  assert.throws(() => loadServiceConfigFromEnv({ ...envBase, MESSAGE_BOX_STORE_MAX_CONCURRENT_REQUESTS: 'nope' }), (error) => {
    assert.equal(error.code, SERVICE_CONFIG_CODE)
    return true
  })
  assert.throws(() => loadServiceConfigFromEnv({ ...envBase, MYSQL_POOL_MIN: '-1' }), (error) => {
    assert.equal(error.code, SERVICE_MYSQL_CODE)
    return true
  })
})

test('M2.2a.2 validated concurrency and pool bounds are observable on the composed service config', async (t) => {
  const { createService } = await import('../dist/server.js')
  const service = await createService({
    config: baseConfig({
      maxConcurrentRequests: 5,
      mysql: { ...mysqlBase(), pool: { min: 0, max: 3 } },
    }),
    store: createMemoryStore(),
    knex: fakeKnex(),
  })
  t.after(() => service.close())
  assert.equal(service.config.maxConcurrentRequests, 5, 'concurrency bound observable without secrets')
  assert.deepEqual(service.config.mysql.pool, { min: 0, max: 3 }, 'pool bounds observable without secrets')
  assertRedacted(JSON.stringify({ maxConcurrentRequests: service.config.maxConcurrentRequests, pool: service.config.mysql.pool }), 'observable config')
})

test('M2.2a.2 configured pool bounds reach the constructed Knex instance; M1 defaults preserved', async (t) => {
  const { createService } = await import('../dist/server.js')

  // Full default construction (no injected knex): config -> defaultCreateKnex
  // -> createMysqlKnex -> Knex pool options. min 0 keeps construction lazy,
  // so no connection is attempted in this offline test.
  const service = await createService({
    config: baseConfig({ mysql: { ...mysqlBase(), pool: { min: 0, max: 3 } } }),
  })
  t.after(() => service.close())
  assert.equal(service.ownsKnex, true)
  assert.equal(service.knex.client.config.pool.min, 0, 'configured pool min reaches knex config')
  assert.equal(service.knex.client.config.pool.max, 3, 'configured pool max reaches knex config')
  assert.equal(service.knex.client.pool.max, 3, 'live tarn pool adopts the configured ceiling')
  assert.equal(typeof service.knex.client.config.pool.afterCreate, 'function', 'UTC session hook preserved')

  const { createMysqlKnex } = await import('../src/repository.mysql.mjs')
  const defaulted = await createMysqlKnex({ user: 'mbs_test', password: PASSWORD, database: 'message_box_store_test' })
  t.after(() => defaulted.destroy())
  assert.equal(defaulted.client.config.pool.min, 0, 'M1 default pool min preserved when pool absent')
  assert.equal(defaulted.client.config.pool.max, LIMITS.DB_POOL_MAX, 'M1 default pool max preserved when pool absent')
  assert.equal(typeof defaulted.client.config.pool.afterCreate, 'function', 'M1 UTC session hook preserved by default')
})
