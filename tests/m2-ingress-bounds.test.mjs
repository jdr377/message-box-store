// M2.2a.1 ingress (mbs-8g5.3.2.1.1): exact configured origin/CORS handling
// plus early HTTP body, batch-item and batch-byte bounds enforced before any
// authentication or repository work, reusing the accepted M1 LIMITS constants
// and the existing typed/redacted error envelopes. Proves exact-boundary and
// bound+1 behavior, that disallowed origins get no permissive CORS headers
// and cannot mutate even with a valid signature, and that deletion plus
// ordinary idempotent retry remain intact behind the new gates.
import assert from 'node:assert/strict'
import { test } from 'node:test'

// The SDK binds global fetch at import time; install the hold/capture wrapper
// before the first '@bsv/sdk' import so a signed archive request can be held
// and replayed with/without an Origin header while the original stays
// unsent (so the server-side request-id/session state is untouched until we
// release it).
const plainFetch = globalThis.fetch
let holdSignedArchive = null
globalThis.fetch = async (url, init) => {
  let headers = {}
  try {
    if (init?.headers instanceof Headers) headers = Object.fromEntries(init.headers.entries())
    else if (init?.headers) headers = { ...init.headers }
  } catch {}
  if (holdSignedArchive &&
      String(init?.method ?? 'GET').toUpperCase() === 'POST' &&
      typeof headers['x-bsv-auth-signature'] === 'string' &&
      String(url).endsWith('/v1/history/records')) {
    const held = holdSignedArchive
    holdSignedArchive = null
    return await held.capture({ url: String(url), method: init?.method, headers, body: init?.body })
  }
  return plainFetch(url, init)
}

const { ProtoWallet, PrivateKey, AuthFetch, SessionManager } = await import('@bsv/sdk')
const { createMemoryStore } = await import('../src/repository.mjs')
const { LIMITS } = await import('../src/protocol.mjs')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const SERVER_KEY = '33'.repeat(32)
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const BODY_A = '{"encryptedMessage":"AQ=="}'
const BODY_SENTINEL = '{"encryptedMessage":"U0VOVElORUxfTVQyX0lOR1JFU1NfQk9VTkRT"}'
const ALLOWED_ORIGIN = 'https://app.example.com'
const ARCHIVE_PATH = '/v1/history/records'

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

function walletFor(hex) {
  return new ProtoWallet(PrivateKey.fromHex(hex))
}

async function identityOf(wallet) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

function outboundRecord({ messageId, owner, peer, body = BODY_A, ...extra }) {
  return { messageId, messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body, ...extra }
}

function assertRedacted(value, label) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, PASSWORD, SERVER_KEY, CLIENT_KEY, OTHER_KEY, BODY_A, BODY_SENTINEL]) {
    assert.ok(!text.includes(secret), `${label} must not leak secret or ciphertext material`)
  }
  assert.ok(!text.includes('x-bsv-auth-signature'), `${label} must not echo auth headers`)
  assert.ok(!text.includes('BEGIN'), `${label} must not echo key material`)
}

function assertNoPermissiveCors(res, label) {
  assert.equal(res.headers.get('access-control-allow-origin'), null, `${label}: no Access-Control-Allow-Origin`)
  assert.equal(res.headers.get('access-control-allow-methods'), null, `${label}: no Access-Control-Allow-Methods`)
  assert.equal(res.headers.get('access-control-allow-headers'), null, `${label}: no Access-Control-Allow-Headers`)
  assert.equal(res.headers.get('access-control-expose-headers'), null, `${label}: no Access-Control-Expose-Headers`)
  assert.equal(res.headers.get('access-control-allow-credentials'), null, `${label}: no Access-Control-Allow-Credentials`)
}

async function plainResponse(url, options = {}) {
  return await plainFetch(url, options)
}

