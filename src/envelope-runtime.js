import { stringifyBRC100, Utils } from '@bsv/sdk'

import {
  assertNoDuplicateTopLevelKeys,
  bodyHash,
  canonicalRecordKey,
  isCanonicalBase64,
} from './canonical-runtime.js'

/** The wallet protocol used by @bsv/message-box-client 2.5.1. */
export const MESSAGEBOX_PROTOCOL = Object.freeze([1, 'messagebox'])
export const MESSAGEBOX_KEY_ID = '1'

/** Match MessageBoxClient's public body serialization before encryption. */
export function plaintextText(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') {
    throw new TypeError('MessageBox plaintext must be a string or object')
  }
  return stringifyBRC100(value)
}

/** Encrypt once and preserve the exact body bytes passed to Message Box. */
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

/** Extract the canonical ciphertext without rewriting the stored body. */
export function extractEncryptedMessage(body, { allowPaymentFreeTransportWrapper = false } = {}) {
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
    !isCanonicalBase64(parsed.encryptedMessage)
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

export { bodyHash, canonicalRecordKey }
