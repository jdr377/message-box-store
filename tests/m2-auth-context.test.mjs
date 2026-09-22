import assert from 'node:assert/strict'
import { test } from 'node:test'

// Capture AuthFetch's signed wire requests for mutation/replay negatives.
// The SDK binds global fetch at import time, so the wrapper must be installed
// before the first '@bsv/sdk' import in this process.
const plainFetch = globalThis.fetch
const captured = []
globalThis.fetch = async (url, init) => {
  try {
    let headers
    if (init?.headers instanceof Headers) headers = Object.fromEntries(init.headers.entries())
    else if (init?.headers) headers = { ...init.headers }
    captured.push({ url: String(url), method: init?.method, headers, body: init?.body })
  } catch {}
  return plainFetch(url, init)
}

const { ProtoWallet, PrivateKey, AuthFetch, SessionManager } = await import('@bsv/sdk')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const SERVER_KEY = '33'.repeat(32)
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const CIPHERTEXT_SENTINEL = 'SENTINEL_CIPHERTEXT_BODY_aq91xyz'

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

function fakeStore(spy) {
  return {
    archiveBatch: async (...args) => { spy.calls += 1; return { epoch: 'gen-1', committed: true, outcomes: [] } },
    getUsage: async () => ({ recordCount: 0, byteCount: 0, epoch: 'gen-1', nextSequence: '1' }),
  }
}

async function fetchJson(url, options = {}) {
  const response = await plainFetch(url, options)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

function walletFor(hex) {
  return new ProtoWallet(PrivateKey.fromHex(hex))
}

async function identityOf(wallet) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

function lastSignedRequest() {
  for (let i = captured.length - 1; i >= 0; i -= 1) {
    if (captured[i]?.headers?.['x-bsv-auth-signature']) return captured[i]
  }
  return null
}

async function createHarness(t, { serverKey = SERVER_KEY, clientKey = CLIENT_KEY } = {}) {
  const { createService } = await import('../dist/server.js')
  const serverWallet = walletFor(serverKey)
  const clientWallet = walletFor(clientKey)
  const sessionManager = new SessionManager()
  const spy = { calls: 0 }
  const service = await createService({
    config: baseConfig(),
    knex: fakeKnex(),
    store: fakeStore(spy),
    migrate: async () => ['001-init'],
    auth: { wallet: serverWallet, sessionManager },
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  const clientId = await identityOf(clientWallet)
  const authFetch = new AuthFetch(clientWallet)
  return { service, base, sessionManager, serverWallet, clientWallet, clientId, authFetch, spy }
}

async function authedJson(authFetch, url, config = {}) {
  const response = await authFetch.fetch(url, config)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

function assertRedacted(value, label) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, PASSWORD, SERVER_KEY, CLIENT_KEY, OTHER_KEY, CIPHERTEXT_SENTINEL]) {
    assert.ok(!text.includes(secret), `${label} must not leak secret material`)
  }
  assert.ok(!text.includes('x-bsv-auth-signature'), `${label} must not echo auth headers`)
  assert.ok(!text.includes('BEGIN'), `${label} must not echo key material`)
}

test('M2.1b valid signed context yields exactly the verified identity', async (t) => {
  const h = await createHarness(t)
  const probe = `${h.base}/v1/history/auth-context`
  const get = await authedJson(h.authFetch, probe, { method: 'GET' })
  assert.equal(get.status, 200)
  assert.equal(get.body.status, 'ok')
  assert.equal(get.body.ownerIdentityKey, h.clientId)
  assert.equal(get.body.checkedRecords, 0)
  const post = await authedJson(h.authFetch, probe, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(post.status, 200)
  assert.equal(post.body.ownerIdentityKey, h.clientId)
})

test('M2.1b unsigned and malformed auth fail without leaking', async (t) => {
  const h = await createHarness(t)
  const probe = `${h.base}/v1/history/auth-context`
  const unsigned = await fetchJson(probe)
  assert.equal(unsigned.status, 401)
  assertRedacted(unsigned.body, 'unsigned probe')
  const malformed = await fetchJson(probe, {
    method: 'GET',
    headers: {
      'x-bsv-auth-request-id': '!!!not-base64!!!',
      'x-bsv-auth-version': '1',
      'x-bsv-auth-identity-key': 'not-a-key',
      'x-bsv-auth-nonce': 'bad',
      'x-bsv-auth-your-nonce': 'bad',
      'x-bsv-auth-signature': '00',
    },
  })
  assert.ok([400, 401].includes(malformed.status), `malformed auth fails, got ${malformed.status}`)
  assertRedacted(malformed.body, 'malformed probe')
})

test('M2.1b mutated method/path/query/body signatures fail', async (t) => {
  const h = await createHarness(t)
  captured.length = 0
  const probe = `${h.base}/v1/history/auth-context?tag=one`
  const valid = await authedJson(h.authFetch, probe, { method: 'GET' })
  assert.equal(valid.status, 200)
  const signed = lastSignedRequest()
  assert.ok(signed, 'captured a signed general request')
  const headers = { ...signed.headers }

  const mutQuery = await fetchJson(`${h.base}/v1/history/auth-context?tag=two`, { method: 'GET', headers })
  assert.equal(mutQuery.status, 401, 'mutated query fails')
  const mutMethod = await fetchJson(signed.url, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(mutMethod.status, 401, 'mutated method fails')
  const mutPath = await fetchJson(`${h.base}/v1/history/other`, { method: 'GET', headers })
  assert.equal(mutPath.status, 401, 'mutated path fails')

  captured.length = 0
  const postValid = await authedJson(h.authFetch, `${h.base}/v1/history/auth-context`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hello: 'world' }),
  })
  assert.equal(postValid.status, 200)
  const postSigned = lastSignedRequest()
  assert.ok(postSigned, 'captured a signed POST')
  const mutBody = await fetchJson(postSigned.url, {
    method: 'POST', headers: { ...postSigned.headers }, body: JSON.stringify({ hello: 'tampered' }),
  })
  assert.equal(mutBody.status, 401, 'mutated body fails')
  for (const [label, res] of [['query', mutQuery], ['method', mutMethod], ['path', mutPath], ['body', mutBody]]) {
    assertRedacted(res.body, `mutated ${label}`)
  }
})

