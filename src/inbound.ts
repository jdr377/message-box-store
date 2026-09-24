import { bodyHash, canonicalRecordKey } from './canonical.js'
import { extractEncryptedMessage } from './envelope-runtime.js'
import type { FreeOnlyMessageBoxClient } from './outbound-runtime.js'
import type { ArchiveBatchRequest, ArchiveBatchResponse, ArchiveRecordInput } from './protocol.js'

export interface InboundHistoryClient {
  capabilities(requiredFeatures?: readonly string[]): Promise<{ epoch: string }>
  archiveBatch(request: ArchiveBatchRequest): Promise<ArchiveBatchResponse>
}

export interface SyncPendingOptions {
  messageBoxClient: FreeOnlyMessageBoxClient
  historyClient: InboundHistoryClient
  messageBoxes: readonly string[]
  /** Optional subset of the facade's already-validated primary/receive hosts. */
  hosts?: readonly string[]
  acknowledgeAfterArchive?: boolean
  pageSize?: number
  maxPages?: number
  maxMessages?: number
  signal?: AbortSignal
}

export type InboundArchiveStatus = 'stored' | 'alreadyPresent' | 'rejected' | 'failed'
export type InboundAcknowledgementStatus = 'disabled' | 'acknowledged' | 'pending' | 'failed'

export interface InboundRecordOutcome {
  host: string
  messageBox: string
  messageId: string
  recordKey: string | null
  archive: InboundArchiveStatus
  acknowledgement: InboundAcknowledgementStatus
  errorCode?: string
  dedupedAcrossHosts?: boolean
}

export interface SyncPendingResult {
  ownerIdentityKey: string
  epoch: string
  pagesRead: number
  messagesRead: number
  archived: number
  acknowledged: number
  incomplete: boolean
  outcomes: InboundRecordOutcome[]
}

interface RawMessage {
  messageId: string
  sender: string
  body: string
}

interface RawPage {
  messages: RawMessage[]
  hasMore: boolean
  nextOffset: number
}

const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_PAGES = 10
const DEFAULT_MAX_MESSAGES = 1_000

function boundedInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return result
}

function requireNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('Inbound synchronization was cancelled', 'AbortError')
}

function validateBoxes(boxes: readonly string[]): string[] {
  if (!Array.isArray(boxes) || boxes.length === 0) throw new TypeError('messageBoxes must be a non-empty array')
  const unique = new Set<string>()
  for (const box of boxes) {
    if (typeof box !== 'string' || box.trim() === '') throw new TypeError('messageBoxes must contain non-empty strings')
    unique.add(box)
  }
  return [...unique]
}

function configuredHosts(client: FreeOnlyMessageBoxClient, requested?: readonly string[]): string[] {
  const available = [client.host, ...client.trustedHosts]
  if (requested === undefined) return available
  if (!Array.isArray(requested) || requested.length === 0) throw new TypeError('hosts must be a non-empty configured-host subset')
  const allowed = new Set(available)
  const selected = new Set<string>()
  for (const host of requested) {
    if (typeof host !== 'string' || !allowed.has(host)) throw new TypeError('hosts may contain only configured Message Box origins')
    selected.add(host)
  }
  return [...selected]
}

function validateRawPage(value: unknown): RawPage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Message Box returned a malformed page')
  const page = value as Record<string, unknown>
  if (!Array.isArray(page.messages) || typeof page.hasMore !== 'boolean' || !Number.isSafeInteger(page.offset) || (page.offset as number) < 0 || (page.nextOffset !== undefined && (!Number.isSafeInteger(page.nextOffset) || (page.nextOffset as number) < 0))) {
    throw new TypeError('Message Box returned a malformed page')
  }
  const nextOffset = page.nextOffset === undefined ? (page.offset as number) + page.messages.length : page.nextOffset as number
  if (nextOffset !== (page.offset as number) + page.messages.length || (page.hasMore && page.messages.length === 0)) {
    throw new TypeError('Message Box returned a malformed page')
  }
  const messages: RawMessage[] = page.messages.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Message Box returned a malformed record')
    const record = value as Record<string, unknown>
    if (typeof record.messageId !== 'string' || record.messageId.length === 0 || typeof record.sender !== 'string' || typeof record.body !== 'string') {
      throw new TypeError('Message Box returned a malformed record')
    }
    return { messageId: record.messageId, sender: record.sender, body: exactEncryptedBody(record.body) }
  })
  return { messages, hasMore: page.hasMore, nextOffset }
}

/** Validate either the canonical body or the exact payment-free transport wrapper without reserializing it. */
function exactEncryptedBody(body: string): string {
  extractEncryptedMessage(body, { allowPaymentFreeTransportWrapper: true })
  const parsed = JSON.parse(body) as Record<string, unknown>
  if (Object.keys(parsed).length === 1 && typeof parsed.message === 'string') return parsed.message
  return body
}

function safeCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && /^ERR_[A-Z0-9_]+$/.test(code) ? code : 'ERR_UNAVAILABLE'
}

function archiveStatus(response: ArchiveBatchResponse, recordKey: string): 'stored' | 'alreadyPresent' | undefined {
  if (response.committed !== true || response.outcomes.length !== 1) return undefined
  const outcome = response.outcomes[0]
  if (outcome.index !== 0 || outcome.recordKey !== recordKey) return undefined
  return outcome.outcome === 'stored' || outcome.outcome === 'alreadyPresent' ? outcome.outcome : undefined
}

