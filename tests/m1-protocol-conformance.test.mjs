import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { createMemoryStore } from '../src/repository.mjs'
import { createSqliteStore } from '../src/repository.sqlite.mjs'
import { JSON_SCHEMAS, M0_VECTOR, UINT64_CANONICAL_PATTERN } from '../src/protocol.mjs'

const OWNER = M0_VECTOR.ownerIdentityKey
const PEER = M0_VECTOR.recipient

function compileAlone(name) {
  // Each public schema must compile independently under strict Ajv with only
  // its own embedded $defs — no external registry.
  const schema = JSON_SCHEMAS[name]
  assert.ok(schema?.$id, `${name} has $id`)
  const instance = new Ajv2020({ strict: true, allErrors: true })
  addFormats(instance)
  const validate = instance.compile(schema)
  assert.ok(validate, `${name} compiles alone`)
  return validate
}

test('M1 every public schema compiles independently under strict Ajv', () => {
  const required = [
    'archiveBatchRequest',
    'archiveBatchResponse',
    'batchOutcome',
    'historyRecord',
    'historyPage',
    'changeFeedPage',
    'deleteEvent',
    'statePatchRequest',
    'statePatchResponse',
    'deleteRecordRequest',
    'deleteRecordResponse',
    'deleteAllRequest',
    'deleteAllResponse',
    'snapshotCreateRequest',
    'snapshotCreateResponse',
    'snapshotMeta',
    'snapshotItem',
    'snapshotMembersResponse',
    'snapshotFilter',
    'capabilities',
    'storeError',
  ]
  for (const name of required) {
    assert.ok(JSON_SCHEMAS[name], `schema exists: ${name}`)
    compileAlone(name)
  }
  // No external $ref like 'batch-outcome.json' remains.
  for (const [name, schema] of Object.entries(JSON_SCHEMAS)) {
    if (!schema?.$id) continue
    const text = JSON.stringify(schema)
    assert.ok(!text.includes('.json"') || text.includes(schema.$id), `${name} has no external registry ref: ${text.slice(0, 200)}`)
    assert.ok(!text.includes('"batch-outcome.json"'), `${name} self-contained`)
  }
})

test('M1 decimal strings enforce true uint64 maximum', () => {
  const re = new RegExp(UINT64_CANONICAL_PATTERN)
  assert.equal(re.test('0'), true)
  assert.equal(re.test('18446744073709551615'), true)
  assert.equal(re.test('18446744073709551616'), false)
  assert.equal(re.test('99999999999999999999'), false)
  assert.equal(re.test('01'), false)
  const validate = compileAlone('historyRecord')
  const base = {
    recordKey: M0_VECTOR.recordKey,
    messageId: 'x',
    messageBox: 'inbox',
    direction: 'outbound',
    sender: OWNER,
    recipient: PEER,
    body: M0_VECTOR.body,
    bodyHash: M0_VECTOR.bodyHash,
    bodyBytes: 27,
    deliveryState: 'received',
    revision: '1',
    changeSequence: '7',
    createdAt: new Date().toISOString(),
    archivedAt: new Date().toISOString(),
    expiresAt: null,
  }
  assert.equal(validate({ ...base, revision: '18446744073709551615' }), true)
  assert.equal(validate({ ...base, revision: '18446744073709551616' }), false)
  assert.equal(validate({ ...base, recordKey: '' }), false, 'record keys cannot be empty')
})

