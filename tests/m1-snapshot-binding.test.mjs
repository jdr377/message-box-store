import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryStore } from '../src/repository.mjs'
import { createSqliteStore } from '../src/repository.sqlite.mjs'
import {
  SNAPSHOT_FEED,
  SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL,
  SNAPSHOT_PURGE_MAX_SNAPSHOTS_PER_CALL,
  snapshotFilterHash,
} from '../src/snapshots.mjs'

const OWNER = `02${'ee'.repeat(32)}`
const OWNER_B = `02${'ab'.repeat(32)}`
const PEER = `03${'ff'.repeat(32)}`
const OTHER = `03${'11'.repeat(32)}`
const BODY = '{"encryptedMessage":"AQ=="}'
const PAGE_SECRET = 'snapshot-proof-secret-0123456789'
const PROOF_RUN = Date.now().toString(16).padStart(12, '0').slice(-12)

function proofOwner(ordinal, fill) {
  return `02${(PROOF_RUN + ordinal.toString(16).padStart(4, '0') + fill.repeat(32)).slice(0, 64)}`
}

function record({ messageId, direction = 'outbound', messageBox = 'inbox', sender = OWNER, recipient = PEER, body = BODY } = {}) {
  return { messageId, messageBox, direction, sender, recipient, body }
}

