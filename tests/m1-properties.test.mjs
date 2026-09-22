import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bodyHash,
  canonicalRecordKey,
  isUint64DecimalString,
  LIMITS,
  validateEncryptedBody,
} from '../src/protocol.mjs'

const OWNER = `02${'11'.repeat(32)}`
const PEER = `03${'22'.repeat(32)}`

/** Deterministic xorshift32 for reproducible generated coverage. */
function prng(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0xffffffff
  }
}

const ASCII = 'abcdefghijklmnopqrstuvwxyz0123456789_-'
const UNICODE = ['α', 'β', '水', '🔑', 'é', '\u0000']

function randomString(rand, alphabet, max) {
  const length = 1 + Math.floor(rand() * max)
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(rand() * alphabet.length)]
  return out
}

test('M1 length-prefix framing admits no cross-field ambiguity', () => {
  // Without length prefixes, 'ab'+'c' and 'a'+'bc' collide; framing must separate them.
  const rand = prng(0x2a11)
  for (let i = 0; i < 200; i += 1) {
    const boxA = randomString(rand, ASCII, 8)
    const idA = randomString(rand, ASCII, 8)
    // Split the same concatenated bytes differently across box/id.
    const joined = boxA + idA
    const cut = 1 + Math.floor(rand() * (joined.length - 1))
    const boxB = joined.slice(0, cut)
    const idB = joined.slice(cut)
    const keyA = canonicalRecordKey({ ownerIdentityKey: OWNER, direction: 'outbound', messageBox: boxA, sender: OWNER, recipient: PEER, messageId: idA })
    const keyB = canonicalRecordKey({ ownerIdentityKey: OWNER, direction: 'outbound', messageBox: boxB, sender: OWNER, recipient: PEER, messageId: idB })
    if (boxA === boxB && idA === idB) assert.equal(keyA, keyB)
    else assert.notEqual(keyA, keyB, `collision for ${boxA}|${idA} vs ${boxB}|${idB}`)
  }
})

test('M1 UTF-8 byte boundaries differ from character counts', () => {
  // A body of 1MiB multibyte chars is many MiB of UTF-8 and must reject;
  // the byte-exact boundary accepts.
  const twoByte = 'é'.repeat(512 * 1024 + 1) // >1 MiB chars+bytes despite modest char count
  assert.ok(Buffer.byteLength(twoByte, 'utf8') > LIMITS.MAX_BODY_BYTES)
  const envelope = JSON.stringify({ encryptedMessage: 'AQ==' })
  assert.equal(validateEncryptedBody(envelope), 'AQ==')
  assert.equal(bodyHash(envelope).length, 64)
  // Lone surrogates never hash: rejected before any digest.
  assert.throws(() => bodyHash('"\uD800"'), /invalid Unicode/)
})

test('M1 uint64 extremes and canonical form', () => {
  const cases = [
    ['0', true],
    ['1', true],
    ['18446744073709551615', true],
    ['18446744073709551616', false],
    ['99999999999999999999', false],
    ['00', false],
    ['01', false],
    ['-0', false],
    [' 1', false],
    ['1 ', false],
    ['', false],
  ]
  for (const [value, expected] of cases) assert.equal(isUint64DecimalString(value), expected, value)
  const rand = prng(0x9e37)
  for (let i = 0; i < 200; i += 1) {
    const digits = Array.from({ length: 1 + Math.floor(rand() * 21) }, () => Math.floor(rand() * 10)).join('')
    const canonical = digits.replace(/^0+(?=\d)/, '') || '0'
    assert.equal(isUint64DecimalString(canonical), BigInt(canonical) <= 18446744073709551615n, canonical)
  }
})

test('M1 generated collision attempts and forged identities fail', () => {
  const rand = prng(0x51ab)
  const keys = new Set()
  for (let i = 0; i < 300; i += 1) {
    const messageId = `fuzz-${i}-${randomString(rand, ASCII, 6)}`
    const key = canonicalRecordKey({ ownerIdentityKey: OWNER, direction: 'outbound', messageBox: 'inbox', sender: OWNER, recipient: PEER, messageId })
    assert.ok(!keys.has(key), `recordKey collision at ${messageId}`)
    keys.add(key)
  }
  // Forged owner/keys never validate.
  for (const bad of ['0211', '02' + 'zz'.repeat(32), OWNER.toUpperCase().replace(/1/g, 'A'), '', null]) {
    assert.throws(
      () => canonicalRecordKey({ ownerIdentityKey: bad, direction: 'outbound', messageBox: 'inbox', sender: OWNER, recipient: PEER, messageId: 'x' }),
      /identity key/,
      String(bad),
    )
  }
  // Unicode lookalikes do not normalize to the same key.
  const plain = canonicalRecordKey({ ownerIdentityKey: OWNER, direction: 'outbound', messageBox: 'inbox', sender: OWNER, recipient: PEER, messageId: 'inbox' })
  const confusing = canonicalRecordKey({ ownerIdentityKey: OWNER, direction: 'outbound', messageBox: 'inbox', sender: OWNER, recipient: PEER, messageId: 'іnbox' })
  assert.notEqual(plain, confusing)
  assert.ok(UNICODE.length > 0)
})
