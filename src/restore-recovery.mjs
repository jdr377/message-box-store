import { createHash } from 'node:crypto'

import { isIdentityKey, isRecordKey, validateEpoch } from './protocol.mjs'

const RECOVERY_ID = /^[A-Za-z0-9_-]{1,64}$/
const UINT64_MAX = 18_446_744_073_709_551_615n

function recoveryError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function canonicalInstant(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) {
    throw recoveryError('ERR_RECOVERY_MANIFEST', `${field} must be a canonical UTC instant`)
  }
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) throw recoveryError('ERR_RECOVERY_MANIFEST', `${field} is invalid`)
  return { iso: value, millis }
}

function mysqlInstant(iso) {
  return iso.slice(0, -1).replace('T', ' ')
}

/** Validate the deliberately small, externally retained restore receipt bundle. */
export function validateRestoreRecoveryBundle(bundle) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw recoveryError('ERR_RECOVERY_MANIFEST', 'recovery bundle must be an object')
  }
  if (bundle.version !== 1) throw recoveryError('ERR_RECOVERY_MANIFEST', 'recovery bundle version must be 1')
  if (typeof bundle.recoveryId !== 'string' || !RECOVERY_ID.test(bundle.recoveryId)) {
    throw recoveryError('ERR_RECOVERY_MANIFEST', 'recoveryId must be 1..64 [A-Za-z0-9_-] chars')
  }
  if (!isIdentityKey(bundle.owner)) throw recoveryError('ERR_RECOVERY_MANIFEST', 'owner must be a compressed lowercase identity key')
  try {
    validateEpoch(bundle.restoredEpoch)
    validateEpoch(bundle.recoveryEpoch)
  } catch (error) {
    throw recoveryError('ERR_RECOVERY_MANIFEST', error.message)
  }
  if (bundle.restoredEpoch === bundle.recoveryEpoch) {
    throw recoveryError('ERR_RECOVERY_MANIFEST', 'recoveryEpoch must be fresh')
  }
  if (bundle.deletionReceiptsComplete !== true) {
    throw recoveryError('ERR_RECOVERY_RECEIPTS_INCOMPLETE', 'deletion receipts are not asserted complete; keep service offline')
  }
  const backup = canonicalInstant(bundle.backupCreatedAt, 'backupCreatedAt')
  const complete = canonicalInstant(bundle.receiptsCompleteThrough, 'receiptsCompleteThrough')
  const retention = canonicalInstant(bundle.backupRetentionUntil, 'backupRetentionUntil')
  if (complete.millis < backup.millis) throw recoveryError('ERR_RECOVERY_MANIFEST', 'receipt coverage predates the backup')
  if (retention.millis <= backup.millis) throw recoveryError('ERR_RECOVERY_MANIFEST', 'backup retention must end after backup creation')
  if (!Array.isArray(bundle.deletions)) throw recoveryError('ERR_RECOVERY_MANIFEST', 'deletions must be an array')
  const seen = new Set()
  const deletions = bundle.deletions.map((receipt, index) => {
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) || !isRecordKey(receipt.recordKey)) {
      throw recoveryError('ERR_RECOVERY_MANIFEST', `deletions[${index}].recordKey is invalid`)
    }
    if (seen.has(receipt.recordKey)) throw recoveryError('ERR_RECOVERY_MANIFEST', 'duplicate deletion receipt')
    seen.add(receipt.recordKey)
    const deleted = canonicalInstant(receipt.deletedAt, `deletions[${index}].deletedAt`)
    if (deleted.millis < backup.millis || deleted.millis > complete.millis) {
      throw recoveryError('ERR_RECOVERY_MANIFEST', `deletions[${index}] is outside receipt coverage`)
    }
    return Object.freeze({ recordKey: receipt.recordKey, deletedAt: deleted.iso })
  })
  return Object.freeze({
    version: 1,
    recoveryId: bundle.recoveryId,
    owner: bundle.owner,
    restoredEpoch: bundle.restoredEpoch,
    recoveryEpoch: bundle.recoveryEpoch,
    deletionReceiptsComplete: true,
    backupCreatedAt: backup.iso,
    receiptsCompleteThrough: complete.iso,
    backupRetentionUntil: retention.iso,
    deletions: Object.freeze(deletions),
  })
}

/**
 * Fence one externally restored owner before service resumes.
 *
 * The database restore itself remains operator/provider owned. Call this only
 * while the service is offline, after restoring a consistent MySQL image and
 * before accepting traffic. The receipt bundle is deliberately external to
 * that image so a rollback cannot erase the evidence needed to keep deleted
 * ciphertext deleted.
 */