async function makeStores(t, owner = OWNER) {
  const mem = createMemoryStore()
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  // Live MySQL when enabled: isolated owner per test via unique prefix.
  let mysql = null
  let mysqlKnex = null
  if (process.env.MESSAGE_BOX_STORE_MYSQL === '1') {
    const { createMysqlKnex, migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
    mysqlKnex = await createMysqlKnex({
      host: process.env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    })
    t.after(() => mysqlKnex.destroy())
    await migrateMysql(mysqlKnex)
    mysql = createMysqlStore(mysqlKnex)
  }
  return { mem, sqlite, mysql, _mysqlKnex: mysqlKnex }
}

async function seed(store, owner, ids) {
  const epoch = (await store.getUsage({ owner })).epoch
  const result = await store.archiveBatch({ owner, epoch, records: ids.map((messageId) => record({ messageId, sender: owner, recipient: PEER })) })
  assert.ok(result.outcomes.every((o) => o.outcome === 'stored'), JSON.stringify({ owner, outcomes: result.outcomes }))
  return result
}

function tamperCursor(cursor) {
  const [payload, mac] = cursor.split('.')
  return `${payload}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`
}

async function mutateSnapshot({ name, store, knex, snapshotId, field, value }) {
  if (name === 'mem') {
    const meta = store._debug.snapshots.get(snapshotId)
    meta[field] = value
    return
  }
  const columns = { expiresAt: 'expires_at', epoch: 'epoch', filterHash: 'filter_hash', watermark: 'watermark', status: 'status' }
  if (name === 'sqlite') store.db.prepare(`UPDATE history_snapshots SET ${columns[field]} = ? WHERE snapshot_id = ?`).run(value, snapshotId)
  else await knex.raw(`UPDATE history_snapshots SET ${columns[field]} = ? WHERE snapshot_id = ?`, [value, snapshotId])
}

async function expireRecord({ name, store, knex, owner, recordKey }) {
  if (name === 'mem') store._debug.records.get(`${owner}\0${recordKey}`).expiresAt = '2020-01-01T00:00:00.000Z'
  else if (name === 'sqlite') store.db.prepare(`UPDATE history_records SET expires_at = ? WHERE owner_identity_key = ? AND record_key = ?`).run('2020-01-01T00:00:00.000Z', owner, recordKey)
  else await knex.raw(`UPDATE history_records SET expires_at = ? WHERE owner_identity_key = ? AND record_key = ?`, ['2020-01-01 00:00:00.000000', owner, recordKey])
}

async function deleteChangeSequence({ name, store, knex, owner, sequence }) {
  if (name === 'mem') {
    const rows = store._debug.changes.get(owner) ?? []
    const index = rows.findIndex((row) => String(row.sequence) === String(sequence))
    if (index >= 0) rows.splice(index, 1)
    return
  }
  if (name === 'sqlite') {
    store.db.exec('BEGIN IMMEDIATE')
    try {
      store.db.prepare(`DELETE FROM history_change_details WHERE owner_identity_key=? AND change_sequence=?`).run(owner, String(sequence))
      store.db.prepare(`DELETE FROM history_changes WHERE owner_identity_key=? AND change_sequence=?`).run(owner, String(sequence))
      store.db.exec('COMMIT')
    } catch (error) {
      store.db.exec('ROLLBACK')
      throw error
    }
  } else {
    await knex.transaction(async (trx) => {
      await trx.raw(`DELETE FROM history_change_details WHERE owner_identity_key=? AND change_sequence=?`, [owner, String(sequence)])
      await trx.raw(`DELETE FROM history_changes WHERE owner_identity_key=? AND change_sequence=?`, [owner, String(sequence)])
    })
  }
}

async function backdateChanges({ name, store, knex, owner }) {
  if (name === 'mem') for (const row of store._debug.changes.get(owner) ?? []) row.createdAt = '2020-01-01T00:00:00.000Z'
  else if (name === 'sqlite') store.db.prepare(`UPDATE history_changes SET created_at=? WHERE owner_identity_key=?`).run('2020-01-01T00:00:00.000Z', owner)
  else await knex.raw(`UPDATE history_changes SET created_at=? WHERE owner_identity_key=?`, ['2020-01-01 00:00:00.000000', owner])
}

async function orphanDetailCount({ name, store, knex, owner }) {
  if (name === 'mem') return 0
  const sql = `SELECT COUNT(*) AS n FROM history_change_details d LEFT JOIN history_changes c ON c.owner_identity_key=d.owner_identity_key AND c.change_sequence=d.change_sequence WHERE d.owner_identity_key=? AND c.change_sequence IS NULL`
  if (name === 'sqlite') return Number(store.db.prepare(sql).get(owner).n)
  return Number((await knex.raw(sql, [owner]))[0][0].n)
}

test('M1 .2.4.4 killer matrix: every internal retention gap fails closed while valid edges terminate', async (t) => {
  const { mem, sqlite, mysql, _mysqlKnex } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  let ordinal = 80
  for (const [name, store] of Object.entries(stores)) {
    for (const missing of [null, '2', '3', '4']) {
      const owner = proofOwner(++ordinal, name === 'mysql' ? 'bd' : 'bc')
      await seed(store, owner, ['gap-1', 'gap-2', 'gap-3', 'gap-4'])
      const first = await store.listChangesPage({ owner, serverSecret: PAGE_SECRET, limit: 1 })
      assert.equal(first.checkpoint, '1', `${name}: C=1`)
      assert.equal(first.watermark, '4', `${name}: W=4`)
      if (missing) await deleteChangeSequence({ name, store, knex: _mysqlKnex, owner, sequence: missing })
      if (missing) {
        // MUT-KILLER: removing assertNoInternalRetentionGap silently advances
        // across first, middle, or tail loss instead of forcing resync.
        await assert.rejects(async () => store.listChangesPage({ owner, serverSecret: PAGE_SECRET, cursor: first.nextCursor, limit: 10 }), (e) => e?.code === 'ERR_CURSOR_EXPIRED', `${name}: missing ${missing}`)
        const fresh = await store.listChangesPage({ owner, serverSecret: PAGE_SECRET, limit: 10 })
        assert.ok(Array.isArray(fresh.records), `${name}: initial C=0 remains readable as an explicitly partial retained view`)
        if (fresh.hasMore) await assert.rejects(async () => store.listChangesPage({ owner, serverSecret: PAGE_SECRET, cursor: fresh.nextCursor, limit: 10 }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')
      } else {
        const final = await store.listChangesPage({ owner, serverSecret: PAGE_SECRET, cursor: first.nextCursor, limit: 10 })
        assert.equal(final.hasMore, false, `${name}: no-gap final terminates`)
        assert.equal(final.checkpoint, '4')
      }
    }
  }
})

test('M1 .2.4.5 killer: bounded compaction crosses many anchors, removes details atomically, and converges', async (t) => {
  const { mem, sqlite, mysql, _mysqlKnex } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  let ordinal = 140
  for (const [name, store] of Object.entries(stores)) {
    const owner = proofOwner(++ordinal, name === 'mysql' ? 'cd' : 'cc')
    const seeded = await seed(store, owner, Array.from({ length: 8 }, (_, i) => `anchor-${i}`))
    for (let i = 0; i < seeded.outcomes.length; i += 1) await store.patchState({ owner, recordKey: seeded.outcomes[i].recordKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: `state-${i}` })
    await backdateChanges({ name, store, knex: _mysqlKnex, owner })
    let removed = 0
    let calls = 0
    let result
    do {
      result = await store.purgeExpiredChanges({ owner, nowIso: '2030-01-01T00:00:00.000Z', batchSize: 2, maxItems: 3 })
      assert.ok(result.examinedChanges <= 3, `${name}: hard examination budget`)
      assert.ok(result.purgedChanges <= 3, `${name}: hard mutation budget`)
      removed += result.purgedChanges
      calls += 1
      assert.equal(await orphanDetailCount({ name, store, knex: _mysqlKnex, owner }), 0, `${name}: no orphan detail after call ${calls}`)
      assert.ok(calls < 20, `${name}: continuation converges`)
    } while (result.hasMore)
    // MUT-KILLER: selecting maxItems before excluding protected upserts leaves
    // removed=0; non-atomic deletion leaves the orphan assertion non-zero.
    assert.equal(removed, 8, `${name}: all eligible state rows removed past protected anchors`)
    const stats = await store.getStorageStats({ owner })
    assert.equal(stats.physical.changeCount, 8, `${name}: truthful physical changes include retained anchors`)
    assert.equal(stats.physical.changeDetailCount, 8, `${name}: truthful detail count matches survivors`)
    assert.equal(result.hasMore, false, `${name}: truthful completion signal`)
  }
})

test('M1 .2.4.6 killer matrix: cursor authentication precedes invalidation/expiry and no stale ciphertext escapes', async (t) => {
  const { mem, sqlite, mysql, _mysqlKnex } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  let ordinal = 0
  const activeNow = new Date().toISOString()
  for (const [name, store] of Object.entries(stores)) {
    const freshOwner = () => proofOwner(++ordinal, name === 'mysql' ? 'ad' : 'ac')

    // MUT-KILLER: moving status/TTL checks before cursor verification changes
    // both tampered cases below from ERR_INVALID_CURSOR to ERR_CURSOR_EXPIRED.
    let owner = freshOwner()
    await seed(store, owner, ['active-a', 'active-b'])
    let snap = await store.createSnapshot({ owner })
    let first = await store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, limit: 1, nowSeconds: 1_000_000, nowIso: activeNow })
    assert.equal(first.hasMore, true, `${name}: active continuation exists`)
    await assert.rejects(async () => store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, cursor: tamperCursor(first.nextCursor), nowSeconds: 1_000_001, nowIso: activeNow }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    const victim = first.records[0].recordKey
    await store.deleteRecord({ owner, recordKey: victim })
    await assert.rejects(async () => store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, cursor: tamperCursor(first.nextCursor), nowSeconds: 1_000_001, nowIso: activeNow }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    await assert.rejects(async () => store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, cursor: first.nextCursor, nowSeconds: 1_000_001, nowIso: activeNow }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')

    owner = freshOwner()
    await seed(store, owner, ['ttl-a', 'ttl-b'])
    snap = await store.createSnapshot({ owner })
    first = await store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, limit: 1, nowSeconds: 1_000_000, nowIso: activeNow })
    await mutateSnapshot({ name, store, knex: _mysqlKnex, snapshotId: snap.snapshotId, field: 'expiresAt', value: name === 'mysql' ? '2020-01-01 00:00:00.000000' : '2020-01-01T00:00:00.000Z' })
    await assert.rejects(async () => store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, nowIso: '2030-01-01T00:00:00.000Z' }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')
    await assert.rejects(async () => store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, cursor: tamperCursor(first.nextCursor), nowSeconds: 1_000_001, nowIso: '2030-01-01T00:00:00.000Z' }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    await assert.rejects(async () => store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, cursor: first.nextCursor, nowSeconds: 1_000_001, nowIso: '2030-01-01T00:00:00.000Z' }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')

    owner = freshOwner()
    const archived = await seed(store, owner, ['record-expiry'])
    snap = await store.createSnapshot({ owner })
    await expireRecord({ name, store, knex: _mysqlKnex, owner, recordKey: archived.outcomes[0].recordKey })
    await assert.rejects(async () => store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, nowIso: '2030-01-01T00:00:00.000Z' }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')

    // Authenticated binding matrix: changing any stored feed identity after
    // cursor issuance invalidates the token before a body can be returned.
    for (const [field, value, expectedCode] of [['epoch', 'gen-999', 'ERR_EPOCH_CHANGED'], ['filterHash', 'f'.repeat(64), 'ERR_INVALID_CURSOR'], ['watermark', '999', 'ERR_INVALID_CURSOR']]) {
      owner = freshOwner()
      await seed(store, owner, [`bind-${field}-a`, `bind-${field}-b`])
      snap = await store.createSnapshot({ owner })
      first = await store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, limit: 1, nowSeconds: 1_000_000, nowIso: activeNow })
      await mutateSnapshot({ name, store, knex: _mysqlKnex, snapshotId: snap.snapshotId, field, value })
      await assert.rejects(async () => store.listSnapshotPage({ owner, serverSecret: PAGE_SECRET, snapshotId: snap.snapshotId, cursor: first.nextCursor, nowSeconds: 1_000_001, nowIso: activeNow }), (e) => e?.code === expectedCode)
    }
  }
})

