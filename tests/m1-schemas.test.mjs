import assert from 'node:assert/strict'
import { test } from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { JSON_SCHEMAS, LIMITS, M0_VECTOR } from '../src/protocol.mjs'

const OWNER = M0_VECTOR.ownerIdentityKey
const PEER = M0_VECTOR.recipient

function ajv() {
  const instance = new Ajv2020({ strict: true, allErrors: true })
  addFormats(instance)
  for (const schema of Object.values(JSON_SCHEMAS).filter((s) => s && typeof s === 'object' && s.$id)) {
    instance.addSchema(schema)
  }
  return instance
}

function validRecord(overrides = {}) {
  return {
    recordKey: M0_VECTOR.recordKey,
    messageId: 'm0-vector-1',
    messageBox: 'general_inbox',
    direction: 'outbound',
    sender: OWNER,
    recipient: PEER,
    body: M0_VECTOR.body,
    bodyHash: M0_VECTOR.bodyHash,
    // Canonical contract: bodyBytes is public derived metadata (exact UTF-8).
    bodyBytes: Buffer.byteLength(M0_VECTOR.body, 'utf8'),
    deliveryState: 'received',
    revision: '1',
    changeSequence: '7',
    createdAt: '2026-09-20T00:00:00.000Z',
    archivedAt: '2026-09-20T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  }
}

test('M1 every schema compiles strict with resolved references', () => {
  const instance = ajv()
  // Compilation itself proves $id uniqueness and reference resolution.
  for (const [name, schema] of Object.entries(JSON_SCHEMAS)) {
    if (schema?.$id) assert.equal(instance.getSchema(schema.$id) !== undefined, true, name)
  }
})

test('M1 archiveBatchRequest accepts and rejects fixtures', () => {
  const validate = ajv().getSchema(`${'https://message-box-store/schemas/v1'}/archive-batch-request.json`)
  const good = {
    epoch: 'gen-1',
    records: [{ messageId: 'a', messageBox: 'inbox', direction: 'outbound', sender: OWNER, recipient: PEER, body: M0_VECTOR.body }],
  }
  assert.equal(validate(good), true, JSON.stringify(validate.errors))
  assert.equal(validate({ epoch: 'gen-1', records: [] }), false, 'empty batch rejected')
  assert.equal(validate({ epoch: 'gen-1' }), false, 'missing records rejected')
  assert.equal(
    validate({ epoch: 'gen-1', records: [{ ...good.records[0], sender: 'NOT-A-KEY' }] }),
    false,
    'bad identity rejected',
  )
  assert.equal(validate({ epoch: 'gen-1', records: [{ ...good.records[0], direction: 'sideways' }] }), false)
  for (const state of ['unknown', 'accepted', 'failed']) {
    assert.equal(validate({ epoch: 'gen-1', records: [{ ...good.records[0], deliveryState: state }] }), false, `archive rejects ${state} initial state`)
  }
  assert.equal(validate({ epoch: 'gen-1', records: [{ ...good.records[0], owner: OWNER }] }), false, 'owner claim rejected')
  assert.equal(validate({ epoch: 'gen-1', records: [{ ...good.records[0], extra: 1 }] }), false)
  const tooMany = { epoch: 'gen-1', records: Array.from({ length: LIMITS.MAX_BATCH_RECORDS + 1 }, (_, i) => ({ ...good.records[0], messageId: `m-${i}` })) }
  assert.equal(validate(tooMany), false, 'batch record bound enforced')
})

test('M1 batchOutcome/historyRecord/page/delete/capabilities/error fixtures', () => {
  const instance = ajv()
  const get = (name) => instance.getSchema(`https://message-box-store/schemas/v1/${name}.json`)
  assert.equal(get('batch-outcome')({ index: 0, recordKey: M0_VECTOR.recordKey, outcome: 'stored', sequence: '3' }), true)
  assert.equal(get('batch-outcome')({ index: 0, recordKey: null, outcome: 'invalid' }), true)
  assert.equal(get('batch-outcome')({ index: 0, recordKey: '', outcome: 'invalid' }), false, 'standalone empty recordKey rejected')
  assert.equal(get('batch-outcome')({ index: 0, recordKey: 'A'.repeat(64), outcome: 'invalid' }), false, 'standalone noncanonical recordKey rejected')
  const archiveResponse = get('archive-batch-response')
  assert.equal(archiveResponse({ epoch: 'gen-1', committed: false, outcomes: [{ index: 0, recordKey: null, outcome: 'epochChanged' }] }), true)
  assert.equal(archiveResponse({ epoch: 'gen-1', committed: true, outcomes: [{ index: 0, recordKey: M0_VECTOR.recordKey, outcome: 'stored' }] }), true)
  assert.equal(archiveResponse({ epoch: 'gen-1', committed: false, outcomes: [{ index: 0, recordKey: '', outcome: 'invalid' }] }), false, 'inline empty recordKey rejected')
  assert.equal(archiveResponse({ epoch: 'gen-1', committed: false, outcomes: [{ index: 0, recordKey: 'g'.repeat(64), outcome: 'invalid' }] }), false, 'inline malformed recordKey rejected')
  assert.equal(get('batch-outcome')({ index: 0, outcome: 'bogus' }), false)
  assert.equal(get('batch-outcome')({ index: 100, outcome: 'stored' }), false, 'index bound enforced')
  assert.equal(get('history-record')(validRecord()), true, JSON.stringify(get('history-record').errors))
  assert.equal(get('history-record')(validRecord({ direction: 'sideways' })), false)
  assert.equal(get('history-record')(validRecord({ revision: '01' })), false, 'non-canonical uint64 rejected')
  // Schema enforces the true uint64 maximum (not just 20-digit shape).
  assert.equal(get('history-record')(validRecord({ revision: '18446744073709551615' })), true, 'uint64 max accepted')
  assert.equal(get('history-record')(validRecord({ revision: '18446744073709551616' })), false, 'uint64 max+1 rejected by schema')
  assert.equal(get('history-record')(validRecord({ changeSequence: '99999999999999999999' })), false, 'out-of-range sequence rejected')
  // Record keys cannot be empty; timestamps required by ADR are present.
  assert.equal(get('history-record')(validRecord({ recordKey: '' })), false, 'empty recordKey rejected')
  assert.equal(get('history-record')(validRecord({ createdAt: undefined })), false, 'createdAt required')
  // bodyBytes is public derived metadata and must agree with implementation.
  assert.equal(get('history-record')(validRecord({ bodyBytes: 27 })), true)
  assert.equal(get('history-record')(validRecord({ bodyBytes: 0 })), false)
  const page = {
    records: [],
    nextCursor: null,
    checkpoint: '0',
    hasMore: false,
    watermark: '42',
    epoch: 'gen-1',
    serverTime: new Date().toISOString(),
  }
  assert.equal(get('history-page')(page), true)
  assert.equal(get('history-page')({ ...page, checkpoint: '' }), false, 'checkpoint required even when empty')
  assert.equal(get('history-page')({ ...page, hasMore: true, nextCursor: null }), false)
  assert.equal(
    get('delete-event')({ recordKey: M0_VECTOR.recordKey, sequence: '9', deletedAt: new Date().toISOString() }),
    true,
  )
  assert.equal(get('delete-event')({ recordKey: M0_VECTOR.recordKey, sequence: '9' }), false)
  const caps = {
    protocolVersion: '1',
    epoch: 'gen-1',
    maxRecordsPerOwner: 10000,
    maxBytesPerOwner: 1073741824,
    maxBodyBytes: 1048576,
    maxBatchRecords: 100,
    maxBatchBytes: 4194304,
    maxPageRecords: 1000,
    maxPageBytes: 8388608,
    retention: 'permanent',
    supportedFeatures: ['archive', 'snapshot'],
  }
  assert.equal(get('capabilities')(caps), true)
  assert.equal(get('capabilities')({ ...caps, protocolVersion: '2' }), false)
  assert.equal(get('store-error')({ status: 'error', code: 'ERR_QUOTA_EXCEEDED', description: 'full' }), true)
  assert.equal(get('store-error')({ status: 'error', code: 'NOPE', description: 'x' }), false)
})
