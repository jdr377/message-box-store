import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LIMITS } from '../src/protocol.mjs'
import { newChangesCursor } from '../src/feeds.mjs'

const ENABLED = process.env.MESSAGE_BOX_STORE_MYSQL === '1'
const OWNER = `02${'aa'.repeat(32)}`
const PEER = `03${'bb'.repeat(32)}`
const BODY = '{"encryptedMessage":"AQ=="}'

function env() {
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  }
}

async function connect(t, database) {
  const { createMysqlKnex } = await import('../src/repository.mysql.mjs')
  const cfg = { ...env(), database: database ?? env().database }
  assert.ok(cfg.user && cfg.password && cfg.database, 'MYSQL_USER/PASSWORD/DATABASE required')
  const knex = await createMysqlKnex(cfg)
  t.after(() => knex.destroy())
  return knex
}

test('M1 live MySQL evidence (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  const store = createMysqlStore(knex)

  // Fresh owner for isolation.
  await store.deleteAll({ owner: OWNER })

  // 1. Concurrent same-key archive -> one row.
  const rec = { messageId: 'mysql-conc-1', messageBox: 'inbox', direction: 'outbound', sender: OWNER, recipient: PEER, body: BODY }
  const [a, b] = await Promise.all([
    store.archiveBatch({ owner: OWNER, epoch: (await store.getUsage({ owner: OWNER })).epoch, records: [rec] }),
    store.archiveBatch({ owner: OWNER, epoch: (await store.getUsage({ owner: OWNER })).epoch, records: [rec] }),
  ])
  const outcomes = [...a.outcomes, ...b.outcomes].map((o) => o.outcome).sort()
  assert.deepEqual(outcomes, ['alreadyPresent', 'stored'])
  assert.equal((await store.getUsage({ owner: OWNER })).recordCount, 1)

  // 2. Retry allocates no extra charge.
  const before = await store.getUsage({ owner: OWNER })
  const epoch = before.epoch
  const retry = await store.archiveBatch({ owner: OWNER, epoch, records: [rec] })
  assert.equal(retry.outcomes[0].outcome, 'alreadyPresent')
  assert.deepEqual(await store.getUsage({ owner: OWNER }), before)

  // 3. Immutable conflict + accepted-no-downgrade + deletion wins.
  const conflict = await store.archiveBatch({
    owner: OWNER,
    epoch,
    records: [{ ...rec, messageId: 'mysql-conc-1', body: '{"encryptedMessage":"AQI="}' }],
  })
  // Same metadata key, different body -> conflict (recordKey covers metadata only).
  assert.equal(conflict.outcomes[0].outcome, 'conflict')
  const key = a.outcomes.find((o) => o.recordKey)?.recordKey ?? b.outcomes.find((o) => o.recordKey)?.recordKey
  const accepted = await store.patchState({ owner: OWNER, recordKey: key, newState: 'accepted', expectedRevision: '1', idempotencyKey: `mysql-accept-${Date.now()}` })
  assert.equal(accepted.ok, true)
  await assert.rejects(store.patchState({ owner: OWNER, recordKey: key, newState: 'unknown', expectedRevision: accepted.revision, idempotencyKey: `mysql-downgrade-${Date.now()}` }), /accepted cannot downgrade/)
  const del = await store.deleteRecord({ owner: OWNER, recordKey: key })
  assert.equal(del.deleted, true)
  assert.equal((await store.getUsage({ owner: OWNER })).recordCount, 0)
  const reupload = await store.archiveBatch({ owner: OWNER, epoch: del.epoch, records: [rec] })
  // MUT-4 killer: dropping the tombstone check would resurrect the deleted body here.
  assert.equal(reupload.outcomes[0].outcome, 'deleted')

  // 4. Case-sensitive collation evidence (utf8mb4_bin).
  const cs = await knex.raw(`SELECT ('ABC' = 'abc' COLLATE utf8mb4_bin) AS eq_bin, ('ABC' = 'abc' COLLATE utf8mb4_0900_ai_ci) AS eq_ci`)
  assert.equal(Number(cs[0][0].eq_bin), 0, 'binary collation must distinguish case')
  assert.equal(Number(cs[0][0].eq_ci), 1, 'sanity: ci collation folds case')
  const createSql = await knex.raw(`SHOW CREATE TABLE history_records`)
  assert.match(JSON.stringify(createSql[0]), /utf8mb4_bin/)
  const collations = await knex.raw(
    `SELECT COLUMN_NAME, COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'history_records'
     AND COLUMN_NAME IN ('record_key','message_id','message_box')`,
  )
  for (const row of collations[0]) assert.match(row.COLLATION_NAME, /bin/)

  // 5. Index + query-plan evidence for required access paths.
  const tables = await knex.raw(`SHOW INDEX FROM history_records`)
  const indexNames = tables[0].map((r) => r.Key_name)
  for (const needed of ['PRIMARY', 'uq_owner_record', 'idx_owner_seq', 'idx_owner_box_created', 'idx_owner_dir_created', 'idx_owner_expires']) {
    assert.ok(indexNames.includes(needed), `missing index ${needed}: ${indexNames}`)
  }
  const plans = await Promise.all([
    knex.raw(`EXPLAIN SELECT * FROM history_records WHERE owner_identity_key = ? AND record_key = ?`, [OWNER, key]),
    knex.raw(`EXPLAIN SELECT * FROM history_records WHERE owner_identity_key = ? AND message_box = ?`, [OWNER, 'inbox']),
    knex.raw(`EXPLAIN SELECT * FROM history_changes WHERE owner_identity_key = ? AND change_sequence > 0 ORDER BY change_sequence`, [OWNER]),
  ])
  const planText = JSON.stringify(plans.map((p) => p[0]))
  assert.ok(/ref|range|const|eq_ref/i.test(planText), `expected indexed access, got ${planText}`)

  // 6. Exact byte accounting.
  const row = await store.getRecord({ owner: OWNER, recordKey: '0'.repeat(64) })
  assert.equal(row, null)

  await store.deleteAll({ owner: OWNER })
})

