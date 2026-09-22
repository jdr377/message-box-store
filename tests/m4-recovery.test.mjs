import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'

import { applyMysqlRestoreRecovery, validateRestoreRecoveryBundle } from '../src/restore-recovery.mjs'
import { createTransactionalReplicaFixture } from './helpers/replica-store.mjs'

const ENABLED = process.env.MESSAGE_BOX_STORE_MYSQL === '1'
const SECRET = 'm4-recovery-server-secret-0123456789'

function bundle(overrides = {}) {
  return {
    version: 1,
    recoveryId: 'm4-disposable-drill',
    owner: `02${'11'.repeat(32)}`,
    restoredEpoch: 'gen-1',
    recoveryEpoch: 'restore_test_1',
    deletionReceiptsComplete: true,
    backupCreatedAt: '2026-09-22T00:00:00.000Z',
    receiptsCompleteThrough: '2026-09-22T01:00:00.000Z',
    backupRetentionUntil: '2026-10-22T00:00:00.000Z',
    deletions: [],
    ...overrides,
  }
}

test('M4 restore recovery bundle fails closed without complete external deletion receipts', () => {
  assert.throws(
    () => validateRestoreRecoveryBundle(bundle({ deletionReceiptsComplete: false })),
    (error) => error?.code === 'ERR_RECOVERY_RECEIPTS_INCOMPLETE',
  )
  assert.throws(
    () => validateRestoreRecoveryBundle(bundle({ recoveryEpoch: 'gen-1' })),
    (error) => error?.code === 'ERR_RECOVERY_MANIFEST',
  )
  assert.throws(
    () => validateRestoreRecoveryBundle(bundle({
      deletions: [
        { recordKey: 'a'.repeat(64), deletedAt: '2026-09-22T00:30:00.000Z' },
        { recordKey: 'a'.repeat(64), deletedAt: '2026-09-22T00:31:00.000Z' },
      ],
    })),
    (error) => error?.code === 'ERR_RECOVERY_MANIFEST',
  )
})

function mysqlConfig() {
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  }
}

function walletFor(hex) {
  return new ProtoWallet(PrivateKey.fromHex(hex))
}

async function identityOf(wallet) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

function directHistoryClient(store, owner) {
  return {
    createSnapshot(filter) {
      return store.createSnapshot({ owner, filter })
    },
    listSnapshotPage(options) {
      return store.listSnapshotPage({ owner, serverSecret: SECRET, ...options })
    },
    listChanges(options = {}) {
      const { epoch, ...rest } = options
      return store.listChangesPage({ owner, serverSecret: SECRET, ...rest, ...(epoch === undefined ? {} : { expectedEpoch: epoch }) })
    },
  }
}

const OWNER_TABLES = [
  'history_owner_state',
  'history_resource_locks',
  'history_records',
  'history_changes',
  'history_idempotency',
  'history_tombstones',
  'history_change_details',
  'history_change_boundaries',
]

async function captureOwnerImage(knex, owner) {
  return knex.transaction(async (trx) => {
    await trx.raw(`SELECT owner_identity_key FROM history_resource_locks WHERE owner_identity_key = ? FOR SHARE`, [owner])
    const image = {}
    for (const table of OWNER_TABLES) image[table] = await trx(table).where({ owner_identity_key: owner }).select('*')
    image.history_snapshots = await trx('history_snapshots').where({ owner_identity_key: owner }).select('*')
    const snapshotIds = image.history_snapshots.map((row) => row.snapshot_id)
    image.history_snapshot_items = snapshotIds.length === 0
      ? []
      : await trx('history_snapshot_items').whereIn('snapshot_id', snapshotIds).select('*')
    return image
  })
}

async function restoreOwnerImage(knex, owner, image) {
  await knex.transaction(async (trx) => {
    const currentSnapshots = await trx('history_snapshots').where({ owner_identity_key: owner }).pluck('snapshot_id')
    if (currentSnapshots.length > 0) await trx('history_snapshot_items').whereIn('snapshot_id', currentSnapshots).del()
    await trx('history_snapshots').where({ owner_identity_key: owner }).del()
    for (const table of OWNER_TABLES.slice().reverse()) await trx(table).where({ owner_identity_key: owner }).del()
    for (const table of OWNER_TABLES) {
      if (image[table].length > 0) await trx(table).insert(image[table])
    }
    if (image.history_snapshots.length > 0) await trx('history_snapshots').insert(image.history_snapshots)
    if (image.history_snapshot_items.length > 0) await trx('history_snapshot_items').insert(image.history_snapshot_items)
  })
}