async function plainJson(url, options = {}) {
  const response = await plainFetch(url, options)
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

// ---------------------------------------------------------------------------
// Harness 1: createServiceApp with a counting auth spy and counting repository
// — proves exact/bound+1 requests never reach authentication or repository
// access, and pins the exact CORS behavior without any signature machinery.
// ---------------------------------------------------------------------------

let requestSeq = 0
function spyAuthHeaders(extra = {}) {
  requestSeq += 1
  return {
    'content-type': 'application/json',
    'x-bsv-auth-signature': '00',
    'x-bsv-auth-request-id': `m22a1-${requestSeq}`,
    ...extra,
  }
}

async function listenApp(t, app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

async function createBoundsHarness(t, { allowedOrigins = [ALLOWED_ORIGIN] } = {}) {
  const { createServiceApp } = await import('../dist/server.js')
  const auth = { calls: 0 }
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
  const app = await createServiceApp({
    checkReadiness: () => ({ ready: false, versions: null }),
    version: 'm2.2a.1-probe',
    authMiddleware: (req, _res, next) => { auth.calls += 1; next() },
    repository,
    serverSecret: SECRET,
    allowedOrigins,
  })
  const base = await listenApp(t, app)
  return { base, auth, repoCalls }
}

// A JSON body padded to exactly MAX_HTTP_BODY_BYTES UTF-8 bytes.
function httpBodyOfSize(size) {
  const prefix = '{"epoch":"gen-1","records":[],"pad":"'
  const suffix = '"}'
  assert.ok(size > prefix.length + suffix.length, 'pad target must fit the envelope')
  const body = `${prefix}${'a'.repeat(size - prefix.length - suffix.length)}${suffix}`
  assert.equal(Buffer.byteLength(body, 'utf8'), size, 'exact byte construction')
  return body
}

test('M2.2a.1 exact HTTP body bound reaches authentication; bound+1 fails typed 413 before it', async (t) => {
  const h = await createBoundsHarness(t)
  const exact = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: spyAuthHeaders(),
    body: httpBodyOfSize(LIMITS.MAX_HTTP_BODY_BYTES),
  })
  assert.equal(exact.status, 401, 'exact body bound proceeds through ingress to authentication')
  assert.equal(h.auth.calls, 1, 'exact body reaches the auth middleware once')
  assert.equal(h.repoCalls.length, 0, '401 at owner resolution never touches the repository')
  assertRedacted(exact.body, 'exact HTTP body')

  const before = h.auth.calls
  const plusOne = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: spyAuthHeaders(),
    body: httpBodyOfSize(LIMITS.MAX_HTTP_BODY_BYTES + 1),
  })
  assert.equal(plusOne.status, 413)
  assert.equal(plusOne.body?.code, 'ERR_REQUEST_TOO_LARGE')
  assert.equal(plusOne.body?.description, 'request exceeds the configured limit')
  assertRedacted(plusOne.body, 'HTTP body bound +1')
  assert.equal(h.auth.calls, before, 'bound+1 never reaches authentication')
  assert.equal(h.repoCalls.length, 0, 'bound+1 never reaches the repository')
})

test('M2.2a.1 exact batch-item bound reaches authentication; bound+1 fails typed 413 before it', async (t) => {
  const h = await createBoundsHarness(t)
  const batchOf = (count) => JSON.stringify({
    epoch: 'gen-1',
    records: Array.from({ length: count }, (_, i) => ({ body: `x${i}` })),
  })
  const exact = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: spyAuthHeaders(),
    body: batchOf(LIMITS.MAX_BATCH_RECORDS),
  })
  assert.equal(exact.status, 401, 'exact batch-item bound proceeds through ingress to authentication')
  assert.equal(h.auth.calls, 1, '100-record batch reaches the auth middleware')
  assert.equal(h.repoCalls.length, 0)

  const before = h.auth.calls
  const plusOne = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: spyAuthHeaders(),
    body: batchOf(LIMITS.MAX_BATCH_RECORDS + 1),
  })
  assert.equal(plusOne.status, 413)
  assert.equal(plusOne.body?.code, 'ERR_REQUEST_TOO_LARGE')
  assertRedacted(plusOne.body, 'batch-item bound +1')
  assert.equal(h.auth.calls, before, '101-record batch never reaches authentication')
  assert.equal(h.repoCalls.length, 0, '101-record batch never reaches the repository')

  const trailingSlash = await plainJson(`${h.base}${ARCHIVE_PATH}/`, {
    method: 'POST',
    headers: spyAuthHeaders(),
    body: batchOf(LIMITS.MAX_BATCH_RECORDS + 1),
  })
  assert.equal(trailingSlash.status, 413, 'trailing-slash variant carries the same early bound')
  assert.equal(h.auth.calls, before, 'trailing-slash bound+1 never reaches authentication')
  assert.equal(h.repoCalls.length, 0)
})

