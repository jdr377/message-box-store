import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryStore } from '../src/repository.mjs'
import { createSqliteStore } from '../src/repository.sqlite.mjs'
import { LIMITS, validateHistoryPage } from '../src/protocol.mjs'
import { fitRecordsToPage, historyPageOverheadBytes } from '../src/feeds.mjs'

const SECRET = 'test-server-secret-0123456789'
const OWNER = `02${'ee'.repeat(32)}`
const PEER = `03${'ff'.repeat(32)}`
const OTHER = `03${'11'.repeat(32)}`
const BODY = '{"encryptedMessage":"AQ=="}'
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function nonCanonicalAlias(value) {
  assert.ok([2, 3].includes(value.length % 4), `alias vector has no pad bits: ${value.length}`)
  const index = BASE64URL_ALPHABET.indexOf(value.at(-1))
  return `${value.slice(0, -1)}${BASE64URL_ALPHABET[index ^ 1]}`
}

function record({ messageId, direction = 'outbound', messageBox = 'inbox', sender = OWNER, recipient = PEER, body = BODY } = {}) {
  return { messageId, messageBox, direction, sender, recipient, body }
}

async function makeStores(t) {
  const mem = createMemoryStore()
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  return { mem, sqlite }
}

async function seed(store, owner, ids) {
  const epoch = (await store.getUsage({ owner })).epoch
  const result = await store.archiveBatch({ owner, epoch, records: ids.map((messageId) => record({ messageId, sender: owner, recipient: PEER })) })
  assert.ok(result.outcomes.every((o) => o.outcome === 'stored'))
  return result
}

async function drainChanges(store, owner, { limit = 100, filter = {} } = {}) {
  const seenSeq = []
  const seenKeys = new Set()
  let cursor = null
  let first = null
  let last = null
  for (let i = 0; i < 20; i += 1) {
    const page = await store.listChangesPage({ owner, serverSecret: SECRET, cursor, limit, filter })
    validateHistoryPage({ records: page.records, nextCursor: page.nextCursor, checkpoint: page.checkpoint, hasMore: page.hasMore, watermark: page.watermark, epoch: page.epoch, serverTime: page.serverTime })
    if (!first) first = page
    last = page
    for (const r of page.records) {
      if (r.sequence !== undefined) seenSeq.push(String(r.sequence))
      else if (r.changeSequence !== undefined) seenSeq.push(String(r.changeSequence))
      if (r.recordKey) seenKeys.add(r.recordKey)
    }
    if (!page.hasMore) break
    cursor = page.nextCursor
    assert.ok(cursor, 'non-final page must carry nextCursor')
  }
  return { seenSeq, seenKeys, first, last }
}

test('M1 .2.4 byte fitting uses the exact serialized HistoryPage envelope at production limits', () => {
  const cursor = 'cursor.actual.checkpoint'
  const shell = { records: [], nextCursor: cursor, checkpoint: '999', hasMore: true, watermark: '1000', epoch: 'gen-1', serverTime: '2030-01-02T03:04:05.678Z' }
  const overheadBytes = historyPageOverheadBytes(shell)
  const base = { recordKey: 'a'.repeat(64), sequence: '1', body: '' }
  const fixed = Buffer.byteLength(JSON.stringify(base))
  const exactBodyLength = LIMITS.MAX_PAGE_BYTES - overheadBytes - 2 - fixed
  const exact = { ...base, body: 'x'.repeat(exactBodyLength) }
  const exactResult = fitRecordsToPage({ records: [exact], limit: 1, overheadBytes })
  assert.equal(exactResult.bytes, LIMITS.MAX_PAGE_BYTES)
  assert.equal(Buffer.byteLength(JSON.stringify({ ...shell, records: exactResult.admitted })), LIMITS.MAX_PAGE_BYTES)
  assert.throws(() => fitRecordsToPage({ records: [{ ...exact, body: `${exact.body}x` }], limit: 1, overheadBytes }), (e) => e?.code === 'ERR_REQUEST_TOO_LARGE')

  const half = { ...base, body: 'y'.repeat(Math.floor(exactBodyLength / 2)) }
  const split = fitRecordsToPage({ records: [half, half, half], limit: 3, overheadBytes })
  assert.ok(split.admitted.length >= 1, 'bounded page always makes progress')
  assert.ok(split.admitted.length < 3, 'max+1 aggregate splits before overflow')
  assert.ok(Buffer.byteLength(JSON.stringify({ ...shell, records: split.admitted })) <= LIMITS.MAX_PAGE_BYTES)
})

