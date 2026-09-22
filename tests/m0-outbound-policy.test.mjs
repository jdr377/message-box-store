import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMessageBoxHttpSendCapability,
  OUTBOUND_SEND_STATES,
  sendPreparedHttpOnce,
} from '../src/m0-outbound-http-send.mjs'
import * as outboundPolicy from '../src/m0-outbound-http-send.mjs'
import { createFreeOnlyMessageBoxClient, PaidTransportUnsupportedError } from '../src/free-only-transport.mjs'
import { isPaidTransportUnsupportedError } from '../src/free-only-transport.mjs'
import { CountingWallet, createMessageBoxHost } from '../src/m0-message-box-fixture.mjs'
import { createM0AttemptStore } from './m0-attempt-store.mjs'

// Public identity for SENDER_KEY under the pinned wallet implementation.
const OWNER_IDENTITY_KEY = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
const RECIPIENT_IDENTITY_KEY = `03${'22'.repeat(32)}`
const MESSAGE_BOX = 'm0-outbound-policy'
const MESSAGE_ID = 'm0-one-shot-1'
const BODY = JSON.stringify({ encryptedMessage: 'AQ==' })
const HOST = 'https://messagebox.example'
const SENDER_KEY = '11'.repeat(32)
const DELIVERY_KEY = '33'.repeat(32)

function input({ messageId = MESSAGE_ID, body = BODY, host = HOST, checkPermissions = false } = {}) {
  return {
    ownerIdentityKey: OWNER_IDENTITY_KEY,
    recipient: RECIPIENT_IDENTITY_KEY,
    messageBox: MESSAGE_BOX,
    messageId,
    body,
    host,
    checkPermissions,
  }
}

async function freeClientFor(testContext, { quote, sender = new CountingWallet(SENDER_KEY) } = {}) {
  const host = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner, quote })
  testContext.after(() => host.close())
  const client = createFreeOnlyMessageBoxClient({ walletClient: sender, host: host.host, allowLoopbackHttpForTests: true })
  return { client, sender, host }
}

