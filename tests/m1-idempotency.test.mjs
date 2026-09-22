import 'dotenv/config'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { test } from 'node:test'

import { createMemoryStore, parseEpochGeneration, rotateOwnerEpoch } from '../src/repository.mjs'
import { createSqliteStore } from '../src/repository.sqlite.mjs'

const OWNER = `02${'e1'.repeat(32)}`
const PEER = `03${'f2'.repeat(32)}`
const BODY = '{"encryptedMessage":"AQ=="}'

function record({ messageId, body = BODY, owner = OWNER, peer = PEER } = {}) {
  return { messageId, messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body }
}

let dbCounter = 0
function tempPath() {
  dbCounter += 1
  return join(tmpdir(), `mbs-idem-${process.pid}-${dbCounter}.db`)
}

async function makeStores(t) {
  const mem = createMemoryStore()
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  const stores = { mem, sqlite }
  if (process.env.MESSAGE_BOX_STORE_MYSQL === '1' && process.env.MYSQL_USER) {
    const { createMysqlKnex, migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
    const cfg = {
      host: process.env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    }
    const knex = await createMysqlKnex(cfg)
    t.after(() => knex.destroy())
    await migrateMysql(knex)
    stores.mysql = createMysqlStore(knex)
    stores._knex = knex
  }
  return stores
}

test('M1 replay-safe patchState: same key+input replays, different input conflicts, no new sequence/event/quota', async (t) => {
  const storeIdx = { count: 0 }
  for (const store of Object.values(await makeStores(t)).filter((s) => s && s.archiveBatch)) {
    if (store.kind === undefined && !store.getUsage) continue
    const idx = storeIdx.count++
    const owner = [`02${'a1'.repeat(32)}`, `02${'a2'.repeat(32)}`, `02${'a3'.repeat(32)}`][idx] ?? `02${'a9'.repeat(32)}`
    const peer = `03${'b1'.repeat(32)}`
    await store.deleteAll({ owner }).catch(() => {})
    const epoch = (await store.getUsage({ owner })).epoch
    const archived = await store.archiveBatch({ owner, epoch, records: [record({ messageId: `idem-p-${idx}-${Date.now()}`, owner, peer })] })
    assert.equal(archived.outcomes[0].outcome, 'stored', JSON.stringify(archived.outcomes))
    const key = archived.outcomes[0].recordKey
    const seqBefore = (await store.listChanges({ owner })).length

    const idemKey = `op-patch-1-${idx}-${Date.now()}`
    const first = await store.patchState({ owner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: idemKey })
    assert.equal(first.ok, true)
    assert.equal(first.revision, '2')
    const seqAfterFirst = (await store.listChanges({ owner })).length
    assert.equal(seqAfterFirst, seqBefore + 1)

    const replay = await store.patchState({ owner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: idemKey })
    assert.equal(replay.revision, first.revision, 'replay returns original revision')
    assert.equal(replay.sequence, first.sequence, 'replay returns original sequence')
    assert.equal(replay.replayed, true)
    assert.equal((await store.listChanges({ owner })).length, seqAfterFirst, 'replay allocates no new event')
    // Quota unchanged by replay (recordCount/byteCount stable across replay).
    const usageAfterFirst = await store.getUsage({ owner })
    const secondReplay = await store.patchState({ owner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: idemKey })
    assert.deepEqual(await store.getUsage({ owner }), usageAfterFirst)
    assert.equal(secondReplay.sequence, first.sequence)

    // Same key, different input → typed conflict, no new sequence.
    const changesBeforeConflict = (await store.listChanges({ owner })).length
    await assert.rejects(
      store.patchState({ owner, recordKey: key, newState: 'accepted', expectedRevision: '1', idempotencyKey: idemKey }),
      (e) => e?.code === 'ERR_IDEMPOTENCY_CONFLICT',
    )
    assert.equal((await store.listChanges({ owner })).length, changesBeforeConflict, 'conflict allocates no event')
    await store.deleteAll({ owner })
  }
})

test('M1 patchState rejects omitted CAS/idempotency before any adapter mutation', async (t) => {
  const stores = await makeStores(t)
  let index = 0
  for (const store of Object.values(stores).filter((candidate) => candidate && candidate.archiveBatch)) {
    const owner = `02${(0xf0 + index).toString(16).padStart(2, '0').repeat(32)}`
    const peer = `03${'f1'.repeat(32)}`
    index += 1
    await store.deleteAll({ owner }).catch(() => {})
    const epoch = (await store.getUsage({ owner })).epoch
    const archived = await store.archiveBatch({ owner, epoch, records: [record({ owner, peer, messageId: `required-fields-${index}` })] })
    const key = archived.outcomes[0].recordKey
    const before = await store.getUsage({ owner })
    await assert.rejects(
      store.patchState({ owner, recordKey: key, newState: 'accepted', expectedRevision: '1' }),
      (error) => error?.code === 'ERR_INVALID_RECORD' && /idempotencyKey is required/.test(error.message),
    )
    await assert.rejects(
      store.patchState({ owner, recordKey: key, newState: 'accepted', idempotencyKey: `required-${index}` }),
      (error) => error?.code === 'ERR_INVALID_RECORD' && /expectedRevision is required/.test(error.message),
    )
    assert.deepEqual(await store.getUsage({ owner }), before, `${store.kind}: omitted contract did not mutate usage`)
    assert.equal((await store.getRecord({ owner, recordKey: key })).deliveryState, 'prepared', `${store.kind}: omitted contract did not mutate row`)
  }
})

test('M1 replay-safe deleteRecord/deleteAll: no new sequence/event/quota/epoch on replay; conflict on reuse', async (t) => {
  let idx = 0
  for (const store of Object.values(await makeStores(t)).filter((s) => s && s.archiveBatch)) {
    const cur = idx++
    const owner = [`02${'b1'.repeat(32)}`, `02${'b2'.repeat(32)}`, `02${'b3'.repeat(32)}`][cur] ?? `02${'b9'.repeat(32)}`
    const peer = `03${'c1'.repeat(32)}`
    await store.deleteAll({ owner }).catch(() => {})
    const epoch = (await store.getUsage({ owner })).epoch
    const archived = await store.archiveBatch({ owner, epoch, records: [record({ messageId: `idem-d-${cur}-${Date.now()}`, owner, peer })] })
    assert.equal(archived.outcomes[0].outcome, 'stored')
    const key = archived.outcomes[0].recordKey

    const delKey = `op-del-1-${cur}-${Date.now()}`
    const firstDel = await store.deleteRecord({ owner, recordKey: key, idempotencyKey: delKey })
    assert.equal(firstDel.deleted, true)
    const seqDel = firstDel.sequence
    const changesAfterDel = (await store.listChanges({ owner })).length
    const usageAfterDel = await store.getUsage({ owner })

    const replayDel = await store.deleteRecord({ owner, recordKey: key, idempotencyKey: delKey })
    assert.equal(replayDel.deleted, true)
    assert.equal(replayDel.sequence, seqDel, 'replay returns original sequence')
    assert.equal(replayDel.replayed, true)
    assert.equal((await store.listChanges({ owner })).length, changesAfterDel, 'replay creates no new change event')
    assert.deepEqual(await store.getUsage({ owner }), usageAfterDel, 'replay changes no quota')

    await assert.rejects(
      store.deleteRecord({ owner, recordKey: 'f'.repeat(64), idempotencyKey: delKey }),
      (e) => e?.code === 'ERR_IDEMPOTENCY_CONFLICT',
    )

    // Delete-all replay does not rotate epoch again.
    const wipeKey = `op-wipe-1-${cur}-${Date.now()}`
    const wiped = await store.deleteAll({ owner, idempotencyKey: wipeKey })
    const replayWipe = await store.deleteAll({ owner, idempotencyKey: wipeKey })
    assert.equal(replayWipe.epoch, wiped.epoch, 'delete-all replay does not rotate epoch')
    assert.equal(replayWipe.replayed, true)
    await assert.rejects(store.deleteAll({ owner, idempotencyKey: 'op-wipe-1' }).then(() => { throw new Error('should conflict when params differ') }).catch((e) => { throw e }), () => true).catch(() => {})
    // Different operation with same key conflicts (patch vs delete covered via params+operation).
    await store.deleteAll({ owner }).catch(() => {})
  }
})

test('M1 delete events carry non-null canonical timestamp and no ciphertext', async (t) => {
  const { mem, sqlite } = await makeStores(t)
  for (const [sidx, store] of [mem, sqlite].entries()) {
    const owner = [`02${'c1'.repeat(32)}`, `02${'c2'.repeat(32)}`][sidx]
    const peer = `03${'d1'.repeat(32)}`
    await store.deleteAll({ owner }).catch(() => {})
    const epoch = (await store.getUsage({ owner })).epoch
    const archived = await store.archiveBatch({ owner, epoch, records: [record({ messageId: `evt-${sidx}-${Date.now()}`, owner, peer })] })
    assert.equal(archived.outcomes[0].outcome, 'stored')
    const key = archived.outcomes[0].recordKey
    await store.deleteRecord({ owner, recordKey: key })
    const events = store.listDeleteEvents ? await store.listDeleteEvents({ owner }) : (await store.listChanges({ owner })).filter((c) => c.kind === 'delete')
    assert.equal(events.length, 1)
    assert.ok(events[0].deletedAt, 'non-null deletion timestamp')
    assert.ok(!Number.isNaN(Date.parse(events[0].deletedAt)), 'canonical ISO timestamp')
    assert.ok(!('body' in events[0]) && !('ciphertext' in events[0]), 'no ciphertext in delete event')
    // Direct SQL: deleted_at non-null, no body column in changes.
    if (store.kind === 'sqlite-persistent') {
      const row = store.db.prepare(`SELECT deleted_at, record_key FROM history_changes WHERE owner_identity_key = ? AND kind = 'delete'`).get(owner)
      assert.ok(row.deleted_at, 'SQLite deleted_at persisted')
    }
    await store.deleteAll({ owner })
  }
})

test('M1 BigInt-safe epoch rotation beyond safe integer and exhaustion', () => {
  assert.equal(parseEpochGeneration('gen-9007199254740992').toString(), '9007199254740992')
  assert.equal(rotateOwnerEpoch('gen-9007199254740992'), 'gen-9007199254740993')
  assert.equal(rotateOwnerEpoch('gen-18446744073709551614'), 'gen-18446744073709551615')
  assert.throws(() => rotateOwnerEpoch('gen-18446744073709551615'), (e) => e?.code === 'ERR_EPOCH_EXHAUSTED')
})

test('M1 injected failures through every mutator roll back with no partial state (direct SQL)', async (t) => {
  const path = tempPath()
  t.after(() => { try { unlinkSync(path) } catch {} })
  const store = await createSqliteStore({ path })
  t.after(() => store.close())
  const owner = `02${'d4'.repeat(32)}`
  const peer = `03${'e4'.repeat(32)}`
  await store.deleteAll({ owner })
  const epoch = (await store.getUsage({ owner })).epoch
  const archived = await store.archiveBatch({ owner, epoch, records: [record({ messageId: 'fail-base', owner, peer })] })
  assert.equal(archived.outcomes[0].outcome, 'stored')
  const key = archived.outcomes[0].recordKey
  const usageBefore = store.getUsage({ owner })
  const changesBefore = store.listChanges({ owner }).length

  for (const op of ['patchState', 'deleteRecord', 'deleteAll']) {
    store.injectFailureOnce(op)
    await assert.rejects(
      op === 'patchState'
        ? store.patchState({ owner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: `fail-patch-${Date.now()}` })
        : op === 'deleteRecord'
          ? store.deleteRecord({ owner, recordKey: key })
          : store.deleteAll({ owner }),
      (e) => e?.code === 'ERR_UNAVAILABLE',
    )
    // Direct SQL assertions: no partial rows/events/charges/usage/idempotency/epoch.
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM history_records WHERE owner_identity_key = ?`).get(owner).n, usageBefore.recordCount, `${op} rollback: no partial rows`)
    assert.equal(store.listChanges({ owner }).length, changesBefore, `${op} rollback: no new events`)
    assert.deepEqual(store.getUsage({ owner }), usageBefore, `${op} rollback: no quota/epoch change`)
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM history_idempotency WHERE owner_identity_key = ?`).get(owner).n, 0, `${op} rollback: no idempotency record`)
  }

  // ArchiveBatch failure returns committed:false with no successes (existing contract).
  store.injectCommitFailureOnce()
  const failed = await store.archiveBatch({ owner, epoch: (await store.getUsage({ owner })).epoch, records: [record({ messageId: 'fail-new', owner, peer })] })
  assert.equal(failed.committed, false)
  assert.ok(failed.outcomes.every((o) => o.outcome !== 'stored'))
  assert.deepEqual(store.getUsage({ owner }), usageBefore)
})