test('M2.1b replay window rejects verbatim reuse on the probe', async (t) => {
  const h = await createHarness(t)
  captured.length = 0
  const probe = `${h.base}/v1/history/auth-context`
  const valid = await authedJson(h.authFetch, probe, { method: 'GET' })
  assert.equal(valid.status, 200)
  const signed = lastSignedRequest()
  assert.ok(signed, 'captured the valid signed request')
  const replay = await fetchJson(signed.url, { method: 'GET', headers: { ...signed.headers } })
  assert.equal(replay.status, 401, 'reused request-id fails')
  assert.equal(replay.body?.code, 'ERR_AUTHENTICATION_REQUIRED')
  assertRedacted(replay.body, 'replay')
})

test('M2.1b.1 replay window covers every protected path, not the probe only', async (t) => {
  const h = await createHarness(t)
  captured.length = 0
  // A signed request to a second protected path (authenticated 404) mints a
  // windowed id; replaying it must fail with 401 rather than repeat the 404.
  const first = await authedJson(h.authFetch, `${h.base}/v1/history/nope`, { method: 'GET' })
  assert.equal(first.status, 404)
  const signed = lastSignedRequest()
  assert.ok(signed, 'captured the signed unknown-path request')
  const replay = await fetchJson(signed.url, { method: 'GET', headers: { ...signed.headers } })
  assert.equal(replay.status, 401, 'reused request-id fails on a non-probe protected path')
  assert.equal(replay.body?.code, 'ERR_AUTHENTICATION_REQUIRED')
  assertRedacted(replay.body, 'non-probe replay')
})

