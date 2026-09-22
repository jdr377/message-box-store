import { bodyHash, canonicalRecordKey } from './canonical-runtime.js'
import { extractEncryptedMessage } from './envelope-runtime.js'
import {
  createFreeOnlyMessageBoxClient,
  getFreeOnlyMessageBoxTransport,
  isPaidTransportUnsupportedError,
  PaidTransportUnsupportedError,
  PAID_TRANSPORT_UNSUPPORTED_CODE,
} from './free-only-transport.mjs'

export const OUTBOUND_SEND_STATES = Object.freeze(['prepared', 'accepted', 'unknown', 'failed'])

// Only this module can brand a capability accepted by the send state machine.
const freeOnlyHttpSendCapabilities = new WeakMap()

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isIdentityKey(value) {
  return typeof value === 'string' && /^0[23][0-9a-f]{64}$/.test(value)
}

function sameAttempt(existing, expected) {
  return existing !== null && typeof existing === 'object' && [
    'recordKey', 'ownerIdentityKey', 'direction', 'messageBox', 'sender',
    'recipient', 'messageId', 'body', 'bodyHash', 'host',
  ].every((field) => existing[field] === expected[field])
}

function existingStateResult(existing) {
  switch (existing?.state) {
    case 'accepted': return 'accepted'
    case 'failed': return 'failed'
    case 'prepared':
    case 'unknown':
    default: return 'unknown'
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

/** Produce the opaque capability accepted by the one-shot send helper. */
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
 * Reserve one canonical outbound attempt and invoke HTTP send at most once.
 * Existing prepared or unknown attempts are ambiguous and are never resent.
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

  const capabilityOwnerIdentityKey = await capabilityState.getOwnerIdentityKey()
  if (ownerIdentityKey !== capabilityOwnerIdentityKey) {
    throw new TypeError('ownerIdentityKey must equal the capability wallet identity')
  }
  const transport = capabilityState.transport

  if (typeof host === 'string' && host !== transport.host) {
    throw new TypeError('Outbound Message Box send must use the capability primary origin')
  }

  const canKey = isIdentityKey(ownerIdentityKey) && isIdentityKey(recipient) &&
    isNonEmptyString(messageBox) && isNonEmptyString(messageId)
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

  if (checkPermissions === true) {
    return {
      state: 'failed', attempted: false, recordKey,
      errorCode: PAID_TRANSPORT_UNSUPPORTED_CODE, statePersisted: false,
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

  if (typeof attemptStore?.claimPrepared !== 'function' || typeof attemptStore?.setState !== 'function') {
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
    if (claim?.created === false && claim.existingUnobserved === true) {
      return { state: 'unknown', attempted: false, recordKey, reused: true, statePersisted: false }
    }
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

  // Only the guarded free transport is reachable after the reservation.
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
        state: 'failed', attempted: true, recordKey,
        errorCode: PAID_TRANSPORT_UNSUPPORTED_CODE, statePersisted,
      }
    }
    const statePersisted = await persistOutcome(attemptStore, recordKey, 'unknown')
    return { state: 'unknown', attempted: true, recordKey, errorCode: 'AMBIGUOUS_SEND_OUTCOME', statePersisted }
  }
}

export {
  createFreeOnlyMessageBoxClient,
  PaidTransportUnsupportedError,
  PAID_TRANSPORT_UNSUPPORTED_CODE,
}