// MUT-1 killer: without the aggregate byte pre-check, the cap+1 all-valid
// batch below would store. The check trips before any envelope parsing,
// so even the multibyte-invalid batch fails closed with ERR_REQUEST_TOO_LARGE.
/** Valid envelope of exactly totalSize bytes (whitespace-tuned, canonical b64). */
function validBody(totalSize) {
  // Prefix `{"encryptedMessage":"` is 21 bytes, suffix `"}` is 2 bytes.
  const pad = (totalSize - 23) % 4
  const payloadLength = totalSize - 23 - pad
  assert.ok(payloadLength > 0 && payloadLength % 4 === 0, `size ${totalSize}`)
  return `{"encryptedMessage":"${'A'.repeat(payloadLength)}"${' '.repeat(pad)}}`
}

function liveRecord(owner, peer, messageId, body) {
  return { messageId, messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body }
}

test('M1 live MySQL batch bytes enforced at cap and cap+1 (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  const { migrateMysql } = await import('../src/repository.mysql.mjs')
  await migrateMysql(knex)
  const BOwner = `02${'b0'.repeat(32)}`
  const small = createMysqlStore(knex, { limits: { MAX_BATCH_BYTES: 1000 } })
  await small.deleteAll({ owner: BOwner })
  const epochB = (await small.getUsage({ owner: BOwner })).epoch
  // Exact cap in bytes stores.
  const atCap = await small.archiveBatch({ owner: BOwner, epoch: epochB, records: [liveRecord(BOwner, PEER, 'cap-1', validBody(398)), liveRecord(BOwner, PEER, 'cap-2', validBody(602))] })
  assert.ok(atCap.outcomes.every((o) => o.outcome === 'stored'), JSON.stringify(atCap.outcomes))
  // Cap+1 rejects before envelope parsing.
  await assert.rejects(
    small.archiveBatch({ owner: BOwner, epoch: epochB, records: [liveRecord(BOwner, PEER, 'cap-3', validBody(399)), liveRecord(BOwner, PEER, 'cap-4', validBody(602))] }),
    (e) => e?.code === 'ERR_REQUEST_TOO_LARGE',
  )
  // Multibyte chars do not smuggle bytes past the cap: 600 chars but 1200 bytes.
  await assert.rejects(
    small.archiveBatch({ owner: BOwner, epoch: epochB, records: [{ ...liveRecord(BOwner, PEER, 'cap-5', 'é'.repeat(300)), body: 'é'.repeat(300) }, { ...liveRecord(BOwner, PEER, 'cap-6', 'é'.repeat(300)), body: 'é'.repeat(300) }] }),
    (e) => e?.code === 'ERR_REQUEST_TOO_LARGE',
  )
  await small.deleteAll({ owner: BOwner })

  // Real 4 MiB cap with all-valid bodies: exact cap stores, cap+1 rejects.
  const COwner = `02${'c0'.repeat(32)}`
  const real = createMysqlStore(knex)
  await real.deleteAll({ owner: COwner })
  const epochC = (await real.getUsage({ owner: COwner })).epoch
  const sizes = [699050, 699050, 699050, 699050, 699050, 699054]
  assert.equal(sizes.reduce((a, b) => a + b, 0), LIMITS.MAX_BATCH_BYTES)
  const exact = await real.archiveBatch({ owner: COwner, epoch: epochC, records: sizes.map((n, i) => liveRecord(COwner, PEER, `real-${i}`, validBody(n))) })
  assert.ok(exact.outcomes.every((o) => o.outcome === 'stored'))
  await real.deleteAll({ owner: COwner })
  const epochC2 = (await real.getUsage({ owner: COwner })).epoch
  const over = sizes.map((n, i) => (i === 5 ? validBody(n + 1) : validBody(n)))
  assert.equal(over.reduce((s, b) => s + Buffer.byteLength(b, 'utf8'), 0), LIMITS.MAX_BATCH_BYTES + 1)
  await assert.rejects(
    real.archiveBatch({ owner: COwner, epoch: epochC2, records: over.map((body, i) => liveRecord(COwner, PEER, `over-${i}`, body)) }),
    (e) => e?.code === 'ERR_REQUEST_TOO_LARGE',
  )
  await real.deleteAll({ owner: COwner })
})

test('M1 live MySQL quotas admit in request order with exact accounting (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  // MUT-3 killer: quota-before-duplicate would charge retries at full quota.
  const QOwner = `02${'d0'.repeat(32)}`
  const store = createMysqlStore(knex, { limits: { MAX_RECORDS_PER_OWNER: 3, MAX_BYTES_PER_OWNER: 10_000 } })
  await store.deleteAll({ owner: QOwner })
  const epoch = (await store.getUsage({ owner: QOwner })).epoch
  const batch = await store.archiveBatch({
    owner: QOwner,
    epoch,
    records: ['q-1', 'q-2', 'q-3', 'q-4', 'q-5'].map((messageId) => liveRecord(QOwner, PEER, messageId, BODY)),
  })
  assert.deepEqual(batch.outcomes.map((o) => o.outcome), ['stored', 'stored', 'stored', 'quotaExceeded', 'quotaExceeded'])
  assert.deepEqual(batch.outcomes.map((o) => o.index), [0, 1, 2, 3, 4])
  const usage = await store.getUsage({ owner: QOwner })
  assert.equal(usage.recordCount, 3)
  assert.equal(usage.byteCount, batch.outcomes.slice(0, 3).reduce((sum, o, i) => sum + Buffer.byteLength(BODY, 'utf8'), 0))
  // Duplicate at full quota still succeeds without charge.
  const retry = await store.archiveBatch({ owner: QOwner, epoch, records: [liveRecord(QOwner, PEER, 'q-1', BODY)] })
  assert.equal(retry.outcomes[0].outcome, 'alreadyPresent')
  assert.deepEqual(await store.getUsage({ owner: QOwner }), usage)
  await store.deleteAll({ owner: QOwner })
})

