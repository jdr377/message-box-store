import 'dotenv/config'
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
const { JSON_SCHEMAS } = await import('../src/protocol.mjs')
const { snapshotFilterHash } = await import('../src/snapshots.mjs')
const Ajv2020 = (await import('ajv/dist/2020.js')).default
const { default: addFormats } = await import('ajv-formats')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const SERVER_KEY = '33'.repeat(32)
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const BODY_A = '{"encryptedMessage":"AQ=="}'
const BODY_B = '{"encryptedMessage":"Ag=="}'
const BODY_SENTINEL = '{"encryptedMessage":"U0VOVElORUxfTVQyX1JFVFJJRVZBTF9DSVBIRVJUQVhU"}'

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

function outboundRecord({ messageId, owner, peer, body = BODY_A, messageBox = 'inbox', ...extra }) {
  return { messageId, messageBox, direction: 'outbound', sender: owner, recipient: peer, body, ...extra }
}

function inboundRecord({ messageId, owner, peer, body = BODY_A, messageBox = 'inbox', ...extra }) {
  return { messageId, messageBox, direction: 'inbound', sender: peer, recipient: owner, body, ...extra }
}

async function createHarness(t, { serverKey = SERVER_KEY, storeLimits, storeNow } = {}) {
  const { createService } = await import('../dist/server.js')
  const serverWallet = walletFor(serverKey)
  const clientWallet = walletFor(CLIENT_KEY)
  const otherWallet = walletFor(OTHER_KEY)
  const sessionManager = new SessionManager()
  const inner = createMemoryStore({ ...(storeLimits ? { limits: storeLimits } : {}), ...(storeNow ? { now: storeNow } : {}) })
  const calls = []
  const tracked = ['archiveBatch', 'patchState', 'deleteRecord', 'deleteAll', 'listBrowse', 'listChangesPage', 'listSnapshotPage', 'createSnapshot', 'getUsage']
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = target[prop]
      if (typeof value === 'function' && tracked.includes(prop)) {
        return async (args) => {
          calls.push({ method: prop, owner: args?.owner })
          return value.call(target, args)
        }
      }
      if (prop === '_debug') return target._debug
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
    service, store: inner, proxied: store, calls, base, clientId, otherId,
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

function compile(name) {
  const instance = new Ajv2020({ strict: true, allErrors: true })
  addFormats(instance)
  return instance.compile(JSON_SCHEMAS[name])
}

const validateHistoryRecord = compile('historyRecord')
const validateHistoryPage = compile('historyPage')
const validateChangePage = compile('changeFeedPage')
const validateSnapshotCreate = compile('snapshotCreateResponse')
const validateStoreError = compile('storeError')

const archive = (h, records, epoch = 'gen-1', fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch, records }),
  })

const browse = (h, query = '', fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/records${query}`, { method: 'GET' })

const changes = (h, query = '', fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/changes${query}`, { method: 'GET' })

const snapshotCreate = (h, body, fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/snapshot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })

const snapshotPage = (h, query, fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/snapshot${query}`, { method: 'GET' })

const usage = (h, query = '', fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/usage${query}`, { method: 'GET' })

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

