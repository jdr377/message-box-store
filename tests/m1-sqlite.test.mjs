import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { test } from 'node:test'

import { createSqliteStore } from '../src/repository.sqlite.mjs'
import { newChangesCursor } from '../src/feeds.mjs'
import { createMemoryStore } from '../src/repository.mjs'
import { EXPECTED_MIGRATION_CHECKSUMS, SQLITE_IDEMPOTENCY_SCHEMA_SQL } from '../src/migrations.mjs'

const OWNER = `02${'cc'.repeat(32)}`
const PEER = `03${'dd'.repeat(32)}`
const BODY_A = '{"encryptedMessage":"AQ=="}'
const BODY_B = '{"encryptedMessage":"AQI="}'

let dbCounter = 0
function tempPath() {
  dbCounter += 1
  return join(tmpdir(), `mbs-sqlite-${process.pid}-${dbCounter}.db`)
}

function record({ messageId, body = BODY_A, deliveryState } = {}) {
  const r = { messageId, messageBox: 'inbox', direction: 'outbound', sender: OWNER, recipient: PEER, body }
  if (deliveryState) r.deliveryState = deliveryState
  return r
}

function count(db, sql, ...params) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params).n)
}

test('M1 SQLite is the state of record: direct SQL proves archive, state, delete and usage', async (t) => {
  const path = tempPath()
  t.after(() => {
    try {
      unlinkSync(path)
    } catch {}
  })
  const store = await createSqliteStore({ path })
  t.after(() => store.close())

  const archived = await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'persist-1', deliveryState: 'prepared' })] })
  const key = archived.outcomes[0].recordKey
  assert.equal(archived.outcomes[0].outcome, 'stored')

  // Direct database assertions, never store getters.
  assert.equal(count(store.db, `SELECT * FROM history_records WHERE owner_identity_key = ?`, OWNER), 1)
  assert.equal(store.db.prepare(`SELECT body FROM history_records WHERE record_key = ?`).get(key).body, BODY_A)
  assert.equal(Number(store.db.prepare(`SELECT record_count AS n FROM history_owner_state WHERE owner_identity_key = ?`).get(OWNER).n), 1)
  assert.equal(count(store.db, `SELECT * FROM history_changes WHERE owner_identity_key = ? AND kind = 'upsert'`, OWNER), 1)

  const patched = await store.patchState({ owner: OWNER, recordKey: key, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'sqlite-patch-1' })
  assert.equal(store.db.prepare(`SELECT delivery_state AS s FROM history_records WHERE record_key = ?`).get(key).s, 'accepted')
  assert.equal(store.db.prepare(`SELECT revision AS r FROM history_records WHERE record_key = ?`).get(key).r, String(patched.revision))
  assert.equal(count(store.db, `SELECT * FROM history_changes WHERE kind = 'state'`), 1)

  const deleted = await store.deleteRecord({ owner: OWNER, recordKey: key })
  assert.equal(deleted.deleted, true)
  assert.equal(count(store.db, `SELECT * FROM history_records WHERE owner_identity_key = ?`, OWNER), 0, 'live body purged immediately')
  assert.equal(Number(store.db.prepare(`SELECT byte_count AS n FROM history_owner_state WHERE owner_identity_key = ?`).get(OWNER).n), 0, 'quota released')
  const lastKind = store.db.prepare(`SELECT kind FROM history_changes WHERE owner_identity_key = ? ORDER BY LENGTH(change_sequence), change_sequence DESC LIMIT 1`).get(OWNER).kind
  assert.equal(lastKind, 'delete', 'bounded body-free delete event retained')

  const wiped = await store.deleteAll({ owner: OWNER })
  assert.notEqual(wiped.epoch, 'gen-1')
  assert.equal(store.db.prepare(`SELECT epoch FROM history_owner_state WHERE owner_identity_key = ?`).get(OWNER).epoch, wiped.epoch)
})