test('M1 live MySQL concurrent distinct writes are gap-free allocation-ordered (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  const GOwner = `02${'e0'.repeat(32)}`
  const store = createMysqlStore(knex)
  await store.deleteAll({ owner: GOwner })
  const epoch = (await store.getUsage({ owner: GOwner })).epoch
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.archiveBatch({ owner: GOwner, epoch, records: [liveRecord(GOwner, PEER, `gap-${i}`, BODY)] })),
  )
  assert.ok(results.every((r) => r.outcomes[0].outcome === 'stored'), JSON.stringify(results.map((r) => r.outcomes)))
  const seqs = (await knex.raw(`SELECT change_sequence AS s FROM history_changes WHERE owner_identity_key = ?`, [GOwner]))[0].map((r) => BigInt(r.s)).sort((a, b) => (a < b ? -1 : 1))
  assert.equal(seqs.length, 10)
  // Allocation-ordered gap-free sequences under the per-owner lock. This sorts
  // committed sequences after the fact; it does not measure wall-clock commit
  // order, and no wall-clock ordering is claimed.
  for (let i = 1; i < seqs.length; i += 1) assert.equal(seqs[i] - seqs[i - 1], 1n, 'gap-free allocation-ordered sequences')
  assert.equal((await store.getUsage({ owner: GOwner })).recordCount, 10)
  await store.deleteAll({ owner: GOwner })
})

test('M1 live MySQL CAS monotonicity, downgrade guard and deletion wins (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  // MUT-2 killer: removing the accepted guard would let unknown overwrite accepted.
  const COwner = `02${'f0'.repeat(32)}`
  const store = createMysqlStore(knex)
  await store.deleteAll({ owner: COwner })
  const epoch = (await store.getUsage({ owner: COwner })).epoch
  const archived = await store.archiveBatch({ owner: COwner, epoch, records: [{ ...liveRecord(COwner, PEER, 'cas-1', BODY), deliveryState: 'received' }] })
  const key = archived.outcomes[0].recordKey
  const s1 = await store.patchState({ owner: COwner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: `mysql-cas-1-${Date.now()}` })
  assert.equal(s1.revision, '2')
  const s2 = await store.patchState({ owner: COwner, recordKey: key, newState: 'failed', expectedRevision: '2', idempotencyKey: `mysql-cas-2-${Date.now()}` })
  assert.equal(s2.revision, '3')
  await assert.rejects(store.patchState({ owner: COwner, recordKey: key, newState: 'accepted', expectedRevision: '2', idempotencyKey: `mysql-cas-stale-${Date.now()}` }), (e) => e?.code === 'ERR_REVISION_CONFLICT')
  const acc = await store.patchState({ owner: COwner, recordKey: key, newState: 'accepted', expectedRevision: '3', idempotencyKey: `mysql-cas-3-${Date.now()}` })
  assert.equal(acc.revision, '4')
  await assert.rejects(store.patchState({ owner: COwner, recordKey: key, newState: 'unknown', expectedRevision: '4', idempotencyKey: `mysql-cas-downgrade-${Date.now()}` }), /accepted cannot downgrade/)
  await store.deleteRecord({ owner: COwner, recordKey: key })
  await assert.rejects(store.patchState({ owner: COwner, recordKey: key, newState: 'accepted', expectedRevision: acc.revision, idempotencyKey: `mysql-cas-deleted-${Date.now()}` }), /deletion wins/)
  await store.deleteAll({ owner: COwner })
})

test('M1 live MySQL delete-all expectedEpoch CAS is atomic and exact retries replay (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  const store = createMysqlStore(knex)
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const owner = `02${'f1'.repeat(32)}`
  const peer = `03${'b1'.repeat(32)}`
  await store.deleteAll({ owner })
  const initialEpoch = (await store.getUsage({ owner })).epoch
  const base = liveRecord(owner, peer, `delete-all-cas-base-${suffix}`, BODY)
  const archived = await store.archiveBatch({ owner, epoch: initialEpoch, records: [base] })
  assert.equal(archived.outcomes[0].outcome, 'stored')

  const [first, second] = await Promise.allSettled([
    store.deleteAll({ owner, expectedEpoch: initialEpoch }),
    store.deleteAll({ owner, expectedEpoch: initialEpoch }),
  ])
  assert.equal([first, second].filter((result) => result.status === 'fulfilled').length, 1)
  const loser = [first, second].find((result) => result.status === 'rejected')
  assert.equal(loser?.reason?.code, 'ERR_EPOCH_CHANGED')
  const winner = [first, second].find((result) => result.status === 'fulfilled').value
  assert.equal((await store.getUsage({ owner })).recordCount, 0)

  const newer = liveRecord(owner, peer, `delete-all-cas-new-${suffix}`, BODY)
  const seeded = await store.archiveBatch({ owner, epoch: winner.epoch, records: [newer] })
  assert.equal(seeded.outcomes[0].outcome, 'stored')
  await assert.rejects(store.deleteAll({ owner, expectedEpoch: initialEpoch }), (error) => error?.code === 'ERR_EPOCH_CHANGED')
  assert.equal((await store.getUsage({ owner })).recordCount, 1, 'stale CAS cannot erase newer history')

  const replayKey = `delete-all-replay-${suffix}`
  const replayEpoch = (await store.getUsage({ owner })).epoch
  const deleted = await store.deleteAll({ owner, expectedEpoch: replayEpoch, idempotencyKey: replayKey })
  const replayRecord = liveRecord(owner, peer, `delete-all-replay-new-${suffix}`, BODY)
  const replaySeed = await store.archiveBatch({ owner, epoch: deleted.epoch, records: [replayRecord] })
  assert.equal(replaySeed.outcomes[0].outcome, 'stored')
  const replayed = await store.deleteAll({ owner, expectedEpoch: replayEpoch, idempotencyKey: replayKey })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.epoch, deleted.epoch)
  assert.equal((await store.getUsage({ owner })).recordCount, 1, 'exact retry cannot erase newer history')
  await assert.rejects(store.deleteAll({ owner, expectedEpoch: deleted.epoch, idempotencyKey: replayKey }), (error) => error?.code === 'ERR_IDEMPOTENCY_CONFLICT')

  const capOwner = `02${'f2'.repeat(32)}`
  await store.deleteAll({ owner: capOwner })
  const capEpoch = (await store.getUsage({ owner: capOwner })).epoch
  const exact = await store.archiveBatch({ owner: capOwner, epoch: capEpoch, records: [liveRecord(capOwner, peer, `record-cap-${suffix}`, validBody(LIMITS.MAX_BODY_BYTES))] })
  assert.equal(exact.outcomes[0].outcome, 'stored')
  const over = await store.archiveBatch({ owner: capOwner, epoch: capEpoch, records: [liveRecord(capOwner, peer, `record-over-${suffix}`, validBody(LIMITS.MAX_BODY_BYTES + 1))] })
  assert.equal(over.outcomes[0].outcome, 'invalid')
  assert.equal(over.outcomes[0].errorCode, 'ERR_REQUEST_TOO_LARGE')
  await store.deleteAll({ owner })
  await store.deleteAll({ owner: capOwner })
})

