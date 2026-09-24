import { randomBytes } from 'node:crypto'
import { isIdentityKey, sha256Hex, validateDirection, validateMessageBox } from './canonical-runtime.js'

/**
 * Shared snapshot-foundation helpers (mbs-8g5.2.3.3). Storage lives in the
 * repository adapters; this module holds only pure policy: filter identity,
 * snapshot TTL, purge batching and ID generation. No cursors or feed
 * behavior — those belong to mbs-8g5.2.4.
 */

export const SNAPSHOT_STATUS = Object.freeze({ ACTIVE: 'active', INVALIDATED: 'invalidated' })
/** Snapshots are short-lived capture aids, not retention: 1 hour. */
export const SNAPSHOT_TTL_SECONDS = 3600
/** Physical per-owner admission limits, including expired rows awaiting purge. */
export const MAX_SNAPSHOTS_PER_OWNER = 32
export const MAX_SNAPSHOT_ITEMS_PER_OWNER = 40000
export const SNAPSHOT_PURGE_BATCH = 500
/** Total work bound per purge invocation (mbs-8g5.2.3.3.1). */
export const SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL = 5000
export const SNAPSHOT_PURGE_MAX_SNAPSHOTS_PER_CALL = 100
export const SNAPSHOT_VERSION = '002-snapshot-foundation'
/** Snapshot feed binding: all foundation snapshots serve the snapshot feed. No .2.4 cursor/feed behavior. */
export const SNAPSHOT_FEED = 'snapshot'

function invalidFilter(message) {
  const error = new TypeError(message)
  error.code = 'ERR_INVALID_RECORD'
  throw error
}

/**
 * Validate a snapshot filter. Allowed keys: direction (inbound|outbound),
 * messageBox (1..128 non-blank, no control chars), participant (compressed
 * lowercase identity key). Unknown keys reject. Participant matches when it
 * equals either sender or recipient (conversation view across directions).
 */
export function validateSnapshotFilter(filter = {}) {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    invalidFilter('filter must be an object')
  }
  const allowed = new Set(['direction', 'messageBox', 'participant'])
  for (const key of Object.keys(filter)) {
    if (!allowed.has(key)) invalidFilter(`unknown filter key: ${key}`)
  }
  if (filter.direction !== undefined) {
    try {
      validateDirection(filter.direction)
    } catch {
      invalidFilter('filter.direction must be inbound or outbound')
    }
  }
  if (filter.messageBox !== undefined) {
    try {
      validateMessageBox(filter.messageBox)
    } catch {
      invalidFilter('filter.messageBox must be 1..128 non-blank chars')
    }
  }
  if (filter.participant !== undefined) {
    if (!isIdentityKey(filter.participant)) {
      invalidFilter('filter.participant must be a compressed lowercase identity key')
    }
  }
  return filter
}

/**
 * Canonical filter identity: '' for unfiltered, else SHA-256 hex of the
 * canonical filter JSON ({ direction?, messageBox?, participant? } with
 * sorted keys in direction/messageBox/participant order, which is
 * alphabetical). Validates before hashing so malformed filters never get an
 * identity.
 */
export function snapshotFilterHash(filter = {}) {
  validateSnapshotFilter(filter)
  const canonical = {}
  if (filter.direction !== undefined) canonical.direction = filter.direction
  if (filter.messageBox !== undefined) canonical.messageBox = filter.messageBox
  if (filter.participant !== undefined) canonical.participant = filter.participant
  const keys = Object.keys(canonical)
  if (keys.length === 0) return ''
  return sha256Hex(JSON.stringify(canonical))
}

export function matchesSnapshotFilter(record, filter = {}) {
  if (filter.direction !== undefined && record.direction !== filter.direction) return false
  if (filter.messageBox !== undefined && record.messageBox !== filter.messageBox) return false
  if (filter.participant !== undefined && record.sender !== filter.participant && record.recipient !== filter.participant) return false
  return true
}

/**
 * Binding check for snapshot reads (mbs-8g5.2.3.3.1). The snapshotId alone is
 * never bearer authority: callers must present the owner, and any expected
 * epoch/feed/filter/watermark they assert must match the stored snapshot
 * before metadata or membership is returned.
 *
 * - owner is required; mismatch throws ERR_FORBIDDEN without metadata.
 * - expectedEpoch mismatch throws ERR_EPOCH_CHANGED.
 * - expectedFeed mismatch (anything other than 'snapshot') throws ERR_INVALID_CURSOR.
 * - expectedFilter hash mismatch throws ERR_INVALID_CURSOR.
 * - expectedWatermark mismatch throws ERR_INVALID_CURSOR.
 */
export function assertSnapshotBinding({ stored, owner, expectedEpoch, expectedFeed, expectedFilter, expectedWatermark }) {
  if (typeof owner !== 'string' || owner.length === 0) {
    const error = new TypeError('owner is required for snapshot reads')
    error.code = 'ERR_INVALID_RECORD'
    throw error
  }
  if (!stored || stored.owner !== owner) {
    const error = new Error('snapshot owner mismatch')
    error.code = 'ERR_FORBIDDEN'
    throw error
  }
  if (expectedEpoch !== undefined && stored.epoch !== expectedEpoch) {
    const error = new RangeError('snapshot epoch mismatch; reconcile against the current snapshot')
    error.code = 'ERR_EPOCH_CHANGED'
    throw error
  }
  if (expectedFeed !== undefined && expectedFeed !== SNAPSHOT_FEED) {
    const error = new TypeError('snapshot feed mismatch')
    error.code = 'ERR_INVALID_CURSOR'
    throw error
  }
  if (expectedFilter !== undefined) {
    const expectedHash = snapshotFilterHash(expectedFilter)
    if (stored.filterHash !== expectedHash) {
      const error = new TypeError('snapshot filter mismatch')
      error.code = 'ERR_INVALID_CURSOR'
      throw error
    }
  }
  if (expectedWatermark !== undefined && stored.watermark !== String(expectedWatermark)) {
    const error = new TypeError('snapshot watermark mismatch')
    error.code = 'ERR_INVALID_CURSOR'
    throw error
  }
}

/** Total-work bounds for purge invocations. Returns clamped { batch, maxItems, maxSnapshots }. */
export function boundPurgeParams({ batchSize = SNAPSHOT_PURGE_BATCH, maxItems = SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL, maxSnapshots = SNAPSHOT_PURGE_MAX_SNAPSHOTS_PER_CALL } = {}) {
  const batch = Math.max(1, Math.min(Number(batchSize) || SNAPSHOT_PURGE_BATCH, 5000))
  const items = Math.max(1, Math.min(Number(maxItems) || SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL, 5000))
  const snaps = Math.max(1, Math.min(Number(maxSnapshots) || SNAPSHOT_PURGE_MAX_SNAPSHOTS_PER_CALL, 5000))
  return { batch, maxItems: items, maxSnapshots: snaps }
}

export function generateSnapshotId() {
  return `snap_${randomBytes(16).toString('hex')}`
}

export function snapshotExpiryIso(nowMs = Date.now()) {
  return new Date(nowMs + SNAPSHOT_TTL_SECONDS * 1000).toISOString()
}