/**
 * One bounded archive-before-ack pass. It has no scheduler, retry queue, local
 * database, socket path, or implicit mutation retry.
 */
export async function syncPending(options: SyncPendingOptions): Promise<SyncPendingResult> {
  const boxes = validateBoxes(options.messageBoxes)
  const hosts = configuredHosts(options.messageBoxClient, options.hosts)
  const pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 'pageSize')
  const maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, 'maxPages')
  const maxMessages = boundedInteger(options.maxMessages, DEFAULT_MAX_MESSAGES, 'maxMessages')
  const acknowledge = options.acknowledgeAfterArchive === true

  requireNotCancelled(options.signal)
  const ownerIdentityKey = await options.messageBoxClient.getIdentityKey()
  requireNotCancelled(options.signal)
  const { epoch } = await options.historyClient.capabilities(['archiveBatch', 'epoch'])
  const outcomes: InboundRecordOutcome[] = []
  const archiveCache = new Map<string, { fingerprint: string; status: 'stored' | 'alreadyPresent' }>()
  let pagesRead = 0
  let messagesRead = 0
  let archived = 0
  let acknowledged = 0
  let incomplete = false

  outer: for (const host of hosts) {
    for (const messageBox of boxes) {
      let offset = 0
      while (pagesRead < maxPages && messagesRead < maxMessages) {
        requireNotCancelled(options.signal)
        let page: RawPage
        try {
          page = validateRawPage(await options.messageBoxClient.listRawPage({ messageBox, offset, limit: Math.min(pageSize, maxMessages - messagesRead), host }))
        } catch (error) {
          outcomes.push({ host, messageBox, messageId: '', recordKey: null, archive: 'failed', acknowledgement: 'pending', errorCode: safeCode(error) })
          incomplete = true
          break
        }
        pagesRead += 1
        if (page.messages.length === 0) {
          if (page.hasMore) incomplete = true
          break
        }

        const acknowledgeable: Array<{ messageId: string; outcome: InboundRecordOutcome }> = []
        let pageHadFailure = false
        for (const raw of page.messages) {
          if (messagesRead >= maxMessages) {
            incomplete = true
            break outer
          }
          messagesRead += 1
          const record: ArchiveRecordInput = {
            messageId: raw.messageId,
            messageBox,
            direction: 'inbound',
            sender: raw.sender,
            recipient: ownerIdentityKey,
            body: raw.body,
            bodyHash: bodyHash(raw.body),
            deliveryState: 'received',
          }
          const recordKey = canonicalRecordKey({ ownerIdentityKey, ...record })
          const fingerprint = JSON.stringify(record)
          const result: InboundRecordOutcome = {
            host,
            messageBox,
            messageId: raw.messageId,
            recordKey,
            archive: 'failed',
            acknowledgement: acknowledge ? 'pending' : 'disabled',
          }
          outcomes.push(result)

          const cached = archiveCache.get(recordKey)
          if (cached !== undefined) {
            if (cached.fingerprint !== fingerprint) {
              result.archive = 'rejected'
              result.errorCode = 'ERR_IMMUTABLE_CONFLICT'
              pageHadFailure = true
              continue
            }
            result.archive = cached.status
            result.dedupedAcrossHosts = true
          } else {
            requireNotCancelled(options.signal)
            try {
              const response = await options.historyClient.archiveBatch({ epoch, records: [{ ...record, recordKey }] })
              const status = archiveStatus(response, recordKey)
              if (status === undefined) {
                result.archive = 'rejected'
                result.errorCode = response.outcomes[0]?.errorCode ?? 'ERR_INTERNAL'
                pageHadFailure = true
                continue
              }
              result.archive = status
              archiveCache.set(recordKey, { fingerprint, status })
              archived += 1
            } catch (error) {
              result.errorCode = safeCode(error)
              pageHadFailure = true
              continue
            }
          }
          if (acknowledge) acknowledgeable.push({ messageId: raw.messageId, outcome: result })
        }

        if (acknowledgeable.length > 0) {
          requireNotCancelled(options.signal)
          try {
            await options.messageBoxClient.acknowledgeMessage({ messageIds: acknowledgeable.map(({ messageId }) => messageId), host })
            for (const item of acknowledgeable) item.outcome.acknowledgement = 'acknowledged'
            acknowledged += acknowledgeable.length
            offset = 0
          } catch (error) {
            for (const item of acknowledgeable) {
              item.outcome.acknowledgement = 'failed'
              item.outcome.errorCode = safeCode(error)
            }
            incomplete = true
            break
          }
        } else if (acknowledge && pageHadFailure) {
          incomplete = true
          break
        } else {
          offset = page.nextOffset
        }

        if (pageHadFailure) {
          incomplete = true
          break
        }
        if (!page.hasMore && !acknowledge) break
      }
      if (pagesRead >= maxPages || messagesRead >= maxMessages) incomplete = true
    }
  }

  return { ownerIdentityKey, epoch, pagesRead, messagesRead, archived, acknowledged, incomplete, outcomes }
}