test('M1 live MySQL raw transaction rollback leaves no rows, events or charges (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  const ROWNER = `02${'99'.repeat(32)}`
  await knex.raw(`DELETE FROM history_changes WHERE owner_identity_key = ?`, [ROWNER])
  await knex.raw(`DELETE FROM history_records WHERE owner_identity_key = ?`, [ROWNER])
  await knex.raw(`DELETE FROM history_owner_state WHERE owner_identity_key = ?`, [ROWNER])
  await knex.raw(`DELETE FROM history_audit_events WHERE owner_identity_key = ?`, [ROWNER])
  await assert.rejects(
    knex.transaction(async (trx) => {
      await trx.raw(`INSERT INTO history_owner_state (owner_identity_key, epoch, next_sequence, record_count, byte_count) VALUES (?, 'gen-1', 2, 1, 27)`, [ROWNER])
      await trx.raw(
        `INSERT INTO history_records (owner_identity_key, record_key, message_id, message_box, direction, sender, recipient, body, body_hash, body_bytes, delivery_state, revision, change_sequence)
         VALUES (?, ?, 'rb-1', 'inbox', 'outbound', ?, ?, ?, ?, 27, 'received', 1, 1)`,
        [ROWNER, 'a'.repeat(64), ROWNER, PEER, BODY, '0084794ecc214b1345494cd74a5758785b703aa54b89b1ff36b5087dc65ff8ce'],
      )
      await trx.raw(`INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version) VALUES (?, 1, ?, 'upsert', 1)`, [ROWNER, 'a'.repeat(64)])
      throw new Error('injected mid-transaction failure')
    }),
    /injected mid-transaction failure/,
  )
  for (const table of ['history_records', 'history_changes', 'history_owner_state', 'history_audit_events']) {
    const n = (await knex.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_identity_key = ?`, [ROWNER]))[0][0].n
    assert.equal(Number(n), 0, `${table} rolled back`)
  }
})

test('M1 live MySQL ordered migrations: fresh, upgrade resume, tamper refusal (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql } = await import('../src/repository.mysql.mjs')
  const { MYSQL_MIGRATION_CHAIN, verifyMysqlSchema } = await import('../src/migrations.mjs')
  const freshDb = process.env.MYSQL_FRESH_DATABASE ?? 'message_box_store_fresh'
  const knex = await connect(t, freshDb)
  // Start from zero: drop everything the chain manages.
  for (const table of ['history_change_details', 'history_tombstones', 'history_idempotency', 'history_snapshot_items', 'history_snapshots', 'history_audit_events', 'history_changes', 'history_records', 'history_resource_locks', 'history_owner_state', 'schema_migrations']) {
    await knex.raw(`DROP TABLE IF EXISTS ${table}`)
  }
  await assert.rejects(verifyMysqlSchema(knex), /missing table/, 'verify-before-record: empty DB fails verification')
  // Interrupted-upgrade resume: apply 001 only, then the full chain.
  await migrateMysql(knex, [MYSQL_MIGRATION_CHAIN[0]])
  let versions = (await knex.raw(`SELECT version FROM schema_migrations ORDER BY version`))[0].map((r) => r.version)
  assert.deepEqual(versions, ['001-init'])
  await assert.rejects(verifyMysqlSchema(knex), /history_snapshots/, 'full verify still gates 002 recording')
  await migrateMysql(knex, [MYSQL_MIGRATION_CHAIN[0], MYSQL_MIGRATION_CHAIN[1]])
  versions = (await knex.raw(`SELECT version FROM schema_migrations ORDER BY version`))[0].map((r) => r.version)
  assert.deepEqual(versions, ['001-init', '002-snapshot-foundation'])
  await assert.rejects(verifyMysqlSchema(knex), /history_idempotency/, 'full verify still gates 003 recording')
  await migrateMysql(knex)
  versions = (await knex.raw(`SELECT version FROM schema_migrations ORDER BY version`))[0].map((r) => r.version)
  assert.deepEqual(versions, ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
  assert.equal(await verifyMysqlSchema(knex), true)
  // Injected tamper is refused with zero side effects.
  await assert.rejects(migrateMysql(knex, [{ version: '001-init', sql: 'SELECT 1; --tampered' }]), (e) => e?.code === 'ERR_MIGRATION_CHECKSUM')
  versions = (await knex.raw(`SELECT version FROM schema_migrations ORDER BY version`))[0].map((r) => r.version)
  assert.deepEqual(versions, ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
  // Safe rerun is a no-op success.
  assert.deepEqual(await migrateMysql(knex), ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
})

test('M1 live MySQL migration failure between steps leaves no false stamp and resumes (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql } = await import('../src/repository.mysql.mjs')
  const { MYSQL_MIGRATION_CHAIN, verifyMysqlSchema } = await import('../src/migrations.mjs')
  const freshDb = process.env.MYSQL_FRESH_DATABASE ?? 'message_box_store_fresh'
  const knex = await connect(t, freshDb)
  for (const table of ['history_change_details', 'history_tombstones', 'history_idempotency', 'history_snapshot_items', 'history_snapshots', 'history_audit_events', 'history_changes', 'history_records', 'history_resource_locks', 'history_owner_state', 'schema_migrations']) {
    await knex.raw(`DROP TABLE IF EXISTS ${table}`)
  }
  // Fail between the two real DDL steps of 002 (2 statements: snapshots, items).
  await assert.rejects(
    migrateMysql(knex, MYSQL_MIGRATION_CHAIN, { failAfterStatements: 1, failVersion: '002-snapshot-foundation' }),
    (e) => e?.code === 'ERR_MIGRATION_INJECTED',
  )
  // 001 applied; 002 absent: no false applied-version record.
  const partial = (await knex.raw(`SELECT version FROM schema_migrations ORDER BY version`))[0].map((r) => r.version)
  assert.deepEqual(partial, ['001-init'])
  // Safe resume completes the chain and verifies full structure.
  assert.deepEqual(await migrateMysql(knex), ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
  assert.equal(await verifyMysqlSchema(knex), true)
  assert.deepEqual(await migrateMysql(knex), ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
})

test('M1 live MySQL recorded checksum tamper refused then restored (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql } = await import('../src/repository.mysql.mjs')
  const { EXPECTED_MIGRATION_CHECKSUMS } = await import('../src/migrations.mjs')
  const freshDb = process.env.MYSQL_FRESH_DATABASE ?? 'message_box_store_fresh'
  const knex = await connect(t, freshDb)
  await migrateMysql(knex)
  await knex.raw(`UPDATE schema_migrations SET checksum = ? WHERE version = ?`, ['0'.repeat(64), '001-init'])
  try {
    await assert.rejects(migrateMysql(knex), (e) => e?.code === 'ERR_MIGRATION_CHECKSUM')
  } finally {
    await knex.raw(`UPDATE schema_migrations SET checksum = ? WHERE version = ?`, [EXPECTED_MIGRATION_CHECKSUMS['mysql:001-init'], '001-init'])
  }
  assert.deepEqual(await migrateMysql(knex), ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
})

test('M1 live MySQL recorded legacy stamps require complete structure before adoption (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql } = await import('../src/repository.mysql.mjs')
  const { MYSQL_SCHEMA_SQL, MYSQL_SNAPSHOT_SCHEMA_SQL, MYSQL_IDEMPOTENCY_SCHEMA_SQL, MYSQL_MIGRATION_CHAIN, EXPECTED_MIGRATION_CHECKSUMS, splitStatements } = await import('../src/migrations.mjs')
  const freshDb = process.env.MYSQL_FRESH_DATABASE ?? 'message_box_store_fresh'
  const knex = await connect(t, freshDb)
  const tables = ['history_change_details', 'history_tombstones', 'history_idempotency', 'history_snapshot_items', 'history_snapshots', 'history_audit_events', 'history_changes', 'history_records', 'history_resource_locks', 'history_owner_state', 'schema_migrations']
  for (const table of tables) await knex.raw(`DROP TABLE IF EXISTS ${table}`)

  // A legacy 001 stamp without checksum and without its structure must fail
  // before adoption; no later version may be applied or blessed.
  await knex.raw(`CREATE TABLE schema_migrations (version VARCHAR(64) NOT NULL PRIMARY KEY, applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await knex.raw(`INSERT INTO schema_migrations (version) VALUES ('001-init')`)
  await assert.rejects(migrateMysql(knex), /missing table history_owner_state/)
  let rows = (await knex.raw(`SELECT version, checksum FROM schema_migrations ORDER BY version`))[0]
  assert.equal(rows[0].checksum, '', 'incomplete legacy stamp is not blessed')
  assert.equal(rows.some((row) => row.version === '002-snapshot-foundation'), false, 'later version is not stamped')

  // Repair the complete legacy 001 structure, then prove checksum adoption
  // happens safely and the normal upgrade resumes through 002/003.
  for (const statement of splitStatements(MYSQL_SCHEMA_SQL)) await knex.raw(statement.replace(/;$/, ''))
  assert.deepEqual(await migrateMysql(knex), ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
  rows = (await knex.raw(`SELECT version, checksum FROM schema_migrations ORDER BY version`))[0]
  assert.equal(rows.find((row) => row.version === '001-init').checksum, EXPECTED_MIGRATION_CHECKSUMS['mysql:001-init'])

  // A recorded 002 stamp with only one snapshot table is rejected before
  // checksum adoption or 003 application; repairing its missing table then
  // permits a clean rerun.
  for (const table of tables) await knex.raw(`DROP TABLE IF EXISTS ${table}`)
  for (const statement of splitStatements(MYSQL_SCHEMA_SQL)) await knex.raw(statement.replace(/;$/, ''))
  await knex.raw(`INSERT INTO schema_migrations (version, checksum) VALUES ('001-init', ''), ('002-snapshot-foundation', '')`)
  await knex.raw(splitStatements(MYSQL_SNAPSHOT_SCHEMA_SQL)[0].replace(/;$/, ''))
  await assert.rejects(migrateMysql(knex), /missing table history_snapshot_items/)
  rows = (await knex.raw(`SELECT version, checksum FROM schema_migrations ORDER BY version`))[0]
  assert.equal(rows.find((row) => row.version === '001-init').checksum, '', '001 checksum remains unblessed after later-structure failure')
  assert.equal(rows.some((row) => row.version === '003-idempotency'), false, '003 is not stamped after 002 failure')
  await knex.raw(splitStatements(MYSQL_SNAPSHOT_SCHEMA_SQL)[1].replace(/;$/, ''))
  await knex.raw(MYSQL_IDEMPOTENCY_SCHEMA_SQL.split(';')[0])
  assert.deepEqual(await migrateMysql(knex), ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
  assert.equal((await knex.raw(`SELECT checksum FROM schema_migrations WHERE version = '002-snapshot-foundation'`))[0][0].checksum, EXPECTED_MIGRATION_CHECKSUMS['mysql:002-snapshot-foundation'])
})

test('M1 live MySQL rerun detects snapshot/idempotency structural tampering and resumes after repair (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql } = await import('../src/repository.mysql.mjs')
  const { verifyMysqlSchema } = await import('../src/migrations.mjs')
  const freshDb = process.env.MYSQL_FRESH_DATABASE ?? 'message_box_store_fresh'
  const knex = await connect(t, freshDb)
  await migrateMysql(knex)
  await knex.raw(`DROP INDEX idx_snapshots_expiry ON history_snapshots`)
  await assert.rejects(migrateMysql(knex), /missing index history_snapshots.idx_snapshots_expiry/)
  await knex.raw(`CREATE INDEX idx_snapshots_expiry ON history_snapshots (expires_at)`)
  await knex.raw(`ALTER TABLE history_idempotency MODIFY operation VARCHAR(31) NOT NULL`)
  await assert.rejects(migrateMysql(knex), /history_idempotency.operation/)
  await knex.raw(`ALTER TABLE history_idempotency MODIFY operation VARCHAR(32) NOT NULL`)
  assert.equal(await verifyMysqlSchema(knex), true)
  assert.deepEqual(await migrateMysql(knex), ['001-init', '002-snapshot-foundation', '003-idempotency', '004-tombstones'])
})

test('M1 live MySQL adapter rollback through every mutator leaves zero partial state (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  const store = createMysqlStore(knex)
  const owner = `02${'71'.repeat(32)}`
  const peer = `03${'72'.repeat(32)}`
  await store.deleteAll({ owner }).catch(() => {})
  const epoch = (await store.getUsage({ owner })).epoch
  const seed = await store.archiveBatch({ owner, epoch, records: [liveRecord(owner, peer, 'rb-seed-1', BODY)] })
  assert.equal(seed.outcomes[0].outcome, 'stored')
  const key = seed.outcomes[0].recordKey
  // Durable idempotency row proving idempotency-table effects roll back too.
  await store.patchState({ owner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: 'rb-idem-1' })
  async function snapshot() {
    const usage = await store.getUsage({ owner })
    const recs = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_records WHERE owner_identity_key = ?`, [owner]))[0][0].n)
    const ch = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_changes WHERE owner_identity_key = ?`, [owner]))[0][0].n)
    const idem = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_idempotency WHERE owner_identity_key = ?`, [owner]))[0][0].n)
    const audits = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_audit_events WHERE owner_identity_key = ?`, [owner]))[0][0].n)
    return { usage, recs, ch, idem, audits }
  }
  const before = await snapshot()

  store.injectFailureOnce('archiveBatch')
  await assert.rejects(store.archiveBatch({ owner, epoch: before.usage.epoch, records: [liveRecord(owner, peer, 'rb-doomed', BODY)] }), (e) => e?.code === 'ERR_UNAVAILABLE')
  assert.deepEqual(await snapshot(), before, 'archiveBatch failure: no partial rows/events/charges/usage/idempotency/epoch')

  store.injectFailureOnce('patchState')
  await assert.rejects(store.patchState({ owner, recordKey: key, newState: 'accepted', expectedRevision: '2', idempotencyKey: 'rb-failing-patch' }), (e) => e?.code === 'ERR_UNAVAILABLE')
  assert.deepEqual(await snapshot(), before, 'patchState failure: no partial rows/events/charges/usage/idempotency/epoch')

  store.injectFailureOnce('deleteRecord')
  await assert.rejects(store.deleteRecord({ owner, recordKey: key }), (e) => e?.code === 'ERR_UNAVAILABLE')
  assert.deepEqual(await snapshot(), before, 'deleteRecord failure: no partial rows/events/charges/usage/idempotency/epoch')

  const snap = await store.createSnapshot({ owner })
  store.injectFailureOnce('snapshotCleanup')
  await assert.rejects(store.purgeExpiredSnapshots({ nowIso: '2999-01-01T00:00:00.000Z' }), (e) => e?.code === 'ERR_UNAVAILABLE')
  assert.ok(await store.getSnapshot({ snapshotId: snap.snapshotId, owner }), 'purge failure: snapshot intact')
  assert.equal((await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner })).items.length, snap.memberCount, 'purge failure: members intact')
  assert.deepEqual(await snapshot(), before, 'purge failure: no partial rows/events/charges/usage/idempotency/epoch')

  store.injectFailureOnce('deleteAll')
  await assert.rejects(store.deleteAll({ owner }), (e) => e?.code === 'ERR_UNAVAILABLE')
  assert.deepEqual(await snapshot(), before, 'deleteAll failure: no partial rows/events/charges/usage/idempotency/epoch')

  await store.deleteAll({ owner })
})

