/**
 * M1 feed pagination helpers (mbs-8g5.2.4). Pure policy for browse versus
 * authoritative change/snapshot feeds. Storage lives in the repository
 * adapters; this module holds only shared validation, cursor binding, page
 * fitting and retention-expiry rules. No I/O.
 *
 * - Browse: live keyset over (createdAt, recordKey), non-authoritative.
 *   Never a convergence primitive; for UI/debugging only.
 * - Changes: fixed-W sequence pages in (C,W] with HMAC cursors binding
 *   owner/epoch/feed/filter/W/position/expiry. Empty final checkpoint is W.
 *   Deduplicated by recordKey within the scanned range; deletes converge via
 *   body-free events; never serves a currently-deleted body (early delete).
 * - Snapshot HistoryPage: fixed-W materialized members with HMAC cursors
 *   (feed 'snapshot'). Invalidated snapshots never serve bodies; callers must
 *   take a new snapshot (ERR_CURSOR_EXPIRED).
 * - Retention: 30-day change window (LIMITS.CHANGE_RETENTION_DAYS). Purged
 *   gaps expire cursors (ERR_CURSOR_EXPIRED) to force snapshot resync.
 * - Byte fitting: JSON-overhead aware; a single allowed record that alone
 *   exceeds the page budget throws ERR_REQUEST_TOO_LARGE, never an empty
 *   continuation loop.
 */

import {
  checkPageFits,
  compareUint64Decimal,
  createCursor,
  estimateJsonBytes,
  LIMITS,
  validateChangeSequence,
  verifyCursor,
} from './protocol.mjs'
import { matchesSnapshotFilter, snapshotFilterHash, SNAPSHOT_STATUS, validateSnapshotFilter } from './snapshots.mjs'

export const FEED_CHANGES = 'changes'
export const FEED_SNAPSHOT = 'snapshot'
export const FEED_START = '0'
export const PAGE_OVERHEAD_BYTES = 512

function feedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function validateFeedOwner(owner) {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw feedError('ERR_INVALID_RECORD', 'owner is required for feed reads')
  }
  return owner
}

export function validateServerSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw feedError('ERR_INVALID_RECORD', 'serverSecret must be at least 16 chars')
  }
  return secret
}

export function boundFeedLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n)) return 100
  return Math.max(1, Math.min(Math.trunc(n) || 100, LIMITS.MAX_PAGE_RECORDS))
}

export function retentionCutoffIso(nowIso, days = LIMITS.CHANGE_RETENTION_DAYS) {
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) throw feedError('ERR_INVALID_RECORD', 'nowIso must be an ISO timestamp')
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString()
}

export function encodeSnapshotPosition({ createdAtAtW, recordKey }) {
  if (typeof createdAtAtW !== 'string' || Number.isNaN(Date.parse(createdAtAtW))) {
    throw feedError('ERR_INVALID_CURSOR', 'snapshot position timestamp malformed')
  }
  if (typeof recordKey !== 'string' || !/^[0-9a-f]{64}$/.test(recordKey)) {
    throw feedError('ERR_INVALID_CURSOR', 'snapshot position recordKey malformed')
  }
  const pos = `${createdAtAtW}|${recordKey}`
  if (pos.length > 128) throw feedError('ERR_INVALID_CURSOR', 'snapshot position too long')
  return pos
}

export function decodeSnapshotPosition(position) {
  if (position === FEED_START) return null
  if (typeof position !== 'string' || position.length === 0 || position.length > 128) {
    throw feedError('ERR_INVALID_CURSOR', 'snapshot position malformed')
  }
  const sep = position.lastIndexOf('|')
  if (sep <= 0) throw feedError('ERR_INVALID_CURSOR', 'snapshot position malformed')
  const createdAtAtW = position.slice(0, sep)
  const recordKey = position.slice(sep + 1)
  if (Number.isNaN(Date.parse(createdAtAtW)) || !/^[0-9a-f]{64}$/.test(recordKey)) {
    throw feedError('ERR_INVALID_CURSOR', 'snapshot position malformed')
  }
  return { createdAtAtW, recordKey }
}

