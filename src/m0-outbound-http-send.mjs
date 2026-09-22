import { bodyHash, canonicalRecordKey, extractEncryptedMessage } from './m0-envelope.mjs'
import {
  getFreeOnlyMessageBoxTransport,
  isPaidTransportUnsupportedError,
  PaidTransportUnsupportedError,
  PAID_TRANSPORT_UNSUPPORTED_CODE,
} from './free-only-transport.mjs'

/**
 * M0 outbound states. A persisted `prepared` attempt may have crossed the
 * process/network boundary before a crash, so a later invocation treats it as
 * ambiguous and never sends it again.
 */
export const OUTBOUND_SEND_STATES = Object.freeze(['prepared', 'accepted', 'unknown', 'failed'])

// A WeakSet brand prevents structurally similar senders from entering the
// public one-shot helper. Callers cannot mint membership with a property or
// symbol; only the factory below can create an accepted capability.
const freeOnlyHttpSendCapabilities = new WeakMap()

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isIdentityKey(value) {
  return typeof value === 'string' && /^0[23][0-9a-f]{64}$/.test(value)
}

function sameAttempt(existing, expected) {
  return existing !== null && typeof existing === 'object' && [
    'recordKey',
    'ownerIdentityKey',
    'direction',
    'messageBox',
    'sender',
    'recipient',
    'messageId',
    'body',
    'bodyHash',
    'host',
  ].every((field) => existing[field] === expected[field])
}

function paidTransportUnsupportedError() {
  return new PaidTransportUnsupportedError()
}

function existingStateResult(existing) {
  switch (existing?.state) {
    case 'accepted':
      return 'accepted'
    case 'failed':
      return 'failed'
    case 'prepared':
    case 'unknown':
    default:
      // A prior prepared write may have reached the transport before a crash.
      return 'unknown'
  }
}

async function recordPreflightFailure(attemptStore, recordKey, errorCode) {
  if (recordKey === null || typeof attemptStore?.recordPreflightFailure !== 'function') return false
  try {
    return (await attemptStore.recordPreflightFailure({ recordKey, state: 'failed', errorCode })) === true
  } catch {
    return false
  }
}

async function persistOutcome(attemptStore, recordKey, state) {
  try {
    return (await attemptStore.setState(recordKey, state)) === true
  } catch {
    return false
  }
}

/**
 * Produce an unforgeable one-shot-helper capability from a client returned by
 * the approved free-only factory. It contains one application-level send
 * method and no live-send or live-to-HTTP fallback path. The SDK may still
 * perform internal BRC-103 session recovery exchanges within that invocation.
 */
export function createMessageBoxHttpSendCapability(messageBoxClient) {
  const transport = getFreeOnlyMessageBoxTransport(messageBoxClient)
  if (transport === undefined) {
    throw new TypeError('MessageBoxClient must come from createFreeOnlyMessageBoxClient()')
  }

  let identityPromise
  const getOwnerIdentityKey = () => {
    identityPromise ??= Promise.resolve(messageBoxClient.getIdentityKey()).then((identityKey) => {
      if (!isIdentityKey(identityKey)) throw new TypeError('Capability wallet returned an invalid identity key')
      return identityKey
    })
    return identityPromise
  }
  const capability = Object.freeze(Object.create(null))
  freeOnlyHttpSendCapabilities.set(capability, Object.freeze({ transport, getOwnerIdentityKey }))
  return capability
}

/**
 * Archive an exact prepared envelope and make at most one application-level
 * public HTTP `sendMessage` invocation for its canonical outbound record key.
 * AuthFetch can make internal authentication/session exchanges; this helper
 * does not promise one physical HTTP exchange. `attemptStore.claimPrepared`
 * must be an atomic insert-if-absent operation. Existing prepared/unknown
 * attempts are treated as ambiguous and are never resent.
 *
 * This is an M0 proof API, not the future durable worker. It deliberately
 * accepts only the runtime-branded capability produced by
 * `createMessageBoxHttpSendCapability`, not a raw client or duck-typed sender.
 */
