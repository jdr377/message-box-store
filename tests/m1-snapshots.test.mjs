import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryStore } from '../src/repository.mjs'
import { createSqliteStore } from '../src/repository.sqlite.mjs'
import { snapshotFilterHash } from '../src/snapshots.mjs'

const OWNER = `02${'ee'.repeat(32)}`
const PEER = `03${'ff'.repeat(32)}`
const BODY = '{"encryptedMessage":"AQ=="}'

function record({ messageId, direction = 'outbound', messageBox = 'inbox', body = BODY } = {}) {
  return { messageId, messageBox, direction, sender: OWNER, recipient: PEER, body }
}

async function makeStores(t) {
  const mem = createMemoryStore()
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  return { mem, sqlite }
}

async function seed(store, ids) {
  const epoch = store.getUsage ? (await store.getUsage({ owner: OWNER })).epoch : 'gen-1'
  const result = await store.archiveBatch({ owner: OWNER, epoch, records: ids.map((messageId) => record({ messageId })) })
  assert.ok(result.outcomes.every((o) => o.outcome === 'stored'))
  return result
}

test('M1 snapshot freezes state at W: post-W writes excluded, later state invisible', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await seed(store, ['snap-a-1', 'snap-a-2'])
    const snap = await store.createSnapshot({ owner: OWNER })
    assert.equal(snap.memberCount, 2)
    assert.equal(snap.status, 'active')
    // Post-W archive is not a member; post-W state change does not leak in.
    const usage = await store.getUsage({ owner: OWNER })
    await store.archiveBatch({ owner: OWNER, epoch: usage.epoch, records: [record({ messageId: 'snap-a-3' })] })
    const key = (await store.archiveBatch({ owner: OWNER, epoch: usage.epoch, records: [record({ messageId: 'probe' })] })).outcomes[0].recordKey
    await store.deleteRecord({ owner: OWNER, recordKey: key }) // keep member set intact
    const firstKey = snap.memberCount ? (await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })).items[0].recordKey : null
    await store.patchState({ owner: OWNER, recordKey: firstKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'snap-freeze-accept' })
    const members = await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })
    assert.equal(members.status, 'active')
    assert.equal(members.items.length, 2, 'post-W records are not members')
    const changed = members.items.find((item) => item.recordKey === firstKey)
    assert.equal(changed.deliveryStateAtW, 'prepared', 'materialized state frozen at W')
    assert.equal(changed.revisionAtW, '1')
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 interleaved commits leave an active snapshot stable', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await seed(store, ['stab-1', 'stab-2', 'stab-3'])
    const snap = await store.createSnapshot({ owner: OWNER })
    const before = await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })
    const usage = await store.getUsage({ owner: OWNER })
    // Interleave: new archive, member state change, unrelated delete.
    await store.archiveBatch({ owner: OWNER, epoch: usage.epoch, records: [record({ messageId: 'stab-4' })] })
    await store.patchState({ owner: OWNER, recordKey: before.items[0].recordKey, newState: 'unknown', expectedRevision: '1', idempotencyKey: 'snap-stable-unknown' })
    const tempKey = (await store.archiveBatch({ owner: OWNER, epoch: usage.epoch, records: [record({ messageId: 'stab-temp' })] })).outcomes[0].recordKey
    await store.deleteRecord({ owner: OWNER, recordKey: tempKey })
    const afterReads = [await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER }), await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })]
    // The temp delete invalidated nothing (not a member); snapshot stays active and identical.
    assert.equal(afterReads[0].status, 'active')
    assert.deepEqual(afterReads[0], afterReads[1])
    assert.deepEqual(afterReads[0].items, before.items)
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 deletion purges ciphertext immediately and invalidates only dependent snapshots', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await seed(store, ['dep-1', 'dep-2'])
    const withBoth = await store.createSnapshot({ owner: OWNER })
    const filtered = await store.createSnapshot({ owner: OWNER, filter: { messageBox: 'other-box' } })
    assert.equal(filtered.memberCount, 0)
    assert.notEqual(filtered.snapshotId, withBoth.snapshotId)
    const victimKey = (await store.listSnapshotMembers({ snapshotId: withBoth.snapshotId, owner: OWNER })).items[0].recordKey
    await store.deleteRecord({ owner: OWNER, recordKey: victimKey })
    assert.equal(await store.getRecord({ owner: OWNER, recordKey: victimKey }), null, 'ciphertext purged immediately')
    const dead = await store.listSnapshotMembers({ snapshotId: withBoth.snapshotId, owner: OWNER })
    assert.equal(dead.status, 'invalidated')
    assert.deepEqual(dead.items, [])
    const meta = await store.getSnapshot({ snapshotId: withBoth.snapshotId, owner: OWNER })
    assert.equal(meta.status, 'invalidated')
    // Snapshot with no dependent member stays active.
    assert.equal((await store.getSnapshot({ snapshotId: filtered.snapshotId, owner: OWNER })).status, 'active')
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 delete-all and epoch rotation invalidate old-epoch snapshots only', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await seed(store, ['ep-1'])
    const old = await store.createSnapshot({ owner: OWNER })
    const wiped = await store.deleteAll({ owner: OWNER })
    assert.equal((await store.getSnapshot({ snapshotId: old.snapshotId, owner: OWNER })).status, 'invalidated')
    await store.archiveBatch({ owner: OWNER, epoch: wiped.epoch, records: [record({ messageId: 'ep-2' })] })
    const fresh = await store.createSnapshot({ owner: OWNER })
    assert.equal(fresh.epoch, wiped.epoch)
    assert.equal(fresh.memberCount, 1)
    assert.equal((await store.listSnapshotMembers({ snapshotId: fresh.snapshotId, owner: OWNER })).items.length, 1)
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 snapshot pagination is gap-free with stable ordering', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await seed(store, ['pg-1', 'pg-2', 'pg-3', 'pg-4', 'pg-5'])
    const snap = await store.createSnapshot({ owner: OWNER })
    const seen = []
    let after
    for (let i = 0; i < 4; i += 1) {
      const page = await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER, limit: 2, after })
      seen.push(...page.items.map((item) => item.recordKey))
      if (page.items.length < 2) break
      const last = page.items[page.items.length - 1]
      after = { createdAtAtW: last.createdAtAtW, recordKey: last.recordKey }
    }
    assert.equal(seen.length, 5)
    assert.equal(new Set(seen).size, 5, 'no gaps or duplicates')
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 snapshot expiry purges membership in bounded batches', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await seed(store, ['ex-1', 'ex-2', 'ex-3'])
    const snap = await store.createSnapshot({ owner: OWNER })
    assert.equal((await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })).items.length, 3)
    const purged = await store.purgeExpiredSnapshots({ nowIso: '2999-01-01T00:00:00.000Z', batchSize: 2 })
    assert.equal(purged.purgedItems, 3, 'all items purged across bounded passes')
    assert.equal(purged.purgedSnapshots, 1)
    assert.equal(purged.hasMore, false)
    assert.equal(await store.getSnapshot({ snapshotId: snap.snapshotId, owner: OWNER }), null)
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 filter identity separates snapshots without duplicating bodies', async (t) => {
  const store = (await makeStores(t)).sqlite
  await store.archiveBatch({
    owner: OWNER,
    epoch: (await store.getUsage({ owner: OWNER })).epoch,
    records: [record({ messageId: 'f-in-1', direction: 'inbound', messageBox: 'inbox' })].map((r) => ({ ...r, sender: PEER, recipient: OWNER })),
  })
  await store.archiveBatch({
    owner: OWNER,
    epoch: (await store.getUsage({ owner: OWNER })).epoch,
    records: [record({ messageId: 'f-out-1', direction: 'outbound', messageBox: 'inbox' })],
  })
  const inboundOnly = await store.createSnapshot({ owner: OWNER, filter: { direction: 'inbound' } })
  const all = await store.createSnapshot({ owner: OWNER })
  assert.equal(inboundOnly.memberCount, 1)
  assert.equal(all.memberCount, 2)
  assert.notEqual(inboundOnly.snapshotId, all.snapshotId)
  assert.ok(inboundOnly.filterHash.length === 64 && all.filterHash === '')
  assert.equal(snapshotFilterHash({ direction: 'inbound' }), inboundOnly.filterHash)
  // No ciphertext in items: bodies live only in history_records.
  assert.equal((await store.listSnapshotMembers({ snapshotId: all.snapshotId, owner: OWNER })).items.every((i) => !('body' in i)), true)
  await store.deleteAll({ owner: OWNER })
})

