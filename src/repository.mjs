import { createHash } from 'node:crypto'

import {
  assertOwnerDirection,
  bodyHash,
  canonicalRecordKey,
  isIdentityKey,
  LIMITS,
  validateEncryptedBody,
  validateChangeSequence,
  validateEpoch,
  validateIdempotencyKey,
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
import {
  assertNoInternalRetentionGap,
  assertNoRetentionGap,
  boundFeedLimit,
  decodeSnapshotPosition,
  encodeSnapshotPosition,
  FEED_SNAPSHOT,
  FEED_START,
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
} from './feeds.mjs'

const DELIVERY = new Set(['prepared', 'received', 'unknown', 'accepted', 'failed'])

const utf8Bytes = utf8ByteLength

/**
 * Canonical idempotency contract (mbs-8g5.2.3.1.1). All adapters share these
 * helpers so memory, SQLite and MySQL replay identically:
 * - key is per-owner (`owner\0key`), validated as 1..128 [A-Za-z0-9_-];
 * - paramsHash is SHA-256 over canonical JSON of operation inputs (owner and
 *   key excluded; undefined fields omitted; keys sorted);
 * - same key + same hash replays the stored result with `replayed:true` and
 *   allocates no sequence/event/quota/epoch;
 * - same key + different hash (or operation) throws ERR_IDEMPOTENCY_CONFLICT.
 */
export function canonicalParamsHash(params) {
  const canonical = {}
  for (const key of Object.keys(params ?? {}).sort()) {
    const value = params[key]
    if (value === undefined) continue
    canonical[key] = typeof value === 'bigint' ? value.toString() : value
  }
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

export function validateIdempotencyInput(idempotencyKey) {
  if (idempotencyKey === undefined) return undefined
  validateIdempotencyKey(idempotencyKey)
  return idempotencyKey
}

/**
 * Required compare-and-set contract for state transitions. Validate this
 * before acquiring a lock or opening a transaction so omitted fields cannot
 * cause any mutation or owner-state initialization. Replays still enter the
 * normal idempotency path after this shape check.
 */
export function validateStateMutationInput({ expectedRevision, idempotencyKey } = {}) {
  const invalid = (message) => {
    const error = new TypeError(message)
    error.code = 'ERR_INVALID_RECORD'
    throw error
  }
  if (expectedRevision === undefined) invalid('expectedRevision is required')
  try {
    validateChangeSequence(expectedRevision, 'expectedRevision')
  } catch (error) {
    invalid(error?.message ?? 'expectedRevision must be a uint64 decimal string')
  }
  if (idempotencyKey === undefined) invalid('idempotencyKey is required')
  try {
    validateIdempotencyKey(idempotencyKey)
  } catch (error) {
    invalid(error?.message ?? 'idempotencyKey is required')
  }
  return { expectedRevision, idempotencyKey }
}

export function idempotencyConflict(message = 'idempotency key reuse with different input') {
  const error = new RangeError(message)
  error.code = 'ERR_IDEMPOTENCY_CONFLICT'
  throw error
}

export function nextSequenceString(current) {
  return (BigInt(current) + 1n).toString()
}

function nextSeqString(current) {
  return nextSequenceString(current)
}

function nowIso(now) {
  return typeof now === 'function' ? now() : new Date().toISOString()
}

export const MAX_EPOCH_GENERATION = 18446744073709551615n

export function parseEpochGeneration(epoch) {
  const m = /^gen-(\d+)$/.exec(epoch)
  if (!m) return null
  // Arbitrary-precision: return BigInt, never Number (safe beyond 2^53).
  try {
    const value = BigInt(m[1])
    // Canonical form: no leading zeros unless exactly "0".
    const canonical = value.toString()
    if (canonical !== m[1]) return null
    return value
  } catch {
    return null
  }
}

function parseEpochGen(epoch) {
  return parseEpochGeneration(epoch)
}

export function rotateOwnerEpoch(epoch) {
  const gen = parseEpochGeneration(epoch)
  if (gen !== null) {
    if (gen >= MAX_EPOCH_GENERATION) {
      const error = new RangeError('epoch generation exhausted at uint64 maximum')
      error.code = 'ERR_EPOCH_EXHAUSTED'
      throw error
    }
    return `gen-${(gen + 1n).toString()}`
  }
  return `${epoch}#${Date.now()}`
}

function rotateEpoch(epoch) {
  return rotateOwnerEpoch(epoch)
}

export function validateArchiveInput({ owner, epoch, record, ownerEpoch }) {
  if (!isIdentityKey(owner)) return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'owner' }
  try {
    validateEpoch(epoch)
  } catch {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'epoch format' }
  }
  if (ownerEpoch !== undefined && epoch !== ownerEpoch) {
    return { valid: false, code: 'ERR_EPOCH_CHANGED', reason: 'stale epoch' }
  }
  // Check the per-record byte cap before parsing the encrypted envelope. The
  // canonical validator deliberately throws a RangeError for an oversized
  // string; archive callers must preserve that as a typed size outcome rather
  // than collapsing it into malformed-record handling.
  if (typeof record?.body === 'string' && utf8Bytes(record.body) > LIMITS.MAX_BODY_BYTES) {
    return { valid: false, code: 'ERR_REQUEST_TOO_LARGE', reason: 'body exceeds 1 MiB' }
  }
  try {
    validateMessageBox(record.messageBox)
    validateMessageId(record.messageId)
    if (record.direction !== 'inbound' && record.direction !== 'outbound') {
      return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'direction' }
    }
    assertOwnerDirection({
      ownerIdentityKey: owner,
      direction: record.direction,
      sender: record.sender,
      recipient: record.recipient,
    })
    validateEncryptedBody(record.body)
  } catch (error) {
    if (error instanceof RangeError && /inbound recipient|outbound sender/.test(error.message)) {
      return { valid: false, code: 'ERR_INVALID_RECORD', reason: error.message }
    }
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: error.message }
  }
  const bytes = utf8Bytes(record.body)
  if (bytes > LIMITS.MAX_BODY_BYTES) {
    return { valid: false, code: 'ERR_REQUEST_TOO_LARGE', reason: 'body exceeds 1 MiB' }
  }
  let recomputed
  try {
    const bodyHashValue = bodyHash(record.body)
    const recordKey = canonicalRecordKey({
      ownerIdentityKey: owner,
      direction: record.direction,
      messageBox: record.messageBox,
      sender: record.sender,
      recipient: record.recipient,
      messageId: record.messageId,
    })
    recomputed = { bodyHash: bodyHashValue, recordKey }
  } catch (error) {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: error.message }
  }
  if (record.recordKey !== undefined && record.recordKey !== recomputed.recordKey) {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'recordKey mismatch (server recomputes)' }
  }
  if (record.bodyHash !== undefined && record.bodyHash !== recomputed.bodyHash) {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'bodyHash mismatch (server recomputes)' }
  }
  if (record.deliveryState !== undefined && !['prepared', 'received'].includes(record.deliveryState)) {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'deliveryState must be prepared or received on archive' }
  }
  return { valid: true, ...recomputed, bodyBytes: bytes }
}

