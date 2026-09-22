/**
 * Browser-safe client surface. Transport helpers share the implementation
 * exercised by the M0 proof paths; no server/database graph is imported.
 */
import type { WalletInterface } from '@bsv/sdk'
import { ERROR_CODES, PROTOCOL_VERSION } from './protocol.js'
import type {
  ArchiveBatchRequest,
  ArchiveBatchResponse,
  BatchOutcome,
  BrowseAfter,
  BrowseResponse,
  Capabilities,
  DeleteAllResponse,
  DeleteRecordResponse,
  HistoryPage,
  HistoryRecord,
  SnapshotCreateResponse,
  SnapshotFilter,
  StatePatchResponse,
  StoreErrorCode,
  Usage,
} from './protocol.js'
// The guarded transport is the frozen M0 implementation promoted by M3.4.4.
// @ts-expect-error The runtime is authored as browser-safe ESM and bundled here.
import { createFreeOnlyAuthFetch } from './free-only-transport.mjs'

export type { WalletInterface } from '@bsv/sdk'
export { syncPending } from './inbound.js'
export type {
  InboundAcknowledgementStatus,
  InboundArchiveStatus,
  InboundHistoryClient,
  InboundRecordOutcome,
  SyncPendingOptions,
  SyncPendingResult,
} from './inbound.js'
export { sendOutboundOnce } from './outbound.js'
export type {
  OutboundHistoryClient,
  SendOutboundOnceOptions,
  SendOutboundOnceResult,
} from './outbound.js'
export type {
  ArchiveBatchRequest,
  ArchiveBatchResponse,
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
  Usage,
} from './protocol.js'
export {
  bodyHash,
  canonicalRecordKey,
  decryptArchivedBody,
  extractEncryptedMessage,
  MESSAGEBOX_KEY_ID,
  MESSAGEBOX_PROTOCOL,
  plaintextText,
  prepareEncryptedBody,
} from './envelope-runtime.js'
export type {
  MessageBoxDecryptWallet,
  MessageBoxEncryptWallet,
  PreparedEncryptedBody,
} from './envelope-runtime.js'
export {
  createFreeOnlyMessageBoxClient,
  createMessageBoxHttpSendCapability,
  OUTBOUND_SEND_STATES,
  PaidTransportUnsupportedError,
  PAID_TRANSPORT_UNSUPPORTED_CODE,
  sendPreparedHttpOnce,
} from './outbound-runtime.js'
export { normalizeReplicaFilter, ReplicaSyncError, syncHistory } from './replica.js'
export type { HistoryReplicaClient, SyncHistoryOptions, SyncHistoryResult } from './replica.js'
export { MessageBoxArchiveWorker } from './worker.js'
export type { ArchiveWorkerOptions, SyncOnceOptions } from './worker.js'
export type {
  FreeOnlyMessageBoxClient,
  MessageBoxHttpSendCapability,
  OutboundAttempt,
  OutboundAttemptStore,
  OutboundSendState,
  PreparedHttpSendResult,
} from './outbound-runtime.js'

export interface MessageBoxStoreClientOptions {
  /** Existing BRC-100 wallet; the store never takes keys. */
  walletClient: WalletInterface
  /** Explicit HTTPS store origin, e.g. `https://history.example.com`. */
  host: string
  /** Exact loopback-only HTTP escape hatch for local tests. */
  allowLoopbackHttpForTests?: boolean
}

export interface HistoryListOptions {
  messageBox?: string
  direction?: 'inbound' | 'outbound'
  participant?: string
  limit?: number
  after?: BrowseAfter | null
}

export interface HistoryChangesOptions {
  messageBox?: string
  direction?: 'inbound' | 'outbound'
  participant?: string
  limit?: number
  cursor?: string | null
  afterSequence?: string
  epoch?: string
}

export interface SnapshotPageOptions {
  snapshotId: string
  limit?: number
  cursor?: string | null
}

export interface PatchStateOptions {
  recordKey: string
  newState: HistoryRecord['deliveryState']
  expectedRevision: string
  idempotencyKey: string
}

export interface DeleteRecordOptions {
  recordKey: string
  idempotencyKey?: string
}

export interface DeleteAllOptions {
  idempotencyKey?: string
  expectedEpoch?: string
}