test('M2.2a.1 batch-byte bound: exact sum passes, sum+1 fails typed before repository access', async (t) => {
  // JSON overhead means a byte-overflowing archive body always exceeds
  // MAX_HTTP_BODY_BYTES as well (both are 4 MiB), so over HTTP the +1 sum is
  // rejected by the early HTTP body bound before authentication — asserted
  // here — while the batch-byte gate's own exact/+1 boundary is proven
  // directly against assertEarlyBatchBounds below.
  const { assertEarlyBatchBounds } = await import('../dist/server.js')
  const unitMiB = 1024 * 1024
  const exactBytes = {
    records: Array.from({ length: LIMITS.MAX_BATCH_BYTES / unitMiB }, () => ({ body: 'b'.repeat(unitMiB) })),
  }
  assert.doesNotThrow(() => assertEarlyBatchBounds(exactBytes), 'exact batch-byte sum passes')
  const plusOneBytes = {
    records: [
      ...Array.from({ length: LIMITS.MAX_BATCH_BYTES / unitMiB - 1 }, () => ({ body: 'b'.repeat(unitMiB) })),
      { body: 'b'.repeat(unitMiB + 1) },
    ],
  }
  assert.throws(() => assertEarlyBatchBounds(plusOneBytes), (error) => {
    assert.equal(error.statusCode, 413)
    assert.equal(error.code, 'ERR_REQUEST_TOO_LARGE')
    assert.equal(error.message, 'batch exceeds the configured byte bound')
    return true
  }, 'batch-byte sum +1 fails typed')
  // Shape/content validation stays out of the early bound: non-record entries
  // and non-array bodies are ignored here and remain the route contract.
  assert.doesNotThrow(() => assertEarlyBatchBounds({ records: [1, null, 'x'] }))
  assert.doesNotThrow(() => assertEarlyBatchBounds({ epoch: 'gen-1' }))
  assert.doesNotThrow(() => assertEarlyBatchBounds(undefined))

  const h = await createBoundsHarness(t)
  const recordBodyOfSize = (size) => JSON.stringify({
    epoch: 'gen-1',
    records: [{ messageId: 'm22a1-bytes', messageBox: 'inbox', direction: 'outbound', body: 'a'.repeat(size) }],
  })
  const near = LIMITS.MAX_HTTP_BODY_BYTES - 512
  const withinBothBounds = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: spyAuthHeaders(),
    body: recordBodyOfSize(near),
  })
  assert.equal(withinBothBounds.status, 401, 'a large-but-within-bounds batch reaches authentication')
  assert.equal(h.auth.calls, 1)
  assert.equal(h.repoCalls.length, 0)

  const before = h.auth.calls
  const overflow = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: spyAuthHeaders(),
    body: recordBodyOfSize(LIMITS.MAX_BATCH_BYTES + 1),
  })
  assert.equal(overflow.status, 413)
  assert.equal(overflow.body?.code, 'ERR_REQUEST_TOO_LARGE')
  assertRedacted(overflow.body, 'batch-byte bound +1 over HTTP')
  assert.equal(h.auth.calls, before, 'batch-byte overflow never reaches authentication')
  assert.equal(h.repoCalls.length, 0, 'batch-byte overflow never reaches the repository')
})