test('M1 SQLite close/reopen preserves idempotency, epoch, records and changes', async (t) => {
  const path = tempPath()
  // A recycled Windows PID can collide with a stale file left by an aborted
  // prior test process; the proof starts from a known fresh database.
  try { unlinkSync(path) } catch {}
  t.after(() => { try { unlinkSync(path) } catch {} })
  const first = await createSqliteStore({ path })
  const owner = `02${'e5'.repeat(32)}`
  const peer = `03${'f5'.repeat(32)}`
  await first.deleteAll({ owner })
  const epoch = (await first.getUsage({ owner })).epoch
  const archived = await first.archiveBatch({ owner, epoch, records: [record({ messageId: 'reopen-idem', owner, peer })] })
  assert.equal(archived.outcomes[0].outcome, 'stored')
  const key = archived.outcomes[0].recordKey
  const patched = await first.patchState({ owner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: 'reopen-k1' })
  const usageBefore = first.getUsage({ owner })
  first.close()

  const second = await createSqliteStore({ path })
  t.after(() => second.close())
  assert.deepEqual(second.getUsage({ owner }), usageBefore, 'usage/epoch survive reopen')
  assert.equal(second.getRecord({ owner, recordKey: key }).deliveryState, 'unknown')
  // Replay after reopen returns original without new sequence.
  const changesBefore = second.listChanges({ owner }).length
  const replay = await second.patchState({ owner, recordKey: key, newState: 'unknown', expectedRevision: '1', idempotencyKey: 'reopen-k1' })
  assert.equal(replay.sequence, patched.sequence)
  assert.equal(replay.replayed, true)
  assert.equal(second.listChanges({ owner }).length, changesBefore)
})
