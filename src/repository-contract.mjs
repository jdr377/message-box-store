import { createHash } from 'node:crypto'

import {
  assertOwnerDirection,
  bodyHash,
  canonicalRecordKey,
  INITIAL_DELIVERY_STATES,
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

/** Canonical hash for one operation's idempotency inputs. */
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

/** Replay results remain authoritative for one day; new keys are rejected at capacity. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_IDEMPOTENCY_ROWS_PER_OWNER = 1024

export function auxiliaryQuotaExceeded(resource) {
  const error = new RangeError(`${resource} capacity reached`)
  error.code = 'ERR_QUOTA_EXCEEDED'
  throw error
}

export function nextSequenceString(current) {
  return (BigInt(current) + 1n).toString()
}

export const MAX_EPOCH_GENERATION = 18446744073709551615n

export function parseEpochGeneration(epoch) {
  const match = /^gen-(\d+)$/.exec(epoch)
  if (!match) return null
  try {
    const value = BigInt(match[1])
    return value.toString() === match[1] ? value : null
  } catch {
    return null
  }
}

export function rotateOwnerEpoch(epoch) {
  const generation = parseEpochGeneration(epoch)
  if (generation !== null) {
    if (generation >= MAX_EPOCH_GENERATION) {
      const error = new RangeError('epoch generation exhausted at uint64 maximum')
      error.code = 'ERR_EPOCH_EXHAUSTED'
      throw error
    }
    return `gen-${(generation + 1n).toString()}`
  }
  return `${epoch}#${Date.now()}`
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
  if (typeof record?.body === 'string' && utf8ByteLength(record.body) > LIMITS.MAX_BODY_BYTES) {
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
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: error.message }
  }
  const bodyBytes = utf8ByteLength(record.body)
  if (bodyBytes > LIMITS.MAX_BODY_BYTES) {
    return { valid: false, code: 'ERR_REQUEST_TOO_LARGE', reason: 'body exceeds 1 MiB' }
  }
  let recomputed
  try {
    recomputed = {
      bodyHash: bodyHash(record.body),
      recordKey: canonicalRecordKey({
        ownerIdentityKey: owner,
        direction: record.direction,
        messageBox: record.messageBox,
        sender: record.sender,
        recipient: record.recipient,
        messageId: record.messageId,
      }),
    }
  } catch (error) {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: error.message }
  }
  if (record.recordKey !== undefined && record.recordKey !== recomputed.recordKey) {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'recordKey mismatch (server recomputes)' }
  }
  if (record.bodyHash !== undefined && record.bodyHash !== recomputed.bodyHash) {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'bodyHash mismatch (server recomputes)' }
  }
  if (record.deliveryState !== undefined && !INITIAL_DELIVERY_STATES.includes(record.deliveryState)) {
    return { valid: false, code: 'ERR_INVALID_RECORD', reason: 'deliveryState must be prepared or received on archive' }
  }
  return { valid: true, ...recomputed, bodyBytes }
}

export function validateArchiveBatchBounds(records, limits = LIMITS) {
  if (!Array.isArray(records) || records.length === 0) {
    const error = new TypeError('records must be a non-empty array')
    error.code = 'ERR_INVALID_RECORD'
    throw error
  }
  if (records.length > limits.MAX_BATCH_RECORDS ||
      records.reduce((bytes, record) => bytes + (typeof record?.body === 'string' ? utf8ByteLength(record.body) : 0), 0) > limits.MAX_BATCH_BYTES) {
    const error = new RangeError('batch exceeds bound')
    error.code = 'ERR_REQUEST_TOO_LARGE'
    throw error
  }
}

export function archiveEpochChanged(records, epoch) {
  return {
    epoch,
    committed: false,
    outcomes: records.map((record, index) => ({ index, recordKey: record?.recordKey ?? null, outcome: 'epochChanged', errorCode: 'ERR_EPOCH_CHANGED' })),
  }
}

export function archiveInvalidOutcome(index, record, check) {
  return { index, recordKey: record?.recordKey ?? null, outcome: check.code === 'ERR_EPOCH_CHANGED' ? 'epochChanged' : 'invalid', errorCode: check.code }
}

export function archiveExistingOutcome(index, record, check, existing) {
  return sameImmutableRecord(existing, { ...record, bodyHash: check.bodyHash })
    ? { index, recordKey: check.recordKey, outcome: 'alreadyPresent', bodyHash: check.bodyHash }
    : { index, recordKey: check.recordKey, outcome: 'conflict', errorCode: 'ERR_IMMUTABLE_CONFLICT' }
}

export function archiveAdmissionOutcome(index, record, check, projected, limits = LIMITS) {
  if (projected.count + 1 > limits.MAX_RECORDS_PER_OWNER || projected.bytes + check.bodyBytes > limits.MAX_BYTES_PER_OWNER) {
    return { index, recordKey: check.recordKey, outcome: 'quotaExceeded', errorCode: 'ERR_QUOTA_EXCEEDED' }
  }
  projected.count += 1
  projected.bytes += check.bodyBytes
  return { index, recordKey: check.recordKey, outcome: 'stored', bodyHash: check.bodyHash, bodyBytes: check.bodyBytes, validated: { ...record } }
}

export function sameImmutableRecord(left, right) {
  return (
    left.messageId === right.messageId &&
    left.messageBox === right.messageBox &&
    left.direction === right.direction &&
    left.sender === right.sender &&
    left.recipient === right.recipient &&
    left.bodyHash === right.bodyHash &&
    left.body === right.body
  )
}

/** Per-owner promise-chain serializer used by in-process adapters. */
export function createOwnerLocks() {
  const chains = new Map()
  return async function withOwnerLock(owner, fn) {
    const previous = chains.get(owner) ?? Promise.resolve()
    let tracked
    const current = previous.then(() => fn()).finally(() => {
      if (chains.get(owner) === tracked) chains.delete(owner)
    })
    tracked = current.catch(() => {})
    chains.set(owner, tracked)
    void tracked.catch(() => {})
    return current
  }
}