test('M2.2a.1 allowed configured origin gets the exact CORS contract (preflight, actual, liveness)', async (t) => {
  const h = await createBoundsHarness(t)
  const preflight = await plainResponse(`${h.base}${ARCHIVE_PATH}`, {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-bsv-auth-signature',
    },
  })
  assert.equal(preflight.status, 204, 'preflight answered before authentication')
  assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(preflight.headers.get('vary'), 'Origin')
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE')
  const allowedHeaders = (preflight.headers.get('access-control-allow-headers') ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
  for (const header of [
    'content-type',
    'x-bsv-auth-version',
    'x-bsv-auth-identity-key',
    'x-bsv-auth-message-type',
    'x-bsv-auth-nonce',
    'x-bsv-auth-your-nonce',
    'x-bsv-auth-signature',
    'x-bsv-auth-request-id',
    'x-bsv-auth-requested-certificates',
  ]) {
    assert.ok(allowedHeaders.includes(header), `preflight allows ${header}`)
  }
  assert.equal(preflight.headers.get('access-control-max-age'), '600')
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null, 'no credentialed CORS')
  assert.equal(preflight.headers.get('x-bsv-auth-signature'), null, 'preflight never runs authentication')
  assert.equal(h.auth.calls, 0, 'preflight never reaches authentication')
  assert.equal(h.repoCalls.length, 0)

  const actual = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: spyAuthHeaders({ Origin: ALLOWED_ORIGIN }),
    body: JSON.stringify({ epoch: 'gen-1', records: [] }),
  })
  assert.equal(actual.status, 401, 'allowed-origin request proceeds to authentication')
  assert.equal(actual.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(actual.headers.get('vary'), 'Origin')
  const exposed = (actual.headers.get('access-control-expose-headers') ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
  for (const header of ['x-bsv-auth-signature', 'x-bsv-auth-request-id', 'x-bsv-auth-identity-key']) {
    assert.ok(exposed.includes(header), `exposes ${header}`)
  }
  assert.equal(h.auth.calls, 1)

  const live = await plainJson(`${h.base}/healthz`, { headers: { Origin: ALLOWED_ORIGIN } })
  assert.equal(live.status, 200)
  assert.equal(live.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
})

test('M2.2a.1 absent Origin keeps the private non-browser contract with no CORS headers', async (t) => {
  const h = await createBoundsHarness(t)
  const res = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: spyAuthHeaders(),
    body: JSON.stringify({ epoch: 'gen-1', records: [] }),
  })
  assert.equal(res.status, 401, 'absent Origin proceeds to authentication')
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  assert.equal(res.headers.get('access-control-expose-headers'), null)
  assert.equal(res.headers.get('vary'), null, 'no Vary: Origin without an Origin header')
  assert.equal(h.auth.calls, 1)
  assert.equal(h.repoCalls.length, 0)

  const live = await plainJson(`${h.base}/healthz`)
  assert.equal(live.status, 200)
  assert.equal(live.headers.get('access-control-allow-origin'), null)
  assert.equal(live.headers.get('vary'), null)
})

