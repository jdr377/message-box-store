// M2.1e (mbs-8g5.3.1.5): authenticated capabilities, dependency-free
// liveness, non-sensitive MySQL readiness, and the table-driven route
// isolation/redaction matrix over every M2.1 protected route.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const plainFetch = globalThis.fetch

const { ProtoWallet, PrivateKey, AuthFetch, SessionManager } = await import('@bsv/sdk')
const { createMemoryStore } = await import('../src/repository.mjs')
const { JSON_SCHEMAS, LIMITS, PROTOCOL_VERSION, SCHEMA_VERSION } = await import('../src/protocol.mjs')
const Ajv2020 = (await import('ajv/dist/2020.js')).default
const { default: addFormats } = await import('ajv-formats')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const SERVER_KEY = '33'.repeat(32)
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const BODY_A = '{"encryptedMessage":"AQ=="}'
const BODY_SENTINEL = '{"encryptedMessage":"U0VOVElORUxfTVQyX0lTT0xBVElPTl9DSVBIRVJUQVhU"}'

function baseConfig(overrides = {}) {
  return {
    serverSecret: SECRET,
    mysql: { host: '127.0.0.1', port: 3306, user: 'mbs_test', password: PASSWORD, database: 'message_box_store_test' },
    retention: 'permanent',
    ...overrides,
  }
}