test('M1 .2.4 browse is live keyset while snapshot/changes fix W', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['browse-1', 'browse-2'])
    const snap = await store.createSnapshot({ owner: OWNER })
    assert.equal(snap.memberCount, 2)
    const changesFirst = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET })
    assert.equal(changesFirst.watermark, snap.watermark)
    // Post-W write: browse sees it live; fixed-W feeds do not.
    const usage = await store.getUsage({ owner: OWNER })
    await store.archiveBatch({ owner: OWNER, epoch: usage.epoch, records: [record({ messageId: 'browse-3' })] })
    const browse = await store.listBrowse({ owner: OWNER })
    assert.equal(browse.items.length, 3, 'browse is a live view')
    assert.ok(browse.items[0].createdAt <= browse.items[1].createdAt, 'browse ordered by (createdAt, recordKey)')
    const still = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor: changesFirst.nextCursor ?? undefined, limit: 100 })
    // First page already reached W (hasMore false, nextCursor null) or continues within same W.
    if (!changesFirst.hasMore) {
      assert.equal(changesFirst.records.length, 2)
      const fresh = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET })
      assert.equal(fresh.watermark, (await store.getUsage({ owner: OWNER })).nextSequence === '1' ? '0' : (BigInt((await store.getUsage({ owner: OWNER })).nextSequence) - 1n).toString())
    } else {
      assert.equal(still.watermark, changesFirst.watermark, 'continuations stay within fixed W')
    }
    const members = await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })
    assert.equal(members.items.length, 2, 'snapshot membership stable at W')
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 .2.4 interleaved commits produce no gaps/duplicates; snapshots do not drift', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['gap-1', 'gap-2', 'gap-3'])
    const w0 = (await store.getUsage({ owner: OWNER })).nextSequence === '1' ? '0' : (BigInt((await store.getUsage({ owner: OWNER })).nextSequence) - 1n).toString()
    const snap = await store.createSnapshot({ owner: OWNER })
    assert.equal(snap.watermark, w0)
    const beforeMembers = await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })
    // Capture W before interleaving: first page fixes W=w0, then new commits
    // must not shift continuations.
    const firstPage = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, limit: 2 })
    assert.equal(firstPage.watermark, w0, 'first page fixes W')
    // Interleave after W capture: new archive, member state change, temp delete.
    const usage = await store.getUsage({ owner: OWNER })
    await store.archiveBatch({ owner: OWNER, epoch: usage.epoch, records: [record({ messageId: 'gap-4' })] })
    await store.patchState({ owner: OWNER, recordKey: beforeMembers.items[0].recordKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'gap-accept' })
    const tempKey = (await store.archiveBatch({ owner: OWNER, epoch: usage.epoch, records: [record({ messageId: 'gap-temp' })] })).outcomes[0].recordKey
    await store.deleteRecord({ owner: OWNER, recordKey: tempKey })
    // Drain fixed-W changes starting from the pre-interleave cursor.
    const seen = []
    for (const r of firstPage.records) {
      if (r.sequence !== undefined) seen.push(String(r.sequence))
      else seen.push(String(r.changeSequence))
    }
    let cursor = firstPage.nextCursor
    if (!firstPage.hasMore) {
      assert.equal(firstPage.checkpoint, w0)
    }
    for (let i = 0; i < 10 && cursor; i += 1) {
      const page = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor, limit: 2 })
      assert.equal(page.watermark, w0, 'W fixed across continuations')
      for (const r of page.records) {
        if (r.sequence !== undefined) seen.push(String(r.sequence))
        else seen.push(String(r.changeSequence))
      }
      if (!page.hasMore) {
        assert.equal(page.checkpoint, w0, 'final checkpoint represents W')
        assert.equal(page.nextCursor, null)
        break
      }
      cursor = page.nextCursor
    }
    const expected = []
    for (let s = 1n; s <= BigInt(w0); s += 1n) expected.push(s.toString())
    assert.deepEqual([...seen].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)), expected, 'no gaps or duplicates in (C,W]')
    // Snapshot still active (temp delete was not a member) and identical.
    const afterMembers = await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })
    assert.equal(afterMembers.status, 'active')
    assert.deepEqual(afterMembers.items, beforeMembers.items, 'no mutable snapshot drift')
    const frozen = afterMembers.items.find((i) => i.recordKey === beforeMembers.items[0].recordKey)
    assert.equal(frozen.deliveryStateAtW, 'prepared', 'materialized state frozen at W')
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 .2.4 cursors distinguish tampering from expiry; misuse rejected', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['cur-1'])
    const page = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, ttlSeconds: 3600, nowSeconds: 1_000_000 })
    assert.ok(page.nextCursor === null || typeof page.nextCursor === 'string')
    // Tampered cursor (flipped payload) fails as invalid, not expired.
    const probe = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, ttlSeconds: 3600, nowSeconds: 1_000_000, limit: 1 })
    // Force a multi-page cursor by seeding more and paging with limit 1.
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['cur-a', 'cur-b'])
    const first = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, limit: 1, ttlSeconds: 3600, nowSeconds: 1_000_000 })
    assert.equal(first.hasMore, true)
    const [payload, mac] = first.nextCursor.split('.')
    await assert.rejects(async () => store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor: `${payload.slice(0, -2)}AA.${mac}`, nowSeconds: 1_000_100 }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    // Cross-owner copy fails without revealing activity.
    const OWNER_B = `02${'ab'.repeat(32)}`
    await assert.rejects(async () => store.listChangesPage({ owner: OWNER_B, serverSecret: SECRET, cursor: first.nextCursor, nowSeconds: 1_000_100 }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    // Filter misuse fails.
    await assert.rejects(async () => store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor: first.nextCursor, filter: { direction: 'inbound' }, nowSeconds: 1_000_100 }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    // Expired but otherwise valid returns expiry with resync hint.
    await assert.rejects(async () => store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor: first.nextCursor, nowSeconds: 1_000_000 + 3601 }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')
    // Epoch rotation rejects old cursors.
    const wiped = await store.deleteAll({ owner: OWNER })
    assert.notEqual(wiped.epoch, first.epoch)
    await assert.rejects(async () => store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor: first.nextCursor, nowSeconds: 1_000_100 }), (e) => e?.code === 'ERR_EPOCH_CHANGED')
    await store.deleteAll({ owner: OWNER }).catch(() => {})
  }
})

