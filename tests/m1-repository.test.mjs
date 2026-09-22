import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MYSQL_SCHEMA_SQL, SQLITE_SCHEMA_SQL, MIGRATION_VERSION } from '../src/migrations.mjs'
import { createMemoryStore, createSqliteStore } from '../src/repository.mjs'
import { LIMITS } from '../src/protocol.mjs'

const OWNER = `02${'11'.repeat(32)}`
const PEER = `03${'22'.repeat(32)}`
const OTHER = `03${'33'.repeat(32)}`
const BODY_A = '{"encryptedMessage":"AQ=="}'
const BODY_B = '{"encryptedMessage":"AQI="}'

function record({ messageId, messageBox = 'inbox', direction = 'outbound', sender = OWNER, recipient = PEER, body = BODY_A, deliveryState } = {}) {
  const r = { messageId, messageBox, direction, sender, recipient, body }
  if (deliveryState) r.deliveryState = deliveryState
  return r
}

function canonicalBodyOfSize(size) {
  const prefix = '{"encryptedMessage":"'
  const suffix = '"}'
  const payloadLength = Math.floor((size - prefix.length - suffix.length) / 4) * 4
  const core = `${prefix}${'A'.repeat(payloadLength)}${suffix}`
  return `${' '.repeat(size - core.length)}${core}`
}

function usageOf(store, owner = OWNER) {
  return store.getUsage({ owner })
}

async function freshStores() {
  const mem = createMemoryStore()
  const sqlite = await createSqliteStore()
  return { mem, sqlite }
}

test('M1 shared archive contract preserves rejection and conflict outcomes across adapters', async (t) => {
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  for (const [index, store] of [createMemoryStore(), sqlite].entries()) {
    const owner = `02${(index === 0 ? 'a4' : 'a5').repeat(32)}`
    const peer = `03${'b4'.repeat(32)}`
    const valid = record({ messageId: `contract-${index}`, sender: owner, recipient: peer })

    const invalidOwner = await store.archiveBatch({ owner: 'invalid-owner', epoch: 'gen-1', records: [valid] })
    assert.deepEqual(
      { outcome: invalidOwner.outcomes[0].outcome, errorCode: invalidOwner.outcomes[0].errorCode },
      { outcome: 'invalid', errorCode: 'ERR_INVALID_RECORD' },
    )

    for (const forged of [
      { ...valid, messageId: `forged-key-${index}`, recordKey: 'f'.repeat(64) },
      { ...valid, messageId: `forged-hash-${index}`, bodyHash: 'e'.repeat(64) },
      { ...valid, messageId: `invalid-state-${index}`, deliveryState: 'accepted' },
    ]) {
      const rejected = await store.archiveBatch({ owner, epoch: 'gen-1', records: [forged] })
      assert.equal(rejected.outcomes[0].outcome, 'invalid')
      assert.equal(rejected.outcomes[0].errorCode, 'ERR_INVALID_RECORD')
    }

    const first = await store.archiveBatch({ owner, epoch: 'gen-1', records: [valid] })
    assert.equal(first.outcomes[0].outcome, 'stored')
    const conflict = await store.archiveBatch({ owner, epoch: 'gen-1', records: [{ ...valid, body: BODY_B }] })
    assert.equal(conflict.outcomes[0].outcome, 'conflict')
    assert.equal(conflict.outcomes[0].errorCode, 'ERR_IMMUTABLE_CONFLICT')
  }
})

test('M1 concurrent devices produce one immutable row with ordered sequences and exact quotas', async () => {
  for (const store of [createMemoryStore(), await createSqliteStore()]) {
    const input = record({ messageId: 'concurrent-1' })
    const [a, b] = await Promise.all([
      store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [input] }),
      store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [input] }),
    ])
    const storedCount = [...a.outcomes, ...b.outcomes].filter((o) => o.outcome === 'stored').length
    const presentCount = [...a.outcomes, ...b.outcomes].filter((o) => o.outcome === 'alreadyPresent').length
    assert.ok(storedCount === 1 && presentCount === 1, JSON.stringify({ a, b }))
    const usage = usageOf(store)
    assert.equal(usage.recordCount, 1)
    assert.equal(usage.byteCount, Buffer.byteLength(BODY_A, 'utf8'))
    const changes = store.listChanges({ owner: OWNER })
    assert.equal(changes.length, 1, 'retry allocates no event')
    assert.equal(store.getRecord({ owner: OWNER, recordKey: a.outcomes[0].recordKey ?? b.outcomes[0].recordKey }).body, BODY_A)
  }
})

