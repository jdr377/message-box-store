import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractEncryptedMessage } from '../src/m0-envelope.mjs'
import { assertNoDuplicateTopLevelKeys, bodyHash, validateEncryptedBody } from '../src/protocol.mjs'

test('M1 duplicate encryptedMessage members reject without rewriting', () => {
  const dupes = [
    '{"encryptedMessage":"AQ==","encryptedMessage":"AQI="}',
    '{"encryptedMessage":"AQ==", "encryptedMessage" : "AQI=" }',
    '{"\\u0065ncryptedMessage":"AQ==","encryptedMessage":"AQI="}',
    '{"encryptedMessage":"AQ==","\\u0065ncryptedMessage":"AQI="}',
    '{ "encryptedMessage" : "AQ==" ,\n\t"encryptedMessage":"AQI="}',
  ]
  for (const body of dupes) {
    assert.throws(() => assertNoDuplicateTopLevelKeys(body), /duplicate/, body)
    assert.throws(() => validateEncryptedBody(body), /duplicate/, body)
  }
  // Accepted bodies keep exact bytes: no normalization, no rewrite.
  const accepted = ['{"encryptedMessage":"AQ=="}', '{ "encryptedMessage" : "AQ==" }']
  for (const body of accepted) {
    assertNoDuplicateTopLevelKeys(body)
    assert.equal(validateEncryptedBody(body), 'AQ==')
  }
})

test('M1 scanner agrees with JSON.parse on structure, nested dupes ignored', () => {
  // Nested duplicates cannot shadow the top-level envelope member.
  assertNoDuplicateTopLevelKeys('{"encryptedMessage":"AQ==","meta":{"a":1,"a":2}}')
  assert.throws(() => validateEncryptedBody('{"encryptedMessage":"AQ==","meta":{"a":1}}'), /exactly/)
  // Malformed input is left for JSON.parse to reject canonically.
  assert.throws(() => validateEncryptedBody('{"encryptedMessage":'), /valid JSON/)
  assert.throws(() => validateEncryptedBody('{"encryptedMessage":"AQ=="}trailing'), /valid JSON/)
  assert.throws(() => validateEncryptedBody(''), /valid JSON/)
  // Arrays and scalars are not objects.
  assert.throws(() => validateEncryptedBody('["encryptedMessage"]'), /JSON object/)
  assert.throws(() => validateEncryptedBody('42'), /JSON object/)
})

test('M1 string-valued wrapper inner duplicates reject before collapse (literal/escaped/whitespace)', () => {
  const innerDupes = [
    '{"encryptedMessage":"AQ==","encryptedMessage":"AQI="}',
    '{"encryptedMessage":"AQ==", "encryptedMessage" : "AQI=" }',
    '{"\\u0065ncryptedMessage":"AQ==","encryptedMessage":"AQI="}',
    '{"encryptedMessage":"AQ==","\\u0065ncryptedMessage":"AQI="}',
    '{ "encryptedMessage" : "AQ==" ,\n\t"encryptedMessage":"AQI="}',
  ]
  for (const inner of innerDupes) {
    const wrapper = JSON.stringify({ message: inner })
    // Direct path rejects.
    assert.throws(() => validateEncryptedBody(inner), /duplicate/, inner)
    // Wrapper path rejects with the same strictness before semantic collapse.
    assert.throws(() => extractEncryptedMessage(wrapper, { allowPaymentFreeTransportWrapper: true }), /duplicate/, wrapper)
    // Outer duplicates also reject.
    const outerDupe = `{"message":${JSON.stringify(inner)},"message":${JSON.stringify(inner)}}`
    assert.throws(() => extractEncryptedMessage(outerDupe, { allowPaymentFreeTransportWrapper: true }), /duplicate/, outerDupe)
  }
  // Wrapper carrying payment metadata is rejected so history never archives it.
  const goodInner = '{"encryptedMessage":"AQ=="}'
  assert.throws(
    () => extractEncryptedMessage(JSON.stringify({ message: goodInner, payment: { tx: [1] } }), { allowPaymentFreeTransportWrapper: true }),
    /exactly/,
  )
  // Object-valued wrapper is not the supported string form.
  assert.throws(
    () => extractEncryptedMessage(JSON.stringify({ message: { encryptedMessage: 'AQ==' } }), { allowPaymentFreeTransportWrapper: true }),
    /exactly/,
  )
  // Disabled wrapper path stays strict.
  assert.throws(() => extractEncryptedMessage(JSON.stringify({ message: goodInner }), { allowPaymentFreeTransportWrapper: false }), /exactly/)
})

test('M1 valid bodies preserve exact bytes across direct and wrapper paths', () => {
  const accepted = ['{"encryptedMessage":"AQ=="}', '{ "encryptedMessage" : "AQ==" }']
  for (const body of accepted) {
    const payload = validateEncryptedBody(body)
    assert.equal(payload, 'AQ==')
    assert.equal(bodyHash(body), bodyHash(body), 'hash is over exact bytes')
    // Wrapper preserves inner bytes: inner hash equals direct hash.
    const wrapper = JSON.stringify({ message: body })
    assert.equal(extractEncryptedMessage(wrapper, { allowPaymentFreeTransportWrapper: true }), 'AQ==')
    // Spacing changes bytes and hash: no silent normalization.
    assert.notEqual(bodyHash('{"encryptedMessage":"AQ=="}'), bodyHash('{ "encryptedMessage" : "AQ==" }'))
  }
})
