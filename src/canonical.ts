/**
 * Typed public entry point for the platform-neutral canonical implementation.
 *
 * The executable implementation lives in `canonical.js`, which is also used
 * directly by the Node repository/protocol adapters. Keeping this file as a
 * type-preserving re-export means tsdown emits the public ESM, CJS, and
 * declaration artifacts from the same implementation without maintaining a
 * second hashing or validation algorithm.
 */
export {
  CURSOR_DOMAIN,
  LIMITS,
  PROTOCOL_VERSION,
  RECORD_DOMAIN,
  bodyHash,
  canonicalRecordKey,
  assertNoDuplicateTopLevelKeys,
  hasInvalidUnicode,
  isBodyHash,
  isCanonicalBase64,
  isIdentityKey,
  isRecordKey,
  isUint64DecimalString,
  sha256Bytes,
  sha256Hex,
  utf8ByteLength,
  utf8Bytes,
  validateDirection,
  validateEncryptedBody,
  validateMessageBox,
  validateMessageId,
} from './canonical-runtime.js'

export type Direction = 'inbound' | 'outbound'
export type DeliveryState = 'prepared' | 'received' | 'unknown' | 'accepted' | 'failed'
export type Feed = 'changes' | 'snapshot'

export type CanonicalRecordKeyInput = {
  ownerIdentityKey: string
  direction: Direction
  messageBox: string
  sender: string
  recipient: string
  messageId: string
}