const REQUIRED_FEATURES = Object.freeze([
  'archiveBatch',
  'browse',
  'changes',
  'snapshotCreate',
  'snapshotPage',
  'patchState',
  'deleteRecord',
  'deleteAll',
  'usage',
  'capabilities',
  'epoch',
  'idempotency',
])
const STORE_ERROR_CODES = new Set<string>(ERROR_CODES)
const HEX_64 = /^[0-9a-f]{64}$/
const UINT64 = /^(0|[1-9][0-9]*)$/
const EPOCH = /^[A-Za-z0-9:_-]{1,128}$/
const OUTCOMES = new Set(['stored', 'alreadyPresent', 'conflict', 'invalid', 'quotaExceeded', 'deleted', 'epochChanged', 'failed'])

export class MessageBoxStoreClientError extends Error {
  readonly code: StoreErrorCode
  readonly statusCode?: number
  readonly retryAfterSeconds?: number

  constructor(code: StoreErrorCode, message: string, options: { statusCode?: number; retryAfterSeconds?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MessageBoxStoreClientError'
    this.code = code
    if (options.statusCode !== undefined) this.statusCode = options.statusCode
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds
  }
}

type GuardedAuthFetch = {
  host: string
  fetch(url: string, config?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function malformed(): never {
  throw new MessageBoxStoreClientError('ERR_INTERNAL', 'History service returned a malformed response')
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') malformed()
  return value
}

function requireUint64(value: unknown): string {
  const text = requireString(value)
  if (!UINT64.test(text)) malformed()
  return text
}

function requireEpoch(value: unknown): string {
  const text = requireString(value)
  if (!EPOCH.test(text)) malformed()
  return text
}

function requireRecordKey(value: unknown): string {
  const text = requireString(value)
  if (!HEX_64.test(text)) malformed()
  return text
}

function requireFiniteCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) malformed()
  return value as number
}

function validateHistoryRecord(value: unknown): HistoryRecord {
  if (!isObject(value)) malformed()
  requireRecordKey(value.recordKey)
  for (const key of ['messageId', 'messageBox', 'sender', 'recipient', 'body', 'bodyHash', 'createdAt', 'archivedAt']) requireString(value[key])
  if (value.direction !== 'inbound' && value.direction !== 'outbound') malformed()
  if (!['prepared', 'received', 'unknown', 'accepted', 'failed'].includes(String(value.deliveryState))) malformed()
  requireFiniteCount(value.bodyBytes)
  requireUint64(value.revision)
  requireUint64(value.changeSequence)
  return value as unknown as HistoryRecord
}

function validateDeleteEvent(value: unknown): void {
  if (!isObject(value)) malformed()
  requireRecordKey(value.recordKey)
  requireUint64(value.sequence)
  requireString(value.deletedAt)
}

function validateBrowse(value: unknown): BrowseResponse {
  if (!isObject(value) || !Array.isArray(value.records)) malformed()
  for (const record of value.records) validateHistoryRecord(record)
  if (value.nextAfter !== null) {
    if (!isObject(value.nextAfter)) malformed()
    requireString(value.nextAfter.createdAt)
    requireRecordKey(value.nextAfter.recordKey)
  }
  return value as unknown as BrowseResponse
}

function validateHistoryPage(value: unknown): HistoryPage {
  if (!isObject(value) || !Array.isArray(value.records) || typeof value.hasMore !== 'boolean') malformed()
  for (const record of value.records) {
    if (isObject(record) && 'body' in record) validateHistoryRecord(record)
    else validateDeleteEvent(record)
  }
  if (value.nextCursor !== null) requireString(value.nextCursor)
  requireString(value.checkpoint)
  requireUint64(value.watermark)
  requireEpoch(value.epoch)
  requireString(value.serverTime)
  return value as unknown as HistoryPage
}

function validateOutcome(value: unknown, expectedCount: number, indexes: Set<number>): BatchOutcome {
  if (!isObject(value) || !Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) >= expectedCount) malformed()
  const index = value.index as number
  if (indexes.has(index) || !OUTCOMES.has(String(value.outcome))) malformed()
  indexes.add(index)
  if (value.recordKey !== null && value.recordKey !== undefined) requireRecordKey(value.recordKey)
  if (value.errorCode !== undefined && !STORE_ERROR_CODES.has(String(value.errorCode))) malformed()
  if (value.bodyHash !== undefined && !HEX_64.test(requireString(value.bodyHash))) malformed()
  if (value.bodyBytes !== undefined) requireFiniteCount(value.bodyBytes)
  if (value.sequence !== undefined) requireUint64(value.sequence)
  if (value.outcome === 'stored' || value.outcome === 'alreadyPresent') {
    requireRecordKey(value.recordKey)
    if (!HEX_64.test(requireString(value.bodyHash))) malformed()
  }
  if (value.outcome === 'stored') {
    requireFiniteCount(value.bodyBytes)
    requireUint64(value.sequence)
  }
  return value as unknown as BatchOutcome
}