export function validateChangesPosition(position) {
  try {
    validateChangeSequence(position, 'position')
  } catch {
    throw feedError('ERR_INVALID_CURSOR', 'changes position malformed')
  }
  return position
}

/**
 * Retention-gap expiry: purged sequences in the unapplied range force a
 * snapshot resync. earliest is the minimum retained sequence for the owner
 * (null when no changes retained). Expires iff position+1 < earliest, i.e.
 * the unapplied range (position,W] starts before retained history.
 */
export function assertNoRetentionGap({ position, earliest }) {
  if (earliest === null || earliest === undefined) return
  const next = (BigInt(position) + 1n).toString()
  if (compareUint64Decimal(next, String(earliest)) < 0) {
    throw feedError('ERR_CURSOR_EXPIRED', 'cursor outside retained history; take a full snapshot')
  }
}

/**
 * Internal retention-gap expiry (mbs-8g5.2.4.4): purged sequences inside the
 * unapplied range (C,W] must also force a snapshot resync, not silent
 * advancement. Fresh starts (C=0) never expire; they return available
 * retained history. Continuations and explicit persisted checkpoints require
 * the retained rows in (C,W] to be
 * contiguous from C+1. `sequences` are the retained change_sequences in range
 * order (pre-filter, as stored). `bounded` is the page limit: when the fetch
 * filled the page, the tail beyond the window is checked on the next
 * continuation; when the fetch exhausted retained rows, the last sequence
 * must be W or the tail was purged.
 */
export function assertNoInternalRetentionGap({ position, watermark, sequences, bounded, explicitCheckpoint = false }) {
  if (position === FEED_START && !explicitCheckpoint) return
  const w = BigInt(watermark)
  const c = BigInt(position)
  if (c === w) {
    if (sequences.length !== 0) {
      throw feedError('ERR_CURSOR_EXPIRED', 'cursor outside retained history; take a full snapshot')
    }
    return
  }
  if (sequences.length === 0) {
    throw feedError('ERR_CURSOR_EXPIRED', 'cursor outside retained history; take a full snapshot')
  }
  let expected = c + 1n
  for (const seqRaw of sequences) {
    const seq = BigInt(String(seqRaw))
    if (seq !== expected) {
      throw feedError('ERR_CURSOR_EXPIRED', 'cursor outside retained history; take a full snapshot')
    }
    expected += 1n
  }
  // Exhausted retained rows but did not reach W: tail purged.
  if (sequences.length < bounded) {
    const last = BigInt(String(sequences[sequences.length - 1]))
    if (last !== w) {
      throw feedError('ERR_CURSOR_EXPIRED', 'cursor outside retained history; take a full snapshot')
    }
  }
}

export function newChangesCursor({ serverSecret, owner, epoch, filterDigest, watermark, position, ttlSeconds, nowSeconds }) {
  return createCursor({
    serverSecret,
    ownerIdentityKey: owner,
    epoch,
    feed: FEED_CHANGES,
    filterDigest,
    watermark,
    position,
    ttlSeconds: ttlSeconds ?? LIMITS.CURSOR_TTL_SECONDS,
    nowSeconds: nowSeconds ?? Math.floor(Date.now() / 1000),
  })
}

export function verifyChangesCursor(token, { serverSecret, owner, expectedEpoch, expectedFilterDigest, nowSeconds }) {
  try {
    return verifyCursor(token, {
      serverSecret,
      ownerIdentityKey: owner,
      expectedEpoch,
      expectedFeed: FEED_CHANGES,
      expectedFilterDigest: expectedFilterDigest ?? '',
      nowSeconds: nowSeconds ?? Math.floor(Date.now() / 1000),
    })
  } catch (error) {
    // Preserve typed codes from protocol (INVALID vs EXPIRED vs EPOCH_CHANGED).
    if (error?.code) throw error
    throw feedError('ERR_INVALID_CURSOR', 'cursor is not valid for this owner')
  }
}