export function sameImmutableRecord(a, b) {
  return (
    a.messageId === b.messageId &&
    a.messageBox === b.messageBox &&
    a.direction === b.direction &&
    a.sender === b.sender &&
    a.recipient === b.recipient &&
    a.bodyHash === b.bodyHash &&
    a.body === b.body
  )
}

function sameImmutable(a, b) {
  // Memory rows use camelCase; SQL rows use snake_case. Accept both.
  const left = a.message_id !== undefined
    ? { messageId: a.message_id, messageBox: a.message_box, direction: a.direction, sender: a.sender, recipient: a.recipient, bodyHash: a.body_hash, body: a.body }
    : a
  return sameImmutableRecord(left, b)
}

/** Per-owner promise-chain serializer (single-process analog of SELECT ... FOR UPDATE). */
export function createOwnerLocks() {
  const chains = new Map()
  return async function withOwnerLock(owner, fn) {
    const prev = chains.get(owner) ?? Promise.resolve()
    let release
    const current = prev.then(() => fn()).finally(() => {
      if (chains.get(owner) === tracked) chains.delete(owner)
    })
    const tracked = current.catch(() => {})
    chains.set(owner, tracked)
    // Avoid unhandled rejection on the chain while propagating to caller.
    void tracked.catch(() => {})
    return current
  }
}

