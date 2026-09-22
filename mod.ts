/**
 * Browser-safe public root: canonical helpers and guarded transport runtime.
 * Server/database modules and generic authenticated fetch remain separate.
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
export {
  decryptArchivedBody,
  extractEncryptedMessage,
  MESSAGEBOX_KEY_ID,
  MESSAGEBOX_PROTOCOL,
  plaintextText,
  prepareEncryptedBody,
} from './src/envelope-runtime.js'
export type {
  MessageBoxDecryptWallet,
  MessageBoxEncryptWallet,
  PreparedEncryptedBody,
} from './src/envelope-runtime.js'
export {
  createFreeOnlyMessageBoxClient,
  createMessageBoxHttpSendCapability,
  OUTBOUND_SEND_STATES,
  PaidTransportUnsupportedError,
  PAID_TRANSPORT_UNSUPPORTED_CODE,
  sendPreparedHttpOnce,
} from './src/outbound-runtime.js'
export { assertCompatibleCapabilities, MessageBoxStoreClient, MessageBoxStoreClientError } from './src/client.js'
export { syncPending } from './src/inbound.js'
export { sendOutboundOnce } from './src/outbound.js'
export type {
  OutboundHistoryClient,
  SendOutboundOnceOptions,
  SendOutboundOnceResult,
} from './src/outbound.js'
export type {
  InboundAcknowledgementStatus,
  InboundArchiveStatus,
  InboundHistoryClient,
  InboundRecordOutcome,
  SyncPendingOptions,
  SyncPendingResult,
} from './src/inbound.js'
export type {
  FreeOnlyMessageBoxClient,
  MessageBoxHttpSendCapability,
  OutboundAttempt,
  OutboundAttemptStore,
  OutboundSendState,
  PreparedHttpSendResult,
} from './src/outbound-runtime.js'
export { ERROR_CODES, ROUTES } from './src/protocol.js'
export type {
  ArchiveBatchRequest,
  ArchiveBatchResponse,
  ArchiveRecordInput,
  BatchOutcome,
  BrowseAfter,
  BrowseResponse,
  Capabilities,
  DeleteAllResponse,
  DeleteEvent,
  DeleteRecordResponse,
  HistoryPage,
  HistoryRecord,
  SnapshotCreateResponse,
  SnapshotFilter,
  StatePatchResponse,
  StoreError,
  StoreErrorCode,
  Usage,
} from './src/protocol.js'
export type {
  ArchiveWorkerOptions,
  DeleteAllOptions,
  DeleteRecordOptions,
  HistoryChangesOptions,
  HistoryListOptions,
  MessageBoxStoreClientOptions,
  PatchStateOptions,
  SnapshotPageOptions,
  SyncOnceOptions,
  WalletInterface,
} from './src/client.js'