test('M1 injected SQL failure rolls back every observable state and reports no success', async (t) => {
  const path = tempPath()
  t.after(() => {
    try {
      unlinkSync(path)
    } catch {}
  })
  const store = await createSqliteStore({ path })
  t.after(() => store.close())
  await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'base-1' })] })
  const usageBefore = store.getUsage({ owner: OWNER })
  const recordsBefore = count(store.db, `SELECT * FROM history_records WHERE owner_identity_key = ?`, OWNER)
  const changesBefore = count(store.db, `SELECT * FROM history_changes WHERE owner_identity_key = ?`, OWNER)

  const failing = await createSqliteStore({ path })
  failing.injectCommitFailureOnce()
  // Second handle on the same file must not observe uncommitted state.
  const result = await failing.archiveBatch({ owner: OWNER, epoch: usageBefore.epoch, records: [record({ messageId: 'doomed-1' })] })
  assert.equal(result.committed, false)
  assert.ok(result.outcomes.every((o) => o.outcome !== 'stored'), 'rollback reports no successes')
  failing.close()

  assert.equal(count(store.db, `SELECT * FROM history_records WHERE owner_identity_key = ?`, OWNER), recordsBefore)
  assert.equal(count(store.db, `SELECT * FROM history_changes WHERE owner_identity_key = ?`, OWNER), changesBefore)
  assert.deepEqual(store.getUsage({ owner: OWNER }), usageBefore)
})

test('M1 closing and reopening preserves records, changes, usage and epoch', async (t) => {
  const path = tempPath()
  t.after(() => {
    try {
      unlinkSync(path)
    } catch {}
  })
  const first = await createSqliteStore({ path })
  const archived = await first.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'reopen-1' }), record({ messageId: 'reopen-2' })] })
  const usageBefore = first.getUsage({ owner: OWNER })
  const key = archived.outcomes[0].recordKey
  first.close()

  const second = await createSqliteStore({ path })
  t.after(() => second.close())
  assert.deepEqual(second.getUsage({ owner: OWNER }), usageBefore)
  assert.equal(second.getRecord({ owner: OWNER, recordKey: key }).body, BODY_A)
  assert.equal(second.listChanges({ owner: OWNER }).length, 2)
})

test('M1 SQLite recorded checksum tamper fails without rewrite, then repaired history reopens cleanly', async (t) => {
  const path = tempPath()
  t.after(() => { try { unlinkSync(path) } catch {} })
  const first = await createSqliteStore({ path })
  first.db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = '001-init'`).run('0'.repeat(64))
  first.close()
  await assert.rejects(createSqliteStore({ path }), /recorded checksum differs/)
  const { DatabaseSync } = await import('node:sqlite')
  const repair = new DatabaseSync(path)
  assert.equal(repair.prepare(`SELECT checksum FROM schema_migrations WHERE version = '001-init'`).get().checksum, '0'.repeat(64), 'failed reopen did not rewrite stamp')
  repair.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = '001-init'`).run(EXPECTED_MIGRATION_CHECKSUMS['sqlite:001-init'])
  repair.close()
  const resumed = await createSqliteStore({ path })
  assert.equal(resumed.db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get().n, 4)
  resumed.close()
  const clean = await createSqliteStore({ path })
  clean.close()
})

test('M1 SQLite unknown recorded migration fails before schema or history changes', async (t) => {
  const path = tempPath()
  t.after(() => { try { unlinkSync(path) } catch {} })
  const first = await createSqliteStore({ path })
  first.db.prepare(`INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)`).run('999-unknown', 'f'.repeat(64))
  const countBefore = first.db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get().n
  first.close()
  await assert.rejects(createSqliteStore({ path }), /unknown version 999-unknown/)
  const { DatabaseSync } = await import('node:sqlite')
  const inspect = new DatabaseSync(path)
  assert.equal(inspect.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get().n, countBefore)
  assert.equal(inspect.prepare(`SELECT checksum FROM schema_migrations WHERE version = '999-unknown'`).get().checksum, 'f'.repeat(64))
  inspect.prepare(`DELETE FROM schema_migrations WHERE version = '999-unknown'`).run()
  inspect.close()
  const repaired = await createSqliteStore({ path })
  repaired.close()
})

