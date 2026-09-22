// M2.2b.2 graceful shutdown (mbs-8g5.3.2.2.2): stop admission and reject
// new protected work with the typed bounded 503 once drain begins while
// public liveness stays 200, drain active requests under the finite
// validated shutdownDrainTimeoutMs (default 10s, 0 skips waiting), force
// close remaining connections on timeout, stop cleanup before closing the
// HTTP server, and destroy an owned Knex pool exactly once while an
// externally supplied pool is never destroyed. stop()/close() are memoized
// and idempotent, restart clears drain, completed mutations report success
// and incomplete mutations leave no partial repository state. Redacted
// typed envelopes only — no process supervisors, distributed coordination
// or deployment modes.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { ProtoWallet, PrivateKey, AuthFetch, SessionManager } = await import('@bsv/sdk')
const { createMemoryStore } = await import('../src/repository.mjs')
const {
  createService,
  createAdmissionTracker,
  loadServiceConfigFromEnv,
  validateServiceConfig,
  SERVICE_CONFIG_CODE,
  SERVICE_VERSION,
  SHUTDOWN_DRAIN_TIMEOUT_DEFAULT_MS,
} = await import('../dist/server.js')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const SERVER_KEY = '33'.repeat(32)
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const BODY_A = '{"encryptedMessage":"AQ=="}'
const BODY_SENTINEL = '{"encryptedMessage":"U0VOVElORUxfTVQyX1NVRFdOQVRJT05fQ0lQSEVSVEVYVA=="}'
const ARCHIVE_PATH = '/v1/history/records'
const USAGE_PATH = '/v1/history/usage'

function baseConfig(overrides = {}) {
  return {
    serverSecret: SECRET,
    mysql: { host: '127.0.0.1', port: 3306, user: 'mbs_test', password: PASSWORD, database: 'message_box_store_test' },
    retention: 'permanent',
    ...overrides,
  }
}

function fakeKnex() {
  return { raw: async () => [[{ ok: 1 }]], destroy: async () => {} }
}

function assertRedacted(value, label) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, PASSWORD, SERVER_KEY, CLIENT_KEY, OTHER_KEY, BODY_A, BODY_SENTINEL]) {
    assert.ok(!text.includes(secret), `${label} must not leak secret or ciphertext material`)
  }
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
  return { status: response.status, body }
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

