export const PROTOCOL_VERSION: '1'
export const RECORD_DOMAIN: 'message-box-store:record:v1'
export const CURSOR_DOMAIN: 'message-box-store:cursor:v1'
export const LIMITS: Readonly<{
  MAX_RECORDS_PER_OWNER: 10000
  MAX_BYTES_PER_OWNER: 1073741824
  MAX_BODY_BYTES: 1048576
  MAX_BATCH_RECORDS: 100
  MAX_BATCH_BYTES: 4194304
  MAX_PAGE_RECORDS: 1000
  MAX_PAGE_BYTES: 8388608
  MAX_HTTP_BODY_BYTES: 4194304
  MAX_MESSAGE_BOX_LENGTH: 128
  MAX_MESSAGE_ID_LENGTH: 256
  MAX_EPOCH_LENGTH: 128
  MAX_IDEMPOTENCY_KEY_LENGTH: 128
  CHANGE_RETENTION_DAYS: 30
  CURSOR_TTL_SECONDS: 86400
  PRE_AUTH_RATE_PER_MIN_PER_IP: 300
  AUTH_RATE_PER_MIN_PER_IDENTITY: 1000
  MAX_CONCURRENT_REQUESTS: 24
  DB_POOL_MAX: 7
}>

export function utf8Bytes(value: string): Uint8Array
export function utf8ByteLength(value: string): number
export function hasInvalidUnicode(value: unknown): boolean
export function isIdentityKey(value: unknown): value is string
export function isRecordKey(value: unknown): value is string
export function isBodyHash(value: unknown): value is string
export function isUint64DecimalString(value: unknown): value is string
export function sha256Bytes(data: Uint8Array): Uint8Array
export function sha256Hex(data: Uint8Array | string): string
export function bodyHash(body: string): string
export function assertNoDuplicateTopLevelKeys(jsonText: string): void
export function validateEncryptedBody(body: string): string

export type Direction = 'inbound' | 'outbound'
export function validateDirection(value: unknown): Direction
export function validateMessageBox(value: unknown): string
export function validateMessageId(value: unknown): string
export function canonicalRecordKey(args: {
  ownerIdentityKey: string
  direction: Direction
  messageBox: string
  sender: string
  recipient: string
  messageId: string
}): string
export function isCanonicalBase64(value: unknown): value is string