test('M1 live MySQL bounded deadlock retry through every mutator (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  const real = createMysqlStore(knex)
  const owner = `02${'73'.repeat(32)}`
  const peer = `03${'74'.repeat(32)}`
  await real.deleteAll({ owner }).catch(() => {})
  const epoch = (await real.getUsage({ owner })).epoch
  const s1 = await real.archiveBatch({ owner, epoch, records: [liveRecord(owner, peer, 'dl-seed-1', BODY)] })
  const s2 = await real.archiveBatch({ owner, epoch, records: [liveRecord(owner, peer, 'dl-seed-2', BODY)] })
  const k1 = s1.outcomes[0].recordKey
  const k2 = s2.outcomes[0].recordKey

  function deadlockProxy(base, { txFailures = 0, rawFailures = 0 } = {}) {
    let txCalls = 0
    let rawCalls = 0
    let injected = 0
    const proxy = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async (...args) => {
            txCalls += 1
            if (injected < txFailures) {
              injected += 1
              const e = new Error('Deadlock found when trying to get lock; try restarting transaction')
              e.code = 'ER_LOCK_DEADLOCK'
              throw e
            }
            return target.transaction(...args)
          }
        }
        if (prop === 'raw') {
          return async (...args) => {
            rawCalls += 1
            if (injected < rawFailures) {
              injected += 1
              const e = new Error('Deadlock found when trying to get lock; try restarting transaction')
              e.code = 'ER_LOCK_DEADLOCK'
              throw e
            }
            return target.raw(...args)
          }
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    return { proxy, counts: () => ({ txCalls, rawCalls, injected }) }
  }

  // archiveBatch retries 2 transient deadlocks then commits (3 attempts, bounded).
  {
    const { proxy, counts } = deadlockProxy(knex, { txFailures: 2 })
    const store = createMysqlStore(proxy)
    const r = await store.archiveBatch({ owner, epoch, records: [liveRecord(owner, peer, 'dl-new-1', BODY)] })
    assert.equal(r.outcomes[0].outcome, 'stored')
    assert.equal(counts().txCalls, 3, 'archiveBatch: bounded retries then success')
  }
  // patchState retries then commits.
  {
    const { proxy, counts } = deadlockProxy(knex, { txFailures: 2 })
    const store = createMysqlStore(proxy)
    const r = await store.patchState({ owner, recordKey: k1, newState: 'unknown', expectedRevision: '1', idempotencyKey: 'mysql-deadlock-patch' })
    assert.equal(r.revision, '2')
    assert.equal(counts().txCalls, 3, 'patchState: bounded retries then success')
  }
  // deleteRecord retries then commits.
  {
    const { proxy, counts } = deadlockProxy(knex, { txFailures: 2 })
    const store = createMysqlStore(proxy)
    const r = await store.deleteRecord({ owner, recordKey: k2 })
    assert.equal(r.deleted, true)
    assert.equal(counts().txCalls, 3, 'deleteRecord: bounded retries then success')
  }
  // snapshot purge retries raw deadlocks then completes.
  {
    await real.createSnapshot({ owner })
    const { proxy, counts } = deadlockProxy(knex, { rawFailures: 2 })
    const store = createMysqlStore(proxy)
    const r = await store.purgeExpiredSnapshots({ nowIso: '2999-01-01T00:00:00.000Z' })
    assert.ok(r.purgedSnapshots >= 1, `purge completed after retry: ${JSON.stringify(r)}`)
    assert.equal(counts().injected, 2, 'purge: exactly the injected deadlocks retried')
  }
  // deleteAll retries then rotates epoch once.
  {
    const { proxy, counts } = deadlockProxy(knex, { txFailures: 2 })
    const store = createMysqlStore(proxy)
    const r = await store.deleteAll({ owner })
    assert.ok(typeof r.epoch === 'string')
    assert.equal(counts().txCalls, 3, 'deleteAll: bounded retries then success')
  }
  // Exhausted budget fails closed with ERR_UNAVAILABLE after 4 attempts.
  {
    const { proxy, counts } = deadlockProxy(knex, { txFailures: 10 })
    const store = createMysqlStore(proxy)
    await assert.rejects(store.archiveBatch({ owner, epoch: (await real.getUsage({ owner })).epoch, records: [liveRecord(owner, peer, 'dl-doomed', BODY)] }), (e) => e?.code === 'ERR_UNAVAILABLE')
    assert.equal(counts().txCalls, 4, 'exhausted deadlock budget: exactly 4 attempts')
  }
  await real.deleteAll({ owner }).catch(() => {})
})

