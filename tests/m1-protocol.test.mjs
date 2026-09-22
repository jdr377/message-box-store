import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertOwnerDirection,
  bodyHash,
  canonicalRecordKey,
  checkPageFits,
  compareUint64Decimal,
  createCursor,
  DELIVERY_STATES,
  DIRECTIONS,
  ERROR_CODES,
  estimateJsonBytes,
  isIdentityKey,
  isUint64DecimalString,
  LIMITS,
  M0_VECTOR,
  makeStoreError,
  recomputeRecordIdentity,
  validateChangeSequence,
  validateEncryptedBody,
  validateEpoch,
  validateHistoryPage,
  validateIdempotencyKey,
  verifyCursor,
} from '../src/protocol.mjs'

const OWNER = M0_VECTOR.ownerIdentityKey
const PEER = M0_VECTOR.recipient
const OTHER_PEER = `03${'33'.repeat(32)}`
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function nonCanonicalBase64urlAlias(value) {
  const remainder = value.length % 4
  assert.ok(remainder === 2 || remainder === 3, `test vector must have unused pad bits: ${value.length}`)
  const index = BASE64URL_ALPHABET.indexOf(value.at(-1))
  assert.ok(index >= 0)
  return `${value.slice(0, -1)}${BASE64URL_ALPHABET[index ^ 1]}`
}

test('M1 canonical M0 vector is frozen', () => {
  assert.equal(bodyHash(M0_VECTOR.body), M0_VECTOR.bodyHash)
  assert.equal(
    canonicalRecordKey({
      ownerIdentityKey: M0_VECTOR.ownerIdentityKey,
      direction: M0_VECTOR.direction,
      messageBox: M0_VECTOR.messageBox,
      sender: M0_VECTOR.sender,
      recipient: M0_VECTOR.recipient,
      messageId: M0_VECTOR.messageId,
    }),
    M0_VECTOR.recordKey,
  )
  assert.equal(
    recomputeRecordIdentity({
      ownerIdentityKey: OWNER,
      direction: 'outbound',
      messageBox: M0_VECTOR.messageBox,
      sender: OWNER,
      recipient: PEER,
      messageId: M0_VECTOR.messageId,
      body: M0_VECTOR.body,
    }).recordKey,
    M0_VECTOR.recordKey,
  )
})

test('M1 same messageId in different boxes/directions yields distinct keys', () => {
  const base = {
    ownerIdentityKey: OWNER,
    sender: OWNER,
    recipient: PEER,
    messageId: 'same-id',
  }
  const a = canonicalRecordKey({ ...base, direction: 'outbound', messageBox: 'inbox' })
  const b = canonicalRecordKey({ ...base, direction: 'outbound', messageBox: 'general_inbox' })
  const c = canonicalRecordKey({
    ownerIdentityKey: OWNER,
    direction: 'inbound',
    messageBox: 'inbox',
    sender: PEER,
    recipient: OWNER,
    messageId: 'same-id',
  })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.notEqual(b, c)
})

test('M1 forged keys/hashes are caught by server recomputation', () => {
  // Same metadata with a different body must recompute to a different hash;
  // the server must compare supplied values against recomputation and raise
  // an immutable conflict instead of creating a second row.
  const recomputed = recomputeRecordIdentity({
    ownerIdentityKey: OWNER,
    direction: 'outbound',
    messageBox: M0_VECTOR.messageBox,
    sender: OWNER,
    recipient: PEER,
    messageId: M0_VECTOR.messageId,
    body: '{"encryptedMessage":"AQI="}',
  })
  assert.notEqual(recomputed.bodyHash, M0_VECTOR.bodyHash)
  assert.equal(
    recomputed.recordKey,
    M0_VECTOR.recordKey,
    'recordKey covers metadata only; body change is a conflict under the same key',
  )
  const original = recomputeRecordIdentity({
    ownerIdentityKey: OWNER,
    direction: 'outbound',
    messageBox: M0_VECTOR.messageBox,
    sender: OWNER,
    recipient: PEER,
    messageId: M0_VECTOR.messageId,
    body: M0_VECTOR.body,
  })
  assert.notEqual(recomputed.bodyHash, original.bodyHash)
  assert.equal(original.recordKey, M0_VECTOR.recordKey)
})

test('M1 identity keys are compressed lowercase only', () => {
  const hexKey = `02${'ab'.repeat(32)}`
  assert.equal(isIdentityKey(OWNER), true)
  assert.equal(isIdentityKey(hexKey), true)
  assert.equal(isIdentityKey(hexKey.toUpperCase()), false)
  assert.equal(isIdentityKey(`04${'11'.repeat(32)}`), false)
  assert.equal(isIdentityKey('0211'), false)
  assert.equal(isIdentityKey(''), false)
})

