import assert from 'node:assert/strict'
import { test } from 'node:test'

// Capture AuthFetch's signed wire requests for replay negatives. The SDK
// binds global fetch at import time, so the wrapper must be installed before
// the first '@bsv/sdk' import in this process.
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
const { createMemoryStore } = await import('../src/repository.mjs')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const SERVER_KEY = '33'.repeat(32)
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const BODY_A = '{"encryptedMessage":"AQ=="}'
const BODY_B = '{"encryptedMessage":"Ag=="}'
const BODY_SENTINEL = '{"encryptedMessage":"U0VOVElORUxfTVQyX01VTUFUSU9OU19DSVBIRVJUQVhU"}'

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

function inboundRecord({ messageId, owner, peer, body = BODY_A, ...extra }) {
  return { messageId, messageBox: 'inbox', direction: 'inbound', sender: peer, recipient: owner, body, ...extra }
}

function canonicalBodyOfSize(size) {
  const prefix = '{"encryptedMessage":"'
  const suffix = '"}'
  const payloadLength = Math.floor((size - prefix.length - suffix.length) / 4) * 4
  const core = `${prefix}${'A'.repeat(payloadLength)}${suffix}`
  return `${' '.repeat(size - core.length)}${core}`
}

async function createHarness(t, { serverKey = SERVER_KEY, storeLimits } = {}) {
  const { createService } = await import('../dist/server.js')
  const serverWallet = walletFor(serverKey)
  const clientWallet = walletFor(CLIENT_KEY)
  const otherWallet = walletFor(OTHER_KEY)
  const sessionManager = new SessionManager()
  const inner = createMemoryStore(storeLimits ? { limits: storeLimits } : {})
  const calls = []
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = target[prop]
      if (typeof value === 'function' && ['archiveBatch', 'patchState', 'deleteRecord', 'deleteAll', 'getUsage'].includes(prop)) {
        return async (args) => {
          calls.push({ method: prop, owner: args?.owner })
          return value.call(target, args)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const service = await createService({
    config: baseConfig(),
    knex: fakeKnex(),
    store,
    migrate: async () => ['001-init'],
    auth: { wallet: serverWallet, sessionManager },
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  const clientId = await identityOf(clientWallet)
  const otherId = await identityOf(otherWallet)
  assert.notEqual(clientId, otherId)
  return {
    service, store, calls, base, clientId, otherId,
    authFetch: new AuthFetch(clientWallet),
    otherFetch: new AuthFetch(otherWallet),
  }
}

async function authedJson(authFetch, url, config = {}) {
  const response = await authFetch.fetch(url, config)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

async function plainJson(url, options = {}) {
  const response = await plainFetch(url, options)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

const archive = (h, records, epoch = 'gen-1', fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch, records }),
  })

const patch = (h, recordKey, payload, fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/records/${recordKey}/state`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })

const deleteOne = (h, recordKey, query = '', body, fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/records/${recordKey}${query}`, {
    method: 'DELETE',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })

const deleteAll = (h, query = '', body, fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/records${query}`, {
    method: 'DELETE',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })

function assertRedacted(value, label) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, PASSWORD, SERVER_KEY, CLIENT_KEY, OTHER_KEY, BODY_A, BODY_B, BODY_SENTINEL]) {
    assert.ok(!text.includes(secret), `${label} must not leak secret or ciphertext material`)
  }
  assert.ok(!text.includes('x-bsv-auth-signature'), `${label} must not echo auth headers`)
  assert.ok(!text.includes('BEGIN'), `${label} must not echo key material`)
}

function assertOwnerCalls(h, label) {
  for (const call of h.calls) {
    assert.ok([h.clientId, h.otherId].includes(call.owner), `${label}: repository owner must be an authenticated identity`)
  }
}

// ---------------------------------------------------------------------------
// Archive batch
// ---------------------------------------------------------------------------

test('M2.1c archive success stores inbound and outbound under the verified owner', async (t) => {
  const h = await createHarness(t)
  const res = await archive(h, [
    outboundRecord({ messageId: 'm2c-arch-1', owner: h.clientId, peer: h.otherId }),
    inboundRecord({ messageId: 'm2c-arch-2', owner: h.clientId, peer: h.otherId }),
  ])
  assert.equal(res.status, 200)
  assert.equal(res.body.epoch, 'gen-1')
  assert.equal(res.body.committed, true)
  assert.equal(res.body.outcomes.length, 2)
  assert.deepEqual(res.body.outcomes.map((o) => o.outcome), ['stored', 'stored'])
  for (const outcome of res.body.outcomes) {
    assert.match(outcome.recordKey, /^[0-9a-f]{64}$/)
    assert.match(outcome.bodyHash, /^[0-9a-f]{64}$/)
    assert.ok(outcome.bodyBytes > 0)
    assert.ok(outcome.sequence)
  }
  assert.ok(h.calls.length >= 1 && h.calls.every((c) => c.owner === h.clientId && c.method === 'archiveBatch'))
  const usage = await h.store.getUsage({ owner: h.clientId })
  assert.equal(usage.recordCount, 2)
})

test('M2.1c archive idempotency replays without new quota', async (t) => {
  const h = await createHarness(t)
  const records = [outboundRecord({ messageId: 'm2c-idem-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })]
  const first = await archive(h, records)
  assert.equal(first.body.outcomes[0].outcome, 'stored')
  const usageBefore = await h.store.getUsage({ owner: h.clientId })
  const second = await archive(h, records)
  assert.equal(second.status, 200)
  assert.equal(second.body.outcomes[0].outcome, 'alreadyPresent')
  assert.equal(second.body.outcomes[0].recordKey, first.body.outcomes[0].recordKey)
  assert.deepEqual(await h.store.getUsage({ owner: h.clientId }), usageBefore)
})

test('M2.1c archive immutable conflict is a per-record outcome', async (t) => {
  const h = await createHarness(t)
  const first = await archive(h, [outboundRecord({ messageId: 'm2c-conf-1', owner: h.clientId, peer: h.otherId, body: BODY_A })])
  assert.equal(first.body.outcomes[0].outcome, 'stored')
  const second = await archive(h, [outboundRecord({ messageId: 'm2c-conf-1', owner: h.clientId, peer: h.otherId, body: BODY_B })])
  assert.equal(second.status, 200)
  assert.equal(second.body.outcomes[0].outcome, 'conflict')
  assert.equal(second.body.outcomes[0].errorCode, 'ERR_IMMUTABLE_CONFLICT')
  assertRedacted(second.body, 'conflict outcome')
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 1)
})

test('M2.1c archive stale epoch returns epochChanged without mutation', async (t) => {
  const h = await createHarness(t)
  const wiped = await deleteAll(h)
  assert.equal(wiped.status, 200)
  const freshEpoch = wiped.body.epoch
  assert.notEqual(freshEpoch, 'gen-1')
  const stale = await archive(h, [outboundRecord({ messageId: 'm2c-stale-1', owner: h.clientId, peer: h.otherId })], 'gen-1')
  assert.equal(stale.status, 200)
  assert.equal(stale.body.committed, false)
  assert.equal(stale.body.outcomes[0].outcome, 'epochChanged')
  assert.equal(stale.body.outcomes[0].errorCode, 'ERR_EPOCH_CHANGED')
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 0)
  const fresh = await archive(h, [outboundRecord({ messageId: 'm2c-stale-1', owner: h.clientId, peer: h.otherId })], freshEpoch)
  assert.equal(fresh.body.outcomes[0].outcome, 'stored')
})

test('M2.1c archive quotaExceeded is per-record and delete stays available at full quota', async (t) => {
  const h = await createHarness(t, { storeLimits: { MAX_RECORDS_PER_OWNER: 2 } })
  const rec = (n) => outboundRecord({ messageId: `m2c-quota-${n}`, owner: h.clientId, peer: h.otherId })
  const full = await archive(h, [rec(1), rec(2)])
  assert.deepEqual(full.body.outcomes.map((o) => o.outcome), ['stored', 'stored'])
  const over = await archive(h, [rec(3)])
  assert.equal(over.status, 200)
  assert.equal(over.body.outcomes[0].outcome, 'quotaExceeded')
  assert.equal(over.body.outcomes[0].errorCode, 'ERR_QUOTA_EXCEEDED')
  assertRedacted(over.body, 'quota outcome')
  // Deletion remains available at full quota and releases it.
  const key = full.body.outcomes[0].recordKey
  const del = await deleteOne(h, key)
  assert.equal(del.status, 200)
  assert.equal(del.body.deleted, true)
  const retry = await archive(h, [rec(3)])
  assert.equal(retry.body.outcomes[0].outcome, 'stored')
  assertOwnerCalls(h, 'quota')
})

test('M2.1c archive malformed shapes fail 400 without ciphertext echo', async (t) => {
  const h = await createHarness(t)
  const good = outboundRecord({ messageId: 'm2c-mal-0', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })
  const cases = [
    ['missing records', {}, 400, 'ERR_INVALID_RECORD'],
    ['empty records', { epoch: 'gen-1', records: [] }, 400, 'ERR_INVALID_RECORD'],
    ['records not array', { epoch: 'gen-1', records: {} }, 400, 'ERR_INVALID_RECORD'],
    ['bad epoch', { epoch: '!!!', records: [good] }, 400, 'ERR_INVALID_RECORD'],
    ['extra top-level field', { epoch: 'gen-1', records: [good], nonsense: 1 }, 400, 'ERR_INVALID_RECORD'],
    ['conflicting owner claim', { epoch: 'gen-1', records: [good], owner: h.otherId }, 403, 'ERR_FORBIDDEN'],
    ['missing body', { epoch: 'gen-1', records: [{ messageId: 'x', messageBox: 'inbox', direction: 'outbound', sender: h.clientId, recipient: h.otherId }] }, 400, 'ERR_INVALID_RECORD'],
    ['bad direction', { epoch: 'gen-1', records: [{ ...good, direction: 'sideways' }] }, 400, 'ERR_INVALID_RECORD'],
    ['extra record field', { epoch: 'gen-1', records: [{ ...good, pricing: 1 }] }, 400, 'ERR_INVALID_RECORD'],
    ['bad delivery state', { epoch: 'gen-1', records: [{ ...good, deliveryState: 'accepted' }] }, 400, 'ERR_INVALID_RECORD'],
    ['bad sender', { epoch: 'gen-1', records: [{ ...good, sender: 'not-a-key' }] }, 400, 'ERR_INVALID_RECORD'],
  ]
  for (const [label, payload, status, code] of cases) {
    const res = await authedJson(h.authFetch, `${h.base}/v1/history/records`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert.equal(res.status, status, label)
    assert.equal(res.body?.code, code, label)
    assertRedacted(res.body, label)
  }
  assert.equal(h.calls.length, 0, 'malformed archive never reaches the repository')
  // Malformed JSON fails in the body parser before the auth middleware runs,
  // so the typed 400 carries no BRC response signature and must be read over
  // a plain fetch (AuthFetch itself rejects unsigned error responses).
  const raw = await plainJson(`${h.base}/v1/history/records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
  })
  assert.equal(raw.status, 400)
  assert.equal(raw.body?.code, 'ERR_INVALID_RECORD')
  assertRedacted(raw.body, 'malformed JSON')
})

