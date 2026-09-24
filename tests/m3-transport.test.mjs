import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as root from '@jdr377/message-box-store'
import * as client from '@jdr377/message-box-store/client'
import * as envelopeCompatibility from '../src/m0-envelope.mjs'
import * as envelopeRuntime from '../src/envelope-runtime.js'
import * as outboundCompatibility from '../src/m0-outbound-http-send.mjs'
import * as outboundRuntime from '../src/outbound-runtime.js'

test('M0 compatibility paths re-export the production implementations', () => {
  for (const name of [
    'bodyHash',
    'canonicalRecordKey',
    'decryptArchivedBody',
    'extractEncryptedMessage',
    'plaintextText',
    'prepareEncryptedBody',
  ]) {
    assert.equal(envelopeCompatibility[name], envelopeRuntime[name], name)
  }
  for (const name of ['createMessageBoxHttpSendCapability', 'sendPreparedHttpOnce']) {
    assert.equal(outboundCompatibility[name], outboundRuntime[name], name)
  }
})

test('root and client entries expose real browser-safe transport helpers', async () => {
  for (const entry of [root, client]) {
    for (const name of [
      'createFreeOnlyMessageBoxClient',
      'createMessageBoxHttpSendCapability',
      'decryptArchivedBody',
      'extractEncryptedMessage',
      'prepareEncryptedBody',
      'sendPreparedHttpOnce',
    ]) {
      assert.equal(typeof entry[name], 'function', name)
    }
    for (const name of [
      'AuthFetch',
      'MessageBoxClient',
      'createFreeOnlyAuthFetch',
      'createPaymentDisabledWallet',
      'getFreeOnlyMessageBoxTransport',
      'sendLiveMessage',
    ]) {
      assert.equal(Object.hasOwn(entry, name), false, name)
    }
  }

  const calls = []
  const wallet = {
    async encrypt(args) {
      calls.push(args)
      return { ciphertext: [1, 2, 3] }
    },
    async decrypt(args) {
      calls.push(args)
      return { plaintext: new TextEncoder().encode('recovered') }
    },
  }
  const counterparty = `02${'11'.repeat(32)}`
  const prepared = await root.prepareEncryptedBody({ wallet, plaintext: 'hello', counterparty })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].protocolID, [1, 'messagebox'])
  assert.equal(calls[0].keyID, '1')
  assert.equal(prepared.body, JSON.stringify({ encryptedMessage: 'AQID' }))
  assert.equal(await client.decryptArchivedBody({ wallet, body: prepared.body, counterparty }), 'recovered')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].protocolID, [1, 'messagebox'])
  assert.equal(calls[1].counterparty, counterparty)

  await assert.rejects(
    root.sendPreparedHttpOnce({ httpSend: Object.freeze({}) }),
    /createMessageBoxHttpSendCapability/,
  )
})
