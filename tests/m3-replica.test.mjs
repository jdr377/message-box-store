import assert from 'node:assert/strict'
import { test } from 'node:test'
import { syncHistory } from '../dist/mod.js'
import { createTransactionalReplicaFixture } from './helpers/replica-store.mjs'

const OWNER = `02${'11'.repeat(32)}`
const PEER = `03${'22'.repeat(32)}`
const ALL = { owner: OWNER, filter: { direction: null, messageBox: null, participant: null } }
const OUTBOUND = { owner: OWNER, filter: { direction: 'outbound', messageBox: null, participant: null } }

function record(key, sequence, overrides = {}) {
  return {
    recordKey: key.repeat(64),
    messageId: `message-${key}`,
    messageBox: 'inbox',
    direction: 'outbound',
    sender: OWNER,
    recipient: PEER,
    body: '{"encryptedMessage":"AQ=="}',
    bodyHash: 'ab'.repeat(32),
    bodyBytes: 27,
    deliveryState: 'prepared',
    revision: '1',
    changeSequence: sequence,
    createdAt: '2026-09-22T00:00:00.000Z',
    archivedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  }
}

function page({ records = [], cursor = null, checkpoint, watermark, epoch = 'epoch-1' }) {
  return {
    records,
    nextCursor: cursor,
    checkpoint,
    hasMore: cursor !== null,
    watermark,
    epoch,
    serverTime: '2026-09-22T00:00:00.000Z',
  }
}

function client({ snapshot, snapshotPages = [], changePages = [] }) {
  const calls = []
  return {
    calls,
    async createSnapshot(filter) {
      calls.push(['createSnapshot', filter])
      if (snapshot instanceof Error) throw snapshot
      return snapshot
    },
    async listSnapshotPage(options) {
      calls.push(['listSnapshotPage', options])
      const next = snapshotPages.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('unexpected snapshot page')
      return next
    },
    async listChanges(options) {
      calls.push(['listChanges', options])
      const next = changePages.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('unexpected changes page')
      return next
    },
  }
}

function snapshotMeta(epoch = 'epoch-1', watermark = '2') {
  return {
    snapshotId: `snap_${'ab'.repeat(16)}`,
    epoch,
    feed: 'snapshot',
    filterHash: '',
    watermark,
    memberCount: 0,
    status: 'active',
  }
}

function version(coverage) {
  return {
    epoch: coverage.epoch,
    checkpoint: coverage.checkpoint,
    generation: coverage.generation,
    continuation: coverage.continuation,
  }
}

async function seed(fixture, scope, records, { epoch = 'epoch-1', checkpoint = '1', id = 'seed' } = {}) {
  const current = await fixture.replica.readCoverage(scope)
  await fixture.replica.beginSnapshot({
    scope, epoch, snapshotId: id, expected: current === null ? null : version(current),
  })
  await fixture.replica.stageSnapshotPage({ scope, epoch, snapshotId: id, records })
  return fixture.replica.commitSnapshot({ scope, epoch, snapshotId: id, checkpoint })
}

test('M3 reconciliation stages cache loss, commits complete coverage, then applies post-W changes', async () => {
  const fixture = createTransactionalReplicaFixture()
  const a = record('a', '1')
  const b = record('b', '2')
  const c = record('c', '18446744073709551614')
  const postWatermarkDelete = {
    recordKey: b.recordKey,
    sequence: '18446744073709551615',
    deletedAt: '2026-09-22T00:01:00.000Z',
  }
  const history = client({
    snapshot: snapshotMeta('epoch-1', '2'),
    snapshotPages: [
      page({ records: [a], cursor: 'snapshot-opaque', checkpoint: '2', watermark: '2' }),
      page({ records: [b], checkpoint: '2', watermark: '2' }),
    ],
    changePages: [page({
      records: [postWatermarkDelete, c],
      checkpoint: '18446744073709551615',
      watermark: '18446744073709551615',
    })],
  })
  const result = await syncHistory({ owner: OWNER, historyClient: history, localReplica: fixture.replica, maxPages: 3 })
  assert.equal(result.status, 'complete')
  assert.equal(result.mode, 'snapshot')
  assert.deepEqual(fixture.inspect(ALL).members, [a.recordKey, c.recordKey], 'post-W delete removes a staged snapshot row')
  assert.equal(result.coverage.checkpoint, '18446744073709551615')
  assert.deepEqual(history.calls.at(-1), ['listChanges', { afterSequence: '2', epoch: 'epoch-1' }])
})

test('M3 interrupted snapshot and expired incremental cursor preserve active coverage', async () => {
  const fixture = createTransactionalReplicaFixture()
  const active = record('a', '1')
  await seed(fixture, ALL, [active])
  const expired = Object.assign(new Error('expired'), { code: 'ERR_CURSOR_EXPIRED' })
  const history = client({
    snapshot: snapshotMeta('epoch-1', '2'),
    snapshotPages: [page({ records: [record('b', '2')], cursor: 'more', checkpoint: '2', watermark: '2' })],
    changePages: [expired],
  })
  const result = await syncHistory({ owner: OWNER, historyClient: history, localReplica: fixture.replica, maxPages: 1 })
  assert.equal(result.status, 'partial')
  assert.equal(result.coverage, null)
  assert.deepEqual(fixture.inspect(ALL).members, [active.recordKey], 'incomplete replacement never prunes')
  assert.equal((await fixture.replica.readCoverage(ALL)).checkpoint, '1')
})