test('M2.1b.1 replay window unit semantics: FIFO eviction, handshake skip, fail-closed', async () => {
  const { createReplayGuard } = await import('../dist/server.js')
  const run = (guard, { path = '/v1/history/auth-context', requestId } = {}) => new Promise((resolve) => {
    const req = { path, headers: requestId === undefined ? {} : { 'x-bsv-auth-request-id': requestId } }
    guard.middleware(req, {}, (err) => resolve(err))
  })
  assert.throws(() => createReplayGuard({ limit: 0 }), TypeError, 'non-positive limit throws')

  const guard = createReplayGuard({ limit: 3 })
  assert.equal(await run(guard, { requestId: 'id-a' }), undefined)
  assert.equal(await run(guard, { requestId: 'id-b' }), undefined)
  assert.equal(await run(guard, { requestId: 'id-c' }), undefined)
  assert.equal(guard.seenCount(), 3)
  // Handshake ids are never windowed, even on reuse.
  assert.equal(await run(guard, { path: '/.well-known/auth', requestId: 'hs-1' }), undefined)
  assert.equal(await run(guard, { path: '/.well-known/auth', requestId: 'hs-1' }), undefined)
  assert.equal(guard.seenCount(), 3, 'handshake traffic does not consume the window')
  // Missing correlation id fails closed with a generic error.
  const missing = await run(guard, {})
  assert.equal(missing?.code, 'ERR_AUTHENTICATION_REQUIRED')
  assert.ok(!String(missing?.message).includes('id-a'), 'window errors never echo ids')
  // Fourth application id evicts the oldest: the window (not single-use)
  // admits the evicted id again while still rejecting a windowed one. Past
  // eviction the request falls back to upstream session/signature checks.
  assert.equal(await run(guard, { requestId: 'id-d' }), undefined)
  assert.equal(guard.seenCount(), 3)
  assert.equal(await run(guard, { requestId: 'id-a' }), undefined, 'evicted id falls through to upstream checks')
  const windowed = await run(guard, { requestId: 'id-c' })
  assert.equal(windowed?.code, 'ERR_AUTHENTICATION_REQUIRED', 'windowed id still rejected')
})

test('M2.1b.1 legitimate fresh retries never collide with the window', async (t) => {
  const h = await createHarness(t)
  const probe = `${h.base}/v1/history/auth-context`
  for (let i = 0; i < 3; i += 1) {
    const res = await authedJson(h.authFetch, probe, { method: 'GET' })
    assert.equal(res.status, 200, `fresh retry ${i} succeeds`)
    assert.equal(res.body.ownerIdentityKey, h.clientId)
  }
})

test('M2.1b expired server session rejects stolen auth material', async (t) => {
  const { createService } = await import('../dist/server.js')
  const serverWallet = walletFor(SERVER_KEY)
  const clientWallet = walletFor(CLIENT_KEY)
  const spy = { calls: 0 }
  const first = await createService({
    config: baseConfig(), knex: fakeKnex(), store: fakeStore(spy),
    migrate: async () => ['001-init'], auth: { wallet: serverWallet, sessionManager: new SessionManager() },
  })
  t.after(() => first.close())
  const s1 = await first.start(0, '127.0.0.1')
  const base1 = `http://127.0.0.1:${s1.address().port}`
  captured.length = 0
  const authFetch = new AuthFetch(clientWallet)
  const valid = await authedJson(authFetch, `${base1}/v1/history/auth-context`, { method: 'GET' })
  assert.equal(valid.status, 200)
  const signed = lastSignedRequest()
  assert.ok(signed, 'captured a signed request')
  await first.close()

  // Same server identity, fresh session table: the stolen headers bind to an
  // unknown session and must fail rather than select any owner.
  const second = await createService({
    config: baseConfig(), knex: fakeKnex(), store: fakeStore(spy),
    migrate: async () => ['001-init'], auth: { wallet: serverWallet, sessionManager: new SessionManager() },
  })
  t.after(() => second.close())
  const s2 = await second.start(0, '127.0.0.1')
  const base2 = `http://127.0.0.1:${s2.address().port}`
  const replayUrl = signed.url.replace(base1, base2)
  const expired = await fetchJson(replayUrl, { method: 'GET', headers: { ...signed.headers } })
  assert.equal(expired.status, 401, 'expired-session replay fails')
  assertRedacted(expired.body, 'expired session')
})