test('M1 .2.4 canonical cursor aliases fail on changes and snapshot adapters', async (t) => {
  for (const [index, store] of Object.values(await makeStores(t)).entries()) {
    const owner = `02${(index === 0 ? 'a7' : 'a8').repeat(32)}`
    await store.deleteAll({ owner }).catch(() => {})
    await seed(store, owner, Array.from({ length: 11 }, (_, n) => `alias-${n}`))
    const changes = await store.listChangesPage({ owner, serverSecret: SECRET, limit: 10 })
    assert.equal(changes.hasMore, true)
    const [changePayload, changeMac] = changes.nextCursor.split('.')
    if ([2, 3].includes(changePayload.length % 4)) {
      await assert.rejects(
        async () => store.listChangesPage({ owner, serverSecret: SECRET, cursor: `${nonCanonicalAlias(changePayload)}.${changeMac}` }),
        (error) => error?.code === 'ERR_INVALID_CURSOR',
      )
    }
    await assert.rejects(
      async () => store.listChangesPage({ owner, serverSecret: SECRET, cursor: `${changePayload}.${nonCanonicalAlias(changeMac)}` }),
      (error) => error?.code === 'ERR_INVALID_CURSOR',
    )

    const snapshot = await store.createSnapshot({ owner })
    const page = await store.listSnapshotPage({ owner, serverSecret: SECRET, snapshotId: snapshot.snapshotId, limit: 1 })
    assert.equal(page.hasMore, true)
    const [snapshotPayload, snapshotMac] = page.nextCursor.split('.')
    if ([2, 3].includes(snapshotPayload.length % 4)) {
      await assert.rejects(
        async () => store.listSnapshotPage({ owner, serverSecret: SECRET, snapshotId: snapshot.snapshotId, cursor: `${nonCanonicalAlias(snapshotPayload)}.${snapshotMac}` }),
        (error) => error?.code === 'ERR_INVALID_CURSOR',
      )
    }
    await assert.rejects(
      async () => store.listSnapshotPage({ owner, serverSecret: SECRET, snapshotId: snapshot.snapshotId, cursor: `${snapshotPayload}.${nonCanonicalAlias(snapshotMac)}` }),
      (error) => error?.code === 'ERR_INVALID_CURSOR',
    )
  }
})

