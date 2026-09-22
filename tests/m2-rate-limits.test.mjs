// M2.2a.3 rate (mbs-8g5.3.2.1.3): process-local fixed-window pre-auth IP and
// authenticated-identity limiters with bounded keys, deterministic expiry,
// typed redacted 429 ERR_RATE_LIMITED, forwarding headers ignored unless the
// single trusted-proxy setting matches the socket, per-identity isolation, and
// the documented minimal safe allowance (one deletion plus its exact idempotent
// retry) at the configuration floor.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { createMemoryStore } = await import('../src/repository.mjs')
const { JSON_SCHEMAS, LIMITS } = await import('../src/protocol.mjs')
const Ajv2020 = (await import('ajv/dist/2020.js')).default
const { default: addFormats } = await import('ajv-formats')
const {
  createFixedWindowRateLimiter,
  parseTrustedProxy,
  validateServiceConfig,
  loadServiceConfigFromEnv,
  RATE_LIMIT_MIN_PER_WINDOW,
  SERVICE_CONFIG_CODE,
} = await import('../dist/server.js')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-password'
const OWNER_A = 'aa'.repeat(32)
const OWNER_B = 'bb'.repeat(32)
const IDENTITY_A = `02${'cd'.repeat(32)}`
const IDENTITY_B = `03${'ef'.repeat(32)}`
const CAPABILITIES_PATH = '/v1/history/capabilities'
const ALLOWED_ORIGIN = 'https://app.example.com'
const ARCHIVE_PATH = '/v1/history/records'
const CIPHERTEXT_SENTINEL = 'SENTINEL_RATE_LIMIT_CIPHERTEXT_qq77'

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

function compileStoreError() {
  const instance = new Ajv2020({ allErrors: true, strict: false })
  addFormats(instance)
  return instance.compile(JSON_SCHEMAS.storeError)
}

function assertRedacted(value, label) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, PASSWORD, OWNER_A, OWNER_B, CIPHERTEXT_SENTINEL]) {
    assert.ok(!text.includes(secret), `${label} must not leak secrets or ciphertext`)
  }
}

async function plainJson(url, options = {}) {
  const response = await fetch(url, options)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

let requestSeq = 0
function spyHeaders(extra = {}) {
  requestSeq += 1
  return {
    'content-type': 'application/json',
    'x-bsv-auth-signature': '00',
    'x-bsv-auth-request-id': `m22a3-${requestSeq}`,
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

async function createIpHarness(t, { ipRateLimiter, trustedProxy, authMiddleware, ...state } = {}) {
  const { createServiceApp } = await import('../dist/server.js')
  const repository = createMemoryStore()
  const app = await createServiceApp({
    checkReadiness: () => ({ ready: true, versions: ['001'] }),
    checkDatabase: async () => true,
    authMiddleware: authMiddleware ?? ((req, _res, next) => { req.auth = { identityKey: IDENTITY_A }; next() }),
    repository,
    serverSecret: SECRET,
    allowedOrigins: [ALLOWED_ORIGIN],
    ...state,
    ...(ipRateLimiter ? { ipRateLimiter } : {}),
    ...(trustedProxy !== undefined ? { trustedProxy } : {}),
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  }))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, repository, app }
}

function fakeClock(start = 1_000_000_000_000) {
  return { now: () => start, advance: (ms) => { start += ms } }
}

// ---------------------------------------------------------------------------
// Factory unit tests (fake clock)
// ---------------------------------------------------------------------------

test('limiter admits exact limit, denies limit+1 with retryAfterSeconds, expires after window', () => {
  const clock = fakeClock()
  const limiter = createFixedWindowRateLimiter({ limit: 3, windowMs: 60_000, now: clock.now })
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(limiter.consume('ip'), { allowed: true })
  }
  const denied = limiter.consume('ip')
  assert.equal(denied.allowed, false)
  assert.ok(Number.isSafeInteger(denied.retryAfterSeconds) && denied.retryAfterSeconds >= 1)
  assert.equal(limiter.size(), 1)
  clock.advance(60_000)
  assert.deepEqual(limiter.consume('ip'), { allowed: true })
})

test('limiter keeps per-key buckets independent and bounds occupancy via overflow eviction', () => {
  const clock = fakeClock()
  const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: clock.now })
  assert.equal(limiter.consume('a').allowed, true)
  assert.equal(limiter.consume('b').allowed, true)
  assert.equal(limiter.consume('a').allowed, false)
  assert.equal(limiter.consume('c').allowed, true)
  assert.equal(limiter.size(), 2)
  assert.ok(limiter.keys().includes('c'))
  const text = JSON.stringify(limiter.keys())
  for (const secret of [SECRET, CIPHERTEXT_SENTINEL, 'signature', 'nonce']) {
    assert.ok(!text.includes(secret), 'keys() must not retain auth or ciphertext material')
  }
})

