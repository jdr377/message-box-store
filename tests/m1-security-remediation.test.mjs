import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

import { LIMITS, validateEpoch } from '../src/protocol.mjs'
import { createBrowsePageBuilder } from '../src/feeds.mjs'
import { createMemoryStore } from '../src/repository.mjs'
import { createSqliteStore } from '../src/repository.sqlite.mjs'
import { createMysqlStore } from '../src/repository.mysql.mjs'
import { validateRestoreRecoveryBundle } from '../src/restore-recovery.mjs'
import { MAX_SNAPSHOTS_PER_OWNER, MAX_SNAPSHOT_ITEMS_PER_OWNER } from '../src/snapshots.mjs'

const OWNER = `02${'11'.repeat(32)}`
const PEER = `03${'22'.repeat(32)}`
const BODY = '{"encryptedMessage":"AQ=="}'
const SECRET = 'security-regression-cursor-secret'
const record = (messageId, body = BODY) => ({ messageId, messageBox: 'security', direction: 'outbound', sender: OWNER, recipient: PEER, body })
async function makeStores(t, limits) {
  const sqlite = await createSqliteStore({ limits })
  t.after(() => sqlite.close())
  return [createMemoryStore({ limits }), sqlite]
}
async function archive(store, records, epoch) {
  return store.archiveBatch({ owner: OWNER, epoch: epoch ?? (await store.getUsage({ owner: OWNER })).epoch, records })
}

for (const adapter of ['memory', 'sqlite']) test(`F2 ${adapter}: custom recovery epochs rotate canonically and remain usable`, async t => {
  const store = adapter === 'memory' ? createMemoryStore() : await createSqliteStore()
  t.after(() => store.close?.())
  for (const recovered of ['restore_2026_09_22_a', 'x'.repeat(128)]) {
    validateRestoreRecoveryBundle({ version: 1, recoveryId: 'security_regression', owner: OWNER, restoredEpoch: 'gen-1', recoveryEpoch: recovered, deletionReceiptsComplete: true, backupCreatedAt: '2026-09-22T00:00:00.000Z', receiptsCompleteThrough: '2026-09-22T01:00:00.000Z', backupRetentionUntil: '2026-10-22T00:00:00.000Z', deletions: [] })
    await archive(store, [record('before')])
    if (store.db) store.db.prepare('UPDATE history_owner_state SET epoch = ? WHERE owner_identity_key = ?').run(recovered, OWNER)
    else store._debug.owners.get(OWNER).epoch = recovered
    const one = await store.deleteAll({ owner: OWNER, expectedEpoch: recovered })
    const two = await store.deleteAll({ owner: OWNER, expectedEpoch: one.epoch })
    for (const epoch of [one.epoch, two.epoch]) { assert.equal(validateEpoch(epoch), epoch); assert.ok(epoch.length <= 128) }
    assert.notEqual(one.epoch, recovered)
    assert.notEqual(one.epoch, two.epoch)
    assert.equal((await archive(store, [record('stale')], recovered)).outcomes[0].outcome, 'epochChanged')
    assert.equal((await archive(store, [record('after')], two.epoch)).outcomes[0].outcome, 'stored')
    const snapshot = await store.createSnapshot({ owner: OWNER })
    assert.equal((await store.listSnapshotPage({ owner: OWNER, snapshotId: snapshot.snapshotId, serverSecret: SECRET })).records.length, 1)
  }
})

test('F3 browse byte boundary includes array/continuation framing and rejects impossible single rows', () => {
  const row = { recordKey: 'a'.repeat(64), createdAt: '2026-10-28T00:00:00.000Z', body: 'x"\\\n' }
  const exact = Buffer.byteLength(JSON.stringify({ records: [row], nextAfter: { createdAt: row.createdAt, recordKey: row.recordKey } }))
  const page = createBrowsePageBuilder({ limit: 10, maxBytes: exact })
  assert.equal(page.add(row), true)
  assert.equal(page.add(row), false)
  assert.equal(Buffer.byteLength(JSON.stringify({ records: page.finish(true).items, nextAfter: page.finish(true).nextAfter })), exact)
  assert.throws(() => createBrowsePageBuilder({ limit: 1, maxBytes: exact - 1 }).add(row), error => error.code === 'ERR_REQUEST_TOO_LARGE')
})

