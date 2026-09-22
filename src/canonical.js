/**
 * Platform-neutral canonical implementation for the M1 public/runtime
 * boundary.  This plain JavaScript module is the single executable source for
 * UTF-8 handling, canonical validation, record-key derivation, body hashing,
 * and synchronous SHA-256.  It deliberately has no Node built-ins, Buffer, or
 * server/database imports so it can be bundled for browsers as well as used
 * by the Node repository adapters.
 *
 * The typed `canonical.ts` entry point re-exports this module.  Keeping the
 * implementation in a runtime-neutral module avoids a second algorithm in
 * the frozen `.mjs` protocol fixture while preserving the M0 fixture role.
 */

export const PROTOCOL_VERSION = '1'
export const RECORD_DOMAIN = 'message-box-store:record:v1'
export const CURSOR_DOMAIN = 'message-box-store:cursor:v1'

export const LIMITS = Object.freeze({
  MAX_RECORDS_PER_OWNER: 10_000,
  MAX_BYTES_PER_OWNER: 1024 * 1024 * 1024,
  MAX_BODY_BYTES: 1024 * 1024,
  MAX_BATCH_RECORDS: 100,
  MAX_BATCH_BYTES: 4 * 1024 * 1024,
  MAX_PAGE_RECORDS: 1000,
  MAX_PAGE_BYTES: 8 * 1024 * 1024,
  MAX_HTTP_BODY_BYTES: 4 * 1024 * 1024,
  MAX_MESSAGE_BOX_LENGTH: 128,
  MAX_MESSAGE_ID_LENGTH: 256,
  MAX_EPOCH_LENGTH: 128,
  MAX_IDEMPOTENCY_KEY_LENGTH: 128,
  CHANGE_RETENTION_DAYS: 30,
  CURSOR_TTL_SECONDS: 24 * 60 * 60,
  PRE_AUTH_RATE_PER_MIN_PER_IP: 300,
  AUTH_RATE_PER_MIN_PER_IDENTITY: 1000,
  MAX_CONCURRENT_REQUESTS: 24,
  DB_POOL_MAX: 7,
})

const IDENTITY_KEY_RE = /^0[23][0-9a-f]{64}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const UINT64_DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/
const MAX_UINT64 = 18446744073709551615n

const textEncoder = new TextEncoder()

export function utf8Bytes(value) {
  return textEncoder.encode(value)
}

export function utf8ByteLength(value) {
  return textEncoder.encode(value).length
}

export function hasInvalidUnicode(value) {
  return typeof value === 'string' && LONE_SURROGATE_RE.test(value)
}

export function isIdentityKey(value) {
  return typeof value === 'string' && IDENTITY_KEY_RE.test(value)
}

export function isRecordKey(value) {
  return typeof value === 'string' && HEX64_RE.test(value)
}

export function isBodyHash(value) {
  return typeof value === 'string' && HEX64_RE.test(value)
}

export function isUint64DecimalString(value) {
  if (typeof value !== 'string' || !UINT64_DECIMAL_RE.test(value)) return false
  try {
    return BigInt(value) <= MAX_UINT64
  } catch {
    return false
  }
}

// SHA-256 (FIPS 180-4), synchronous and platform-neutral.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb,
  0xbef9a3f7, 0xc67178f2,
])

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n))
}