test('M0 HTTP policy exposes an opaque capability and reserves before one application-level send invocation', async (testContext) => {
  assert.deepEqual(OUTBOUND_SEND_STATES, ['prepared', 'accepted', 'unknown', 'failed'])
  const attemptStore = createM0AttemptStore()
  const { client, host } = await freeClientFor(testContext)
  host.state.onSendMessage = () => assert.ok([...attemptStore.records.values()].some((record) => record.state === 'prepared'))
  const capability = createMessageBoxHttpSendCapability(client)
  assert.deepEqual(Reflect.ownKeys(capability), [])
  assert.equal('sendLiveMessage' in client, false)

  const result = await sendPreparedHttpOnce({
    ...input({ host: host.host }),
    httpSend: capability,
    attemptStore,
  })

  assert.equal(result.state, 'accepted')
  assert.equal(result.attempted, true)
  assert.equal(result.statePersisted, true)
  assert.equal(host.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  assert.deepEqual(host.state.paymentHeaders, [null])
  assert.deepEqual(attemptStore.transitions.map(({ state }) => state), ['prepared', 'accepted'])
  const sentMessage = host.state.requests[0].payload.message
  assert.equal(sentMessage.messageId, MESSAGE_ID)
  assert.equal(sentMessage.body, BODY)
  assert.equal(sentMessage.skipEncryption, true)
  assert.equal(sentMessage.checkPermissions, false)
})

test('M0 concurrent/repeated invocation of one record key never sends twice', async (testContext) => {
  const attemptStore = createM0AttemptStore()
  const { client, host } = await freeClientFor(testContext)
  const args = {
    ...input({ host: host.host }),
    httpSend: createMessageBoxHttpSendCapability(client),
    attemptStore,
  }

  const results = await Promise.all([
    sendPreparedHttpOnce(args),
    sendPreparedHttpOnce(args),
  ])
  const later = await sendPreparedHttpOnce(args)

  assert.equal(host.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  assert.ok(results.every((result) => ['accepted', 'unknown'].includes(result.state)))
  assert.equal(later.state, 'accepted')
  assert.equal(later.attempted, false)
  assert.equal(later.reused, true)
  assert.equal(later.statePersisted, true)
})

test('M0 refuses changed body or destination under an existing record key', async (testContext) => {
  const attemptStore = createM0AttemptStore()
  const { client, host } = await freeClientFor(testContext)
  const httpSend = createMessageBoxHttpSendCapability(client)
  const original = {
    ...input({ host: host.host }),
    httpSend,
    attemptStore,
  }
  const accepted = await sendPreparedHttpOnce(original)
  const changedBody = await sendPreparedHttpOnce({
    ...original,
    body: JSON.stringify({ encryptedMessage: 'AQI=' }),
  })
  await assert.rejects(sendPreparedHttpOnce({
    ...original, host: 'https://other-messagebox.example',
  }), /primary origin/)
  assert.equal(accepted.state, 'accepted')
  for (const result of [changedBody]) {
    assert.equal(result.state, 'failed')
    assert.equal(result.attempted, false)
    assert.equal(result.errorCode, 'ERR_IMMUTABLE_CONFLICT')
  }
  assert.equal(host.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
})

test('M0 lost HTTP response is unknown and is never retried, even when the server accepted it', async (testContext) => {
  const attemptStore = createM0AttemptStore()
  const { client, host } = await freeClientFor(testContext)
  host.state.dropNextSendResponse = true
  const args = {
    ...input({ host: host.host }),
    httpSend: createMessageBoxHttpSendCapability(client),
    attemptStore,
  }

  const first = await sendPreparedHttpOnce(args)
  const second = await sendPreparedHttpOnce(args)

  assert.equal(first.state, 'unknown')
  assert.equal(first.attempted, true)
  assert.equal(second.state, 'unknown')
  assert.equal(second.attempted, false)
  assert.equal(host.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  assert.equal(host.state.records.size, 1)
  assert.deepEqual(attemptStore.transitions.map(({ state }) => state), ['prepared', 'unknown'])
})

test('M0 recovered prepared intent is treated as unknown and never dispatched', async (testContext) => {
  const attemptStore = createM0AttemptStore()
  const { client, host } = await freeClientFor(testContext)
  const interruptedReservation = {
    ...attemptStore,
    async claimPrepared(attempt) {
      await attemptStore.claimPrepared(attempt)
      throw new Error('reservation response lost after the prepared record committed')
    },
  }
  const common = {
    ...input({ messageId: 'm0-crash-after-reserve', host: host.host }),
    httpSend: createMessageBoxHttpSendCapability(client),
  }

  const interrupted = await sendPreparedHttpOnce({ ...common, attemptStore: interruptedReservation })
  const recovered = await sendPreparedHttpOnce({ ...common, attemptStore })

  assert.equal(interrupted.state, 'failed')
  assert.equal(interrupted.attempted, false)
  assert.equal(interrupted.statePersisted, false, 'the reservation write may have committed, but the helper did not observe confirmation')
  assert.equal(recovered.state, 'unknown')
  assert.equal(recovered.attempted, false)
  assert.equal(recovered.statePersisted, true)
  assert.equal(host.state.requests.length, 0)
  assert.deepEqual(attemptStore.transitions.map(({ state }) => state), ['prepared', 'unknown'])
})

test('M0 does not claim an unrecognized stored state was persisted as unknown', async (testContext) => {
  const { client, host } = await freeClientFor(testContext)
  const attemptStore = {
    async claimPrepared(attempt) {
      return { created: false, record: { ...attempt, state: 'unrecognized' } }
    },
    async setState() {
      throw new Error('an unrecognized existing state is not rewritten by this M0 proof API')
    },
  }

  const result = await sendPreparedHttpOnce({
    ...input({ host: host.host }),
    httpSend: createMessageBoxHttpSendCapability(client),
    attemptStore,
  })

  assert.equal(result.state, 'unknown')
  assert.equal(result.attempted, false)
  assert.equal(result.statePersisted, false)
  assert.equal(host.state.requests.length, 0)
})

test('M0 paid permission requests fail before reservation or transport', async (testContext) => {
  const attemptStore = createM0AttemptStore()
  const { client, sender, host } = await freeClientFor(testContext)
  const capability = createMessageBoxHttpSendCapability(client)

  const paid = await sendPreparedHttpOnce({
    ...input({ messageId: 'm0-paid-1', host: host.host, checkPermissions: true }),
    httpSend: capability,
    attemptStore,
  })

  assert.equal(paid.state, 'failed')
  assert.equal(paid.attempted, false)
  assert.equal(paid.errorCode, 'ERR_PAID_TRANSPORT_UNSUPPORTED')
  assert.equal(paid.statePersisted, false)
  assert.equal(attemptStore.records.size, 0)
  assert.deepEqual(attemptStore.transitions, [])
  assert.equal(host.state.requests.length, 0)
  assert.equal(sender.calls.createAction, 0)
  assert.deepEqual(sender.calls.createActionOutputs, [], 'no payment outputs/satoshis were ever handed to the underlying wallet')
})

test('M0 HTTP capability is opaque and supported sends force checkPermissions false', async (testContext) => {
  const { client, sender, host } = await freeClientFor(testContext)
  const capability = createMessageBoxHttpSendCapability(client)
  const params = {
    recipient: RECIPIENT_IDENTITY_KEY,
    messageBox: MESSAGE_BOX,
    messageId: 'free-capability',
    body: BODY,
    skipEncryption: true,
  }

  assert.equal('sendMessage' in capability, false)
  assert.equal(host.state.requests.length, 0)
  assert.equal(sender.calls.createAction, 0)

  const result = await sendPreparedHttpOnce({
    ...input({ messageId: params.messageId, host: host.host }), httpSend: capability,
    attemptStore: createM0AttemptStore(),
  })
  assert.equal(result.state, 'accepted')
  assert.equal(host.state.requests.length, 1)
  assert.equal(host.state.requests[0].payload.message.checkPermissions, false)
})

test('M0 rejects malformed/plaintext envelopes before transport and records failed', async (testContext) => {
  const attemptStore = createM0AttemptStore()
  const { client, host } = await freeClientFor(testContext)
  const result = await sendPreparedHttpOnce({
    ...input({ body: JSON.stringify({ text: 'not ciphertext' }), host: host.host }),
    httpSend: createMessageBoxHttpSendCapability(client),
    attemptStore,
  })

  assert.equal(result.state, 'failed')
  assert.equal(result.attempted, false)
  assert.equal(result.statePersisted, true)
  assert.equal(result.errorCode, 'INVALID_ENCRYPTED_BODY')
  assert.equal(host.state.requests.length, 0)
  assert.equal(attemptStore.records.get(result.recordKey).state, 'failed')
})

test('M0 capability rejects clients not constructed through the guarded public factory', async () => {
  const unguardedClient = { sendMessage() {}, sendLiveMessage() {} }
  assert.throws(() => createMessageBoxHttpSendCapability(unguardedClient), /createFreeOnlyMessageBoxClient/)
})

test('M0 typed paid-transport failure requires the guard brand, not a public code lookalike', () => {
  assert.equal(isPaidTransportUnsupportedError(new PaidTransportUnsupportedError()), false)
  assert.equal(isPaidTransportUnsupportedError({ code: 'ERR_PAID_TRANSPORT_UNSUPPORTED' }), false)
  assert.equal(isPaidTransportUnsupportedError({ message: 'ERR_PAID_TRANSPORT_UNSUPPORTED' }), false)
})

test('M0 402 is typed, stops before wallet action, and does not retry the paid request', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const { client, host } = await freeClientFor(testContext, { sender })
  const attemptStore = createM0AttemptStore()
  host.state.challengeNextSend = true

  const result = await sendPreparedHttpOnce({
    ...input({ messageId: 'm0-402-no-payment', host: host.host }),
    httpSend: createMessageBoxHttpSendCapability(client),
    attemptStore,
  })

  assert.equal(result.state, 'failed')
  assert.equal(result.attempted, true)
  assert.equal(result.statePersisted, true)
  assert.equal(result.errorCode, 'ERR_PAID_TRANSPORT_UNSUPPORTED')
  assert.deepEqual(attemptStore.transitions.map(({ state }) => state), ['prepared', 'failed'])
  assert.deepEqual(host.state.paymentChallengeRequests, ['/sendMessage'])
  assert.equal(host.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  assert.deepEqual(host.state.paymentHeaders, [null])
  assert.equal(sender.calls.createAction, 0)
  assert.deepEqual(sender.calls.createActionOutputs, [], 'no payment outputs/satoshis were ever handed to the underlying wallet')
  assert.equal(sender.calls.signAction, 0)
  assert.equal(sender.calls.abortAction, 0)
  assert.equal(sender.calls.internalizeAction, 0)
  assert.ok(sender.calls.createHmac.some((args) => args?.protocolID?.[1] === 'server hmac'), 'BRC-103 authentication must retain its nonce HMAC operation')
  assert.equal(sender.calls.getPublicKey.some((args) => args?.protocolID?.[1] === '3241645161d8'), false)
  assert.ok(result.errorCode === new PaidTransportUnsupportedError().code)
})

test('M0 outbound API exposes no retry, reset, or manual recovery operation', () => {
  assert.deepEqual(Object.keys(outboundPolicy).sort(), [
    'OUTBOUND_SEND_STATES',
    'createMessageBoxHttpSendCapability',
    'sendPreparedHttpOnce',
  ])
})