test('M2.2a.1 disallowed, null and malformed origins fail closed 403 before authentication with no permissive headers', async (t) => {
  const h = await createBoundsHarness(t)
  const origins = [
    ['unlisted origin', 'https://evil.example'],
    ['null origin', 'null'],
    ['http origin', 'http://app.example.com'],
    ['trailing slash', `${ALLOWED_ORIGIN}/`],
    ['suffix confusion', `${ALLOWED_ORIGIN}.evil`],
    ['default port', 'https://app.example.com:443'],
    ['case variation', 'https://APP.example.com'],
    ['malformed', 'not a url'],
  ]
  for (const [label, origin] of origins) {
    const res = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
      method: 'POST',
      headers: spyAuthHeaders({ Origin: origin }),
      body: JSON.stringify({ epoch: 'gen-1', records: [{ body: BODY_A }] }),
    })
    assert.equal(res.status, 403, label)
    assert.equal(res.body?.code, 'ERR_FORBIDDEN', label)
    assert.equal(res.body?.description, 'forbidden', label)
    assertNoPermissiveCors(res, label)
    assert.equal(res.headers.get('vary'), 'Origin', `${label}: Vary: Origin is set but never permissive`)
    assertRedacted(res.body, label)
    assert.equal(h.auth.calls, 0, `${label}: never reaches authentication`)
    assert.equal(h.repoCalls.length, 0, `${label}: never reaches the repository`)
  }
  const preflight = await plainResponse(`${h.base}${ARCHIVE_PATH}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  })
  assert.equal(preflight.status, 403, 'disallowed preflight fails closed')
  assertNoPermissiveCors(preflight, 'disallowed preflight')
  assert.equal(h.auth.calls, 0, 'disallowed preflight never reaches authentication')

  const live = await plainJson(`${h.base}/healthz`, { headers: { Origin: 'https://evil.example' } })
  assert.equal(live.status, 403, 'the origin gate is the first middleware, liveness included')
  assertNoPermissiveCors(live, 'disallowed healthz')
  assert.equal(h.auth.calls, 0)
})

// ---------------------------------------------------------------------------
// Harness 2: full createService with real BRC-104 auth — proves the origin
// policy against genuinely signed requests and that deletion/idempotent
// retry stay intact behind the early bounds.
// ---------------------------------------------------------------------------

async function createFullHarness(t) {
  const { createService } = await import('../dist/server.js')
  const serverWallet = walletFor(SERVER_KEY)
  const clientWallet = walletFor(CLIENT_KEY)
  const otherWallet = walletFor(OTHER_KEY)
  const sessionManager = new SessionManager()
  const service = await createService({
    config: baseConfig({ allowedOrigins: [ALLOWED_ORIGIN] }),
    knex: fakeKnex(),
    store: createMemoryStore(),
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
    store: service.repository,
  }
}

const archive = (h, records, epoch = 'gen-1') =>
  authedJson(h.authFetch, `${h.base}${ARCHIVE_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch, records }),
  })

const deleteOne = (h, recordKey, query = '') =>
  authedJson(h.authFetch, `${h.base}${ARCHIVE_PATH}/${recordKey}${query}`, { method: 'DELETE' })

const deleteAll = (h, query = '') =>
  authedJson(h.authFetch, `${h.base}${ARCHIVE_PATH}${query}`, { method: 'DELETE' })

function createHoldGate() {
  let pending = null
  let resolveCapture = null
  const captured = new Promise((resolve) => { resolveCapture = resolve })
  holdSignedArchive = {
    async capture(request) {
      return await new Promise((resolve) => {
        pending = { request, resolve }
        resolveCapture(request)
      })
    },
  }
  return {
    waitForCapture: () => captured,
    async release() {
      const held = pending
      pending = null
      holdSignedArchive = null
      if (!held) return null
      const response = await plainFetch(held.request.url, {
        method: held.request.method,
        headers: held.request.headers,
        body: held.request.body,
      })
      held.resolve(response)
      return response
    },
  }
}