test('M2.1c archive oversized batch fails 413; oversized single body is per-record', async (t) => {
  const h = await createHarness(t)
  const rec = (n) => outboundRecord({ messageId: `m2c-big-${n}`, owner: h.clientId, peer: h.otherId })
  // The M2.2a.1 early batch bound rejects >100 records before authentication,
  // so the 413 is unsigned (no BRC response signature) and must be read over
  // a plain fetch; AuthFetch itself rejects unsigned error responses.
  const tooMany = await plainJson(`${h.base}/v1/history/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ epoch: 'gen-1', records: Array.from({ length: 101 }, (_, i) => rec(i)) }),
  })
  assert.equal(tooMany.status, 413)
  assert.equal(tooMany.body?.code, 'ERR_REQUEST_TOO_LARGE')
  assertRedacted(tooMany.body, 'oversized batch')
  const exact = await archive(h, [outboundRecord({ messageId: 'm2c-cap-exact', owner: h.clientId, peer: h.otherId, body: canonicalBodyOfSize(1024 * 1024) })])
  assert.equal(exact.status, 200)
  assert.equal(exact.body.outcomes[0].outcome, 'stored')
  const capPlusOne = await archive(h, [outboundRecord({ messageId: 'm2c-cap-plus-one', owner: h.clientId, peer: h.otherId, body: canonicalBodyOfSize(1024 * 1024 + 1) })])
  assert.equal(capPlusOne.status, 200)
  assert.equal(capPlusOne.body.outcomes[0].outcome, 'invalid')
  assert.equal(capPlusOne.body.outcomes[0].errorCode, 'ERR_REQUEST_TOO_LARGE')
  assertRedacted(capPlusOne.body, 'record cap plus one')
  // One body over 1 MiB stays a per-record outcome, HTTP 200, while retaining
  // the typed size code from the repository. The body is never echoed.
  const huge = `{"encryptedMessage":"${'Q'.repeat(1024 * 1024 + 64)}"}`
  const single = await archive(h, [outboundRecord({ messageId: 'm2c-huge-1', owner: h.clientId, peer: h.otherId, body: huge })])
  assert.equal(single.status, 200)
  assert.equal(single.body.outcomes[0].outcome, 'invalid')
  assert.equal(single.body.outcomes[0].errorCode, 'ERR_REQUEST_TOO_LARGE')
  assert.ok(!JSON.stringify(single.body).includes(huge.slice(0, 64)), 'oversized body is not echoed')
})

test('M2.1c mutation schemas reject primitive bodies and unknown queries before repository access', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-shape-base')
  h.calls.length = 0
  const validArchive = JSON.stringify({ epoch: 'gen-1', records: [outboundRecord({ messageId: 'm2c-shape-archive', owner: h.clientId, peer: h.otherId })] })
  const validPatch = JSON.stringify({ newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-shape-patch' })
  const cases = [
    ['archive unknown query', `${h.base}/v1/history/records?surprise=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validArchive }],
    ['archive primitive body', `${h.base}/v1/history/records`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(42) }],
    ['patch unknown query', `${h.base}/v1/history/records/${key}/state?surprise=1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: validPatch }],
    ['patch array body', `${h.base}/v1/history/records/${key}/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) }],
    ['patch null body', `${h.base}/v1/history/records/${key}/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(null) }],
    ['delete-one primitive body', `${h.base}/v1/history/records/${key}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify('destructive') }],
    ['delete-one array body', `${h.base}/v1/history/records/${key}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) }],
    ['delete-one unknown body', `${h.base}/v1/history/records/${key}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ surprise: 1 }) }],
    ['delete-one unknown query', `${h.base}/v1/history/records/${key}?surprise=1`, { method: 'DELETE' }],
    ['delete-all primitive body', `${h.base}/v1/history/records`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(42) }],
    ['delete-all array body', `${h.base}/v1/history/records`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) }],
    ['delete-all unknown body', `${h.base}/v1/history/records`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ surprise: 1 }) }],
    ['delete-all unknown query', `${h.base}/v1/history/records?surprise=1`, { method: 'DELETE' }],
    ['delete-one discordant idempotency', `${h.base}/v1/history/records/${key}?idempotencyKey=query-one`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'body-one' }) }],
    ['delete-all discordant idempotency', `${h.base}/v1/history/records?idempotencyKey=query-all`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'body-all' }) }],
    ['delete-all discordant epoch', `${h.base}/v1/history/records?expectedEpoch=gen-1`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedEpoch: 'gen-2' }) }],
  ]
  for (const [label, url, init] of cases) {
    const result = await authedJson(h.authFetch, url, init)
    assert.equal(result.status, 400, label)
    assert.equal(result.body?.code, 'ERR_INVALID_RECORD', label)
    assertRedacted(result.body, label)
  }
  assert.equal(h.calls.length, 0, 'rejected mutation shapes never reach the repository')
})