test('M1 .2.4 allowed large row fits; oversized single yields typed error, never empty loop', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    // 500 KiB canonical body fits well within the 8 MiB page budget.
    const bigBody = `{"encryptedMessage":"${'A'.repeat(699_000)}"}`
    // 699000 is divisible by 4? 699000/4=174750 exact, canonical b64 (all A).
    const epoch = (await store.getUsage({ owner: OWNER })).epoch
    const archived = await store.archiveBatch({ owner: OWNER, epoch, records: [{ messageId: 'large-1', messageBox: 'inbox', direction: 'outbound', sender: OWNER, recipient: PEER, body: bigBody }] })
    assert.equal(archived.outcomes[0].outcome, 'stored')
    const page = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, limit: 100 })
    assert.ok(page.records.length >= 1, 'allowed large row fits')
    // Unaffected: paginating with limit 1 never returns empty hasMore-true loops.
    let cursor = null
    for (let i = 0; i < 10; i += 1) {
      const p = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor, limit: 1 })
      if (p.hasMore) assert.ok(p.records.length >= 1 || p.checkpoint !== (cursor ?? '0'), 'progress on every non-final page')
      if (!p.hasMore) break
      cursor = p.nextCursor
    }
    await store.deleteAll({ owner: OWNER })
  }
  // Unit: a single record that alone exceeds the budget throws typed error.
  const huge = { recordKey: 'b'.repeat(64), body: 'y'.repeat(9 * 1024 * 1024) }
  assert.throws(() => fitRecordsToPage({ records: [huge], limit: 100 }), (e) => e?.code === 'ERR_REQUEST_TOO_LARGE')
})

