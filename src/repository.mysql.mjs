import {
  assertOwnerDirection,
  bodyHash,
  canonicalRecordKey,
  INITIAL_DELIVERY_STATES,
  isIdentityKey,
  LIMITS,
  validateEncryptedBody,
  validateEpoch,
  validateMessageBox,
  validateMessageId,
  utf8ByteLength,
} from './protocol.mjs'
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

const DELIVERY = new Set(['prepared', 'received', 'unknown', 'accepted', 'failed'])
const utf8Bytes = utf8ByteLength
const nextSeq = (cur) => (BigInt(cur) + 1n).toString()
// Canonical BigInt-safe rotation + idempotency helpers (shared contract).
import { canonicalParamsHash, rotateOwnerEpoch as sharedRotateEpoch, validateIdempotencyInput, validateStateMutationInput } from './repository.mjs'
import {
  assertNoInternalRetentionGap,
  assertNoRetentionGap,
  boundFeedLimit,
  decodeSnapshotPosition,
  encodeSnapshotPosition,
  fitRecordsToPage,
  historyPageOverheadBytes,
  matchesFeedFilter as matchesFeedFilterMysql,
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
const rotateEpoch = (epoch) => sharedRotateEpoch(epoch)

function idempotencyConflictError() {
  const error = new RangeError('idempotency key reuse with different input')
  error.code = 'ERR_IDEMPOTENCY_CONFLICT'
  throw error
}

function toMysqlTimestamp(iso) {
  return String(iso).slice(0, 19).replace('T', ' ')
}

function validateInput({ owner, epoch, record, ownerEpoch }) {
  if (!isIdentityKey(owner)) return { valid: false, code: 'ERR_INVALID_RECORD' }
  try {
    validateEpoch(epoch)
  } catch {
    return { valid: false, code: 'ERR_INVALID_RECORD' }
  }
  if (ownerEpoch !== undefined && epoch !== ownerEpoch) return { valid: false, code: 'ERR_EPOCH_CHANGED' }
  // Check the per-record byte cap before parsing the encrypted envelope. The
  // canonical validator throws a RangeError for an oversized string; archive
  // callers must preserve that as a typed size outcome rather than treating
  // it as a malformed record.
  if (typeof record?.body === 'string' && utf8Bytes(record.body) > LIMITS.MAX_BODY_BYTES) return { valid: false, code: 'ERR_REQUEST_TOO_LARGE' }
  try {
    validateMessageBox(record.messageBox)
    validateMessageId(record.messageId)
    if (record.direction !== 'inbound' && record.direction !== 'outbound') return { valid: false, code: 'ERR_INVALID_RECORD' }
    assertOwnerDirection({ ownerIdentityKey: owner, direction: record.direction, sender: record.sender, recipient: record.recipient })
    validateEncryptedBody(record.body)
  } catch {
    return { valid: false, code: 'ERR_INVALID_RECORD' }
  }
  const bytes = utf8Bytes(record.body)
  if (bytes > LIMITS.MAX_BODY_BYTES) return { valid: false, code: 'ERR_REQUEST_TOO_LARGE' }
  const bodyHashValue = bodyHash(record.body)
  const recordKey = canonicalRecordKey({
    ownerIdentityKey: owner,
    direction: record.direction,
    messageBox: record.messageBox,
    sender: record.sender,
    recipient: record.recipient,
    messageId: record.messageId,
  })
  if (record.recordKey !== undefined && record.recordKey !== recordKey) return { valid: false, code: 'ERR_INVALID_RECORD' }
  if (record.bodyHash !== undefined && record.bodyHash !== bodyHashValue) return { valid: false, code: 'ERR_INVALID_RECORD' }
  if (record.deliveryState !== undefined && !INITIAL_DELIVERY_STATES.includes(record.deliveryState)) return { valid: false, code: 'ERR_INVALID_RECORD' }
  return { valid: true, bodyHash: bodyHashValue, recordKey, bodyBytes: bytes }
}

const sameImmutable = (a, b) =>
  a.message_id === b.messageId &&
  a.message_box === b.messageBox &&
  a.direction === b.direction &&
  a.sender === b.sender &&
  a.recipient === b.recipient &&
  a.body_hash === b.bodyHash &&
  a.body === b.body

/** Ordered migration chain with checksum persistence and pre-record verification.
 * - Persists version + canonical checksum in schema_migrations;
 * - Compares recorded checksums on every rerun, refusing tampered history;
 * - Verifies tables/columns/indexes/collations/constraints/snapshot structures
 *   before recording each version, so an interrupted run never leaves a false
 *   applied stamp and safely resumes;
 * - `hooks.failAfterStatements` injects a failure between real DDL steps for
 *   resume-proof tests (no version recorded on failure).
 */
export async function migrateMysql(knex, chain, hooks = {}) {
  const { MYSQL_MIGRATION_CHAIN, checksumMigration, EXPECTED_MIGRATION_CHECKSUMS, splitStatements, verifyMysqlSchema, verifyMysqlTables, verifyMysqlVersion } =
    await import('./migrations.mjs')
  const ordered = chain ?? MYSQL_MIGRATION_CHAIN

  // Ensure schema_migrations exists (fresh installs via 001 DDL; upgrades via
  // idempotent CREATE). Older DBs without the checksum column get an ALTER.
  async function ensureMigrationsTable() {
    // Create with checksum column if missing entirely (idempotent).
    await knex.raw(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) NOT NULL PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    )
    // Upgrade path: 001 without checksum column (pre-checksum DBs).
    const cols = (await knex.raw(
      `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'`,
    ))[0].map((r) => r.name)
    if (!cols.includes('checksum')) {
      await knex.raw(`ALTER TABLE schema_migrations ADD COLUMN checksum CHAR(64) NOT NULL DEFAULT ''`)
      // Legacy rows remain blank until their complete version-specific
      // structure has been verified below. A column addition is not a trust
      // decision; checksum adoption is deliberately deferred.
    }
  }

  await ensureMigrationsTable()

  let recordedRows = []
  try {
    recordedRows = (await knex.raw(`SELECT version, checksum FROM schema_migrations`))[0]
  } catch {
    recordedRows = []
  }
  const recordedMap = new Map(recordedRows.map((r) => [r.version, r.checksum ?? '']))
  const legacy004Checksum = '24589ed1deae2a63a8ac77a68aa297c7ac71ec23ed524eeaea40d8f42a1a872f'
  if (recordedMap.get('004-tombstones') === legacy004Checksum) {
    const migration = MYSQL_MIGRATION_CHAIN.find(({ version }) => version === '004-tombstones')
    for (const stmt of splitStatements(migration.sql)) await knex.raw(stmt.replace(/;$/, ''))
    const repairedChecksum = EXPECTED_MIGRATION_CHECKSUMS['mysql:004-tombstones']
    await knex.raw(`UPDATE schema_migrations SET checksum = ? WHERE version = '004-tombstones' AND checksum = ?`, [repairedChecksum, legacy004Checksum])
    recordedMap.set('004-tombstones', repairedChecksum)
  }
  const recorded = [...recordedMap.keys()]
  const canonicalVersions = MYSQL_MIGRATION_CHAIN.map(({ version }) => version)

  // Preflight every recorded version before trusting, backfilling or
  // skipping anything. This also rejects a later stamp whose earlier version
  // is absent: a partial legacy 001/002 state must not bless later migrations.
  for (const version of recorded) {
    const key = `mysql:${version}`
    const expected = EXPECTED_MIGRATION_CHECKSUMS[key]
    if (!expected) {
      const error = new Error(`migration history contains unknown version ${version}`)
      error.code = 'ERR_MIGRATION_STRUCTURE'
      throw error
    }
    const recordedChecksum = String(recordedMap.get(version) ?? '')
    if (recordedChecksum !== '' && recordedChecksum !== expected) {
      const error = new Error(`migration history tampered for ${key}: recorded checksum differs from canonical`)
      error.code = 'ERR_MIGRATION_CHECKSUM'
      throw error
    }
  }
  for (let index = 0; index < canonicalVersions.length; index += 1) {
    const version = canonicalVersions[index]
    if (!recordedMap.has(version)) continue
    const missingEarlier = canonicalVersions.slice(0, index).find((earlier) => !recordedMap.has(earlier))
    if (missingEarlier) {
      const error = new Error(`migration history has recorded ${version} before ${missingEarlier}`)
      error.code = 'ERR_MIGRATION_STRUCTURE'
      throw error
    }
  }
  for (const version of recorded) {
    await verifyMysqlVersion(knex, version)
  }
  // Only now can legacy checksum rows be adopted. Every recorded version was
  // structurally verified above, so this write cannot bless an incomplete DB.
  for (const version of recorded) {
    if (String(recordedMap.get(version) ?? '') === '') {
      const expected = EXPECTED_MIGRATION_CHECKSUMS[`mysql:${version}`]
      await knex.raw(`UPDATE schema_migrations SET checksum = ? WHERE version = ? AND (checksum = '' OR checksum IS NULL)`, [expected, version])
      recordedMap.set(version, expected)
    }
  }

  for (const { version, sql } of ordered) {
    const key = `mysql:${version}`
    const shipped = checksumMigration(sql)
    if (shipped !== EXPECTED_MIGRATION_CHECKSUMS[key]) {
      const error = new Error(`migration checksum mismatch for ${key}: refusing to apply`)
      error.code = 'ERR_MIGRATION_CHECKSUM'
      throw error
    }
    if (recordedMap.has(version)) continue
    const statements = splitStatements(sql)
    let applied = 0
    for (const stmt of statements) {
      await knex.raw(stmt.replace(/;$/, ''))
      applied += 1
      if (hooks.failAfterStatements !== undefined && applied === hooks.failAfterStatements && hooks.failVersion !== undefined && hooks.failVersion === version) {
        const error = new Error(`injected migration failure after ${applied} statements of ${version}`)
        error.code = 'ERR_MIGRATION_INJECTED'
        throw error
      }
      if (hooks.failAfterStatements !== undefined && hooks.failVersion === undefined && applied === hooks.failAfterStatements) {
        const error = new Error(`injected migration failure after ${applied} statements`)
        error.code = 'ERR_MIGRATION_INJECTED'
        throw error
      }
    }
    // Verify required tables/columns/indexes/collations/snapshot structures
    // before recording the version as applied.
    if (verifyMysqlVersion) {
      await verifyMysqlVersion(knex, version)
    } else {
      const { VERSION_TABLES } = await import('./migrations.mjs')
      await verifyMysqlTables(knex, VERSION_TABLES[version] ?? [])
    }
    await knex.raw(`INSERT INTO schema_migrations (version, checksum) VALUES (?, ?) ON DUPLICATE KEY UPDATE checksum=VALUES(checksum)`, [version, shipped])
    recordedMap.set(version, shipped)
    recorded.push(version)
  }
  // Full structural check (indexes, collation) once every known version is present.
  if (MYSQL_MIGRATION_CHAIN.every(({ version }) => recordedMap.has(version))) {
    await verifyMysqlSchema(knex)
  }
  return [...recordedMap.keys()].filter((v) => ordered.some((o) => o.version === v))
}