export function newSnapshotCursor({ serverSecret, owner, epoch, filterDigest, watermark, position, ttlSeconds, nowSeconds }) {
  return createCursor({
    serverSecret,
    ownerIdentityKey: owner,
    epoch,
    feed: FEED_SNAPSHOT,
    filterDigest,
    watermark,
    position,
    ttlSeconds: ttlSeconds ?? LIMITS.CURSOR_TTL_SECONDS,
    nowSeconds: nowSeconds ?? Math.floor(Date.now() / 1000),
  })
}

export function verifySnapshotCursor(token, { serverSecret, owner, expectedEpoch, expectedFilterDigest, nowSeconds }) {
  try {
    return verifyCursor(token, {
      serverSecret,
      ownerIdentityKey: owner,
      expectedEpoch,
      expectedFeed: FEED_SNAPSHOT,
      expectedFilterDigest: expectedFilterDigest ?? '',
      nowSeconds: nowSeconds ?? Math.floor(Date.now() / 1000),
    })
  } catch (error) {
    if (error?.code) throw error
    throw feedError('ERR_INVALID_CURSOR', 'cursor is not valid for this owner')
  }
}

/**
 * Incremental byte fitting: records are admitted in order until the page
 * budget (count or JSON bytes including overhead) would be exceeded. A
 * single record that alone exceeds the budget throws ERR_REQUEST_TOO_LARGE
 * instead of returning an empty continuation loop.
 */
export function fitRecordsToPage({ records, limit, overheadBytes = PAGE_OVERHEAD_BYTES, maxBytes = LIMITS.MAX_PAGE_BYTES, maxRecords = LIMITS.MAX_PAGE_RECORDS }) {
  const boundedCount = Math.max(1, Math.min(Number(limit) || 100, maxRecords))
  const admitted = []
  // JSON-array aware accounting (mbs-8g5.2.4.7): the wire records array
  // serializes as sum(recordBytes) + (n-1) commas + 2 brackets. Start from
  // overhead + empty "[]" so a production-limit page cannot exceed
  // MAX_PAGE_BYTES while the estimate still fits.
  let total = overheadBytes + 2
  for (const record of records) {
    const bytes = estimateJsonBytes(record)
    if (bytes + overheadBytes + 2 > maxBytes) {
      throw feedError('ERR_REQUEST_TOO_LARGE', 'single record exceeds page budget')
    }
    if (admitted.length >= boundedCount || total + bytes + (admitted.length > 0 ? 1 : 0) > maxBytes) break
    total += bytes + (admitted.length > 0 ? 1 : 0)
    admitted.push(record)
  }
  // Defensive: also run the shared protocol check for the admitted page so
  // all adapters share one byte-accounting implementation.
  const check = checkPageFits({ records: admitted, overheadBytes, maxBytes, maxRecords })
  if (!check.ok) throw feedError(check.code ?? 'ERR_REQUEST_TOO_LARGE', check.reason ?? 'page budget exceeded')
  return { admitted, bytes: total }
}

/** Exact serialized HistoryPage bytes excluding the records array itself. */
export function historyPageOverheadBytes(page) {
  const marker = '__MESSAGE_BOX_RECORDS__'
  const json = JSON.stringify({ ...page, records: marker })
  return new TextEncoder().encode(json).byteLength - new TextEncoder().encode(JSON.stringify(marker)).byteLength
}

export function validateFeedFilter(filter = {}) {
  return validateSnapshotFilter(filter)
}

export function feedFilterDigest(filter = {}) {
  return snapshotFilterHash(filter)
}

export function matchesFeedFilter(record, filter = {}) {
  return matchesSnapshotFilter(record, filter)
}

export function assertSnapshotActiveForFeed(meta) {
  if (!meta) return null
  if (meta.status !== SNAPSHOT_STATUS.ACTIVE) {
    throw feedError('ERR_CURSOR_EXPIRED', 'snapshot invalidated; take a new snapshot')
  }
  return meta
}