test('M2.2a.1 allowed origin carries a genuinely signed archive to a stored outcome', async (t) => {
  const h = await createFullHarness(t)
  const gate = createHoldGate()
  let pending
  try {
    pending = archive(h, [outboundRecord({ messageId: 'm22a1-allowed-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
    pending.catch(() => {})
    const held = await withTimeout(gate.waitForCapture(), 15000, 'signed archive capture')
    assert.equal(typeof held.headers['x-bsv-auth-signature'], 'string', 'captured a genuinely signed request')
    const replayed = await plainResponse(held.url, {
      method: 'POST',
      headers: { ...held.headers, Origin: ALLOWED_ORIGIN },
      body: held.body,
    })
    assert.equal(replayed.status, 200, 'allowed origin + valid signature stores')
    assert.equal(replayed.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
    const replayedBody = await replayed.json()
    assert.equal(replayedBody.outcomes[0].outcome, 'stored')
    assertRedacted(replayedBody, 'allowed-origin archive')
  } finally {
    await gate.release().catch(() => {})
  }
  const released = await pending
  assert.equal(released.status, 401, 'the released verbatim request-id fails the replay window')
  assert.equal(released.body?.code, 'ERR_AUTHENTICATION_REQUIRED')
  assertRedacted(released.body, 'released replay')
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 1, 'exactly one mutation committed')
})

test('M2.2a.1 disallowed origins cannot mutate a genuinely signed archive request', async (t) => {
  const h = await createFullHarness(t)
  const gate = createHoldGate()
  let pending
  try {
    pending = archive(h, [outboundRecord({ messageId: 'm22a1-blocked-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
    pending.catch(() => {})
    const held = await withTimeout(gate.waitForCapture(), 15000, 'signed archive capture')
    for (const origin of ['https://evil.example', 'null', 'http://app.example.com']) {
      const blocked = await plainJson(held.url, {
        method: 'POST',
        headers: { ...held.headers, Origin: origin },
        body: held.body,
      })
      assert.equal(blocked.status, 403, origin)
      assert.equal(blocked.body?.code, 'ERR_FORBIDDEN', origin)
      assertNoPermissiveCors(blocked, origin)
      assertRedacted(blocked.body, origin)
      assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 0, `${origin}: no mutation`)
    }
  } finally {
    await gate.release().catch(() => {})
  }
  const released = await pending
  assert.equal(released.status, 200, 'counterfactual: the same signed request stores once the Origin is absent')
  assert.equal(released.body.outcomes[0].outcome, 'stored')
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 1, 'blocked attempts committed nothing')
})

test('M2.2a.1 deletion and idempotent retry remain intact behind the early bounds', async (t) => {
  const h = await createFullHarness(t)
  const record = outboundRecord({ messageId: 'm22a1-intact-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })
  const first = await archive(h, [record])
  assert.equal(first.status, 200)
  assert.equal(first.body.outcomes[0].outcome, 'stored')
  const key = first.body.outcomes[0].recordKey

  // The early bounds are live but do not obstruct in-bounds traffic.
  const tooMany = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      epoch: 'gen-1',
      records: Array.from({ length: LIMITS.MAX_BATCH_RECORDS + 1 }, (_, i) => outboundRecord({
        messageId: `m22a1-intact-${i}`, owner: h.clientId, peer: h.otherId,
      })),
    }),
  })
  assert.equal(tooMany.status, 413)
  assert.equal(tooMany.body?.code, 'ERR_REQUEST_TOO_LARGE')
  assertRedacted(tooMany.body, 'intact oversized batch')
  const oversized = await plainJson(`${h.base}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: httpBodyOfSize(LIMITS.MAX_HTTP_BODY_BYTES + 1),
  })
  assert.equal(oversized.status, 413)
  assert.equal(oversized.body?.code, 'ERR_REQUEST_TOO_LARGE')

  const again = await archive(h, [record])
  assert.equal(again.status, 200)
  assert.equal(again.body.outcomes[0].outcome, 'alreadyPresent', 'archive idempotent retry intact')

  const del = await deleteOne(h, key, '?idempotencyKey=m22a1-intact-del-1')
  assert.equal(del.status, 200)
  assert.equal(del.body.deleted, true)
  const delReplay = await deleteOne(h, key, '?idempotencyKey=m22a1-intact-del-1')
  assert.equal(delReplay.status, 200)
  assert.equal(delReplay.body.sequence, del.body.sequence, 'delete-one replay returns the original sequence')
  assert.equal(delReplay.body.replayed, true)

  const wipe = await deleteAll(h, '?idempotencyKey=m22a1-intact-wipe-1')
  assert.equal(wipe.status, 200)
  const wipeReplay = await deleteAll(h, '?idempotencyKey=m22a1-intact-wipe-1')
  assert.equal(wipeReplay.status, 200)
  assert.equal(wipeReplay.body.epoch, wipe.body.epoch, 'delete-all replay does not rotate the epoch')
  assert.equal(wipeReplay.body.replayed, true)
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 0)
})

// ---------------------------------------------------------------------------
// Configuration: allowedOrigins parsing, env loading, exact-HTTPS validation
// ---------------------------------------------------------------------------

test('M2.2a.1 allowedOrigins config accepts exact HTTPS origins and rejects every near miss typed and redacted', async (t) => {
  const { validateServiceConfig, loadServiceConfigFromEnv, parseAllowedOrigins } = await import('../dist/server.js')

  assert.deepEqual([...validateServiceConfig(baseConfig()).allowedOrigins], [], 'default is the private non-browser contract')
  assert.deepEqual(
    [...validateServiceConfig(baseConfig({ allowedOrigins: [ALLOWED_ORIGIN] })).allowedOrigins],
    [ALLOWED_ORIGIN],
  )
  assert.deepEqual([...parseAllowedOrigins(undefined)], [])
  assert.deepEqual([...parseAllowedOrigins(null)], [])
  assert.deepEqual([...parseAllowedOrigins('')], [])
  assert.deepEqual([...parseAllowedOrigins('https://a.example, https://b.example')], ['https://a.example', 'https://b.example'])
  assert.deepEqual([...parseAllowedOrigins(['https://a.example', 'https://a.example'])], ['https://a.example'], 'deduplicated')
  assert.deepEqual([...parseAllowedOrigins([' https://a.example '])], ['https://a.example'], 'trimmed')
  assert.deepEqual([...parseAllowedOrigins('https://a.example,,https://b.example')], ['https://a.example', 'https://b.example'])

  const envConfig = loadServiceConfigFromEnv({
    MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
    MYSQL_USER: 'mbs_test',
    MYSQL_PASSWORD: PASSWORD,
    MYSQL_DATABASE: 'message_box_store_test',
    MESSAGE_BOX_STORE_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
  })
  assert.deepEqual([...envConfig.allowedOrigins], ['https://a.example', 'https://b.example'])
  assert.deepEqual(
    [...loadServiceConfigFromEnv({
      MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
      MYSQL_USER: 'mbs_test',
      MYSQL_PASSWORD: PASSWORD,
      MYSQL_DATABASE: 'message_box_store_test',
    }).allowedOrigins],
    [],
    'absent env resolves to the private non-browser default',
  )

  const badCases = [
    ['http origin', ['http://app.example.com']],
    ['trailing slash', ['https://app.example.com/']],
    ['path form', ['https://app.example.com/app']],
    ['not a url', ['not-a-url']],
    ['credentials form', ['https://user:pass@app.example.com']],
    ['default port', ['https://app.example.com:443']],
    ['upper-case host', ['https://APP.example.com']],
    ['query form', ['https://app.example.com?x=1']],
    ['wildcard form', ['*']],
    ['non-string entry', [123]],
    ['non-list scalar', 42],
    ['list containing one bad entry', ['https://ok.example', 'https://bad.example/']],
  ]
  for (const [label, allowedOrigins] of badCases) {
    await assert.rejects(async () => validateServiceConfig(baseConfig({ allowedOrigins })), (error) => {
      assert.ok(error instanceof Error, label)
      assert.equal(error.code, 'ERR_STORAGE_CONFIGURATION', label)
      assert.equal(error.message, 'allowedOrigins must be exact HTTPS origins', label)
      const text = `${error.message} ${error.code}`
      assert.ok(!text.includes(SECRET), `${label} redacts secret`)
      assert.ok(!text.includes(PASSWORD), `${label} redacts password`)
      assert.ok(!text.includes('pass@app'), `${label} never echoes the supplied value`)
      return true
    }, label)
  }
})