test('M2.1c archive ownership gate fails 403 before repository access', async (t) => {
  const h = await createHarness(t)
  const badInbound = await archive(h, [inboundRecord({ messageId: 'm2c-own-1', owner: h.otherId, peer: h.clientId })])
  assert.equal(badInbound.status, 403)
  assert.equal(badInbound.body?.code, 'ERR_FORBIDDEN')
  const badOutbound = await archive(h, [outboundRecord({ messageId: 'm2c-own-2', owner: h.otherId, peer: h.clientId })])
  assert.equal(badOutbound.status, 403)
  assert.equal(badOutbound.body?.code, 'ERR_FORBIDDEN')
  assert.equal(h.calls.length, 0, 'ownership failures never reach the repository')
  assertRedacted(badInbound.body, 'ownership gate')
})

test('M2.1c archive method/path and unsigned callers', async (t) => {
  const h = await createHarness(t)
  // M2.1d: GET on the collection path is browse (200), not a method error.
  const get = await authedJson(h.authFetch, `${h.base}/v1/history/records`, { method: 'GET' })
  assert.equal(get.status, 200)
  assert.ok(Array.isArray(get.body.records))
  const put = await authedJson(h.authFetch, `${h.base}/v1/history/records`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(put.status, 404)
  const unsigned = await plainJson(`${h.base}/v1/history/records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(unsigned.status, 401)
  // Unsigned requests fail the service's pre-middleware gate with the shared
  // schema-valid redacted 401 envelope (mbs-8g5.3.1.5).
  assertRedacted(unsigned.body, 'unsigned archive')
})

// ---------------------------------------------------------------------------
// Delivery-state patch
// ---------------------------------------------------------------------------

async function archiveOne(h, messageId, body = BODY_A) {
  const res = await archive(h, [outboundRecord({ messageId, owner: h.clientId, peer: h.otherId, body })])
  assert.equal(res.status, 200)
  assert.equal(res.body.outcomes[0].outcome, 'stored')
  return res.body.outcomes[0].recordKey
}

test('M2.1c patch success advances revision and sequence', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-patch-1')
  const res = await patch(h, key, { newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-1-k1' })
  assert.equal(res.status, 200)
  assert.equal(res.body.recordKey, key)
  assert.equal(res.body.revision, '2')
  assert.ok(res.body.sequence)
  assert.ok(h.calls.some((c) => c.method === 'patchState' && c.owner === h.clientId))
  assert.equal(h.store.getRecord({ owner: h.clientId, recordKey: key }).deliveryState, 'accepted')
})

test('M2.1c patch idempotency replays; reuse with different input conflicts', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-patch-2')
  const first = await patch(h, key, { newState: 'unknown', expectedRevision: '1', idempotencyKey: 'm2c-patch-2-k1' })
  assert.equal(first.status, 200)
  const replay = await patch(h, key, { newState: 'unknown', expectedRevision: '1', idempotencyKey: 'm2c-patch-2-k1' })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.revision, first.body.revision)
  assert.equal(replay.body.sequence, first.body.sequence)
  assert.equal(replay.body.replayed, true)
  const conflict = await patch(h, key, { newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-2-k1' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body?.code, 'ERR_IDEMPOTENCY_CONFLICT')
  assertRedacted(conflict.body, 'patch idempotency conflict')
})

test('M2.1c patch stale CAS and accepted downgrade fail 409; missing fields fail 400', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-patch-3')
  const stale = await patch(h, key, { newState: 'accepted', expectedRevision: '99', idempotencyKey: 'm2c-patch-3-k1' })
  assert.equal(stale.status, 409)
  assert.equal(stale.body?.code, 'ERR_REVISION_CONFLICT')
  const accepted = await patch(h, key, { newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-3-k2' })
  assert.equal(accepted.status, 200)
  const downgrade = await patch(h, key, { newState: 'unknown', expectedRevision: accepted.body.revision, idempotencyKey: 'm2c-patch-3-k3' })
  assert.equal(downgrade.status, 409)
  assert.equal(downgrade.body?.code, 'ERR_REVISION_CONFLICT')
  for (const [label, payload] of [
    ['missing revision', { newState: 'accepted', idempotencyKey: 'm2c-patch-3-k4' }],
    ['missing key', { newState: 'accepted', expectedRevision: '2' }],
    ['bad revision', { newState: 'accepted', expectedRevision: 'nope', idempotencyKey: 'm2c-patch-3-k5' }],
    ['bad state', { newState: 'flying', expectedRevision: '2', idempotencyKey: 'm2c-patch-3-k6' }],
    ['bad key', { newState: 'accepted', expectedRevision: '2', idempotencyKey: '!!!' }],
    ['extra field', { newState: 'accepted', expectedRevision: '2', idempotencyKey: 'm2c-patch-3-k7', owner: h.clientId }],
  ]) {
    const res = await patch(h, key, payload)
    assert.ok([400, 403].includes(res.status), label)
    assertRedacted(res.body, label)
  }
})

test('M2.1c patch missing and deleted records fail 400 without oracle', async (t) => {
  const h = await createHarness(t)
  const missingKey = 'f'.repeat(64)
  const missing = await patch(h, missingKey, { newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-4-k1' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body?.code, 'ERR_INVALID_RECORD')
  const key = await archiveOne(h, 'm2c-patch-4', BODY_SENTINEL)
  const del = await deleteOne(h, key)
  assert.equal(del.body.deleted, true)
  const afterDelete = await patch(h, key, { newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-4-k2' })
  assert.equal(afterDelete.status, 400)
  assert.equal(afterDelete.body?.code, 'ERR_INVALID_RECORD')
  assertRedacted(afterDelete.body, 'patch after delete')
})

test('M2.1c patch validates path key, key agreement, method and auth', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-patch-5')
  const badPath = await patch(h, 'not-hex', { newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-5-k1' })
  assert.equal(badPath.status, 400)
  const mismatch = await patch(h, key, { recordKey: 'e'.repeat(64), newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-5-k2' })
  assert.equal(mismatch.status, 403)
  const get = await authedJson(h.authFetch, `${h.base}/v1/history/records/${key}/state`, { method: 'GET' })
  assert.equal(get.status, 404)
  const unsigned = await plainJson(`${h.base}/v1/history/records/${key}/state`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-5-k3' }),
  })
  assert.equal(unsigned.status, 401)
})

test('M2.1c patch is owner-scoped: cross-owner patch cannot touch the record', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-patch-6')
  const cross = await patch(h, key, { newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2c-patch-6-x' }, h.otherFetch)
  assert.equal(cross.status, 400)
  assert.equal(cross.body?.code, 'ERR_INVALID_RECORD')
  assertRedacted(cross.body, 'cross-owner patch')
  assert.equal(h.store.getRecord({ owner: h.clientId, recordKey: key }).deliveryState, 'prepared')
  assert.equal(h.store.getRecord({ owner: h.otherId, recordKey: key }), null)
  assert.ok(h.calls.some((c) => c.method === 'patchState' && c.owner === h.otherId))
})

// ---------------------------------------------------------------------------
// Delete one
// ---------------------------------------------------------------------------

test('M2.1c delete-one success purges body, releases quota and is repeatable', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-del-1', BODY_SENTINEL)
  const before = await h.store.getUsage({ owner: h.clientId })
  const res = await deleteOne(h, key)
  assert.equal(res.status, 200)
  assert.equal(res.body.deleted, true)
  assert.ok(res.body.sequence)
  assert.equal(res.body.epoch, before.epoch)
  assert.equal(h.store.getRecord({ owner: h.clientId, recordKey: key }), null)
  const after = await h.store.getUsage({ owner: h.clientId })
  assert.equal(after.recordCount, before.recordCount - 1)
  assert.ok(after.byteCount < before.byteCount)
  const unknown = await deleteOne(h, 'd'.repeat(64))
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.deleted, false)
  assertRedacted(res.body, 'delete-one success')
})

test('M2.1c delete-one idempotency replays; key reuse across operations conflicts', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-del-2')
  const first = await deleteOne(h, key, '?idempotencyKey=m2c-del-2-k1')
  assert.equal(first.body.deleted, true)
  const replay = await deleteOne(h, key, '?idempotencyKey=m2c-del-2-k1')
  assert.equal(replay.status, 200)
  assert.equal(replay.body.sequence, first.body.sequence)
  assert.equal(replay.body.replayed, true)
  const conflict = await deleteOne(h, 'e'.repeat(64), '?idempotencyKey=m2c-del-2-k1')
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body?.code, 'ERR_IDEMPOTENCY_CONFLICT')
})

test('M2.1c delete-one accepts body idempotency key and validates input', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-del-3')
  const viaBody = await deleteOne(h, key, '', { idempotencyKey: 'm2c-del-3-k1' })
  assert.equal(viaBody.status, 200)
  assert.equal(viaBody.body.deleted, true)
  const badPath = await deleteOne(h, 'short')
  assert.equal(badPath.status, 400)
  const badKey = await deleteOne(h, key, '?idempotencyKey=!!!')
  assert.equal(badKey.status, 400)
  const mismatch = await deleteOne(h, key, '', { recordKey: 'e'.repeat(64) })
  assert.equal(mismatch.status, 403)
  const get = await authedJson(h.authFetch, `${h.base}/v1/history/records/${key}`, { method: 'GET' })
  assert.equal(get.status, 404)
  const unsigned = await plainJson(`${h.base}/v1/history/records/${key}`, { method: 'DELETE' })
  assert.equal(unsigned.status, 401)
})

test('M2.1c delete-one is owner-scoped', async (t) => {
  const h = await createHarness(t)
  const key = await archiveOne(h, 'm2c-del-4', BODY_SENTINEL)
  const cross = await deleteOne(h, key, '', undefined, h.otherFetch)
  assert.equal(cross.status, 200)
  assert.equal(cross.body.deleted, false)
  assertRedacted(cross.body, 'cross-owner delete')
  assert.notEqual(h.store.getRecord({ owner: h.clientId, recordKey: key }), null)
})

// ---------------------------------------------------------------------------
// Delete all
// ---------------------------------------------------------------------------

test('M2.1c delete-all rotates epoch and fences stale writes', async (t) => {
  const h = await createHarness(t)
  const before = await h.store.getUsage({ owner: h.clientId })
  await archiveOne(h, 'm2c-wipe-1')
  const wiped = await deleteAll(h)
  assert.equal(wiped.status, 200)
  assert.notEqual(wiped.body.epoch, before.epoch)
  const usage = await h.store.getUsage({ owner: h.clientId })
  assert.equal(usage.recordCount, 0)
  assert.equal(usage.byteCount, 0)
  assert.equal(usage.epoch, wiped.body.epoch)
  const stale = await archive(h, [outboundRecord({ messageId: 'm2c-wipe-2', owner: h.clientId, peer: h.otherId })], before.epoch)
  assert.equal(stale.body.outcomes[0].outcome, 'epochChanged')
  const fresh = await archive(h, [outboundRecord({ messageId: 'm2c-wipe-2', owner: h.clientId, peer: h.otherId })], wiped.body.epoch)
  assert.equal(fresh.body.outcomes[0].outcome, 'stored')
  assertOwnerCalls(h, 'delete-all')
})

test('M2.1c delete-all idempotency does not rotate twice; CAS guards stale wipes', async (t) => {
  const h = await createHarness(t)
  const rec = (messageId) => outboundRecord({ messageId, owner: h.clientId, peer: h.otherId })
  await archiveOne(h, 'm2c-wipe-3')
  const first = await deleteAll(h, '?idempotencyKey=m2c-wipe-3-k1')
  assert.equal(first.status, 200)
  const replay = await deleteAll(h, '?idempotencyKey=m2c-wipe-3-k1')
  assert.equal(replay.status, 200)
  assert.equal(replay.body.epoch, first.body.epoch)
  assert.equal(replay.body.replayed, true)
  // Epoch has rotated past gen-1: thread it explicitly from here on.
  const epoch2 = first.body.epoch
  const seeded = await archive(h, [rec('m2c-wipe-4')], epoch2)
  assert.equal(seeded.body.outcomes[0].outcome, 'stored')
  const guarded = await deleteAll(h, `?expectedEpoch=${epoch2}`)
  assert.equal(guarded.status, 200)
  const epoch3 = guarded.body.epoch
  assert.notEqual(epoch3, epoch2)
  const postWipe = await archive(h, [rec('m2c-wipe-5')], epoch3)
  assert.equal(postWipe.body.outcomes[0].outcome, 'stored')
  const staleCas = await deleteAll(h, `?expectedEpoch=${epoch2}`)
  assert.equal(staleCas.status, 409)
  assert.equal(staleCas.body?.code, 'ERR_EPOCH_CHANGED')
  assertRedacted(staleCas.body, 'stale delete-all CAS')
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 1, 'stale CAS mutates nothing')
  const bodyCas = await deleteAll(h, '', { expectedEpoch: 'gen-0-stale' })
  assert.equal(bodyCas.status, 409)
  const badCas = await deleteAll(h, '?expectedEpoch=!!!')
  assert.equal(badCas.status, 400)
})

test('M2.1c delete-all CAS is atomic under concurrent requests and exact retries replay', async (t) => {
  const h = await createHarness(t)
  await archiveOne(h, 'm2c-wipe-cas-1')
  const expectedEpoch = (await h.store.getUsage({ owner: h.clientId })).epoch
  h.calls.length = 0
  const [left, right] = await Promise.all([
    deleteAll(h, `?expectedEpoch=${expectedEpoch}`),
    deleteAll(h, `?expectedEpoch=${expectedEpoch}`),
  ])
  assert.deepEqual([left.status, right.status].sort((a, b) => a - b), [200, 409])
  const winner = left.status === 200 ? left : right
  const loser = left.status === 409 ? left : right
  assert.equal(loser.body?.code, 'ERR_EPOCH_CHANGED')
  assert.equal(h.calls.filter((call) => call.method === 'getUsage').length, 0, 'route does not pre-read usage')
  assert.equal((await h.store.getUsage({ owner: h.clientId })).epoch, winner.body.epoch)
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 0)

  const replayKey = 'm2c-wipe-cas-replay'
  const replaySeed = await archive(h, [outboundRecord({ messageId: 'm2c-wipe-cas-2', owner: h.clientId, peer: h.otherId })], winner.body.epoch)
  assert.equal(replaySeed.body.outcomes[0].outcome, 'stored')
  const first = await deleteAll(h, `?expectedEpoch=${winner.body.epoch}&idempotencyKey=${replayKey}`)
  assert.equal(first.status, 200)
  const next = await archive(h, [outboundRecord({ messageId: 'm2c-wipe-cas-3', owner: h.clientId, peer: h.otherId })], first.body.epoch)
  assert.equal(next.body.outcomes[0].outcome, 'stored')
  const replay = await deleteAll(h, `?expectedEpoch=${winner.body.epoch}&idempotencyKey=${replayKey}`)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.epoch, first.body.epoch)
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 1, 'exact replay does not erase newer history')
  const conflict = await deleteAll(h, `?expectedEpoch=${first.body.epoch}&idempotencyKey=${replayKey}`)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body?.code, 'ERR_IDEMPOTENCY_CONFLICT')
})

test('M2.1c delete-all rejects present-but-invalid CAS and idempotency fields before repository access', async (t) => {
  const h = await createHarness(t)
  await archiveOne(h, 'm2c-wipe-guard-1')
  const before = await h.store.getUsage({ owner: h.clientId })
  const { validateDeleteAllInput, validateDeleteOneInput } = await import('../dist/server.js')

  // Direct validator: present-but-invalid values are 400, not "omitted".
  for (const args of [
    { query: { expectedEpoch: '' }, body: undefined },
    { query: {}, body: { expectedEpoch: null } },
    { query: { expectedEpoch: null }, body: undefined },
    { query: { idempotencyKey: '' }, body: undefined },
    { query: {}, body: { idempotencyKey: null } },
    { query: {}, body: { idempotencyKey: '' } },
  ]) {
    assert.throws(
      () => validateDeleteAllInput(args),
      (e) => e?.code === 'ERR_INVALID_RECORD' && e?.statusCode === 400,
      JSON.stringify(args),
    )
  }
  // Valid omission and valid values keep working.
  assert.deepEqual(validateDeleteAllInput({ query: {}, body: undefined }), { idempotencyKey: undefined, expectedEpoch: undefined })
  assert.deepEqual(
    validateDeleteAllInput({ query: { expectedEpoch: 'gen-7', idempotencyKey: 'm2c-k' }, body: undefined }),
    { idempotencyKey: 'm2c-k', expectedEpoch: 'gen-7' },
  )
  assert.throws(
    () => validateDeleteOneInput({ pathRecordKey: 'a'.repeat(64), query: {}, body: { idempotencyKey: '' } }),
    (e) => e?.code === 'ERR_INVALID_RECORD',
  )

  // Signed route: every malformed guard field fails 400 with zero repository calls.
  h.calls.length = 0
  const cases = [
    ['empty epoch query', '?expectedEpoch=', undefined],
    ['null epoch body', '', { expectedEpoch: null }],
    ['empty epoch body', '', { expectedEpoch: '' }],
    ['empty idempotency query', '?idempotencyKey=', undefined],
    ['null idempotency body', '', { idempotencyKey: null }],
    ['empty idempotency body', '', { idempotencyKey: '' }],
  ]
  for (const [label, query, body] of cases) {
    const res = await deleteAll(h, query, body)
    assert.equal(res.status, 400, label)
    assert.equal(res.body?.code, 'ERR_INVALID_RECORD', label)
    assertRedacted(res.body, label)
  }
  assert.equal(h.calls.length, 0, 'invalid guard fields never reach the repository')
  assert.deepEqual(await h.store.getUsage({ owner: h.clientId }), before, 'history and epoch are unchanged')
})

test('M2.1c delete-all is owner-scoped and rejects wrong methods and unsigned callers', async (t) => {
  const h = await createHarness(t)
  await archiveOne(h, 'm2c-wipe-6')
  const cross = await deleteAll(h, '', undefined, h.otherFetch)
  assert.equal(cross.status, 200)
  assert.equal((await h.store.getUsage({ owner: h.clientId })).recordCount, 1)
  assert.equal((await h.store.getUsage({ owner: h.otherId })).recordCount, 0)
  // M2.1d: GET on the collection path is browse (200). Wrong-method proof
  // uses PUT, which remains an authenticated 404.
  const put = await authedJson(h.authFetch, `${h.base}/v1/history/records`, { method: 'PUT' })
  assert.equal(put.status, 404)
  const unsigned = await plainJson(`${h.base}/v1/history/records`, { method: 'DELETE' })
  assert.equal(unsigned.status, 401)
})

// ---------------------------------------------------------------------------
// Cross-cutting: replay window and redaction over mutation routes
// ---------------------------------------------------------------------------

test('M2.1c replayed signed mutation requests fail closed', async (t) => {
  const h = await createHarness(t)
  captured.length = 0
  const first = await archive(h, [outboundRecord({ messageId: 'm2c-replay-1', owner: h.clientId, peer: h.otherId })])
  assert.equal(first.status, 200)
  const signed = [...captured].reverse().find((c) => c?.headers?.['x-bsv-auth-signature'])
  assert.ok(signed, 'captured the signed archive request')
  const replay = await plainJson(signed.url, { method: 'POST', headers: { ...signed.headers }, body: signed.body })
  assert.equal(replay.status, 401)
  assert.equal(replay.body?.code, 'ERR_AUTHENTICATION_REQUIRED')
})