test('F3 browse resumes after the last emitted key without omission on byte/count limits', async t => {
  const body = JSON.stringify({ encryptedMessage: 'A'.repeat(1024 * 1024 - 64) })
  for (const store of await makeStores(t)) {
    for (let i = 0; i < 9; i++) assert.equal((await archive(store, [record(`large-${i}`, body)])).outcomes[0].outcome, 'stored')
    const found = []
    let after
    do {
      const page = await store.listBrowse({ owner: OWNER, limit: 1000, after })
      assert.ok(Buffer.byteLength(JSON.stringify({ records: page.items, nextAfter: page.nextAfter })) <= LIMITS.MAX_PAGE_BYTES)
      assert.ok(page.items.length > 0)
      found.push(...page.items.map(row => row.recordKey))
      after = page.nextAfter
    } while (after)
    assert.equal(found.length, 9)
    assert.equal(new Set(found).size, 9)
    const first = await store.listBrowse({ owner: OWNER, limit: 1 })
    assert.equal(first.items.length, 1)
    assert.deepEqual(first.nextAfter, { createdAt: first.items[0].createdAt, recordKey: first.items[0].recordKey })
    assert.deepEqual((await store.listBrowse({ owner: PEER })).items, [])
  }
})

test('F4 snapshot capacity rejects before membership reads; snapshot membership stays metadata-only', async t => {
  const sqlite = await createSqliteStore()
  t.after(() => sqlite.close())
  await archive(sqlite, [record('snapshot')])
  const original = sqlite.db.prepare.bind(sqlite.db)
  const queries = []
  sqlite.db.prepare = sql => { queries.push(sql); return original(sql) }
  const snapshot = await sqlite.createSnapshot({ owner: OWNER })
  const membershipSql = queries.find(sql => sql.startsWith('SELECT r.'))
  assert.ok(membershipSql)
  assert.doesNotMatch(membershipSql, /r\.\*|r\.body\b/)
  const members = await sqlite.listSnapshotMembers({ owner: OWNER, snapshotId: snapshot.snapshotId })
  assert.equal(members.items.length, 1)
  assert.ok(!('body' in members.items[0]))
  for (let i = 1; i < MAX_SNAPSHOTS_PER_OWNER; i++) await sqlite.createSnapshot({ owner: OWNER })
  queries.length = 0
  await assert.rejects(sqlite.createSnapshot({ owner: OWNER }), error => error.code === 'ERR_QUOTA_EXCEEDED')
  assert.equal(queries.some(sql => sql.includes('FROM history_records')), false)
})

test('F4 concurrent snapshot admission never exceeds its anchor capacity', async t => {
  for (const store of await makeStores(t)) {
    await archive(store, [record('concurrent-snapshot')])
    const results = await Promise.allSettled(Array.from({ length: MAX_SNAPSHOTS_PER_OWNER + 2 }, () => store.createSnapshot({ owner: OWNER })))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, MAX_SNAPSHOTS_PER_OWNER)
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'ERR_QUOTA_EXCEEDED'))
  }
})

test('F5 reserve future deletion capacity once per distinct key and preserve retries at capacity', async t => {
  assert.equal(LIMITS.MAX_RESERVED_RECORD_KEYS_PER_OWNER, 1_000_000)
  for (const store of await makeStores(t, { MAX_RESERVED_RECORD_KEYS_PER_OWNER: 2 })) {
    const input = record('first')
    const batch = await archive(store, [input, input, record('first', '{"encryptedMessage":"Ag=="}'), record('second'), record('over')])
    assert.deepEqual(batch.outcomes.map(result => result.outcome), ['stored', 'alreadyPresent', 'conflict', 'stored', 'quotaExceeded'])
    assert.equal((await store.getUsage({ owner: OWNER })).byteCount, 2 * Buffer.byteLength(BODY))
    const first = batch.outcomes[0].recordKey
    assert.equal((await archive(store, [input])).outcomes[0].outcome, 'alreadyPresent')
    await store.patchState({ owner: OWNER, recordKey: first, newState: 'accepted', expectedRevision: '1', idempotencyKey: 'state-at-capacity' })
    const snapshot = await store.createSnapshot({ owner: OWNER })
    assert.equal(snapshot.memberCount, 2)
    const deleted = await store.deleteRecord({ owner: OWNER, recordKey: first })
    assert.equal(deleted.deleted, true)
    assert.equal((await archive(store, [record('new-after-delete')])).outcomes[0].outcome, 'quotaExceeded')
    assert.equal((await archive(store, [input])).outcomes[0].outcome, 'deleted')
    const stats = await store.getStorageStats({ owner: OWNER })
    assert.equal(stats.physical.tombstoneCount, 1)
    assert.equal(stats.live.recordCount, 1)
    await store.deleteRecord({ owner: OWNER, recordKey: batch.outcomes[3].recordKey })
    assert.equal((await store.getUsage({ owner: OWNER })).recordCount, 0)
    assert.equal((await archive(store, [record('still-blocked')])).outcomes[0].outcome, 'quotaExceeded')
    await store.deleteAll({ owner: OWNER })
    assert.equal((await archive(store, [record('new-epoch')])).outcomes[0].outcome, 'stored')
  }
})