test('M1 stale-epoch archive parity has ordered outcomes and zero effects across adapters', async (t) => {
  const { mem, sqlite, mysql, _mysqlKnex } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  for (const [name, store] of Object.entries(stores)) {
    const owner = name === 'mysql' ? `02${(`e${Date.now().toString(16)}` + '7a'.repeat(32)).slice(0, 64)}` : name === 'sqlite' ? OWNER_B : OWNER
    const staleEpoch = (await store.getUsage({ owner })).epoch
    const rotated = await store.deleteAll({ owner })
    const before = await store.getUsage({ owner })
    const countEffects = async () => {
      if (name === 'mem') return {
        records: [...store._debug.records.keys()].filter((key) => key.startsWith(`${owner}\0`)).length,
        changes: (store._debug.changes.get(owner) ?? []).length,
        audits: (store._debug.audits.get(owner) ?? []).length,
        idempotency: [...store._debug.idempotency.keys()].filter((key) => key.startsWith(`${owner}\0`)).length,
      }
      if (name === 'sqlite') {
        const row = store.db.prepare(`SELECT
          (SELECT COUNT(*) FROM history_records WHERE owner_identity_key = ?) records,
          (SELECT COUNT(*) FROM history_changes WHERE owner_identity_key = ?) changes,
          (SELECT COUNT(*) FROM history_audit_events WHERE owner_identity_key = ?) audits,
          (SELECT COUNT(*) FROM history_idempotency WHERE owner_identity_key = ?) idempotency`).get(owner, owner, owner, owner)
        return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
      }
      const [rows] = await _mysqlKnex.raw(`SELECT
        (SELECT COUNT(*) FROM history_records WHERE owner_identity_key = ?) records,
        (SELECT COUNT(*) FROM history_changes WHERE owner_identity_key = ?) changes,
        (SELECT COUNT(*) FROM history_audit_events WHERE owner_identity_key = ?) audits,
        (SELECT COUNT(*) FROM history_idempotency WHERE owner_identity_key = ?) idempotency`, [owner, owner, owner, owner])
      return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]))
    }
    const effectsBefore = await countEffects()
    const result = await store.archiveBatch({ owner, epoch: staleEpoch, records: [
      record({ messageId: 'stale-1', sender: owner }),
      record({ messageId: 'stale-2', sender: owner }),
    ] })
    assert.equal(result.committed, false, `${name}: wholly stale batch is not committed`)
    assert.equal(result.epoch, rotated.epoch, `${name}: canonical current epoch returned`)
    assert.deepEqual(result.outcomes.map(({ index, outcome }) => ({ index, outcome })), [{ index: 0, outcome: 'epochChanged' }, { index: 1, outcome: 'epochChanged' }], `${name}: ordered stale outcomes`)
    assert.deepEqual(await store.getUsage({ owner }), before, `${name}: quota and sequence unchanged`)
    assert.deepEqual(await countEffects(), effectsBefore, `${name}: no record/change/audit/idempotency effects`)
  }
})