test('M1 JSON escape decoding does not rewrite the body', () => {
  // Wire-escaped and plain JSON decode to the same stored string and hash.
  const wire = '"{\\"encryptedMessage\\":\\"AQ==\\"}"'
  const decoded = JSON.parse(wire)
  assert.equal(decoded, M0_VECTOR.body)
  assert.equal(bodyHash(decoded), M0_VECTOR.bodyHash)
  // Spacing is a different byte string with a different hash, proving no
  // silent normalization: the server hashes exact bytes, not reserialized JSON.
  const spaced = '{ "encryptedMessage" : "AQ==" }'
  assert.notEqual(bodyHash(spaced), M0_VECTOR.bodyHash)
  assert.equal(validateEncryptedBody(spaced), 'AQ==')
})

test('M1 invalid Unicode and plaintext bodies are rejected', () => {
  assert.throws(() => validateEncryptedBody('{"encryptedMessage":"AQ=="}\uD800'), /invalid Unicode/)
  assert.throws(() => validateEncryptedBody(JSON.stringify({ text: 'not ciphertext' })), /exactly/)
  assert.throws(() => validateEncryptedBody(JSON.stringify({ encryptedMessage: '!!!' })), /exactly/)
  assert.throws(() => validateEncryptedBody(JSON.stringify({ encryptedMessage: 'AQ==', extra: 1 })), /exactly/)
  assert.throws(() => bodyHash('\uD800'), /invalid Unicode/)
  assert.throws(
    () =>
      canonicalRecordKey({
        ownerIdentityKey: OWNER,
        direction: 'outbound',
        messageBox: 'inbox\uD800',
        sender: OWNER,
        recipient: PEER,
        messageId: 'x',
      }),
    /invalid Unicode|messageBox/,
  )
})

test('M1 owner direction constraints', () => {
  assertOwnerDirection({ ownerIdentityKey: OWNER, direction: 'outbound', sender: OWNER, recipient: PEER })
  assertOwnerDirection({ ownerIdentityKey: OWNER, direction: 'inbound', sender: PEER, recipient: OWNER })
  assert.throws(
    () => assertOwnerDirection({ ownerIdentityKey: OWNER, direction: 'inbound', sender: OWNER, recipient: PEER }),
    /inbound recipient/,
  )
  assert.throws(
    () => assertOwnerDirection({ ownerIdentityKey: OWNER, direction: 'outbound', sender: PEER, recipient: OWNER }),
    /outbound sender/,
  )
})

test('M1 uint64 sequences are decimal strings with canonical ordering', () => {
  assert.equal(isUint64DecimalString('0'), true)
  assert.equal(isUint64DecimalString('18446744073709551615'), true)
  assert.equal(isUint64DecimalString('18446744073709551616'), false)
  assert.equal(isUint64DecimalString(42), false)
  assert.equal(isUint64DecimalString('-1'), false)
  assert.equal(isUint64DecimalString('01'), false)
  assert.equal(compareUint64Decimal('2', '10'), -1)
  assert.equal(compareUint64Decimal('10', '2'), 1)
  assert.equal(compareUint64Decimal('10', '10'), 0)
  assert.throws(() => validateChangeSequence('01'), /uint64/)
  validateEpoch('gen-1')
  assert.throws(() => validateEpoch(''), /epoch/)
  validateIdempotencyKey('op-123_abc')
  assert.throws(() => validateIdempotencyKey(''), /idempotency/)
})

test('M1 error envelope covers PRD classes without secret echo', () => {
  for (const code of [
    'ERR_AUTHENTICATION_REQUIRED',
    'ERR_FORBIDDEN',
    'ERR_INVALID_RECORD',
    'ERR_REQUEST_TOO_LARGE',
    'ERR_QUOTA_EXCEEDED',
    'ERR_IMMUTABLE_CONFLICT',
    'ERR_CURSOR_EXPIRED',
    'ERR_INVALID_CURSOR',
    'ERR_REVISION_CONFLICT',
    'ERR_EPOCH_CHANGED',
    'ERR_RATE_LIMITED',
    'ERR_UNAVAILABLE',
    'ERR_INTERNAL',
  ]) {
    assert.ok(ERROR_CODES.includes(code), code)
    const err = makeStoreError(code, 'operator-safe description')
    assert.equal(err.status, 'error')
    assert.equal(err.code, code)
    assert.ok(!JSON.stringify(err).includes(M0_VECTOR.body))
  }
  assert.deepEqual(DIRECTIONS, ['inbound', 'outbound'])
  assert.ok(DELIVERY_STATES.includes('received'))
})

test('M1 empty/final checkpoints are still progress', () => {
  const emptyFinal = {
    records: [],
    nextCursor: null,
    checkpoint: '0',
    hasMore: false,
    watermark: '42',
    epoch: 'gen-1',
    serverTime: new Date().toISOString(),
  }
  validateHistoryPage(emptyFinal)
  assert.throws(() => validateHistoryPage({ ...emptyFinal, checkpoint: '' }), /checkpoint/)
  assert.throws(() => validateHistoryPage({ ...emptyFinal, hasMore: true, nextCursor: null }), /nextCursor/)
  assert.throws(() => validateHistoryPage({ ...emptyFinal, hasMore: false, nextCursor: 'x' }), /nextCursor/)
})