test('F5 concurrent writers share one reservation bound and rollback leaks no reservation', async t => {
  for (const store of await makeStores(t, { MAX_RESERVED_RECORD_KEYS_PER_OWNER: 1 })) {
    store.injectFailureOnce('archiveBatch')
    await archive(store, [record('rollback')]).catch(() => {})
    const results = await Promise.all([archive(store, [record('a')]), archive(store, [record('b')])])
    assert.deepEqual(results.map(result => result.outcomes[0].outcome).sort(), ['quotaExceeded', 'stored'])
    assert.equal((await store.getUsage({ owner: OWNER })).recordCount, 1)
  }
})

test('F5 existing SQLite owners over a lowered bound retain history, retries and deletions after reopen', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mbs-security-reservations-'))
  t.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()), 'cleanup remains within the explicitly created temp directory')
    rmSync(directory, { recursive: true, force: true })
  })
  const path = join(directory, 'history.db')
  let store = await createSqliteStore({ path })
  const initial = await archive(store, [record('existing-a'), record('existing-b'), record('existing-c')])
  await store.deleteRecord({ owner: OWNER, recordKey: initial.outcomes[0].recordKey })
  const migrationRows = store.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
  store.close()
  store = await createSqliteStore({ path, limits: { MAX_RESERVED_RECORD_KEYS_PER_OWNER: 1 } })
  try {
    assert.deepEqual(store.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all(), migrationRows)
    assert.equal((await store.listBrowse({ owner: OWNER })).items.length, 2)
    assert.equal((await archive(store, [record('existing-b')])).outcomes[0].outcome, 'alreadyPresent')
    assert.equal((await archive(store, [record('blocked-new')])).outcomes[0].outcome, 'quotaExceeded')
    for (const outcome of initial.outcomes.slice(1)) assert.equal((await store.deleteRecord({ owner: OWNER, recordKey: outcome.recordKey })).deleted, true)
    assert.equal((await store.getStorageStats({ owner: OWNER })).physical.tombstoneCount, 3)
    assert.equal((await archive(store, [record('existing-a')])).outcomes[0].outcome, 'deleted')
  } finally { store.close() }
})

function sqlRow(i, body = BODY) {
  return { owner_identity_key: OWNER, record_key: i.toString(16).padStart(64, '0'), message_id: `mysql-${i}`, message_box: 'security', direction: 'outbound', sender: OWNER, recipient: PEER, body, body_hash: 'a'.repeat(64), body_bytes: Buffer.byteLength(body), delivery_state: 'prepared', revision: '1', change_sequence: String(i + 1), created_at: new Date('2026-10-28T00:00:00Z'), created_at_exact: '2026-10-28 00:00:00.000123', archived_at: new Date('2026-10-28T00:00:00Z'), expires_at: null }
}

test('F3 MySQL seam bounds fetched bodies and preserves exact timestamp keysets', async () => {
  const body = JSON.stringify({ encryptedMessage: 'A'.repeat(1024 * 1024 - 64) })
  const rows = Array.from({ length: 10 }, (_, i) => sqlRow(i, body))
  let fetchedBytes = 0
  const raw = async (sql, params) => {
    assert.equal(params[0], OWNER)
    if (sql.startsWith('SELECT record_key, DATE_FORMAT')) {
      assert.doesNotMatch(sql, /SELECT \*|\bbody\b/)
      assert.match(sql, /LIMIT 1001$/)
      return [rows.filter(row => params.length === 1 || row.record_key > params[3]).map(row => ({ record_key: row.record_key, created_at_exact: row.created_at_exact }))]
    }
    assert.match(sql, /^SELECT \* FROM history_records WHERE owner_identity_key = \? AND record_key = \?$/)
    const row = rows.find(row => row.record_key === params[1])
    fetchedBytes += row.body_bytes
    return [[row]]
  }
  const store = createMysqlStore({ transaction: fn => fn({ raw }) })
  const first = await store.listBrowse({ owner: OWNER, limit: 1000 })
  assert.equal(first.items.length, 7)
  assert.ok(fetchedBytes <= LIMITS.MAX_PAGE_BYTES + LIMITS.MAX_BODY_BYTES)
  assert.ok(first.nextAfter.createdAt.endsWith('.000123Z'))
  fetchedBytes = 0
  const second = await store.listBrowse({ owner: OWNER, limit: 1000, after: first.nextAfter })
  assert.equal(second.items.length, 3)
  assert.equal(second.nextAfter, null)
  assert.equal(new Set([...first.items, ...second.items].map(row => row.recordKey)).size, 10)
})

