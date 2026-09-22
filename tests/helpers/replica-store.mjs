import assert from 'node:assert/strict'

const UINT64 = /^(0|[1-9][0-9]*)$/

function clone(value) {
  return structuredClone(value)
}

function filterKey(filter) {
  return JSON.stringify([filter.direction, filter.messageBox, filter.participant])
}

function scopeKey(scope) {
  return `${scope.owner}\u0000${filterKey(scope.filter)}`
}

function snapshotKey(input) {
  return `${scopeKey(input.scope)}\u0000${input.epoch}\u0000${input.snapshotId}`
}

function recordKey(owner, key) {
  return `${owner}\u0000${key}`
}

function versionOf(coverage) {
  return coverage === undefined
    ? null
    : {
        epoch: coverage.epoch,
        checkpoint: coverage.checkpoint,
        generation: coverage.generation,
        continuation: coverage.continuation,
      }
}

function sameVersion(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function conflict(message = 'replica compare-and-swap failed') {
  return Object.assign(new Error(message), { code: 'ERR_REPLICA_CAS_MISMATCH' })
}

function assertUint64(value, field) {
  if (!UINT64.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new TypeError(`${field} must be a canonical uint64 decimal string`)
  }
}

function nextGeneration(previous) {
  assertUint64(previous, 'generation')
  const next = BigInt(previous) + 1n
  if (next > 18_446_744_073_709_551_615n) throw new RangeError('replica generation exhausted')
  return next.toString()
}

function coverageView(coverage) {
  if (coverage === undefined) return null
  return clone({
    scope: coverage.scope,
    epoch: coverage.epoch,
    checkpoint: coverage.checkpoint,
    generation: coverage.generation,
    continuation: coverage.continuation,
    complete: true,
  })
}

/**
 * Test-only transactional adapter. It deliberately exposes inspection and
 * fault injection outside `replica` so neither becomes part of LocalReplica.
 */
export function createTransactionalReplicaFixture() {
  let state = {
    records: new Map(),
    coverages: new Map(),
    snapshots: new Map(),
    drafts: new Map(),
  }
  const failures = new Set()

  function failIf(operation) {
    if (!failures.delete(operation)) return
    throw Object.assign(new Error(`injected ${operation} failure`), { code: 'ERR_INJECTED_FAILURE' })
  }

  function pruneUnreferenced(next, owner) {
    const referenced = new Set()
    for (const coverage of next.coverages.values()) {
      if (coverage.scope.owner !== owner) continue
      for (const key of coverage.members) referenced.add(key)
    }
    for (const [key, record] of next.records) {
      if (record.owner === owner && !referenced.has(record.record.recordKey)) next.records.delete(key)
    }
  }

  function transact(operation, mutate) {
    const next = clone(state)
    const result = mutate(next)
    failIf(operation)
    state = next
    return result
  }

  const replica = {
    async readCoverage(scope) {
      return coverageView(state.coverages.get(scopeKey(scope)))
    },

    async beginSnapshot(input) {
      assertUint64(input.expected?.checkpoint ?? '0', 'expected checkpoint')
      assertUint64(input.expected?.generation ?? '0', 'expected generation')
      const current = versionOf(state.coverages.get(scopeKey(input.scope)))
      if (!sameVersion(current, input.expected)) throw conflict()
      const key = snapshotKey(input)
      if (state.snapshots.has(key)) throw conflict('snapshot is already staged')
      state.snapshots.set(key, clone({
        scope: input.scope,
        epoch: input.epoch,
        snapshotId: input.snapshotId,
        expected: input.expected,
        records: new Map(),
      }))
    },

    async stageSnapshotPage(input) {
      const key = snapshotKey(input)
      const staged = state.snapshots.get(key)
      if (staged === undefined) throw conflict('snapshot is not staged')
      failIf('stageSnapshotPage')
      for (const record of input.records) staged.records.set(record.recordKey, clone(record))
    },

    async discardSnapshot(input) {
      state.snapshots.delete(snapshotKey(input))
    },

    async commitSnapshot(input) {
      assertUint64(input.checkpoint, 'checkpoint')
      const key = snapshotKey(input)
      const staged = state.snapshots.get(key)
      if (staged === undefined) throw conflict('snapshot is not staged')
      const current = state.coverages.get(scopeKey(input.scope))
      if (!sameVersion(versionOf(current), staged.expected)) throw conflict()

      return transact('commitSnapshot', (next) => {
        const active = next.coverages.get(scopeKey(input.scope))
        const generation = nextGeneration(active?.generation ?? '0')

        // An epoch transition fences every old coverage for this owner before
        // installing the newly complete view.
        for (const [candidateKey, coverage] of next.coverages) {
          if (coverage.scope.owner === input.scope.owner && coverage.epoch !== input.epoch) {
            next.coverages.delete(candidateKey)
          }
        }
        for (const [candidateKey, snapshot] of next.snapshots) {
          if (snapshot.scope.owner === input.scope.owner && snapshot.epoch !== input.epoch) {
            next.snapshots.delete(candidateKey)
          }
        }
        for (const record of staged.records.values()) {
          next.records.set(recordKey(input.scope.owner, record.recordKey), {
            owner: input.scope.owner,
            record: clone(record),
          })
        }
        const coverage = {
          scope: clone(input.scope),
          epoch: input.epoch,
          checkpoint: input.checkpoint,
          generation,
          continuation: null,
          members: new Set(staged.records.keys()),
        }
        next.coverages.set(scopeKey(input.scope), coverage)
        next.snapshots.delete(key)
        pruneUnreferenced(next, input.scope.owner)
        return coverageView(coverage)
      })
    },

    async applyIncrementalPage(input) {
      assertUint64(input.checkpoint, 'checkpoint')
      assertUint64(input.expected.checkpoint, 'expected checkpoint')
      assertUint64(input.expected.generation, 'expected generation')
      if (input.continuation !== null) assertUint64(input.continuation.watermark, 'continuation watermark')
      const current = state.coverages.get(scopeKey(input.scope))
      if (!sameVersion(versionOf(current), input.expected) || current?.epoch !== input.epoch) throw conflict()

      return transact('applyIncrementalPage', (next) => {
        const coverage = next.coverages.get(scopeKey(input.scope))
        for (const event of input.records) {
          if ('body' in event) {
            next.records.set(recordKey(input.scope.owner, event.recordKey), {
              owner: input.scope.owner,
              record: clone(event),
            })
            coverage.members.add(event.recordKey)
          } else {
            // A deletion is owner-wide. Remove it from overlapping coverage as
            // well as shared record storage; replay is naturally idempotent.
            next.records.delete(recordKey(input.scope.owner, event.recordKey))
            for (const candidate of next.coverages.values()) {
              if (candidate.scope.owner === input.scope.owner) candidate.members.delete(event.recordKey)
            }
          }
        }
        coverage.checkpoint = input.checkpoint
        coverage.continuation = clone(input.continuation)
        coverage.generation = nextGeneration(coverage.generation)
        return coverageView(coverage)
      })
    },
  }

  return {
    replica,
    failNext(operation) {
      failures.add(operation)
    },
    seedDraft(draft) {
      state.drafts.set(draft.id, clone(draft))
    },
    inspect(scope) {
      const coverage = state.coverages.get(scopeKey(scope))
      const records = coverage === undefined
        ? []
        : [...coverage.members].map((key) => clone(state.records.get(recordKey(scope.owner, key))?.record)).filter(Boolean)
      return {
        coverage: coverageView(coverage),
        members: coverage === undefined ? [] : [...coverage.members].sort(),
        records: records.sort((a, b) => a.recordKey.localeCompare(b.recordKey)),
        drafts: [...state.drafts.values()].map(clone),
      }
    },
  }
}

const OWNER = `02${'11'.repeat(32)}`
const PEER = `03${'22'.repeat(32)}`
const ALL = Object.freeze({ owner: OWNER, filter: { direction: null, messageBox: null, participant: null } })
const OUTBOUND = Object.freeze({ owner: OWNER, filter: { direction: 'outbound', messageBox: null, participant: null } })

function historyRecord(key, sequence, overrides = {}) {
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

function version(coverage) {
  return {
    epoch: coverage.epoch,
    checkpoint: coverage.checkpoint,
    generation: coverage.generation,
    continuation: coverage.continuation,
  }
}

async function install(fixture, scope, records, options = {}) {
  const epoch = options.epoch ?? 'epoch-1'
  const snapshotId = options.snapshotId ?? `snapshot-${Math.random()}`
  const expected = await fixture.replica.readCoverage(scope)
  await fixture.replica.beginSnapshot({ scope, epoch, snapshotId, expected: expected === null ? null : version(expected) })
  await fixture.replica.stageSnapshotPage({ scope, epoch, snapshotId, records })
  return fixture.replica.commitSnapshot({ scope, epoch, snapshotId, checkpoint: options.checkpoint ?? '1' })
}

/** Run the executable LocalReplica contract against any fresh-fixture factory. */
export async function runReplicaStoreConformance(t, createFixture) {
  await t.test('incremental rows and checkpoint commit together or neither commits', async () => {
    const fixture = createFixture()
    const first = historyRecord('a', '18446744073709551613')
    const second = historyRecord('b', '18446744073709551614')
    const initial = await install(fixture, ALL, [first], { checkpoint: '18446744073709551613' })
    fixture.failNext('applyIncrementalPage')
    await assert.rejects(
      fixture.replica.applyIncrementalPage({
        scope: ALL,
        epoch: 'epoch-1',
        records: [second],
        checkpoint: '18446744073709551614',
        continuation: { cursor: 'opaque-1', watermark: '18446744073709551615' },
        expected: version(initial),
      }),
      (error) => error?.code === 'ERR_INJECTED_FAILURE',
    )
    assert.deepEqual(fixture.inspect(ALL).members, [first.recordKey])
    assert.equal((await fixture.replica.readCoverage(ALL)).checkpoint, '18446744073709551613')

    const committed = await fixture.replica.applyIncrementalPage({
      scope: ALL,
      epoch: 'epoch-1',
      records: [second],
      checkpoint: '18446744073709551614',
      continuation: { cursor: 'opaque-1', watermark: '18446744073709551615' },
      expected: version(initial),
    })
    assert.deepEqual(fixture.inspect(ALL).members, [first.recordKey, second.recordKey])
    assert.equal(committed.checkpoint, '18446744073709551614')
  })

  await t.test('failed or discarded snapshot staging never changes active rows', async () => {
    const fixture = createFixture()
    const active = historyRecord('a', '1')
    const replacement = historyRecord('b', '2')
    const current = await install(fixture, ALL, [active])
    const input = { scope: ALL, epoch: 'epoch-1', snapshotId: 'staging', expected: version(current) }
    await fixture.replica.beginSnapshot(input)
    fixture.failNext('stageSnapshotPage')
    await assert.rejects(
      fixture.replica.stageSnapshotPage({ ...input, records: [replacement] }),
      (error) => error?.code === 'ERR_INJECTED_FAILURE',
    )
    assert.deepEqual(fixture.inspect(ALL).members, [active.recordKey])
    await fixture.replica.stageSnapshotPage({ ...input, records: [replacement] })
    assert.deepEqual(fixture.inspect(ALL).members, [active.recordKey], 'incomplete snapshot remains isolated')
    fixture.failNext('commitSnapshot')
    await assert.rejects(
      fixture.replica.commitSnapshot({ ...input, checkpoint: '2' }),
      (error) => error?.code === 'ERR_INJECTED_FAILURE',
    )
    assert.deepEqual(fixture.inspect(ALL).members, [active.recordKey], 'failed commit rolls back replacement and checkpoint')
    assert.equal((await fixture.replica.readCoverage(ALL)).checkpoint, '1')
    await fixture.replica.discardSnapshot(input)
    assert.deepEqual(fixture.inspect(ALL).members, [active.recordKey])
  })

  await t.test('complete snapshot prunes only its coverage and preserves overlapping views', async () => {
    const fixture = createFixture()
    const shared = historyRecord('b', '2')
    const retained = historyRecord('a', '1')
    await install(fixture, ALL, [retained, shared], { snapshotId: 'all-1' })
    await install(fixture, OUTBOUND, [shared], { snapshotId: 'out-1' })
    await install(fixture, ALL, [retained], { snapshotId: 'all-2', checkpoint: '2' })
    assert.deepEqual(fixture.inspect(ALL).members, [retained.recordKey])
    assert.deepEqual(fixture.inspect(OUTBOUND).members, [shared.recordKey], 'shared row remains referenced')
    await install(fixture, OUTBOUND, [], { snapshotId: 'out-2', checkpoint: '2' })
    assert.deepEqual(fixture.inspect(OUTBOUND).members, [])
    assert.deepEqual(fixture.inspect(ALL).members, [retained.recordKey])
  })

  await t.test('stale snapshot and incremental CAS cannot overwrite newer progress', async () => {
    const fixture = createFixture()
    const current = await install(fixture, ALL, [historyRecord('a', '1')])
    const expected = version(current)
    await fixture.replica.beginSnapshot({ scope: ALL, epoch: 'epoch-1', snapshotId: 'winner', expected })
    await fixture.replica.beginSnapshot({ scope: ALL, epoch: 'epoch-1', snapshotId: 'stale', expected })
    await fixture.replica.commitSnapshot({ scope: ALL, epoch: 'epoch-1', snapshotId: 'winner', checkpoint: '2' })
    await assert.rejects(
      fixture.replica.commitSnapshot({ scope: ALL, epoch: 'epoch-1', snapshotId: 'stale', checkpoint: '3' }),
      (error) => error?.code === 'ERR_REPLICA_CAS_MISMATCH',
    )
    await assert.rejects(
      fixture.replica.applyIncrementalPage({ scope: ALL, epoch: 'epoch-1', records: [], checkpoint: '3', continuation: null, expected }),
      (error) => error?.code === 'ERR_REPLICA_CAS_MISMATCH',
    )
    assert.equal((await fixture.replica.readCoverage(ALL)).checkpoint, '2')
  })

  await t.test('delete replay is idempotent across overlapping coverage', async () => {
    const fixture = createFixture()
    const victim = historyRecord('a', '1')
    const all = await install(fixture, ALL, [victim], { snapshotId: 'all' })
    await install(fixture, OUTBOUND, [victim], { snapshotId: 'out' })
    const deletion = { recordKey: victim.recordKey, sequence: '2', deletedAt: '2026-09-22T00:01:00.000Z' }
    const once = await fixture.replica.applyIncrementalPage({
      scope: ALL, epoch: 'epoch-1', records: [deletion], checkpoint: '2', continuation: null, expected: version(all),
    })
    await fixture.replica.applyIncrementalPage({
      scope: ALL, epoch: 'epoch-1', records: [deletion], checkpoint: '3', continuation: null, expected: version(once),
    })
    assert.deepEqual(fixture.inspect(ALL).members, [])
    assert.deepEqual(fixture.inspect(OUTBOUND).members, [])
  })

  await t.test('epoch replacement invalidates old coverage without sweeping drafts', async () => {
    const fixture = createFixture()
    fixture.seedDraft({ id: 'draft-1', body: 'never reconciled' })
    await install(fixture, ALL, [historyRecord('a', '1')], { snapshotId: 'old-all' })
    await install(fixture, OUTBOUND, [historyRecord('b', '2')], { snapshotId: 'old-out' })
    await install(fixture, ALL, [], { epoch: 'epoch-2', snapshotId: 'new-all', checkpoint: '0' })
    assert.equal(await fixture.replica.readCoverage(OUTBOUND), null, 'old-epoch checkpoint is invalidated')
    assert.deepEqual(fixture.inspect(ALL).records, [], 'old cached rows cannot become upload candidates')
    assert.deepEqual(fixture.inspect(ALL).drafts, [{ id: 'draft-1', body: 'never reconciled' }])
  })
}
