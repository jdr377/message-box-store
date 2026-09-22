import { createHash } from 'node:crypto'

import { stringifyBRC100, Utils } from '@bsv/sdk'

import { assertNoDuplicateTopLevelKeys } from './protocol.mjs'

/** The wallet protocol used by @bsv/message-box-client 2.5.1. */
export const MESSAGEBOX_PROTOCOL = Object.freeze([1, 'messagebox'])
export const MESSAGEBOX_KEY_ID = '1'

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Match MessageBoxClient's public body serialization before encryption.
 * Strings are bytes as supplied; objects use the SDK's BRC-100 JSON encoding.
 */
export function plaintextText(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') {
    throw new TypeError('MessageBox plaintext must be a string or object')
  }
  return stringifyBRC100(value)
}

/**
 * Prepare one encrypted Message Box body through the public WalletInterface.
 * This is deliberately a one-encrypt operation. The returned body is the
 * exact UTF-8 string passed to sendMessage(..., { skipEncryption: true }).
 */
export async function prepareEncryptedBody({ wallet, plaintext, counterparty }) {
  if (typeof counterparty !== 'string' || counterparty.trim() === '') {
    throw new TypeError('MessageBox counterparty is required')
  }
  const text = plaintextText(plaintext)
  const encrypted = await wallet.encrypt({
    protocolID: [...MESSAGEBOX_PROTOCOL],
    keyID: MESSAGEBOX_KEY_ID,
    counterparty,
    plaintext: Array.from(new TextEncoder().encode(text)),
  })
  const ciphertext = Array.from(encrypted.ciphertext)
  if (ciphertext.length === 0) throw new Error('Wallet returned empty ciphertext')
  const encoded = Utils.toBase64(ciphertext)
  return {
    body: stringifyBRC100({ encryptedMessage: encoded }),
    plaintext: text,
    ciphertext,
    encryptedMessage: encoded,
  }
}

/** SHA-256 of the exact UTF-8 bytes of a stored Message Box body string. */
export function bodyHash(body) {
  if (typeof body !== 'string') throw new TypeError('MessageBox body must be a string')
  return createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
}

/** ADR-001 v1 record key encoding, included here for the M0 dedupe fixture. */
export function canonicalRecordKey({ ownerIdentityKey, direction, messageBox, sender, recipient, messageId }) {
  const fields = ['message-box-store:record:v1', ownerIdentityKey, direction, messageBox, sender, recipient, messageId]
  const chunks = fields.map((field) => {
    if (typeof field !== 'string') throw new TypeError('Record-key fields must be strings')
    const bytes = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.length, 0)
    return Buffer.concat([length, bytes])
  })
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex')
}

function parseJsonBody(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      throw new TypeError('MessageBox body is not valid JSON')
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  throw new TypeError('MessageBox body must be a JSON object')
}

/**
 * Extract an encryptedMessage string from an exact inner envelope. When
 * allowPaymentFreeTransportWrapper is true, one `{ message: ... }` wrapper is
 * accepted for the current server's payment-free response shape; wrappers
 * carrying payment metadata are rejected so history never archives it.
 */
export function extractEncryptedMessage(body, { allowPaymentFreeTransportWrapper = false } = {}) {
  // Every string layer gets duplicate-member screening before JSON.parse
  // collapses literal, escaped (\u0065) or whitespace-varied duplicates.
  // Object layers are already collapsed by the caller and cannot carry raw
  // duplicates; they are still validated for exact single-key shape below.
  // Valid bodies are never rewritten: the original bytes are hashed elsewhere
  // and only the base64 payload string is returned.
  if (typeof body === 'string') assertNoDuplicateTopLevelKeys(body)
  let parsed = parseJsonBody(body)
  if (
    allowPaymentFreeTransportWrapper &&
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length === 1 &&
    Object.prototype.hasOwnProperty.call(parsed, 'message')
  ) {
    // Supported wrapper is string-valued: `{ "message": "<inner JSON string>" }`.
    // Object-valued wrappers cannot be duplicate-screened from raw bytes, so
    // only the canonical string form is accepted for history archival.
    if (typeof parsed.message !== 'string') {
      throw new TypeError('MessageBox body must be exactly { encryptedMessage: canonical base64 }')
    }
    assertNoDuplicateTopLevelKeys(parsed.message)
    parsed = parseJsonBody(parsed.message)
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof parsed.encryptedMessage !== 'string' ||
    !BASE64.test(parsed.encryptedMessage) ||
    parsed.encryptedMessage.length === 0 ||
    Utils.toBase64(Utils.toArray(parsed.encryptedMessage, 'base64')) !== parsed.encryptedMessage
  ) {
    throw new TypeError('MessageBox body must be exactly { encryptedMessage: canonical base64 }')
  }
  return parsed.encryptedMessage
}

/** Decrypt an archived outbound or inbound body through the public wallet API. */
export async function decryptArchivedBody({ wallet, body, counterparty, allowPaymentFreeTransportWrapper = false }) {
  const encryptedMessage = extractEncryptedMessage(body, { allowPaymentFreeTransportWrapper })
  const result = await wallet.decrypt({
    protocolID: [...MESSAGEBOX_PROTOCOL],
    keyID: MESSAGEBOX_KEY_ID,
    counterparty,
    ciphertext: Utils.toArray(encryptedMessage, 'base64'),
  })
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(result.plaintext))
}