function fakeKnex(overrides = {}) {
  return { raw: async () => [[{ ok: 1 }]], destroy: async () => {}, ...overrides }
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

async function createHarness(t, { knex = fakeKnex(), config = baseConfig() } = {}) {
  const { createService } = await import('../dist/server.js')
  const serverWallet = walletFor(SERVER_KEY)
  const clientWallet = walletFor(CLIENT_KEY)
  const otherWallet = walletFor(OTHER_KEY)
  const sessionManager = new SessionManager()
  const inner = createMemoryStore()
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
    config,
    knex,
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
    service, store: inner, calls, base, clientId, otherId,
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

const validateCapabilities = compile('capabilities')
const validateStoreError = compile('storeError')

const capabilities = (h, fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/capabilities`, { method: 'GET' })

const archive = (h, records, fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch: 'gen-1', records }),
  })

const deleteAll = (h, query = '', fetchImpl) =>
  authedJson(fetchImpl ?? h.authFetch, `${h.base}/v1/history/records${query}`, { method: 'DELETE' })

function assertRedacted(value, label) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, PASSWORD, SERVER_KEY, CLIENT_KEY, OTHER_KEY, BODY_A, BODY_SENTINEL]) {
    assert.ok(!text.includes(secret), `${label} must not leak secret or ciphertext material`)
  }
  assert.ok(!text.includes('x-bsv-auth-signature'), `${label} must not echo auth headers`)
  assert.ok(!text.includes('BEGIN'), `${label} must not echo key material`)
  for (const detail of ['127.0.0.1', 'mbs_test', 'message_box_store_test', 'ECONNREFUSED', 'mysql']) {
    assert.ok(!text.includes(detail), `${label} must not leak connection detail: ${detail}`)
  }
}

function assertStoreError(body, label) {
  assert.equal(validateStoreError(body), true, `${label}: ${JSON.stringify(validateStoreError.errors)}`)
}

async function archiveOne(h, messageId, fetchImpl) {
  const res = await archive(h, [outboundRecord({ messageId, owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL })], fetchImpl)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const stored = res.body.outcomes.find((o) => o.outcome === 'stored')
  assert.ok(stored, 'expected a stored outcome')
  return stored.recordKey
}

// ---------------------------------------------------------------------------
// Capabilities: effective configuration only
// ---------------------------------------------------------------------------

test('M2.1e capabilities publish effective configuration and never usage state', async (t) => {
  const h = await createHarness(t)
  const { SERVICE_SUPPORTED_FEATURES, SERVICE_VERSION, buildCapabilities } = await import('../dist/server.js')

  // Captured before any record exists, then compared after seeding: an
  // owner's capabilities must be identical regardless of record/byte usage.
  const before = await capabilities(h)
  assert.equal(before.status, 200)
  assert.equal(validateCapabilities(before.body), true, JSON.stringify(validateCapabilities.errors))

  await archive(h, [
    outboundRecord({ messageId: 'm2e-cap-1', owner: h.clientId, peer: h.otherId, body: BODY_SENTINEL }),
    outboundRecord({ messageId: 'm2e-cap-2', owner: h.clientId, peer: h.otherId }),
  ])
  const usage = h.store.getUsage({ owner: h.clientId })
  assert.equal(usage.recordCount, 2)
  assert.ok(usage.byteCount > 0)

  const after = await capabilities(h)
  assert.equal(after.status, 200)
  assert.equal(validateCapabilities(after.body), true, JSON.stringify(validateCapabilities.errors))
  assert.deepEqual(after.body, before.body, 'capabilities are configuration-only; usage must not change them')

  const doc = after.body
  assert.equal(doc.protocolVersion, PROTOCOL_VERSION)
  assert.equal(doc.protocolVersion, SCHEMA_VERSION)
  assert.equal(doc.maxRecordsPerOwner, LIMITS.MAX_RECORDS_PER_OWNER)
  assert.equal(doc.maxBytesPerOwner, LIMITS.MAX_BYTES_PER_OWNER)
  assert.equal(doc.maxBodyBytes, LIMITS.MAX_BODY_BYTES)
  assert.equal(doc.maxBatchRecords, LIMITS.MAX_BATCH_RECORDS)
  assert.equal(doc.maxBatchBytes, LIMITS.MAX_BATCH_BYTES)
  assert.equal(doc.maxPageRecords, LIMITS.MAX_PAGE_RECORDS)
  assert.equal(doc.maxPageBytes, LIMITS.MAX_PAGE_BYTES)
  assert.equal(doc.retention, 'permanent')
  assert.equal(doc.epoch, usage.epoch)
  assert.deepEqual(doc.supportedFeatures, [...SERVICE_SUPPORTED_FEATURES])
  assert.equal(doc.supportedFeatures.includes('retention'), false, 'unenforced config is not a supported feature')
  for (const leaked of ['recordCount', 'byteCount', 'nextSequence']) {
    assert.equal(Object.hasOwn(doc, leaked), false, `capabilities must not expose ${leaked}`)
  }
  assertRedacted(doc, 'capabilities document')

  // The published feature list is a copy: mutating the response cannot
  // poison the service's frozen export for other owners.
  doc.supportedFeatures.push('pretend-feature')
  assert.equal(SERVICE_SUPPORTED_FEATURES.includes('pretend-feature'), false)

  // buildCapabilities always publishes the enforced retention policy; finite
  // values are not accepted anywhere in the contract (mbs-8g5.3.1.5.2).
  const built = buildCapabilities({ epoch: 'gen-1' })
  assert.equal(validateCapabilities(built), true, JSON.stringify(validateCapabilities.errors))
  assert.equal(built.retention, 'permanent')

  // Liveness reports the composed service version and no dependency detail.
  const live = await plainJson(`${h.base}/healthz`)
  assert.equal(live.status, 200)
  assert.equal(live.body.status, 'ok')
  assert.equal(live.body.version, SERVICE_VERSION)
  assertRedacted(live.body, 'healthz')
})

test('M2.1e capabilities never claim unenforced finite retention; epochs stay per-owner', async (t) => {
  const { parseRetentionDays, validateServiceConfig } = await import('../dist/server.js')

  // Config boundary (mbs-8g5.3.1.5.2): finite day counts fail typed so the
  // service cannot carry a retention value capabilities would have to lie
  // about. Permanent (the enforced policy) remains valid.
  for (const finite of ['7', '30', '365', 30, 7]) {
    await assert.rejects(async () => parseRetentionDays(finite), (error) => {
      assert.ok(error instanceof Error)
      assert.equal(typeof error.code, 'string')
      assert.ok(error.code.length > 0)
      assert.ok(!String(error.message).includes(PASSWORD))
      return true
    }, `finite retention ${finite} must be rejected`)
  }
  assert.equal(parseRetentionDays('permanent'), 'permanent')
  assert.equal(parseRetentionDays(undefined), 'permanent')
  await assert.rejects(async () => validateServiceConfig(baseConfig({ retention: '30' })),
    (error) => error instanceof Error && typeof error.code === 'string')

  const h = await createHarness(t)
  const capped = await capabilities(h)
  assert.equal(capped.status, 200)
  assert.equal(validateCapabilities(capped.body), true, JSON.stringify(validateCapabilities.errors))
  assert.equal(capped.body.retention, 'permanent', 'capabilities report the enforced policy only')

  // Client delete-all rotates only the client's epoch in the document.
  const wiped = await deleteAll(h)
  assert.equal(wiped.status, 200)
  const clientCap = await capabilities(h)
  assert.equal(clientCap.body.epoch, 'gen-2')
  const otherCap = await capabilities(h, h.otherFetch)
  assert.equal(otherCap.status, 200)
  assert.equal(otherCap.body.epoch, 'gen-1', "one owner's rotation must not change another's epoch")
  assert.equal(otherCap.body.retention, 'permanent')
  assertRedacted(otherCap.body, 'other owner capabilities')
})

test('M2.1e capabilities rejects unsigned, owner-claim and unknown-query access', async (t) => {
  const h = await createHarness(t)
  const before = h.calls.length

  const unsigned = await plainJson(`${h.base}/v1/history/capabilities`)
  assert.equal(unsigned.status, 401)
  assertStoreError(unsigned.body, 'unsigned capabilities')
  assert.equal(unsigned.body.code, 'ERR_AUTHENTICATION_REQUIRED')
  assertRedacted(unsigned.body, 'unsigned capabilities')

  const claimed = await authedJson(h.authFetch, `${h.base}/v1/history/capabilities?owner=${h.otherId}`)
  assert.equal(claimed.status, 403)
  assert.equal(claimed.body?.code, 'ERR_FORBIDDEN')
  assertStoreError(claimed.body, 'capabilities owner claim')
  assertRedacted(claimed.body, 'capabilities owner claim')

  const unknown = await authedJson(h.authFetch, `${h.base}/v1/history/capabilities?nope=1`)
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body?.code, 'ERR_INVALID_RECORD')
  assertStoreError(unknown.body, 'capabilities unknown query')
  assertRedacted(unknown.body, 'capabilities unknown query')

  assert.equal(h.calls.length, before, 'rejected capability requests never reach the repository')

  const ok = await capabilities(h)
  assert.equal(ok.status, 200)
  assert.equal(validateCapabilities(ok.body), true, JSON.stringify(validateCapabilities.errors))
})

// ---------------------------------------------------------------------------
// Liveness and readiness: public, dependency-split, non-sensitive
// ---------------------------------------------------------------------------

test('M2.1e liveness has no dependencies; readiness gates migrations then MySQL without connection detail', async (t) => {
  const detail = `connect ECONNREFUSED 127.0.0.1:3306 user mbs_test password ${PASSWORD} database message_box_store_test`
  const brokenKnex = fakeKnex({
    raw: async () => { throw new Error(detail) },
  })
  const h = await createHarness(t, { knex: brokenKnex })

  // Liveness never consults the store, knex or migrations.
  const liveBefore = await plainJson(`${h.base}/healthz`)
  assert.equal(liveBefore.status, 200)
  assert.equal(liveBefore.body.status, 'ok')
  assertRedacted(liveBefore.body, 'healthz pre-migrate')

  // Gate 1: migrations unverified.
  const preMigrate = await plainJson(`${h.base}/ready`)
  assert.equal(preMigrate.status, 503)
  assert.equal(preMigrate.body?.code, 'ERR_UNAVAILABLE')
  assertStoreError(preMigrate.body, 'readiness migration gate')
  assert.ok(preMigrate.body.description.includes('migrations not verified'))
  assertRedacted(preMigrate.body, 'readiness migration gate')

  // Migrations verify; the database probe now decides.
  const versions = await h.service.migrate()
  assert.deepEqual(versions, ['001-init'])
  assert.equal(h.service.checkReadiness().ready, true)

  const dbDown = await plainJson(`${h.base}/ready`)
  assert.equal(dbDown.status, 503)
  assert.equal(dbDown.body?.code, 'ERR_UNAVAILABLE')
  assert.equal(dbDown.body?.description, 'service not ready: database unavailable')
  assertStoreError(dbDown.body, 'readiness database gate')
  assertRedacted(dbDown.body, 'readiness database gate')
  assert.equal(dbDown.body.description.includes(detail), false)

  // Liveness stays green while readiness is red.
  const liveWhileRed = await plainJson(`${h.base}/healthz`)
  assert.equal(liveWhileRed.status, 200)
  assert.equal(liveWhileRed.body.status, 'ok')

  // Healthy probe: same composition reports ready.
  const healthy = await createHarness(t)
  const migrated = await healthy.service.migrate()
  assert.deepEqual(migrated, ['001-init'])
  const ready = await plainJson(`${healthy.base}/ready`)
  assert.equal(ready.status, 200)
  assert.equal(ready.body.status, 'ready')
  assertRedacted(ready.body, 'ready')
})

async function listenApp(t, app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('M2.1e readiness fails closed without a passing database probe (mbs-8g5.3.1.5.1)', async (t) => {
  const { createServiceApp } = await import('../dist/server.js')
  const verified = { checkReadiness: () => ({ ready: true, versions: ['001-init'] }), version: 'probe' }

  // checkReadiness true + missing/throwing/false/non-true probe: the SAME
  // schema-valid redacted 503. Never fail open on an absent probe.
  const failures = [
    ['missing probe', undefined],
    ['false probe', async () => false],
    ['non-boolean probe', async () => 'ok'],
    ['throwing probe', async () => {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:3306 user mbs_test password ${PASSWORD} database message_box_store_test`)
    }],
  ]
  for (const [label, checkDatabase] of failures) {
    const state = { ...verified }
    if (checkDatabase) state.checkDatabase = checkDatabase
    const base = await listenApp(t, await createServiceApp(state))
    const res = await plainJson(`${base}/ready`)
    assert.equal(res.status, 503, label)
    assert.equal(res.body?.code, 'ERR_UNAVAILABLE', label)
    assert.equal(res.body?.description, 'service not ready: database unavailable', label)
    assertStoreError(res.body, label)
    assertRedacted(res.body, label)
  }

  // Present + passing probe is required alongside verified migrations.
  const okBase = await listenApp(t, await createServiceApp({ ...verified, checkDatabase: async () => true }))
  const ok = await plainJson(`${okBase}/ready`)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.status, 'ready')
  assertRedacted(ok.body, 'ready with probe')

  // Migration gate still precedes the probe even when the probe would pass.
  const preMigrateBase = await listenApp(t, await createServiceApp({
    checkReadiness: () => ({ ready: false, versions: null }),
    version: 'probe',
    checkDatabase: async () => true,
  }))
  const preMigrate = await plainJson(`${preMigrateBase}/ready`)
  assert.equal(preMigrate.status, 503)
  assert.equal(preMigrate.body?.description, 'service not ready: migrations not verified')
  assertStoreError(preMigrate.body, 'pre-migrate readiness')

  // Liveness invokes neither dependency.
  let readinessCalls = 0
  let probeCalls = 0
  const spyBase = await listenApp(t, await createServiceApp({
    checkReadiness: () => {
      readinessCalls += 1
      return { ready: false, versions: null }
    },
    version: 'probe',
    checkDatabase: async () => {
      probeCalls += 1
      return true
    },
  }))
  const live = await plainJson(`${spyBase}/healthz`)
  assert.equal(live.status, 200)
  assert.equal(live.body.status, 'ok')
  assert.equal(readinessCalls, 0, '/healthz must not invoke checkReadiness')
  assert.equal(probeCalls, 0, '/healthz must not invoke checkDatabase')
})