test('M1 rereview .2.3.3.1: snapshot reads require owner and bind epoch/feed/filter/watermark', async (t) => {
  const { mem, sqlite, mysql } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  for (const [name, store] of Object.entries(stores)) {
    const owner = name === 'mysql' ? `02${'c1'.repeat(32)}` : OWNER
    if (name === 'mysql') await store.deleteAll({ owner }).catch(() => {})
    else await store.deleteAll({ owner }).catch(() => {})
    await seed(store, owner, ['bind-1', 'bind-2'])
    const snap = await store.createSnapshot({ owner, filter: { direction: 'outbound' } })
    assert.equal(snap.feed, SNAPSHOT_FEED)
    assert.ok(snap.filterHash.length === 64)
    const meta = await store.getSnapshot({ snapshotId: snap.snapshotId, owner })
    assert.equal(meta.epoch, snap.epoch)
    assert.equal(meta.feed, SNAPSHOT_FEED)
    assert.equal(meta.watermark, snap.watermark)
    // Correct expected bindings succeed.
    assert.ok(await store.getSnapshot({ snapshotId: snap.snapshotId, owner, expectedEpoch: snap.epoch, expectedFeed: 'snapshot', expectedFilter: { direction: 'outbound' }, expectedWatermark: snap.watermark }))
    assert.ok((await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner, expectedEpoch: snap.epoch, expectedFeed: 'snapshot', expectedFilter: { direction: 'outbound' }, expectedWatermark: snap.watermark })).items.length === 2)
    // Missing owner rejects before metadata (sync throw or async reject).
    await assert.rejects(async () => store.getSnapshot({ snapshotId: snap.snapshotId }), (e) => e?.code === 'ERR_INVALID_RECORD')
    await assert.rejects(async () => store.listSnapshotMembers({ snapshotId: snap.snapshotId }), (e) => e?.code === 'ERR_INVALID_RECORD')
    // Wrong owner rejects without metadata/membership.
    await assert.rejects(async () => store.getSnapshot({ snapshotId: snap.snapshotId, owner: OWNER_B }), (e) => e?.code === 'ERR_FORBIDDEN')
    await assert.rejects(async () => store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER_B }), (e) => e?.code === 'ERR_FORBIDDEN')
    // Wrong epoch rejects.
    await assert.rejects(async () => store.getSnapshot({ snapshotId: snap.snapshotId, owner, expectedEpoch: 'gen-9999' }), (e) => e?.code === 'ERR_EPOCH_CHANGED')
    await assert.rejects(async () => store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner, expectedEpoch: 'gen-9999' }), (e) => e?.code === 'ERR_EPOCH_CHANGED')
    // Wrong feed rejects (only 'snapshot' is valid; no .2.4 cursor/feed behavior).
    await assert.rejects(async () => store.getSnapshot({ snapshotId: snap.snapshotId, owner, expectedFeed: 'changes' }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    await assert.rejects(async () => store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner, expectedFeed: 'changes' }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    // Wrong filter rejects (canonical identity mismatch).
    await assert.rejects(async () => store.getSnapshot({ snapshotId: snap.snapshotId, owner, expectedFilter: { direction: 'inbound' } }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    await assert.rejects(async () => store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner, expectedFilter: { messageBox: 'other' } }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    // Wrong watermark rejects.
    await assert.rejects(async () => store.getSnapshot({ snapshotId: snap.snapshotId, owner, expectedWatermark: '999999' }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    // Unknown snapshotId with owner returns null (no leak, no throw).
    assert.equal(await store.getSnapshot({ snapshotId: 'snap_ffffffffffffffffffffffffffffffff', owner }), null)
    assert.equal(await store.listSnapshotMembers({ snapshotId: 'snap_ffffffffffffffffffffffffffffffff', owner }), null)
    await store.deleteAll({ owner })
  }
})

test('M1 rereview .2.3.3.1: cross-owner and cross-epoch negative tests', async (t) => {
  const { mem, sqlite, mysql } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  for (const [name, store] of Object.entries(stores)) {
    const ownerA = name === 'mysql' ? `02${'d1'.repeat(32)}` : OWNER
    const ownerB = name === 'mysql' ? `02${'d2'.repeat(32)}` : OWNER_B
    await store.deleteAll({ owner: ownerA }).catch(() => {})
    await store.deleteAll({ owner: ownerB }).catch(() => {})
    await seed(store, ownerA, ['cross-1'])
    const snap = await store.createSnapshot({ owner: ownerA })
    // Cross-owner: B cannot read A's snapshot.
    await assert.rejects(async () => store.getSnapshot({ snapshotId: snap.snapshotId, owner: ownerB }), (e) => e?.code === 'ERR_FORBIDDEN')
    await assert.rejects(async () => store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: ownerB }), (e) => e?.code === 'ERR_FORBIDDEN')
    // Cross-epoch: rotate A's epoch, then stale expectedEpoch rejects.
    const wiped = await store.deleteAll({ owner: ownerA })
    assert.notEqual(wiped.epoch, snap.epoch)
    // Old snapshot still bound to old epoch: asking with new epoch rejects.
    await assert.rejects(async () => store.getSnapshot({ snapshotId: snap.snapshotId, owner: ownerA, expectedEpoch: wiped.epoch }), (e) => e?.code === 'ERR_EPOCH_CHANGED')
    // Without expectedEpoch, old snapshot reports invalidated (no silent success).
    const meta = await store.getSnapshot({ snapshotId: snap.snapshotId, owner: ownerA })
    assert.equal(meta.status, 'invalidated')
    assert.deepEqual((await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: ownerA })).items, [])
    await store.deleteAll({ owner: ownerA }).catch(() => {})
    await store.deleteAll({ owner: ownerB }).catch(() => {})
  }
})