test('limiter denial does not mutate counters, and stale-window entries are swept on overflow', () => {
  const clock = fakeClock()
  const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 1, now: clock.now })
  assert.equal(limiter.consume('a').allowed, true)
  assert.equal(limiter.consume('a').allowed, false)
  assert.equal(limiter.consume('a').allowed, false, 'denied consume must not grant extra budget')
  clock.advance(60_000)
  assert.equal(limiter.consume('a').allowed, true, 'window expiry restores the allowance')
  assert.equal(limiter.size(), 1)
})

test('limiter rejects invalid options with typed constructor errors', () => {
  assert.throws(() => createFixedWindowRateLimiter({ limit: 0 }), TypeError)
  assert.throws(() => createFixedWindowRateLimiter({ limit: 1.5 }), TypeError)
  assert.throws(() => createFixedWindowRateLimiter({ limit: 1, windowMs: 0 }), TypeError)
  assert.throws(() => createFixedWindowRateLimiter({ limit: 1, maxKeys: 0 }), TypeError)
})

// ---------------------------------------------------------------------------
// Configuration: defaults, floor, env, trusted proxy
// ---------------------------------------------------------------------------

test('validateServiceConfig applies M1 rate defaults and accepts the floor of 2', () => {
  const defaults = validateServiceConfig(baseConfig())
  assert.equal(defaults.preAuthRatePerMinPerIp, LIMITS.PRE_AUTH_RATE_PER_MIN_PER_IP)
  assert.equal(defaults.authRatePerMinPerIdentity, LIMITS.AUTH_RATE_PER_MIN_PER_IDENTITY)
  assert.equal(defaults.trustedProxy, '')
  const floored = validateServiceConfig(baseConfig({
    preAuthRatePerMinPerIp: RATE_LIMIT_MIN_PER_WINDOW,
    authRatePerMinPerIdentity: RATE_LIMIT_MIN_PER_WINDOW,
    trustedProxy: '127.0.0.1',
  }))
  assert.equal(floored.preAuthRatePerMinPerIp, 2)
  assert.equal(floored.authRatePerMinPerIdentity, 2)
  assert.equal(floored.trustedProxy, '127.0.0.1')
})

test('validateServiceConfig rejects rates below the floor and invalid trusted proxies with typed config errors', () => {
  const rateCases = [
    ['preAuthRatePerMinPerIp', 1, 'preAuthRatePerMinPerIp must be an integer of at least 2'],
    ['preAuthRatePerMinPerIp', 0, 'preAuthRatePerMinPerIp must be an integer of at least 2'],
    ['authRatePerMinPerIdentity', 1, 'authRatePerMinPerIdentity must be an integer of at least 2'],
    ['authRatePerMinPerIdentity', 2.5, 'authRatePerMinPerIdentity must be an integer of at least 2'],
  ]
  for (const [field, value, message] of rateCases) {
    assert.throws(
      () => validateServiceConfig(baseConfig({ [field]: value })),
      (error) => error.code === SERVICE_CONFIG_CODE && error.message === message,
      `${field}=${value} must fail typed with the generic message`,
    )
  }
  for (const bad of [
    'not-an-ip',
    '::ffff:g',
    '999.1.1.1',
    ':::',
    '1::2::3',
    '12345::1',
    42,
  ]) {
    assert.throws(
      () => validateServiceConfig(baseConfig({ trustedProxy: bad })),
      (error) => error.code === SERVICE_CONFIG_CODE && !String(error.message).includes(String(bad)),
      `trustedProxy=${bad} must fail without echoing the input`,
    )
  }
})