test('M1 pages use typed record/delete-event union; timestamps and revision/idempotency required', () => {
  const historyValidate = compileAlone('historyRecord')
  // Timestamps required by ADR.
  const missingTime = {
    recordKey: M0_VECTOR.recordKey,
    messageId: 'x',
    messageBox: 'inbox',
    direction: 'outbound',
    sender: OWNER,
    recipient: PEER,
    body: M0_VECTOR.body,
    bodyHash: M0_VECTOR.bodyHash,
    bodyBytes: 27,
    deliveryState: 'received',
    revision: '1',
    changeSequence: '7',
    expiresAt: null,
  }
  assert.equal(historyValidate(missingTime), false, 'createdAt/archivedAt required')

  const pageValidate = compileAlone('historyPage')
  const changeValidate = compileAlone('changeFeedPage')
  const record = {
    recordKey: M0_VECTOR.recordKey,
    messageId: 'x',
    messageBox: 'inbox',
    direction: 'outbound',
    sender: OWNER,
    recipient: PEER,
    body: M0_VECTOR.body,
    bodyHash: M0_VECTOR.bodyHash,
    bodyBytes: 27,
    deliveryState: 'received',
    revision: '1',
    changeSequence: '7',
    createdAt: new Date().toISOString(),
    archivedAt: new Date().toISOString(),
    expiresAt: null,
  }
  const del = { recordKey: M0_VECTOR.recordKey, sequence: '9', deletedAt: new Date().toISOString() }
  const page = {
    records: [record, del],
    nextCursor: null,
    checkpoint: '9',
    hasMore: false,
    watermark: '9',
    epoch: 'gen-1',
    serverTime: new Date().toISOString(),
  }
  assert.equal(pageValidate(page), true, JSON.stringify(pageValidate.errors))
  assert.equal(changeValidate(page), true)
  assert.equal(pageValidate({ ...page, records: [{ nope: 1 }] }), false, 'union rejects unknown shapes')

  // State mutations include revision and idempotency fields.
  const patchReq = compileAlone('statePatchRequest')
  assert.equal(patchReq({ recordKey: M0_VECTOR.recordKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'op-1' }), true)
  assert.equal(patchReq({ recordKey: M0_VECTOR.recordKey }), false, 'newState/CAS/idempotency required')
  assert.equal(patchReq({ recordKey: M0_VECTOR.recordKey, newState: 'accepted', expectedRevision: '1' }), false, 'idempotency required')
  assert.equal(patchReq({ recordKey: M0_VECTOR.recordKey, newState: 'accepted', idempotencyKey: 'op-1' }), false, 'expectedRevision required')
  assert.equal(patchReq({ recordKey: 'zz', newState: 'accepted' }), false)
  const patchRes = compileAlone('statePatchResponse')
  assert.equal(patchRes({ recordKey: M0_VECTOR.recordKey, revision: '2', sequence: '8' }), true)
  assert.equal(patchRes({ recordKey: M0_VECTOR.recordKey, revision: '2' }), false, 'sequence required')

  const delReq = compileAlone('deleteRecordRequest')
  assert.equal(delReq({ recordKey: M0_VECTOR.recordKey, idempotencyKey: 'k-1' }), true)
  const delRes = compileAlone('deleteRecordResponse')
  assert.equal(delRes({ deleted: true, epoch: 'gen-2', sequence: '10' }), true)
  const allReq = compileAlone('deleteAllRequest')
  assert.equal(allReq({}), true)
  assert.equal(allReq({ idempotencyKey: 'k-2' }), true)
  const allRes = compileAlone('deleteAllResponse')
  assert.equal(allRes({ epoch: 'gen-2' }), true)

  const snapReq = compileAlone('snapshotCreateRequest')
  assert.equal(snapReq({}), true)
  assert.equal(snapReq({ filter: { direction: 'inbound', messageBox: 'inbox' } }), true)
  assert.equal(snapReq({ filter: { direction: 'sideways' } }), false)
  const snapRes = compileAlone('snapshotCreateResponse')
  assert.equal(
    snapRes({ snapshotId: `snap_${'ab'.repeat(16)}`, epoch: 'gen-1', feed: 'snapshot', filterHash: '', watermark: '5', memberCount: 0, status: 'active' }),
    true,
  )
  assert.equal(
    snapRes({ snapshotId: `snap_${'ab'.repeat(16)}`, epoch: 'gen-1', filterHash: '', watermark: '5', memberCount: 0, status: 'active' }),
    false,
    'snapshot feed is required',
  )
  assert.equal(
    snapRes({ snapshotId: `snap_${'ab'.repeat(16)}`, epoch: 'gen-1', feed: 'changes', filterHash: '', watermark: '5', memberCount: 0, status: 'active' }),
    false,
    'snapshot feed is canonical',
  )
  assert.equal(
    snapRes({ snapshotId: `snap_${'ab'.repeat(16)}`, epoch: 'gen-1', feed: 'snapshot', filterHash: '', watermark: '5', memberCount: 10000, status: 'active' }),
    true,
    'memberCount uses owner quota, not page size',
  )
  assert.equal(
    snapRes({ snapshotId: `snap_${'ab'.repeat(16)}`, epoch: 'gen-1', feed: 'snapshot', filterHash: '', watermark: '5', memberCount: 10001, status: 'active' }),
    false,
  )
})