function createMemoryCore({ limits = {}, now } = {}) {
  const L = { ...LIMITS, ...limits }
  const owners = new Map() // owner -> { epoch, nextSequence, recordCount, byteCount }
  const records = new Map() // `${owner}\0${recordKey}` -> record row
  const tombstones = new Map() // `${owner}\0${recordKey}` -> { sequence, deletedAt }
  const changes = new Map() // owner -> [{ sequence, recordKey, kind, version, deletedAt? }]
  const changePurgePositions = new Map() // owner -> last examined sequence
  const audits = new Map() // owner -> [{ kind, recordKey, detail, at }]
  const snapshots = new Map() // snapshotId -> { snapshotId, owner, epoch, filterHash, filter, watermark, status, createdAt, expiresAt }
  const snapshotItems = new Map() // snapshotId -> [{ recordKey, revisionAtW, deliveryStateAtW, changeSequenceAtW, createdAtAtW }]
  const idempotency = new Map() // `${owner}\0${key}` -> { operation, paramsHash, result }
  const withOwnerLock = createOwnerLocks()
  let commitFailureOnce = false
  const failOnce = { archiveBatch: false, patchState: false, deleteRecord: false, deleteAll: false, snapshotCleanup: false }

  function checkIdempotency({ owner, key, operation, params }) {
    if (key === undefined) return null
    validateIdempotencyInput(key)
    const mapKey = `${owner}\0${key}`
    const paramsHash = canonicalParamsHash(params)
    const existing = idempotency.get(mapKey)
    if (!existing) return { mapKey, paramsHash, existing: null }
    if (existing.operation !== operation || existing.paramsHash !== paramsHash) {
      idempotencyConflict()
    }
    return { mapKey, paramsHash, existing }
  }

  function storeIdempotency(mapKey, operation, paramsHash, result) {
    idempotency.set(mapKey, { operation, paramsHash, result: { ...result } })
  }

  function consumeFailure(op) {
    if (failOnce[op]) {
      failOnce[op] = false
      const error = new Error(`injected ${op} failure`)
      error.code = 'ERR_UNAVAILABLE'
      throw error
    }
    if (op === 'archiveBatch' && commitFailureOnce) {
      // Legacy single-shot flag preserved for existing callers.
      commitFailureOnce = false
      return true
    }
    return false
  }

  function ownerState(owner) {
    let st = owners.get(owner)
    if (!st) {
      st = { epoch: 'gen-1', nextSequence: '1', recordCount: 0, byteCount: 0 }
      owners.set(owner, st)
      changes.set(owner, [])
      audits.set(owner, [])
    }
    return st
  }

  function audit(owner, kind, recordKey, detail) {
    const list = audits.get(owner) ?? []
    list.push({ kind, recordKey, detail, at: nowIso(now) })
    if (list.length > 200) list.splice(0, list.length - 200)
    audits.set(owner, list)
  }

  function allocSequence(st) {
    const seq = st.nextSequence
    st.nextSequence = nextSeqString(seq)
    return seq
  }

  async function archiveBatch({ owner, epoch, records: input }) {
    return withOwnerLock(owner, async () => {
      const st = ownerState(owner)
      if (!Array.isArray(input) || input.length === 0) {
        const e = new TypeError('records must be a non-empty array')
        e.code = 'ERR_INVALID_RECORD'
        throw e
      }
      if (input.length > L.MAX_BATCH_RECORDS) {
        const e = new RangeError('batch exceeds record bound')
        e.code = 'ERR_REQUEST_TOO_LARGE'
        throw e
      }
      let batchBytes = 0
      for (const r of input) batchBytes += typeof r?.body === 'string' ? utf8Bytes(r.body) : 0
      if (batchBytes > L.MAX_BATCH_BYTES) {
        const e = new RangeError('batch exceeds byte bound')
        e.code = 'ERR_REQUEST_TOO_LARGE'
        throw e
      }
      if (epoch !== st.epoch) {
        return {
          epoch: st.epoch,
          committed: false,
          outcomes: input.map((r, index) => ({
            index,
            recordKey: r?.recordKey ?? null,
            outcome: 'epochChanged',
            errorCode: 'ERR_EPOCH_CHANGED',
          })),
        }
      }

      // Phase 1: validate in request order, duplicate-before-quota.
      const planned = []
      let projectedCount = st.recordCount
      let projectedBytes = st.byteCount
      for (let index = 0; index < input.length; index += 1) {
        const record = input[index]
        const check = validateArchiveInput({ owner, epoch, record, ownerEpoch: st.epoch })
        if (!check.valid) {
          const code = check.code === 'ERR_EPOCH_CHANGED' ? 'ERR_EPOCH_CHANGED' : check.code
          planned.push({ index, recordKey: record?.recordKey ?? null, outcome: code === 'ERR_EPOCH_CHANGED' ? 'epochChanged' : 'invalid', errorCode: code })
          continue
        }
        const key = `${owner} ${check.recordKey}`
        const existing = records.get(key)
        if (existing) {
          if (sameImmutable(existing, { ...record, bodyHash: check.bodyHash })) {
            planned.push({ index, recordKey: check.recordKey, outcome: 'alreadyPresent', bodyHash: check.bodyHash })
          } else {
            audit(owner, 'immutable-conflict', check.recordKey, 'same key different content')
            planned.push({ index, recordKey: check.recordKey, outcome: 'conflict', errorCode: 'ERR_IMMUTABLE_CONFLICT' })
          }
          continue
        }
        if (tombstones.has(key)) {
          planned.push({ index, recordKey: check.recordKey, outcome: 'deleted', errorCode: 'ERR_INVALID_RECORD' })
          continue
        }
        if (projectedCount + 1 > L.MAX_RECORDS_PER_OWNER || projectedBytes + check.bodyBytes > L.MAX_BYTES_PER_OWNER) {
          planned.push({ index, recordKey: check.recordKey, outcome: 'quotaExceeded', errorCode: 'ERR_QUOTA_EXCEEDED' })
          continue
        }
        projectedCount += 1
        projectedBytes += check.bodyBytes
        planned.push({
          index,
          recordKey: check.recordKey,
          outcome: 'stored',
          bodyHash: check.bodyHash,
          bodyBytes: check.bodyBytes,
          validated: { ...record, bodyHash: check.bodyHash, bodyBytes: check.bodyBytes },
        })
      }

      // Phase 2: atomic commit of admitted items in request order.
      const admitted = planned.filter((p) => p.outcome === 'stored')
      if (commitFailureOnce || failOnce.archiveBatch) {
        commitFailureOnce = false
        failOnce.archiveBatch = false
        return {
          epoch: st.epoch,
          committed: false,
          outcomes: planned.map((p) =>
            p.outcome === 'stored'
              ? { index: p.index, recordKey: p.recordKey, outcome: 'failed', errorCode: 'ERR_UNAVAILABLE' }
              : p,
          ),
        }
      }
      const at = nowIso(now)
      for (const item of admitted) {
        const seq = allocSequence(st)
        const src = item.validated
        const initialState = src.deliveryState ?? (src.direction === 'outbound' ? 'prepared' : 'received')
        const row = {
          owner,
          recordKey: item.recordKey,
          messageId: src.messageId,
          messageBox: src.messageBox,
          direction: src.direction,
          sender: src.sender,
          recipient: src.recipient,
          body: src.body,
          bodyHash: item.bodyHash,
          bodyBytes: item.bodyBytes,
          deliveryState: initialState,
          revision: '1',
          changeSequence: seq,
          createdAt: at,
          archivedAt: at,
          expiresAt: null,
        }
        records.set(`${owner} ${item.recordKey}`, row)
        st.recordCount += 1
        st.byteCount += item.bodyBytes
        // Preserve the event version for fixed-W pages (mbs-8g5.2.4.3):
        // upsert events carry their initial delivery state so later patches
        // cannot leak post-W state into earlier pages.
        changes.get(owner).push({ sequence: seq, recordKey: item.recordKey, kind: 'upsert', version: '1', deliveryState: initialState, createdAt: at })
        item.sequence = seq
        delete item.validated
      }
      return { epoch: st.epoch, committed: true, outcomes: planned }
    })
  }

  async function patchState({ owner, recordKey, newState, expectedRevision, idempotencyKey }) {
    // Reject omitted CAS/idempotency fields before owner state or any other
    // mutation is touched. Replays/conflicts are handled below as before.
    validateStateMutationInput({ expectedRevision, idempotencyKey })
    return withOwnerLock(owner, async () => {
      const idem = checkIdempotency({ owner, key: idempotencyKey, operation: 'patchState', params: { recordKey, newState, expectedRevision: expectedRevision === undefined ? undefined : String(expectedRevision) } })
      if (idem?.existing) {
        return { ...idem.existing.result, replayed: true }
      }
      consumeFailure('patchState')
      const st = ownerState(owner)
      if (!DELIVERY.has(newState)) {
        const e = new TypeError('unknown delivery state')
        e.code = 'ERR_INVALID_RECORD'
        throw e
      }
      const key = `${owner} ${recordKey}`
      if (tombstones.has(key)) {
        const e = new RangeError('record deleted; deletion wins')
        e.code = 'ERR_INVALID_RECORD'
        throw e
      }
      const row = records.get(key)
      if (!row) {
        const e = new RangeError('record not found')
        e.code = 'ERR_INVALID_RECORD'
        throw e
      }
      if (expectedRevision !== undefined && row.revision !== String(expectedRevision)) {
        const e = new RangeError('revision conflict')
        e.code = 'ERR_REVISION_CONFLICT'
        throw e
      }
      if (row.deliveryState === 'accepted' && newState !== 'accepted') {
        const e = new RangeError('accepted cannot downgrade')
        e.code = 'ERR_REVISION_CONFLICT'
        throw e
      }
      if (row.deliveryState === newState) {
        const result = { ok: true, recordKey, revision: row.revision, sequence: row.changeSequence, deduped: true }
        if (idem) storeIdempotency(idem.mapKey, 'patchState', idem.paramsHash, result)
        return result
      }
      const seq = allocSequence(st)
      row.deliveryState = newState
      row.revision = nextSeqString(row.revision)
      row.changeSequence = seq
      changes.get(owner).push({ sequence: seq, recordKey, kind: 'state', version: row.revision, deliveryState: newState, createdAt: nowIso(now) })
      const result = { ok: true, recordKey, revision: row.revision, sequence: seq }
      if (idem) storeIdempotency(idem.mapKey, 'patchState', idem.paramsHash, result)
      return result
    })
  }

  async function deleteRecord({ owner, recordKey, idempotencyKey }) {
    return withOwnerLock(owner, async () => {
      const idem = checkIdempotency({ owner, key: idempotencyKey, operation: 'deleteRecord', params: { recordKey } })
      if (idem?.existing) {
        return { ...idem.existing.result, replayed: true }
      }
      consumeFailure('deleteRecord')
      const st = ownerState(owner)
      const key = `${owner} ${recordKey}`
      const row = records.get(key)
      if (!row && !tombstones.has(key)) {
        const result = { deleted: false, epoch: st.epoch }
        if (idem) storeIdempotency(idem.mapKey, 'deleteRecord', idem.paramsHash, result)
        return result
      }
      const seq = allocSequence(st)
      const at = nowIso(now)
      if (row) {
        st.recordCount -= 1
        st.byteCount -= row.bodyBytes
        records.delete(key)
      }
      tombstones.set(key, { sequence: seq, deletedAt: at })
      // Body-free delete event: only key, sequence and canonical time, never ciphertext.
      changes.get(owner).push({ sequence: seq, recordKey, kind: 'delete', version: '1', deletedAt: at, createdAt: at })
      invalidateSnapshotsForRecord(owner, st.epoch, recordKey)
      const result = { deleted: true, sequence: seq, epoch: st.epoch }
      if (idem) storeIdempotency(idem.mapKey, 'deleteRecord', idem.paramsHash, result)
      return result
    })
  }

  async function deleteAll({ owner, idempotencyKey, expectedEpoch }) {
    return withOwnerLock(owner, async () => {
      // Idempotency is checked before the live-epoch CAS: an exact retry must
      // replay its committed result even though that result rotated the epoch.
      const idem = checkIdempotency({ owner, key: idempotencyKey, operation: 'deleteAll', params: { expectedEpoch } })
      if (idem?.existing) {
        return { ...idem.existing.result, replayed: true }
      }
      const currentEpoch = owners.get(owner)?.epoch ?? 'gen-1'
      if (expectedEpoch !== undefined && expectedEpoch !== currentEpoch) {
        const error = new RangeError('epoch changed')
        error.code = 'ERR_EPOCH_CHANGED'
        throw error
      }
      consumeFailure('deleteAll')
      const st = ownerState(owner)
      const oldEpoch = st.epoch
      for (const key of [...records.keys()]) {
        if (key.startsWith(`${owner} `)) records.delete(key)
      }
      for (const key of [...tombstones.keys()]) {
        if (key.startsWith(`${owner} `)) tombstones.delete(key)
      }
      st.recordCount = 0
      st.byteCount = 0
      st.epoch = rotateEpoch(st.epoch)
      changes.set(owner, [])
      invalidateSnapshotsForEpoch(owner, oldEpoch)
      const result = { epoch: st.epoch }
      if (idem) storeIdempotency(idem.mapKey, 'deleteAll', idem.paramsHash, result)
      return result
    })
  }

  function invalidateSnapshotsForRecord(owner, epoch, recordKey) {
    for (const meta of snapshots.values()) {
      if (meta.owner !== owner || meta.epoch !== epoch || meta.status !== SNAPSHOT_STATUS.ACTIVE) continue
      const items = snapshotItems.get(meta.snapshotId) ?? []
      if (items.some((item) => item.recordKey === recordKey)) meta.status = SNAPSHOT_STATUS.INVALIDATED
    }
  }

  function invalidateSnapshotsForEpoch(owner, epoch) {
    for (const meta of snapshots.values()) {
      if (meta.owner === owner && meta.epoch === epoch && meta.status === SNAPSHOT_STATUS.ACTIVE) {
        meta.status = SNAPSHOT_STATUS.INVALIDATED
      }
    }
  }

  function creationSequenceOf(owner, recordKey) {
    for (const change of changes.get(owner) ?? []) {
      if (change.recordKey === recordKey && change.kind === 'upsert') return change.sequence
    }
    return null
  }

  async function createSnapshot({ owner, filter = {} } = {}) {
    return withOwnerLock(owner, async () => {
      validateSnapshotFilter(filter)
      const st = ownerState(owner)
      const w = st.nextSequence === '1' ? '0' : (BigInt(st.nextSequence) - 1n).toString()
      const wBig = BigInt(w)
      const members = []
      for (const row of records.values()) {
        if (row.owner !== owner) continue
        const created = creationSequenceOf(owner, row.recordKey)
        if (created === null || BigInt(created) > wBig) continue
        if (!matchesSnapshotFilter(row, filter)) continue
        members.push(row)
      }
      members.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.recordKey < b.recordKey ? -1 : 1))
      const snapshotId = generateSnapshotId()
      const at = nowIso(now)
      const filterHash = snapshotFilterHash(filter)
      snapshots.set(snapshotId, {
        snapshotId,
        owner,
        epoch: st.epoch,
        feed: SNAPSHOT_FEED,
        filterHash,
        filter: { ...filter },
        watermark: w,
        status: SNAPSHOT_STATUS.ACTIVE,
        createdAt: at,
        expiresAt: snapshotExpiryIso(Date.parse(at)),
      })
      snapshotItems.set(
        snapshotId,
        members.map((row) => ({
          recordKey: row.recordKey,
          revisionAtW: row.revision,
          deliveryStateAtW: row.deliveryState,
          changeSequenceAtW: row.changeSequence,
          createdAtAtW: row.createdAt,
        })),
      )
      return { snapshotId, epoch: st.epoch, feed: SNAPSHOT_FEED, filterHash, watermark: w, memberCount: members.length, status: SNAPSHOT_STATUS.ACTIVE }
    })
  }

  function boundGetSnapshot({ snapshotId, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark }) {
    const meta = snapshots.get(snapshotId)
    if (!meta) return null
    assertSnapshotBinding({ stored: meta, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark })
    const { filter, ...rest } = meta
    return { ...rest }
  }

  function getSnapshot({ snapshotId, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark } = {}) {
    // Owner is required: snapshotId alone is never bearer authority.
    if (owner === undefined) {
      const error = new TypeError('owner is required for snapshot reads')
      error.code = 'ERR_INVALID_RECORD'
      throw error
    }
    return boundGetSnapshot({ snapshotId, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark })
  }

  function listSnapshotMembers({ snapshotId, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark, limit = 100, after } = {}) {
    if (owner === undefined) {
      const error = new TypeError('owner is required for snapshot reads')
      error.code = 'ERR_INVALID_RECORD'
      throw error
    }
    const meta = snapshots.get(snapshotId)
    if (!meta) return null
    assertSnapshotBinding({ stored: meta, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark })
    if (meta.status !== SNAPSHOT_STATUS.ACTIVE) return { status: meta.status, items: [] }
    if (meta.expiresAt !== undefined && meta.expiresAt !== null && !Number.isNaN(Date.parse(meta.expiresAt)) && Date.parse(meta.expiresAt) <= Date.now()) {
      return { status: meta.status, items: [] }
    }
    const bounded = Math.max(1, Math.min(Number(limit) || 100, LIMITS.MAX_PAGE_RECORDS))
    let items = snapshotItems.get(snapshotId) ?? []
    if (after?.createdAtAtW !== undefined && after?.recordKey !== undefined) {
      items = items.filter(
        (item) => item.createdAtAtW > after.createdAtAtW || (item.createdAtAtW === after.createdAtAtW && item.recordKey > after.recordKey),
      )
    }
    return { status: meta.status, items: items.slice(0, bounded) }
  }

  function purgeExpiredSnapshots({ nowIso: nowValue = new Date().toISOString(), batchSize, maxItems, maxSnapshots } = {}) {
    if (failOnce.snapshotCleanup) {
      failOnce.snapshotCleanup = false
      const error = new Error('injected snapshotCleanup failure')
      error.code = 'ERR_UNAVAILABLE'
      throw error
    }
    const { batch: bounded, maxItems: itemBudget, maxSnapshots: snapBudget } = boundPurgeParams({ batchSize, maxItems, maxSnapshots })
    let purgedItems = 0
    let purgedSnapshots = 0
    let itemAllowance = itemBudget
    // Deterministic bounded target selection: the snapshot budget is applied
    // before any membership inspection or mutation. A full target batch may
    // conservatively report hasMore; the next call proves whether another
    // batch exists without examining more than its own budget.
    const ordered = []
    for (const entry of snapshots) {
      const [snapshotId, meta] = entry
      if (meta.expiresAt > nowValue && !(meta.status === SNAPSHOT_STATUS.INVALIDATED && (snapshotItems.get(snapshotId)?.length ?? 0) > 0)) continue
      ordered.push(entry)
      if (ordered.length >= snapBudget) break
    }
    for (const [snapshotId, meta] of ordered) {
      if (itemAllowance <= 0) break
      const due = meta.expiresAt <= nowValue || (meta.status === SNAPSHOT_STATUS.INVALIDATED && (snapshotItems.get(snapshotId)?.length ?? 0) > 0)
      if (!due) continue
      const items = snapshotItems.get(snapshotId) ?? []
      while (items.length > 0 && itemAllowance > 0) {
        const take = Math.min(bounded, itemAllowance, items.length)
        items.splice(0, take)
        purgedItems += take
        itemAllowance -= take
        if (take < bounded) break
      }
      const itemsRemain = (snapshotItems.get(snapshotId) ?? []).length > 0
      if (itemsRemain) {
        // Budget exhausted mid-snapshot: report continuation; row stays.
        break
      }
      snapshotItems.delete(snapshotId)
      if (meta.expiresAt <= nowValue) {
        snapshots.delete(snapshotId)
        purgedSnapshots += 1
      }
      // Invalidated-but-unexpired rows remain as restart signals with no items.
    }
    // A full anchor batch means there may be another due anchor. If item work
    // exhausted, the current anchor also needs continuation. Both signals are
    // bounded and converge on a subsequent call.
    const hasMore = itemAllowance <= 0 || ordered.length >= snapBudget
    return { purgedItems, purgedSnapshots, examinedSnapshots: ordered.length, hasMore }
  }

  function getUsage({ owner }) {
    const st = ownerState(owner)
    return { recordCount: st.recordCount, byteCount: st.byteCount, epoch: st.epoch, nextSequence: st.nextSequence }
  }

  function getRecord({ owner, recordKey }) {
    const row = records.get(`${owner} ${recordKey}`)
    return row ? { ...row } : null
  }

  function listChanges({ owner }) {
    return (changes.get(owner) ?? []).map((c) => {
      const out = { sequence: String(c.sequence), recordKey: c.recordKey, kind: c.kind, version: String(c.version) }
      if (c.deletedAt !== undefined) out.deletedAt = c.deletedAt
      return out
    })
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

  function listDeleteEvents({ owner } = {}) {
    // Body-free delete events: only key, sequence and canonical time.
    return (changes.get(owner) ?? [])
      .filter((c) => c.kind === 'delete')
      .map((c) => ({ recordKey: c.recordKey, sequence: String(c.sequence), deletedAt: c.deletedAt }))
  }

  function earliestSequence(owner) {
    let min = null
    for (const c of changes.get(owner) ?? []) {
      if (min === null || BigInt(c.sequence) < BigInt(min)) min = String(c.sequence)
    }
    return min
  }

  function currentWatermark(st) {
    return st.nextSequence === '1' ? '0' : (BigInt(st.nextSequence) - 1n).toString()
  }

  function toHistoryRecord(row) {
    return row ? { ...row } : null
  }

  /**
   * Browse: live keyset over (createdAt, recordKey). Non-authoritative;
   * never a convergence primitive. Excludes tombstoned bodies.
   */
  function listBrowse({ owner, filter = {}, limit = 100, after } = {}) {
    validateFeedOwner(owner)
    validateSnapshotFilter(filter)
    const bounded = boundFeedLimit(limit)
    const live = []
    for (const row of records.values()) {
      if (row.owner !== owner) continue
      if (!matchesFeedFilter(row, filter)) continue
      live.push(row)
    }
    live.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.recordKey < b.recordKey ? -1 : 1))
    let items = live
    if (after?.createdAt !== undefined && after?.recordKey !== undefined) {
      items = items.filter((r) => r.createdAt > after.createdAt || (r.createdAt === after.createdAt && r.recordKey > after.recordKey))
    }
    const page = items.slice(0, bounded).map(toHistoryRecord)
    const last = page[page.length - 1]
    return { items: page, nextAfter: page.length === bounded && last ? { createdAt: last.createdAt, recordKey: last.recordKey } : null }
  }

  function findLatestDelete(owner, recordKey) {
    let latest = null
    for (const c of changes.get(owner) ?? []) {
      if (c.recordKey === recordKey && c.kind === 'delete' && (latest === null || BigInt(c.sequence) > BigInt(latest.sequence))) latest = c
    }
    return latest
  }

  /**
   * Authoritative incremental changes in (C,W] with HMAC cursors. Fixed W,
   * sequence-ordered, no gaps/duplicates by sequence. Live views converge
   * idempotently; tombstoned bodies are never served (early delete).
   */
  function listChangesPage({ owner, serverSecret, cursor = null, limit = 100, filter = {}, nowSeconds, nowIso: nowIsoValue, ttlSeconds } = {}) {
    validateFeedOwner(owner)
    validateServerSecret(serverSecret)
    validateSnapshotFilter(filter)
    const filterDigest = snapshotFilterHash(filter)
    const bounded = boundFeedLimit(limit)
    const nowSec = nowSeconds ?? Math.floor(Date.now() / 1000)
    const serverTime = nowIsoValue ?? nowIso(now) ?? new Date().toISOString()
    const st = ownerState(owner)
    let W
    let C
    let epoch
    if (cursor === null || cursor === undefined) {
      W = currentWatermark(st)
      C = FEED_START
      epoch = st.epoch
      try {
        validateChangeSequence(W, 'watermark')
      } catch {
        const e = new Error('watermark malformed')
        e.code = 'ERR_INVALID_CURSOR'
        throw e
      }
    } else {
      const payload = verifyChangesCursor(cursor, { serverSecret, owner, expectedEpoch: st.epoch, expectedFilterDigest: filterDigest, nowSeconds: nowSec })
      W = String(payload.w)
      C = String(payload.p)
      epoch = String(payload.epoch)
      validateChangesPosition(C)
      try {
        validateChangeSequence(W, 'watermark')
      } catch {
        const e = new Error('watermark malformed')
        e.code = 'ERR_INVALID_CURSOR'
        throw e
      }
    }
    const earliest = earliestSequence(owner)
    // Fresh starts (C=0) never expire via retention: they return available
    // retained history. Empty-cache completeness requires a snapshot per ADR;
    // changes from 0 is not a completeness proof. Continuations (C>0) expire
    // when purged gaps enter the unapplied range.
    if (C !== FEED_START) {
      assertNoRetentionGap({ position: C, earliest })
      if (earliest === null && C !== W) {
        const e = new Error('cursor outside retained history; take a full snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
    }
    const all = (changes.get(owner) ?? []).filter((c) => BigInt(c.sequence) > BigInt(C) && BigInt(c.sequence) <= BigInt(W))
    all.sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1))
    const scanned = all.slice(0, bounded)
    // Internal retention gaps (mbs-8g5.2.4.4): any purged sequence inside
    // (C,W] fails closed even when the start is still retained.
    assertNoInternalRetentionGap({ position: C, watermark: W, sequences: scanned.map((c) => String(c.sequence)), bounded })
    if (scanned.length === 0) {
      // Empty final checkpoint still represents W.
      return { records: [], nextCursor: null, checkpoint: W, hasMore: false, watermark: W, epoch, serverTime }
    }
    const candidates = []
    const candidateSeq = []
    for (const c of scanned) {
      if (c.kind === 'delete') {
        candidates.push({ recordKey: c.recordKey, sequence: String(c.sequence), deletedAt: c.deletedAt })
        candidateSeq.push(String(c.sequence))
        continue
      }
      const live = getRecord({ owner, recordKey: c.recordKey })
      if (!live) {
        const del = findLatestDelete(owner, c.recordKey)
        if (del && BigInt(del.sequence) > BigInt(W)) {
          // Privacy: body purged after W; converge early with the delete.
          candidates.push({ recordKey: c.recordKey, sequence: String(del.sequence), deletedAt: del.deletedAt })
          candidateSeq.push(String(c.sequence))
        }
        // Else the delete event is itself in range (or will be covered); skip
        // the superseded upsert/state to avoid duplicate bodies.
        continue
      }
      if (!matchesFeedFilter(live, filter)) continue
      // Event versioning (mbs-8g5.2.4.3): return the version described by
      // this change event, not the current live row, so post-W mutations
      // cannot leak into a fixed-W page and repeated events for one record
      // carry distinct sequences.
      candidates.push({
        ...live,
        deliveryState: c.deliveryState ?? live.deliveryState,
        revision: String(c.version),
        changeSequence: String(c.sequence),
      })
      candidateSeq.push(String(c.sequence))
    }
    const budgetCursor = newChangesCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: W, ttlSeconds, nowSeconds: nowSec })
    const overheadBytes = historyPageOverheadBytes({ records: [], nextCursor: budgetCursor, checkpoint: W, hasMore: true, watermark: W, epoch, serverTime })
    const { admitted } = fitRecordsToPage({ records: candidates, limit: bounded, overheadBytes })
    const byteCut = admitted.length < candidates.length
    let checkpoint
    let hasMore
    let nextCursor
    if (byteCut) {
      // Page full: checkpoint at last admitted scanned sequence for progress.
      let lastIdx = -1
      let count = 0
      for (let i = 0; i < candidates.length && count < admitted.length; i += 1) {
        // Admitted is a prefix of candidates; map by identity order.
        if (candidates[i] === admitted[count]) {
          lastIdx = i
          count += 1
        }
      }
      checkpoint = lastIdx >= 0 ? candidateSeq[lastIdx] : C
      hasMore = true
      nextCursor = newChangesCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: checkpoint, ttlSeconds, nowSeconds: nowSec })
    } else {
      checkpoint = String(scanned[scanned.length - 1].sequence)
      hasMore = BigInt(checkpoint) < BigInt(W)
      nextCursor = hasMore ? newChangesCursor({ serverSecret, owner, epoch, filterDigest, watermark: W, position: checkpoint, ttlSeconds, nowSeconds: nowSec }) : null
      if (!hasMore) checkpoint = W
    }
    return { records: admitted, nextCursor, checkpoint, hasMore, watermark: W, epoch, serverTime }
  }

  /**
   * Authoritative snapshot HistoryPage at fixed W with HMAC cursors.
   * Invalidated snapshots never serve bodies (ERR_CURSOR_EXPIRED).
   */
  function listSnapshotPage({ owner, serverSecret, snapshotId, cursor = null, limit = 100, nowSeconds, nowIso: nowIsoValue, ttlSeconds } = {}) {
    validateFeedOwner(owner)
    validateServerSecret(serverSecret)
    const bounded = boundFeedLimit(limit)
    const nowSec = nowSeconds ?? Math.floor(Date.now() / 1000)
    const serverTime = nowIsoValue ?? nowIso(now) ?? new Date().toISOString()
    if (owner === undefined) {
      const e = new TypeError('owner is required for snapshot reads')
      e.code = 'ERR_INVALID_RECORD'
      throw e
    }
    const meta = snapshots.get(snapshotId)
    if (!meta) return null
    assertSnapshotBinding({ stored: meta, owner })
    const W = String(meta.watermark)
    const epoch = String(meta.epoch)
    const filterDigest = String(meta.filterHash ?? '')
    // Cursor integrity first (mbs-8g5.2.4.6): a tampered continuation on an
    // invalidated/expired snapshot must fail as ERR_INVALID_CURSOR, not
    // ERR_CURSOR_EXPIRED. Status/expiry are checked only after the cursor
    // proves authentic for this owner/epoch/filter/W.
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
    // Absolute snapshot expiry (mbs-8g5.2.4.6): never serve bodies past
    // meta.expiresAt even if the row has not been purged yet.
    if (meta.expiresAt !== undefined && meta.expiresAt !== null) {
      const expMs = Date.parse(meta.expiresAt)
      if (!Number.isNaN(expMs) && expMs <= Date.parse(serverTime)) {
        const e = new Error('snapshot expired; take a new snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
    }
    let items = snapshotItems.get(snapshotId) ?? []
    if (position !== FEED_START) {
      const decoded = decodeSnapshotPosition(position)
      items = items.filter((it) => it.createdAtAtW > decoded.createdAtAtW || (it.createdAtAtW === decoded.createdAtAtW && it.recordKey > decoded.recordKey))
    }
    // Peek one extra to decide hasMore without an unbounded scan.
    const window = items.slice(0, bounded + 1)
    const resolved = []
    for (const it of window) {
      const live = getRecord({ owner, recordKey: it.recordKey })
      if (!live) {
        const e = new Error('snapshot invalidated; take a new snapshot')
        e.code = 'ERR_CURSOR_EXPIRED'
        throw e
      }
      // Absolute record expiry: never serve an expired body via snapshot.
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
        deliveryState: it.deliveryStateAtW,
        revision: String(it.revisionAtW),
        changeSequence: String(it.changeSequenceAtW),
        createdAt: it.createdAtAtW,
        archivedAt: live.archivedAt,
        expiresAt: live.expiresAt ?? null,
      })
    }
    // Final invalidation check (mbs-8g5.2.4.1): a deletion committing between
    // the opening metadata read and the body fetches must not serve stale
    // ciphertext. Re-read the snapshot row; any transition to invalidated
    // (or expiry) fails closed before bodies are returned.
    {
      const fresh = snapshots.get(snapshotId)
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
    // Snapshot checkpoint is always the fixed watermark, even on empty/final.
    return { records: admitted, nextCursor, checkpoint: W, hasMore, watermark: W, epoch, serverTime }
  }

  function getStorageStats({ owner } = {}) {
    validateFeedOwner(owner)
    const st = ownerState(owner)
    let snapshotCount = 0
    let snapshotItemCount = 0
    for (const meta of snapshots.values()) {
      if (meta.owner !== owner) continue
      snapshotCount += 1
      snapshotItemCount += (snapshotItems.get(meta.snapshotId) ?? []).length
    }
    return {
      live: { recordCount: st.recordCount, byteCount: st.byteCount, epoch: st.epoch, nextSequence: st.nextSequence },
      physical: { changeCount: (changes.get(owner) ?? []).length, changeDetailCount: (changes.get(owner) ?? []).filter((c) => c.kind !== 'delete').length, tombstoneCount: tombstones.get(owner)?.size ?? 0, snapshotCount, snapshotItemCount },
    }
  }

  /**
   * Bounded change retention purge (30-day window). Retains upserts for
   * still-live records (creation needed for snapshot stability); purges old
   * states, old upserts for deleted keys, and old deletes beyond retention.
   */
  function purgeExpiredChanges({ owner, nowIso: nowValue = new Date().toISOString(), batchSize, maxItems } = {}) {
    const { batch: bounded, maxItems: itemBudget } = boundPurgeParams({ batchSize, maxItems, maxSnapshots: 100 })
    const cutoff = retentionCutoffIso(nowValue)
    const targets = []
    // Honest examination accounting (mbs-8g5.2.4.5): count every old row
    // inspected, including protected live upserts skipped for snapshot
    // stability, so reported work covers the actual scan.
    let examined = 0
    const list = changes.get(owner) ?? []
    if (owner !== undefined) {
      const after = changePurgePositions.get(owner)
      const ordered = [...list].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1)
      const start = after === undefined ? 0 : Math.max(0, ordered.findIndex((c) => BigInt(c.sequence) > BigInt(after)))
      let lastExamined
      for (let i = start; i < ordered.length && examined < itemBudget; i += 1) {
        const c = ordered[i]
        if (c.createdAt !== undefined && c.createdAt !== null && c.createdAt >= cutoff) continue
        // Without timestamps (legacy), treat as recent to avoid surprise purge.
        if (c.createdAt === undefined || c.createdAt === null) continue
        examined += 1
        lastExamined = String(c.sequence)
        if (c.kind === 'upsert') {
          const live = getRecord({ owner, recordKey: c.recordKey })
          if (live) continue // retain creation for live snapshot stability
        }
        targets.push(c)
      }
      if (lastExamined !== undefined && ordered.some((c) => BigInt(c.sequence) > BigInt(lastExamined))) changePurgePositions.set(owner, lastExamined)
      else changePurgePositions.delete(owner)
    } else {
      for (const [changeOwner, arr] of changes) {
        for (const c of arr) {
          if (c.createdAt !== undefined && c.createdAt !== null && c.createdAt >= cutoff) continue
          if (c.createdAt === undefined || c.createdAt === null) continue
          examined += 1
          if (c.kind === 'upsert') {
            const live = getRecord({ owner: changeOwner, recordKey: c.recordKey })
            if (live) continue
          }
          targets.push({ owner: changeOwner, change: c })
          if (targets.length >= itemBudget) break
        }
        if (targets.length >= itemBudget) break
      }
    }
    let purged = 0
    let allowance = itemBudget
    if (owner !== undefined) {
      const arr = changes.get(owner) ?? []
      const victims = new Set(targets)
      // Delete in bounded batches to keep per-call work predictable.
      while (victims.size > 0 && allowance > 0) {
        const take = Math.min(bounded, allowance, victims.size)
        let removed = 0
        for (let i = arr.length - 1; i >= 0 && removed < take; i -= 1) {
          if (victims.has(arr[i])) {
            const victim = arr[i]
            arr.splice(i, 1)
            victims.delete(victim)
            removed += 1
          }
        }
        purged += removed
        allowance -= removed
        if (removed < take) break
      }
    }
    const hasMore = owner !== undefined ? changePurgePositions.has(owner) || targets.length >= itemBudget || allowance <= 0 : targets.length >= itemBudget || allowance <= 0
    return { purgedChanges: purged, examinedChanges: examined, hasMore }
  }

  return {
    kind: 'memory',
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
    createSnapshot,
    getSnapshot,
    listSnapshotMembers,
    purgeExpiredSnapshots,
    listBrowse,
    listChangesPage,
    listSnapshotPage,
    getStorageStats,
    purgeExpiredChanges,
    _debug: { owners, records, tombstones, changes, audits, idempotency, snapshots, snapshotItems },
  }
}

export function createMemoryStore(options) {
  return createMemoryCore(options)
}

export async function createSqliteStore({ limits = {}, now, path = ':memory:' } = {}) {
  // Persistent implementation lives in repository.sqlite.mjs; dynamic import
  // keeps this module free of cycles and of the node:sqlite warning unless used.
  const mod = await import('./repository.sqlite.mjs')
  return mod.createSqliteStore({ limits, now, path })
}

export const __testOnly = { validateArchiveInput }