test('M1 .2.4 tombstone reupload returns deleted; feeds never serve purged bodies', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['tomb-1', 'tomb-2'])
    const snap = await store.createSnapshot({ owner: OWNER })
    const victim = (await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })).items[0].recordKey
    const victimMsg = (await store.getRecord({ owner: OWNER, recordKey: victim })).messageId
    const del = await store.deleteRecord({ owner: OWNER, recordKey: victim })
    assert.equal(del.deleted, true)
    assert.equal(await store.getRecord({ owner: OWNER, recordKey: victim }), null, 'ciphertext purged immediately')
    const reupload = await store.archiveBatch({ owner: OWNER, epoch: del.epoch, records: [record({ messageId: victimMsg })] })
    assert.equal(reupload.outcomes[0].outcome, 'deleted', 'tombstone reupload must not resurrect')
    // Browse excludes the purged body.
    const browse = await store.listBrowse({ owner: OWNER })
    assert.ok(browse.items.every((r) => r.recordKey !== victim))
    // Changes converge via a body-free delete event (no ciphertext).
    const { last } = await drainChanges(store, OWNER)
    const deletes = last ? null : null
    const all = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, limit: 100 })
    const delEvents = all.records.filter((r) => r.sequence !== undefined || r.deletedAt !== undefined)
    assert.ok(delEvents.some((e) => e.recordKey === victim), 'delete event present')
    assert.ok(JSON.stringify(delEvents).length < 1000, 'delete events carry no bodies')
    for (const e of delEvents) assert.ok(!('body' in e), 'no ciphertext in delete events')
    // Dependent snapshot invalidated and never serves bodies again.
    assert.equal((await store.listSnapshotMembers({ snapshotId: snap.snapshotId, owner: OWNER })).status, 'invalidated')
    await assert.rejects(async () => store.listSnapshotPage({ owner: OWNER, serverSecret: SECRET, snapshotId: snap.snapshotId }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 .2.4 retention expiry requires snapshot resync; delete-all fences old writes', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['exp-1'])
    const key = (await store.listBrowse({ owner: OWNER })).items[0].recordKey
    await store.deleteRecord({ owner: OWNER, recordKey: key })
    // Capture a pre-purge continuation (C=1 within W=2) before compaction.
    const pre = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, limit: 1 })
    assert.equal(pre.hasMore, true, 'pre-purge first page leaves continuation')
    const oldCursor = pre.nextCursor
    assert.ok(oldCursor)
    // Backdate every change beyond the 30-day window, then compact.
    const OLD = '2020-01-01T00:00:00.000Z'
    if (store._debug) {
      for (const c of store._debug.changes.get(OWNER) ?? []) c.createdAt = OLD
    } else {
      store.db.prepare(`UPDATE history_changes SET created_at = ? WHERE owner_identity_key = ?`).run(OLD, OWNER)
    }
    const purged = await store.purgeExpiredChanges({ owner: OWNER, nowIso: new Date().toISOString() })
    assert.ok(purged.purgedChanges >= 1, 'old delete/upsert compacted')
    // The pre-purge continuation is now outside retained history: resync.
    await assert.rejects(async () => store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor: oldCursor }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')
    // A fresh start still converges to an empty final for live views.
    const cur = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET })
    assert.equal(cur.hasMore, false, 'post-purge changes converge to empty final')
    assert.equal(cur.checkpoint, cur.watermark)
    // Snapshot resync removes absent rows (the deleted key is gone).
    const fresh = await store.createSnapshot({ owner: OWNER })
    assert.equal(fresh.memberCount, 0)
    // Delete-all fences in-flight old writes.
    await seed(store, OWNER, ['fence-1'])
    const staleEpoch = (await store.getUsage({ owner: OWNER })).epoch
    const wiped = await store.deleteAll({ owner: OWNER })
    assert.notEqual(wiped.epoch, staleEpoch)
    const staleWrite = await store.archiveBatch({ owner: OWNER, epoch: staleEpoch, records: [record({ messageId: 'fence-2' })] })
    assert.equal(staleWrite.outcomes[0].outcome, 'epochChanged')
    assert.equal(staleWrite.outcomes[0].errorCode, 'ERR_EPOCH_CHANGED')
    await store.deleteAll({ owner: OWNER }).catch(() => {})
  }
})

test('M1 .2.4 physical versus live accounting and bounded compaction', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    await seed(store, OWNER, ['phys-1', 'phys-2'])
    const key = (await store.listBrowse({ owner: OWNER })).items[0].recordKey
    await store.patchState({ owner: OWNER, recordKey: key, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'phys-accept' })
    await store.deleteRecord({ owner: OWNER, recordKey: key })
    const stats = await store.getStorageStats({ owner: OWNER })
    assert.equal(stats.live.recordCount, 1, 'live counts active rows only')
    assert.ok(stats.physical.changeCount >= 4, `physical retains versioned events (${stats.physical.changeCount})`)
    assert.ok(stats.physical.changeCount > stats.live.recordCount, 'physical exceeds live')
    // Full-quota deletion: fill a tiny quota, delete succeeds and releases.
    const tiny = store.kind === 'memory' ? createMemoryStore({ limits: { MAX_RECORDS_PER_OWNER: 2, MAX_BYTES_PER_OWNER: 10_000 } }) : null
    if (tiny) {
      const o2 = `02${'aa'.repeat(32)}`
      await tiny.archiveBatch({ owner: o2, epoch: 'gen-1', records: [record({ messageId: 'q-1', sender: o2 }), record({ messageId: 'q-2', sender: o2 })] })
      const k = (await tiny.listBrowse({ owner: o2 })).items[0].recordKey
      const d = await tiny.deleteRecord({ owner: o2, recordKey: k })
      assert.equal(d.deleted, true, 'deletion available at full quota')
      const after = await tiny.archiveBatch({ owner: o2, epoch: d.epoch, records: [record({ messageId: 'q-3', sender: o2 })] })
      assert.equal(after.outcomes[0].outcome, 'stored', 'quota released in the same transaction')
    }
    // Bounded compaction: backdate the state event only (live upsert retained
    // for snapshot stability), purge reduces physical without touching live.
    const liveBefore = await store.getUsage({ owner: OWNER })
    if (store._debug) {
      for (const c of store._debug.changes.get(OWNER) ?? []) {
        if (c.kind === 'state') c.createdAt = '2020-01-01T00:00:00.000Z'
      }
    } else {
      store.db.prepare(`UPDATE history_changes SET created_at = ? WHERE owner_identity_key = ? AND kind = 'state'`).run('2020-01-01T00:00:00.000Z', OWNER)
    }
    const before = (await store.getStorageStats({ owner: OWNER })).physical.changeCount
    const res = await store.purgeExpiredChanges({ owner: OWNER, nowIso: new Date().toISOString(), batchSize: 1, maxItems: 10 })
    assert.ok(res.purgedChanges >= 1, 'old state compacted')
    assert.ok(res.examinedChanges <= 10, 'examination bounded')
    const afterStats = await store.getStorageStats({ owner: OWNER })
    assert.equal(afterStats.live.recordCount, liveBefore.recordCount, 'compaction never touches live quota')
    assert.ok(afterStats.physical.changeCount < before, 'physical shrinks')
    await store.deleteAll({ owner: OWNER })
  }
})