test('parseTrustedProxy normalizes valid literals and rejects invalid ones without echoing', () => {
  assert.equal(parseTrustedProxy(undefined), '')
  assert.equal(parseTrustedProxy(''), '')
  assert.equal(parseTrustedProxy('127.0.0.1'), '127.0.0.1')
  assert.equal(parseTrustedProxy('001.002.003.004'), '1.2.3.4', 'leading-zero IPv4 canonicalizes')
  assert.equal(parseTrustedProxy('  ::FFFF:127.0.0.1 '), '127.0.0.1', 'IPv4-mapped literals unmapped to dotted-quad')
  assert.equal(parseTrustedProxy('0:0:0:0:0:ffff:192.0.2.5'), '192.0.2.5', 'expanded IPv4-mapped form unmapped')
  assert.equal(parseTrustedProxy('fe80::1'), 'fe80:0:0:0:0:0:0:1', 'compressed IPv6 expands to eight groups')
  assert.equal(parseTrustedProxy('FE80:0:0:0:0:0:0:1'), 'fe80:0:0:0:0:0:0:1', 'equivalent IPv6 spellings share one key')
  assert.equal(parseTrustedProxy('fe80::1%eth0'), 'fe80:0:0:0:0:0:0:1', 'zone suffix dropped before canonicalization')
  assert.equal(parseTrustedProxy('::1'), '0:0:0:0:0:0:0:1')
  assert.equal(parseTrustedProxy('::'), '0:0:0:0:0:0:0:0')
  for (const bad of [
    'example.com',
    '127.0.0.1/',
    '::ffff:999.0.0.1',
    '1.2.3',
    '256.0.0.1',
    ':::',
    '1::2::3',
    '12345::1',
    '1:::2',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::',
    ':1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7:',
    'g::1',
    '1.2.3.4::',
    7,
  ]) {
    assert.throws(
      () => parseTrustedProxy(bad),
      (error) => error.code === SERVICE_CONFIG_CODE && !String(error.message).includes(String(bad)),
      `trustedProxy=${bad} must fail without echoing the input`,
    )
  }
})

test('loadServiceConfigFromEnv reads rate and trusted-proxy variables, validating typed', () => {
  const envBase = {
    MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'mbs_test',
    MYSQL_PASSWORD: PASSWORD,
    MYSQL_DATABASE: 'message_box_store_test',
  }
  const config = loadServiceConfigFromEnv({
    ...envBase,
    MESSAGE_BOX_STORE_PRE_AUTH_RATE_PER_MIN_PER_IP: '5',
    MESSAGE_BOX_STORE_AUTH_RATE_PER_MIN_PER_IDENTITY: '7',
    MESSAGE_BOX_STORE_TRUSTED_PROXY: '127.0.0.1',
  })
  assert.equal(config.preAuthRatePerMinPerIp, 5)
  assert.equal(config.authRatePerMinPerIdentity, 7)
  assert.equal(config.trustedProxy, '127.0.0.1')
  assert.throws(
    () => loadServiceConfigFromEnv({
      ...envBase,
      MESSAGE_BOX_STORE_PRE_AUTH_RATE_PER_MIN_PER_IP: '1',
    }),
    (error) => error.code === SERVICE_CONFIG_CODE,
  )
})

// ---------------------------------------------------------------------------
// Pre-auth IP limiter integration
// ---------------------------------------------------------------------------

test('pre-auth: exact limit admits, limit+1 returns schema-valid redacted 429 before auth', async (t) => {
  const validate = compileStoreError()
  const clock = fakeClock()
  const ipRateLimiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now })
  let authCalls = 0
  const { base } = await createIpHarness(t, {
    ipRateLimiter,
    authMiddleware: (req, _res, next) => { authCalls += 1; req.auth = { identityKey: IDENTITY_A }; next() },
  })

  const ok1 = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  const ok2 = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(ok1.status, 200)
  assert.equal(ok2.status, 200)
  assert.equal(authCalls, 2)

  const denied = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(denied.status, 429)
  assert.equal(denied.body.status, 'error')
  assert.equal(denied.body.code, 'ERR_RATE_LIMITED')
  assert.equal(denied.body.description, 'rate limited')
  assert.ok(Number.isSafeInteger(denied.body.retryAfterSeconds) && denied.body.retryAfterSeconds >= 1)
  assert.ok(validate(denied.body), '429 body must satisfy the storeError schema')
  assertRedacted(denied.body, '429 body')
  assert.equal(authCalls, 2, 'rate denial must occur before authentication')

  const health = await plainJson(`${base}/healthz`)
  assert.equal(health.status, 200, 'public liveness must bypass the pre-auth limiter')

  clock.advance(60_000)
  const afterWindow = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(afterWindow.status, 200, 'window expiry restores the pre-auth allowance')
})