test('M1 rereview .2.3.3.1: participant filter has canonical identity and stable membership at W', async (t) => {
  const { mem, sqlite, mysql } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  for (const [name, store] of Object.entries(stores)) {
    const owner = name === 'mysql' ? `02${'e1'.repeat(32)}` : OWNER
    const peer = name === 'mysql' ? `03${'e2'.repeat(32)}` : PEER
    const other = name === 'mysql' ? `03${'e3'.repeat(32)}` : OTHER
    await store.deleteAll({ owner }).catch(() => {})
    const epoch = (await store.getUsage({ owner })).epoch
    // Outbound to peer, inbound from peer, outbound to other.
    await store.archiveBatch({
      owner,
      epoch,
      records: [
        { messageId: 'p-out-1', messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body: BODY },
        { messageId: 'p-in-1', messageBox: 'inbox', direction: 'inbound', sender: peer, recipient: owner, body: BODY },
        { messageId: 'p-out-other', messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: other, body: BODY },
      ],
    })
    const byPeer = await store.createSnapshot({ owner, filter: { participant: peer } })
    assert.equal(byPeer.memberCount, 2, `${name}: participant matches sender OR recipient`)
    assert.equal(byPeer.filterHash, snapshotFilterHash({ participant: peer }))
    const outboundPeer = await store.createSnapshot({ owner, filter: { direction: 'outbound', participant: peer } })
    assert.equal(outboundPeer.memberCount, 1)
    const byOther = await store.createSnapshot({ owner, filter: { participant: other } })
    assert.equal(byOther.memberCount, 1)
    // Canonical: different key order still hashes identically (sorted keys).
    assert.equal(snapshotFilterHash({ participant: peer, direction: 'outbound' }), snapshotFilterHash({ direction: 'outbound', participant: peer }))
    // Invalid participant rejects before capture.
    await assert.rejects(async () => store.createSnapshot({ owner, filter: { participant: 'not-a-key' } }), /participant/)
    await assert.rejects(async () => store.createSnapshot({ owner, filter: { unknown: 'x' } }), /unknown filter key/)
    // Stable at W: post-W write with same participant excluded; state frozen.
    const members = await store.listSnapshotMembers({ snapshotId: byPeer.snapshotId, owner })
    assert.equal(members.items.length, 2)
    assert.ok(members.items.every((i) => !('body' in i)), 'no ciphertext duplication')
    const usage = await store.getUsage({ owner })
    await store.archiveBatch({ owner, epoch: usage.epoch, records: [{ messageId: 'p-out-2', messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body: BODY }] })
    assert.equal((await store.listSnapshotMembers({ snapshotId: byPeer.snapshotId, owner })).items.length, 2, 'post-W participant write excluded')
    await store.patchState({ owner, recordKey: members.items[0].recordKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'binding-accept' })
    const frozen = (await store.listSnapshotMembers({ snapshotId: byPeer.snapshotId, owner })).items.find((i) => i.recordKey === members.items[0].recordKey)
    assert.equal(frozen.deliveryStateAtW, 'prepared', 'materialized participant state frozen at W')
    await store.deleteAll({ owner })
  }
})

