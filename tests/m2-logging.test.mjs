// M2.2b.3 redacted operational logs (mbs-8g5.3.2.2.3): injectable ServiceLogger
// with bounded correlation ids covering startup/readiness, request outcome class,
// cleanup and shutdown. Logs never include bodies, keys, identities, auth/wallet
// material or connection values. Logging failure cannot fail requests or cleanup.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { ProtoWallet, PrivateKey, AuthFetch, SessionManager } = await import('@bsv/sdk')
const { createMemoryStore } = await import('../src/repository.mjs')
const {
  createService, createServiceApp, createConsoleServiceLogger, createNoopServiceLogger,
  CORRELATION_HEADER, CORRELATION_ID_RE,
} = await import('../dist/server.js')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const SERVER_KEY = '33'.repeat(32)
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const BODY_A = '{"encryptedMessage":"AQ=="}'
const BODY_SENTINEL = '{"encryptedMessage":"U0VOVElORUxfTVQyX0xPR0dJTkdfQ0lQSEVSVEVYVA=="}'
const DRIVER_SENTINEL = 'ER_ACCESS_DENIED_ERROR mbs_test@10.0.0.5'
const ARCHIVE_PATH = '/v1/history/records'
const USAGE_PATH = '/v1/history/usage'
const CORRELATION = 'x-mbs-correlation-id'

const baseConfig = (overrides = {}) => ({
  serverSecret: SECRET,
  mysql: { host: '127.0.0.1', port: 3306, user: 'mbs_test', password: PASSWORD, database: 'message_box_store_test' },
  retention: 'permanent',
  ...overrides,
})
const fakeKnex = () => ({ raw: async () => [[{ ok: 1 }]], destroy: async () => {} })
const walletFor = (hex) => new ProtoWallet(PrivateKey.fromHex(hex))
const identityOf = async (wallet) => (await wallet.getPublicKey({ identityKey: true })).publicKey
const outboundRecord = ({ messageId, owner, peer, body = BODY_A }) =>
  ({ messageId, messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body })

const SENTINELS = [SECRET, PASSWORD, SERVER_KEY, CLIENT_KEY, OTHER_KEY, BODY_A, BODY_SENTINEL, DRIVER_SENTINEL]

function collector() {
  const records = []
  return {
    records,
    log(r) { records.push(r) },
    of(e) { return records.filter((r) => r.event === e) },
    text() { return JSON.stringify(records) },
  }
}

function assertRedacted(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const s of SENTINELS) assert.ok(!text.includes(s), `${label} must not leak ${s.slice(0, 20)}`)
  assert.ok(!text.includes('x-bsv-auth-signature'), `${label} must not echo auth headers`)
  assert.ok(!text.includes('BEGIN'), `${label} must not echo key material`)
}

async function plainJson(url, options = {}) {
  const response = await fetch(url, options)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body, headers: response.headers }
}

async function authedJson(authFetch, url, config = {}) {
  const response = await authFetch.fetch(url, config)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body, headers: response.headers }
}

function assertRecordShape(record, label) {
  assert.ok(record && typeof record === 'object', `${label}: object`)
  assert.ok(typeof record.level === 'string', `${label}: level`)
  assert.ok(typeof record.event === 'string', `${label}: event`)
  assert.ok(record.fields && typeof record.fields === 'object', `${label}: fields`)
  for (const v of Object.values(record.fields)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof v), `${label}: primitive fields only`)
  }
}

