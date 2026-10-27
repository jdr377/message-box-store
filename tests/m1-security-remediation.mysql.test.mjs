import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { LIMITS, validateEpoch } from '../src/protocol.mjs'
import { createMysqlKnex, createMysqlStore, migrateMysql } from '../src/repository.mysql.mjs'
import { applyMysqlRestoreRecovery } from '../src/restore-recovery.mjs'
import { MAX_SNAPSHOTS_PER_OWNER, MAX_SNAPSHOT_ITEMS_PER_OWNER } from '../src/snapshots.mjs'

const ENABLED = process.env.MESSAGE_BOX_STORE_MYSQL === '1'
const BODY = '{"encryptedMessage":"AQ=="}'
const PEER = `03${'22'.repeat(32)}`
const SECRET = 'disposable-security-test-cursor-secret'
const OWNER_TABLES = ['history_audit_events', 'history_change_boundaries', 'history_change_details', 'history_tombstones', 'history_idempotency', 'history_changes', 'history_records', 'history_owner_state', 'history_resource_locks']
const record = (owner, messageId, body = BODY) => ({ messageId, messageBox: 'security', direction: 'outbound', sender: owner, recipient: PEER, body })

// Use only an explicitly named test/fresh/disposable schema.
// Every owner is fresh; cleanup is scoped to those owners, not the database.
test('live MySQL security repairs preserve quotas, recovery and bounded reads', {
  skip: ENABLED ? false : 'set MESSAGE_BOX_STORE_MYSQL=1 with dedicated MYSQL_* test configuration',
  timeout: 120_000,
}, async t => {
  const database = process.env.MYSQL_DATABASE
  assert.ok(database && /(?:^|_)(?:test|fresh|disposable)(?:_|$)/.test(database), 'a dedicated test/fresh/disposable database is required')
  const knex = await createMysqlKnex({ host: process.env.MYSQL_HOST ?? '127.0.0.1', port: Number(process.env.MYSQL_PORT ?? 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database })
  const owners = []
  t.after(async () => {
    try {
      for (const owner of owners) {
        await knex.transaction(async trx => {
          const ids = await trx('history_snapshots').where({ owner_identity_key: owner }).pluck('snapshot_id')
          if (ids.length) await trx('history_snapshot_items').whereIn('snapshot_id', ids).del()
          await trx('history_snapshots').where({ owner_identity_key: owner }).del()
          for (const table of OWNER_TABLES) await trx(table).where({ owner_identity_key: owner }).del()
        })
        for (const table of [...OWNER_TABLES, 'history_snapshots']) {
          assert.equal(Number((await knex(table).where({ owner_identity_key: owner }).count({ n: '*' }))[0].n), 0, 'fixture owner cleanup must complete')
        }
      }
    } finally { await knex.destroy() }
  })
  await migrateMysql(knex)
  const migrationRows = await knex('schema_migrations').select('version', 'checksum').orderBy('version')
  const store = createMysqlStore(knex)
  async function owner() {
    const key = `02${randomBytes(32).toString('hex')}`
    assert.equal(await knex('history_owner_state').where({ owner_identity_key: key }).first(), undefined)
    owners.push(key)
    return key
  }
  const archive = async (api, key, records, epoch) => api.archiveBatch({ owner: key, epoch: epoch ?? (await api.getUsage({ owner: key })).epoch, records })

  await t.test('F2 actual restore recovery epochs survive repeated delete-all and new writes', async () => {
    for (const recoveryEpoch of ['restore_security_20261028', 'x'.repeat(128)]) {
      const key = await owner()
      await archive(store, key, [record(key, 'before-recovery')])
      await applyMysqlRestoreRecovery({ knex, bundle: { version: 1, recoveryId: 'disposable-security', owner: key, restoredEpoch: 'gen-1', recoveryEpoch, deletionReceiptsComplete: true, backupCreatedAt: '2026-09-22T00:00:00.000Z', receiptsCompleteThrough: '2026-09-22T01:00:00.000Z', backupRetentionUntil: '2026-10-22T00:00:00.000Z', deletions: [] } })
      const first = await store.deleteAll({ owner: key, expectedEpoch: recoveryEpoch })
      const second = await store.deleteAll({ owner: key, expectedEpoch: first.epoch })
      assert.equal(validateEpoch(first.epoch), first.epoch)
      assert.equal(validateEpoch(second.epoch), second.epoch)
      assert.notEqual(first.epoch, second.epoch)
      assert.equal((await archive(store, key, [record(key, 'stale')], recoveryEpoch)).outcomes[0].outcome, 'epochChanged')
      assert.equal((await archive(store, key, [record(key, 'after')], second.epoch)).outcomes[0].outcome, 'stored')
      const snapshot = await store.createSnapshot({ owner: key })
      assert.equal((await store.listSnapshotPage({ owner: key, snapshotId: snapshot.snapshotId, serverSecret: SECRET })).records.length, 1)
    }
  })

  await t.test('F3 bounded ciphertext pages resume exact microsecond keysets with no omissions', async () => {
    const key = await owner()
    const body = JSON.stringify({ encryptedMessage: 'A'.repeat(1024 * 1024 - 64) })
    const expected = []
    for (let i = 0; i < 10; i++) {
      const result = await archive(store, key, [record(key, `large-${i}`, body)])
      assert.equal(result.outcomes[0].outcome, 'stored')
      expected.push(result.outcomes[0].recordKey)
    }
    await knex('history_records').where({ owner_identity_key: key }).update({ created_at: '2026-10-28 00:00:00.000123' })
    const found = []
    let after
    let pages = 0
    do {
      assert.ok(++pages <= 10, 'continuation must make progress')
      const page = await store.listBrowse({ owner: key, limit: 1000, after, filter: { messageBox: 'security', direction: 'outbound', participant: PEER } })
      assert.ok(Buffer.byteLength(JSON.stringify({ records: page.items, nextAfter: page.nextAfter })) <= LIMITS.MAX_PAGE_BYTES)
      assert.ok(page.items.length > 0)
      for (const row of page.items) {
        assert.equal(row.createdAt, '2026-10-28T00:00:00.000123Z')
        assert.equal(row.body, body)
        found.push(row.recordKey)
      }
      after = page.nextAfter
    } while (after)
    assert.ok(pages > 1, 'byte budget must split the requested 1000-row page')
    assert.deepEqual(found.sort(), expected.sort())
    assert.equal(new Set(found).size, 10)
    assert.deepEqual((await store.listBrowse({ owner: await owner() })).items, [])
    const single = await store.listBrowse({ owner: key, limit: 1 })
    assert.equal(single.items.length, 1)
    assert.deepEqual(single.nextAfter, { createdAt: single.items[0].createdAt, recordKey: single.items[0].recordKey })
  })

  await t.test('F4 snapshot metadata and concurrent anchor admission use real InnoDB locking', async () => {
    const key = await owner()
    await archive(store, key, [record(key, 'snapshot')])
    const queries = []
    const capture = query => queries.push(query.sql)
    knex.on('query', capture)
    try {
      const snapshot = await store.createSnapshot({ owner: key, filter: { direction: 'outbound', messageBox: 'security', participant: PEER } })
      const membership = queries.find(sql => sql.startsWith('SELECT r.'))
      assert.ok(membership)
      assert.doesNotMatch(membership, /r\.\*|r\.body\b/)
      assert.equal((await store.listSnapshotMembers({ owner: key, snapshotId: snapshot.snapshotId })).items.length, 1)
      const attempts = await Promise.allSettled(Array.from({ length: MAX_SNAPSHOTS_PER_OWNER + 1 }, () => store.createSnapshot({ owner: key })))
      assert.equal(attempts.filter(r => r.status === 'fulfilled').length, MAX_SNAPSHOTS_PER_OWNER - 1)
      assert.ok(attempts.filter(r => r.status === 'rejected').every(r => r.reason.code === 'ERR_QUOTA_EXCEEDED'))
      queries.length = 0
      await assert.rejects(store.createSnapshot({ owner: key }), error => error.code === 'ERR_QUOTA_EXCEEDED')
      assert.equal(queries.some(sql => sql.includes('FROM history_records')), false, 'full anchor capacity must reject before membership reads')
    } finally { knex.off('query', capture) }
  })

  await t.test('F4 aggregate snapshot item capacity rejects before metadata materialization', async () => {
    const key = await owner()
    await archive(store, key, [record(key, 'item-capacity')])
    const snapshot = await store.createSnapshot({ owner: key })
    // Synthetic membership rows exercise the real fixed 40,000-item boundary.
    // No ciphertext bodies or historical production rows are copied.
    const rows = Array.from({ length: MAX_SNAPSHOT_ITEMS_PER_OWNER - 1 }, (_, i) => ({ snapshot_id: snapshot.snapshotId, record_key: i.toString(16).padStart(64, '0'), revision_at_w: '1', delivery_state_at_w: 'prepared', change_sequence_at_w: '1', created_at_at_w: '2026-10-28 00:00:00.000000' }))
    await knex.batchInsert('history_snapshot_items', rows, 1000)
    const queries = []
    const capture = query => queries.push(query.sql)
    knex.on('query', capture)
    try {
      await assert.rejects(store.createSnapshot({ owner: key }), error => error.code === 'ERR_QUOTA_EXCEEDED')
      assert.ok(queries.some(sql => sql.startsWith('SELECT COUNT(*) AS n FROM history_records')))
      assert.equal(queries.some(sql => sql.startsWith('SELECT r.')), false)
    } finally { knex.off('query', capture) }
  })

  await t.test('F5 deletion reservations preserve retries, conflicts and history after reconnection', async () => {
    const key = await owner()
    const limited = createMysqlStore(knex, { limits: { MAX_RESERVED_RECORD_KEYS_PER_OWNER: 2 } })
    const input = record(key, 'first')
    const result = await archive(limited, key, [input, input, record(key, 'first', '{"encryptedMessage":"Ag=="}'), record(key, 'second'), record(key, 'over')])
    assert.deepEqual(result.outcomes.map(r => r.outcome), ['stored', 'alreadyPresent', 'conflict', 'stored', 'quotaExceeded'])
    const firstKey = result.outcomes[0].recordKey
    assert.equal((await limited.patchState({ owner: key, recordKey: firstKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'state-at-capacity' })).ok, true)
    assert.equal((await limited.deleteRecord({ owner: key, recordKey: firstKey })).deleted, true)
    assert.equal((await archive(limited, key, [input])).outcomes[0].outcome, 'deleted')
    assert.equal((await archive(limited, key, [record(key, 'new')])).outcomes[0].outcome, 'quotaExceeded')
    const reopenedKnex = await createMysqlKnex({ host: process.env.MYSQL_HOST ?? '127.0.0.1', port: Number(process.env.MYSQL_PORT ?? 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database })
    try {
      const reopened = createMysqlStore(reopenedKnex, { limits: { MAX_RESERVED_RECORD_KEYS_PER_OWNER: 1 } })
      assert.equal((await reopened.listBrowse({ owner: key })).items.length, 1)
      assert.equal((await archive(reopened, key, [record(key, 'second')])).outcomes[0].outcome, 'alreadyPresent')
      assert.equal((await archive(reopened, key, [record(key, 'still-blocked')])).outcomes[0].outcome, 'quotaExceeded')
      assert.equal((await reopened.deleteRecord({ owner: key, recordKey: result.outcomes[3].recordKey })).deleted, true)
      assert.equal((await reopened.getUsage({ owner: key })).recordCount, 0)
      assert.equal((await reopened.getStorageStats({ owner: key })).physical.tombstoneCount, 2)
      await reopened.deleteAll({ owner: key })
      assert.equal((await archive(reopened, key, [record(key, 'new-epoch')])).outcomes[0].outcome, 'stored')
    } finally { await reopenedKnex.destroy() }
  })

  await t.test('F5 concurrent admission and rollback preserve a single reservation', async () => {
    const key = await owner()
    const limited = createMysqlStore(knex, { limits: { MAX_RESERVED_RECORD_KEYS_PER_OWNER: 1 } })
    const input = record(key, 'rollback')
    limited.injectFailureOnce('archiveBatch')
    await assert.rejects(archive(limited, key, [input]))
    assert.equal((await limited.getUsage({ owner: key })).recordCount, 0)
    const results = await Promise.all([archive(limited, key, [record(key, 'a')]), archive(limited, key, [record(key, 'b')])])
    assert.deepEqual(results.map(r => r.outcomes[0].outcome).sort(), ['quotaExceeded', 'stored'])
    assert.equal((await limited.getUsage({ owner: key })).recordCount, 1)
  })
  assert.deepEqual(await knex('schema_migrations').select('version', 'checksum').orderBy('version'), migrationRows, 'repairs must not rewrite migration history')
})