async function cleanupOwner(knex, owner) {
  await knex.transaction(async (trx) => {
    const snapshotIds = await trx('history_snapshots').where({ owner_identity_key: owner }).pluck('snapshot_id')
    if (snapshotIds.length > 0) await trx('history_snapshot_items').whereIn('snapshot_id', snapshotIds).del()
    await trx('history_snapshots').where({ owner_identity_key: owner }).del()
    await trx('history_audit_events').where({ owner_identity_key: owner }).del()
    for (const table of OWNER_TABLES.slice().reverse()) await trx(table).where({ owner_identity_key: owner }).del()
  })
}

test('M4 disposable MySQL rollback reapplies deletion receipts and forces complete two-device reconciliation', {
  skip: !ENABLED ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false,
  timeout: 30_000,
}, async (t) => {
  const { createMysqlKnex, createMysqlStore, migrateMysql } = await import('../src/repository.mysql.mjs')
  const root = await import('../dist/mod.js')
  const knex = await createMysqlKnex(mysqlConfig())
  let cleanupOwnerKey = null
  t.after(async () => {
    if (cleanupOwnerKey !== null) await cleanupOwner(knex, cleanupOwnerKey)
    await knex.destroy()
  })
  await migrateMysql(knex)
  const store = createMysqlStore(knex)

  const stamp = Date.now().toString(16).padStart(16, '0')
  const walletA = walletFor((stamp + '41'.repeat(32)).slice(0, 64))
  const walletB = walletFor((stamp + '41'.repeat(32)).slice(0, 64))
  const senderWallet = walletFor((stamp + '52'.repeat(32)).slice(0, 64))
  const peerWallet = walletFor((stamp + '63'.repeat(32)).slice(0, 64))
  const owner = await identityOf(walletA)
  cleanupOwnerKey = owner
  assert.equal(await identityOf(walletB), owner)
  const sender = await identityOf(senderWallet)
  const peer = await identityOf(peerWallet)

  const initialEpoch = (await store.getUsage({ owner })).epoch
  const inboundText = 'M4 inbound survives cache loss and database rollback'
  const outboundText = 'M4 outbound survives cache loss and database rollback'
  const inboundBody = (await root.prepareEncryptedBody({ wallet: senderWallet, plaintext: inboundText, counterparty: owner })).body
  const outboundBody = (await root.prepareEncryptedBody({ wallet: walletA, plaintext: outboundText, counterparty: peer })).body
  const archived = await store.archiveBatch({
    owner,
    epoch: initialEpoch,
    records: [
      { messageId: 'm4-inbound', messageBox: 'recovery', direction: 'inbound', sender, recipient: owner, body: inboundBody },
      { messageId: 'm4-outbound', messageBox: 'recovery', direction: 'outbound', sender: owner, recipient: peer, body: outboundBody },
    ],
  })
  assert.deepEqual(archived.outcomes.map((outcome) => outcome.outcome), ['stored', 'stored'])
  const inboundKey = archived.outcomes[0].recordKey
  const outboundKey = archived.outcomes[1].recordKey

  const localB = createTransactionalReplicaFixture()
  const history = directHistoryClient(store, owner)
  const firstSync = await root.syncHistory({ owner, historyClient: history, localReplica: localB.replica, maxPages: 10 })
  assert.equal(firstSync.status, 'complete')
  assert.equal(firstSync.records, 2, JSON.stringify(firstSync))
  const scope = firstSync.coverage.scope
  const initialReplica = localB.inspect(scope)
  const initiallyRecovered = initialReplica.records
  const inboundRecovered = initiallyRecovered.find((row) => row.recordKey === inboundKey)
  const outboundRecovered = initiallyRecovered.find((row) => row.recordKey === outboundKey)
  assert.ok(inboundRecovered, JSON.stringify({ inboundKey, members: initialReplica.members, recovered: initiallyRecovered.map((row) => row.recordKey) }))
  assert.ok(outboundRecovered, JSON.stringify({ outboundKey, members: initialReplica.members, recovered: initiallyRecovered.map((row) => row.recordKey) }))
  assert.equal(await root.decryptArchivedBody({ wallet: walletB, body: inboundRecovered.body, counterparty: sender }), inboundText)
  assert.equal(await root.decryptArchivedBody({ wallet: walletB, body: outboundRecovered.body, counterparty: peer }), outboundText)

  const duplicate = await store.archiveBatch({
    owner,
    epoch: initialEpoch,
    records: [{ messageId: 'm4-outbound', messageBox: 'recovery', direction: 'outbound', sender: owner, recipient: peer, body: outboundBody }],
  })
  assert.equal(duplicate.outcomes[0].outcome, 'alreadyPresent')
  assert.equal((await store.getUsage({ owner })).recordCount, 2)

  const image = await captureOwnerImage(knex, owner)
  const backupCreatedAt = new Date(Date.now() - 2_000).toISOString()
  await store.deleteRecord({ owner, recordKey: inboundKey, idempotencyKey: `m4-delete-${stamp}` })
  const receiptRow = (await knex('history_tombstones').where({ owner_identity_key: owner, record_key: inboundKey }).select('deleted_at'))[0]
  const deletedAt = receiptRow.deleted_at instanceof Date ? receiptRow.deleted_at.toISOString() : new Date(receiptRow.deleted_at).toISOString()

  const postBody = (await root.prepareEncryptedBody({ wallet: walletA, plaintext: 'post-backup and intentionally unrecoverable', counterparty: peer })).body
  const post = await store.archiveBatch({
    owner,
    epoch: initialEpoch,
    records: [{ messageId: 'm4-post-backup', messageBox: 'recovery', direction: 'outbound', sender: owner, recipient: peer, body: postBody }],
  })
  const postBackupKey = post.outcomes[0].recordKey
  await root.syncHistory({ owner, historyClient: history, localReplica: localB.replica, maxPages: 10 })
  assert.ok(localB.inspect(scope).members.includes(postBackupKey))

  await restoreOwnerImage(knex, owner, image)
  assert.ok(await store.getRecord({ owner, recordKey: inboundKey }), 'rollback alone would resurrect deleted ciphertext')
  assert.equal(await store.getRecord({ owner, recordKey: postBackupKey }), null, 'rollback cannot recover a post-backup write')

  const recoveryEpoch = `restore_${stamp}`
  const recoveryBundle = bundle({
    recoveryId: `m4_${stamp}`,
    owner,
    restoredEpoch: initialEpoch,
    recoveryEpoch,
    backupCreatedAt,
    receiptsCompleteThrough: new Date(Date.now() + 1_000).toISOString(),
    backupRetentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    deletions: [{ recordKey: inboundKey, deletedAt }],
  })
  const result = await applyMysqlRestoreRecovery({ knex, bundle: recoveryBundle })
  assert.equal(result.replayed, false)
  assert.equal(result.postBackupWritesRecovered, false)
  assert.equal((await store.getUsage({ owner })).epoch, recoveryEpoch)
  assert.equal(await store.getRecord({ owner, recordKey: inboundKey }), null)
  assert.ok(await store.getRecord({ owner, recordKey: outboundKey }))
  assert.equal(await store.getRecord({ owner, recordKey: postBackupKey }), null)
  assert.equal((await applyMysqlRestoreRecovery({ knex, bundle: recoveryBundle })).replayed, true)
  await assert.rejects(
    applyMysqlRestoreRecovery({
      knex,
      bundle: { ...recoveryBundle, backupRetentionUntil: new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString() },
    }),
    (error) => error?.code === 'ERR_RECOVERY_STATE',
  )

  const staleWrite = await store.archiveBatch({
    owner,
    epoch: initialEpoch,
    records: [{ messageId: 'm4-stale', messageBox: 'recovery', direction: 'outbound', sender: owner, recipient: peer, body: outboundBody }],
  })
  assert.equal(staleWrite.outcomes[0].outcome, 'epochChanged')
  const reuploadDeleted = await store.archiveBatch({
    owner,
    epoch: recoveryEpoch,
    records: [{ messageId: 'm4-inbound', messageBox: 'recovery', direction: 'inbound', sender, recipient: owner, body: inboundBody }],
  })
  assert.equal(reuploadDeleted.outcomes[0].outcome, 'deleted')

  const reconciled = await root.syncHistory({ owner, historyClient: history, localReplica: localB.replica, maxPages: 10 })
  assert.equal(reconciled.mode, 'snapshot')
  const finalRows = localB.inspect(scope).records
  assert.deepEqual(finalRows.map((row) => row.recordKey), [outboundKey])
  assert.equal(await root.decryptArchivedBody({ wallet: walletB, body: finalRows[0].body, counterparty: peer }), outboundText)
})