async function waitFor(condition, label, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`${label} timed out after ${ms}ms`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function deferred() {
  let resolve = () => {}
  let reject = () => {}
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function gatedKnex() {
  const gate = deferred()
  const stats = { rawCalls: 0, destroys: 0 }
  return {
    gate,
    stats,
    knex: {
      raw: async () => {
        stats.rawCalls += 1
        await gate.promise
        return [[{ ok: 1 }]]
      },
      destroy: async () => { stats.destroys += 1 },
    },
  }
}

function walletFor(hex) {
  return new ProtoWallet(PrivateKey.fromHex(hex))
}

async function identityOf(wallet) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

function outboundRecord({ messageId, owner, peer, body = BODY_A }) {
  return { messageId, messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body }
}

async function createAuthHarness(t, { config = {}, store, knex = fakeKnex() } = {}) {
  const serverWallet = walletFor(SERVER_KEY)
  const clientWallet = walletFor(CLIENT_KEY)
  const otherWallet = walletFor(OTHER_KEY)
  const sessionManager = new SessionManager()
  const service = await createService({
    config: baseConfig(config),
    knex,
    store: store ?? createMemoryStore(),
    migrate: async () => ['001-init'],
    auth: { wallet: serverWallet, sessionManager },
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  const clientId = await identityOf(clientWallet)
  const otherId = await identityOf(otherWallet)
  return {
    service, base, clientId, otherId,
    authFetch: new AuthFetch(clientWallet),
    repository: service.repository,
  }
}

const archive = (h, records, epoch = 'gen-1', fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}${ARCHIVE_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch, records }),
  })

test('M2.2b.2 shutdownDrainTimeoutMs validates finitely, redacted, with the accepted default', () => {
  assert.equal(SHUTDOWN_DRAIN_TIMEOUT_DEFAULT_MS, 10_000)
  const defaults = validateServiceConfig(baseConfig())
  assert.equal(defaults.shutdownDrainTimeoutMs, SHUTDOWN_DRAIN_TIMEOUT_DEFAULT_MS)

  assert.equal(validateServiceConfig(baseConfig({ shutdownDrainTimeoutMs: 0 })).shutdownDrainTimeoutMs, 0, '0 skips the drain wait')
  assert.equal(validateServiceConfig(baseConfig({ shutdownDrainTimeoutMs: 250 })).shutdownDrainTimeoutMs, 250)
  assert.equal(validateServiceConfig(baseConfig({ shutdownDrainTimeoutMs: '250' })).shutdownDrainTimeoutMs, 250, 'env-style string coerces')

  for (const bad of [-1, -0.5, 1.5, NaN, Infinity, 'abc', true, false, {}, [], Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => validateServiceConfig(baseConfig({ shutdownDrainTimeoutMs: bad })), (error) => {
      assert.equal(error.code, SERVICE_CONFIG_CODE, `timeout ${String(bad)} rejects typed`)
      assert.equal(error.message, 'shutdownDrainTimeoutMs must be a non-negative integer')
      assertRedacted({ message: error.message }, `timeout ${String(bad)} rejection`)
      return true
    })
  }

  const envBase = {
    MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
    MYSQL_USER: 'mbs_test',
    MYSQL_PASSWORD: PASSWORD,
    MYSQL_DATABASE: 'message_box_store_test',
  }
  const fromEnv = loadServiceConfigFromEnv({ ...envBase, MESSAGE_BOX_STORE_SHUTDOWN_DRAIN_TIMEOUT_MS: '1500' })
  assert.equal(fromEnv.shutdownDrainTimeoutMs, 1_500)
  assert.equal(loadServiceConfigFromEnv({ ...envBase, MESSAGE_BOX_STORE_SHUTDOWN_DRAIN_TIMEOUT_MS: '0' }).shutdownDrainTimeoutMs, 0)
  assert.equal(loadServiceConfigFromEnv(envBase).shutdownDrainTimeoutMs, SHUTDOWN_DRAIN_TIMEOUT_DEFAULT_MS)
  for (const bad of ['nope', '-1', '1.5']) {
    assert.throws(() => loadServiceConfigFromEnv({ ...envBase, MESSAGE_BOX_STORE_SHUTDOWN_DRAIN_TIMEOUT_MS: bad }), (error) => {
      assert.equal(error.code, SERVICE_CONFIG_CODE)
      assertRedacted({ message: error.message }, `env timeout ${bad} rejection`)
      return true
    })
  }
})

test('M2.2b.2 admission tracker enforces the bound, drain rejection and finite waitIdle', async (t) => {
  // waitIdle's timeout timer is deliberately unref()'d so a drain wait can
  // never hold the process open on its own; without a server handle this
  // standalone unit test must therefore reference the loop itself.
  const keepAlive = setInterval(() => {}, 25)
  t.after(() => clearInterval(keepAlive))
  const tracker = createAdmissionTracker()
  assert.equal(tracker.isDraining(), false)
  assert.equal(tracker.active(), 0)
  assert.equal(await tracker.waitIdle(0), true, 'idle tracker resolves immediately')

  assert.equal(tracker.tryAcquire(1), true)
  assert.equal(tracker.tryAcquire(1), false, 'the exact bound rejects the next slot')
  assert.equal(tracker.active(), 1)

  tracker.beginDrain()
  assert.equal(tracker.isDraining(), true)
  assert.equal(tracker.tryAcquire(5), false, 'draining rejects even far below the bound')
  assert.equal(await tracker.waitIdle(30), false, 'an active request blocks idle past the timeout')
  tracker.clearDrain()
  assert.equal(tracker.isDraining(), false)
  assert.equal(tracker.tryAcquire(1), false, 'the held slot still occupies the bound after clearDrain')
  tracker.release()
  assert.equal(tracker.active(), 0)
  assert.equal(tracker.tryAcquire(5), true)

  tracker.beginDrain()
  const waiter = tracker.waitIdle(5_000)
  tracker.release()
  assert.equal(await withTimeout(waiter, 2_000, 'idle waiter'), true, 'release wakes the idle waiter')
  tracker.clearDrain()

  tracker.tryAcquire(1)
  assert.equal(await tracker.waitIdle(30), false)
  assert.equal(await tracker.waitIdle(0), false, 'timeoutMs 0 never waits')
  assert.equal(await tracker.waitIdle(1.5), false, 'non-integer timeouts never wait')
  assert.equal(await tracker.waitIdle(-1), false, 'negative timeouts never wait')
  tracker.release()
  tracker.release()
  assert.equal(tracker.active(), 0, 'extra releases never drive the count negative')
})

test('M2.2b.2 idle shutdown closes the server, is idempotent, respects external Knex, and restart clears drain', async (t) => {
  let destroys = 0
  const knex = { raw: async () => [[{ ok: 1 }]], destroy: async () => { destroys += 1 } }
  const service = await createService({
    config: baseConfig({ shutdownDrainTimeoutMs: 1_000 }),
    knex,
    store: createMemoryStore(),
    migrate: async () => ['001-init'],
  })
  t.after(() => service.close())
  assert.equal(service.ownsKnex, false)
  assert.equal(service.config.shutdownDrainTimeoutMs, 1_000)
  assert.equal(service.config.version, SERVICE_VERSION)

  await withTimeout(service.stop(), 2_000, 'stop before start')
  assert.equal(service.admission.isDraining(), true)

  const server = await service.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal(service.admission.isDraining(), false, 'start clears drain')
  const live = await plainJson(`${base}/healthz`)
  assert.equal(live.status, 200)
  assert.equal(live.body.status, 'ok')
  assert.equal(live.body.version, SERVICE_VERSION)
  const unsigned = await plainJson(`${base}${USAGE_PATH}`)
  assert.equal(unsigned.status, 401, 'ordinary unsigned work fails authentication, not availability')

  const first = service.stop()
  const second = service.stop()
  assert.equal(first, second, 'stop is memoized onto one ordered pass')
  await withTimeout(first, 3_000, 'idle stop')
  assert.equal(service.stop(), first, 'repeated stop returns the settled pass')
  assert.equal(service.admission.isDraining(), true)
  assert.equal(service.admission.active(), 0)
  await assert.rejects(() => plainJson(`${base}/healthz`), 'the closed port refuses new connections')

  const reopened = await service.start(0, '127.0.0.1')
  const base2 = `http://127.0.0.1:${reopened.address().port}`
  assert.equal(service.admission.isDraining(), false, 'restart clears drain')
  assert.equal((await plainJson(`${base2}/healthz`)).status, 200)
  assert.equal((await plainJson(`${base2}${USAGE_PATH}`)).status, 401, 'restarted work authenticates normally again')

  const closeA = service.close()
  const closeB = service.close()
  assert.equal(closeA, closeB, 'close is memoized')
  await withTimeout(closeA, 3_000, 'external close')
  assert.equal(destroys, 0, 'an externally supplied Knex pool is never destroyed')
  assert.equal(service.ownsKnex, false)
})

test('M2.2b.2 active requests drain while new work fails typed 503 and liveness stays 200', async (t) => {
  const { gate, stats, knex } = gatedKnex()
  const service = await createService({
    config: baseConfig({ shutdownDrainTimeoutMs: 4_000 }),
    knex,
    store: createMemoryStore(),
    migrate: async () => ['001-init'],
  })
  t.after(() => service.close())
  t.after(() => { gate.resolve() })
  const server = await service.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  await service.migrate()

  const heldReady = plainJson(`${base}/ready`)
  heldReady.catch(() => {})
  await waitFor(() => stats.rawCalls === 1, 'readiness probe held in flight')
  assert.equal(service.admission.active(), 1, 'the held probe occupies one admission slot')

  const stopping = service.stop()
  assert.equal(service.admission.isDraining(), true, 'drain begins synchronously with stop')

  const live = await plainJson(`${base}/healthz`)
  assert.equal(live.status, 200, 'public liveness bypasses admission and stays 200 during drain')
  assert.equal(live.body.status, 'ok')

  const rejected = await plainJson(`${base}${USAGE_PATH}`)
  assert.equal(rejected.status, 503, 'new protected work is rejected during drain')
  assert.equal(rejected.body?.status, 'error')
  assert.equal(rejected.body?.code, 'ERR_UNAVAILABLE')
  assert.equal(rejected.body?.description, 'service unavailable')
  assertRedacted(rejected.body, 'drain rejection')
  assert.equal(service.admission.active(), 1, 'the drain rejection never counts a slot')

  const rejectedReady = await plainJson(`${base}/ready`)
  assert.equal(rejectedReady.status, 503, 'a second readiness probe is rejected during drain')
  assert.equal(rejectedReady.body?.code, 'ERR_UNAVAILABLE')
  assert.equal(stats.rawCalls, 1, 'the rejected probe never invoked checkDatabase')

  gate.resolve()
  const completed = await withTimeout(heldReady, 3_000, 'held probe completes')
  assert.equal(completed.status, 200)
  assert.equal(completed.body.status, 'ready')
  await withTimeout(stopping, 3_000, 'drained stop')
  assert.equal(service.admission.active(), 0)
  assert.equal(stats.destroys, 0, 'stop never destroys an external pool')
  await assert.rejects(() => plainJson(`${base}/healthz`), 'the closed port refuses new connections')
})

test('M2.2b.2 a timed-out drain force-closes remaining connections and still resolves', async (t) => {
  const { gate, stats, knex } = gatedKnex()
  const service = await createService({
    config: baseConfig({ shutdownDrainTimeoutMs: 120 }),
    knex,
    store: createMemoryStore(),
    migrate: async () => ['001-init'],
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  await service.migrate()

  const heldReady = plainJson(`${base}/ready`)
  heldReady.catch(() => {})
  await waitFor(() => stats.rawCalls === 1, 'stuck probe in flight')

  const started = Date.now()
  await withTimeout(service.stop(), 3_000, 'timed-out stop')
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 100, `the drain waited the configured bound (took ${elapsed}ms)`)
  assert.ok(elapsed < 2_500, 'the stop stays inside the configured finite bound')
  await assert.rejects(() => heldReady, 'the stuck connection was force-closed')
  await assert.rejects(() => plainJson(`${base}/healthz`), 'the closed port refuses new connections')

  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('M2.2b.2 a client abort during drain releases its slot so stop finishes early', async (t) => {
  const { gate, stats, knex } = gatedKnex()
  const service = await createService({
    config: baseConfig({ shutdownDrainTimeoutMs: 8_000 }),
    knex,
    store: createMemoryStore(),
    migrate: async () => ['001-init'],
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  await service.migrate()

  const controller = new AbortController()
  const heldReady = plainJson(`${base}/ready`, { signal: controller.signal })
  heldReady.catch(() => {})
  await waitFor(() => stats.rawCalls === 1, 'probe in flight')
  assert.equal(service.admission.active(), 1)

  const started = Date.now()
  const stopping = service.stop()
  controller.abort()
  await withTimeout(stopping, 3_000, 'abort releases the drain')
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2_000, `the abort released the slot well before the 8s bound (took ${elapsed}ms)`)
  assert.equal(service.admission.active(), 0, 'the aborted request released exactly once')
  await assert.rejects(() => heldReady)

  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('M2.2b.2 completed mutations report success during drain; new signed work fails typed 503 before the repository', async (t) => {
  const held = deferred()
  let archiveCalls = 0
  const inner = createMemoryStore()
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = target[prop]
      if (prop === 'archiveBatch' && typeof value === 'function') {
        return async (args) => {
          archiveCalls += 1
          await held.promise
          return value.apply(target, [args])
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const h = await createAuthHarness(t, { store, config: { shutdownDrainTimeoutMs: 4_000 } })

  const inflight = archive(h, [outboundRecord({ messageId: 'm22b2-drain-ok', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
  inflight.catch(() => {})
  await waitFor(() => archiveCalls === 1, 'signed archive held in the repository')

  const stopping = h.service.stop()
  assert.equal(h.service.admission.isDraining(), true)

  const rejected = await plainJson(`${h.base}${USAGE_PATH}`)
  assert.equal(rejected.status, 503, 'unsigned work fails availability during drain')
  assertRedacted(rejected.body, 'drain unsigned rejection')

  const rejectedSigned = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bsv-auth-version': '1',
      'x-bsv-auth-identity-key': h.clientId,
      'x-bsv-auth-signature': '00',
      'x-bsv-auth-request-id': 'm22b2-drain-late',
    },
    body: JSON.stringify({ epoch: 'gen-1', records: [outboundRecord({ messageId: 'm22b2-drain-late', owner: h.clientId, peer: h.otherId })] }),
  })
  assert.equal(rejectedSigned.status, 503, 'a new signed-shaped mutation fails typed 503 during drain')
  assert.equal(rejectedSigned.body?.status, 'error')
  assert.equal(rejectedSigned.body?.code, 'ERR_UNAVAILABLE')
  assert.equal(rejectedSigned.body?.description, 'service unavailable')
  assertRedacted(rejectedSigned.body, 'drain signed rejection')
  assert.equal(archiveCalls, 1, 'the rejected mutation never reached authentication or the repository')

  held.resolve()
  const completed = await withTimeout(inflight, 3_000, 'in-flight mutation completes')
  assert.equal(completed.status, 200)
  assert.equal(completed.body?.committed, true)
  assert.equal(completed.body?.outcomes?.length, 1)
  assert.equal(completed.body?.outcomes?.[0]?.outcome, 'stored')
  assertRedacted(completed.body, 'completed drain mutation')
  await withTimeout(stopping, 3_000, 'stop after the in-flight mutation')
  const usage = await h.repository.getUsage({ owner: h.clientId })
  assert.equal(usage.recordCount, 1, 'the completed mutation committed exactly once')
  await assert.rejects(() => plainJson(`${h.base}/healthz`), 'the closed port refuses new connections')
})

test('M2.2b.2 forced shutdown mid-mutation keeps all-or-nothing repository state', async (t) => {
  const held = deferred()
  let archiveCalls = 0
  let failNext = false
  const inner = createMemoryStore()
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = target[prop]
      if (prop === 'archiveBatch' && typeof value === 'function') {
        return async (args) => {
          archiveCalls += 1
          if (failNext) {
            failNext = false
            throw Object.assign(new Error('quota exhausted'), { code: 'ERR_QUOTA_EXCEEDED' })
          }
          await held.promise
          return value.apply(target, [args])
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const h = await createAuthHarness(t, { store, config: { shutdownDrainTimeoutMs: 120 } })

  failNext = true
  const failed = await archive(h, [outboundRecord({ messageId: 'm22b2-fail', owner: h.clientId, peer: h.otherId })])
  assert.equal(failed.status, 409, 'a typed repository failure still reports its bounded envelope')
  assert.equal(failed.body?.code, 'ERR_QUOTA_EXCEEDED')
  assertRedacted(failed.body, 'failed mutation envelope')
  const usageAfterFailure = await h.repository.getUsage({ owner: h.clientId })
  assert.equal(usageAfterFailure.recordCount, 0, 'the incomplete mutation left no partial state')

  const batch = [
    outboundRecord({ messageId: 'm22b2-atom-a', owner: h.clientId, peer: h.otherId }),
    outboundRecord({ messageId: 'm22b2-atom-b', owner: h.clientId, peer: h.otherId }),
  ]
  const inflight = archive(h, batch)
  inflight.catch(() => {})
  await waitFor(() => archiveCalls === 2, 'second archive held mid-mutation')

  await withTimeout(h.service.stop(), 3_000, 'forced stop')
  await assert.rejects(() => inflight, 'the force-closed client observes the lost connection')
  await assert.rejects(() => plainJson(`${h.base}/healthz`), 'the closed port refuses new connections')

  held.resolve()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const usage = await h.repository.getUsage({ owner: h.clientId })
  assert.equal(usage.recordCount, 2, 'the interrupted transaction committed all records, never a partial batch')
  assert.equal(archiveCalls, 2)
})

test('M2.2b.2 stop order is deterministic — cleanup, then server, then owned pool destroyed exactly once', async (t) => {
  const service = await createService({ config: baseConfig() })
  t.after(() => service.close())
  assert.equal(service.ownsKnex, true, 'the default construction owns its Knex pool')

  const order = []
  let destroys = 0
  const cleanupStop = service.cleanup.stop.bind(service.cleanup)
  service.cleanup.stop = async (...args) => {
    order.push('cleanup-stop')
    return cleanupStop(...args)
  }
  const pool = service.knex
  const poolDestroy = pool.destroy.bind(pool)
  Object.defineProperty(pool, 'destroy', {
    configurable: true,
    value: async () => {
      destroys += 1
      order.push('pool-destroy')
      return poolDestroy()
    },
  })
  const server = await service.start(0, '127.0.0.1')
  const serverClose = server.close.bind(server)
  server.close = (callback) => {
    order.push('server-close')
    return serverClose(callback)
  }

  const stopA = service.stop()
  const stopB = service.stop()
  assert.equal(stopA, stopB, 'concurrent stop calls share one pass')
  await withTimeout(stopA, 3_000, 'ordered stop')
  assert.equal(service.admission.isDraining(), true)
  assert.deepEqual(order, ['cleanup-stop', 'server-close'], 'cleanup stops before the HTTP server closes')
  assert.equal(destroys, 0, 'stop alone never touches the pool')

  const closeA = service.close()
  const closeB = service.close()
  assert.equal(closeA, closeB, 'concurrent close calls share one pass')
  await withTimeout(closeA, 3_000, 'owned close')
  await service.close()
  assert.deepEqual(order, ['cleanup-stop', 'server-close', 'pool-destroy'], 'the owned pool is destroyed after the server closes')
  assert.equal(destroys, 1, 'the owned pool is destroyed exactly once across every stop/close call')
})