async function createHarness(t, { logger, config = {} } = {}) {
  const serverWallet = walletFor(SERVER_KEY)
  const clientWallet = walletFor(CLIENT_KEY)
  const otherWallet = walletFor(OTHER_KEY)
  const service = await createService({
    config: baseConfig(config),
    knex: fakeKnex(),
    store: createMemoryStore(),
    migrate: async () => ['001-init'],
    auth: { wallet: serverWallet, sessionManager: new SessionManager() },
    logger,
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  return {
    service,
    base: `http://127.0.0.1:${server.address().port}`,
    clientId: await identityOf(clientWallet),
    otherId: await identityOf(otherWallet),
    authFetch: new AuthFetch(clientWallet),
  }
}

const archive = (h, records, epoch = 'gen-1') =>
  authedJson(h.authFetch, `${h.base}${ARCHIVE_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch, records }),
  })

test('M2.2b.3 correlation ids are generated, validated, bounded, not trusted', async (t) => {
  const log = collector()
  const h = await createHarness(t, { logger: log })

  const missing = await plainJson(`${h.base}/healthz`)
  assert.equal(missing.status, 200)
  const generated = missing.headers.get(CORRELATION)
  assert.ok(typeof generated === 'string' && generated.length > 0, 'response carries a correlation id')
  assert.match(generated, /^[0-9a-f]{16}$/, 'generated ids are 16 hex characters')

  const accepted = 'client-token_abc-123'
  assert.ok(CORRELATION_ID_RE.test(accepted))
  const echoed = await plainJson(`${h.base}/healthz`, { headers: { [CORRELATION]: accepted } })
  assert.equal(echoed.headers.get(CORRELATION), accepted, 'valid inbound id is echoed')

  const badIds = ['short', 'x'.repeat(33), 'has spaces here', 'path/../escape', 'a'.repeat(300), '', 'x'.repeat(8000)]
  for (const bad of badIds) {
    const res = await plainJson(`${h.base}/healthz`, { headers: { [CORRELATION]: bad } })
    const returned = res.headers.get(CORRELATION)
    assert.ok(typeof returned === 'string' && CORRELATION_ID_RE.test(returned), 'bad id replaced with bounded id')
    assert.notEqual(returned, bad, 'invalid input never echoed')
    assert.ok(returned.length <= 32, 'returned id is bounded')
  }

  await plainJson(`${h.base}/healthz`)
  const requests = log.of('request')
  assert.ok(requests.length >= badIds.length + 3, 'request events carry correlation ids')
  for (const r of requests) {
    assertRecordShape(r, 'request')
    assert.match(r.fields.correlationId, CORRELATION_ID_RE, 'logged correlation id matches pattern')
  }
  assertRedacted(log.text(), 'correlation logs')
})

test('M2.2b.3 all five events are structured and redacted', async (t) => {
  const log = collector()
  const h = await createHarness(t, { logger: log })

  const startups = log.of('startup')
  assert.equal(startups.length, 1, 'one startup event')
  assertRecordShape(startups[0], 'startup')
  assert.equal(startups[0].level, 'info')
  assert.equal(typeof startups[0].fields.port, 'number')
  assert.equal(typeof startups[0].fields.version, 'string')
  assert.equal(typeof startups[0].fields.drainTimeoutMs, 'number')
  assert.equal(typeof startups[0].fields.cleanupIntervalMs, 'number')

  const notReady = await plainJson(`${h.base}/ready`)
  assert.equal(notReady.status, 503)
  assert.equal(log.of('readiness').length, 1)
  assert.equal(log.of('readiness')[0].fields.ready, false)
  assert.equal(typeof log.of('readiness')[0].fields.durationMs, 'number')

  await h.service.migrate()
  const ready = await plainJson(`${h.base}/ready`)
  assert.equal(ready.status, 200)
  assert.equal(log.of('readiness')[1].fields.ready, true)
  assert.equal(log.of('readiness')[1].level, 'info')

  const ok = await archive(h, [outboundRecord({ messageId: 'm23-log-ok', owner: h.clientId, peer: h.otherId })])
  assert.equal(ok.status, 200)

  const denied = await archive(h, [outboundRecord({ messageId: 'm23-log-denied', owner: h.otherId, peer: h.clientId })])
  assert.ok(denied.status >= 400, 'denied archive still classified')

  await plainJson(`${h.base}${USAGE_PATH}`)
  await plainJson(`${h.base}/no/such/route`)
  await plainJson(`${h.base}/healthz`)
  const unknown404 = await authedJson(h.authFetch, `${h.base}/v1/history/nope`, { method: 'GET' })
  assert.equal(unknown404.status, 404, 'authenticated unknown route is 404')

  await h.service.cleanup.runNow()
  const cleanups = log.of('cleanup')
  assert.equal(cleanups.length, 1, 'one cleanup event per manual pass')
  assertRecordShape(cleanups[0], 'cleanup')
  assert.equal(cleanups[0].fields.ok, true)
  assert.equal(typeof cleanups[0].fields.durationMs, 'number')
  assert.equal(typeof cleanups[0].fields.purgedSnapshots, 'number')
  assert.equal(typeof cleanups[0].fields.purgedItems, 'number')
  assert.equal(typeof cleanups[0].fields.purgedChanges, 'number')
  assert.equal(typeof cleanups[0].fields.hasMore, 'boolean')

  const failingStore = createMemoryStore()
  failingStore.purgeExpiredSnapshots = () => { throw new Error(`purge boom ${DRIVER_SENTINEL}`) }
  const failing = await createService({
    config: baseConfig(),
    knex: fakeKnex(),
    store: failingStore,
    migrate: async () => ['001-init'],
    logger: log,
  })
  t.after(() => failing.close())
  await failing.start(0, '127.0.0.1')
  const failOutcome = await failing.cleanup.runNow()
  assert.equal(failOutcome && failOutcome.ok, false, 'failing cleanup reports failure')
  assert.equal(failOutcome.errorCode, 'ERR_UNAVAILABLE')
  const failed = log.of('cleanup').at(-1)
  assert.equal(failed.level, 'error')
  assert.equal(failed.fields.ok, false)
  assert.equal(failed.fields.errorCode, 'ERR_UNAVAILABLE')
  assertRedacted(failed, 'failed cleanup record')

  await h.service.stop()
  const shutdowns = log.of('shutdown')
  assert.equal(shutdowns.length, 1, 'one shutdown event on stop')
  assertRecordShape(shutdowns[0], 'shutdown')
  assert.equal(typeof shutdowns[0].fields.drained, 'boolean')
  assert.equal(typeof shutdowns[0].fields.durationMs, 'number')

  const requests = log.of('request')
  assert.ok(requests.length >= 5, 'request events cover success and failure paths')
  const successes = requests.filter((r) => r.fields.status === 200)
  assert.ok(successes.some((r) => r.fields.route === ARCHIVE_PATH && r.fields.method === 'POST'))
  assert.ok(successes.some((r) => r.fields.route === '/ready'))
  assert.ok(successes.some((r) => r.fields.route === '/healthz'))
  const failures = requests.filter((r) => r.fields.status >= 400)
  assert.ok(failures.length >= 3, 'typed failures are logged')
  const unknown = requests.find((r) => r.fields.status === 404)
  assert.ok(unknown, 'authenticated unknown routes are logged')
  assert.equal(unknown.fields.route, 'unknown', 'unmatched routes never leak concrete paths')
  assert.equal(unknown.level, 'warn')
  const unauth = requests.find((r) => r.fields.status === 401 && r.fields.route === 'unknown')
  assert.ok(unauth, 'pre-auth rejection is logged without a concrete path')

  for (const r of log.records) {
    assertRecordShape(r, r.event)
    assert.ok(Object.values(r.fields).every((v) => typeof v !== 'string' || v.length < 200), 'string fields bounded')
  }
  assertRedacted(log.text(), 'all log records')
  assert.ok(!log.text().includes(h.clientId), 'identity keys never appear')
})

test('M2.2b.3 request logs use route patterns, never concrete path/query/body', async (t) => {
  const log = collector()
  const h = await createHarness(t, { logger: log })
  await h.service.migrate()

  const ok = await archive(h, [outboundRecord({ messageId: 'm23-pattern-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
  assert.equal(ok.status, 200)
  const key = ok.body.outcomes[0].recordKey
  assert.match(key, /^[0-9a-f]{64}$/)

  const deleted = await authedJson(h.authFetch, `${h.base}${ARCHIVE_PATH}/${key}?idempotencyKey=m23-del`, { method: 'DELETE' })
  assert.equal(deleted.status, 200)

  const signedGet = await authedJson(h.authFetch, `${h.base}${USAGE_PATH}?surprise=${SECRET}`)
  assert.equal(signedGet.status, 400)

  await plainJson(`${h.base}${ARCHIVE_PATH}/${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bsv-auth-signature': 'deadbeef', 'x-bsv-auth-request-id': 'm23-replay' },
    body: '{}',
  })

  const requests = log.of('request')
  assert.ok(requests.length >= 4)

  const deleteLog = requests.find((r) => r.fields.method === 'DELETE' && r.fields.status === 200)
  assert.ok(deleteLog, 'delete success is logged')
  assert.equal(deleteLog.fields.route, '/v1/history/records/:recordKey', 'route is Express pattern')
  assert.ok(!deleteLog.fields.route.includes(key), 'route never embeds record key')

  for (const r of requests) {
    assert.ok(!('path' in r.fields) && !('url' in r.fields) && !('query' in r.fields) && !('body' in r.fields), 'no concrete path/url/query/body fields')
    assert.ok(!('identityKey' in r.fields), 'no identity fields')
    const text = JSON.stringify(r)
    assert.ok(!text.includes(key), 'record key never in request logs')
    assert.ok(!text.includes(SECRET), 'server secret never in logs')
    assert.ok(!text.includes(BODY_SENTINEL), 'ciphertext never in logs')
    assert.ok(!text.includes(h.clientId), 'identity never in logs')
  }

  const okLog = requests.find((r) => r.fields.method === 'POST' && r.fields.route === ARCHIVE_PATH && r.fields.status === 200)
  assert.ok(okLog, 'archive success logged with pattern route')
  assert.equal(typeof okLog.fields.durationMs, 'number')
  assert.ok(okLog.fields.durationMs >= 0)
  assert.match(okLog.fields.correlationId, CORRELATION_ID_RE)

  const queryFailure = requests.find((r) => r.fields.status === 400)
  assert.ok(queryFailure, 'typed 400 is logged')
  assert.match(queryFailure.fields.code, /^ERR_[A-Z0-9_]+$/, 'error code is typed')
  assert.ok(!queryFailure.fields.code.includes(SECRET))

  assertRedacted(log.text(), 'pattern-scoped request logs')
})

