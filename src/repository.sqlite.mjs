import {
  assertOwnerDirection,
  bodyHash,
  canonicalRecordKey,
  DELIVERY_STATES,
  isIdentityKey,
  LIMITS,
  validateEncryptedBody,
  validateEpoch,
  validateMessageBox,
  validateMessageId,
  utf8ByteLength,
} from './protocol.mjs'
import { verifyMigrationChecksums, verifySqliteSchema, verifySqliteVersion } from './migrations.mjs'
import {
  assertSnapshotBinding,
  boundPurgeParams,
  generateSnapshotId,
  matchesSnapshotFilter,
  snapshotExpiryIso,
  snapshotFilterHash,
  SNAPSHOT_FEED,
  SNAPSHOT_PURGE_BATCH,
  SNAPSHOT_STATUS,
  validateSnapshotFilter,
} from './snapshots.mjs'
import {
  canonicalParamsHash,
  createOwnerLocks,
  idempotencyConflict,
  nextSequenceString,
  rotateOwnerEpoch,
  sameImmutableRecord,
  validateArchiveInput,
  validateIdempotencyInput,
  validateStateMutationInput,
} from './repository-contract.mjs'
import {
  assertNoInternalRetentionGap,
  assertNoRetentionGap,
  boundFeedLimit,
  decodeSnapshotPosition,
  encodeSnapshotPosition,
  fitRecordsToPage,
  historyPageOverheadBytes,
  matchesFeedFilter,
  newChangesCursor,
  newSnapshotCursor,
  retentionCutoffIso,
  validateChangesPosition,
  validateFeedOwner,
  validateServerSecret,
  verifyChangesCursor,
  verifySnapshotCursor,
  FEED_START,
} from './feeds.mjs'

const DELIVERY = new Set(DELIVERY_STATES)
// Canonical decimal strings order numerically by length-then-lexicographic.
const SEQ_ORDER = 'LENGTH(change_sequence), change_sequence'

function nowIso(now) {
  return typeof now === 'function' ? now() : new Date().toISOString()
}

async function openDatabase(path) {
  const { DatabaseSync } = await import('node:sqlite')
  const { SQLITE_MIGRATION_CHAIN, EXPECTED_MIGRATION_CHECKSUMS, checksumMigration } = await import('./migrations.mjs')
  verifyMigrationChecksums()
  const db = new DatabaseSync(path ?? ':memory:')
  const knownVersions = new Set(SQLITE_MIGRATION_CHAIN.map(({ version }) => version))
  const migrationTableExists = Boolean(db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get())
  let hasChecksum = migrationTableExists && db.prepare(`PRAGMA table_info(schema_migrations)`).all().some((row) => row.name === 'checksum')
  const recordedRows = migrationTableExists
    ? db.prepare(hasChecksum ? `SELECT version, checksum FROM schema_migrations` : `SELECT version, '' AS checksum FROM schema_migrations`).all()
    : []
  const recorded = new Map(recordedRows.map((row) => [row.version, row.checksum ?? '']))
  const legacy004Checksum = '5ed9b94d1e40676e30ae81a7219d01e88c3602c6e9585d6febc42e09f898e41c'
  if (recorded.get('004-tombstones') === legacy004Checksum) {
    const migration = SQLITE_MIGRATION_CHAIN.find(({ version }) => version === '004-tombstones')
    db.exec(migration.sql)
    const repairedChecksum = EXPECTED_MIGRATION_CHECKSUMS['sqlite:004-tombstones']
    db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = '004-tombstones' AND checksum = ?`).run(repairedChecksum, legacy004Checksum)
    recorded.set('004-tombstones', repairedChecksum)
  }
  for (const version of recorded.keys()) {
    if (!knownVersions.has(version)) throw new Error(`migration history contains unknown version ${version}`)
  }
  let missingEarlier = null
  for (const { version, sql } of SQLITE_MIGRATION_CHAIN) {
    const key = `sqlite:${version}`
    const expected = EXPECTED_MIGRATION_CHECKSUMS[key] ?? checksumMigration(sql)
    if (!recorded.has(version)) {
      missingEarlier ??= version
      continue
    }
    if (missingEarlier) throw new Error(`migration history has recorded ${version} before ${missingEarlier}`)
    const checksum = recorded.get(version)
    if (checksum && checksum !== expected) {
      throw new Error(`migration history tampered for ${key}: recorded checksum differs from canonical`)
    }
    verifySqliteVersion(db, version, { allowMissingChecksum: !hasChecksum })
  }
  if (migrationTableExists && !hasChecksum) {
    db.exec(`ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''`)
    hasChecksum = true
  }
  for (const { version, sql } of SQLITE_MIGRATION_CHAIN) {
    const key = `sqlite:${version}`
    const expected = EXPECTED_MIGRATION_CHECKSUMS[key] ?? checksumMigration(sql)
    if (recorded.has(version)) {
      if (!recorded.get(version)) db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum = ''`).run(expected, version)
      continue
    }
    db.exec(sql)
    verifySqliteVersion(db, version)
    db.prepare(`INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)`).run(version, expected)
  }
  verifySqliteSchema(db)
  return db
}

function toRecord(row) {
  if (!row) return null
  return {
    owner: row.owner_identity_key,
    recordKey: row.record_key,
    messageId: row.message_id,
    messageBox: row.message_box,
    direction: row.direction,
    sender: row.sender,
    recipient: row.recipient,
    body: row.body,
    bodyHash: row.body_hash,
    bodyBytes: Number(row.body_bytes),
    deliveryState: row.delivery_state,
    revision: String(row.revision),
    changeSequence: String(row.change_sequence),
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    expiresAt: row.expires_at,
  }
}

/**
 * Persistent SQLite repository. Every mutation commits through one
 * `BEGIN IMMEDIATE` transaction against SQL tables; reads query SQL
 * directly. There is no memory model to fall back to: close and reopen
 * the same path and all state survives.
 */