test('M1 rollback reports no successes and leaves no partial state', async () => {
  const store = createMemoryStore()
  store.injectCommitFailureOnce()
  const result = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'rollback-1' })] })
  assert.equal(result.committed, false)
  assert.ok(result.outcomes.every((o) => o.outcome !== 'stored'), 'no successes on rollback')
  assert.equal(usageOf(store).recordCount, 0)
  assert.equal(usageOf(store).byteCount, 0)
  assert.equal(store.listChanges({ owner: OWNER }).length, 0)
})

test('M1 idempotent retry allocates no event or quota charge', async () => {
  const store = createMemoryStore()
  const first = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'retry-1' })] })
  assert.equal(first.outcomes[0].outcome, 'stored')
  const before = usageOf(store)
  const seqBefore = store.listChanges({ owner: OWNER }).length
  const second = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'retry-1' })] })
  assert.equal(second.outcomes[0].outcome, 'alreadyPresent')
  assert.deepEqual(usageOf(store), before)
  assert.equal(store.listChanges({ owner: OWNER }).length, seqBefore)
})

test('M1 duplicate-before-quota succeeds at full quota; new writes fail', async () => {
  const store = createMemoryStore({ limits: { MAX_RECORDS_PER_OWNER: 2, MAX_BYTES_PER_OWNER: 10_000 } })
  await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'q-1' }), record({ messageId: 'q-2' })] })
  assert.equal(usageOf(store).recordCount, 2)
  const retry = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'q-1' })] })
  assert.equal(retry.outcomes[0].outcome, 'alreadyPresent')
  const over = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'q-3' })] })
  assert.equal(over.outcomes[0].outcome, 'quotaExceeded')
  assert.equal(over.outcomes[0].errorCode, 'ERR_QUOTA_EXCEEDED')
})

test('M1 immutable conflict quarantines without overwrite and audits', async () => {
  const store = createMemoryStore()
  await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'conf-1', body: BODY_A })] })
  const conflict = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'conf-1', body: BODY_B })] })
  assert.equal(conflict.outcomes[0].outcome, 'conflict')
  assert.equal(conflict.outcomes[0].errorCode, 'ERR_IMMUTABLE_CONFLICT')
  const kept = store.getRecord({ owner: OWNER, recordKey: conflict.outcomes[0].recordKey })
  assert.equal(kept.body, BODY_A)
  assert.equal(store._debug.audits.get(OWNER).length, 1)
  assert.equal(usageOf(store).recordCount, 1)
})

test('M1 accepted cannot downgrade and deletion wins over state', async () => {
  const store = createMemoryStore()
  const archived = await store.archiveBatch({
    owner: OWNER,
    epoch: 'gen-1',
    records: [record({ messageId: 'state-1', deliveryState: 'prepared' })],
  })
  const key = archived.outcomes[0].recordKey
  const accepted = await store.patchState({ owner: OWNER, recordKey: key, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'repo-accept' })
  assert.equal(accepted.ok, true)
  await assert.rejects(store.patchState({ owner: OWNER, recordKey: key, newState: 'unknown', expectedRevision: accepted.revision, idempotencyKey: 'repo-downgrade' }), /accepted cannot downgrade/)
  await assert.rejects(store.patchState({ owner: OWNER, recordKey: key, newState: 'failed', expectedRevision: '999', idempotencyKey: 'repo-stale' }), /revision conflict/)
  const deleted = await store.deleteRecord({ owner: OWNER, recordKey: key })
  assert.equal(deleted.deleted, true)
  assert.equal(usageOf(store).recordCount, 0, 'deletion releases quota in the same transaction')
  await assert.rejects(store.patchState({ owner: OWNER, recordKey: key, newState: 'accepted', expectedRevision: accepted.revision, idempotencyKey: 'repo-deleted' }), /deletion wins/)
  const reupload = await store.archiveBatch({ owner: OWNER, epoch: deleted.epoch, records: [record({ messageId: 'state-1' })] })
  assert.equal(reupload.outcomes[0].outcome, 'deleted', 'tombstone reupload must not resurrect')
})

test('M1 identifiers are case-sensitive; box case yields distinct keys', async () => {
  const store = createMemoryStore()
  const lower = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'Case-1', messageBox: 'inbox' })] })
  const upper = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'Case-1', messageBox: 'Inbox' })] })
  assert.equal(lower.outcomes[0].outcome, 'stored')
  assert.equal(upper.outcomes[0].outcome, 'stored')
  assert.notEqual(lower.outcomes[0].recordKey, upper.outcomes[0].recordKey)
  assert.equal(usageOf(store).recordCount, 2)
})