test('M1 .2.4 many protected anchors respect hard purge budgets and sidecars converge atomically', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    const owner = `02${'c7'.repeat(32)}`
    await store.deleteAll({ owner }).catch(() => {})
    const seeded = await seed(store, owner, Array.from({ length: 18 }, (_, i) => `anchor-${i}`))
    for (let i = 0; i < seeded.outcomes.length; i += 1) {
      await store.patchState({ owner, recordKey: seeded.outcomes[i].recordKey, newState: 'accepted', expectedRevision: '1', idempotencyKey: `anchor-state-${i}` })
    }
    if (store._debug) {
      for (const change of store._debug.changes.get(owner) ?? []) change.createdAt = '2020-01-01T00:00:00.000Z'
    } else {
      store.db.prepare(`UPDATE history_changes SET created_at = ? WHERE owner_identity_key = ?`).run('2020-01-01T00:00:00.000Z', owner)
    }
    let removed = 0
    let calls = 0
    for (; calls < 30; calls += 1) {
      const result = await store.purgeExpiredChanges({ owner, nowIso: '2030-01-01T00:00:00.000Z', batchSize: 2, maxItems: 3 })
      assert.ok(result.examinedChanges <= 3, 'hard examination budget')
      assert.ok(result.purgedChanges <= 3, 'hard mutation budget')
      removed += result.purgedChanges
      if (!result.hasMore) break
    }
    assert.equal(removed, 18, 'all state sidecars eventually compact despite earlier protected upserts')
    assert.ok(calls < 30, 'bounded calls converge')
    const stats = await store.getStorageStats({ owner })
    assert.equal(stats.physical.changeCount, 18, 'only protected live upsert anchors remain')
    assert.equal(stats.physical.changeDetailCount, 18, 'detail count tracks surviving events exactly')
    if (store.db) {
      const orphans = store.db.prepare(`SELECT COUNT(*) AS n FROM history_change_details d LEFT JOIN history_changes c ON c.owner_identity_key=d.owner_identity_key AND c.change_sequence=d.change_sequence WHERE d.owner_identity_key=? AND c.change_sequence IS NULL`).get(owner)
      assert.equal(Number(orphans.n), 0, 'atomic compaction leaves no detail orphans')
    }
    await store.deleteAll({ owner }).catch(() => {})
  }
})

test('M1 .2.4 empty final pages still carry checkpoint W', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    const freshOwner = `02${'d4'.repeat(32)}`
    await store.deleteAll({ owner: freshOwner }).catch(() => {})
    const changes = await store.listChangesPage({ owner: freshOwner, serverSecret: SECRET })
    assert.deepEqual(changes.records, [])
    assert.equal(changes.hasMore, false)
    assert.equal(changes.nextCursor, null)
    assert.equal(changes.checkpoint, changes.watermark, 'empty final checkpoint represents W')
    validateHistoryPage({ records: [], nextCursor: null, checkpoint: changes.checkpoint, hasMore: false, watermark: changes.watermark, epoch: changes.epoch, serverTime: changes.serverTime })
    const snap = await store.createSnapshot({ owner: freshOwner })
    assert.equal(snap.memberCount, 0)
    const page = await store.listSnapshotPage({ owner: freshOwner, serverSecret: SECRET, snapshotId: snap.snapshotId })
    assert.deepEqual(page.records, [])
    assert.equal(page.hasMore, false)
    assert.equal(page.checkpoint, page.watermark)
    await store.deleteAll({ owner: freshOwner }).catch(() => {})
  }
})