test('M1 MySQL/SQLite getRecord canonical parity including timestamps (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const { createSqliteStore } = await import('../src/repository.sqlite.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  const mysql = createMysqlStore(knex)
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  // Unique owner per run: MySQL owner sequence counters persist across runs
  // (gap-free by design), so a fixed owner would yield different changeSequence
  // values in MySQL vs fresh SQLite. Uniqueness keeps both allocations at 1.
  const stamp = Date.now().toString(16).padStart(12, '0').slice(-12)
  const owner = `02${(stamp + '75'.repeat(32)).slice(0, 64)}`
  const peer = `03${'76'.repeat(32)}`
  await sqlite.deleteAll({ owner }).catch(() => {})
  await mysql.deleteAll({ owner }).catch(() => {})
  const sEpoch = (await sqlite.getUsage({ owner })).epoch
  const mEpoch = (await mysql.getUsage({ owner })).epoch
  const sRes = await sqlite.archiveBatch({ owner, epoch: sEpoch, records: [liveRecord(owner, peer, 'parity-1', BODY)] })
  const mRes = await mysql.archiveBatch({ owner, epoch: mEpoch, records: [liveRecord(owner, peer, 'parity-1', BODY)] })
  assert.equal(sRes.outcomes[0].outcome, 'stored')
  assert.equal(mRes.outcomes[0].outcome, 'stored')
  assert.equal(mRes.outcomes[0].recordKey, sRes.outcomes[0].recordKey, 'same canonical recordKey')
  const sRec = await sqlite.getRecord({ owner, recordKey: sRes.outcomes[0].recordKey })
  const mRec = await mysql.getRecord({ owner, recordKey: mRes.outcomes[0].recordKey })
  for (const f of ['owner', 'recordKey', 'messageId', 'messageBox', 'direction', 'sender', 'recipient', 'body', 'bodyHash', 'bodyBytes', 'deliveryState', 'revision', 'changeSequence', 'expiresAt']) {
    assert.deepEqual(mRec[f], sRec[f], `parity field ${f}`)
  }
  for (const ts of ['createdAt', 'archivedAt']) {
    assert.ok(mRec[ts] && sRec[ts], `timestamp present: ${ts}`)
    assert.ok(!Number.isNaN(Date.parse(mRec[ts])), `MySQL ${ts} is ISO: ${mRec[ts]}`)
    assert.ok(!Number.isNaN(Date.parse(sRec[ts])), `SQLite ${ts} is ISO: ${sRec[ts]}`)
  }
  await sqlite.deleteAll({ owner }).catch(() => {})
  await mysql.deleteAll({ owner }).catch(() => {})
})