test('M1 rereview .2.3.3.1: purge is total-work bounded with continuation and eventual completion', async (t) => {
  const { mem, sqlite, mysql } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  // Unique MySQL owner per run: MySQL persists across runs, and deleteAll leaves
  // invalidated rows until purge. Uniqueness keeps the 10-item accounting exact.
  const stamp = Date.now().toString(16).padStart(12, '0').slice(-12)
  for (const [name, store] of Object.entries(stores)) {
    const owner = name === 'mysql' ? `02${(stamp + 'f1'.repeat(32)).slice(0, 64)}` : OWNER
    await store.deleteAll({ owner }).catch(() => {})
    // Clean any pre-existing expired/invalidated work for this owner before seeding.
    try {
      await store.purgeExpiredSnapshots({ nowIso: '2999-01-01T00:00:00.000Z' })
    } catch {}
    await seed(store, owner, ['purge-1', 'purge-2', 'purge-3', 'purge-4', 'purge-5'])
    // Two snapshots covering the same 5 rows (10 items total).
    const s1 = await store.createSnapshot({ owner })
    const s2 = await store.createSnapshot({ owner, filter: { messageBox: 'inbox' } })
    assert.equal(s1.memberCount, 5)
    assert.equal(s2.memberCount, 5)
    // Small total budget: at most maxItems items and maxSnapshots rows per call.
    const first = await store.purgeExpiredSnapshots({ nowIso: '2999-01-01T00:00:00.000Z', batchSize: 2, maxItems: 3, maxSnapshots: 1 })
    assert.ok(first.purgedItems <= 3, `${name}: total items bounded (${first.purgedItems} <= 3)`)
    assert.ok(first.purgedSnapshots <= 1, `${name}: total snapshots bounded`)
    assert.ok(first.examinedSnapshots <= 1, `${name}: selected anchors bounded`)
    assert.equal(first.hasMore, true, 'continuation reported when work remains')
    // Repeat until complete: eventual completion across calls.
    let totalItems = first.purgedItems
    let totalSnaps = first.purgedSnapshots
    let guard = 0
    let cur = first
    while (cur.hasMore && guard < 10) {
      cur = await store.purgeExpiredSnapshots({ nowIso: '2999-01-01T00:00:00.000Z', batchSize: 2, maxItems: 3, maxSnapshots: 1 })
      assert.ok(cur.purgedItems <= 3, 'each call bounded')
      assert.ok(cur.purgedSnapshots <= 1, 'each call bounded')
      assert.ok(cur.examinedSnapshots <= 1, 'each call examines bounded anchors')
      totalItems += cur.purgedItems
      totalSnaps += cur.purgedSnapshots
      guard += 1
    }
    assert.equal(cur.hasMore, false, 'eventually completes')
    assert.equal(totalItems, 10, `${name}: all items purged across calls`)
    assert.equal(totalSnaps, 2, `${name}: both expired rows removed across calls`)
    assert.equal(await store.getSnapshot({ snapshotId: s1.snapshotId, owner }), null)
    assert.equal(await store.getSnapshot({ snapshotId: s2.snapshotId, owner }), null)
    // Documented defaults also bound work.
    assert.ok(SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL <= 5000 && SNAPSHOT_PURGE_MAX_SNAPSHOTS_PER_CALL <= 5000)
    await store.deleteAll({ owner }).catch(() => {})
  }
})