test('M1 batch admits in request order with commit-ordered sequences', async () => {
  const store = createMemoryStore()
  const result = await store.archiveBatch({
    owner: OWNER,
    epoch: 'gen-1',
    records: [record({ messageId: 'ord-1' }), record({ messageId: 'ord-2' }), record({ messageId: 'ord-3' })],
  })
  assert.ok(result.outcomes.every((o) => o.outcome === 'stored'))
  const seqs = result.outcomes.map((o) => o.sequence)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)))
  assert.deepEqual(store.listChanges({ owner: OWNER }).map((c) => c.sequence), seqs)
})

test('M1 stale epoch fails closed; delete-all rotates epoch and clears quota', async () => {
  const store = createMemoryStore()
  await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'ep-1' })] })
  const stale = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'ep-2' })] })
  assert.equal(stale.outcomes[0].outcome, 'stored', 'same epoch still valid')
  const wiped = await store.deleteAll({ owner: OWNER })
  assert.notEqual(wiped.epoch, 'gen-1')
  assert.equal(usageOf(store).recordCount, 0)
  const afterWipe = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'ep-3' })] })
  assert.equal(afterWipe.outcomes[0].outcome, 'epochChanged')
  assert.equal(afterWipe.outcomes[0].errorCode, 'ERR_EPOCH_CHANGED')
  const current = await store.archiveBatch({ owner: OWNER, epoch: wiped.epoch, records: [record({ messageId: 'ep-3' })] })
  assert.equal(current.outcomes[0].outcome, 'stored')
})

test('M1 delete-all expectedEpoch CAS is atomic and exact retries replay across adapters', async (t) => {
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  for (const [index, store] of [createMemoryStore(), sqlite].entries()) {
    const owner = `02${(index === 0 ? '44' : '55').repeat(32)}`
    const peer = `03${'66'.repeat(32)}`
    const initial = await store.archiveBatch({ owner, epoch: 'gen-1', records: [record({ owner, sender: owner, recipient: peer, messageId: `cas-base-${index}` })] })
    assert.equal(initial.outcomes[0].outcome, 'stored')
    const expectedEpoch = (await store.getUsage({ owner })).epoch
    const concurrent = await Promise.allSettled([
      store.deleteAll({ owner, expectedEpoch }),
      store.deleteAll({ owner, expectedEpoch }),
    ])
    const fulfilled = concurrent.filter((result) => result.status === 'fulfilled')
    const rejected = concurrent.filter((result) => result.status === 'rejected')
    assert.equal(fulfilled.length, 1, `${store.kind ?? 'memory'} has one CAS winner`)
    assert.equal(rejected.length, 1, `${store.kind ?? 'memory'} has one CAS loser`)
    assert.equal(rejected[0].reason?.code, 'ERR_EPOCH_CHANGED')
    const winner = fulfilled[0].value
    const usageAfterRace = await store.getUsage({ owner })
    assert.deepEqual({ epoch: usageAfterRace.epoch, recordCount: usageAfterRace.recordCount, byteCount: usageAfterRace.byteCount }, { epoch: winner.epoch, recordCount: 0, byteCount: 0 })

    const seeded = await store.archiveBatch({ owner, epoch: winner.epoch, records: [record({ owner, sender: owner, recipient: peer, messageId: `cas-new-${index}` })] })
    assert.equal(seeded.outcomes[0].outcome, 'stored')
    await assert.rejects(store.deleteAll({ owner, expectedEpoch }), (error) => error?.code === 'ERR_EPOCH_CHANGED')
    assert.equal((await store.getUsage({ owner })).recordCount, 1, 'stale CAS has no deletion effect')

    const replayKey = `cas-replay-${index}`
    const first = await store.deleteAll({ owner, expectedEpoch: winner.epoch, idempotencyKey: replayKey })
    const afterFirstEpoch = first.epoch
    const newer = await store.archiveBatch({ owner, epoch: afterFirstEpoch, records: [record({ owner, sender: owner, recipient: peer, messageId: `cas-retry-${index}` })] })
    assert.equal(newer.outcomes[0].outcome, 'stored')
    const replay = await store.deleteAll({ owner, expectedEpoch: winner.epoch, idempotencyKey: replayKey })
    assert.equal(replay.replayed, true)
    assert.equal(replay.epoch, afterFirstEpoch)
    assert.equal((await store.getUsage({ owner })).recordCount, 1, 'exact retry does not erase newer history')
    await assert.rejects(store.deleteAll({ owner, expectedEpoch: afterFirstEpoch, idempotencyKey: replayKey }), (error) => error?.code === 'ERR_IDEMPOTENCY_CONFLICT')
  }
})