// ---------------------------------------------------------------------------
// Table-driven route isolation/redaction matrix (all ten protected routes)
// ---------------------------------------------------------------------------

// One row per protected application route. `path` builds the canonical
// request path for a seeded record/snapshot; `claim` adds a conflicting
// owner claim in the wire location each handler inspects; `cross` asserts
// the signed same-shape request from a DIFFERENT owner never observes the
// seeded client record.
const ROUTE_MATRIX = [
  {
    label: 'capabilities',
    method: 'GET',
    path: (h) => '/v1/history/capabilities',
    claim: 'query',
    cross: async (h) => {
      const res = await capabilities(h, h.otherFetch)
      assert.equal(res.status, 200)
      assert.equal(validateCapabilities(res.body), true, JSON.stringify(validateCapabilities.errors))
      assert.equal(res.body.epoch, 'gen-1')
      assertRedacted(res.body, 'cross-owner capabilities')
    },
  },
  {
    label: 'browse',
    method: 'GET',
    path: () => '/v1/history/records',
    claim: 'query',
    cross: async (h) => {
      const res = await authedJson(h.otherFetch, `${h.base}/v1/history/records`)
      assert.equal(res.status, 200)
      assert.equal(res.body.records.length, 0, 'other owner sees none of the seeded records')
      assertRedacted(res.body, 'cross-owner browse')
    },
  },
  {
    label: 'changes',
    method: 'GET',
    path: () => '/v1/history/changes',
    claim: 'query',
    cross: async (h) => {
      const res = await authedJson(h.otherFetch, `${h.base}/v1/history/changes`)
      assert.equal(res.status, 200)
      assert.equal(res.body.records.length, 0, 'other owner feed excludes seeded records')
      assertRedacted(res.body, 'cross-owner changes')
    },
  },
  {
    label: 'snapshot create',
    method: 'POST',
    path: () => '/v1/history/snapshot',
    body: () => ({}),
    claim: 'body',
    cross: async (h) => {
      const res = await authedJson(h.otherFetch, `${h.base}/v1/history/snapshot`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      assert.equal(res.status, 200)
      assert.ok(res.body.snapshotId, 'other owner snapshots its own (empty) history')
      const page = await authedJson(h.otherFetch, `${h.base}/v1/history/snapshot?snapshotId=${res.body.snapshotId}`)
      assert.equal(page.status, 200)
      assert.equal(page.body.records.length, 0)
      assertRedacted(page.body, 'cross-owner snapshot page')
    },
  },
  {
    label: 'snapshot page',
    method: 'GET',
    path: (h) => `/v1/history/snapshot?snapshotId=${h.snapshotId}`,
    claim: 'query',
    cross: async (h) => {
      const res = await authedJson(h.otherFetch, `${h.base}/v1/history/snapshot?snapshotId=${h.snapshotId}`)
      assert.ok([403, 404].includes(res.status), `foreign snapshot page redacted, got ${res.status}`)
      assertStoreError(res.body, 'cross-owner snapshot page')
      assertRedacted(res.body, 'cross-owner snapshot page')
    },
  },
  {
    label: 'usage',
    method: 'GET',
    path: () => '/v1/history/usage',
    claim: 'query',
    cross: async (h) => {
      const res = await authedJson(h.otherFetch, `${h.base}/v1/history/usage`)
      assert.equal(res.status, 200)
      assert.equal(res.body.recordCount, 0, "other owner's usage excludes seeded records")
      assert.equal(res.body.byteCount, 0)
      assertRedacted(res.body, 'cross-owner usage')
    },
  },
  {
    label: 'patch state',
    method: 'PATCH',
    path: (h) => `/v1/history/records/${h.recordKey}/state`,
    body: () => ({ newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2e-x-patch' }),
    claim: 'query',
    cross: async (h) => {
      const res = await authedJson(h.otherFetch, `${h.base}/v1/history/records/${h.recordKey}/state`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newState: 'accepted', expectedRevision: '1', idempotencyKey: 'm2e-x-patch-other' }),
      })
      assert.equal(res.status, 400)
      assert.equal(res.body?.code, 'ERR_INVALID_RECORD')
      assertStoreError(res.body, 'cross-owner patch')
      assertRedacted(res.body, 'cross-owner patch')
      const seeded = h.store.getRecord({ owner: h.clientId, recordKey: h.recordKey })
      assert.equal(seeded.deliveryState, 'prepared', 'cross-owner patch must not touch the record')
    },
  },
  {
    label: 'delete one',
    method: 'DELETE',
    path: (h) => `/v1/history/records/${h.recordKey}`,
    claim: 'query',
    cross: async (h) => {
      const res = await authedJson(h.otherFetch, `${h.base}/v1/history/records/${h.recordKey}`, { method: 'DELETE' })
      assert.equal(res.status, 200)
      assert.equal(res.body.deleted, false, 'foreign key deletes nothing')
      assert.equal(h.store.getRecord({ owner: h.clientId, recordKey: h.recordKey }) !== null, true)
      assertRedacted(res.body, 'cross-owner delete')
    },
  },
  {
    label: 'archive batch',
    method: 'POST',
    path: () => '/v1/history/records',
    body: (h) => ({
      epoch: 'gen-1',
      records: [outboundRecord({ messageId: 'm2e-x-archive', owner: h.clientId, peer: h.otherId })],
    }),
    claim: 'body',
    cross: async (h) => {
      const record = outboundRecord({ messageId: 'm2e-x-archive-other', owner: h.otherId, peer: h.clientId })
      const res = await archive(h, [record], h.otherFetch)
      assert.equal(res.status, 200)
      assert.equal(res.body.outcomes[0].outcome, 'stored')
      // Scoping proof: the client's browse still shows only the client's record.
      const browse = await authedJson(h.authFetch, `${h.base}/v1/history/records`)
      assert.equal(browse.body.records.length, 1)
      assert.equal(browse.body.records[0].messageId, 'm2e-seed')
      assertRedacted(res.body, 'cross-owner archive')
    },
  },
  {
    label: 'delete all',
    method: 'DELETE',
    path: () => '/v1/history/records',
    claim: 'query',
    cross: async (h) => {
      const res = await deleteAll(h, '', h.otherFetch)
      assert.equal(res.status, 200)
      assert.equal(res.body.epoch, 'gen-2', "only the caller's epoch rotates")
      const survivor = h.store.getRecord({ owner: h.clientId, recordKey: h.recordKey })
      assert.ok(survivor, "one owner's delete-all must not purge another owner's records")
      const clientCap = await capabilities(h)
      assert.equal(clientCap.body.epoch, 'gen-1', "client epoch untouched by other owner's wipe")
      assertRedacted(res.body, 'cross-owner delete-all')
    },
  },
]