test('M1 response byte accounting prevents empty continuation loops', () => {
  const small = { recordKey: 'a'.repeat(64), body: 'x'.repeat(100) }
  assert.equal(checkPageFits({ records: [small] }).ok, true)
  assert.ok(estimateJsonBytes(small) > 100)
  const huge = { recordKey: 'b'.repeat(64), body: 'y'.repeat(LIMITS.MAX_PAGE_BYTES) }
  const result = checkPageFits({ records: [huge] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ERR_REQUEST_TOO_LARGE')
})

test('M1 cursors distinguish tampering from expiry and bind owner/filter/epoch', () => {
  const secret = 'test-server-secret-0123456789'
  const token = createCursor({
    serverSecret: secret,
    ownerIdentityKey: OWNER,
    epoch: 'gen-1',
    feed: 'changes',
    filterDigest: 'abc',
    watermark: '100',
    position: M0_VECTOR.recordKey,
    ttlSeconds: 3600,
    nowSeconds: 1_000_000,
  })
  const claims = verifyCursor(token, {
    serverSecret: secret,
    ownerIdentityKey: OWNER,
    expectedEpoch: 'gen-1',
    expectedFeed: 'changes',
    expectedFilterDigest: 'abc',
    nowSeconds: 1_000_100,
  })
  assert.equal(claims.w, '100')
  // Tampered payload fails as invalid, not expired.
  const [payload, mac] = token.split('.')
  assert.throws(
    () =>
      verifyCursor(`${payload.slice(0, -2)}AA.${mac}`, {
        serverSecret: secret,
        ownerIdentityKey: OWNER,
        expectedEpoch: 'gen-1',
        expectedFeed: 'changes',
        expectedFilterDigest: 'abc',
        nowSeconds: 1_000_100,
      }),
    (error) => error?.code === 'ERR_INVALID_CURSOR',
  )
  // Copied across identities fails without revealing activity.
  assert.throws(
    () =>
      verifyCursor(token, {
        serverSecret: secret,
        ownerIdentityKey: OTHER_PEER,
        expectedEpoch: 'gen-1',
        expectedFeed: 'changes',
        expectedFilterDigest: 'abc',
        nowSeconds: 1_000_100,
      }),
    (error) => error?.code === 'ERR_INVALID_CURSOR',
  )
  // Expired but otherwise valid returns expiry with resync hint.
  assert.throws(
    () =>
      verifyCursor(token, {
        serverSecret: secret,
        ownerIdentityKey: OWNER,
        expectedEpoch: 'gen-1',
        expectedFeed: 'changes',
        expectedFilterDigest: 'abc',
        nowSeconds: 1_000_000 + 3601,
      }),
    (error) => error?.code === 'ERR_CURSOR_EXPIRED',
  )
  // Epoch rotation and filter/feed misuse are rejected.
  assert.throws(
    () =>
      verifyCursor(token, {
        serverSecret: secret,
        ownerIdentityKey: OWNER,
        expectedEpoch: 'gen-2',
        expectedFeed: 'changes',
        expectedFilterDigest: 'abc',
        nowSeconds: 1_000_100,
      }),
    (error) => error?.code === 'ERR_EPOCH_CHANGED',
  )
  assert.throws(
    () =>
      verifyCursor(token, {
        serverSecret: secret,
        ownerIdentityKey: OWNER,
        expectedEpoch: 'gen-1',
        expectedFeed: 'snapshot',
        expectedFilterDigest: 'abc',
        nowSeconds: 1_000_100,
      }),
    (error) => error?.code === 'ERR_INVALID_CURSOR',
  )
})

test('M1 cursor payload and MAC aliases are rejected for both feed domains', () => {
  const secret = 'test-server-secret-0123456789'
  for (const feed of ['changes', 'snapshot']) {
    const token = createCursor({
      serverSecret: secret,
      ownerIdentityKey: OWNER,
      epoch: 'gen-1',
      feed,
      filterDigest: 'abc',
      watermark: '100',
      position: 'abc',
      ttlSeconds: 3600,
      nowSeconds: 1_000_000,
    })
    const [payload, mac] = token.split('.')
    const verify = (candidate) => verifyCursor(candidate, {
      serverSecret: secret,
      ownerIdentityKey: OWNER,
      expectedEpoch: 'gen-1',
      expectedFeed: feed,
      expectedFilterDigest: 'abc',
      nowSeconds: 1_000_100,
    })
    assert.throws(() => verify(`${nonCanonicalBase64urlAlias(payload)}.${mac}`), (error) => error?.code === 'ERR_INVALID_CURSOR', `${feed} payload alias`)
    assert.throws(() => verify(`${payload}.${nonCanonicalBase64urlAlias(mac)}`), (error) => error?.code === 'ERR_INVALID_CURSOR', `${feed} MAC alias`)
  }
})
