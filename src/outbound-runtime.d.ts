export const PAID_TRANSPORT_UNSUPPORTED_CODE: 'ERR_PAID_TRANSPORT_UNSUPPORTED'
export class PaidTransportUnsupportedError extends Error {
  readonly code: 'ERR_PAID_TRANSPORT_UNSUPPORTED'
}

export interface FreeOnlyMessageBoxClient {
  readonly host: string
  readonly trustedHosts: readonly string[]
  getIdentityKey(): Promise<string>
  listRawPage(args: { messageBox: string; offset?: number; limit?: number; host?: string }): Promise<unknown>
  acknowledgeMessage(args: { messageIds: string[]; host?: string }): Promise<'success'>
}

export function createFreeOnlyMessageBoxClient(options: {
  walletClient: object
  host: string
  trustedHosts?: string[]
  originator?: string
  allowLoopbackHttpForTests?: boolean
}): FreeOnlyMessageBoxClient

declare const httpSendBrand: unique symbol
export interface MessageBoxHttpSendCapability {
  readonly [httpSendBrand]: true
}

export const OUTBOUND_SEND_STATES: readonly ['prepared', 'accepted', 'unknown', 'failed']
export type OutboundSendState = (typeof OUTBOUND_SEND_STATES)[number]

export interface OutboundAttempt {
  recordKey: string
  ownerIdentityKey: string
  direction: 'outbound'
  messageBox: string
  sender: string
  recipient: string
  messageId: string
  body: string
  bodyHash: string
  host: string
  state: 'prepared'
}

export interface OutboundAttemptStore {
  claimPrepared(attempt: OutboundAttempt): Promise<{
    created: boolean
    existingUnobserved?: boolean
    record?: Omit<Partial<OutboundAttempt>, 'state'> & { state?: OutboundSendState }
  }>
  setState(recordKey: string, state: Exclude<OutboundSendState, 'prepared'>): Promise<boolean>
  recordPreflightFailure?(failure: { recordKey: string; state: 'failed'; errorCode: string }): Promise<boolean>
}

export interface PreparedHttpSendResult {
  state: Exclude<OutboundSendState, 'prepared'>
  attempted: boolean
  recordKey: string | null
  errorCode?: string
  reused?: boolean
  statePersisted: boolean
}

export function createMessageBoxHttpSendCapability(client: FreeOnlyMessageBoxClient): MessageBoxHttpSendCapability
export function sendPreparedHttpOnce(options: {
  httpSend: MessageBoxHttpSendCapability
  attemptStore: OutboundAttemptStore
  ownerIdentityKey: string
  recipient: string
  messageBox: string
  messageId: string
  body: string
  host: string
  checkPermissions?: boolean
}): Promise<PreparedHttpSendResult>