test('M2.1e route isolation matrix: unsigned, owner-claim and cross-owner outcomes', async (t) => {
  const h = await createHarness(t)
  h.recordKey = await archiveOne(h, 'm2e-seed')
  const snap = await authedJson(h.authFetch, `${h.base}/v1/history/snapshot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(snap.status, 200)
  h.snapshotId = snap.body.snapshotId
  assert.ok(h.snapshotId)

  for (const row of ROUTE_MATRIX) {
    const path = row.path(h)
    const jsonBody = row.body === undefined ? undefined : JSON.stringify(row.body(h))

    // (a) Unsigned: the pre-middleware gate rejects with the service's own
    // schema-valid redacted 401 before auth middleware or route resolution.
    const callsBeforeUnsigned = h.calls.length
    const unsigned = await plainJson(`${h.base}${path}`, {
      method: row.method,
      ...(jsonBody === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: jsonBody }),
    })
    assert.equal(unsigned.status, 401, `${row.label}: unsigned must 401`)
    assertStoreError(unsigned.body, `${row.label} unsigned`)
    assert.equal(unsigned.body.code, 'ERR_AUTHENTICATION_REQUIRED', row.label)
    assertRedacted(unsigned.body, `${row.label} unsigned`)
    assert.equal(h.calls.length, callsBeforeUnsigned, `${row.label}: unsigned never reaches the repository`)

    // (b) Signed but carrying a conflicting owner claim: 403 before any
    // repository access, schema-valid and redacted.
    const callsBeforeClaim = h.calls.length
    const claimUrl = row.claim === 'query'
      ? `${h.base}${path}${path.includes('?') ? '&' : '?'}owner=${encodeURIComponent(h.otherId)}`
      : `${h.base}${path}`
    const claimInit = { method: row.method }
    if (row.claim === 'body' && jsonBody !== undefined) {
      claimInit.headers = { 'Content-Type': 'application/json' }
      claimInit.body = JSON.stringify({ ...JSON.parse(jsonBody), owner: h.otherId })
    } else if (jsonBody !== undefined) {
      claimInit.headers = { 'Content-Type': 'application/json' }
      claimInit.body = jsonBody
    }
    const claim = await authedJson(h.authFetch, claimUrl, claimInit)
    assert.equal(claim.status, 403, `${row.label}: owner claim must 403, got ${claim.status} ${JSON.stringify(claim.body)}`)
    assert.equal(claim.body?.code, 'ERR_FORBIDDEN', row.label)
    assertStoreError(claim.body, `${row.label} owner claim`)
    assertRedacted(claim.body, `${row.label} owner claim`)
    assert.equal(h.calls.length, callsBeforeClaim, `${row.label}: owner claim never reaches the repository`)

    // (c) Cross-owner signed request: row-specific isolation outcome.
    await row.cross(h)
    // The seeded record must survive every foreign attempt above.
    assert.ok(h.store.getRecord({ owner: h.clientId, recordKey: h.recordKey }),
      `${row.label}: seeded record must survive cross-owner traffic`)
  }

  // Terminal isolation proof: a legitimate signed request still succeeds.
  const finalCap = await capabilities(h)
  assert.equal(finalCap.status, 200)
  assert.equal(validateCapabilities(finalCap.body), true, JSON.stringify(validateCapabilities.errors))
})