export async function sendPreparedHttpOnce(options = {}) {
  const httpSend = options?.httpSend
  const capabilityState = freeOnlyHttpSendCapabilities.get(httpSend)
  if (capabilityState === undefined) {
    throw new TypeError('httpSend must come from createMessageBoxHttpSendCapability()')
  }

  const {
    attemptStore,
    ownerIdentityKey,
    recipient,
    messageBox,
    messageId,
    body,
    host,
    checkPermissions = false,
  } = options

  // The archive owner and envelope sender are the wallet identity authenticated
  // by this capability. A caller-supplied compatibility value has no authority:
  // reject a mismatch before reservation, HTTP, or any payment path.
  const capabilityOwnerIdentityKey = await capabilityState.getOwnerIdentityKey()
  if (ownerIdentityKey !== capabilityOwnerIdentityKey) {
    throw new TypeError('ownerIdentityKey must equal the capability wallet identity')
  }
  const transport = capabilityState.transport

  if (typeof host === 'string' && host !== transport.host) {
    throw new TypeError('Outbound Message Box send must use the capability primary origin')
  }

  const canKey = isIdentityKey(ownerIdentityKey) &&
    isIdentityKey(recipient) &&
    isNonEmptyString(messageBox) &&
    isNonEmptyString(messageId)
  const recordKey = canKey
    ? canonicalRecordKey({
      ownerIdentityKey,
      direction: 'outbound',
      messageBox,
      sender: ownerIdentityKey,
      recipient,
      messageId,
    })
    : null

  // Reject an explicit paid request before touching the attempt store. This
  // keeps paid configuration from reserving quota or reaching the upstream
  // client, whose public send path can create payment actions.
  if (checkPermissions === true) {
    return {
      state: 'failed',
      attempted: false,
      recordKey,
      errorCode: PAID_TRANSPORT_UNSUPPORTED_CODE,
      statePersisted: false,
    }
  }

  let validationCode = null
  if (!isNonEmptyString(ownerIdentityKey) || !isIdentityKey(ownerIdentityKey)) validationCode = 'INVALID_OWNER_IDENTITY'
  else if (!isIdentityKey(recipient)) validationCode = 'INVALID_RECIPIENT_IDENTITY'
  else if (!isNonEmptyString(messageBox)) validationCode = 'INVALID_MESSAGE_BOX'
  else if (!isNonEmptyString(messageId)) validationCode = 'INVALID_MESSAGE_ID'
  else if (typeof body !== 'string') validationCode = 'INVALID_ENCRYPTED_BODY'
  else if (!isNonEmptyString(host)) validationCode = 'INVALID_MESSAGE_BOX_HOST'
  else if (typeof checkPermissions !== 'boolean') validationCode = 'INVALID_PERMISSION_POLICY'
  else {
    try {
      extractEncryptedMessage(body)
    } catch {
      validationCode = 'INVALID_ENCRYPTED_BODY'
    }
  }

  if (validationCode !== null) {
    const statePersisted = await recordPreflightFailure(attemptStore, recordKey, validationCode)
    return { state: 'failed', attempted: false, recordKey, errorCode: validationCode, statePersisted }
  }

  if (
    typeof attemptStore?.claimPrepared !== 'function' ||
    typeof attemptStore?.setState !== 'function'
  ) {
    const errorCode = 'HTTP_SEND_OR_ATTEMPT_STORE_UNAVAILABLE'
    const statePersisted = await recordPreflightFailure(attemptStore, recordKey, errorCode)
    return { state: 'failed', attempted: false, recordKey, errorCode, statePersisted }
  }

  const attempt = {
    recordKey,
    ownerIdentityKey,
    direction: 'outbound',
    messageBox,
    sender: ownerIdentityKey,
    recipient,
    messageId,
    body,
    bodyHash: bodyHash(body),
    host,
    state: 'prepared',
  }

  let claim
  try {
    claim = await attemptStore.claimPrepared(attempt)
  } catch {
    return { state: 'failed', attempted: false, recordKey, errorCode: 'ATTEMPT_RESERVATION_FAILED', statePersisted: false }
  }

  if (claim?.created !== true) {
    const existing = claim?.record
    if (!sameAttempt(existing, attempt)) {
      return { state: 'failed', attempted: false, recordKey, errorCode: 'ERR_IMMUTABLE_CONFLICT', statePersisted: false }
    }
    if (existing?.state === 'prepared') {
      const statePersisted = await persistOutcome(attemptStore, recordKey, 'unknown')
      return { state: 'unknown', attempted: false, recordKey, reused: true, statePersisted }
    }
    const state = existingStateResult(existing)
    const statePersisted = ['accepted', 'failed', 'unknown'].includes(existing?.state) && existing.state === state
    return { state, attempted: false, recordKey, reused: true, statePersisted }
  }

  // One application-level `sendMessage` call only. Under this helper's fixed
  // free-only inputs, ERR_PAID_TRANSPORT_UNSUPPORTED can only come from the
  // guarded AuthFetch payment-key path after an HTTP 402. The guard proves that
  // no BRC-105 action or paid retry happened, so that refusal is deterministic
  // `failed`; other thrown or malformed outcomes remain ambiguous.
  try {
    const result = await transport.sendMessage({
      recipient,
      messageBox,
      messageId,
      body,
      skipEncryption: true,
      checkPermissions: false,
    }, host)

    if (result?.status === 'success' && result.messageId === messageId) {
      const statePersisted = await persistOutcome(attemptStore, recordKey, 'accepted')
      return {
        state: statePersisted ? 'accepted' : 'unknown',
        attempted: true,
        recordKey,
        errorCode: statePersisted ? undefined : 'OUTCOME_PERSISTENCE_FAILED',
        statePersisted,
      }
    }

    const statePersisted = await persistOutcome(attemptStore, recordKey, 'unknown')
    return { state: 'unknown', attempted: true, recordKey, errorCode: 'AMBIGUOUS_SEND_RESPONSE', statePersisted }
  } catch (error) {
    if (isPaidTransportUnsupportedError(error)) {
      const statePersisted = await persistOutcome(attemptStore, recordKey, 'failed')
      return {
        state: 'failed',
        attempted: true,
        recordKey,
        errorCode: PAID_TRANSPORT_UNSUPPORTED_CODE,
        statePersisted,
      }
    }
    const statePersisted = await persistOutcome(attemptStore, recordKey, 'unknown')
    return { state: 'unknown', attempted: true, recordKey, errorCode: 'AMBIGUOUS_SEND_OUTCOME', statePersisted }
  }
}