function qs(params) {
  const parts = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

test('M2.1d browse success round-trips historyRecord schema with filters', async (t) => {
  const h = await createHarness(t)
  await archive(h, [
    outboundRecord({ messageId: 'm2d-browse-1', owner: h.clientId, peer: h.otherId, messageBox: 'inbox' }),
    inboundRecord({ messageId: 'm2d-browse-2', owner: h.clientId, peer: h.otherId, messageBox: 'other-box' }),
    outboundRecord({ messageId: 'm2d-browse-3', owner: h.clientId, peer: h.otherId, messageBox: 'inbox' }),
  ])
  const all = await browse(h)
  assert.equal(all.status, 200)
  assert.equal(all.body.records.length, 3)
  for (const record of all.body.records) {
    assert.equal(validateHistoryRecord(record), true, JSON.stringify(validateHistoryRecord.errors))
  }
  assert.equal(all.body.nextAfter, null)
  // Ordering is (createdAt, recordKey).
  const times = all.body.records.map((r) => r.createdAt)
  assert.ok(times[0] <= times[1] && times[1] <= times[2])

  const filtered = await browse(h, qs({ direction: 'inbound' }))
  assert.equal(filtered.status, 200)
  assert.equal(filtered.body.records.length, 1)
  assert.equal(filtered.body.records[0].direction, 'inbound')

  const byBox = await browse(h, qs({ messageBox: 'other-box' }))
  assert.equal(byBox.body.records.length, 1)

  const byPeer = await browse(h, qs({ participant: h.otherId }))
  assert.equal(byPeer.body.records.length, 3)

  const byOtherPeer = await browse(h, qs({ participant: h.clientId }))
  // Participant matches sender OR recipient: outbound sender==owner matches clientId.
  assert.ok(byOtherPeer.body.records.length >= 2)
  assertOwnerCalls(h, 'browse')
})

test('M2.1d browse paging via after keyset is gap-free', async (t) => {
  const h = await createHarness(t)
  const recs = [1, 2, 3, 4, 5].map((n) => outboundRecord({ messageId: `m2d-bpage-${n}`, owner: h.clientId, peer: h.otherId }))
  const archived = await archive(h, recs)
  assert.equal(archived.body.outcomes.filter((o) => o.outcome === 'stored').length, 5)
  const seen = []
  let after = null
  for (let i = 0; i < 5; i += 1) {
    const query = after === null ? qs({ limit: '2' }) : qs({ limit: '2', afterCreatedAt: after.createdAt, afterRecordKey: after.recordKey })
    const page = await browse(h, query)
    assert.equal(page.status, 200)
    for (const record of page.body.records) {
      assert.equal(validateHistoryRecord(record), true)
    }
    seen.push(...page.body.records.map((r) => r.recordKey))
    if (page.body.nextAfter === null) break
    after = page.body.nextAfter
    assert.ok(after.createdAt && after.recordKey)
  }
  assert.equal(seen.length, 5)
  assert.equal(new Set(seen).size, 5)
})

test('M2.1d browse query misuse fails 400/403 without repository oracle', async (t) => {
  const h = await createHarness(t)
  await archive(h, [outboundRecord({ messageId: 'm2d-bq-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
  const before = h.calls.length
  const cases = [
    ['unknown key', qs({ nope: '1' }), 400, 'ERR_INVALID_RECORD'],
    ['bad limit zero', qs({ limit: '0' }), 400, 'ERR_INVALID_RECORD'],
    ['bad limit over', qs({ limit: '1001' }), 400, 'ERR_INVALID_RECORD'],
    ['bad limit text', qs({ limit: 'many' }), 400, 'ERR_INVALID_RECORD'],
    ['after half', qs({ afterCreatedAt: new Date().toISOString() }), 400, 'ERR_INVALID_RECORD'],
    ['after bad date', qs({ afterCreatedAt: 'not-a-date', afterRecordKey: 'a'.repeat(64) }), 400, 'ERR_INVALID_RECORD'],
    ['after numeric epoch', qs({ afterCreatedAt: '0', afterRecordKey: 'a'.repeat(64) }), 400, 'ERR_INVALID_RECORD'],
    ['after date-only', qs({ afterCreatedAt: '2026-01-01', afterRecordKey: 'a'.repeat(64) }), 400, 'ERR_INVALID_RECORD'],
    ['after rfc7231', qs({ afterCreatedAt: new Date().toUTCString(), afterRecordKey: 'a'.repeat(64) }), 400, 'ERR_INVALID_RECORD'],
    ['after offset alias', qs({ afterCreatedAt: '2026-01-01T00:00:00+00:00', afterRecordKey: 'a'.repeat(64) }), 400, 'ERR_INVALID_RECORD'],
    ['after offset zone', qs({ afterCreatedAt: '2026-01-01T00:00:00.000+01:00', afterRecordKey: 'a'.repeat(64) }), 400, 'ERR_INVALID_RECORD'],
    ['after nanosecond alias', qs({ afterCreatedAt: '2026-01-01T00:00:00.1234567Z', afterRecordKey: 'a'.repeat(64) }), 400, 'ERR_INVALID_RECORD'],
    ['after rolled-over date', qs({ afterCreatedAt: '2026-02-30T00:00:00Z', afterRecordKey: 'a'.repeat(64) }), 400, 'ERR_INVALID_RECORD'],
    ['after bad key', qs({ afterCreatedAt: new Date().toISOString(), afterRecordKey: 'short' }), 400, 'ERR_INVALID_RECORD'],
    ['bad direction', qs({ direction: 'sideways' }), 400, 'ERR_INVALID_RECORD'],
    ['bad participant', qs({ participant: 'not-a-key' }), 400, 'ERR_INVALID_RECORD'],
    ['conflicting owner claim', qs({ owner: h.otherId }), 403, 'ERR_FORBIDDEN'],
  ]
  for (const [label, query, status, code] of cases) {
    const res = await browse(h, query)
    assert.equal(res.status, status, label)
    assert.equal(res.body?.code, code, label)
    assertRedacted(res.body, label)
  }
  // Shape failures never reach the repository; only the successful seed did.
  const browseCalls = h.calls.filter((c) => c.method === 'listBrowse').length
  assert.equal(browseCalls, 0, 'malformed browse never reaches the repository')
  assert.equal(h.calls.length, before, 'no new repository calls on query misuse')
})

test('M2.1d browse keyset timestamps round-trip the canonical validator across adapters', async (t) => {
  const { validateBrowseQuery } = await import('../dist/server.js')
  const { createMemoryStore, createSqliteStore } = await import('../src/repository.mjs')
  const owner = `02${'a1'.repeat(32)}`
  const peer = `03${'b2'.repeat(32)}`
  const stores = [
    { label: 'memory', store: createMemoryStore() },
    { label: 'sqlite', store: await createSqliteStore() },
  ]
  t.after(() => { for (const { store } of stores) store.close?.() })
  if (process.env.MESSAGE_BOX_STORE_MYSQL === '1') {
    const { createMysqlKnex, migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
    const cfg = {
      host: process.env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    }
    if (cfg.user && cfg.password && cfg.database) {
      const knex = await createMysqlKnex(cfg)
      t.after(() => knex.destroy())
      await migrateMysql(knex)
      stores.push({ label: 'mysql', store: createMysqlStore(knex) })
    }
  }
  for (const { label, store } of stores) {
    await store.deleteAll({ owner }).catch(() => {})
    const epoch = (await store.getUsage({ owner })).epoch
    const archived = await store.archiveBatch({
      owner,
      epoch,
      records: [1, 2, 3].map((n) => ({
        messageId: `m2d-rt-${label}-${n}-${Date.now()}`,
        messageBox: 'inbox',
        direction: 'outbound',
        sender: owner,
        recipient: peer,
        body: BODY_A,
      })),
    })
    assert.deepEqual(archived.outcomes.map((o) => o.outcome), ['stored', 'stored', 'stored'], `${label}: ${JSON.stringify(archived.outcomes)}`)
    const seen = []
    let after = null
    for (let i = 0; i < 8; i += 1) {
      const page = after === null
        ? await store.listBrowse({ owner, limit: 1 })
        : await store.listBrowse({ owner, limit: 1, after })
      for (const record of page.items) seen.push(record.recordKey)
      if (page.nextAfter === null) break
      const { nextAfter } = page
      assert.doesNotThrow(
        () => validateBrowseQuery({ afterCreatedAt: nextAfter.createdAt, afterRecordKey: nextAfter.recordKey }),
        `${label}: real nextAfter createdAt must round-trip (${nextAfter.createdAt})`,
      )
      after = { createdAt: nextAfter.createdAt, recordKey: nextAfter.recordKey }
    }
    assert.equal(new Set(seen).size, 3, `${label}: gap-free keyset paging drains every record exactly once`)
  }
})

test('M2.1d browse is owner-scoped with method and auth negatives', async (t) => {
  const h = await createHarness(t)
  await archive(h, [outboundRecord({ messageId: 'm2d-bown-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
  const cross = await browse(h, '', h.otherFetch)
  assert.equal(cross.status, 200)
  assert.equal(cross.body.records.length, 0, 'other owner sees none of the records')
  assertRedacted(cross.body, 'cross-owner browse')
  const post = await authedJson(h.authFetch, `${h.base}/v1/history/records?limit=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  // POST on the collection path routes to archive validation (400), not browse.
  assert.ok([400, 404].includes(post.status))
  const put = await authedJson(h.authFetch, `${h.base}/v1/history/records`, { method: 'PUT' })
  assert.equal(put.status, 404)
  const unsigned = await plainJson(`${h.base}/v1/history/records?limit=1`, { method: 'GET' })
  assert.equal(unsigned.status, 401)
  assertRedacted(unsigned.body, 'unsigned browse')
})

// ---------------------------------------------------------------------------
// Changes (fixed watermark)
// ---------------------------------------------------------------------------

test('M2.1d changes first page round-trips historyPage and drains gap-free', async (t) => {
  const h = await createHarness(t)
  await archive(h, [
    outboundRecord({ messageId: 'm2d-ch-1', owner: h.clientId, peer: h.otherId }),
    outboundRecord({ messageId: 'm2d-ch-2', owner: h.clientId, peer: h.otherId }),
    outboundRecord({ messageId: 'm2d-ch-3', owner: h.clientId, peer: h.otherId }),
  ])
  const seen = []
  let cursor = null
  let first = null
  let last = null
  for (let i = 0; i < 10; i += 1) {
    const page = await changes(h, cursor === null ? qs({ limit: '2' }) : qs({ cursor, limit: '2' }))
    assert.equal(page.status, 200, JSON.stringify(page.body))
    assert.equal(validateHistoryPage(page.body), true, JSON.stringify(validateHistoryPage.errors))
    assert.equal(validateChangePage(page.body), true)
    if (!first) first = page.body
    last = page.body
    for (const r of page.body.records) {
      if (r.body !== undefined) assert.equal(validateHistoryRecord(r), true)
    }
    seen.push(...page.body.records.map((r) => r.recordKey ?? r.sequence))
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null)
      assert.equal(page.body.checkpoint, page.body.watermark)
      break
    }
    assert.ok(page.body.nextCursor, 'non-final page carries nextCursor')
    cursor = page.body.nextCursor
  }
  assert.equal(seen.length, 3)
  assert.ok(first.watermark && first.epoch === 'gen-1' && first.serverTime)
  assert.equal(last.hasMore, false)
  assertOwnerCalls(h, 'changes')
})

test('M2.1d changes fix W: post-W writes invisible until a fresh cursor', async (t) => {
  const h = await createHarness(t)
  await archive(h, [
    outboundRecord({ messageId: 'm2d-fix-1', owner: h.clientId, peer: h.otherId }),
    outboundRecord({ messageId: 'm2d-fix-2', owner: h.clientId, peer: h.otherId }),
  ])
  const first = await changes(h, qs({ limit: '1' }))
  assert.equal(first.status, 200)
  assert.equal(first.body.hasMore, true)
  const w0 = first.body.watermark
  const contCursor = first.body.nextCursor
  // Interleave after W capture.
  const usage = await h.store.getUsage({ owner: h.clientId })
  await archive(h, [outboundRecord({ messageId: 'm2d-fix-3', owner: h.clientId, peer: h.otherId })], usage.epoch)
  const cont = await changes(h, qs({ cursor: contCursor, limit: '10' }))
  assert.equal(cont.status, 200)
  assert.equal(cont.body.watermark, w0, 'continuation stays within fixed W')
  assert.equal(cont.body.records.length, 1, 'only the remainder of W is returned')
  const fresh = await changes(h, qs({ limit: '10' }))
  assert.notEqual(fresh.body.watermark, w0, 'fresh cursor observes the new watermark')
  assert.equal(fresh.body.records.length, 3)
})

test('M2.1d changes cursor misuse: tamper, filter, feed, epoch and cross-owner', async (t) => {
  const h = await createHarness(t)
  await archive(h, [
    outboundRecord({ messageId: 'm2d-cm-1', owner: h.clientId, peer: h.otherId }),
    inboundRecord({ messageId: 'm2d-cm-2', owner: h.clientId, peer: h.otherId }),
  ])
  const first = await changes(h, qs({ limit: '1' }))
  assert.equal(first.status, 200)
  const cursor = first.body.nextCursor
  assert.ok(cursor, 'need a continuation cursor')

  // Tampered cursor fails 400 without oracle.
  const tampered = cursor.slice(0, -1) + (cursor.slice(-1) === 'A' ? 'B' : 'A')
  const bad = await changes(h, qs({ cursor: tampered }))
  assert.equal(bad.status, 400)
  assert.equal(bad.body?.code, 'ERR_INVALID_CURSOR')
  assertRedacted(bad.body, 'tampered cursor')

  // Filter must agree with the cursor digest.
  const filterMismatch = await changes(h, qs({ cursor, direction: 'inbound' }))
  // Unfiltered cursor has empty digest; adding a filter mismatches.
  assert.equal(filterMismatch.status, 400)
  assert.equal(filterMismatch.body?.code, 'ERR_INVALID_CURSOR')

  // Unknown query keys and bad limits fail before repository access.
  const callsBefore = h.calls.length
  for (const [label, query] of [
    ['unknown key', qs({ cursor, bogus: '1' })],
    ['bad limit', qs({ cursor, limit: 'many' })],
    ['bad direction', qs({ cursor, direction: 'sideways' })],
    ['bad participant', qs({ cursor, participant: 'nope' })],
  ]) {
    const res = await changes(h, query)
    assert.equal(res.status, 400, label)
    assertRedacted(res.body, label)
  }
  assert.equal(h.calls.length, callsBefore, 'query misuse never reaches the repository')

  // Cross-owner cursor reuse fails closed without revealing activity.
  const cross = await changes(h, qs({ cursor }), h.otherFetch)
  assert.equal(cross.status, 400)
  assert.equal(cross.body?.code, 'ERR_INVALID_CURSOR')
  assertRedacted(cross.body, 'cross-owner cursor')

  // Epoch rotation fences old cursors with 409.
  const wiped = await authedJson(h.authFetch, `${h.base}/v1/history/records`, { method: 'DELETE' })
  assert.equal(wiped.status, 200)
  const stale = await changes(h, qs({ cursor }))
  assert.equal(stale.status, 409)
  assert.equal(stale.body?.code, 'ERR_EPOCH_CHANGED')
  assertRedacted(stale.body, 'stale epoch cursor')
})

test('M2.1d changes retention gap expires the continuation (410)', async (t) => {
  const oldNow = () => '2020-01-01T00:00:00.000Z'
  const h = await createHarness(t, { storeNow: oldNow })
  await archive(h, [outboundRecord({ messageId: 'm2d-gap-1', owner: h.clientId, peer: h.otherId })])
  const browseRes = await h.store.listBrowse({ owner: h.clientId })
  const key = browseRes.items[0].recordKey
  // Second sequence: a state event old enough to be purged.
  await authedJson(h.authFetch, `${h.base}/v1/history/records/${key}/state`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2d-gap-k1' }),
  })
  const first = await changes(h, qs({ limit: '1' }))
  assert.equal(first.status, 200)
  assert.equal(first.body.hasMore, true)
  const cursor = first.body.nextCursor
  // Purge the old state event; the upsert for the live record is retained,
  // leaving a hole inside (C,W].
  const purged = await h.store.purgeExpiredChanges({ owner: h.clientId, nowIso: '2025-06-01T00:00:00.000Z', batchSize: 10, maxItems: 10 })
  assert.ok(purged.purgedChanges >= 1, 'gap setup purged an old state event')
  const gap = await changes(h, qs({ cursor }))
  assert.equal(gap.status, 410)
  assert.equal(gap.body?.code, 'ERR_CURSOR_EXPIRED')
  assertRedacted(gap.body, 'retention gap')
})

// ---------------------------------------------------------------------------
// Snapshot creation and paging
// ---------------------------------------------------------------------------

test('M2.1d snapshot creation round-trips canonical schema with filter identity', async (t) => {
  const h = await createHarness(t)
  await archive(h, [
    outboundRecord({ messageId: 'm2d-snap-1', owner: h.clientId, peer: h.otherId, messageBox: 'inbox' }),
    inboundRecord({ messageId: 'm2d-snap-2', owner: h.clientId, peer: h.otherId, messageBox: 'other-box' }),
  ])
  const created = await snapshotCreate(h, {})
  assert.equal(created.status, 200)
  assert.equal(validateSnapshotCreate(created.body), true, JSON.stringify(validateSnapshotCreate.errors))
  assert.match(created.body.snapshotId, /^snap_[0-9a-f]{32}$/)
  assert.equal(created.body.feed, 'snapshot')
  assert.equal(created.body.memberCount, 2)
  assert.equal(created.body.status, 'active')
  assert.equal(created.body.filterHash, '')
  const usageNow = await h.store.getUsage({ owner: h.clientId })
  assert.equal(created.body.epoch, usageNow.epoch)
  assert.equal(created.body.watermark, (BigInt(usageNow.nextSequence) - 1n).toString())

  const filtered = await snapshotCreate(h, { filter: { direction: 'inbound' } })
  assert.equal(filtered.status, 200)
  assert.equal(filtered.body.memberCount, 1)
  assert.equal(filtered.body.filterHash, snapshotFilterHash({ direction: 'inbound' }))
  assert.notEqual(filtered.body.snapshotId, created.body.snapshotId)

  const badFilter = await snapshotCreate(h, { filter: { direction: 'sideways' } })
  assert.equal(badFilter.status, 400)
  const extra = await snapshotCreate(h, { filter: {}, surprise: 1 })
  assert.equal(extra.status, 400)
  h.calls.length = 0
  const unsupportedIdempotency = await snapshotCreate(h, { filter: {}, idempotencyKey: 'snapshot-idem-unsupported' })
  assert.equal(unsupportedIdempotency.status, 400)
  assert.equal(unsupportedIdempotency.body?.code, 'ERR_INVALID_RECORD')
  assert.equal(h.calls.filter((call) => call.method === 'createSnapshot').length, 0, 'unsupported snapshot idempotency never reaches the repository')
  assertRedacted(badFilter.body, 'bad snapshot filter')
  assertRedacted(unsupportedIdempotency.body, 'unsupported snapshot idempotency')
  assertOwnerCalls(h, 'snapshot create')
})

test('M2.1d snapshot create schema and route agree on the strict filter-only contract', async (t) => {
  const { validateSnapshotCreateBody } = await import('../dist/server.js')
  const validateReq = compile('snapshotCreateRequest')
  // Canonical schema: optional object filter, nothing else.
  assert.equal(validateReq({}), true)
  assert.equal(validateReq({ filter: {} }), true)
  assert.equal(validateReq({ filter: { direction: 'inbound' } }), true)
  assert.equal(validateReq({ idempotencyKey: 'snap-k' }), false, 'idempotencyKey is not part of the canonical request')
  assert.equal(validateReq({ filter: null }), false, 'null filter is not schema-valid')
  assert.equal(validateReq(null), false)
  assert.equal(validateReq([]), false)
  assert.equal(validateReq('x'), false)
  // Direct validator agrees: only an absent body/filter defaults to {}.
  assert.deepEqual(validateSnapshotCreateBody(undefined), { filter: {} })
  for (const bad of [null, 'x', 42, [], { filter: null }, { filter: {}, idempotencyKey: 'snap-k' }, { surprise: 1 }]) {
    assert.throws(() => validateSnapshotCreateBody(bad), (e) => e?.code === 'ERR_INVALID_RECORD', JSON.stringify(bad))
  }
  // Signed route rejects the same inputs before repository access.
  const h = await createHarness(t)
  h.calls.length = 0
  const rawCases = [
    ['null body', 'null'],
    ['primitive body', '42'],
    ['array body', '[]'],
    ['null filter', JSON.stringify({ filter: null })],
    ['idempotencyKey', JSON.stringify({ filter: {}, idempotencyKey: 'snap-k' })],
    ['unknown field', JSON.stringify({ surprise: 1 })],
  ]
  for (const [label, raw] of rawCases) {
    const res = await authedJson(h.authFetch, `${h.base}/v1/history/snapshot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
    })
    assert.equal(res.status, 400, label)
    assert.equal(res.body?.code, 'ERR_INVALID_RECORD', label)
    assertRedacted(res.body, label)
  }
  assert.equal(h.calls.filter((call) => call.method === 'createSnapshot').length, 0, 'rejected creates never reach the repository')
  const ok = await snapshotCreate(h, {})
  assert.equal(ok.status, 200)
})

test('M2.1d snapshot paging drains gap-free with limit splits', async (t) => {
  const h = await createHarness(t)
  await archive(h, [1, 2, 3, 4, 5].map((n) => outboundRecord({ messageId: `m2d-spage-${n}`, owner: h.clientId, peer: h.otherId })))
  const created = await snapshotCreate(h, {})
  assert.equal(created.status, 200)
  const snapshotId = created.body.snapshotId
  const seen = []
  let cursor = null
  let pages = 0
  for (let i = 0; i < 10; i += 1) {
    const page = await snapshotPage(h, cursor === null ? qs({ snapshotId, limit: '2' }) : qs({ snapshotId, cursor, limit: '2' }))
    assert.equal(page.status, 200, JSON.stringify(page.body))
    assert.equal(validateHistoryPage(page.body), true, JSON.stringify(validateHistoryPage.errors))
    assert.equal(page.body.watermark, created.body.watermark)
    assert.equal(page.body.epoch, created.body.epoch)
    for (const r of page.body.records) assert.equal(validateHistoryRecord(r), true)
    seen.push(...page.body.records.map((r) => r.recordKey))
    pages += 1
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null)
      assert.equal(page.body.checkpoint, created.body.watermark)
      break
    }
    cursor = page.body.nextCursor
    assert.ok(cursor)
  }
  assert.equal(seen.length, 5)
  assert.equal(new Set(seen).size, 5)
  assert.ok(pages >= 3, 'limit splits force continuations')
})

test('M2.1d snapshot invalidated after member delete: 410 and no bodies', async (t) => {
  const h = await createHarness(t)
  await archive(h, [
    outboundRecord({ messageId: 'm2d-inv-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL }),
    outboundRecord({ messageId: 'm2d-inv-2', owner: h.clientId, peer: h.otherId }),
  ])
  const created = await snapshotCreate(h, {})
  assert.equal(created.status, 200)
  const victim = (await snapshotPage(h, qs({ snapshotId: created.body.snapshotId, limit: '1' }))).body.records[0].recordKey
  const del = await authedJson(h.authFetch, `${h.base}/v1/history/records/${victim}`, { method: 'DELETE' })
  assert.equal(del.body.deleted, true)
  const dead = await snapshotPage(h, qs({ snapshotId: created.body.snapshotId }))
  assert.equal(dead.status, 410)
  assert.equal(dead.body?.code, 'ERR_CURSOR_EXPIRED')
  assertRedacted(dead.body, 'invalidated snapshot')
  assert.ok(!JSON.stringify(dead.body).includes(BODY_SENTINEL.slice(0, 16)), 'invalidated page never returns bodies')
  // Browse converges without the deleted body; changes converge via delete event.
  const browseRes = await browse(h)
  assert.ok(browseRes.body.records.every((r) => r.recordKey !== victim))
  assert.ok(!JSON.stringify(browseRes.body).includes(BODY_SENTINEL.slice(0, 16)))
  const changeRes = await changes(h, qs({ limit: '10' }))
  assert.ok(changeRes.body.records.every((r) => r.body === undefined || r.recordKey !== victim || r.body !== BODY_SENTINEL))
  const deletes = changeRes.body.records.filter((r) => r.body === undefined)
  assert.ok(deletes.some((d) => d.recordKey === victim), 'delete event converges without ciphertext')
  for (const d of deletes) {
    assert.ok(d.recordKey && d.sequence && d.deletedAt)
    assert.ok(!('body' in d), 'delete events carry no body')
  }
})

test('M2.1d snapshot query misuse: missing, malformed, unknown, cursor and method errors', async (t) => {
  const h = await createHarness(t)
  await archive(h, [outboundRecord({ messageId: 'm2d-sq-1', owner: h.clientId, peer: h.otherId })])
  const created = await snapshotCreate(h, {})
  const snapshotId = created.body.snapshotId
  const good = await snapshotPage(h, qs({ snapshotId, limit: '1' }))
  assert.equal(good.status, 200)
  const cursor = good.body.nextCursor ?? good.body.checkpoint

  const cases = [
    ['missing snapshotId', qs({ limit: '1' }), 400, 'ERR_INVALID_CURSOR'],
    ['malformed snapshotId', qs({ snapshotId: 'snap_nope', limit: '1' }), 400, 'ERR_INVALID_CURSOR'],
    ['unknown snapshotId', qs({ snapshotId: `snap_${'ab'.repeat(16)}` }), 404, 'ERR_INVALID_CURSOR'],
    ['unknown query key', qs({ snapshotId, filter: 'x' }), 400, 'ERR_INVALID_RECORD'],
    ['bad limit', qs({ snapshotId, limit: 'many' }), 400, 'ERR_INVALID_RECORD'],
    ['tampered cursor', qs({ snapshotId, cursor: `${good.body.nextCursor ?? 'x'}tampered` }), 400, 'ERR_INVALID_CURSOR'],
  ]
  for (const [label, query, status, code] of cases) {
    const res = await snapshotPage(h, query)
    assert.equal(res.status, status, label)
    assert.equal(res.body?.code, code, label)
    assertRedacted(res.body, label)
  }
  // Feed misuse: a changes cursor is not valid on the snapshot feed.
  const changeFirst = await changes(h, qs({ limit: '1' }))
  const changeCursor = changeFirst.body.nextCursor ?? changeFirst.body.checkpoint
  if (changeCursor) {
    const misuse = await snapshotPage(h, qs({ snapshotId, cursor: changeCursor }))
    assert.equal(misuse.status, 400)
    assert.equal(misuse.body?.code, 'ERR_INVALID_CURSOR')
  }
  // Method errors: snapshot creation is POST-only, paging is GET-only.
  const getCreate = await authedJson(h.authFetch, `${h.base}/v1/history/snapshot`, { method: 'GET' })
  assert.equal(getCreate.status, 400, 'paging without snapshotId is 400, not a creation alias')
  const postPage = await authedJson(h.authFetch, `${h.base}/v1/history/snapshot${qs({ snapshotId })}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  // POST on the paging URL is creation with an unexpected query: 400.
  assert.equal(postPage.status, 400)
  const unsigned = await plainJson(`${h.base}/v1/history/snapshot${qs({ snapshotId })}`, { method: 'GET' })
  assert.equal(unsigned.status, 401)
})

test('M2.1d snapshot cross-owner and expired snapshot fail closed', async (t) => {
  const h = await createHarness(t)
  await archive(h, [outboundRecord({ messageId: 'm2d-sx-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
  const created = await snapshotCreate(h, {})
  const snapshotId = created.body.snapshotId
  const cross = await snapshotPage(h, qs({ snapshotId }), h.otherFetch)
  assert.ok([403, 404].includes(cross.status), `cross-owner snapshot fails, got ${cross.status}`)
  assertRedacted(cross.body, 'cross-owner snapshot')
  // Expire the snapshot row directly: paging must fail 410 without bodies.
  const meta = h.store._debug.snapshots.get(snapshotId)
  assert.ok(meta, 'snapshot row exists for expiry test')
  meta.expiresAt = '2000-01-01T00:00:00.000Z'
  const expired = await snapshotPage(h, qs({ snapshotId }))
  assert.equal(expired.status, 410)
  assert.equal(expired.body?.code, 'ERR_CURSOR_EXPIRED')
  assert.ok(!JSON.stringify(expired.body).includes(BODY_SENTINEL.slice(0, 16)))
})

// ---------------------------------------------------------------------------
// Usage (client contract)
// ---------------------------------------------------------------------------

test('M2.1d usage tracks quota, epoch and sequence for the client contract', async (t) => {
  const h = await createHarness(t)
  const empty = await usage(h)
  assert.equal(empty.status, 200)
  assert.deepEqual(Object.keys(empty.body).sort(), ['byteCount', 'epoch', 'nextSequence', 'recordCount'])
  assert.equal(empty.body.recordCount, 0)
  assert.equal(empty.body.epoch, 'gen-1')
  await archive(h, [
    outboundRecord({ messageId: 'm2d-u-1', owner: h.clientId, peer: h.otherId }),
    outboundRecord({ messageId: 'm2d-u-2', owner: h.clientId, peer: h.otherId }),
  ])
  const full = await usage(h)
  assert.equal(full.body.recordCount, 2)
  assert.ok(full.body.byteCount > 0)
  assert.equal(full.body.epoch, 'gen-1')
  assert.equal(full.body.nextSequence, '3')
  const key = (await browse(h)).body.records[0].recordKey
  await authedJson(h.authFetch, `${h.base}/v1/history/records/${key}`, { method: 'DELETE' })
  const after = await usage(h)
  assert.equal(after.body.recordCount, 1)
  assert.ok(after.body.byteCount < full.body.byteCount)
  const wiped = await authedJson(h.authFetch, `${h.base}/v1/history/records`, { method: 'DELETE' })
  const rotated = await usage(h)
  assert.equal(rotated.body.recordCount, 0)
  assert.equal(rotated.body.epoch, wiped.body.epoch)
  assert.notEqual(rotated.body.epoch, 'gen-1')
  assertOwnerCalls(h, 'usage')
})

test('M2.1d usage is owner-scoped with query and auth negatives', async (t) => {
  const h = await createHarness(t)
  await archive(h, [outboundRecord({ messageId: 'm2d-uo-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })])
  const cross = await usage(h, '', h.otherFetch)
  assert.equal(cross.status, 200)
  assert.equal(cross.body.recordCount, 0, 'other owner sees empty usage')
  assertRedacted(cross.body, 'cross-owner usage')
  const badQuery = await usage(h, '?surprise=1')
  assert.equal(badQuery.status, 400)
  const claim = await usage(h, `?owner=${h.otherId}`)
  assert.equal(claim.status, 403)
  const unsigned = await plainJson(`${h.base}/v1/history/usage`, { method: 'GET' })
  assert.equal(unsigned.status, 401)
  const post = await authedJson(h.authFetch, `${h.base}/v1/history/usage`, { method: 'POST' })
  assert.equal(post.status, 404)
})

// ---------------------------------------------------------------------------
// Cross-cutting: replay, redaction, validators, mapping
// ---------------------------------------------------------------------------

test('M2.1d replayed signed retrieval requests fail closed', async (t) => {
  const h = await createHarness(t)
  await archive(h, [outboundRecord({ messageId: 'm2d-replay-1', owner: h.clientId, peer: h.otherId })])
  captured.length = 0
  const first = await browse(h, qs({ limit: '10' }))
  assert.equal(first.status, 200)
  const signed = [...captured].reverse().find((c) => c?.headers?.['x-bsv-auth-signature'])
  assert.ok(signed, 'captured the signed browse request')
  const replay = await plainJson(signed.url, { method: 'GET', headers: { ...signed.headers } })
  assert.equal(replay.status, 401)
  assert.equal(replay.body?.code, 'ERR_AUTHENTICATION_REQUIRED')
})

test('M2.1d retrieval validators and cursor mapping are stable and redacted', async () => {
  const {
    validateBrowseQuery,
    validateChangesQuery,
    validateSnapshotPageQuery,
    validateSnapshotCreateBody,
    validateUsageQuery,
    mapRepositoryError,
  } = await import('../dist/server.js')
  assert.deepEqual(validateUsageQuery({}), {})
  assert.throws(() => validateUsageQuery({ extra: '1' }), (e) => e?.code === 'ERR_INVALID_RECORD')
  assert.throws(() => validateBrowseQuery({ limit: '0' }), (e) => e?.code === 'ERR_INVALID_RECORD')
  assert.throws(() => validateChangesQuery({ cursor: 42 }), (e) => e?.code === 'ERR_INVALID_CURSOR')
  assert.throws(() => validateSnapshotPageQuery({}), (e) => e?.code === 'ERR_INVALID_CURSOR')
  assert.throws(() => validateSnapshotPageQuery({ snapshotId: 'bad' }), (e) => e?.code === 'ERR_INVALID_CURSOR')
  assert.deepEqual(validateSnapshotCreateBody(undefined), { filter: {} })
  assert.throws(() => validateSnapshotCreateBody({ filter: { direction: 'sideways' } }), (e) => e?.code === 'ERR_INVALID_RECORD')
  assert.equal(mapRepositoryError(Object.assign(new Error('x'), { code: 'ERR_INVALID_CURSOR' })).status, 400)
  assert.equal(mapRepositoryError(Object.assign(new Error('x'), { code: 'ERR_CURSOR_EXPIRED' })).status, 410)
  assert.equal(mapRepositoryError(Object.assign(new Error('x'), { code: 'ERR_EPOCH_CHANGED' })).status, 409)
  assert.equal(mapRepositoryError(Object.assign(new Error('x'), { code: 'ERR_FORBIDDEN' })).status, 403)
  for (const mapped of [
    mapRepositoryError(Object.assign(new Error('x'), { code: 'ERR_INVALID_CURSOR' })),
    mapRepositoryError(Object.assign(new Error('x'), { code: 'ERR_CURSOR_EXPIRED' })),
  ]) {
    assert.ok(!JSON.stringify(mapped).includes(SECRET))
  }
  assert.equal(validateStoreError({ status: 'error', code: 'ERR_INVALID_CURSOR', description: 'invalid request' }), true)
  assert.equal(validateStoreError({ status: 'error', code: 'ERR_CURSOR_EXPIRED', description: 'cursor expired; take a full snapshot' }), true)
})
