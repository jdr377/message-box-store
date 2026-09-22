import { prepareEncryptedBody } from './envelope-runtime.js'
import type { MessageBoxEncryptWallet } from './envelope-runtime.js'
import {
  createMessageBoxHttpSendCapability,
  sendPreparedHttpOnce,
} from './outbound-runtime.js'
import type {
  FreeOnlyMessageBoxClient,
  OutboundAttempt,
  OutboundAttemptStore,
  OutboundSendState,
  PreparedHttpSendResult,
} from './outbound-runtime.js'
import type {
  ArchiveBatchRequest,
  ArchiveBatchResponse,
  Capabilities,
  StatePatchResponse,
} from './protocol.js'

export interface OutboundHistoryClient {
  capabilities(requiredFeatures?: readonly string[]): Promise<Capabilities>
  archiveBatch(request: ArchiveBatchRequest): Promise<ArchiveBatchResponse>
  patchState(options: {
    recordKey: string
    newState: 'accepted' | 'unknown' | 'failed'
    expectedRevision: string
    idempotencyKey: string
  }): Promise<StatePatchResponse>
}

export interface SendOutboundOnceOptions {
  wallet: MessageBoxEncryptWallet
  messageBoxClient: FreeOnlyMessageBoxClient
  historyClient: OutboundHistoryClient
  recipient: string
  messageBox: string
  plaintext: string | Record<string, unknown>
  /** Reuse only to identify an already-started logical send; omission creates a fresh event ID. */
  messageId?: string
  /** Test/application ID source. It must return a fresh ID for each new logical send. */
  createMessageId?: () => string
}

export interface SendOutboundOnceResult extends PreparedHttpSendResult {
  messageId: string
}

const OUTBOUND_REQUIRED_FEATURES = Object.freeze(['archiveBatch', 'patchState', 'epoch', 'idempotency'])

function newMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('A secure randomUUID implementation is required')
  }
  return globalThis.crypto.randomUUID()
}

function createRemoteAttemptStore(historyClient: OutboundHistoryClient): OutboundAttemptStore {
  let reservation: { recordKey: string; expectedRevision: '1'; idempotencyKey: string } | undefined

  return {
    async claimPrepared(attempt: OutboundAttempt) {
      const capabilities = await historyClient.capabilities(OUTBOUND_REQUIRED_FEATURES)
      const response = await historyClient.archiveBatch({
        epoch: capabilities.epoch,
        records: [{
          recordKey: attempt.recordKey,
          messageId: attempt.messageId,
          messageBox: attempt.messageBox,
          direction: 'outbound',
          sender: attempt.sender,
          recipient: attempt.recipient,
          body: attempt.body,
          bodyHash: attempt.bodyHash,
          deliveryState: 'prepared',
        }],
      })
      const outcome = response.outcomes[0]
      const matches = response.epoch === capabilities.epoch &&
        outcome?.index === 0 &&
        outcome.recordKey === attempt.recordKey &&
        outcome.bodyHash === attempt.bodyHash

      if (!response.committed || !matches) throw new Error('Outbound reservation was not confirmed')
      if (outcome.outcome === 'stored') {
        reservation = {
          recordKey: attempt.recordKey,
          expectedRevision: '1',
          idempotencyKey: `outbound_state_${attempt.recordKey}`,
        }
        return { created: true }
      }
      if (outcome.outcome === 'alreadyPresent') {
        return { created: false, existingUnobserved: true }
      }
      throw new Error('Outbound reservation was rejected')
    },

    async setState(recordKey: string, state: Exclude<OutboundSendState, 'prepared'>) {
      const owned = reservation
      reservation = undefined
      if (owned === undefined || owned.recordKey !== recordKey) return false
      try {
        const response = await historyClient.patchState({
          recordKey,
          newState: state,
          expectedRevision: owned.expectedRevision,
          idempotencyKey: owned.idempotencyKey,
        })
        return response.recordKey === recordKey && response.revision === '2'
      } catch {
        return false
      }
    },
  }
}

/** Archive a fresh prepared ciphertext, then dispatch it through Message Box at most once. */
export async function sendOutboundOnce(options: SendOutboundOnceOptions): Promise<SendOutboundOnceResult> {
  const messageId = options.messageId ?? (options.createMessageId ?? newMessageId)()
  const ownerIdentityKey = await options.messageBoxClient.getIdentityKey()
  const prepared = await prepareEncryptedBody({
    wallet: options.wallet,
    plaintext: options.plaintext,
    counterparty: options.recipient,
  })
  const result = await sendPreparedHttpOnce({
    httpSend: createMessageBoxHttpSendCapability(options.messageBoxClient),
    attemptStore: createRemoteAttemptStore(options.historyClient),
    ownerIdentityKey,
    recipient: options.recipient,
    messageBox: options.messageBox,
    messageId,
    body: prepared.body,
    host: options.messageBoxClient.host,
    checkPermissions: false,
  })
  return { ...result, messageId }
}