test('M1 SQLite malformed recorded 003 fails without blessing, then repaired schema resumes', async (t) => {
  const path = tempPath()
  t.after(() => { try { unlinkSync(path) } catch {} })
  const first = await createSqliteStore({ path })
  const originalStamp = first.db.prepare(`SELECT checksum FROM schema_migrations WHERE version = '003-idempotency'`).get().checksum
  first.db.exec(`DROP TABLE history_idempotency; CREATE TABLE history_idempotency (owner_identity_key TEXT PRIMARY KEY)`)
  first.close()
  await assert.rejects(createSqliteStore({ path }), /history_idempotency/)
  const { DatabaseSync } = await import('node:sqlite')
  const repair = new DatabaseSync(path)
  assert.equal(repair.prepare(`SELECT checksum FROM schema_migrations WHERE version = '003-idempotency'`).get().checksum, originalStamp, 'failed reopen did not bless malformed 003')
  assert.deepEqual(repair.prepare(`PRAGMA table_info(history_idempotency)`).all().map((row) => row.name), ['owner_identity_key'])
  repair.exec(`DROP TABLE history_idempotency; ${SQLITE_IDEMPOTENCY_SCHEMA_SQL}`)
  repair.close()
  const resumed = await createSqliteStore({ path })
  assert.equal(resumed.db.prepare(`SELECT checksum FROM schema_migrations WHERE version = '003-idempotency'`).get().checksum, originalStamp)
  resumed.close()
  const clean = await createSqliteStore({ path })
  clean.close()
})

test('M1 no read path falls back to memory: SQL-planted rows are visible', async (t) => {
  const store = await createSqliteStore()
  t.after(() => store.close())
  await store.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'plant-0' })] })
  // Bypass the store entirely: a row only SQL knows about must be readable.
  const usage = store.getUsage({ owner: OWNER })
  const seq = usage.nextSequence
  store.db.prepare(`UPDATE history_owner_state SET next_sequence = ? WHERE owner_identity_key = ?`).run(String(BigInt(seq) + 1n), OWNER)
  const plantedKey = 'f'.repeat(64)
  store.db.prepare(
    `INSERT INTO history_records (owner_identity_key, record_key, message_id, message_box, direction, sender, recipient, body, body_hash, body_bytes, delivery_state, revision, change_sequence)
     VALUES (?, ?, 'planted', 'inbox', 'outbound', ?, ?, '{"encryptedMessage":"AQ=="}', ?, 27, 'received', '1', ?)`,
  ).run(OWNER, plantedKey, OWNER, PEER, '0084794ecc214b1345494cd74a5758785b703aa54b89b1ff36b5087dc65ff8ce', seq)
  assert.equal(store.getRecord({ owner: OWNER, recordKey: plantedKey }).messageId, 'planted')
})

test('M1 persistent SQLite matches the canonical contract (quota, conflict, CAS, deletion-wins)', async (t) => {
  const store = await createSqliteStore({ limits: { MAX_RECORDS_PER_OWNER: 2, MAX_BYTES_PER_OWNER: 10_000 } })
  t.after(() => store.close())
  const mem = createMemoryStore({ limits: { MAX_RECORDS_PER_OWNER: 2, MAX_BYTES_PER_OWNER: 10_000 } })

  for (const candidate of [store, mem]) {
    const first = await candidate.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'c-1' }), record({ messageId: 'c-2' })] })
    assert.ok(first.outcomes.every((o) => o.outcome === 'stored'))
    const retry = await candidate.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'c-1' })] })
    assert.equal(retry.outcomes[0].outcome, 'alreadyPresent')
    const over = await candidate.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'c-3' })] })
    assert.equal(over.outcomes[0].outcome, 'quotaExceeded')
    const conflict = await candidate.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'c-1', body: BODY_B })] })
    assert.equal(conflict.outcomes[0].outcome, 'conflict')
    const key = first.outcomes[0].recordKey
    const accepted = await candidate.patchState({ owner: OWNER, recordKey: key, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'sqlite-candidate-accept' })
    assert.equal(accepted.ok, true)
    await assert.rejects(candidate.patchState({ owner: OWNER, recordKey: key, newState: 'unknown', expectedRevision: accepted.revision, idempotencyKey: 'sqlite-candidate-downgrade' }), /accepted cannot downgrade/)
    await candidate.deleteRecord({ owner: OWNER, recordKey: key })
    const reupload = await candidate.archiveBatch({ owner: OWNER, epoch: (await candidate.getUsage({ owner: OWNER })).epoch, records: [record({ messageId: 'c-1' })] })
    // Memory and persistent backends agree on tombstone behavior.
    assert.equal(reupload.outcomes[0].outcome, 'deleted')
    await candidate.deleteAll({ owner: OWNER })
  }
})