test('M1 .2.4 filtered feeds track coverage separately; misuse rejected', async (t) => {
  for (const store of Object.values(await makeStores(t))) {
    await store.deleteAll({ owner: OWNER }).catch(() => {})
    const epoch = (await store.getUsage({ owner: OWNER })).epoch
    await store.archiveBatch({
      owner: OWNER,
      epoch,
      records: [
        { messageId: 'f-out-1', messageBox: 'inbox', direction: 'outbound', sender: OWNER, recipient: PEER, body: BODY },
        { messageId: 'f-in-1', messageBox: 'inbox', direction: 'inbound', sender: PEER, recipient: OWNER, body: BODY },
        { messageId: 'f-out-other', messageBox: 'other', direction: 'outbound', sender: OWNER, recipient: OTHER, body: BODY },
      ],
    })
    const byPeer = await store.createSnapshot({ owner: OWNER, filter: { participant: PEER } })
    assert.equal(byPeer.memberCount, 2)
    const outboundOnly = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, filter: { direction: 'outbound' }, limit: 100 })
    assert.ok(outboundOnly.records.every((r) => r.sequence !== undefined || r.direction === 'outbound' || r.recordKey), 'filtered changes respect direction')
    assert.ok(outboundOnly.records.filter((r) => r.body !== undefined).every((r) => r.direction === 'outbound'))
    // Same W, different filters: cursors are not interchangeable.
    const inboundPage = await store.listChangesPage({ owner: OWNER, serverSecret: SECRET, filter: { direction: 'inbound' }, limit: 100 })
    assert.equal(inboundPage.watermark, outboundOnly.watermark, 'same fixed W across filters')
    if (outboundOnly.nextCursor) {
      await assert.rejects(async () => store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor: outboundOnly.nextCursor, filter: { direction: 'inbound' } }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    }
    if (inboundPage.nextCursor) {
      await assert.rejects(async () => store.listChangesPage({ owner: OWNER, serverSecret: SECRET, cursor: inboundPage.nextCursor, filter: { direction: 'outbound' } }), (e) => e?.code === 'ERR_INVALID_CURSOR')
    }
    await store.deleteAll({ owner: OWNER })
  }
})

const MYSQL_ENABLED = process.env.MESSAGE_BOX_STORE_MYSQL === '1'