export async function createSqliteStore({ path = ':memory:', limits = {}, now } = {}) {
  const L = { ...LIMITS, ...limits }
  const db = await openDatabase(path)
  const withOwnerLock = createOwnerLocks()
  let commitFailureOnce = false
  const failOnce = { archiveBatch: false, patchState: false, deleteRecord: false, deleteAll: false, snapshotCleanup: false }

  function checkIdempotencyLocked({ owner, key, operation, params }) {
    if (key === undefined) return null
    validateIdempotencyInput(key)
    const paramsHash = canonicalParamsHash(params)
    const existing = db.prepare(`SELECT operation, params_hash, result_json FROM history_idempotency WHERE owner_identity_key = ? AND idempotency_key = ?`).get(owner, key)
    if (!existing) return { paramsHash, existing: null }
    if (existing.operation !== operation || existing.params_hash !== paramsHash) {
      idempotencyConflict()
    }
    return { paramsHash, existing: JSON.parse(existing.result_json) }
  }

  function storeIdempotencyLocked({ owner, key, operation, paramsHash, result }) {
    db.prepare(`INSERT INTO history_idempotency (owner_identity_key, idempotency_key, operation, params_hash, result_json) VALUES (?, ?, ?, ?, ?)`).run(
      owner,
      key,
      operation,
      paramsHash,
      JSON.stringify(result),
    )
  }

  function consumeFailureLocked(op) {
    if (failOnce[op]) {
      failOnce[op] = false
      const error = new Error(`injected ${op} failure`)
      error.code = 'ERR_UNAVAILABLE'
      throw error
    }
  }

  function ensureOwner(owner) {
    db.prepare(
      `INSERT INTO history_owner_state (owner_identity_key, epoch, next_sequence, record_count, byte_count)
       VALUES (?, 'gen-1', '1', 0, 0) ON CONFLICT(owner_identity_key) DO NOTHING`,
    ).run(owner)
    db.prepare(`INSERT INTO history_resource_locks (owner_identity_key) VALUES (?) ON CONFLICT(owner_identity_key) DO NOTHING`).run(owner)
  }

  function readOwnerLocked(owner) {
    const row = db.prepare(`SELECT epoch, next_sequence, record_count, byte_count FROM history_owner_state WHERE owner_identity_key = ?`).get(owner)
    if (!row) throw new Error('owner state missing inside transaction')
    return { epoch: row.epoch, nextSequence: String(row.next_sequence), recordCount: Number(row.record_count), byteCount: Number(row.byte_count) }
  }

  function latestChangeKind(owner, recordKey) {
    const row = db
      .prepare(`SELECT kind FROM history_changes WHERE owner_identity_key = ? AND record_key = ? ORDER BY ${SEQ_ORDER} DESC LIMIT 1`)
      .get(owner, recordKey)
    return row?.kind ?? null
  }

  function auditLocked(owner, kind, recordKey, detail) {
    db.prepare(`INSERT INTO history_audit_events (owner_identity_key, kind, record_key, detail) VALUES (?, ?, ?, ?)`).run(owner, kind, recordKey, detail)
    db.prepare(
      `DELETE FROM history_audit_events WHERE owner_identity_key = ? AND id NOT IN
       (SELECT id FROM history_audit_events WHERE owner_identity_key = ? ORDER BY id DESC LIMIT 200)`,
    ).run(owner, owner)
  }

  async function archiveBatch({ owner, epoch, records }) {
    return withOwnerLock(owner, async () => {
      if (!Array.isArray(records) || records.length === 0) {
        const e = new TypeError('records must be a non-empty array')
        e.code = 'ERR_INVALID_RECORD'
        throw e
      }
      if (records.length > L.MAX_BATCH_RECORDS) {
        const e = new RangeError('batch exceeds record bound')
        e.code = 'ERR_REQUEST_TOO_LARGE'
        throw e
      }
      let batchBytes = 0
      for (const r of records) batchBytes += typeof r?.body === 'string' ? utf8ByteLength(r.body) : 0
      if (batchBytes > L.MAX_BATCH_BYTES) {
        const e = new RangeError('batch exceeds byte bound')
        e.code = 'ERR_REQUEST_TOO_LARGE'
        throw e
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        ensureOwner(owner)
        const st = readOwnerLocked(owner)
        if (epoch !== st.epoch) {
          db.exec('ROLLBACK')
          return {
            epoch: st.epoch,
            committed: false,
            outcomes: records.map((r, index) => ({ index, recordKey: r?.recordKey ?? null, outcome: 'epochChanged', errorCode: 'ERR_EPOCH_CHANGED' })),
          }
        }
        let projectedCount = st.recordCount
        let projectedBytes = st.byteCount
        const planned = []
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index]
          const check = validateArchiveInput({ owner, epoch, record, ownerEpoch: st.epoch })
          if (!check.valid) {
            planned.push({
              index,
              recordKey: record?.recordKey ?? null,
              outcome: check.code === 'ERR_EPOCH_CHANGED' ? 'epochChanged' : 'invalid',
              errorCode: check.code,
            })
            continue
          }
          const existing = db.prepare(`SELECT * FROM history_records WHERE owner_identity_key = ? AND record_key = ?`).get(owner, check.recordKey)
          if (existing) {
            const left = {
              messageId: existing.message_id,
              messageBox: existing.message_box,
              direction: existing.direction,
              sender: existing.sender,
              recipient: existing.recipient,
              bodyHash: existing.body_hash,
              body: existing.body,
            }
            if (sameImmutableRecord(left, { ...record, bodyHash: check.bodyHash })) {
              planned.push({ index, recordKey: check.recordKey, outcome: 'alreadyPresent', bodyHash: check.bodyHash })
            } else {
              auditLocked(owner, 'immutable-conflict', check.recordKey, 'same key different content')
              planned.push({ index, recordKey: check.recordKey, outcome: 'conflict', errorCode: 'ERR_IMMUTABLE_CONFLICT' })
            }
            continue
          }
          if (latestChangeKind(owner, check.recordKey) === 'delete') {
            planned.push({ index, recordKey: check.recordKey, outcome: 'deleted', errorCode: 'ERR_INVALID_RECORD' })
            continue
          }
          // Persistent deletion fence (mbs-8g5.2.4.2): tombstones survive
          // change-retention purge so reupload cannot resurrect ciphertext.
          {
            const tomb = db.prepare(`SELECT 1 AS one FROM history_tombstones WHERE owner_identity_key = ? AND record_key = ?`).get(owner, check.recordKey)
            if (tomb) {
              planned.push({ index, recordKey: check.recordKey, outcome: 'deleted', errorCode: 'ERR_INVALID_RECORD' })
              continue
            }
          }
          if (projectedCount + 1 > L.MAX_RECORDS_PER_OWNER || projectedBytes + check.bodyBytes > L.MAX_BYTES_PER_OWNER) {
            planned.push({ index, recordKey: check.recordKey, outcome: 'quotaExceeded', errorCode: 'ERR_QUOTA_EXCEEDED' })
            continue
          }
          projectedCount += 1
          projectedBytes += check.bodyBytes
          planned.push({ index, recordKey: check.recordKey, outcome: 'stored', bodyHash: check.bodyHash, bodyBytes: check.bodyBytes, validated: { ...record } })
        }

        let seq = BigInt(st.nextSequence)
        const at = nowIso(now)
        const insertRecord = db.prepare(
          `INSERT INTO history_records
           (owner_identity_key, record_key, message_id, message_box, direction, sender, recipient, body, body_hash, body_bytes, delivery_state, revision, change_sequence, created_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', ?, ?, ?)`,
        )
        const insertChange = db.prepare(
          `INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version) VALUES (?, ?, ?, 'upsert', '1')`,
        )
        const insertDetail = db.prepare(
          `INSERT OR IGNORE INTO history_change_details (owner_identity_key, change_sequence, delivery_state) VALUES (?, ?, ?)`,
        )
        for (const item of planned.filter((p) => p.outcome === 'stored')) {
          const cur = seq.toString()
          seq += 1n
          const src = item.validated
          const initialState = src.deliveryState ?? (src.direction === 'outbound' ? 'prepared' : 'received')
          try {
            insertRecord.run(
              owner,
              item.recordKey,
              src.messageId,
              src.messageBox,
              src.direction,
              src.sender,
              src.recipient,
              src.body,
              item.bodyHash,
              item.bodyBytes,
              initialState,
              cur,
              at,
              at,
            )
          } catch (error) {
            if (error?.code === 'ERR_SQLITE_CONSTRAINT_PRIMARYKEY' || /UNIQUE|PRIMARY KEY/i.test(error?.message ?? '')) {
              const existing = db.prepare(`SELECT * FROM history_records WHERE owner_identity_key = ? AND record_key = ?`).get(owner, item.recordKey)
              const left = existing && {
                messageId: existing.message_id,
                messageBox: existing.message_box,
                direction: existing.direction,
                sender: existing.sender,
                recipient: existing.recipient,
                bodyHash: existing.body_hash,
                body: existing.body,
              }
              if (left && sameImmutableRecord(left, { ...src, bodyHash: item.bodyHash })) {
                item.outcome = 'alreadyPresent'
              } else {
                auditLocked(owner, 'immutable-conflict', item.recordKey, 'race duplicate')
                item.outcome = 'conflict'
                item.errorCode = 'ERR_IMMUTABLE_CONFLICT'
              }
              delete item.validated
              delete item.bodyBytes
              seq -= 1n
              projectedCount -= 1
              projectedBytes -= item.bodyBytes ?? 0
              continue
            }
            throw error
          }
          insertChange.run(owner, cur, item.recordKey)
          insertDetail.run(owner, cur, initialState)
          item.sequence = cur
          delete item.validated
        }
        db.prepare(`UPDATE history_owner_state SET next_sequence = ?, record_count = ?, byte_count = ? WHERE owner_identity_key = ?`).run(
          seq.toString(),
          projectedCount,
          projectedBytes,
          owner,
        )
        if (commitFailureOnce || failOnce.archiveBatch) {
          commitFailureOnce = false
          failOnce.archiveBatch = false
          db.exec('ROLLBACK')
          return {
            epoch: st.epoch,
            committed: false,
            outcomes: planned.map((p) =>
              p.outcome === 'stored' ? { index: p.index, recordKey: p.recordKey, outcome: 'failed', errorCode: 'ERR_UNAVAILABLE' } : p,
            ),
          }
        }
        db.exec('COMMIT')
        return { epoch: st.epoch, committed: true, outcomes: planned }
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        throw error
      }
    })
  }

  async function patchState({ owner, recordKey, newState, expectedRevision, idempotencyKey }) {
    // Validate the full mutation contract before BEGIN IMMEDIATE so omitted
    // CAS/idempotency fields cannot initialize or mutate owner state.
    validateStateMutationInput({ expectedRevision, idempotencyKey })
    return withOwnerLock(owner, async () => {
      if (!DELIVERY.has(newState)) {
        const e = new TypeError('unknown delivery state')
        e.code = 'ERR_INVALID_RECORD'
        throw e
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        ensureOwner(owner)
        const idem = checkIdempotencyLocked({ owner, key: idempotencyKey, operation: 'patchState', params: { recordKey, newState, expectedRevision: expectedRevision === undefined ? undefined : String(expectedRevision) } })
        if (idem?.existing) {
          db.exec('ROLLBACK')
          return { ...idem.existing, replayed: true }
        }
        consumeFailureLocked('patchState')
        if (latestChangeKind(owner, recordKey) === 'delete') {
          const e = new RangeError('record deleted; deletion wins')
          e.code = 'ERR_INVALID_RECORD'
          throw e
        }
        // Persistent fence: tombstone survives change purge.
        {
          const tomb = db.prepare(`SELECT 1 AS one FROM history_tombstones WHERE owner_identity_key = ? AND record_key = ?`).get(owner, recordKey)
          if (tomb) {
            const e = new RangeError('record deleted; deletion wins')
            e.code = 'ERR_INVALID_RECORD'
            throw e
          }
        }
        const row = db.prepare(`SELECT delivery_state, revision, change_sequence FROM history_records WHERE owner_identity_key = ? AND record_key = ?`).get(owner, recordKey)
        if (!row) {
          const e = new RangeError('record not found')
          e.code = 'ERR_INVALID_RECORD'
          throw e
        }
        const revision = String(row.revision)
        if (expectedRevision !== undefined && revision !== String(expectedRevision)) {
          const e = new RangeError('revision conflict')
          e.code = 'ERR_REVISION_CONFLICT'
          throw e
        }
        if (row.delivery_state === 'accepted' && newState !== 'accepted') {
          const e = new RangeError('accepted cannot downgrade')
          e.code = 'ERR_REVISION_CONFLICT'
          throw e
        }
        if (row.delivery_state === newState) {
          const result = { ok: true, recordKey, revision, sequence: String(row.change_sequence), deduped: true }
          if (idem) storeIdempotencyLocked({ owner, key: idempotencyKey, operation: 'patchState', paramsHash: idem.paramsHash, result })
          db.exec('COMMIT')
          return result
        }
        const st = readOwnerLocked(owner)
        const seq = st.nextSequence
        const nextRev = nextSequenceString(revision)
        db.prepare(`UPDATE history_records SET delivery_state = ?, revision = ?, change_sequence = ? WHERE owner_identity_key = ? AND record_key = ?`).run(
          newState,
          nextRev,
          seq,
          owner,
          recordKey,
        )
        db.prepare(`INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version) VALUES (?, ?, ?, 'state', ?)`).run(owner, seq, recordKey, nextRev)
        db.prepare(`INSERT OR IGNORE INTO history_change_details (owner_identity_key, change_sequence, delivery_state) VALUES (?, ?, ?)`).run(owner, seq, newState)
        db.prepare(`UPDATE history_owner_state SET next_sequence = ? WHERE owner_identity_key = ?`).run(nextSequenceString(seq), owner)
        const result = { ok: true, recordKey, revision: nextRev, sequence: seq }
        if (idem) storeIdempotencyLocked({ owner, key: idempotencyKey, operation: 'patchState', paramsHash: idem.paramsHash, result })
        db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        throw error
      }
    })
  }

  async function deleteRecord({ owner, recordKey, idempotencyKey }) {
    return withOwnerLock(owner, async () => {
      db.exec('BEGIN IMMEDIATE')
      try {
        ensureOwner(owner)
        const idem = checkIdempotencyLocked({ owner, key: idempotencyKey, operation: 'deleteRecord', params: { recordKey } })
        if (idem?.existing) {
          db.exec('ROLLBACK')
          return { ...idem.existing, replayed: true }
        }
        consumeFailureLocked('deleteRecord')
        const row = db.prepare(`SELECT body_bytes FROM history_records WHERE owner_identity_key = ? AND record_key = ?`).get(owner, recordKey)
        const everChanged = db.prepare(`SELECT 1 AS one FROM history_changes WHERE owner_identity_key = ? AND record_key = ? LIMIT 1`).get(owner, recordKey)
        const everTombstoned = db.prepare(`SELECT 1 AS one FROM history_tombstones WHERE owner_identity_key = ? AND record_key = ?`).get(owner, recordKey)
        if (!row && !everChanged && !everTombstoned) {
          const st0 = readOwnerLocked(owner)
          const result0 = { deleted: false, epoch: st0.epoch }
          if (idem) storeIdempotencyLocked({ owner, key: idempotencyKey, operation: 'deleteRecord', paramsHash: idem.paramsHash, result: result0 })
          db.exec('COMMIT')
          return result0
        }
        const st = readOwnerLocked(owner)
        const seq = st.nextSequence
        const at = nowIso(now)
        if (row) {
          db.prepare(`DELETE FROM history_records WHERE owner_identity_key = ? AND record_key = ?`).run(owner, recordKey)
          db.prepare(`UPDATE history_owner_state SET record_count = record_count - 1, byte_count = byte_count - ?, next_sequence = ? WHERE owner_identity_key = ?`).run(
            Number(row.body_bytes),
            nextSequenceString(seq),
            owner,
          )
        } else {
          db.prepare(`UPDATE history_owner_state SET next_sequence = ? WHERE owner_identity_key = ?`).run(nextSequenceString(seq), owner)
        }
        // Body-free delete event with canonical timestamp, never ciphertext.
        db.prepare(`INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version, deleted_at) VALUES (?, ?, ?, 'delete', '1', ?)`).run(owner, seq, recordKey, at)
        // Persistent fence beyond retention purge (mbs-8g5.2.4.2).
        db.prepare(`INSERT OR REPLACE INTO history_tombstones (owner_identity_key, record_key, deleted_at, change_sequence) VALUES (?, ?, ?, ?)`).run(owner, recordKey, at, seq)
        // Ciphertext is already purged above; dependent snapshots invalidate.
        invalidateSnapshotsForRecord(owner, st.epoch, recordKey)
        const result = { deleted: true, sequence: seq, epoch: st.epoch }
        if (idem) storeIdempotencyLocked({ owner, key: idempotencyKey, operation: 'deleteRecord', paramsHash: idem.paramsHash, result })
        db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        throw error
      }
    })
  }

  async function deleteAll({ owner, idempotencyKey, expectedEpoch }) {
    return withOwnerLock(owner, async () => {
      db.exec('BEGIN IMMEDIATE')
      try {
        // Check idempotency before the live-epoch CAS: an exact retry must
        // replay its committed result even after the original rotated epoch.
        const idem = checkIdempotencyLocked({ owner, key: idempotencyKey, operation: 'deleteAll', params: { expectedEpoch } })
        if (idem?.existing) {
          db.exec('ROLLBACK')
          return { ...idem.existing, replayed: true }
        }
        const stateRow = db.prepare(`SELECT epoch FROM history_owner_state WHERE owner_identity_key = ?`).get(owner)
        const currentEpoch = stateRow?.epoch ?? 'gen-1'
        if (expectedEpoch !== undefined && expectedEpoch !== currentEpoch) {
          db.exec('ROLLBACK')
          const error = new RangeError('epoch changed')
          error.code = 'ERR_EPOCH_CHANGED'
          throw error
        }
        consumeFailureLocked('deleteAll')
        ensureOwner(owner)
        db.prepare(`DELETE FROM history_records WHERE owner_identity_key = ?`).run(owner)
        db.prepare(`DELETE FROM history_changes WHERE owner_identity_key = ?`).run(owner)
        db.prepare(`DELETE FROM history_tombstones WHERE owner_identity_key = ?`).run(owner)
        db.prepare(`DELETE FROM history_change_details WHERE owner_identity_key = ?`).run(owner)
        db.prepare(`DELETE FROM history_change_boundaries WHERE owner_identity_key = ?`).run(owner)
        const st = readOwnerLocked(owner)
        const next = rotateOwnerEpoch(st.epoch)
        db.prepare(`UPDATE history_owner_state SET record_count = 0, byte_count = 0, epoch = ? WHERE owner_identity_key = ?`).run(next, owner)
        // Epoch rotation invalidates every snapshot bound to the old epoch.
        invalidateSnapshotsForEpoch(owner, st.epoch)
        const result = { epoch: next }
        if (idem) storeIdempotencyLocked({ owner, key: idempotencyKey, operation: 'deleteAll', paramsHash: idem.paramsHash, result })
        db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        throw error
      }
    })
  }

  function getUsage({ owner }) {
    const row = db.prepare(`SELECT epoch, next_sequence, record_count, byte_count FROM history_owner_state WHERE owner_identity_key = ?`).get(owner)
    if (!row) return { recordCount: 0, byteCount: 0, epoch: 'gen-1', nextSequence: '1' }
    return { recordCount: Number(row.record_count), byteCount: Number(row.byte_count), epoch: row.epoch, nextSequence: String(row.next_sequence) }
  }

  function getRecord({ owner, recordKey }) {
    return toRecord(db.prepare(`SELECT * FROM history_records WHERE owner_identity_key = ? AND record_key = ?`).get(owner, recordKey))
  }

  function listChanges({ owner }) {
    return db
      .prepare(`SELECT change_sequence AS sequence, record_key AS recordKey, kind, version, deleted_at AS deletedAt FROM history_changes WHERE owner_identity_key = ? ORDER BY ${SEQ_ORDER}`)
      .all(owner)
      .map((row) => {
        const out = { sequence: String(row.sequence), recordKey: row.recordKey, kind: row.kind, version: String(row.version) }
        if (row.deletedAt !== null && row.deletedAt !== undefined) out.deletedAt = String(row.deletedAt)
        return out
      })
  }

  function listDeleteEvents({ owner } = {}) {
    return db
      .prepare(`SELECT change_sequence AS sequence, record_key AS recordKey, deleted_at AS deletedAt FROM history_changes WHERE owner_identity_key = ? AND kind = 'delete' ORDER BY ${SEQ_ORDER}`)
      .all(owner)
      .map((row) => ({ recordKey: row.recordKey, sequence: String(row.sequence), deletedAt: String(row.deletedAt) }))
  }

  function injectCommitFailureOnce() {
    commitFailureOnce = true
  }

  function injectFailureOnce(operation) {
    if (!(operation in failOnce)) {
      const e = new TypeError(`unknown operation ${operation}`)
      e.code = 'ERR_INVALID_RECORD'
      throw e
    }
    failOnce[operation] = true
  }

  function invalidateSnapshotsForRecord(owner, epoch, recordKey) {
    db.prepare(
      `UPDATE history_snapshots SET status = 'invalidated'
       WHERE owner_identity_key = ? AND epoch = ? AND status = 'active'
       AND EXISTS (SELECT 1 FROM history_snapshot_items WHERE snapshot_id = history_snapshots.snapshot_id AND record_key = ?)`,
    ).run(owner, epoch, recordKey)
  }

  function invalidateSnapshotsForEpoch(owner, epoch) {
    db.prepare(`UPDATE history_snapshots SET status = 'invalidated' WHERE owner_identity_key = ? AND epoch = ? AND status = 'active'`).run(owner, epoch)
  }

  /**
   * Bounded snapshot materialization. W is fixed atomically to the current
   * max committed sequence inside the same IMMEDIATE transaction that reads
   * the rows, so interleaved commits cannot shift membership mid-capture.
   * Members are records whose creation (first upsert change) is at or
   * before W; their materialized revision/state/sequence is the row state
   * observed in that transaction. No ciphertext is copied.
   */
  async function createSnapshot({ owner, filter = {} } = {}) {
    return withOwnerLock(owner, async () => {
      validateSnapshotFilter(filter)
      db.exec('BEGIN IMMEDIATE')
      try {
        ensureOwner(owner)
        const st = readOwnerLocked(owner)
        const w = st.nextSequence === '1' ? '0' : (BigInt(st.nextSequence) - 1n).toString()
        let sql = `SELECT r.*, c.change_sequence AS created_seq FROM history_records r
                   JOIN history_changes c ON c.owner_identity_key = r.owner_identity_key AND c.record_key = r.record_key AND c.kind = 'upsert'
                   WHERE r.owner_identity_key = ?`
        const params = [owner]
        if (filter.direction !== undefined) {
          sql += ` AND r.direction = ?`
          params.push(filter.direction)
        }
        if (filter.messageBox !== undefined) {
          sql += ` AND r.message_box = ?`
          params.push(filter.messageBox)
        }
        if (filter.participant !== undefined) {
          sql += ` AND (r.sender = ? OR r.recipient = ?)`
          params.push(filter.participant, filter.participant)
        }
        const wBig = BigInt(w)
        const members = []
        for (const row of db.prepare(sql).all(...params)) {
          if (BigInt(row.created_seq) > wBig) continue // created after W: not a member
          const record = toRecord(row)
          if (!matchesSnapshotFilter(record, filter)) continue
          members.push(record)
        }
        members.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.recordKey < b.recordKey ? -1 : 1))
        const snapshotId = generateSnapshotId()
        const filterHash = snapshotFilterHash(filter)
        const expiresAt = snapshotExpiryIso()
        db.prepare(
          `INSERT INTO history_snapshots (snapshot_id, owner_identity_key, epoch, filter_hash, watermark, status, expires_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        ).run(snapshotId, owner, st.epoch, filterHash, w, expiresAt)
        const insertItem = db.prepare(
          `INSERT INTO history_snapshot_items (snapshot_id, record_key, revision_at_w, delivery_state_at_w, change_sequence_at_w, created_at_at_w)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        for (const member of members) {
          insertItem.run(snapshotId, member.recordKey, member.revision, member.deliveryState, member.changeSequence, member.createdAt)
        }
        db.exec('COMMIT')
        return { snapshotId, epoch: st.epoch, feed: SNAPSHOT_FEED, filterHash, watermark: w, memberCount: members.length, status: SNAPSHOT_STATUS.ACTIVE }
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        throw error
      }
    })
  }

  function toSnapshotMeta(row) {
    if (!row) return null
    return {
      snapshotId: row.snapshot_id,
      owner: row.owner_identity_key,
      epoch: row.epoch,
      feed: SNAPSHOT_FEED,
      filterHash: row.filter_hash,
      watermark: String(row.watermark),
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  function readSnapshotMeta(snapshotId) {
    return toSnapshotMeta(db.prepare(`SELECT * FROM history_snapshots WHERE snapshot_id = ?`).get(snapshotId))
  }

  function getSnapshot({ snapshotId, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark } = {}) {
    if (owner === undefined) {
      const error = new TypeError('owner is required for snapshot reads')
      error.code = 'ERR_INVALID_RECORD'
      throw error
    }
    const meta = readSnapshotMeta(snapshotId)
    if (!meta) return null
    assertSnapshotBinding({ stored: meta, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark })
    return meta
  }

  function toSnapshotItem(row) {
    return {
      recordKey: row.record_key,
      revisionAtW: String(row.revision_at_w),
      deliveryStateAtW: row.delivery_state_at_w,
      changeSequenceAtW: String(row.change_sequence_at_w),
      createdAtAtW: row.created_at_at_w,
    }
  }

  /**
   * Keyset page over materialized items. Binding is verified before status or
   * membership is returned. Non-active snapshots report their status with no
   * items: the client must restart, never read stale members.
   */
  function listSnapshotMembers({ snapshotId, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark, limit = 100, after } = {}) {
    if (owner === undefined) {
      const error = new TypeError('owner is required for snapshot reads')
      error.code = 'ERR_INVALID_RECORD'
      throw error
    }
    const meta = readSnapshotMeta(snapshotId)
    if (!meta) return null
    assertSnapshotBinding({ stored: meta, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark })
    if (meta.status !== SNAPSHOT_STATUS.ACTIVE) return { status: meta.status, items: [] }
    if (meta.expiresAt !== undefined && meta.expiresAt !== null && !Number.isNaN(Date.parse(meta.expiresAt)) && Date.parse(meta.expiresAt) <= Date.now()) {
      return { status: meta.status, items: [] }
    }
    const bounded = Math.max(1, Math.min(Number(limit) || 100, LIMITS.MAX_PAGE_RECORDS))
    let sql = `SELECT * FROM history_snapshot_items WHERE snapshot_id = ?`
    const params = [snapshotId]
    if (after?.createdAtAtW !== undefined && after?.recordKey !== undefined) {
      sql += ` AND ((created_at_at_w > ?) OR (created_at_at_w = ? AND record_key > ?))`
      params.push(after.createdAtAtW, after.createdAtAtW, after.recordKey)
    }
    sql += ` ORDER BY created_at_at_w, record_key LIMIT ?`
    params.push(bounded)
    return { status: meta.status, items: db.prepare(sql).all(...params).map(toSnapshotItem) }
  }

  /**
   * Bounded purge (mbs-8g5.2.3.3.1): each invocation performs no more than the
   * documented total item/snapshot work, reports hasMore continuation, and
   * eventually completes across repeated calls. Expired or invalidated
   * snapshots lose items in capped batches; snapshot rows are removed only
   * once expired and empty (invalidated but unexpired rows remain as restart
   * signals).
   */
  function purgeExpiredSnapshots({ nowIso: now = new Date().toISOString(), batchSize, maxItems, maxSnapshots } = {}) {
    if (failOnce.snapshotCleanup) {
      failOnce.snapshotCleanup = false
      const error = new Error('injected snapshotCleanup failure')
      error.code = 'ERR_UNAVAILABLE'
      throw error
    }
    const { batch: bounded, maxItems: itemBudget, maxSnapshots: snapBudget } = boundPurgeParams({ batchSize, maxItems, maxSnapshots })
    // Select at most the snapshot budget before any membership count/delete.
    // A full batch conservatively reports continuation; the next call selects
    // the next deterministic anchors without an unbounded due-row scan.
    const targets = db
      .prepare(`SELECT s.snapshot_id
                  FROM history_snapshots s
                 WHERE s.expires_at <= ?
                    OR (s.status = 'invalidated' AND EXISTS (SELECT 1 FROM history_snapshot_items i WHERE i.snapshot_id = s.snapshot_id))
                 ORDER BY s.expires_at, s.snapshot_id LIMIT ?`)
      .all(now, snapBudget)
      .map((row) => row.snapshot_id)
    let purgedItems = 0
    let itemAllowance = itemBudget
    const deleteItems = db.prepare(
      `DELETE FROM history_snapshot_items WHERE rowid IN (SELECT rowid FROM history_snapshot_items WHERE snapshot_id = ? LIMIT ?)`,
    )
    for (const snapshotId of targets) {
      if (itemAllowance <= 0) break
      while (itemAllowance > 0) {
        const take = Math.min(bounded, itemAllowance)
        const info = deleteItems.run(snapshotId, take)
        const removed = Number(info.changes)
        purgedItems += removed
        itemAllowance -= removed
        if (removed < take) break
        if (removed === 0) break
      }
      const remaining = db.prepare(`SELECT 1 AS one FROM history_snapshot_items WHERE snapshot_id = ? LIMIT 1`).get(snapshotId)
      if (remaining) break // budget exhausted mid-snapshot: continuation on next call
    }
    // Delete only selected expired anchors once their items are empty. This
    // keeps total anchor mutations within the same maxSnapshots selection.
    let purgedSnapshots = 0
    for (const snapshotId of targets) {
      if (itemAllowance <= 0) break
      const meta = db.prepare(`SELECT expires_at FROM history_snapshots WHERE snapshot_id = ?`).get(snapshotId)
      if (!meta || meta.expires_at > now) continue
      const remaining = db.prepare(`SELECT 1 AS one FROM history_snapshot_items WHERE snapshot_id = ? LIMIT 1`).get(snapshotId)
      if (!remaining) purgedSnapshots += Number(db.prepare(`DELETE FROM history_snapshots WHERE snapshot_id = ?`).run(snapshotId).changes)
    }
    const hasMore = itemAllowance <= 0 || targets.length >= snapBudget
    return { purgedItems, purgedSnapshots, examinedSnapshots: targets.length, hasMore }
  }

  function indexEvidence() {
    const explain = (sql, params = []) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    return {
      ownerSeq: explain(`SELECT * FROM history_records WHERE owner_identity_key = ? AND change_sequence = ?`, ['owner', '1']),
      ownerBox: explain(`SELECT * FROM history_records WHERE owner_identity_key = ? AND message_box = ?`, ['owner', 'inbox']),
      ownerDir: explain(`SELECT * FROM history_records WHERE owner_identity_key = ? AND direction = ?`, ['owner', 'inbound']),
      changesSeq: explain(`SELECT * FROM history_changes WHERE owner_identity_key = ? AND change_sequence > ? ORDER BY change_sequence`, ['owner', '0']),
    }
  }

  function close() {
    db.close()
  }

  function currentUsage(owner) {
    const row = db.prepare(`SELECT epoch, next_sequence FROM history_owner_state WHERE owner_identity_key = ?`).get(owner)
    if (!row) return { epoch: 'gen-1', nextSequence: '1' }
    return { epoch: row.epoch, nextSequence: String(row.next_sequence) }
  }

  function earliestChangeSequence(owner) {
    const row = db.prepare(`SELECT change_sequence FROM history_changes WHERE owner_identity_key = ? ORDER BY ${SEQ_ORDER} LIMIT 1`).get(owner)
    return row ? String(row.change_sequence) : null
  }

  function allChangesOrdered(owner) {
    return db.prepare(
      `SELECT c.change_sequence AS sequence, c.record_key AS recordKey, c.kind, c.version, c.deleted_at AS deletedAt, c.created_at AS createdAt, d.delivery_state AS deliveryState
         FROM history_changes c LEFT JOIN history_change_details d
           ON d.owner_identity_key = c.owner_identity_key AND d.change_sequence = c.change_sequence
        WHERE c.owner_identity_key = ? ORDER BY LENGTH(c.change_sequence), c.change_sequence`,
    ).all(owner)
  }

  function findLatestDeleteSql(owner, recordKey) {
    return db.prepare(`SELECT change_sequence AS sequence, deleted_at AS deletedAt FROM history_changes WHERE owner_identity_key = ? AND record_key = ? AND kind = 'delete' ORDER BY ${SEQ_ORDER} DESC LIMIT 1`).get(owner, recordKey) ?? null
  }

  /**
   * Browse: live keyset over (createdAt, recordKey). Non-authoritative.
   */
  function listBrowse({ owner, filter = {}, limit = 100, after } = {}) {
    validateFeedOwner(owner)
    validateSnapshotFilter(filter)
    const bounded = boundFeedLimit(limit)
    let sql = `SELECT * FROM history_records WHERE owner_identity_key = ?`
    const params = [owner]
    if (filter.direction !== undefined) {
      sql += ` AND direction = ?`
      params.push(filter.direction)
    }
    if (filter.messageBox !== undefined) {
      sql += ` AND message_box = ?`
      params.push(filter.messageBox)
    }
    if (filter.participant !== undefined) {
      sql += ` AND (sender = ? OR recipient = ?)`
      params.push(filter.participant, filter.participant)
    }
    if (after?.createdAt !== undefined && after?.recordKey !== undefined) {
      sql += ` AND ((created_at > ?) OR (created_at = ? AND record_key > ?))`
      params.push(after.createdAt, after.createdAt, after.recordKey)
    }
    sql += ` ORDER BY created_at, record_key LIMIT ?`
    params.push(bounded)
    const rows = db.prepare(sql).all(...params).map(toRecord).filter((r) => matchesFeedFilter(r, filter))
    const last = rows[rows.length - 1]
    return { items: rows, nextAfter: rows.length === bounded && last ? { createdAt: last.createdAt, recordKey: last.recordKey } : null }
  }

  /**
   * Authoritative changes in (C,W] with HMAC cursors. See memory adapter for
   * the convergence contract (fixed W, sequence order, early deletes).
   */
  function listChangesPage({ owner, serverSecret, cursor = null, afterSequence, expectedEpoch, limit = 100, filter = {}, nowSeconds, nowIso: nowIsoValue, ttlSeconds } = {}) {
    validateFeedOwner(owner)
    validateServerSecret(serverSecret)
    validateSnapshotFilter(filter)
    const filterDigest = snapshotFilterHash(filter)
    const bounded = boundFeedLimit(limit)
    const nowSec = nowSeconds ?? Math.floor(Date.now() / 1000)
    const serverTime = nowIsoValue ?? nowIso(now) ?? new Date().toISOString()
    const usage = currentUsage(owner)
    let W
    let C
    let epoch
    if ((afterSequence === undefined) !== (expectedEpoch === undefined)) {
      const e = new Error('afterSequence and expectedEpoch must be supplied together')
      e.code = 'ERR_INVALID_CURSOR'
      throw e
    }
    const explicitCheckpoint = afterSequence !== undefined
    if (explicitCheckpoint && cursor !== null && cursor !== undefined) {
      const e = new Error('cursor and checkpoint mode are mutually exclusive')
      e.code = 'ERR_INVALID_CURSOR'
      throw e
    }
    if (explicitCheckpoint) {
      validateChangesPosition(afterSequence)
      if (expectedEpoch !== usage.epoch) {
        const e = new Error('epoch changed; take a full snapshot')
        e.code = 'ERR_EPOCH_CHANGED'
        throw e
      }
      W = usage.nextSequence === '1' ? '0' : (BigInt(usage.nextSequence) - 1n).toString()
      C = afterSequence
      epoch = usage.epoch
      if (BigInt(C) > BigInt(W)) {
        const e = new Error('checkpoint is beyond the current watermark')
        e.code = 'ERR_INVALID_CURSOR'
        throw e
      }
    } else if (cursor === null || cursor === undefined) {
      W = usage.nextSequence === '1' ? '0' : (BigInt(usage.nextSequence) - 1n).toString()
      C = FEED_START
      epoch = usage.epoch
    } else {
      const payload = verifyChangesCursor(cursor, { serverSecret, owner, expectedEpoch: usage.epoch, expectedFilterDigest: filterDigest, nowSeconds: nowSec })
      W = String(payload.w)
      C = String(payload.p)
      epoch = String(payload.epoch)
      validateChangesPosition(C)
    }
    const boundary = db.prepare(`SELECT resync_through_sequence FROM history_change_boundaries WHERE owner_identity_key = ?`).get(owner)
    if (boundary && BigInt(C) < BigInt(String(boundary.resync_through_sequence)) && BigInt(W) > BigInt(C)) {
      const e = new Error('legacy history cannot be reconstructed exactly; take a full snapshot')
      e.code = 'ERR_CURSOR_EXPIRED'
      throw e
    }
    const earliest = earliestChangeSequence(owner)
    if (C !== FEED_START || explicitCheckpoint) {
      assertNoRetentionGap({ position: C, earliest })
      if (earliest === null && C !== W) {
        const e = new Error('cursor outside retained history; take a full snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
    }
    const ordered = allChangesOrdered(owner).filter((c) => BigInt(String(c.sequence)) > BigInt(C) && BigInt(String(c.sequence)) <= BigInt(W))
    const scanned = ordered.slice(0, bounded)
    assertNoInternalRetentionGap({ position: C, watermark: W, sequences: scanned.map((c) => String(c.sequence)), bounded, explicitCheckpoint })
    if (scanned.length === 0) {
      return { records: [], nextCursor: null, checkpoint: W, hasMore: false, watermark: W, epoch, serverTime }
    }
    const candidates = []
    const candidateSeq = []
    for (const c of scanned) {
      const seq = String(c.sequence)
      if (c.kind === 'delete') {
        candidates.push({ recordKey: c.recordKey, sequence: seq, deletedAt: c.deletedAt !== null && c.deletedAt !== undefined ? String(c.deletedAt) : new Date().toISOString() })
        candidateSeq.push(seq)
        continue
      }
      if (c.deliveryState === null || c.deliveryState === undefined) {
        const e = new Error('change detail unavailable; take a full snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
      const live = getRecord({ owner, recordKey: c.recordKey })
      if (!live) {
        const del = findLatestDeleteSql(owner, c.recordKey)
        if (del && BigInt(String(del.sequence)) > BigInt(W)) {
          candidates.push({ recordKey: c.recordKey, sequence: String(del.sequence), deletedAt: del.deletedAt !== null ? String(del.deletedAt) : new Date().toISOString() })
          candidateSeq.push(seq)
        }
        continue
      }
      if (!matchesFeedFilter(live, filter)) continue
      // Event versioning (mbs-8g5.2.4.3): fixed-W pages carry the event's
      // revision/state/sequence, never the current live row.
      candidates.push({
        ...live,
        deliveryState: c.deliveryState,
        revision: String(c.version),
        changeSequence: seq,
      })
      candidateSeq.push(seq)
    }
    const budgetCursor = newChangesCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: W, ttlSeconds, nowSeconds: nowSec })
    const overheadBytes = historyPageOverheadBytes({ records: [], nextCursor: budgetCursor, checkpoint: W, hasMore: true, watermark: W, epoch, serverTime })
    const { admitted } = fitRecordsToPage({ records: candidates, limit: bounded, overheadBytes })
    if (admitted.length < candidates.length) {
      let lastIdx = -1
      let count = 0
      for (let i = 0; i < candidates.length && count < admitted.length; i += 1) {
        if (candidates[i] === admitted[count]) {
          lastIdx = i
          count += 1
        }
      }
      const checkpoint = lastIdx >= 0 ? candidateSeq[lastIdx] : C
      const nextCursor = newChangesCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: checkpoint, ttlSeconds, nowSeconds: nowSec })
      return { records: admitted, nextCursor, checkpoint, hasMore: true, watermark: W, epoch, serverTime }
    }
    const checkpoint = String(scanned[scanned.length - 1].sequence)
    const hasMore = BigInt(checkpoint) < BigInt(W)
    const nextCursor = hasMore ? newChangesCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: checkpoint, ttlSeconds, nowSeconds: nowSec }) : null
    return { records: admitted, nextCursor, checkpoint: hasMore ? checkpoint : W, hasMore, watermark: W, epoch, serverTime }
  }

  /**
   * Authoritative snapshot HistoryPage at fixed W with HMAC cursors.
   */
  function listSnapshotPage({ owner, serverSecret, snapshotId, cursor = null, limit = 100, nowSeconds, nowIso: nowIsoValue, ttlSeconds } = {}) {
    validateFeedOwner(owner)
    validateServerSecret(serverSecret)
    const bounded = boundFeedLimit(limit)
    const nowSec = nowSeconds ?? Math.floor(Date.now() / 1000)
    const serverTime = nowIsoValue ?? nowIso(now) ?? new Date().toISOString()
    const meta = readSnapshotMeta(snapshotId)
    if (!meta) return null
    assertSnapshotBinding({ stored: meta, owner })
    const W = String(meta.watermark)
    const epoch = String(meta.epoch)
    const filterDigest = String(meta.filterHash ?? '')
    // Cursor integrity first (mbs-8g5.2.4.6): tampered continuations fail as
    // ERR_INVALID_CURSOR even on invalidated/expired snapshots.
    let position = FEED_START
    if (cursor !== null && cursor !== undefined) {
      const payload = verifySnapshotCursor(cursor, { serverSecret, owner, expectedEpoch: epoch, expectedFilterDigest: filterDigest, nowSeconds: nowSec })
      if (String(payload.w) !== W) {
        const e = new TypeError('snapshot watermark mismatch')
        e.code = 'ERR_INVALID_CURSOR'
        throw e
      }
      position = String(payload.p)
      if (position !== FEED_START) decodeSnapshotPosition(position)
    }
    if (meta.status !== SNAPSHOT_STATUS.ACTIVE) {
      const e = new Error('snapshot invalidated; take a new snapshot')
      e.code = 'ERR_CURSOR_EXPIRED'
      throw e
    }
    if (meta.expiresAt !== undefined && meta.expiresAt !== null) {
      const expMs = Date.parse(meta.expiresAt)
      if (!Number.isNaN(expMs) && expMs <= Date.parse(serverTime)) {
        const e = new Error('snapshot expired; take a new snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
    }
    let sql = `SELECT * FROM history_snapshot_items WHERE snapshot_id = ?`
    const params = [snapshotId]
    if (position !== FEED_START) {
      const decoded = decodeSnapshotPosition(position)
      sql += ` AND ((created_at_at_w > ?) OR (created_at_at_w = ? AND record_key > ?))`
      params.push(decoded.createdAtAtW, decoded.createdAtAtW, decoded.recordKey)
    }
    sql += ` ORDER BY created_at_at_w, record_key LIMIT ?`
    params.push(bounded + 1)
    const rows = db.prepare(sql).all(...params)
    const resolved = []
    for (const row of rows) {
      const live = getRecord({ owner, recordKey: row.record_key })
      if (!live) {
        const e = new Error('snapshot invalidated; take a new snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
      if (live.expiresAt !== undefined && live.expiresAt !== null) {
        const recExp = Date.parse(live.expiresAt)
        if (!Number.isNaN(recExp) && recExp <= Date.parse(serverTime)) {
          const e = new Error('snapshot invalidated; take a new snapshot')
          e.code = 'ERR_CURSOR_EXPIRED'
          throw e
        }
      }
      resolved.push({
        owner: live.owner,
        recordKey: live.recordKey,
        messageId: live.messageId,
        messageBox: live.messageBox,
        direction: live.direction,
        sender: live.sender,
        recipient: live.recipient,
        body: live.body,
        bodyHash: live.bodyHash,
        bodyBytes: live.bodyBytes,
        deliveryState: row.delivery_state_at_w,
        revision: String(row.revision_at_w),
        changeSequence: String(row.change_sequence_at_w),
        createdAt: row.created_at_at_w,
        archivedAt: live.archivedAt,
        expiresAt: live.expiresAt ?? null,
      })
    }
    // Final invalidation check (mbs-8g5.2.4.1): fail closed if a deletion
    // committed between the opening read and the body fetches.
    {
      const fresh = readSnapshotMeta(snapshotId)
      if (!fresh || fresh.status !== SNAPSHOT_STATUS.ACTIVE) {
        const e = new Error('snapshot invalidated; take a new snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
      if (fresh.expiresAt !== undefined && fresh.expiresAt !== null) {
        const expMs = Date.parse(fresh.expiresAt)
        if (!Number.isNaN(expMs) && expMs <= Date.parse(serverTime)) {
          const e = new Error('snapshot expired; take a new snapshot')
          e.code = 'ERR_CURSOR_EXPIRED'
          throw e
        }
      }
    }
    const budgetLast = resolved[resolved.length - 1]
    const budgetCursor = budgetLast ? newSnapshotCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: encodeSnapshotPosition({ createdAtAtW: budgetLast.createdAt, recordKey: budgetLast.recordKey }), ttlSeconds, nowSeconds: nowSec }) : null
    const overheadBytes = historyPageOverheadBytes({ records: [], nextCursor: budgetCursor, checkpoint: W, hasMore: Boolean(budgetCursor), watermark: W, epoch, serverTime })
    const { admitted } = fitRecordsToPage({ records: resolved, limit: bounded, overheadBytes })
    const hasMore = admitted.length < resolved.length
    let nextCursor = null
    if (hasMore) {
      const last = admitted[admitted.length - 1]
      const pos = encodeSnapshotPosition({ createdAtAtW: last.createdAt, recordKey: last.recordKey })
      nextCursor = newSnapshotCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: pos, ttlSeconds, nowSeconds: nowSec })
    }
    return { records: admitted, nextCursor, checkpoint: W, hasMore, watermark: W, epoch, serverTime }
  }

  function getStorageStats({ owner } = {}) {
    validateFeedOwner(owner)
    const usage = getUsage({ owner })
    const changeCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM history_changes WHERE owner_identity_key = ?`).get(owner).n)
    const snapshotCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM history_snapshots WHERE owner_identity_key = ?`).get(owner).n)
    const itemRow = db.prepare(`SELECT COUNT(*) AS n FROM history_snapshot_items WHERE snapshot_id IN (SELECT snapshot_id FROM history_snapshots WHERE owner_identity_key = ?)`).get(owner)
    const tombstoneCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM history_tombstones WHERE owner_identity_key = ?`).get(owner).n)
    const changeDetailCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM history_change_details WHERE owner_identity_key = ?`).get(owner).n)
    return {
      live: { recordCount: usage.recordCount, byteCount: usage.byteCount, epoch: usage.epoch, nextSequence: usage.nextSequence },
      physical: { changeCount, changeDetailCount, tombstoneCount, snapshotCount, snapshotItemCount: Number(itemRow.n) },
    }
  }

  function purgeExpiredChanges({ owner, nowIso: nowValue = new Date().toISOString(), batchSize, maxItems } = {}) {
    const { batch: bounded, maxItems: itemBudget } = boundPurgeParams({ batchSize, maxItems, maxSnapshots: 100 })
    const cutoff = retentionCutoffIso(nowValue)
    if (owner === undefined) {
      const e = new TypeError('owner is required for change purge')
      e.code = 'ERR_INVALID_RECORD'
      throw e
    }
    // Progress-safe selection (mbs-8g5.2.4.5): exclude protected live upserts
    // in the query so a protected row sorting before an eligible state event
    // cannot stall the bounded window. Eligible rows are old non-upserts plus
    // old upserts for no-longer-live keys.
    const due = db.prepare(
      `SELECT change_sequence, record_key, kind FROM history_changes
        WHERE owner_identity_key = ? AND created_at < ?
          AND (kind != 'upsert' OR NOT EXISTS
            (SELECT 1 FROM history_records r WHERE r.owner_identity_key = history_changes.owner_identity_key AND r.record_key = history_changes.record_key))
        ORDER BY ${SEQ_ORDER} LIMIT ?`,
    ).all(owner, cutoff, itemBudget)
    const victims = due.slice(0, itemBudget)
    let purged = 0
    let allowance = itemBudget
    db.exec('BEGIN IMMEDIATE')
    try {
      const delDetail = db.prepare(`DELETE FROM history_change_details WHERE owner_identity_key = ? AND change_sequence = ?`)
      const delChange = db.prepare(`DELETE FROM history_changes WHERE owner_identity_key = ? AND change_sequence = ?`)
      for (const row of victims) {
        if (allowance <= 0) break
        delDetail.run(owner, row.change_sequence)
        purged += Number(delChange.run(owner, row.change_sequence).changes)
        allowance -= 1
        if (bounded <= 0) break
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    // hasMore is conservative: a full eligible window means another batch may
    // exist. Protected live upserts never block progress because they are
    // excluded from the window above.
    const hasMore = Boolean(db.prepare(
      `SELECT 1 AS one FROM history_changes
        WHERE owner_identity_key = ? AND created_at < ?
          AND (kind != 'upsert' OR NOT EXISTS
            (SELECT 1 FROM history_records r WHERE r.owner_identity_key = history_changes.owner_identity_key AND r.record_key = history_changes.record_key)) LIMIT 1`,
    ).get(owner, cutoff))
    return { purgedChanges: purged, examinedChanges: victims.length, hasMore }
  }

  return {
    kind: 'sqlite-persistent',
    db,
    archiveBatch,
    patchState,
    deleteRecord,
    deleteAll,
    getUsage,
    getRecord,
    listChanges,
    listDeleteEvents,
    injectCommitFailureOnce,
    injectFailureOnce,
    indexEvidence,
    close,
    createSnapshot,
    getSnapshot,
    listSnapshotMembers,
    purgeExpiredSnapshots,
    listBrowse,
    listChangesPage,
    listSnapshotPage,
    getStorageStats,
    purgeExpiredChanges,
  }
}