test('M3 incremental continuation is atomic, resumable and applies delete replay owner-wide', async () => {
  const fixture = createTransactionalReplicaFixture()
  const victim = record('a', '1')
  const all = await seed(fixture, ALL, [victim], { id: 'all' })
  await seed(fixture, OUTBOUND, [victim], { id: 'out' })
  const deletion = { recordKey: victim.recordKey, sequence: '2', deletedAt: '2026-09-22T00:01:00.000Z' }
  const firstClient = client({
    changePages: [page({ records: [deletion], cursor: 'change-opaque', checkpoint: '2', watermark: '3' })],
  })
  const partial = await syncHistory({ owner: OWNER, historyClient: firstClient, localReplica: fixture.replica, maxPages: 1 })
  assert.equal(partial.status, 'partial')
  assert.deepEqual(partial.coverage.continuation, { cursor: 'change-opaque', watermark: '3' })
  assert.deepEqual(fixture.inspect(ALL).members, [])
  assert.deepEqual(fixture.inspect(OUTBOUND).members, [])

  const secondClient = client({ changePages: [page({ records: [deletion], checkpoint: '3', watermark: '3' })] })
  const complete = await syncHistory({ owner: OWNER, historyClient: secondClient, localReplica: fixture.replica, maxPages: 1 })
  assert.equal(complete.status, 'complete')
  assert.equal(complete.coverage.continuation, null)
  assert.deepEqual(secondClient.calls[0], ['listChanges', { cursor: 'change-opaque' }])
  assert.notEqual(complete.coverage.generation, all.generation)
})

test('M3 epoch reset replaces old coverage while filtered views remain isolated otherwise', async () => {
  const fixture = createTransactionalReplicaFixture()
  await seed(fixture, ALL, [record('a', '1')], { id: 'old-all' })
  await seed(fixture, OUTBOUND, [record('b', '1')], { id: 'old-out' })
  const changed = Object.assign(new Error('epoch changed'), { code: 'ERR_EPOCH_CHANGED' })
  const history = client({
    snapshot: snapshotMeta('epoch-2', '0'),
    snapshotPages: [page({ checkpoint: '0', watermark: '0', epoch: 'epoch-2' })],
    changePages: [changed],
  })
  const result = await syncHistory({ owner: OWNER, historyClient: history, localReplica: fixture.replica, maxPages: 1 })
  assert.equal(result.coverage.epoch, 'epoch-2')
  assert.deepEqual(fixture.inspect(ALL).records, [])
  assert.equal(await fixture.replica.readCoverage(OUTBOUND), null, 'all old-epoch filtered checkpoints are fenced')
})

test('M3 filters are normalized and stale CAS or inconsistent fixed-W pages fail closed', async () => {
  const fixture = createTransactionalReplicaFixture()
  const active = await seed(fixture, OUTBOUND, [record('a', '1')])
  let raced = false
  const racingReplica = new Proxy(fixture.replica, {
    get(target, property) {
      if (property !== 'applyIncrementalPage') return target[property].bind(target)
      return async (input) => {
        if (!raced) {
          raced = true
          await target.applyIncrementalPage({ ...input, records: [], checkpoint: input.checkpoint })
        }
        return target.applyIncrementalPage(input)
      }
    },
  })
  const history = client({ changePages: [page({ records: [record('b', '2')], checkpoint: '2', watermark: '2' })] })
  await assert.rejects(
    syncHistory({ owner: OWNER, filter: { direction: 'outbound' }, historyClient: history, localReplica: racingReplica }),
    (error) => error?.code === 'ERR_REPLICA_CAS_MISMATCH',
  )
  assert.deepEqual(history.calls[0][1], { direction: 'outbound', afterSequence: active.checkpoint, epoch: active.epoch })

  const current = await fixture.replica.readCoverage(OUTBOUND)
  const inconsistent = client({
    changePages: [page({ records: [], cursor: 'next', checkpoint: current.checkpoint, watermark: '3' })],
  })
  const one = await syncHistory({ owner: OWNER, filter: { direction: 'outbound' }, historyClient: inconsistent, localReplica: fixture.replica, maxPages: 1 })
  assert.equal(one.status, 'partial')
  const wrong = client({ changePages: [page({ records: [], checkpoint: '4', watermark: '4' })] })
  await assert.rejects(
    syncHistory({ owner: OWNER, filter: { direction: 'outbound' }, historyClient: wrong, localReplica: fixture.replica }),
    (error) => error?.code === 'ERR_REPLICA_PAGE_INCONSISTENT',
  )
})