/** Knex instance for the isolated test/service database. Pool max 7 per M0-DECISIONS. */
export function initializeMysqlUtcSession(connection, done) {
  connection.query("SET time_zone = '+00:00'", (error) => {
    if (error) {
      const wrapped = new Error('MySQL session UTC initialization failed')
      wrapped.code = 'ERR_STORAGE_CONFIGURATION'
      wrapped.cause = error
      done(wrapped, connection)
      return
    }
    connection.query('SELECT @@session.time_zone AS session_time_zone', (verifyError, rows) => {
      if (verifyError || rows?.[0]?.session_time_zone !== '+00:00') {
        const wrapped = new Error('MySQL session did not accept UTC time_zone')
        wrapped.code = 'ERR_STORAGE_CONFIGURATION'
        wrapped.cause = verifyError
        done(wrapped, connection)
        return
      }
      done(null, connection)
    })
  })
}

export function createMysqlKnex({ host = '127.0.0.1', port = 3306, user, password, database }) {
  if (!user || !password || !database) {
    const e = new TypeError('MySQL user/password/database are required (via env, never committed)')
    e.code = 'ERR_MYSQL_CONFIG'
    throw e
  }
  // Lazy import so unit tests never pay the driver cost.
  return import('knex').then(({ default: knex }) =>
    knex({
      client: 'mysql2',
      // UTC session (mbs-8g5.2.4.6): TIMESTAMP columns store UTC wall-clock
      // from the app (ISO slice without zone). Without an explicit UTC
      // session, a non-UTC MySQL SYSTEM time_zone shifts stored times (e.g.
      // Sydney +10h turns a +1h snapshot TTL into an immediate expiry).
      connection: { host, port, user, password, database, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true, timezone: '+00:00' },
      pool: {
        min: 0,
        max: 7,
        afterCreate: initializeMysqlUtcSession,
      },
    }),
  )
}

/** Deadlock classification for bounded transaction retry. */
export function isDeadlockError(error) {
  return error?.code === 'ER_LOCK_DEADLOCK' || error?.code === 'ER_LOCK_WAIT_TIMEOUT'
}

const DEADLOCK_BACKOFF_MS = Object.freeze([10, 25, 50])

/**
 * Bounded deadlock retry: re-runs a transaction closure when InnoDB reports
 * a deadlock or lock-wait timeout, then fails closed with ERR_UNAVAILABLE.
 * Non-deadlock errors propagate immediately with no retry.
 */
export async function withDeadlockRetry(operation, attempts = DEADLOCK_BACKOFF_MS.length + 1) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isDeadlockError(error)) throw error
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, DEADLOCK_BACKOFF_MS[Math.min(attempt - 1, DEADLOCK_BACKOFF_MS.length - 1)]))
    }
  }
  const exhausted = new Error('transaction deadlocked repeatedly; retry budget exhausted')
  exhausted.code = 'ERR_UNAVAILABLE'
  exhausted.cause = lastError
  throw exhausted
}