test('M1 archive record byte cap preserves typed size outcomes across memory and SQLite', async (t) => {
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  for (const [index, store] of [createMemoryStore(), sqlite].entries()) {
    const owner = `02${(index === 0 ? '77' : '88').repeat(32)}`
    const peer = `03${'99'.repeat(32)}`
    const epoch = (await store.getUsage({ owner })).epoch
    const exact = await store.archiveBatch({ owner, epoch, records: [record({ owner, sender: owner, recipient: peer, messageId: `body-cap-${index}`, body: canonicalBodyOfSize(LIMITS.MAX_BODY_BYTES) })] })
    assert.equal(exact.outcomes[0].outcome, 'stored', `${store.kind ?? 'memory'} accepts exact body cap`)
    const over = await store.archiveBatch({ owner, epoch, records: [record({ owner, sender: owner, recipient: peer, messageId: `body-over-${index}`, body: canonicalBodyOfSize(LIMITS.MAX_BODY_BYTES + 1) })] })
    assert.equal(over.outcomes[0].outcome, 'invalid')
    assert.equal(over.outcomes[0].errorCode, 'ERR_REQUEST_TOO_LARGE')
    const malformed = await store.archiveBatch({ owner, epoch, records: [record({ owner, sender: owner, recipient: peer, messageId: `body-malformed-${index}`, body: '{"encryptedMessage":"A"}' })] })
    assert.equal(malformed.outcomes[0].errorCode, 'ERR_INVALID_RECORD')
    await store.deleteAll({ owner })
  }
})

test('M1 migrations carry case-sensitive schema, indexes and idempotent versions', async () => {
  assert.equal(MIGRATION_VERSION, '001-init')
  for (const sql of [MYSQL_SCHEMA_SQL, SQLITE_SCHEMA_SQL]) {
    assert.ok(sql.includes('history_records'))
    assert.ok(sql.includes('history_owner_state'))
    assert.ok(sql.includes('history_changes'))
    assert.ok(sql.includes('history_resource_locks'))
    assert.ok(sql.includes('UNIQUE') || sql.includes('uq_owner_record'))
  }
  assert.ok(MYSQL_SCHEMA_SQL.includes('utf8mb4_bin'), 'MySQL must use binary collation for case-sensitive IDs')
  assert.ok(MYSQL_SCHEMA_SQL.includes('idx_owner_seq'))
  assert.ok(MYSQL_SCHEMA_SQL.includes('idx_owner_box_created'))
  assert.ok(SQLITE_SCHEMA_SQL.includes('CREATE UNIQUE INDEX') || SQLITE_SCHEMA_SQL.includes('uq_owner_record'))

  const { sqlite } = await freshStores()
  assert.equal(sqlite.kind, 'sqlite-persistent')
  const plans = sqlite.indexEvidence()
  const planText = JSON.stringify(plans)
  assert.ok(planText.length > 0)
  // SQLite should use an index/search for owner-scoped lookups, never a full scan without intent.
  assert.ok(/SEARCH|USING (INDEX|COVERING)/i.test(planText), `expected indexed plans, got ${planText}`)

  // Fresh + upgrade are idempotent: re-running schema must not fail.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec(SQLITE_SCHEMA_SQL)
  db.exec(SQLITE_SCHEMA_SQL)
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name)
  for (const t of ['history_records', 'history_owner_state', 'history_changes', 'history_resource_locks', 'history_audit_events']) {
    assert.ok(tables.includes(t), `missing ${t}`)
  }
})

test('M1 SQLite parity: same outcomes as memory backend', async () => {
  const { mem, sqlite } = await freshStores()
  for (const store of [mem, sqlite]) {
    const r = await store.archiveBatch({ owner: OTHER, epoch: 'gen-1', records: [record({ messageId: 'parity-1', sender: OTHER, recipient: OWNER, direction: 'outbound' })] })
    assert.equal(r.outcomes[0].outcome, 'stored')
    assert.equal(store.getUsage({ owner: OTHER }).recordCount, 1)
  }
  assert.equal(mem.getUsage({ owner: OTHER }).recordCount, sqlite.getUsage({ owner: OTHER }).recordCount)
})

test('M1 limits mirror PRD planning defaults', () => {
  assert.equal(LIMITS.MAX_RECORDS_PER_OWNER, 10_000)
  assert.equal(LIMITS.MAX_BYTES_PER_OWNER, 1024 * 1024 * 1024)
  assert.equal(LIMITS.MAX_BODY_BYTES, 1024 * 1024)
  assert.equal(LIMITS.MAX_BATCH_RECORDS, 100)
})
