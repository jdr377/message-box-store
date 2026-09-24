import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryStore } from '../src/repository.mjs'
import { createSqliteStore } from '../src/repository.sqlite.mjs'
import { MAX_IDEMPOTENCY_ROWS_PER_OWNER } from '../src/repository-contract.mjs'
import { MAX_SNAPSHOTS_PER_OWNER } from '../src/snapshots.mjs'

const peer = `03${'ef'.repeat(32)}`
const missing = 'a'.repeat(64)
const runId = Date.now()
const owner = (suffix) => `02${(runId + suffix).toString(16).padStart(12, '0')}${'ab'.repeat(26)}`
const now = () => `sec-${Date.now()}-${Math.random().toString(16).slice(2)}`

async function mysql(t) {
  assert.equal(process.env.MYSQL_DATABASE, 'message_box_store_test', 'capacity tests require the disposable database')
  assert.equal(process.env.MYSQL_FRESH_DATABASE, 'message_box_store_fresh')
  const { createMysqlKnex, migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await createMysqlKnex({
    host: process.env.MYSQL_HOST ?? '127.0.0.1', port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  })
  t.after(() => knex.destroy())
  await migrateMysql(knex)
  return { store: createMysqlStore(knex), knex }
}

async function proveIdempotencyBound(store, own) {
  for (let i = 0; i < MAX_IDEMPOTENCY_ROWS_PER_OWNER; i++) {
    const result = await store.deleteRecord({ owner: own, recordKey: missing, idempotencyKey: `capacity-${i}` })
    assert.equal(result.deleted, false)
  }
  const replay = await store.deleteRecord({ owner: own, recordKey: missing, idempotencyKey: 'capacity-0' })
  assert.equal(replay.replayed, true, 'an admitted key retains its original result')
  await assert.rejects(
    store.deleteRecord({ owner: own, recordKey: missing, idempotencyKey: 'capacity-overflow' }),
    (error) => error?.code === 'ERR_QUOTA_EXCEEDED',
  )
  const stats = await store.getStorageStats({ owner: own })
  assert.equal(stats.live.recordCount, 0)
  assert.equal(stats.physical.idempotencyCount, MAX_IDEMPOTENCY_ROWS_PER_OWNER)
}

async function proveSnapshotBound(store, own) {
  const usage = await store.getUsage({ owner: own })
  const archived = await store.archiveBatch({ owner: own, epoch: usage.epoch, records: [{
    messageId: now(), messageBox: 'inbox', direction: 'outbound', sender: own, recipient: peer,
    body: '{"encryptedMessage":"AQ=="}',
  }] })
  assert.equal(archived.outcomes[0].outcome, 'stored')
  for (let i = 0; i < MAX_SNAPSHOTS_PER_OWNER; i++) {
    const snapshot = await store.createSnapshot({ owner: own })
    assert.equal(snapshot.memberCount, 1)
  }
  await assert.rejects(store.createSnapshot({ owner: own }), (error) => error?.code === 'ERR_QUOTA_EXCEEDED')
  const stats = await store.getStorageStats({ owner: own })
  assert.equal(stats.physical.snapshotCount, MAX_SNAPSHOTS_PER_OWNER)
  assert.equal(stats.physical.snapshotItemCount, MAX_SNAPSHOTS_PER_OWNER)
}

test('M1 auxiliary capacity is enforced in memory and SQLite without consuming live quota', async (t) => {
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  for (const [i, store] of [createMemoryStore(), sqlite].entries()) {
    await proveIdempotencyBound(store, owner(100 + i))
    await proveSnapshotBound(store, owner(200 + i))
  }
})

test('M1 idempotency expiry permits a key to be used again after the replay window', async (t) => {
  let clock = '2026-09-25T00:00:00.000Z'
  const mem = createMemoryStore({ now: () => clock })
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  for (const [i, store] of [mem, sqlite].entries()) {
    const own = owner(300 + i)
    const args = { owner: own, recordKey: missing, idempotencyKey: 'expiry-key' }
    await store.deleteRecord(args)
    if (store === mem) clock = '2026-09-26T00:00:01.000Z'
    else sqlite.db.prepare(`UPDATE history_idempotency SET created_at = '2000-01-01 00:00:00' WHERE owner_identity_key = ?`).run(own)
    const reused = await store.deleteRecord(args)
    assert.notEqual(reused.replayed, true)
    assert.equal((await store.getStorageStats({ owner: own })).physical.idempotencyCount, 1)
  }
})

test('M1 MySQL auxiliary rows and immutable-conflict audit are physically bounded', {
  skip: process.env.MESSAGE_BOX_STORE_MYSQL !== '1' ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false,
}, async (t) => {
  const { store, knex } = await mysql(t)
  await proveIdempotencyBound(store, owner(400))
  await proveSnapshotBound(store, owner(401))

  const own = owner(402)
  const original = { messageId: now(), messageBox: 'inbox', direction: 'outbound', sender: own, recipient: peer, body: '{"encryptedMessage":"AQ=="}' }
  const epoch = (await store.getUsage({ owner: own })).epoch
  assert.equal((await store.archiveBatch({ owner: own, epoch, records: [original] })).outcomes[0].outcome, 'stored')
  const conflicting = { ...original, body: '{"encryptedMessage":"Ag=="}' }
  for (let i = 0; i < 205; i++) {
    assert.equal((await store.archiveBatch({ owner: own, epoch, records: [conflicting] })).outcomes[0].outcome, 'conflict')
  }
  const stats = await store.getStorageStats({ owner: own })
  assert.equal(stats.physical.auditEventCount, 200)
  const audit = (await knex.raw(`SELECT MIN(id) AS first_id, MAX(id) AS last_id FROM history_audit_events WHERE owner_identity_key = ?`, [own]))[0][0]
  assert.equal(Number(audit.last_id) - Number(audit.first_id), 199, 'newest 200 forensic events remain')

  const expiredOwner = owner(403)
  const args = { owner: expiredOwner, recordKey: missing, idempotencyKey: 'expiry-key' }
  await store.deleteRecord(args)
  await knex.raw(`UPDATE history_idempotency SET created_at = '2000-01-01 00:00:00' WHERE owner_identity_key = ?`, [expiredOwner])
  assert.notEqual((await store.deleteRecord(args)).replayed, true)
  assert.equal((await store.getStorageStats({ owner: expiredOwner })).physical.idempotencyCount, 1)
})
