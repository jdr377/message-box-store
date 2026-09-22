/**
 * Public root exports (mbs-8g5.2.2.1). Browser-safe: platform-neutral
 * protocol/canonical helpers plus client types. No `node:` built-ins, no
 * `Buffer`, no server/database graph.
 *
 * M0 `.mjs` proof fixtures remain frozen and are not re-exported here; M1+
 * consumers use this typed boundary. ESM, CommonJS and declarations are
 * generated from this single source via tsdown.
 */
export {
  CURSOR_DOMAIN,
  LIMITS,
  PROTOCOL_VERSION,
  RECORD_DOMAIN,
  bodyHash,
  canonicalRecordKey,
  isBodyHash,
  isCanonicalBase64,
  isIdentityKey,
  isRecordKey,
  isUint64DecimalString,
  sha256Bytes,
  sha256Hex,
  utf8ByteLength,
  validateDirection,
  validateMessageBox,
  validateMessageId,
} from './src/canonical.js'
export type { DeliveryState, Direction, Feed } from './src/canonical.js'
export { ERROR_CODES, ROUTES } from './src/protocol.js'
export type {
  ArchiveBatchRequest,
  ArchiveBatchResponse,
  ArchiveRecordInput,
  BatchOutcome,
  Capabilities,
  DeleteEvent,
  HistoryPage,
  HistoryRecord,
  SnapshotCreateResponse,
  SnapshotFilter,
  StoreError,
  StoreErrorCode,
} from './src/protocol.js'
export type { ArchiveWorkerOptions, HistoryListOptions, MessageBoxStoreClientOptions, SyncOnceOptions } from './src/client.js'
