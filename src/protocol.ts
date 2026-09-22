/**
 * Typed M1+ protocol surface (mbs-8g5.2.2.1). Browser-safe: re-exports the
 * platform-neutral canonical module plus wire types. No `node:` built-ins,
 * no `Buffer`, no server/database imports.
 */
export {
  CURSOR_DOMAIN,
  LIMITS,
  PROTOCOL_VERSION,
  RECORD_DOMAIN,
  bodyHash,
  canonicalRecordKey,
  hasInvalidUnicode,
  isBodyHash,
  isCanonicalBase64,
  isIdentityKey,
  isRecordKey,
  isUint64DecimalString,
  utf8ByteLength,
  utf8Bytes,
  validateDirection,
  validateMessageBox,
  validateMessageId,
  sha256Bytes,
  sha256Hex,
} from './canonical.js'
export type { DeliveryState, Direction, Feed } from './canonical.js'

export const ROUTES = {
  archiveBatch: 'POST /v1/history/records',
  snapshot: 'GET /v1/history/snapshot',
  changes: 'GET /v1/history/changes',
  patchState: 'PATCH /v1/history/records/{recordKey}/state',
  deleteRecord: 'DELETE /v1/history/records/{recordKey}',
  deleteAll: 'DELETE /v1/history/records',
  capabilities: 'GET /v1/history/capabilities',
  liveness: 'GET /healthz',
  readiness: 'GET /ready',
} as const

export const ERROR_CODES = [
  'ERR_AUTHENTICATION_REQUIRED',
  'ERR_FORBIDDEN',
  'ERR_INVALID_RECORD',
  'ERR_REQUEST_TOO_LARGE',
  'ERR_QUOTA_EXCEEDED',
  'ERR_IMMUTABLE_CONFLICT',
  'ERR_CURSOR_EXPIRED',
  'ERR_INVALID_CURSOR',
  'ERR_REVISION_CONFLICT',
  'ERR_EPOCH_CHANGED',
  'ERR_RATE_LIMITED',
  'ERR_UNAVAILABLE',
  'ERR_INTERNAL',
  'ERR_PAID_TRANSPORT_UNSUPPORTED',
  'ERR_IDEMPOTENCY_CONFLICT',
  'ERR_EPOCH_EXHAUSTED',
] as const
export type StoreErrorCode = (typeof ERROR_CODES)[number]

export interface ArchiveRecordInput {
  recordKey?: string
  messageId: string
  messageBox: string
  direction: 'inbound' | 'outbound'
  sender: string
  recipient: string
  body: string
  bodyHash?: string
  deliveryState?: 'prepared' | 'received'
}

export interface ArchiveBatchRequest {
  epoch: string
  records: ArchiveRecordInput[]
}

export interface BatchOutcome {
  index: number
  recordKey: string | null
  outcome: 'stored' | 'alreadyPresent' | 'conflict' | 'invalid' | 'quotaExceeded' | 'deleted' | 'epochChanged' | 'failed'
  errorCode?: StoreErrorCode
  bodyHash?: string
  bodyBytes?: number
  sequence?: string
}

export interface ArchiveBatchResponse {
  epoch: string
  committed: boolean
  outcomes: BatchOutcome[]
}

export interface HistoryRecord {
  owner?: string
  recordKey: string
  messageId: string
  messageBox: string
  direction: 'inbound' | 'outbound'
  sender: string
  recipient: string
  body: string
  bodyHash: string
  bodyBytes: number
  deliveryState: 'prepared' | 'received' | 'unknown' | 'accepted' | 'failed'
  revision: string
  changeSequence: string
  createdAt: string
  archivedAt: string
  expiresAt?: string | null
}

export interface DeleteEvent {
  recordKey: string
  sequence: string
  deletedAt: string
}

export interface HistoryPage {
  records: Array<HistoryRecord | DeleteEvent>
  nextCursor: string | null
  checkpoint: string
  hasMore: boolean
  watermark: string
  epoch: string
  serverTime: string
}

export interface SnapshotFilter {
  direction?: 'inbound' | 'outbound'
  messageBox?: string
  participant?: string
}

export interface SnapshotCreateResponse {
  snapshotId: string
  epoch: string
  feed: 'snapshot'
  filterHash: string
  watermark: string
  memberCount: number
  status: 'active' | 'invalidated'
}

export interface SnapshotMeta {
  snapshotId: string
  owner?: string
  epoch: string
  feed: 'snapshot'
  filterHash: string
  filter?: SnapshotFilter
  watermark: string
  status: 'active' | 'invalidated'
  createdAt: string
  expiresAt: string
}

export interface StoreError {
  status: 'error'
  code: StoreErrorCode
  description: string
  retryAfterSeconds?: number
}