const MYSQL_ENABLED = process.env.MESSAGE_BOX_STORE_MYSQL === '1'

test('M1 live MySQL exposes matching snapshot primitives (gated)', { skip: !MYSQL_ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { createMysqlKnex, migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const cfg = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  }
  assert.ok(cfg.user && cfg.password && cfg.database, 'MYSQL_USER/PASSWORD/DATABASE required')
  const knex = await createMysqlKnex(cfg)
  t.after(() => knex.destroy())
  await migrateMysql(knex) // upgrade: live DB already carried 001
  const versions = (await knex.raw(`SELECT version FROM schema_migrations ORDER BY version`))[0].map((r) => r.version)
  assert.ok(versions.includes('001-init') && versions.includes('002-snapshot-foundation'), `migrations: ${versions}`)
  const tables = (await knex.raw(`SHOW TABLES`))[0].map((r) => Object.values(r)[0])
  assert.ok(tables.includes('history_snapshots') && tables.includes('history_snapshot_items'))

  const MOWNER = `02${'ab'.repeat(32)}`
  const MPEER = `03${'cd'.repeat(32)}`
  const store = createMysqlStore(knex)
  await store.deleteAll({ owner: MOWNER })
  const epoch = (await store.getUsage({ owner: MOWNER })).epoch
  const archived = await store.archiveBatch({
    owner: MOWNER,
    epoch,
    records: [
      { messageId: 'live-snap-1', messageBox: 'inbox', direction: 'outbound', sender: MOWNER, recipient: MPEER, body: BODY },
      { messageId: 'live-snap-2', messageBox: 'inbox', direction: 'outbound', sender: MOWNER, recipient: MPEER, body: BODY },
    ],
  })
  assert.ok(archived.outcomes.every((o) => o.outcome === 'stored'))
  const snap = await store.createSnapshot({ owner: MOWNER })
  assert.equal(snap.memberCount, 2)
  const members = await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: MOWNER })
  assert.equal(members.status, 'active')
  assert.equal(members.items.length, 2)
  // Post-W state change stays out of the materialized view.
  await store.patchState({ owner: MOWNER, recordKey: members.items[0].recordKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'snap-mysql-accept' })
  assert.equal((await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: MOWNER })).items[0].deliveryStateAtW, 'prepared')
  // Deletion invalidates the dependent snapshot on live MySQL too.
  await store.deleteRecord({ owner: MOWNER, recordKey: members.items[0].recordKey })
  assert.equal((await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: MOWNER })).status, 'invalidated')
  await store.deleteAll({ owner: MOWNER })
})