export async function applyMysqlRestoreRecovery({ knex, bundle }) {
  if (!knex || typeof knex.transaction !== 'function') throw new TypeError('knex transaction client is required')
  const input = validateRestoreRecoveryBundle(bundle)
  const digest = createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex')
  const marker = JSON.stringify({ recoveryId: input.recoveryId, recoveryEpoch: input.recoveryEpoch, digest })
  return knex.transaction(async (trx) => {
    await trx.raw(
      `INSERT INTO history_resource_locks (owner_identity_key) VALUES (?)
       ON DUPLICATE KEY UPDATE owner_identity_key = VALUES(owner_identity_key)`,
      [input.owner],
    )
    await trx.raw(`SELECT owner_identity_key FROM history_resource_locks WHERE owner_identity_key = ? FOR UPDATE`, [input.owner])
    const state = (await trx.raw(
      `SELECT epoch, next_sequence FROM history_owner_state WHERE owner_identity_key = ? FOR UPDATE`,
      [input.owner],
    ))[0][0]
    if (!state) throw recoveryError('ERR_RECOVERY_STATE', 'restored owner state is missing')

    const recoveryRows = (await trx.raw(
      `SELECT detail FROM history_audit_events WHERE owner_identity_key = ? AND kind = 'restore_recovery'`,
      [input.owner],
    ))[0]
    const existing = recoveryRows.map((row) => {
      try { return JSON.parse(String(row.detail)) } catch { return null }
    }).find((candidate) => candidate?.recoveryId === input.recoveryId)
    if (existing !== undefined) {
      if (existing?.digest !== digest || existing?.recoveryEpoch !== input.recoveryEpoch) {
        throw recoveryError('ERR_RECOVERY_STATE', 'recoveryId was already used with a different bundle')
      }
      if (String(state.epoch) !== input.recoveryEpoch) {
        throw recoveryError('ERR_RECOVERY_STATE', 'recovery marker and owner epoch disagree')
      }
      return {
        recoveryId: input.recoveryId,
        owner: input.owner,
        epoch: input.recoveryEpoch,
        deletedRecords: input.deletions.length,
        replayed: true,
        postBackupWritesRecovered: false,
      }
    }
    if (String(state.epoch) !== input.restoredEpoch) {
      throw recoveryError('ERR_RECOVERY_STATE', 'restored owner epoch does not match the recovery bundle')
    }

    const maxRow = (await trx.raw(
      `SELECT MAX(change_sequence) AS max_sequence FROM history_changes WHERE owner_identity_key = ?`,
      [input.owner],
    ))[0][0]
    let sequence = BigInt(String(state.next_sequence))
    if (maxRow?.max_sequence !== null && maxRow?.max_sequence !== undefined && sequence <= BigInt(String(maxRow.max_sequence))) {
      throw recoveryError('ERR_RECOVERY_STATE', 'restored owner sequence allocator is inconsistent')
    }
    if (sequence + BigInt(input.deletions.length) > UINT64_MAX + 1n) {
      throw recoveryError('ERR_RECOVERY_STATE', 'recovery deletion sequence would exceed uint64')
    }

    for (const receipt of input.deletions) {
      await trx.raw(`DELETE FROM history_records WHERE owner_identity_key = ? AND record_key = ?`, [input.owner, receipt.recordKey])
      const seq = sequence.toString()
      const deletedAt = mysqlInstant(receipt.deletedAt)
      await trx.raw(
        `INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version, deleted_at)
         VALUES (?, ?, ?, 'delete', 1, ?)`,
        [input.owner, seq, receipt.recordKey, deletedAt],
      )
      await trx.raw(
        `INSERT INTO history_tombstones (owner_identity_key, record_key, deleted_at, change_sequence)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE deleted_at = VALUES(deleted_at), change_sequence = VALUES(change_sequence)`,
        [input.owner, receipt.recordKey, deletedAt, seq],
      )
      sequence += 1n
    }

    await trx.raw(`UPDATE history_snapshots SET status = 'invalidated' WHERE owner_identity_key = ? AND status = 'active'`, [input.owner])
    await trx.raw(`DELETE FROM history_idempotency WHERE owner_identity_key = ?`, [input.owner])
    await trx.raw(
      `UPDATE history_owner_state SET epoch = ?, next_sequence = ?,
         record_count = (SELECT COUNT(*) FROM history_records WHERE owner_identity_key = ?),
         byte_count = (SELECT COALESCE(SUM(body_bytes), 0) FROM history_records WHERE owner_identity_key = ?)
       WHERE owner_identity_key = ?`,
      [input.recoveryEpoch, sequence.toString(), input.owner, input.owner, input.owner],
    )
    await trx.raw(
      `INSERT INTO history_audit_events (owner_identity_key, kind, record_key, detail)
       VALUES (?, 'restore_recovery', NULL, ?)`,
      [input.owner, marker],
    )
    return {
      recoveryId: input.recoveryId,
      owner: input.owner,
      epoch: input.recoveryEpoch,
      deletedRecords: input.deletions.length,
      replayed: false,
      postBackupWritesRecovered: false,
    }
  })
}