test('M1 real memory/SQLite outputs validate against canonical schemas (bodyBytes contract)', async (t) => {
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  const stores = [createMemoryStore(), sqlite]
  // Live MySQL parity (gated) validates the same canonical shapes including timestamps.
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
      stores.push(createMysqlStore(knex))
    }
  }
  // MySQL live parity is covered in m1-repository.mysql tests; here we prove
  // memory and SQLite agree on the same wire shapes.
  const Ajv = (await import('ajv/dist/2020.js')).default
  const { default: addF } = await import('ajv-formats')
  const ownerSeeds = [`02${'c1'.repeat(32)}`, `02${'c2'.repeat(32)}`, `02${'c3'.repeat(32)}`]
  for (const [idx, store] of stores.entries()) {
    const finalOwner = ownerSeeds[idx] ?? `02${'c9'.repeat(32)}`
    const peer = `03${'d2'.repeat(32)}`
    const body = '{"encryptedMessage":"AQ=="}'
    await store.deleteAll({ owner: finalOwner }).catch(() => {})
    const epoch = (await store.getUsage({ owner: finalOwner })).epoch
    for (const deliveryState of ['unknown', 'accepted', 'failed']) {
      const before = await store.getUsage({ owner: finalOwner })
      const rejected = await store.archiveBatch({
        owner: finalOwner,
        epoch,
        records: [{ messageId: `invalid-initial-${idx}-${deliveryState}-${Date.now()}`, messageBox: 'inbox', direction: 'outbound', sender: finalOwner, recipient: peer, body, deliveryState }],
      })
      assert.equal(rejected.outcomes[0].outcome, 'invalid', `${store.kind}: ${deliveryState} cannot be archived initially`)
      assert.deepEqual(await store.getUsage({ owner: finalOwner }), before, `${store.kind}: invalid initial state does not mutate`)
    }
    const archived = await store.archiveBatch({
      owner: finalOwner,
      epoch,
      records: [{ messageId: `conf-1-${idx}-${Date.now()}`, messageBox: 'inbox', direction: 'outbound', sender: finalOwner, recipient: peer, body }],
    })
    assert.equal(archived.outcomes[0].outcome, 'stored', JSON.stringify(archived.outcomes))
    // archiveBatchResponse validates (stored outcomes carry bodyBytes + sequence).
    const respValidate = compileAlone('archiveBatchResponse')
    assert.equal(respValidate({ epoch: archived.epoch, committed: archived.committed, outcomes: archived.outcomes }), true, JSON.stringify(respValidate.errors))
    const key = archived.outcomes[0].recordKey
    const row = await store.getRecord({ owner: finalOwner, recordKey: key })
    assert.ok(row.bodyBytes, 'bodyBytes present')
    assert.ok(row.createdAt && row.archivedAt, 'timestamps present')
    const recValidate = compileAlone('historyRecord')
    assert.equal(recValidate(row), true, JSON.stringify(recValidate.errors))
    const snap = await store.createSnapshot({ owner: finalOwner })
    assert.equal(compileAlone('snapshotCreateResponse')(snap), true, 'snapshot create output validates')
    const meta = await store.getSnapshot({ snapshotId: snap.snapshotId, owner: finalOwner })
    assert.equal(compileAlone('snapshotMeta')(meta), true, 'snapshot metadata output validates')
    // State-patch and delete responses validate against canonical schemas.
    const patched = await store.patchState({ owner: finalOwner, recordKey: key, newState: 'accepted', expectedRevision: row.revision, idempotencyKey: `conformance-patch-${idx}-${Date.now()}` })
    assert.equal(compileAlone('statePatchResponse')(patched), true, 'patchState response validates')
    const del = await store.deleteRecord({ owner: finalOwner, recordKey: key })
    assert.equal(compileAlone('deleteRecordResponse')(del), true, 'deleteRecord response validates')
    const wiped = await store.deleteAll({ owner: finalOwner })
    assert.equal(compileAlone('deleteAllResponse')(wiped), true, 'deleteAll response validates')
  }
})