/** SHA-256 over bytes, returning a 32-byte digest. */
export function sha256Bytes(data) {
  const bitLen = data.length * 8
  const paddedLen = (((data.length + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(paddedLen)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const w = new Uint32Array(64)

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
    h5 = (h5 + f) | 0
    h6 = (h6 + g) | 0
    h7 = (h7 + h) | 0
  }
  const out = new Uint8Array(32)
  const oview = new DataView(out.buffer)
  oview.setUint32(0, h0 >>> 0, false)
  oview.setUint32(4, h1 >>> 0, false)
  oview.setUint32(8, h2 >>> 0, false)
  oview.setUint32(12, h3 >>> 0, false)
  oview.setUint32(16, h4 >>> 0, false)
  oview.setUint32(20, h5 >>> 0, false)
  oview.setUint32(24, h6 >>> 0, false)
  oview.setUint32(28, h7 >>> 0, false)
  return out
}

const HEX = '0123456789abcdef'

export function sha256Hex(data) {
  const bytes = typeof data === 'string' ? utf8Bytes(data) : data
  const digest = sha256Bytes(bytes)
  let out = ''
  for (let i = 0; i < digest.length; i += 1) out += HEX[digest[i] >> 4] + HEX[digest[i] & 0x0f]
  return out
}

/** SHA-256 of the exact UTF-8 bytes of a stored body string. */
export function bodyHash(body) {
  if (typeof body !== 'string') throw new TypeError('body must be a string')
  if (hasInvalidUnicode(body)) throw new TypeError('body contains invalid Unicode')
  return sha256Hex(utf8Bytes(body))
}

function assertExactString(value, { min = 1, max = 128, name = 'value' } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  if (hasInvalidUnicode(value)) throw new TypeError(`${name} contains invalid Unicode`)
  if (value.length < min || value.length > max) throw new TypeError(`${name} must be ${min}..${max} chars`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) throw new TypeError(`${name} contains control characters`)
  if (value.trim() === '') throw new TypeError(`${name} must not be blank`)
  return value
}

export function validateMessageBox(value) {
  return assertExactString(value, { min: 1, max: LIMITS.MAX_MESSAGE_BOX_LENGTH, name: 'messageBox' })
}

export function validateMessageId(value) {
  return assertExactString(value, { min: 1, max: LIMITS.MAX_MESSAGE_ID_LENGTH, name: 'messageId' })
}

export function validateDirection(value) {
  if (value !== 'inbound' && value !== 'outbound') throw new TypeError('direction must be inbound or outbound')
  return value
}

/**
 * Canonical v1 record key: SHA-256 over length-prefixed UTF-8 fields in fixed
 * order (domain, owner, direction, box, sender, recipient, messageId).
 */
export function canonicalRecordKey({ ownerIdentityKey, direction, messageBox, sender, recipient, messageId }) {
  for (const [name, value] of [
    ['ownerIdentityKey', ownerIdentityKey],
    ['sender', sender],
    ['recipient', recipient],
  ]) {
    if (!isIdentityKey(value)) throw new TypeError(`${name} must be a compressed lowercase identity key`)
  }
  validateDirection(direction)
  validateMessageBox(messageBox)
  validateMessageId(messageId)
  const fields = [RECORD_DOMAIN, ownerIdentityKey, direction, messageBox, sender, recipient, messageId]
  const encoded = fields.map((field) => utf8Bytes(field))
  let total = 0
  for (const bytes of encoded) total += 4 + bytes.length
  const joined = new Uint8Array(total)
  const view = new DataView(joined.buffer)
  let offset = 0
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, false)
    offset += 4
    joined.set(bytes, offset)
    offset += bytes.length
  }
  return sha256Hex(joined)
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_REVERSE = Object.create(null)
for (let i = 0; i < B64_ALPHABET.length; i += 1) B64_REVERSE[B64_ALPHABET[i]] = i

function base64Decode(canonical) {
  const pad = canonical.endsWith('==') ? 2 : canonical.endsWith('=') ? 1 : 0
  const outLen = (canonical.length / 4) * 3 - pad
  const out = new Uint8Array(outLen)
  let offset = 0
  for (let i = 0; i < canonical.length; i += 4) {
    const a = B64_REVERSE[canonical[i]] ?? 0
    const b = B64_REVERSE[canonical[i + 1]] ?? 0
    const c = B64_REVERSE[canonical[i + 2]] ?? 0
    const d = B64_REVERSE[canonical[i + 3]] ?? 0
    const triple = (a << 18) | (b << 12) | (c << 6) | d
    if (offset < outLen) out[offset++] = (triple >> 16) & 0xff
    if (offset < outLen) out[offset++] = (triple >> 8) & 0xff
    if (offset < outLen) out[offset++] = triple & 0xff
  }
  return out
}

function base64Encode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    out += B64_ALPHABET[(triple >> 18) & 0x3f] + B64_ALPHABET[(triple >> 12) & 0x3f]
    out += i + 1 < bytes.length ? B64_ALPHABET[(triple >> 6) & 0x3f] : '='
    out += i + 2 < bytes.length ? B64_ALPHABET[triple & 0x3f] : '='
  }
  return out
}

export function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_RE.test(value)) return false
  try {
    return base64Encode(base64Decode(value)) === value
  } catch {
    return false
  }
}

function skipJsonWhitespace(text, index) {
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1
    else break
  }
  return index
}