test('M1 memory purge traverses no more than maxSnapshots eligible anchors', async () => {
  const store = createMemoryStore()
  await seed(store, OWNER, ['instrumented-anchor-record'])
  const anchors = []
  for (let index = 0; index < 24; index += 1) anchors.push(await store.createSnapshot({ owner: OWNER, filter: index % 2 ? { messageBox: 'inbox' } : {} }))
  const snapshots = store._debug.snapshots
  const originalIterator = snapshots[Symbol.iterator].bind(snapshots)
  let traversed = 0
  snapshots[Symbol.iterator] = function * instrumentedIterator() {
    for (const entry of originalIterator()) {
      traversed += 1
      yield entry
    }
  }
  let totalItems = 0
  let totalSnapshots = 0
  let calls = 0
  let result
  do {
    traversed = 0
    result = store.purgeExpiredSnapshots({ nowIso: '2999-01-01T00:00:00.000Z', batchSize: 1, maxItems: 2, maxSnapshots: 3 })
    assert.ok(traversed <= 3, `actual traversal ${traversed} stays within maxSnapshots`)
    assert.equal(result.examinedSnapshots, traversed, 'reported examination matches actual target traversal')
    assert.ok(result.purgedItems <= 2, 'maxItems enforced')
    totalItems += result.purgedItems
    totalSnapshots += result.purgedSnapshots
    calls += 1
    assert.ok(calls < 30, 'purge makes progress')
  } while (result.hasMore)
  assert.equal(totalItems, 24)
  assert.equal(totalSnapshots, 24)
  assert.equal(store._debug.snapshots.size, 0)
  for (const anchor of anchors) assert.equal(store.getSnapshot({ snapshotId: anchor.snapshotId, owner: OWNER }), null)
})