export function createMysqlStore(knex, { limits = {} } = {}) {
  const L = { ...LIMITS, ...limits }
  const failOnce = { archiveBatch: false, patchState: false, deleteRecord: false, deleteAll: false, snapshotCleanup: false }

  function consumeFailure(op) {
    if (failOnce[op]) {
      failOnce[op] = false
      const error = new Error(`injected ${op} failure`)
      error.code = 'ERR_UNAVAILABLE'
      throw error
    }
  }

  async function checkIdempotencyTrx(trx, { owner, key, operation, params }) {
    if (key === undefined) return null
    validateIdempotencyInput(key)
    const paramsHash = canonicalParamsHash(params)
    const rows = await trx.raw(`SELECT operation, params_hash, result_json FROM history_idempotency WHERE owner_identity_key = ? AND idempotency_key = ?`, [owner, key])
    const existing = rows[0][0] ?? null
    if (!existing) return { paramsHash, existing: null }
    if (existing.operation !== operation || existing.params_hash !== paramsHash) {
      idempotencyConflictError()
    }
    return { paramsHash, existing: JSON.parse(existing.result_json) }
  }

  async function storeIdempotencyTrx(trx, { owner, key, operation, paramsHash, result }) {
    await trx.raw(`INSERT INTO history_idempotency (owner_identity_key, idempotency_key, operation, params_hash, result_json) VALUES (?, ?, ?, ?, ?)`, [
      owner,
      key,
      operation,
      paramsHash,
      JSON.stringify(result),
    ])
  }

  async function lockResource(trx, owner) {
    await trx.raw(
      `INSERT INTO history_resource_locks (owner_identity_key) VALUES (?) ON DUPLICATE KEY UPDATE owner_identity_key=owner_identity_key`,
      [owner],
    )
    const lockRows = await trx.raw(`SELECT owner_identity_key FROM history_resource_locks WHERE owner_identity_key = ? FOR UPDATE`, [owner])
    if (lockRows[0].length === 0) throw new Error('owner lock missing')
  }

  async function ensureOwner(trx, owner) {
    await trx.raw(
      `INSERT INTO history_owner_state (owner_identity_key, epoch, next_sequence, record_count, byte_count)
       VALUES (?, 'gen-1', 1, 0, 0) ON DUPLICATE KEY UPDATE owner_identity_key=owner_identity_key`,
      [owner],
    )
    await lockResource(trx, owner)
    const stateRows = await trx.raw(`SELECT epoch, next_sequence, record_count, byte_count FROM history_owner_state WHERE owner_identity_key = ? FOR UPDATE`, [owner])
    const s = stateRows[0][0]
    return { epoch: s.epoch, nextSequence: String(s.next_sequence), recordCount: Number(s.record_count), byteCount: Number(s.byte_count) }
  }

  // Lock an existing owner without creating state. Delete-all uses this
  // before its expectedEpoch CAS so a stale request for an unknown owner
  // rolls back without manufacturing a gen-1 epoch row.
  async function lockOwner(trx, owner) {
    let stateRows = await trx.raw(`SELECT epoch, next_sequence, record_count, byte_count FROM history_owner_state WHERE owner_identity_key = ? FOR UPDATE`, [owner])
    if (stateRows[0][0]) {
      await lockResource(trx, owner)
      return stateRows[0][0]
    }
    await lockResource(trx, owner)
    stateRows = await trx.raw(`SELECT epoch, next_sequence, record_count, byte_count FROM history_owner_state WHERE owner_identity_key = ? FOR UPDATE`, [owner])
    return stateRows[0][0] ?? null
  }

  async function latestChangeFor(trx, owner, recordKey) {
    const rows = await trx.raw(
      `SELECT kind FROM history_changes WHERE owner_identity_key = ? AND record_key = ? ORDER BY change_sequence DESC LIMIT 1`,
      [owner, recordKey],
    )
    return rows[0][0] ?? null
  }

  async function archiveBatch({ owner, epoch, records }) {
    if (!Array.isArray(records) || records.length === 0) {
      const e = new TypeError('records must be non-empty')
      e.code = 'ERR_INVALID_RECORD'
      throw e
    }
    if (records.length > L.MAX_BATCH_RECORDS) {
      const e = new RangeError('batch record bound')
      e.code = 'ERR_REQUEST_TOO_LARGE'
      throw e
    }
    let batchBytes = 0
    for (const r of records) batchBytes += typeof r?.body === 'string' ? utf8Bytes(r.body) : 0
    if (batchBytes > L.MAX_BATCH_BYTES) {
      const e = new RangeError('batch byte bound')
      e.code = 'ERR_REQUEST_TOO_LARGE'
      throw e
    }
    return withDeadlockRetry(() => knex.transaction(async (trx) => {
      consumeFailure('archiveBatch')
      const st = await ensureOwner(trx, owner)
      if (epoch !== st.epoch) {
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
        const rec = records[index]
        const check = validateInput({ owner, epoch, record: rec, ownerEpoch: st.epoch })
        if (!check.valid) {
          planned.push({ index, recordKey: rec?.recordKey ?? null, outcome: check.code === 'ERR_EPOCH_CHANGED' ? 'epochChanged' : 'invalid', errorCode: check.code })
          continue
        }
        const existing = (await trx.raw(`SELECT * FROM history_records WHERE owner_identity_key = ? AND record_key = ?`, [owner, check.recordKey]))[0][0] ?? null
        if (existing) {
          if (sameImmutable(existing, { ...rec, bodyHash: check.bodyHash })) {
            planned.push({ index, recordKey: check.recordKey, outcome: 'alreadyPresent', bodyHash: check.bodyHash })
          } else {
            await trx.raw(`INSERT INTO history_audit_events (owner_identity_key, kind, record_key, detail) VALUES (?, 'immutable-conflict', ?, 'same key different content')`, [
              owner,
              check.recordKey,
            ])
            planned.push({ index, recordKey: check.recordKey, outcome: 'conflict', errorCode: 'ERR_IMMUTABLE_CONFLICT' })
          }
          continue
        }
        const lastChange = await latestChangeFor(trx, owner, check.recordKey)
        if (lastChange?.kind === 'delete') {
          planned.push({ index, recordKey: check.recordKey, outcome: 'deleted', errorCode: 'ERR_INVALID_RECORD' })
          continue
        }
        // Persistent deletion fence (mbs-8g5.2.4.2): tombstones survive
        // change-retention purge.
        {
          const tomb = (await trx.raw(`SELECT 1 AS one FROM history_tombstones WHERE owner_identity_key = ? AND record_key = ? LIMIT 1`, [owner, check.recordKey]))[0][0]
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
        planned.push({ index, recordKey: check.recordKey, outcome: 'stored', bodyHash: check.bodyHash, bodyBytes: check.bodyBytes, validated: { ...rec } })
      }
      let seq = BigInt(st.nextSequence)
      const at = new Date().toISOString().slice(0, 19).replace('T', ' ')
      for (const item of planned.filter((p) => p.outcome === 'stored')) {
        const cur = seq.toString()
        seq += 1n
        const src = item.validated
        const initialState = src.deliveryState ?? (src.direction === 'outbound' ? 'prepared' : 'received')
        try {
          await trx.raw(
            `INSERT INTO history_records
             (owner_identity_key, record_key, message_id, message_box, direction, sender, recipient, body, body_hash, body_bytes, delivery_state, revision, change_sequence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [
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
            ],
          )
        } catch (error) {
          if (error?.code === 'ER_DUP_ENTRY') {
            const existing = (await trx.raw(`SELECT * FROM history_records WHERE owner_identity_key = ? AND record_key = ?`, [owner, item.recordKey]))[0][0]
            if (existing && sameImmutable(existing, { ...src, bodyHash: item.bodyHash })) {
              item.outcome = 'alreadyPresent'
              delete item.validated
              seq -= 1n
              projectedCount -= 1
              projectedBytes -= item.bodyBytes
              continue
            }
            await trx.raw(`INSERT INTO history_audit_events (owner_identity_key, kind, record_key, detail) VALUES (?, 'immutable-conflict', ?, 'race duplicate')`, [owner, item.recordKey])
            item.outcome = 'conflict'
            item.errorCode = 'ERR_IMMUTABLE_CONFLICT'
            delete item.validated
            seq -= 1n
            projectedCount -= 1
            projectedBytes -= item.bodyBytes
            continue
          }
          throw error
        }
        await trx.raw(`INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version) VALUES (?, ?, ?, 'upsert', 1)`, [
          owner,
          cur,
          item.recordKey,
        ])
        await trx.raw(`INSERT IGNORE INTO history_change_details (owner_identity_key, change_sequence, delivery_state) VALUES (?, ?, ?)`, [
          owner,
          cur,
          initialState,
        ])
        item.sequence = cur
        delete item.validated
      }
      await trx.raw(`UPDATE history_owner_state SET next_sequence = ?, record_count = ?, byte_count = ? WHERE owner_identity_key = ?`, [
        seq.toString(),
        projectedCount,
        projectedBytes,
        owner,
      ])
      return { epoch: st.epoch, committed: true, outcomes: planned }
    }))
  }

  async function patchState({ owner, recordKey, newState, expectedRevision, idempotencyKey }) {
    // Validate before starting a retryable transaction so omission cannot
    // mutate owner state or consume a deadlock retry budget.
    validateStateMutationInput({ expectedRevision, idempotencyKey })
    if (!DELIVERY.has(newState)) {
      const e = new TypeError('unknown state')
      e.code = 'ERR_INVALID_RECORD'
      throw e
    }
    if (idempotencyKey !== undefined) validateIdempotencyInput(idempotencyKey)
    return withDeadlockRetry(() => knex.transaction(async (trx) => {
      consumeFailure('patchState')
      await ensureOwner(trx, owner)
      const idem = await checkIdempotencyTrx(trx, { owner, key: idempotencyKey, operation: 'patchState', params: { recordKey, newState, expectedRevision: expectedRevision === undefined ? undefined : String(expectedRevision) } })
      if (idem?.existing) return { ...idem.existing, replayed: true }
      const lastChange = await latestChangeFor(trx, owner, recordKey)
      if (lastChange?.kind === 'delete') {
        const e = new RangeError('record deleted; deletion wins')
        e.code = 'ERR_INVALID_RECORD'
        throw e
      }
      {
        const tomb = (await trx.raw(`SELECT 1 AS one FROM history_tombstones WHERE owner_identity_key = ? AND record_key = ? LIMIT 1`, [owner, recordKey]))[0][0]
        if (tomb) {
          const e = new RangeError('record deleted; deletion wins')
          e.code = 'ERR_INVALID_RECORD'
          throw e
        }
      }
      const row = (await trx.raw(`SELECT delivery_state, revision, change_sequence FROM history_records WHERE owner_identity_key = ? AND record_key = ? FOR UPDATE`, [owner, recordKey]))[0][0]
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
        if (idem) await storeIdempotencyTrx(trx, { owner, key: idempotencyKey, operation: 'patchState', paramsHash: idem.paramsHash, result })
        return result
      }
      const st = (await trx.raw(`SELECT next_sequence FROM history_owner_state WHERE owner_identity_key = ? FOR UPDATE`, [owner]))[0][0]
      const seq = String(st.next_sequence)
      const nextRev = (BigInt(revision) + 1n).toString()
      await trx.raw(`UPDATE history_records SET delivery_state = ?, revision = ?, change_sequence = ? WHERE owner_identity_key = ? AND record_key = ?`, [
        newState,
        nextRev,
        seq,
        owner,
        recordKey,
      ])
      await trx.raw(`INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version) VALUES (?, ?, ?, 'state', ?)`, [
        owner,
        seq,
        recordKey,
        nextRev,
      ])
      await trx.raw(`INSERT IGNORE INTO history_change_details (owner_identity_key, change_sequence, delivery_state) VALUES (?, ?, ?)`, [owner, seq, newState])
      await trx.raw(`UPDATE history_owner_state SET next_sequence = next_sequence + 1 WHERE owner_identity_key = ?`, [owner])
      const result = { ok: true, recordKey, revision: nextRev, sequence: seq }
      if (idem) await storeIdempotencyTrx(trx, { owner, key: idempotencyKey, operation: 'patchState', paramsHash: idem.paramsHash, result })
      return result
    }))
  }

  async function deleteRecord({ owner, recordKey, idempotencyKey }) {
    if (idempotencyKey !== undefined) validateIdempotencyInput(idempotencyKey)
    return withDeadlockRetry(() => knex.transaction(async (trx) => {
      consumeFailure('deleteRecord')
      const st = await ensureOwner(trx, owner)
      const idem = await checkIdempotencyTrx(trx, { owner, key: idempotencyKey, operation: 'deleteRecord', params: { recordKey } })
      if (idem?.existing) return { ...idem.existing, replayed: true }
      const row = (await trx.raw(`SELECT body_bytes FROM history_records WHERE owner_identity_key = ? AND record_key = ? FOR UPDATE`, [owner, recordKey]))[0][0] ?? null
      const lastChange = await latestChangeFor(trx, owner, recordKey)
      if (!row && lastChange?.kind !== 'delete' && !lastChange) {
        // Distinguish never-existed (no-op) from tombstoned (already deleted).
        const everExisted = (await trx.raw(`SELECT 1 FROM history_changes WHERE owner_identity_key = ? AND record_key = ? LIMIT 1`, [owner, recordKey]))[0][0]
        const everTombstoned = (await trx.raw(`SELECT 1 FROM history_tombstones WHERE owner_identity_key = ? AND record_key = ? LIMIT 1`, [owner, recordKey]))[0][0]
        if (!everExisted && !everTombstoned) {
          const result0 = { deleted: false, epoch: st.epoch }
          if (idem) await storeIdempotencyTrx(trx, { owner, key: idempotencyKey, operation: 'deleteRecord', paramsHash: idem.paramsHash, result: result0 })
          return result0
        }
      }
      const seqRow = (await trx.raw(`SELECT next_sequence FROM history_owner_state WHERE owner_identity_key = ? FOR UPDATE`, [owner]))[0][0]
      const seq = String(seqRow.next_sequence)
      const at = toMysqlTimestamp(new Date().toISOString())
      if (row) {
        await trx.raw(`DELETE FROM history_records WHERE owner_identity_key = ? AND record_key = ?`, [owner, recordKey])
        await trx.raw(`UPDATE history_owner_state SET record_count = record_count - 1, byte_count = byte_count - ?, next_sequence = next_sequence + 1 WHERE owner_identity_key = ?`, [
          row.body_bytes,
          owner,
        ])
      } else {
        await trx.raw(`UPDATE history_owner_state SET next_sequence = next_sequence + 1 WHERE owner_identity_key = ?`, [owner])
      }
      // Body-free delete event with canonical timestamp, never ciphertext.
      await trx.raw(`INSERT INTO history_changes (owner_identity_key, change_sequence, record_key, kind, version, deleted_at) VALUES (?, ?, ?, 'delete', 1, ?)`, [owner, seq, recordKey, at])
      // Persistent fence beyond retention purge (mbs-8g5.2.4.2).
      await trx.raw(
        `INSERT INTO history_tombstones (owner_identity_key, record_key, deleted_at, change_sequence) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE deleted_at = VALUES(deleted_at), change_sequence = VALUES(change_sequence)`,
        [owner, recordKey, at, seq],
      )
      await trx.raw(
        `UPDATE history_snapshots SET status = 'invalidated'
         WHERE owner_identity_key = ? AND epoch = ? AND status = 'active'
         AND EXISTS (SELECT 1 FROM history_snapshot_items WHERE snapshot_id = history_snapshots.snapshot_id AND record_key = ?)`,
        [owner, st.epoch, recordKey],
      )
      const result = { deleted: true, sequence: seq, epoch: st.epoch }
      if (idem) await storeIdempotencyTrx(trx, { owner, key: idempotencyKey, operation: 'deleteRecord', paramsHash: idem.paramsHash, result })
      return result
    }))
  }

  async function deleteAll({ owner, idempotencyKey, expectedEpoch }) {
    if (idempotencyKey !== undefined) validateIdempotencyInput(idempotencyKey)
    return withDeadlockRetry(() => knex.transaction(async (trx) => {
      const locked = await lockOwner(trx, owner)
      // Idempotency is checked before the live-epoch CAS: an exact retry must
      // replay its committed result even after the original rotated epoch.
      const idem = await checkIdempotencyTrx(trx, { owner, key: idempotencyKey, operation: 'deleteAll', params: { expectedEpoch } })
      if (idem?.existing) return { ...idem.existing, replayed: true }
      const currentEpoch = locked?.epoch ?? 'gen-1'
      if (expectedEpoch !== undefined && expectedEpoch !== currentEpoch) {
        const error = new RangeError('epoch changed')
        error.code = 'ERR_EPOCH_CHANGED'
        throw error
      }
      consumeFailure('deleteAll')
      const st = await ensureOwner(trx, owner)
      await trx.raw(`DELETE FROM history_records WHERE owner_identity_key = ?`, [owner])
      await trx.raw(`DELETE FROM history_changes WHERE owner_identity_key = ?`, [owner])
      await trx.raw(`DELETE FROM history_tombstones WHERE owner_identity_key = ?`, [owner])
      await trx.raw(`DELETE FROM history_change_details WHERE owner_identity_key = ?`, [owner])
      await trx.raw(`DELETE FROM history_change_boundaries WHERE owner_identity_key = ?`, [owner])
      const next = rotateEpoch(st.epoch)
      await trx.raw(`UPDATE history_owner_state SET record_count = 0, byte_count = 0, epoch = ? WHERE owner_identity_key = ?`, [next, owner])
      await trx.raw(`UPDATE history_snapshots SET status = 'invalidated' WHERE owner_identity_key = ? AND epoch = ? AND status = 'active'`, [owner, st.epoch])
      const result = { epoch: next }
      if (idem) await storeIdempotencyTrx(trx, { owner, key: idempotencyKey, operation: 'deleteAll', paramsHash: idem.paramsHash, result })
      return result
    }))
  }

  async function getUsage({ owner }) {
    const row = (await knex.raw(`SELECT epoch, next_sequence, record_count, byte_count FROM history_owner_state WHERE owner_identity_key = ?`, [owner]))[0][0]
    if (!row) return { recordCount: 0, byteCount: 0, epoch: 'gen-1', nextSequence: '1' }
    return { recordCount: Number(row.record_count), byteCount: Number(row.byte_count), epoch: row.epoch, nextSequence: String(row.next_sequence) }
  }

  function toIso(value) {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value.toISOString()
    // MySQL TIMESTAMP(6) may arrive as 'YYYY-MM-DD HH:MM:SS.ffffff'.
    const text = String(value)
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) {
      return `${text.slice(0, 10)}T${text.slice(11)}Z`.replace(/(\.\d*?)0*Z$/, '$1Z').replace(/\.Z$/, 'Z')
    }
    return text
  }

  function toRecord(owner, row) {
    if (!row) return null
    return {
      owner,
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
      createdAt: toIso(row.created_at),
      archivedAt: toIso(row.archived_at),
      expiresAt: toIso(row.expires_at),
    }
  }

  async function getRecord({ owner, recordKey }) {
    const row = (await knex.raw(`SELECT * FROM history_records WHERE owner_identity_key = ? AND record_key = ?`, [owner, recordKey]))[0][0] ?? null
    return toRecord(owner, row)
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
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    }
  }

  async function createSnapshot({ owner, filter = {} } = {}) {
    validateSnapshotFilter(filter)
    return withDeadlockRetry(() => knex.transaction(async (trx) => {
      const st = await ensureOwner(trx, owner)
      const currentMax = st.nextSequence === '1' ? '0' : (BigInt(st.nextSequence) - 1n).toString()
      const wBig = BigInt(currentMax)
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
      // REPEATABLE READ keeps every read in this transaction on one commit
      // boundary, so W and the materialized rows cannot drift mid-capture.
      // Participant filter has a canonical identity (sender OR recipient) and
      // stable membership/state at W; no ciphertext is duplicated.
      const members = []
      for (const row of (await trx.raw(sql, params))[0]) {
        if (BigInt(String(row.created_seq)) > wBig) continue
        const record = {
          recordKey: row.record_key,
          direction: row.direction,
          messageBox: row.message_box,
          sender: row.sender,
          recipient: row.recipient,
          revision: String(row.revision),
          deliveryState: row.delivery_state,
          changeSequence: String(row.change_sequence),
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        }
        if (!matchesSnapshotFilter(record, filter)) continue
        members.push(record)
      }
      members.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.recordKey < b.recordKey ? -1 : 1))
      const snapshotId = generateSnapshotId()
      const filterHash = snapshotFilterHash(filter)
      const expiresAt = snapshotExpiryIso().slice(0, 19).replace('T', ' ')
      await trx.raw(
        `INSERT INTO history_snapshots (snapshot_id, owner_identity_key, epoch, filter_hash, watermark, status, expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [snapshotId, owner, st.epoch, filterHash, currentMax, expiresAt],
      )
      for (const member of members) {
        await trx.raw(
          `INSERT INTO history_snapshot_items (snapshot_id, record_key, revision_at_w, delivery_state_at_w, change_sequence_at_w, created_at_at_w)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [snapshotId, member.recordKey, member.revision, member.deliveryState, member.changeSequence, member.createdAt.slice(0, 19).replace('T', ' ')],
        )
      }
      return { snapshotId, epoch: st.epoch, feed: SNAPSHOT_FEED, filterHash, watermark: currentMax, memberCount: members.length, status: SNAPSHOT_STATUS.ACTIVE }
    }))
  }

  async function readSnapshotMeta(snapshotId) {
    const row = (await knex.raw(`SELECT * FROM history_snapshots WHERE snapshot_id = ?`, [snapshotId]))[0][0] ?? null
    return toSnapshotMeta(row)
  }

  async function getSnapshot({ snapshotId, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark } = {}) {
    if (owner === undefined) {
      const error = new TypeError('owner is required for snapshot reads')
      error.code = 'ERR_INVALID_RECORD'
      throw error
    }
    const meta = await readSnapshotMeta(snapshotId)
    if (!meta) return null
    assertSnapshotBinding({ stored: meta, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark })
    return meta
  }

  async function listSnapshotMembers({ snapshotId, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark, limit = 100, after } = {}) {
    if (owner === undefined) {
      const error = new TypeError('owner is required for snapshot reads')
      error.code = 'ERR_INVALID_RECORD'
      throw error
    }
    const meta = await readSnapshotMeta(snapshotId)
    if (!meta) return null
    assertSnapshotBinding({ stored: meta, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark })
    if (meta.status !== SNAPSHOT_STATUS.ACTIVE) return { status: meta.status, items: [] }
    {
      const expRaw = meta.expiresAt instanceof Date ? meta.expiresAt.toISOString() : meta.expiresAt
      if (expRaw !== undefined && expRaw !== null && !Number.isNaN(Date.parse(String(expRaw))) && Date.parse(String(expRaw)) <= Date.now()) {
        return { status: meta.status, items: [] }
      }
    }
    const bounded = Math.max(1, Math.min(Number(limit) || 100, L.MAX_PAGE_RECORDS))
    let sql = `SELECT * FROM history_snapshot_items WHERE snapshot_id = ?`
    const params = [snapshotId]
    if (after?.createdAtAtW !== undefined && after?.recordKey !== undefined) {
      sql += ` AND ((created_at_at_w > ?) OR (created_at_at_w = ? AND record_key > ?))`
      params.push(after.createdAtAtW.slice(0, 19).replace('T', ' '), after.createdAtAtW.slice(0, 19).replace('T', ' '), after.recordKey)
    }
    sql += ` ORDER BY created_at_at_w, record_key LIMIT ${bounded}`
    const rows = (await knex.raw(sql, params))[0]
    return {
      status: meta.status,
      items: rows.map((row) => ({
        recordKey: row.record_key,
        revisionAtW: String(row.revision_at_w),
        deliveryStateAtW: row.delivery_state_at_w,
        changeSequenceAtW: String(row.change_sequence_at_w),
        createdAtAtW: row.created_at_at_w instanceof Date ? row.created_at_at_w.toISOString() : String(row.created_at_at_w),
      })),
    }
  }

  async function listChanges({ owner } = {}) {
    const rows = (await knex.raw(`SELECT change_sequence, record_key, kind, version, deleted_at FROM history_changes WHERE owner_identity_key = ? ORDER BY change_sequence`, [owner]))[0]
    return rows.map((row) => {
      const out = { sequence: String(row.change_sequence), recordKey: row.record_key, kind: row.kind, version: String(row.version) }
      if (row.deleted_at !== null && row.deleted_at !== undefined) {
        out.deletedAt = row.deleted_at instanceof Date ? row.deleted_at.toISOString() : toMysqlTimestamp(String(row.deleted_at)).replace(' ', 'T') + 'Z'
        // Normalize MySQL 'YYYY-MM-DD HH:MM:SS' to ISO for canonical comparison.
        if (!out.deletedAt.endsWith('Z')) out.deletedAt = `${out.deletedAt}Z`
      }
      return out
    })
  }

  async function listDeleteEvents({ owner } = {}) {
    const rows = (await knex.raw(`SELECT change_sequence, record_key, deleted_at FROM history_changes WHERE owner_identity_key = ? AND kind = 'delete' ORDER BY change_sequence`, [owner]))[0]
    return rows.map((row) => ({
      recordKey: row.record_key,
      sequence: String(row.change_sequence),
      deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : toMysqlTimestamp(String(row.deleted_at)).replace(' ', 'T') + 'Z',
    }))
  }

  function injectFailureOnce(operation) {
    if (!(operation in failOnce)) {
      const e = new TypeError(`unknown operation ${operation}`)
      e.code = 'ERR_INVALID_RECORD'
      throw e
    }
    failOnce[operation] = true
  }

  async function purgeExpiredSnapshots({ nowIso: now = new Date().toISOString(), batchSize, maxItems, maxSnapshots } = {}) {
    // Bounded deadlock retry for cleanup mutations (mbs-8g5.2.3.2.1/.2.3.3.1).
    // Each invocation performs no more than the documented total item/snapshot
    // work, reports hasMore continuation, and eventually completes across
    // repeated calls.
    return withDeadlockRetry(async () => {
      consumeFailure('snapshotCleanup')
      const { batch: bounded, maxItems: itemBudget, maxSnapshots: snapBudget } = boundPurgeParams({ batchSize, maxItems, maxSnapshots })
      const stamp = now.slice(0, 19).replace('T', ' ')
      // Select at most the snapshot budget before any membership count/delete.
      // A full batch conservatively reports continuation; the next call picks
      // the next deterministic anchors without an unbounded target query.
      const targets = (await knex.raw(`SELECT s.snapshot_id
                                         FROM history_snapshots s
                                        WHERE s.expires_at <= ?
                                           OR (s.status = 'invalidated' AND EXISTS (SELECT 1 FROM history_snapshot_items i WHERE i.snapshot_id = s.snapshot_id))
                                        ORDER BY s.expires_at, s.snapshot_id LIMIT ${snapBudget}`, [stamp]))[0].map((r) => r.snapshot_id)
      let purgedItems = 0
      let itemAllowance = itemBudget
      for (const snapshotId of targets) {
        if (itemAllowance <= 0) break
        while (itemAllowance > 0) {
          const take = Math.min(bounded, itemAllowance)
          // eslint-disable-next-line no-await-in-loop
          const res = await knex.raw(`DELETE FROM history_snapshot_items WHERE snapshot_id = ? LIMIT ${take}`, [snapshotId])
          const removed = Number(res[0].affectedRows ?? 0)
          purgedItems += removed
          itemAllowance -= removed
          if (removed < take) break
          if (removed === 0) break
        }
        // eslint-disable-next-line no-await-in-loop
        const remaining = (await knex.raw(`SELECT 1 AS one FROM history_snapshot_items WHERE snapshot_id = ? LIMIT 1`, [snapshotId]))[0][0]
        if (remaining) break // budget exhausted mid-snapshot: continuation next call
      }
      let purgedSnapshots = 0
      // Delete only selected expired anchors once their items are empty. This
      // keeps total anchor mutations within the same maxSnapshots selection.
      for (const snapshotId of targets) {
        if (itemAllowance <= 0) break
        // eslint-disable-next-line no-await-in-loop
        const meta = (await knex.raw(`SELECT expires_at FROM history_snapshots WHERE snapshot_id = ?`, [snapshotId]))[0][0]
        const expires = meta?.expires_at instanceof Date
          ? meta.expires_at.toISOString().slice(0, 19).replace('T', ' ')
          : String(meta?.expires_at ?? '').slice(0, 19).replace('T', ' ')
        if (!meta || expires > stamp) continue
        // eslint-disable-next-line no-await-in-loop
        const remaining = (await knex.raw(`SELECT 1 AS one FROM history_snapshot_items WHERE snapshot_id = ? LIMIT 1`, [snapshotId]))[0][0]
        if (!remaining) {
          // eslint-disable-next-line no-await-in-loop
          const res = await knex.raw(`DELETE FROM history_snapshots WHERE snapshot_id = ?`, [snapshotId])
          purgedSnapshots += Number(res[0].affectedRows ?? 0)
        }
      }
      const hasMore = itemAllowance <= 0 || targets.length >= snapBudget
      return { purgedItems, purgedSnapshots, examinedSnapshots: targets.length, hasMore }
    })
  }

  async function currentUsageMysql(owner) {
    const row = (await knex.raw(`SELECT epoch, next_sequence FROM history_owner_state WHERE owner_identity_key = ?`, [owner]))[0][0]
    if (!row) return { epoch: 'gen-1', nextSequence: '1' }
    return { epoch: row.epoch, nextSequence: String(row.next_sequence) }
  }

  async function earliestChangeSequenceMysql(owner) {
    const row = (await knex.raw(`SELECT MIN(change_sequence) AS m FROM history_changes WHERE owner_identity_key = ?`, [owner]))[0][0]
    return row?.m === null || row?.m === undefined ? null : String(row.m)
  }

  async function findLatestDeleteMysql(owner, recordKey) {
    const row = (await knex.raw(`SELECT change_sequence, deleted_at FROM history_changes WHERE owner_identity_key = ? AND record_key = ? AND kind = 'delete' ORDER BY change_sequence DESC LIMIT 1`, [owner, recordKey]))[0][0] ?? null
    if (!row) return null
    return { sequence: String(row.change_sequence), deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : toMysqlTimestamp(String(row.deleted_at)).replace(' ', 'T') + 'Z' }
  }

  async function listBrowse({ owner, filter = {}, limit = 100, after } = {}) {
    validateFeedOwner(owner)
    validateSnapshotFilter(filter)
    const bounded = boundFeedLimit(limit)
    let sql = `SELECT *, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at_exact FROM history_records WHERE owner_identity_key = ?`
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
      const cursorTs = String(after.createdAt).replace('T', ' ').replace(/Z$/, '')
      sql += ` AND ((created_at > ?) OR (created_at = ? AND record_key > ?))`
      params.push(cursorTs, cursorTs, after.recordKey)
    }
    sql += ` ORDER BY created_at, record_key LIMIT ${bounded}`
    const rows = (await knex.raw(sql, params))[0]
    const items = []
    for (const row of rows) {
      const rec = {
        owner,
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
        createdAt: toIso(row.created_at_exact),
        archivedAt: toIso(row.archived_at),
        expiresAt: toIso(row.expires_at),
      }
      if (!matchesFeedFilterMysql(rec, filter)) continue
      items.push(rec)
    }
    const last = items[items.length - 1]
    return { items, nextAfter: items.length === bounded && last ? { createdAt: last.createdAt, recordKey: last.recordKey } : null }
  }

  async function listChangesPage({ owner, serverSecret, cursor = null, limit = 100, filter = {}, nowSeconds, nowIso: nowIsoValue, ttlSeconds } = {}) {
    validateFeedOwner(owner)
    validateServerSecret(serverSecret)
    validateSnapshotFilter(filter)
    const filterDigest = snapshotFilterHash(filter)
    const bounded = boundFeedLimit(limit)
    const nowSec = nowSeconds ?? Math.floor(Date.now() / 1000)
    const serverTime = nowIsoValue ?? new Date().toISOString()
    const usage = await currentUsageMysql(owner)
    let W
    let C
    let epoch
    if (cursor === null || cursor === undefined) {
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
    const boundary = (await knex.raw(`SELECT resync_through_sequence FROM history_change_boundaries WHERE owner_identity_key = ?`, [owner]))[0][0]
    if (boundary && BigInt(C) < BigInt(String(boundary.resync_through_sequence)) && BigInt(W) > BigInt(C)) {
      const e = new Error('legacy history cannot be reconstructed exactly; take a full snapshot')
      e.code = 'ERR_CURSOR_EXPIRED'
      throw e
    }
    const earliest = await earliestChangeSequenceMysql(owner)
    if (C !== FEED_START) {
      assertNoRetentionGap({ position: C, earliest })
      if (earliest === null && C !== W) {
        const e = new Error('cursor outside retained history; take a full snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
    }
    // REPEATABLE READ: W was fixed at first-page commit boundary; all
    // continuations stay within (C,W] so interleaved commits cannot shift
    // membership mid-capture. Numeric DECIMAL ordering is exact in MySQL.
    // LEFT JOIN details for event versioning (mbs-8g5.2.4.3).
    const rows = (await knex.raw(
      `SELECT c.change_sequence, c.record_key, c.kind, c.version, c.deleted_at, d.delivery_state AS deliveryState
         FROM history_changes c LEFT JOIN history_change_details d
           ON d.owner_identity_key = c.owner_identity_key AND d.change_sequence = c.change_sequence
        WHERE c.owner_identity_key = ? AND c.change_sequence > ? AND c.change_sequence <= ? ORDER BY c.change_sequence LIMIT ${bounded}`,
      [owner, C, W],
    ))[0]
    assertNoInternalRetentionGap({ position: C, watermark: W, sequences: rows.map((r) => String(r.change_sequence)), bounded })
    if (rows.length === 0) {
      return { records: [], nextCursor: null, checkpoint: W, hasMore: false, watermark: W, epoch, serverTime }
    }
    const candidates = []
    const candidateSeq = []
    for (const row of rows) {
      const seq = String(row.change_sequence)
      if (row.kind === 'delete') {
        candidates.push({ recordKey: row.record_key, sequence: seq, deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : toMysqlTimestamp(String(row.deleted_at)).replace(' ', 'T') + 'Z' })
        candidateSeq.push(seq)
        continue
      }
      if (row.deliveryState === null || row.deliveryState === undefined) {
        const e = new Error('change detail unavailable; take a full snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
      const live = await getRecord({ owner, recordKey: row.record_key })
      if (!live) {
        const del = await findLatestDeleteMysql(owner, row.record_key)
        if (del && BigInt(del.sequence) > BigInt(W)) {
          candidates.push({ recordKey: row.record_key, sequence: del.sequence, deletedAt: del.deletedAt })
          candidateSeq.push(seq)
        }
        continue
      }
      if (!matchesFeedFilterMysql(live, filter)) continue
      // Event versioning (mbs-8g5.2.4.3): fixed-W pages carry the event's
      // revision/state/sequence, never the current live row.
      candidates.push({
        ...live,
        deliveryState: row.deliveryState,
        revision: String(row.version),
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
    const checkpoint = String(rows[rows.length - 1].change_sequence)
    const hasMore = BigInt(checkpoint) < BigInt(W)
    const nextCursor = hasMore ? newChangesCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: checkpoint, ttlSeconds, nowSeconds: nowSec }) : null
    return { records: admitted, nextCursor, checkpoint: hasMore ? checkpoint : W, hasMore, watermark: W, epoch, serverTime }
  }

  async function listSnapshotPage({ owner, serverSecret, snapshotId, cursor = null, limit = 100, nowSeconds, nowIso: nowIsoValue, ttlSeconds } = {}) {
    validateFeedOwner(owner)
    validateServerSecret(serverSecret)
    const bounded = boundFeedLimit(limit)
    const nowSec = nowSeconds ?? Math.floor(Date.now() / 1000)
    const serverTime = nowIsoValue ?? new Date().toISOString()
    // The shared lock is the privacy linearization boundary. deleteRecord and
    // deleteAll invalidate this same history_snapshots row, so they cannot
    // commit while a page is reading ciphertext. Once invalidation commits,
    // every later reader obtains the lock after the status change and fails
    // closed. A final status reread cannot provide this ordering guarantee.
    return knex.transaction(async (trx) => {
    const metaRow = (await trx.raw(`SELECT * FROM history_snapshots WHERE snapshot_id = ? FOR SHARE`, [snapshotId]))[0][0] ?? null
    const meta = toSnapshotMeta(metaRow)
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
      const expMs = Date.parse(meta.expiresAt instanceof Date ? meta.expiresAt.toISOString() : String(meta.expiresAt))
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
      params.push(decoded.createdAtAtW.slice(0, 19).replace('T', ' '), decoded.createdAtAtW.slice(0, 19).replace('T', ' '), decoded.recordKey)
    }
    sql += ` ORDER BY created_at_at_w, record_key LIMIT ${bounded + 1}`
    const rows = (await trx.raw(sql, params))[0]
    const resolved = []
    for (const row of rows) {
      const liveRow = (await trx.raw(`SELECT * FROM history_records WHERE owner_identity_key = ? AND record_key = ?`, [owner, row.record_key]))[0][0] ?? null
      const live = toRecord(owner, liveRow)
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
        createdAt: row.created_at_at_w instanceof Date ? row.created_at_at_w.toISOString() : String(row.created_at_at_w),
        archivedAt: live.archivedAt,
        expiresAt: live.expiresAt ?? null,
      })
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
    })
  }

  async function getStorageStats({ owner } = {}) {
    validateFeedOwner(owner)
    const usage = await getUsage({ owner })
    const changeCount = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_changes WHERE owner_identity_key = ?`, [owner]))[0][0].n)
    const snapshotCount = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_snapshots WHERE owner_identity_key = ?`, [owner]))[0][0].n)
    const itemCount = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_snapshot_items WHERE snapshot_id IN (SELECT snapshot_id FROM history_snapshots WHERE owner_identity_key = ?)`, [owner]))[0][0].n)
    const tombstoneCount = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_tombstones WHERE owner_identity_key = ?`, [owner]))[0][0].n)
    const changeDetailCount = Number((await knex.raw(`SELECT COUNT(*) AS n FROM history_change_details WHERE owner_identity_key = ?`, [owner]))[0][0].n)
    return {
      live: { recordCount: usage.recordCount, byteCount: usage.byteCount, epoch: usage.epoch, nextSequence: usage.nextSequence },
      physical: { changeCount, changeDetailCount, tombstoneCount, snapshotCount, snapshotItemCount: itemCount },
    }
  }

  async function purgeExpiredChanges({ owner, nowIso: nowValue = new Date().toISOString(), batchSize, maxItems } = {}) {
    return withDeadlockRetry(async () => {
      const { batch: bounded, maxItems: itemBudget } = boundPurgeParams({ batchSize, maxItems, maxSnapshots: 100 })
      if (owner === undefined) {
        const e = new TypeError('owner is required for change purge')
        e.code = 'ERR_INVALID_RECORD'
        throw e
      }
      const cutoff = retentionCutoffIso(nowValue).slice(0, 19).replace('T', ' ')
      // Progress-safe selection (mbs-8g5.2.4.5): exclude protected live
      // upserts in the query so they cannot stall the bounded window when
      // sorting before an eligible state event.
      const due = (await knex.raw(
        `SELECT change_sequence, record_key, kind FROM history_changes
          WHERE owner_identity_key = ? AND created_at < ?
            AND (kind != 'upsert' OR NOT EXISTS
              (SELECT 1 FROM history_records r WHERE r.owner_identity_key = history_changes.owner_identity_key AND r.record_key = history_changes.record_key))
          ORDER BY change_sequence LIMIT ${itemBudget}`,
        [owner, cutoff],
      ))[0]
      const victims = due.slice(0, itemBudget)
      let purged = 0
      await knex.transaction(async (trx) => {
        for (const row of victims) {
          if (purged >= itemBudget) break
          await trx.raw(`DELETE FROM history_change_details WHERE owner_identity_key = ? AND change_sequence = ?`, [owner, String(row.change_sequence)])
          const res = await trx.raw(`DELETE FROM history_changes WHERE owner_identity_key = ? AND change_sequence = ?`, [owner, String(row.change_sequence)])
          purged += Number(res[0].affectedRows ?? 0)
          if (bounded <= 0) break
        }
      })
      const hasMore = Boolean((await knex.raw(
        `SELECT 1 AS one FROM history_changes
          WHERE owner_identity_key = ? AND created_at < ?
            AND (kind != 'upsert' OR NOT EXISTS
              (SELECT 1 FROM history_records r WHERE r.owner_identity_key = history_changes.owner_identity_key AND r.record_key = history_changes.record_key)) LIMIT 1`,
        [owner, cutoff],
      ))[0][0])
      return { purgedChanges: purged, examinedChanges: victims.length, hasMore }
    })
  }

  return { kind: 'mysql', archiveBatch, patchState, deleteRecord, deleteAll, getUsage, getRecord, listChanges, listDeleteEvents, injectFailureOnce, createSnapshot, getSnapshot, listSnapshotMembers, purgeExpiredSnapshots, listBrowse, listChangesPage, listSnapshotPage, getStorageStats, purgeExpiredChanges }
}