test('pre-auth: forwarding headers are ignored by default and only honored under the one trusted proxy', async (t) => {
  const spoofClock = fakeClock()
  const spoofLimiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, now: spoofClock.now })
  const spoof = await createIpHarness(t, { ipRateLimiter: spoofLimiter })
  const first = await plainJson(`${spoof.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '203.0.113.9',
      forward: 'for=203.0.113.9',
    }),
  })
  const second = await plainJson(`${spoof.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({
      'x-forwarded-for': '198.51.100.4',
      'x-real-ip': '198.51.100.4',
      forward: 'for=198.51.100.4',
    }),
  })
  assert.equal(first.status, 200)
  assert.equal(second.status, 429, 'spoofed client IPs must not create separate default buckets')
  assert.equal(spoofLimiter.size(), 1, 'default key is the socket address only')

  const trustedClock = fakeClock()
  const trustedLimiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, now: trustedClock.now })
  const trusted = await createIpHarness(t, { ipRateLimiter: trustedLimiter, trustedProxy: '127.0.0.1' })
  const trustedFirst = await plainJson(`${trusted.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({ 'x-forwarded-for': '203.0.113.9' }),
  })
  const trustedSecond = await plainJson(`${trusted.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({ 'x-forwarded-for': '203.0.113.9' }),
  })
  assert.equal(trustedFirst.status, 200)
  assert.equal(trustedSecond.status, 429, 'trusted proxy allows the rightmost XFF hop to key buckets')
  assert.deepEqual([...trustedLimiter.keys()], ['203.0.113.9'])

  const nonTrustedClock = fakeClock()
  const nonTrustedLimiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, now: nonTrustedClock.now })
  const nonTrusted = await createIpHarness(t, { ipRateLimiter: nonTrustedLimiter, trustedProxy: '10.0.0.1' })
  const n1 = await plainJson(`${nonTrusted.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({ 'x-forwarded-for': '203.0.113.9' }),
  })
  const n2 = await plainJson(`${nonTrusted.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({ 'x-forwarded-for': '198.51.100.4' }),
  })
  assert.equal(n1.status, 200)
  assert.equal(n2.status, 429, 'a non-matching trustedProxy must not consume separate forwarded keys')
  assert.notDeepEqual([...nonTrustedLimiter.keys()], ['203.0.113.9'])
  assert.equal(nonTrustedLimiter.size(), 1, 'only the socket key is recorded')

  const malformedClock = fakeClock()
  const malformedLimiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, now: malformedClock.now })
  const malformedProxy = await createIpHarness(t, { ipRateLimiter: malformedLimiter, trustedProxy: '127.0.0.1' })
  const badHop = await plainJson(`${malformedProxy.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({ 'x-forwarded-for': '1::2::3' }),
  })
  const socketHop = await plainJson(`${malformedProxy.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders(),
  })
  assert.equal(badHop.status, 200)
  assert.equal(socketHop.status, 429, 'a malformed rightmost hop must fall back to the socket bucket')
  assert.deepEqual([...malformedLimiter.keys()], ['127.0.0.1'], 'malformed XFF never becomes a bucket key')

  const equivalentClock = fakeClock()
  const equivalentLimiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, now: equivalentClock.now })
  const equivalentProxy = await createIpHarness(t, { ipRateLimiter: equivalentLimiter, trustedProxy: '::ffff:127.0.0.1' })
  const expandedHop = await plainJson(`${equivalentProxy.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({ 'x-forwarded-for': 'FE80:0:0:0:0:0:0:1' }),
  })
  const compressedHop = await plainJson(`${equivalentProxy.base}${CAPABILITIES_PATH}`, {
    headers: spyHeaders({ 'x-forwarded-for': 'fe80::1' }),
  })
  assert.equal(expandedHop.status, 200)
  assert.equal(compressedHop.status, 429, 'equivalent IPv6 spellings share one bucket')
  assert.deepEqual([...equivalentLimiter.keys()], ['fe80:0:0:0:0:0:0:1'])
})

// ---------------------------------------------------------------------------
// Authenticated identity limiter integration
// ---------------------------------------------------------------------------

test('identity: one owner cannot consume another owner allowance; keys hold no auth material', async (t) => {
  const validate = compileStoreError()
  const clock = fakeClock()
  const identityRateLimiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now })
  const readIdentities = []
  const authMiddleware = (req, _res, next) => {
    const header = req.headers['x-test-identity']
    const identityKey = header === 'b' ? IDENTITY_B : IDENTITY_A
    readIdentities.push(identityKey)
    req.auth = { identityKey, signature: `sig-${CIPHERTEXT_SENTINEL}`, requestId: 'req-123' }
    next()
  }
  const { base } = await createIpHarness(t, {
    identityRateLimiter,
    ipRateLimiter: createFixedWindowRateLimiter({ limit: 1000, windowMs: 60_000, now: clock.now }),
    authMiddleware,
  })
  const asA = () => ({ headers: spyHeaders({ 'x-test-identity': 'a' }) })
  const asB = () => ({ headers: spyHeaders({ 'x-test-identity': 'b' }) })

  assert.equal((await plainJson(`${base}${CAPABILITIES_PATH}`, asA())).status, 200)
  assert.equal((await plainJson(`${base}${CAPABILITIES_PATH}`, asA())).status, 200)
  const deniedA = await plainJson(`${base}${CAPABILITIES_PATH}`, asA())
  assert.equal(deniedA.status, 429)
  assert.equal(deniedA.body.code, 'ERR_RATE_LIMITED')
  assert.ok(validate(deniedA.body))
  assertRedacted(deniedA.body, 'identity 429 body')

  const allowedB = await plainJson(`${base}${CAPABILITIES_PATH}`, asB())
  assert.equal(allowedB.status, 200, 'owner B must retain its own allowance after owner A is limited')
  assert.ok(readIdentities.includes(IDENTITY_B))

  const keys = JSON.stringify(identityRateLimiter.keys())
  assert.deepEqual([...identityRateLimiter.keys()].sort(), [IDENTITY_A, IDENTITY_B].sort())
  for (const secret of [SECRET, PASSWORD, CIPHERTEXT_SENTINEL, 'sig-', 'req-123', 'signature']) {
    assert.ok(!keys.includes(secret), `identity limiter keys must not retain ${secret}`)
  }

  clock.advance(60_000)
  assert.equal((await plainJson(`${base}${CAPABILITIES_PATH}`, asA())).status, 200, 'identity window expiry restores A')
})

test('identity: the exact configuration floor admits one deletion plus its exact idempotent retry', async (t) => {
  const clock = fakeClock()
  const identityRateLimiter = createFixedWindowRateLimiter({
    limit: RATE_LIMIT_MIN_PER_WINDOW,
    windowMs: 60_000,
    now: clock.now,
  })
  const { base } = await createIpHarness(t, {
    identityRateLimiter,
    ipRateLimiter: createFixedWindowRateLimiter({ limit: 1000, windowMs: 60_000, now: clock.now }),
    maxConcurrentRequests: 8,
  })

  const deleteOnce = () => plainJson(`${base}${ARCHIVE_PATH}?idempotencyKey=m22a3-floor-k1`, {
    method: 'DELETE',
    headers: spyHeaders(),
  })
  const first = await deleteOnce()
  assert.equal(first.status, 200, `first deletion succeeds: ${first.status} ${JSON.stringify(first.body)}`)
  const retry = await deleteOnce()
  assert.equal(retry.status, 200, 'exact idempotent retry stays within the floor of 2')
  assert.equal(retry.body.epoch, first.body.epoch, 'exact retry replays the original epoch outcome')
  const third = await deleteOnce()
  assert.equal(third.status, 429, 'the request after the minimal safe allowance is denied')
  assert.equal(third.body.code, 'ERR_RATE_LIMITED')
  clock.advance(60_000)
})

// ---------------------------------------------------------------------------
// Representative saturation: 429 must release the admission slot
// ---------------------------------------------------------------------------

test('saturation: 429 releases its admission slot so held concurrency stays at the bound', async (t) => {
  const clock = fakeClock()
  const ipRateLimiter = createFixedWindowRateLimiter({ limit: 3, windowMs: 60_000, now: clock.now })
  const held = []
  const hold = { open: true }
  const { base } = await createIpHarness(t, {
    ipRateLimiter,
    maxConcurrentRequests: 2,
    authMiddleware: (req, _res, next) => {
      req.auth = { identityKey: IDENTITY_A }
      if (hold.open) {
        held.push(next)
        return
      }
      next()
    },
  })

  const first = plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  const second = plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  await waitFor(() => held.length === 2, 'both requests held at the exact bound')
  const excess = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(excess.status, 503, 'representative excess fails typed at the admission bound')
  assert.equal(excess.body.code, 'ERR_UNAVAILABLE')

  hold.open = false
  for (const next of held.splice(0)) next()
  const settled = await Promise.all([first, second])
  assert.deepEqual(settled.map((r) => r.status), [200, 200], 'held requests at the bound succeed after release')
  assert.equal(ipRateLimiter.size(), 1, 'held requests consumed two IP tokens before release')

  const third = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(third.status, 200, 'third admitted request consumes the last IP token')
  const fourth = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(fourth.status, 429, 'fourth is denied by the IP limiter')
  assert.equal(fourth.body.code, 'ERR_RATE_LIMITED')
  const fifth = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(fifth.status, 429, 'the 429 released its admission slot so the next request admits then denies')
  const sixth = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(sixth.status, 429, 'repeated 429s never leak slots into a 503 at the bound')

  clock.advance(60_000)
  const afterWindow = await plainJson(`${base}${CAPABILITIES_PATH}`, { headers: spyHeaders() })
  assert.equal(afterWindow.status, 200, 'window expiry restores allowance after 429 traffic')
})