test('M1 rereview .2.3.3.1: empty invalidated anchors do not defeat maxSnapshots selection', async (t) => {
  const { mem, sqlite, mysql, _mysqlKnex } = await makeStores(t)
  const stores = { mem, sqlite, ...(mysql ? { mysql } : {}) }
  for (const [name, store] of Object.entries(stores)) {
    const owner = name === 'mysql' ? `02${'d9'.repeat(32)}` : OWNER_B
    await store.deleteAll({ owner }).catch(() => {})
    const snapshots = []
    for (let index = 0; index < 8; index += 1) snapshots.push(await store.createSnapshot({ owner }))
    if (name === 'mem') {
      for (const snapshot of snapshots) store._debug.snapshots.get(snapshot.snapshotId).status = 'invalidated'
    } else if (name === 'sqlite') {
      store.db.prepare(`UPDATE history_snapshots SET status = 'invalidated' WHERE owner_identity_key = ?`).run(owner)
    } else {
      await _mysqlKnex.raw(`UPDATE history_snapshots SET status = 'invalidated' WHERE owner_identity_key = ?`, [owner])
    }
    const first = await store.purgeExpiredSnapshots({ nowIso: new Date().toISOString(), maxItems: 100, maxSnapshots: 2 })
    assert.equal(first.purgedItems, 0, `${name}: empty invalidated anchors have no membership work`)
    assert.equal(first.purgedSnapshots, 0, `${name}: unexpired invalidated anchors remain restart signals`)
    assert.ok(first.examinedSnapshots <= 2, `${name}: first selection is bounded`)
    assert.equal(first.hasMore, false, `${name}: empty invalidated anchors are not reported as endless work`)
    const second = await store.purgeExpiredSnapshots({ nowIso: new Date().toISOString(), maxItems: 100, maxSnapshots: 2 })
    assert.equal(second.examinedSnapshots, 0, `${name}: subsequent call does not re-examine empty anchors`)
    await store.deleteAll({ owner }).catch(() => {})
  }
})

test('M1 rereview .2.3.3.1: invalidated snapshots purge items but keep restart signal until expiry', async (t) => {
  const { mem, sqlite } = await makeStores(t)
  for (const [name, store] of Object.entries({ mem, sqlite })) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['inv-1', 'inv-2'])
    const snap = await store.createSnapshot({ owner: OWNER })
    const victim = (await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })).items[0].recordKey
    await store.deleteRecord({ owner: OWNER, recordKey: victim })
    // Invalidated snapshot reports status with no members, even with correct binding.
    const dead = await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })
    assert.equal(dead.status, 'invalidated')
    assert.deepEqual(dead.items, [])
    // Purge with current time (unexpired): items purged, row remains as restart signal.
    const purged = await store.purgeExpiredSnapshots({ nowIso: new Date().toISOString(), batchSize: 10, maxItems: 100, maxSnapshots: 100 })
    assert.ok(purged.purgedItems >= 1, `${name}: invalidated items purged`)
    const meta = await store.getSnapshot({ snapshotId: snap.snapshotId, owner: OWNER })
    assert.equal(meta.status, 'invalidated', 'invalidated row remains until expiry')
    // Far-future purge removes the expired row.
    const far = await store.purgeExpiredSnapshots({ nowIso: '2999-01-01T00:00:00.000Z' })
    assert.equal(far.hasMore, false)
    assert.equal(await store.getSnapshot({ snapshotId: snap.snapshotId, owner: OWNER }), null)
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 rereview .2.3.3.1: delete and delete-all still purge ciphertext and invalidate', async (t) => {
  const { mem, sqlite } = await makeStores(t)
  for (const store of [mem, sqlite]) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['del-1', 'del-2'])
    const snap = await store.createSnapshot({ owner: OWNER })
    const key = (await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })).items[0].recordKey
    const del = await store.deleteRecord({ owner: OWNER, recordKey: key })
    assert.equal(del.deleted, true)
    const rec = await store.getRecord({ owner: OWNER, recordKey: key })
    assert.equal(rec, null, 'ciphertext purged immediately')
    assert.equal((await store.getSnapshot({ snapshotId: snap.snapshotId, owner: OWNER })).status, 'invalidated')
    const wiped = await store.deleteAll({ owner: OWNER })
    assert.ok(typeof wiped.epoch === 'string' && wiped.epoch !== snap.epoch)
    // No cursor/feed behavior introduced: snapshot APIs expose no cursors.
    const fresh = await store.createSnapshot({ owner: OWNER })
    assert.ok(!('nextCursor' in fresh) && !('hasMore' in fresh), 'no .2.4 cursor/feed surface')
    await store.deleteAll({ owner: OWNER })
  }
})