test('M2.2b.3 sentinel scan: forbidden material never logged', async (t) => {
  const log = collector()
  const h = await createHarness(t, { logger: log, config: { allowedOrigins: ['https://allowed.example'] } })
  await h.service.migrate()

  await archive(h, [outboundRecord({ messageId: 'm23-scan-ok', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
  await archive(h, [outboundRecord({ messageId: 'm23-scan-own', owner: h.otherId, peer: h.clientId })])
  await plainJson(`${h.base}${USAGE_PATH}`)
  await plainJson(`${h.base}${USAGE_PATH}`, { headers: { 'x-bsv-auth-signature': '00', 'x-bsv-auth-request-id': 'm23-bad' } })
  await plainJson(`${h.base}/ready`)
  await plainJson(`${h.base}/healthz`)
  await plainJson(`${h.base}/does/not/exist`)
  await plainJson(`${h.base}${ARCHIVE_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' })
  await plainJson(`${h.base}${USAGE_PATH}?unexpected=${encodeURIComponent(BODY_SENTINEL)}`)
  await h.service.cleanup.runNow()
  await h.service.stop()

  assert.ok(log.records.length >= 8, 'scan produced events across paths')
  const text = log.text()
  for (const s of [...SENTINELS, h.clientId, h.otherId, 'x-bsv-auth-signature', 'message_box_store_test', 'mbs_test']) {
    assert.ok(!text.includes(s), `logs must not contain ${s.slice(0, 24)}`)
  }
  for (const r of log.records) {
    assertRecordShape(r, r.event)
    assertRedacted(r, `${r.event} record`)
  }
  for (const level of new Set(log.records.map((r) => r.level))) {
    assert.ok(['debug', 'info', 'warn', 'error'].includes(level), `level ${level} in fixed set`)
  }
  for (const event of new Set(log.records.map((r) => r.event))) {
    assert.ok(['startup', 'readiness', 'request', 'cleanup', 'shutdown'].includes(event), `event ${event} in fixed set`)
  }
})

test('M2.2b.3 throwing logger never fails requests, cleanup, or shutdown', async (t) => {
  const broken = { log() { throw new Error(`logger boom ${DRIVER_SENTINEL}`) } }
  const h = await createHarness(t, { logger: broken })
  await h.service.migrate()

  const live = await plainJson(`${h.base}/healthz`)
  assert.equal(live.status, 200, 'liveness succeeds despite throwing logger')

  const notReady = await plainJson(`${h.base}/ready`)
  assert.equal(notReady.status, 200, 'readiness succeeds despite throwing logger')

  const ok = await archive(h, [outboundRecord({ messageId: 'm23-throw-ok', owner: h.clientId, peer: h.otherId })])
  assert.equal(ok.status, 200, 'archive succeeds despite throwing logger')

  const denied = await archive(h, [outboundRecord({ messageId: 'm23-throw-denied', owner: h.otherId, peer: h.clientId })])
  assert.ok(denied.status >= 400, 'typed failures still classify')
  assertRedacted(denied.body, 'typed failure under throwing logger')

  const outcome = await h.service.cleanup.runNow()
  assert.equal(outcome && outcome.ok, true, 'cleanup still reports success')
  await h.service.stop()
  await h.service.close()
})

test('M2.2b.3 logger defaults: no-op in createServiceApp, console JSON in createService', async () => {
  const noop = createNoopServiceLogger()
  assert.equal(typeof noop.log, 'function')
  noop.log({ level: 'info', event: 'startup', fields: { port: 1 } })
  noop.log(undefined)
  noop.log(() => { throw new Error('noop must not invoke') })

  const app = await createServiceApp({
    checkReadiness: () => ({ ready: false, versions: null }),
    version: 'm2.2b.3-probe',
  })
  assert.ok(app, 'createServiceApp works without injected logger (no-op default)')

  const lines = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (line) => { lines.push({ stream: 'out', line }) }
  console.error = (line) => { lines.push({ stream: 'err', line }) }
  try {
    const consoleLogger = createConsoleServiceLogger()
    consoleLogger.log({ level: 'info', event: 'startup', fields: { port: 1 } })
    consoleLogger.log({ level: 'warn', event: 'readiness', fields: { ready: false } })
    consoleLogger.log({ level: 'error', event: 'cleanup', fields: { ok: false } })
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  assert.equal(lines.length, 3, 'console logger emits one line per record')
  assert.equal(lines[0].stream, 'out')
  assert.equal(lines[1].stream, 'err')
  assert.equal(lines[2].stream, 'err')
  for (const { line } of lines) {
    const parsed = JSON.parse(line)
    assert.ok(typeof parsed.ts === 'string')
    assert.ok(['info', 'warn', 'error'].includes(parsed.level))
    assert.ok(['startup', 'readiness', 'cleanup'].includes(parsed.event))
    assertRedacted(line, 'console JSON line')
  }

  const serviceDefaults = await createService({
    config: baseConfig(),
    knex: fakeKnex(),
    store: createMemoryStore(),
    migrate: async () => ['001-init'],
  })
  assert.ok(serviceDefaults.logger, 'createService supplies a default logger')
  assert.equal(typeof serviceDefaults.logger.log, 'function')
  await serviceDefaults.close()
})