test('M2.1b body/query/path owner claims cannot override identity', async (t) => {
  const h = await createHarness(t)
  const otherId = await identityOf(walletFor(OTHER_KEY))
  assert.notEqual(otherId, h.clientId)
  const probe = `${h.base}/v1/history/auth-context`

  for (const url of [`${probe}?owner=${otherId}`, `${probe}?ownerIdentityKey=${otherId}`]) {
    const res = await authedJson(h.authFetch, url, { method: 'GET' })
    assert.equal(res.status, 403, `conflicting query claim fails: ${url}`)
    assert.equal(res.body?.code, 'ERR_FORBIDDEN')
    assertRedacted(res.body, 'query override')
  }
  const matchQuery = await authedJson(h.authFetch, `${probe}?owner=${h.clientId}`, { method: 'GET' })
  assert.equal(matchQuery.status, 200, 'matching query claim is ignored')

  for (const body of [{ owner: otherId }, { ownerIdentityKey: otherId }, { owner_identity_key: otherId }]) {
    const res = await authedJson(h.authFetch, probe, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(res.status, 403, `conflicting body claim fails: ${JSON.stringify(Object.keys(body))}`)
    assertRedacted(res.body, 'body override')
  }

  const pathMismatch = await authedJson(h.authFetch, `${probe}/${otherId}`, { method: 'GET' })
  assert.equal(pathMismatch.status, 403, 'conflicting path claim fails')
  const pathMatch = await authedJson(h.authFetch, `${probe}/${h.clientId}`, { method: 'GET' })
  assert.equal(pathMatch.status, 200, 'matching path claim is ignored')
  assert.equal(pathMatch.body.ownerIdentityKey, h.clientId)
})

test('M2.1b inbound/outbound ownership enforced before repository access', async (t) => {
  const h = await createHarness(t)
  const otherId = await identityOf(walletFor(OTHER_KEY))
  const probe = `${h.base}/v1/history/auth-context`
  const post = (body) => authedJson(h.authFetch, probe, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  const badInbound = await post({ records: [{ direction: 'inbound', sender: otherId, recipient: otherId }] })
  assert.equal(badInbound.status, 403, 'inbound recipient mismatch fails')
  const badOutbound = await post({ records: [{ direction: 'outbound', sender: otherId, recipient: h.clientId }] })
  assert.equal(badOutbound.status, 403, 'outbound sender mismatch fails')
  const malformed = await post({ records: [{ direction: 'sideways', sender: h.clientId, recipient: h.clientId }] })
  assert.equal(malformed.status, 400, 'malformed direction fails')
  assert.equal(h.spy.calls, 0, 'probe never reaches the repository on failure')

  const good = await post({
    records: [
      { direction: 'inbound', sender: otherId, recipient: h.clientId },
      { direction: 'outbound', sender: h.clientId, recipient: otherId },
    ],
  })
  assert.equal(good.status, 200)
  assert.equal(good.body.ownerIdentityKey, h.clientId)
  assert.equal(good.body.checkedRecords, 2)
  assert.equal(h.spy.calls, 0, 'probe never reaches the repository on success either')
})

test('M2.1b adapter rejects missing/invalid owners without echoes', async () => {
  const { resolveRequestOwner, assertNoOwnerOverride, assertArchiveOwnership } = await import('../dist/server.js')
  const owner = (await identityOf(walletFor(CLIENT_KEY)))
  assert.deepEqual(resolveRequestOwner({ auth: { identityKey: owner } }), { ownerIdentityKey: owner })
  for (const req of [{}, { auth: null }, { auth: {} }, { auth: { identityKey: 'unknown' } }, { auth: { identityKey: 'bad' } }]) {
    assert.throws(() => resolveRequestOwner(req), (e) => e?.code === 'ERR_AUTHENTICATION_REQUIRED')
  }
  assert.throws(() => assertNoOwnerOverride({ owner, body: { owner: 'other' } }), (e) => e?.code === 'ERR_FORBIDDEN')
  const otherOwner = '030000000000000000000000000000000000000000000000000000000000000001'
  assert.throws(
    () => assertArchiveOwnership({ owner, records: [{ direction: 'inbound', sender: owner, recipient: otherOwner }] }),
    (e) => e?.code === 'ERR_FORBIDDEN',
  )
})

test('M2.1b authenticated unknown route is a redacted 404', async (t) => {
  const h = await createHarness(t)
  const res = await authedJson(h.authFetch, `${h.base}/v1/history/nope`, { method: 'GET' })
  assert.equal(res.status, 404)
  assert.equal(res.body?.code, 'ERR_UNAVAILABLE')
  assertRedacted(res.body, 'authenticated 404')
})

test('M2.1b browser-safe entrypoints do not import the auth graph', async () => {
  const { readFileSync } = await import('node:fs')
  for (const rel of ['mod.ts', 'src/protocol.ts', 'src/client.ts', 'src/canonical.ts']) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    assert.ok(!/from\s+['"][^'"]*service(?:\.[^'"]*)?['"]/.test(source), `${rel} must not import service`)
    assert.ok(!source.includes('auth-express-middleware'), `${rel} must not import auth middleware`)
    assert.ok(!source.includes("from 'express"), `${rel} must not import express`)
  }
})