function validateArchive(value: unknown, expectedCount: number): ArchiveBatchResponse {
  if (!isObject(value) || typeof value.committed !== 'boolean' || !Array.isArray(value.outcomes) || value.outcomes.length !== expectedCount) malformed()
  requireEpoch(value.epoch)
  const indexes = new Set<number>()
  for (const outcome of value.outcomes) validateOutcome(outcome, expectedCount, indexes)
  return value as unknown as ArchiveBatchResponse
}

function appendFilter(query: URLSearchParams, options: HistoryListOptions | HistoryChangesOptions): void {
  if (options.direction !== undefined) query.set('direction', options.direction)
  if (options.messageBox !== undefined) query.set('messageBox', options.messageBox)
  if (options.participant !== undefined) query.set('participant', options.participant)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
}

function fixedErrorMessage(code: StoreErrorCode): string {
  switch (code) {
    case 'ERR_AUTHENTICATION_REQUIRED': return 'History authentication failed'
    case 'ERR_FORBIDDEN': return 'History request is forbidden'
    case 'ERR_REQUEST_TOO_LARGE': return 'History request exceeds a configured limit'
    case 'ERR_QUOTA_EXCEEDED': return 'History storage quota is exceeded'
    case 'ERR_CURSOR_EXPIRED': return 'History cursor expired'
    case 'ERR_RATE_LIMITED': return 'History request was rate limited'
    case 'ERR_UNAVAILABLE': return 'History service is unavailable'
    case 'ERR_PAID_TRANSPORT_UNSUPPORTED': return 'Paid history transport is unsupported'
    default: return 'History request failed'
  }
}

export function assertCompatibleCapabilities(capabilities: Capabilities, requiredFeatures: readonly string[] = REQUIRED_FEATURES): Capabilities {
  if (capabilities.protocolVersion !== PROTOCOL_VERSION) {
    throw new MessageBoxStoreClientError('ERR_UNAVAILABLE', 'History protocol version is incompatible')
  }
  const supported = new Set(capabilities.supportedFeatures)
  if (requiredFeatures.some((feature) => !supported.has(feature))) {
    throw new MessageBoxStoreClientError('ERR_UNAVAILABLE', 'History service is missing a required capability')
  }
  return capabilities
}

export class MessageBoxStoreClient {
  readonly host: string
  readonly #authFetch: GuardedAuthFetch

  constructor(options: MessageBoxStoreClientOptions) {
    this.#authFetch = createFreeOnlyAuthFetch(options) as GuardedAuthFetch
    this.host = this.#authFetch.host
  }