test('F4 MySQL seam rejects impossible anchor/item admission before materializing members', async () => {
  for (const [anchors, items, count] of [[32, 0, 1], [0, 40000, 1], [0, 39999, 2], [0, 0, 2]]) {
    const queries = []
    const raw = async (sql, params) => {
      queries.push(sql)
      if (sql.includes('SELECT epoch, next_sequence')) return [[{ epoch: 'gen-1', next_sequence: '3', record_count: 2, byte_count: 50 }]]
      if (sql.startsWith('SELECT owner_identity_key')) return [[{ owner_identity_key: OWNER }]]
      if (sql.includes('AS snapshots')) return [[{ snapshots: anchors, items }]]
      if (sql.startsWith('SELECT COUNT(*) AS n FROM history_records')) return [[{ n: count }]]
      if (sql.startsWith('SELECT r.')) {
        assert.doesNotMatch(sql, /r\.\*|r\.body\b/)
        assert.match(sql, new RegExp(`LIMIT ${MAX_SNAPSHOT_ITEMS_PER_OWNER}$`))
        return [Array.from({ length: count }, (_, i) => ({ ...sqlRow(i), created_seq: String(i + 1) }))]
      }
      assert.ok(sql.startsWith('INSERT'), sql)
      return [[]]
    }
    const promise = createMysqlStore({ transaction: fn => fn({ raw }) }).createSnapshot({ owner: OWNER })
    if (anchors === 32 || items + count > 40000) {
      await assert.rejects(promise, error => error.code === 'ERR_QUOTA_EXCEEDED')
      assert.equal(queries.some(sql => sql.startsWith('SELECT r.')), false)
      if (anchors === 32) assert.equal(queries.some(sql => sql.includes('FROM history_records')), false)
    } else assert.equal((await promise).memberCount, 2)
  }
})

test('F2 MySQL seam persists bounded custom-epoch rotation and rejects stale delete-all', async () => {
  let epoch = 'r'.repeat(128)
  const raw = async (sql, params) => {
    if (sql.startsWith('SELECT epoch, next_sequence')) return [[{ epoch, next_sequence: '1', record_count: 0, byte_count: 0 }]]
    if (sql.startsWith('SELECT owner_identity_key')) return [[{ owner_identity_key: OWNER }]]
    if (sql.includes('SET record_count = 0')) epoch = params[0]
    return [[]]
  }
  const store = createMysqlStore({ transaction: fn => fn({ raw }) })
  const original = epoch
  const result = await store.deleteAll({ owner: OWNER, expectedEpoch: original })
  assert.equal(validateEpoch(result.epoch), epoch)
  assert.notEqual(epoch, original)
  await assert.rejects(store.deleteAll({ owner: OWNER, expectedEpoch: original }), error => error.code === 'ERR_EPOCH_CHANGED')
})

test('F5 MySQL seam reserves distinct batch keys using one marker count under the owner lock', async () => {
  const queries = []
  const inserts = []
  const raw = async (sql, params) => {
    queries.push(sql)
    if (sql.startsWith('SELECT epoch, next_sequence')) return [[{ epoch: 'gen-1', next_sequence: '1', record_count: 0, byte_count: 0 }]]
    if (sql.startsWith('SELECT owner_identity_key')) return [[{ owner_identity_key: OWNER }]]
    if (sql.startsWith('SELECT COUNT(*) AS n FROM history_tombstones')) return [[{ n: 2 }]]
    if (sql.startsWith('SELECT')) return [[]]
    if (sql.includes('INSERT INTO history_records')) inserts.push(params)
    if (sql.startsWith('UPDATE history_owner_state SET next_sequence')) assert.deepEqual(params.slice(1, 3), [2, 2 * Buffer.byteLength(BODY)])
    return [[]]
  }
  const store = createMysqlStore({ transaction: fn => fn({ raw }) }, { limits: { MAX_RESERVED_RECORD_KEYS_PER_OWNER: 4 } })
  const first = record('mysql-batch')
  const result = await archive(store, [first, first, record('mysql-batch', '{"encryptedMessage":"Ag=="}'), record('mysql-batch-2'), record('overflow')], 'gen-1')
  assert.deepEqual(result.outcomes.map(row => row.outcome), ['stored', 'alreadyPresent', 'conflict', 'stored', 'quotaExceeded'])
  assert.equal(inserts.length, 2)
  const countIndex = queries.findIndex(sql => sql.startsWith('SELECT COUNT(*) AS n FROM history_tombstones'))
  assert.ok(queries.slice(0, countIndex).some(sql => sql.endsWith('FOR UPDATE')))
  assert.equal(queries.filter(sql => sql.startsWith('SELECT COUNT(*) AS n FROM history_tombstones')).length, 1)
})