/** Raw token end of a JSON string starting at the opening quote. */
function scanJsonStringEnd(text, index) {
  let i = index + 1
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 0x22) return i
    if (code === 0x5c) {
      if (text[i + 1] === 'u') i += 6
      else i += 2
      continue
    }
    if (code < 0x20) return -1
    i += 1
  }
  return -1
}

/** Skip one JSON value; malformed input is left for JSON.parse. */
function skipJsonValue(text, index, depth = 0) {
  if (depth > 100) return -1
  index = skipJsonWhitespace(text, index)
  if (index >= text.length) return -1
  const char = text[index]
  if (char === '"') {
    const end = scanJsonStringEnd(text, index)
    return end === -1 ? -1 : end + 1
  }
  if (char === '{') {
    let i = skipJsonWhitespace(text, index + 1)
    if (i < text.length && text[i] === '}') return i + 1
    while (true) {
      i = skipJsonWhitespace(text, i)
      if (i >= text.length || text[i] !== '"') return -1
      const keyEnd = scanJsonStringEnd(text, i)
      if (keyEnd === -1) return -1
      i = skipJsonWhitespace(text, keyEnd + 1)
      if (i >= text.length || text[i] !== ':') return -1
      i = skipJsonValue(text, i + 1, depth + 1)
      if (i === -1) return -1
      i = skipJsonWhitespace(text, i)
      if (i >= text.length) return -1
      if (text[i] === '}') return i + 1
      if (text[i] !== ',') return -1
      i += 1
    }
  }
  if (char === '[') {
    let i = skipJsonWhitespace(text, index + 1)
    if (i < text.length && text[i] === ']') return i + 1
    while (true) {
      i = skipJsonValue(text, i, depth + 1)
      if (i === -1) return -1
      i = skipJsonWhitespace(text, i)
      if (i >= text.length) return -1
      if (text[i] === ']') return i + 1
      if (text[i] !== ',') return -1
      i += 1
    }
  }
  const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index))
  return literal ? index + literal[0].length : -1
}

/** Reject duplicate top-level JSON members without rewriting body bytes. */
export function assertNoDuplicateTopLevelKeys(jsonText) {
  if (typeof jsonText !== 'string') throw new TypeError('body must be a string')
  let i = skipJsonWhitespace(jsonText, 0)
  if (i >= jsonText.length || jsonText[i] !== '{') return
  i += 1
  const seen = new Set()
  let first = true
  while (true) {
    i = skipJsonWhitespace(jsonText, i)
    if (i >= jsonText.length) return
    if (jsonText[i] === '}') return
    if (!first) {
      if (jsonText[i] !== ',') return
      i = skipJsonWhitespace(jsonText, i + 1)
    }
    if (jsonText[i] !== '"') return
    const keyEnd = scanJsonStringEnd(jsonText, i)
    if (keyEnd === -1) return
    let decoded
    try {
      decoded = JSON.parse(jsonText.slice(i, keyEnd + 1))
    } catch {
      return
    }
    if (seen.has(decoded)) throw new TypeError('body must not contain duplicate JSON members')
    seen.add(decoded)
    i = skipJsonWhitespace(jsonText, keyEnd + 1)
    if (jsonText[i] !== ':') return
    i = skipJsonValue(jsonText, i + 1)
    if (i === -1) return
    first = false
  }
}

function parseJsonObject(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('body must be a JSON object string')
      }
      return parsed
    } catch (error) {
      if (error instanceof TypeError) throw error
      throw new TypeError('body is not valid JSON')
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  throw new TypeError('body must be a JSON object')
}

/** Validate the exact inner encrypted body without rewriting its bytes. */
export function validateEncryptedBody(body) {
  if (typeof body !== 'string') throw new TypeError('body must be a string')
  if (hasInvalidUnicode(body)) throw new TypeError('body contains invalid Unicode')
  if (utf8ByteLength(body) > LIMITS.MAX_BODY_BYTES) throw new RangeError('body exceeds 1 MiB')
  assertNoDuplicateTopLevelKeys(body)
  const parsed = parseJsonObject(body)
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || typeof parsed.encryptedMessage !== 'string' || !isCanonicalBase64(parsed.encryptedMessage)) {
    throw new TypeError('body must be exactly { encryptedMessage: canonical base64 }')
  }
  return parsed.encryptedMessage
}