  async #request<T>(method: string, path: string, options: { query?: URLSearchParams; body?: unknown; validate(value: unknown): T }): Promise<T> {
    const url = new URL(path, `${this.host}/`)
    if (options.query !== undefined) url.search = options.query.toString()
    const config: { method: string; headers?: Record<string, string>; body?: string } = { method }
    if (options.body !== undefined) {
      config.headers = { 'content-type': 'application/json' }
      config.body = JSON.stringify(options.body)
    }
    let response: Response
    try {
      response = await this.#authFetch.fetch(url.toString(), config)
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (code === 'ERR_PAID_TRANSPORT_UNSUPPORTED') throw error
      throw new MessageBoxStoreClientError('ERR_UNAVAILABLE', 'History service is unavailable', { cause: error })
    }
    let value: unknown
    try {
      value = await response.json()
    } catch (error) {
      throw new MessageBoxStoreClientError('ERR_INTERNAL', 'History service returned a malformed response', { statusCode: response.status, cause: error })
    }
    if (!response.ok) {
      const candidate = isObject(value) && typeof value.code === 'string' && STORE_ERROR_CODES.has(value.code)
        ? value.code as StoreErrorCode
        : response.status === 402 ? 'ERR_PAID_TRANSPORT_UNSUPPORTED' : 'ERR_INTERNAL'
      const retryAfterSeconds = isObject(value) && Number.isSafeInteger(value.retryAfterSeconds) && (value.retryAfterSeconds as number) >= 0
        ? value.retryAfterSeconds as number
        : undefined
      throw new MessageBoxStoreClientError(candidate, fixedErrorMessage(candidate), {
        statusCode: response.status,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      })
    }
    return options.validate(value)
  }

  capabilities(requiredFeatures: readonly string[] = REQUIRED_FEATURES): Promise<Capabilities> {
    return this.#request('GET', '/v1/history/capabilities', {
      validate(value) {
        if (!isObject(value) || !Array.isArray(value.supportedFeatures)) malformed()
        requireString(value.protocolVersion)
        requireEpoch(value.epoch)
        if (!value.supportedFeatures.every((feature) => typeof feature === 'string')) malformed()
        return assertCompatibleCapabilities(value as unknown as Capabilities, requiredFeatures)
      },
    })
  }

  archiveBatch(request: ArchiveBatchRequest): Promise<ArchiveBatchResponse> {
    return this.#request('POST', '/v1/history/records', { body: request, validate: (value) => validateArchive(value, request.records.length) })
  }

  list(options: HistoryListOptions = {}): Promise<BrowseResponse> {
    const query = new URLSearchParams()
    appendFilter(query, options)
    if (options.after !== undefined && options.after !== null) {
      query.set('afterCreatedAt', options.after.createdAt)
      query.set('afterRecordKey', options.after.recordKey)
    }
    return this.#request('GET', '/v1/history/records', { query, validate: validateBrowse })
  }

  createSnapshot(filter: SnapshotFilter = {}): Promise<SnapshotCreateResponse> {
    return this.#request('POST', '/v1/history/snapshot', {
      body: { filter },
      validate(value) {
        if (!isObject(value) || value.feed !== 'snapshot' || (value.status !== 'active' && value.status !== 'invalidated')) malformed()
        for (const key of ['snapshotId', 'filterHash']) requireString(value[key])
        requireEpoch(value.epoch)
        requireUint64(value.watermark)
        requireFiniteCount(value.memberCount)
        return value as unknown as SnapshotCreateResponse
      },
    })
  }

  listSnapshotPage(options: SnapshotPageOptions): Promise<HistoryPage> {
    const query = new URLSearchParams({ snapshotId: options.snapshotId })
    if (options.cursor !== undefined && options.cursor !== null) query.set('cursor', options.cursor)
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    return this.#request('GET', '/v1/history/snapshot', { query, validate: validateHistoryPage })
  }

  listChanges(options: HistoryChangesOptions = {}): Promise<HistoryPage> {
    const checkpointMode = options.afterSequence !== undefined || options.epoch !== undefined
    if ((options.afterSequence === undefined) !== (options.epoch === undefined)) {
      throw new MessageBoxStoreClientError('ERR_INVALID_RECORD', 'afterSequence and epoch must be supplied together')
    }
    if (checkpointMode && options.cursor !== undefined && options.cursor !== null) {
      throw new MessageBoxStoreClientError('ERR_INVALID_RECORD', 'cursor and checkpoint mode are mutually exclusive')
    }
    const query = new URLSearchParams()
    appendFilter(query, options)
    if (options.cursor !== undefined && options.cursor !== null) query.set('cursor', options.cursor)
    if (options.afterSequence !== undefined) query.set('afterSequence', options.afterSequence)
    if (options.epoch !== undefined) query.set('epoch', options.epoch)
    return this.#request('GET', '/v1/history/changes', { query, validate: validateHistoryPage })
  }

  patchState(options: PatchStateOptions): Promise<StatePatchResponse> {
    const { recordKey, ...body } = options
    return this.#request('PATCH', `/v1/history/records/${encodeURIComponent(recordKey)}/state`, {
      body,
      validate(value) {
        if (!isObject(value)) malformed()
        requireRecordKey(value.recordKey)
        requireUint64(value.revision)
        requireUint64(value.sequence)
        return value as unknown as StatePatchResponse
      },
    })
  }

  deleteRecord(options: DeleteRecordOptions): Promise<DeleteRecordResponse> {
    return this.#request('DELETE', `/v1/history/records/${encodeURIComponent(options.recordKey)}`, {
      ...(options.idempotencyKey === undefined ? {} : { body: { idempotencyKey: options.idempotencyKey } }),
      validate(value) {
        if (!isObject(value) || typeof value.deleted !== 'boolean') malformed()
        requireEpoch(value.epoch)
        if (value.sequence !== undefined) requireUint64(value.sequence)
        return value as unknown as DeleteRecordResponse
      },
    })
  }

  deleteAll(options: DeleteAllOptions = {}): Promise<DeleteAllResponse> {
    return this.#request('DELETE', '/v1/history/records', {
      body: options,
      validate(value) {
        if (!isObject(value)) malformed()
        requireEpoch(value.epoch)
        return value as unknown as DeleteAllResponse
      },
    })
  }

  usage(): Promise<Usage> {
    return this.#request('GET', '/v1/history/usage', {
      validate(value) {
        if (!isObject(value)) malformed()
        requireFiniteCount(value.recordCount)
        requireFiniteCount(value.byteCount)
        requireUint64(value.nextSequence)
        requireEpoch(value.epoch)
        return value as unknown as Usage
      },
    })
  }
}