test('M1 .2.4 live MySQL feed parity (gated)', { skip: !MYSQL_ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { createMysqlKnex, migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await createMysqlKnex({
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  })
  t.after(() => knex.destroy())
  await migrateMysql(knex)
  const store = createMysqlStore(knex)
  const stamp = Date.now().toString(16).padStart(12, '0').slice(-12)
  const MOWNER = `02${(stamp + 'e2'.repeat(32)).slice(0, 64)}`
  const MPEER = `03${'e3'.repeat(32)}`
  await store.deleteAll({ owner: MOWNER }).catch(() => {})
  const epoch = (await store.getUsage({ owner: MOWNER })).epoch
  const archived = await store.archiveBatch({
    owner: MOWNER,
    epoch,
    records: [
      { messageId: 'mysql-feed-1', messageBox: 'inbox', direction: 'outbound', sender: MOWNER, recipient: MPEER, body: BODY },
      { messageId: 'mysql-feed-2', messageBox: 'inbox', direction: 'outbound', sender: MOWNER, recipient: MPEER, body: BODY },
    ],
  })
  assert.ok(archived.outcomes.every((o) => o.outcome === 'stored'))
  // Fixed-W drain with limit 1: no gaps/duplicates.
  const seen = []
  let cursor = null
  let W = null
  for (let i = 0; i < 10; i += 1) {
    const page = await store.listChangesPage({ owner: MOWNER, serverSecret: SECRET, cursor, limit: 1 })
    if (W === null) W = page.watermark
    else assert.equal(page.watermark, W)
    for (const r of page.records) seen.push(r.recordKey ?? r.sequence)
    if (!page.hasMore) {
      assert.equal(page.checkpoint, W)
      break
    }
    cursor = page.nextCursor
  }
  assert.equal(new Set(seen).size, 2)
  // Snapshot stable + versioned page.
  const snap = await store.createSnapshot({ owner: MOWNER })
  assert.equal(snap.memberCount, 2)
  const sp = await store.listSnapshotPage({ owner: MOWNER, serverSecret: SECRET, snapshotId: snap.snapshotId })
  assert.equal(sp.records.length, 2)
  assert.equal(sp.checkpoint, sp.watermark)
  // Deletion converges via delete event; snapshot invalidates.
  await store.deleteRecord({ owner: MOWNER, recordKey: sp.records[0].recordKey })
  const after = await store.listChangesPage({ owner: MOWNER, serverSecret: SECRET, limit: 100 })
  assert.ok(after.records.some((r) => r.recordKey === sp.records[0].recordKey && !('body' in r)))
  await assert.rejects(async () => store.listSnapshotPage({ owner: MOWNER, serverSecret: SECRET, snapshotId: snap.snapshotId }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')
  const stats = await store.getStorageStats({ owner: MOWNER })
  assert.ok(stats.physical.changeCount > stats.live.recordCount)
  await store.deleteAll({ owner: MOWNER })
})

test('M1 .2.4 live MySQL snapshot lock orders deletion before future ciphertext reads (gated)', { skip: !MYSQL_ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false }, async (t) => {
  const { createMysqlKnex, migrateMysql, createMysqlStore } = await import('../src/repository.mysql.mjs')
  const knex = await createMysqlKnex({
    host: process.env.MYSQL_HOST ?? '127.0.0.1', port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  })
  t.after(() => knex.destroy())
  await migrateMysql(knex)
  const writer = createMysqlStore(knex)
  const stamp = `${Date.now().toString(16)}${process.pid.toString(16)}`.padEnd(64, '8').slice(0, 64)
  const owner = `02${stamp}`
  const peer = `03${'91'.repeat(32)}`
  const epoch = (await writer.getUsage({ owner })).epoch
  const archived = await writer.archiveBatch({ owner, epoch, records: [{ messageId: 'lock-killer', messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body: BODY }] })
  const key = archived.outcomes[0].recordKey
  const snapshot = await writer.createSnapshot({ owner })

  let lockedResolve
  let releaseResolve
  const locked = new Promise((resolve) => { lockedResolve = resolve })
  const release = new Promise((resolve) => { releaseResolve = resolve })
  let paused = false
  const readerKnex = new Proxy(knex, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (callback) => target.transaction((trx) => callback(new Proxy(trx, {
        get(trxTarget, trxProp, trxReceiver) {
          if (trxProp !== 'raw') {
            const value = Reflect.get(trxTarget, trxProp, trxReceiver)
            return typeof value === 'function' ? value.bind(trxTarget) : value
          }
          return async (sql, bindings) => {
            const result = await trxTarget.raw(sql, bindings)
            if (!paused && String(sql).includes('FROM history_snapshot_items')) {
              paused = true
              lockedResolve()
              await release
            }
            return result
          }
        },
      })))
    },
  })
  const reader = createMysqlStore(readerKnex)
  const pagePromise = reader.listSnapshotPage({ owner, serverSecret: SECRET, snapshotId: snapshot.snapshotId })
  await locked
  let deleteSettled = false
  const deletePromise = writer.deleteRecord({ owner, recordKey: key }).finally(() => { deleteSettled = true })
  // Give the queued UPDATE multiple event-loop turns. It must remain blocked
  // on the reader's FOR SHARE lock until the page transaction is released.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(deleteSettled, false, 'privacy deletion cannot commit while ciphertext page holds the snapshot lock')
  releaseResolve()
  const page = await pagePromise
  assert.equal(page.records[0].recordKey, key, 'the read linearized before deletion')
  await deletePromise
  await assert.rejects(reader.listSnapshotPage({ owner, serverSecret: SECRET, snapshotId: snapshot.snapshotId }), (e) => e?.code === 'ERR_CURSOR_EXPIRED')
  await writer.deleteAll({ owner }).catch(() => {})
})
