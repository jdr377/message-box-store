import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MessageBoxArchiveWorker } from '../dist/mod.js'
import { createTransactionalReplicaFixture } from './helpers/replica-store.mjs'

const OWNER = `02${'11'.repeat(32)}`

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function emptyPage() {
  return {
    records: [], nextCursor: null, checkpoint: '0', hasMore: false,
    watermark: '0', epoch: 'epoch-1', serverTime: '2026-09-22T00:00:00.000Z',
  }
}

function meta() {
  return {
    snapshotId: `snap_${'ab'.repeat(16)}`, epoch: 'epoch-1', feed: 'snapshot',
    filterHash: '', watermark: '0', memberCount: 0, status: 'active',
  }
}

test('M3 worker is single-flight and stop fences the local side effect after in-flight HTTP', async () => {
  const fixture = createTransactionalReplicaFixture()
  const pending = deferred()
  const called = deferred()
  let creates = 0
  const historyClient = {
    async createSnapshot() { creates += 1; called.resolve(); return pending.promise },
    async listSnapshotPage() { throw new Error('must not page after stop') },
    async listChanges() { throw new Error('unexpected changes') },
  }
  const worker = new MessageBoxArchiveWorker({ owner: OWNER, historyClient, localStore: fixture.replica })
  const first = worker.syncOnce()
  const second = worker.syncOnce()
  assert.equal(first, second, 'concurrent callers share one cycle')
  await called.promise
  assert.equal(creates, 1)
  const stopping = worker.stop()
  pending.resolve(meta())
  assert.equal((await first).status, 'cancelled')
  await stopping
  assert.equal(await fixture.replica.readCoverage({ owner: OWNER, filter: { direction: null, messageBox: null, participant: null } }), null)
  assert.equal((await worker.syncOnce()).status, 'cancelled')
  assert.equal(creates, 1)
})

test('M3 worker start schedules one bounded cycle and stop prevents future polling', async () => {
  const fixture = createTransactionalReplicaFixture()
  const started = deferred()
  const release = deferred()
  let creates = 0
  const historyClient = {
    async createSnapshot() {
      creates += 1
      started.resolve()
      return release.promise
    },
    async listSnapshotPage() { return emptyPage() },
    async listChanges() { return emptyPage() },
  }
  const worker = new MessageBoxArchiveWorker({
    owner: OWNER,
    historyClient,
    localStore: fixture.replica,
    maxPagesPerCycle: 1,
    pollIntervalMs: 5,
    maxBackoffMs: 20,
  })
  worker.start()
  worker.start()
  await started.promise
  const stopping = worker.stop()
  release.resolve(meta())
  await stopping
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(creates, 1, 'no poll is scheduled after stop')
  assert.throws(() => worker.start(), /stopped/)
})

test('M3 worker enforces finite per-cycle page budgets', async () => {
  const fixture = createTransactionalReplicaFixture()
  let pageCalls = 0
  const historyClient = {
    async createSnapshot() { return { ...meta(), watermark: '2' } },
    async listSnapshotPage() {
      pageCalls += 1
      return {
        records: [], nextCursor: 'opaque-next', checkpoint: '2', hasMore: true,
        watermark: '2', epoch: 'epoch-1', serverTime: '2026-09-22T00:00:00.000Z',
      }
    },
    async listChanges() { throw new Error('unexpected changes') },
  }
  const worker = new MessageBoxArchiveWorker({ owner: OWNER, historyClient, localStore: fixture.replica, maxPagesPerCycle: 1 })
  const result = await worker.syncOnce()
  assert.equal(result.status, 'partial')
  assert.equal(result.pages, 1)
  assert.equal(pageCalls, 1)
  await worker.stop()
})