test('M1 live MySQL fault-injection killers prove guards bite (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const { verifyMysqlVersion } = await import('../src/migrations.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  const store = createMysqlStore(knex)
  const owner = `02${'78'.repeat(32)}`
  const peer = `03${'79'.repeat(32)}`
  await store.deleteAll({ owner }).catch(() => {})

  // Killer 1: a missing required index fails version verification (restore after).
  await knex.raw(`DROP INDEX idx_owner_seq ON history_records`)
  await assert.rejects(verifyMysqlVersion(knex, '001-init'), /missing index.*idx_owner_seq/, 'dropped index is detected')
  await knex.raw(`CREATE INDEX idx_owner_seq ON history_records (owner_identity_key, change_sequence, record_key)`)
  await verifyMysqlVersion(knex, '001-init')

  // Killer 2: the SQL CHECK constraint rejects a bad body_hash at the DB layer.
  await assert.rejects(
    knex.raw(
      `INSERT INTO history_records (owner_identity_key, record_key, message_id, message_box, direction, sender, recipient, body, body_hash, body_bytes, change_sequence)
       VALUES (?, ?, 'killer', 'inbox', 'outbound', ?, ?, ?, 'zz', 27, 1)`,
      [owner, 'b'.repeat(64), owner, peer, BODY],
    ),
    /check/i,
    'CHECK constraint rejects non-hex body_hash',
  )
  assert.equal(Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_records WHERE record_key = ?`, ['b'.repeat(64)]))[0][0].n), 0)

  // Killer 3: idempotency-key reuse with different input is a typed conflict.
  const epoch = (await store.getUsage({ owner })).epoch
  const archived = await store.archiveBatch({ owner, epoch, records: [liveRecord(owner, peer, 'killer-1', BODY)] })
  const key = archived.outcomes[0].recordKey
  await store.patchState({ owner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: 'killer-key-1' })
  await assert.rejects(
    store.patchState({ owner, recordKey: key, newState: 'accepted', expectedRevision: '2', idempotencyKey: 'killer-key-1' }),
    (e) => e?.code === 'ERR_IDEMPOTENCY_CONFLICT',
    'key reuse with different input conflicts',
  )

  // Killer 4: forged recordKey/bodyHash never creates a row (server recomputes).
  const forged = await store.archiveBatch({ owner, epoch, records: [{ ...liveRecord(owner, peer, 'killer-2', BODY), recordKey: 'c'.repeat(64), bodyHash: 'd'.repeat(64) }] })
  assert.equal(forged.outcomes[0].outcome, 'invalid', 'forged identity rejected')
  assert.equal(await store.getRecord({ owner, recordKey: 'c'.repeat(64) }), null)

  await store.deleteAll({ owner }).catch(() => {})
})

test('M1 .2.4.2/.2.4.3 live MySQL data-bearing pre-004 upgrade fails closed and preserves numeric deletion fences (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await connect(t)
  await migrateMysql(knex)
  let store = createMysqlStore(knex)
  const stamp = `${Date.now().toString(16)}${process.pid.toString(16)}`.padEnd(64, 'd').slice(0, 64)
  const owner = `02${stamp}`
  const peer = `03${'de'.repeat(32)}`
  const legacyRecord = liveRecord(owner, peer, 'legacy-deleted', BODY)
  const epoch = (await store.getUsage({ owner })).epoch
  const first = await store.archiveBatch({ owner, epoch, records: [legacyRecord, liveRecord(owner, peer, 'legacy-live', BODY)] })
  await store.patchState({ owner, recordKey: first.outcomes[1].recordKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'legacy-state' })
  await store.deleteRecord({ owner, recordKey: first.outcomes[0].recordKey })

  // Build a real pre-004 database: legacy 001-003 tables retain data-bearing
  // upsert/state/delete history while only 004 objects and its stamp vanish.
  await knex.raw(`DROP TABLE history_change_details`)
  await knex.raw(`DROP TABLE history_change_boundaries`)
  await knex.raw(`DROP TABLE history_tombstones`)
  await knex.raw(`DELETE FROM schema_migrations WHERE version='004-tombstones'`)
  await knex.raw(`INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version, deleted_at, created_at) VALUES (?, 10, ?, 'delete', 1, '2029-01-01 00:00:00.000000', '2029-01-01 00:00:00.000000')`, [owner, first.outcomes[0].recordKey])
  await knex.raw(`UPDATE history_owner_state SET next_sequence=11 WHERE owner_identity_key=?`, [owner])

  await migrateMysql(knex)
  store = createMysqlStore(knex)
  const tombstone = (await knex.raw(`SELECT change_sequence FROM history_tombstones WHERE owner_identity_key=? AND record_key=?`, [owner, first.outcomes[0].recordKey]))[0][0]
  assert.equal(String(tombstone.change_sequence), '10', 'MUT-KILLER: numeric 10 must beat lexical 2 during backfill')
  await assert.rejects(() => store.listChangesPage({ owner, serverSecret: 'legacy-upgrade-secret-012345' }), (e) => e?.code === 'ERR_CURSOR_EXPIRED', 'ambiguous legacy history requires typed snapshot resync')

  const postEpoch = (await store.getUsage({ owner })).epoch
  const post = await store.archiveBatch({ owner, epoch: postEpoch, records: [liveRecord(owner, peer, 'post-004', BODY)] })
  await store.patchState({ owner, recordKey: post.outcomes[0].recordKey, newState: 'received', expectedRevision: '1', idempotencyKey: 'post-state' })
  const W = String(BigInt((await store.getUsage({ owner })).nextSequence) - 1n)
  const cursor = newChangesCursor({ serverSecret: 'legacy-upgrade-secret-012345', owner, epoch: postEpoch, filterDigest: '', watermark: W, position: '10' })
  const page = await store.listChangesPage({ owner, serverSecret: 'legacy-upgrade-secret-012345', cursor, limit: 10 })
  assert.deepEqual(page.records.map((row) => [row.changeSequence, row.revision, row.deliveryState]), [['11', '1', 'prepared'], ['12', '2', 'received']], 'reconstructable post-004 details remain event-faithful')

  await knex.raw(`UPDATE history_changes SET created_at='2020-01-01 00:00:00.000000' WHERE owner_identity_key=?`, [owner])
  for (let guard = 0; guard < 20; guard += 1) {
    const result = await store.purgeExpiredChanges({ owner, nowIso: '2030-01-01T00:00:00.000Z', maxItems: 3 })
    if (!result.hasMore) break
  }
  const retried = await store.archiveBatch({ owner, epoch: postEpoch, records: [legacyRecord] })
  assert.equal(retried.outcomes[0].outcome, 'deleted', 'fence survives change compaction and prevents resurrection')
  await store.deleteAll({ owner })
  assert.equal(Number((await knex.raw(`SELECT COUNT(*) n FROM history_tombstones WHERE owner_identity_key=?`, [owner]))[0][0].n), 0, 'deleteAll epoch rotation clears obsolete fences')
})

test('M1 every pooled MySQL connection is UTC and round-trips fixed instants (gated)', { skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const knex = await connect(t)
  const acquired = await Promise.all([knex.client.acquireConnection(), knex.client.acquireConnection(), knex.client.acquireConnection()])
  const query = (connection, sql, values = []) => new Promise((resolve, reject) => {
    connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows))
  })
  const fixed = '2031-02-03 04:05:06.123456'
  try {
    for (const connection of acquired) {
      const zoneRows = await query(connection, `SELECT @@session.time_zone AS session_tz, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offset_seconds`)
      assert.equal(zoneRows[0].session_tz, '+00:00')
      assert.ok(Math.abs(Number(zoneRows[0].offset_seconds)) <= 1, 'database NOW agrees with UTC_TIMESTAMP')
      const roundTrip = await query(connection, `SELECT CAST(? AS DATETIME(6)) AS fixed_utc`, [fixed])
      assert.equal(new Date(roundTrip[0].fixed_utc).toISOString(), '2031-02-03T04:05:06.123Z')
    }
  } finally {
    await Promise.all(acquired.map((connection) => knex.client.releaseConnection(connection)))
  }
})