test('M1 SQLite pre-004 upgrade fails closed and backfills numeric latest tombstone', async (t) => {
  const path = tempPath()
  t.after(() => { try { unlinkSync(path) } catch {} })
  const initial = await createSqliteStore({ path })
  const archived = await initial.archiveBatch({ owner: OWNER, epoch: 'gen-1', records: [record({ messageId: 'legacy-004' })] })
  const key = archived.outcomes[0].recordKey
  await initial.deleteRecord({ owner: OWNER, recordKey: key })
  initial.close()

  const { DatabaseSync } = await import('node:sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec(`DROP TABLE history_change_details; DROP TABLE history_change_boundaries; DROP TABLE history_tombstones; DELETE FROM schema_migrations WHERE version='004-tombstones'`)
  legacy.prepare(`INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version, deleted_at, created_at) VALUES (?, '10', ?, 'delete', '1', ?, ?)`).run(OWNER, key, '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z')
  legacy.prepare(`UPDATE history_owner_state SET next_sequence='11' WHERE owner_identity_key=?`).run(OWNER)
  legacy.close()

  const upgraded = await createSqliteStore({ path })
  t.after(() => upgraded.close())
  const tombstone = upgraded.db.prepare(`SELECT change_sequence FROM history_tombstones WHERE owner_identity_key=? AND record_key=?`).get(OWNER, key)
  assert.equal(tombstone.change_sequence, '10', 'numeric sequence 10 wins over lexical sequence 2')
  assert.throws(() => upgraded.listChangesPage({ owner: OWNER, serverSecret: 'legacy-upgrade-secret' }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')
  const retried = await upgraded.archiveBatch({ owner: OWNER, epoch: (await upgraded.getUsage({ owner: OWNER })).epoch, records: [record({ messageId: 'legacy-004' })] })
  assert.equal(retried.outcomes[0].outcome, 'deleted', 'backfilled fence prevents resurrection')
  const epoch = (await upgraded.getUsage({ owner: OWNER })).epoch
  const post = await upgraded.archiveBatch({ owner: OWNER, epoch, records: [record({ messageId: 'post-004-faithful' })] })
  await upgraded.patchState({ owner: OWNER, recordKey: post.outcomes[0].recordKey, newState: 'received', expectedRevision: '1', idempotencyKey: 'post-004-state' })
  const W = String(BigInt((await upgraded.getUsage({ owner: OWNER })).nextSequence) - 1n)
  const cursor = newChangesCursor({ serverSecret: 'legacy-upgrade-secret-012345', owner: OWNER, epoch, filterDigest: '', watermark: W, position: '10' })
  const page = await upgraded.listChangesPage({ owner: OWNER, serverSecret: 'legacy-upgrade-secret-012345', cursor, limit: 10 })
  assert.deepEqual(page.records.map((row) => [row.changeSequence, row.revision, row.deliveryState]), [['11', '1', 'prepared'], ['12', '2', 'received']], 'post-004 event details are faithful and do not leak later state')
  upgraded.db.prepare(`UPDATE history_changes SET created_at='2020-01-01T00:00:00.000Z' WHERE owner_identity_key=?`).run(OWNER)
  for (let guard = 0; guard < 20; guard += 1) {
    const result = upgraded.purgeExpiredChanges({ owner: OWNER, nowIso: '2030-01-01T00:00:00.000Z', maxItems: 3 })
    if (!result.hasMore) break
  }
  const afterPurge = await upgraded.archiveBatch({ owner: OWNER, epoch, records: [record({ messageId: 'legacy-004' })] })
  assert.equal(afterPurge.outcomes[0].outcome, 'deleted', 'fence survives compaction')
  await upgraded.deleteAll({ owner: OWNER })
  assert.equal(Number(upgraded.db.prepare(`SELECT COUNT(*) n FROM history_tombstones WHERE owner_identity_key=?`).get(OWNER).n), 0, 'epoch rotation clears obsolete fence')
})
