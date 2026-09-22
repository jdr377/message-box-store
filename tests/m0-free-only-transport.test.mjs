import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MessageBoxClient } from '@bsv/message-box-client'

import * as publicApi from '../src/index.mjs'
import {
  createFreeOnlyMessageBoxClient,
  createMessageBoxHttpSendCapability,
  PAID_TRANSPORT_UNSUPPORTED_CODE,
  sendPreparedHttpOnce,
} from '../src/index.mjs'
import { createFreeOnlyAuthFetch, createPaymentDisabledWallet } from '../src/free-only-transport.mjs'
import { CountingWallet, createMessageBoxHost } from '../src/m0-message-box-fixture.mjs'
import { createM0AttemptStore } from './m0-attempt-store.mjs'

const SENDER_KEY = '11'.repeat(32)
const RECIPIENT_KEY = '22'.repeat(32)
const DELIVERY_KEY = '33'.repeat(32)
const MESSAGE_BOX = 'm0-free-only-transport'

function localMessageBoxClient(walletClient, host, options = {}) {
  return createFreeOnlyMessageBoxClient({
    walletClient,
    host,
    allowLoopbackHttpForTests: true,
    ...options,
  })
}

function localAuthFetch(walletClient, host) {
  return createFreeOnlyAuthFetch({ walletClient, host, allowLoopbackHttpForTests: true })
}

async function localHost(testContext) {
  const host = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  testContext.after(() => host.close())
  return host
}

test('payment-disabled WalletInterface forwards identity, auth crypto, encryption and decryption but blocks wallet actions', async () => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const senderWallet = createPaymentDisabledWallet(sender)
  const recipientWallet = createPaymentDisabledWallet(recipient)
  assert.deepEqual(Object.keys(senderWallet).sort(), [
    'abortAction',
    'acquireCertificate',
    'createAction',
    'createHmac',
    'createSignature',
    'decrypt',
    'discoverByAttributes',
    'discoverByIdentityKey',
    'encrypt',
    'getHeaderForHeight',
    'getHeight',
    'getNetwork',
    'getPublicKey',
    'getVersion',
    'internalizeAction',
    'isAuthenticated',
    'listActions',
    'listCertificates',
    'listOutputs',
    'proveCertificate',
    'relinquishCertificate',
    'relinquishOutput',
    'revealCounterpartyKeyLinkage',
    'revealSpecificKeyLinkage',
    'signAction',
    'verifyHmac',
    'verifySignature',
    'waitForAuthentication',
  ], 'the facade mirrors all public WalletInterface methods in the pinned SDK 2.7.1 baseline')
  const senderIdentityKey = (await senderWallet.getPublicKey({ identityKey: true })).publicKey
  const recipientIdentityKey = (await recipientWallet.getPublicKey({ identityKey: true })).publicKey
  const plaintext = Array.from(new TextEncoder().encode('wallet facade remains useful'))

  const encrypted = await senderWallet.encrypt({
    protocolID: [1, 'messagebox'],
    keyID: '1',
    counterparty: recipientIdentityKey,
    plaintext,
  })
  const decrypted = await recipientWallet.decrypt({
    protocolID: [1, 'messagebox'],
    keyID: '1',
    counterparty: senderIdentityKey,
    ciphertext: encrypted.ciphertext,
  })

  assert.deepEqual(decrypted.plaintext, plaintext)
  assert.equal(sender.calls.encrypt.length, 1)
  assert.equal(recipient.calls.decrypt.length, 1)
  assert.ok(sender.calls.createHmac.length === 0, 'the wallet facade does not require HMAC just to encrypt')

  for (const method of ['createAction', 'signAction', 'abortAction', 'internalizeAction']) {
    await assert.rejects(senderWallet[method]({}), (error) => error?.code === PAID_TRANSPORT_UNSUPPORTED_CODE)
  }
  assert.equal(sender.calls.createAction, 0)
  assert.equal(sender.calls.satoshisRequested, 0)
  assert.equal(sender.calls.signAction, 0)
  assert.equal(sender.calls.abortAction, 0)
  assert.equal(sender.calls.internalizeAction, 0)
})

test('HTTP 402 from raw polling, acknowledgement and a future history/capabilities request never pays or retries', async (testContext) => {
  const host = await localHost(testContext)
  const wallet = new CountingWallet(SENDER_KEY)
  const messageBoxClient = localMessageBoxClient(wallet, host.host)

  host.state.challengeNextList = true
  await assert.rejects(
    messageBoxClient.listRawPage({ messageBox: MESSAGE_BOX }),
    (error) => error?.code === PAID_TRANSPORT_UNSUPPORTED_CODE,
  )

  host.state.challengeNextAcknowledgement = true
  await assert.rejects(
    messageBoxClient.acknowledgeMessage({ messageIds: ['will-not-be-acknowledged'] }),
    (error) => error?.code === PAID_TRANSPORT_UNSUPPORTED_CODE,
  )

  const storeAuthFetch = localAuthFetch(wallet, host.host)
  const challengeUrl = new URL('/v1/history/capabilities', host.host).toString()

  await assert.rejects(storeAuthFetch.fetch('https://other.invalid/v1/history/capabilities', { method: 'GET' }), /not authorized/)
  assert.equal('authFetch' in messageBoxClient, false)
  for (const config of [
    { method: 'GET', paymentContext: { transactionBase64: 'already-made' } },
    { method: 'GET', paymentRetryAttempts: 1 },
    { method: 'GET', labels: ['brc105'] },
    { method: 'GET', headers: { 'X-BSV-Payment': 'pre-supplied' } },
    { method: 'GET', headers: new Headers({ 'X-BSV-Payment': 'pre-supplied' }) },
  ]) {
    await assert.rejects(
      storeAuthFetch.fetch(challengeUrl, config),
      (error) => error?.code === PAID_TRANSPORT_UNSUPPORTED_CODE,
    )
  }
  assert.equal(host.state.requests.filter((request) => request.route === '/v1/history/capabilities').length, 0,
    'pre-supplied payment context/header is rejected before any request')

  const mutableHeaders = {}
  const inFlightChallenge = storeAuthFetch.fetch(challengeUrl, { method: 'GET', headers: mutableHeaders })
  mutableHeaders['x-bsv-payment'] = 'late mutation must not enter the signed request'
  await assert.rejects(
    inFlightChallenge,
    (error) => error?.code === PAID_TRANSPORT_UNSUPPORTED_CODE,
  )

  await assert.rejects(
    storeAuthFetch.fetch(challengeUrl, { method: 'GET' }),
    (error) => error?.code === PAID_TRANSPORT_UNSUPPORTED_CODE && error.name === 'PaidTransportUnsupportedError',
  )

  assert.deepEqual(host.state.paymentChallengeRequests, [
    '/listMessages',
    '/acknowledgeMessage',
    '/v1/history/capabilities',
    '/v1/history/capabilities',
  ])
  assert.equal(host.state.requests.filter((request) => request.route === '/listMessages').length, 1)
  assert.equal(host.state.requests.filter((request) => request.route === '/acknowledgeMessage').length, 1)
  assert.equal(host.state.requests.filter((request) => request.route === '/v1/history/capabilities').length, 2)
  assert.deepEqual(host.state.paymentHeaders, [null, null, null, null])
  assert.equal(wallet.calls.createAction, 0)
  assert.equal(wallet.calls.satoshisRequested, 0)
  assert.equal(wallet.calls.signAction, 0)
  assert.equal(wallet.calls.abortAction, 0)
  assert.equal(wallet.calls.internalizeAction, 0)
  assert.deepEqual(wallet.calls.createActionOutputs, [])
  assert.equal(wallet.calls.createSignature > 0, true, 'ordinary authenticated requests still sign with the wallet')
  assert.equal(wallet.calls.getPublicKey.some((args) => args?.protocolID?.[1] === '3241645161d8'), false,
    'BRC-105 payment derivation key is blocked before reaching the wallet')
  assert.ok(wallet.calls.createHmac.some((args) => args?.protocolID?.[1] === 'server hmac'),
    'normal BRC-103 AuthFetch authentication still uses the shared nonce HMAC')
})

test('Message Box secondary authority is limited to exact list and acknowledgement operations', async (testContext) => {
  const hostA = await localHost(testContext)
  const hostB = await localHost(testContext)
  const wallet = new CountingWallet(SENDER_KEY)
  const primaryOnly = localMessageBoxClient(wallet, hostA.host)
  await assert.rejects(primaryOnly.listRawPage({ messageBox: MESSAGE_BOX, host: hostB.host }), /primary or an explicitly trusted origin/)
  await assert.rejects(primaryOnly.acknowledgeMessage({ messageIds: ['source-message'], host: hostB.host }), /primary or an explicitly trusted origin/)
  assert.equal(hostB.state.requests.length, 0, 'an unlisted origin is rejected before AuthFetch sends')

  const configured = localMessageBoxClient(wallet, hostA.host, { trustedHosts: [hostB.host] })
  assert.equal('authFetch' in configured, false, 'generic authenticated fetch is not exposed')
  assert.equal('sendMessage' in configured, false, 'direct outbound send is not exposed')
  hostB.seedMessage({
    messageId: 'source-message', sender: `03${'44'.repeat(32)}`,
    recipient: await configured.getIdentityKey(), messageBox: MESSAGE_BOX,
    body: JSON.stringify({ encryptedMessage: 'AQ==' }),
  })
  assert.equal((await configured.listRawPage({ messageBox: MESSAGE_BOX, host: hostB.host })).messages.length, 1)
  assert.equal(await configured.acknowledgeMessage({ messageIds: ['source-message'], host: hostB.host }), 'success')
  const capability = createMessageBoxHttpSendCapability(configured)
  const attemptStore = createM0AttemptStore()
  assert.equal('sendMessage' in capability, false)
  await assert.rejects(
    sendPreparedHttpOnce({
      ownerIdentityKey: await configured.getIdentityKey(), recipient: `03${'22'.repeat(32)}`,
      messageBox: MESSAGE_BOX, messageId: 'secondary-send-helper',
      body: JSON.stringify({ encryptedMessage: 'AQ==' }), host: hostB.host,
      httpSend: capability, attemptStore,
    }),
    /primary origin/,
  )
  assert.equal(attemptStore.records.size, 0, 'secondary outbound is rejected before reservation')
  assert.equal(hostB.state.requests.filter((request) => request.route === '/sendMessage').length, 0)
  assert.equal(wallet.calls.createAction, 0)
  assert.equal(wallet.calls.satoshisRequested, 0)
})

test('test-only HTTP origins accept only localhost, strict numeric 127/8, and IPv6 ::1', () => {
  const wallet = new CountingWallet(SENDER_KEY)
  const validHosts = [
    'http://localhost:3001',
    'http://127.0.0.0:3001',
    'http://127.0.0.1:3001',
    'http://127.255.255.255:3001',
    'http://[::1]:3001',
  ]
  for (const host of validHosts) {
    assert.doesNotThrow(() => localAuthFetch(wallet, host), host)
    assert.doesNotThrow(() => createFreeOnlyMessageBoxClient({
      walletClient: wallet,
      host,
      allowLoopbackHttpForTests: true,
    }), `Message Box facade accepts test loopback host ${host}`)
  }

  const invalidHosts = [
    'http://127.attacker.example:3001',
    'http://127.0.0.1.example:3001',
    'http://localhost.attacker.example:3001',
    'http://128.0.0.1:3001',
    'http://127.0.0.256:3001',
    'http://127.000.0.1:3001',
    'http://0177.0.0.1:3001',
    'http://0x7f000001:3001',
    'http://2130706433:3001',
    'http://user:pass@127.0.0.1:3001',
    'http://127.0.0.1:3001/base-path',
  ]
  for (const host of invalidHosts) {
    assert.throws(() => localAuthFetch(wallet, host), TypeError, host)
    assert.throws(() => createFreeOnlyMessageBoxClient({
      walletClient: wallet,
      host,
      allowLoopbackHttpForTests: true,
    }), TypeError, `Message Box facade rejects ${host}`)
  }
  assert.throws(() => createFreeOnlyAuthFetch({ walletClient: wallet, host: 'http://127.0.0.1:3001' }), /HTTPS/,
    'the HTTP loopback exception is opt-in for test construction only')
  assert.throws(() => createFreeOnlyMessageBoxClient({ walletClient: wallet, host: 'http://127.0.0.1:3001' }), /HTTPS/,
    'the Message Box facade also requires explicit test-only opt-in for loopback HTTP')
})

test('public one-shot helper rejects raw MessageBoxClient and custom senders before reservation or authenticated 402', async (testContext) => {
  const host = await localHost(testContext)
  const wallet = new CountingWallet(SENDER_KEY)
  const rawClient = new MessageBoxClient({ walletClient: wallet, host: host.host })
  const approvedClient = localMessageBoxClient(wallet, host.host)
  const approvedCapability = createMessageBoxHttpSendCapability(approvedClient)
  const backingStore = createM0AttemptStore()
  const reservations = { claimPrepared: 0, recordPreflightFailure: 0, setState: 0 }
  const attemptStore = {
    records: backingStore.records,
    transitions: backingStore.transitions,
    async claimPrepared(attempt) {
      reservations.claimPrepared += 1
      return backingStore.claimPrepared(attempt)
    },
    async recordPreflightFailure(failure) {
      reservations.recordPreflightFailure += 1
      return backingStore.recordPreflightFailure(failure)
    },
    async setState(recordKey, state) {
      reservations.setState += 1
      return backingStore.setState(recordKey, state)
    },
  }
  const customSenderCalls = { count: 0 }
  const customSender = {
    async sendMessage() {
      customSenderCalls.count += 1
      return { status: 'success', messageId: 'must-not-run' }
    },
  }
  const input = {
    ownerIdentityKey: await approvedClient.getIdentityKey(),
    recipient: `03${'22'.repeat(32)}`,
    messageBox: MESSAGE_BOX,
    messageId: 'raw-sender-402-regression',
    body: JSON.stringify({ encryptedMessage: 'AQ==' }),
    host: host.host,
    attemptStore,
  }
  host.state.challengeNextSend = true

  await assert.rejects(
    sendPreparedHttpOnce({ ...input, httpSend: rawClient }),
    /createMessageBoxHttpSendCapability/,
  )
  await assert.rejects(
    sendPreparedHttpOnce({ ...input, httpSend: customSender }),
    /createMessageBoxHttpSendCapability/,
  )

  assert.deepEqual(reservations, { claimPrepared: 0, recordPreflightFailure: 0, setState: 0 })
  assert.equal(customSenderCalls.count, 0)
  assert.equal(host.state.requests.length, 0)
  assert.deepEqual(host.state.paymentChallengeRequests, [])
  assert.equal(host.state.challengeNextSend, true, 'the authenticated 402 remains untouched because neither rejected sender ran')
  assert.equal(wallet.calls.createAction, 0)
  assert.equal(wallet.calls.satoshisRequested, 0)

  host.state.challengeNextSend = false
  const freeSend = await sendPreparedHttpOnce({ ...input, httpSend: approvedCapability })
  assert.equal(freeSend.state, 'accepted')
  assert.equal(freeSend.attempted, true)
  assert.equal(host.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  assert.deepEqual(backingStore.transitions.map(({ state }) => state), ['prepared', 'accepted'])
  assert.deepEqual(host.state.paymentHeaders, [null])
  assert.equal(wallet.calls.createAction, 0)
  assert.equal(wallet.calls.satoshisRequested, 0)
})

test('the guarded MessageBoxClient factory keeps one-shot free send and public list/ack functional', async (testContext) => {
  const host = await localHost(testContext)
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const senderClient = localMessageBoxClient(sender, host.host)
  const recipientClient = localMessageBoxClient(recipient, host.host)
  const senderIdentityKey = await senderClient.getIdentityKey()
  const recipientIdentityKey = await recipientClient.getIdentityKey()
  const plaintext = { free: true, encrypted: 'locally' }
  const encrypted = await sender.encrypt({
    protocolID: [1, 'messagebox'],
    keyID: '1',
    counterparty: recipientIdentityKey,
    plaintext: Array.from(new TextEncoder().encode(JSON.stringify(plaintext))),
  })
  const body = JSON.stringify({ encryptedMessage: Buffer.from(encrypted.ciphertext).toString('base64') })

  assert.equal('sendMessage' in senderClient, false)
  assert.equal('wallet' in senderClient, false)
  const sent = await sendPreparedHttpOnce({
    ownerIdentityKey: senderIdentityKey, recipient: recipientIdentityKey, messageBox: MESSAGE_BOX,
    messageId: 'free-facade-message', body, host: host.host,
    httpSend: createMessageBoxHttpSendCapability(senderClient), attemptStore: createM0AttemptStore(),
  })
  assert.equal(sent.state, 'accepted')
  assert.equal(host.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  assert.equal(host.state.requests.find((request) => request.route === '/sendMessage').payload.message.checkPermissions, false)

  const rawPage = await recipientClient.listRawPage({ messageBox: MESSAGE_BOX })
  assert.equal(rawPage.messages.length, 1)
  assert.equal(rawPage.messages[0].body, body)
  assert.equal(typeof rawPage.messages[0].createdAt, 'string')
  assert.equal(typeof rawPage.messages[0].updatedAt, 'string')
  const storedMessage = [...host.state.records.values()][0]
  assert.equal(rawPage.messages[0].createdAt, storedMessage.created_at,
    'the list route returns the server 1.1.42 createdAt timestamp value')
  assert.equal(rawPage.messages[0].updatedAt, storedMessage.updated_at,
    'the list route returns the server 1.1.42 updatedAt timestamp value')
  assert.equal(Number.isNaN(Date.parse(rawPage.messages[0].createdAt)), false)
  assert.equal(Number.isNaN(Date.parse(rawPage.messages[0].updatedAt)), false)
  assert.equal(Object.hasOwn(rawPage.messages[0], 'created_at'), false)
  assert.equal(Object.hasOwn(rawPage.messages[0], 'updated_at'), false)

  await assert.rejects(recipientClient.acknowledgeMessage({ messageIds: ['not-present'] }), /HTTP 400/)
  assert.equal((await recipientClient.listRawPage({ messageBox: MESSAGE_BOX })).messages.length, 1,
    'a missing ID is not acknowledged and the queued message remains available')

  // The sister package's public list method remains compatible when built
  // from the guarded WalletInterface; paid acceptance is explicitly disabled.
  const publicClient = new MessageBoxClient({ walletClient: createPaymentDisabledWallet(recipient), host: host.host })
  const listed = await publicClient.listMessages({ messageBox: MESSAGE_BOX, host: host.host, acceptPayments: false })
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0].body, plaintext)
  assert.equal(recipient.calls.internalizeAction, 0)

  assert.equal(await recipientClient.acknowledgeMessage({ messageIds: ['free-facade-message'] }), 'success')
  assert.equal(host.state.records.size, 0)
  assert.equal(host.state.requests.filter((request) => request.route === '/acknowledgeMessage').length, 2,
    'one missing-ID request is rejected and the final valid acknowledgement succeeds')
  assert.equal(host.state.paymentHeaders.every((value) => value === null), true)
  assert.equal(sender.calls.createSignature > 0, true, 'free Message Box requests still use wallet signing')
  assert.equal(recipient.calls.createSignature > 0, true, 'free Message Box requests still use wallet signing')
  assert.equal(sender.calls.satoshisRequested, 0)
  assert.equal(recipient.calls.satoshisRequested, 0)
})

test('opaque send capability binds archive owner and envelope sender to its authenticated wallet', async (testContext) => {
  const host = await localHost(testContext)
  const walletA = new CountingWallet(SENDER_KEY)
  const walletB = new CountingWallet(RECIPIENT_KEY)
  const recipient = new CountingWallet(DELIVERY_KEY)
  const clientA = localMessageBoxClient(walletA, host.host)
  const capabilityA = createMessageBoxHttpSendCapability(clientA)
  const identityA = await clientA.getIdentityKey()
  const identityB = (await walletB.getPublicKey({ identityKey: true })).publicKey
  const recipientIdentity = (await recipient.getPublicKey({ identityKey: true })).publicKey
  const backingStore = createM0AttemptStore()
  const sideEffects = { claimPrepared: 0, recordPreflightFailure: 0, setState: 0 }
  const attemptStore = {
    records: backingStore.records,
    transitions: backingStore.transitions,
    async claimPrepared(attempt) {
      sideEffects.claimPrepared += 1
      return backingStore.claimPrepared(attempt)
    },
    async recordPreflightFailure(failure) {
      sideEffects.recordPreflightFailure += 1
      return backingStore.recordPreflightFailure(failure)
    },
    async setState(recordKey, state) {
      sideEffects.setState += 1
      return backingStore.setState(recordKey, state)
    },
  }
  const common = {
    recipient: recipientIdentity,
    messageBox: MESSAGE_BOX,
    messageId: 'identity-bound-capability',
    body: JSON.stringify({ encryptedMessage: 'AQ==' }),
    host: host.host,
    httpSend: capabilityA,
    attemptStore,
  }

  await assert.rejects(
    sendPreparedHttpOnce({ ...common, ownerIdentityKey: identityB }),
    /must equal the capability wallet identity/,
  )
  assert.deepEqual(sideEffects, { claimPrepared: 0, recordPreflightFailure: 0, setState: 0 })
  assert.equal(host.state.requests.length, 0)
  assert.equal(walletA.calls.createAction, 0)
  assert.equal(walletA.calls.satoshisRequested, 0)

  const result = await sendPreparedHttpOnce({ ...common, ownerIdentityKey: identityA })
  assert.equal(result.state, 'accepted')
  const prepared = backingStore.records.get(result.recordKey)
  assert.equal(prepared.ownerIdentityKey, identityA)
  assert.equal(prepared.sender, identityA)
  const request = host.state.requests.find(({ route }) => route === '/sendMessage')
  assert.equal(request.identityKey, identityA)
  const recorded = [...host.state.records.values()][0]
  assert.equal(recorded.sender, identityA)
  assert.equal(walletA.calls.createAction, 0)
  assert.equal(walletA.calls.satoshisRequested, 0)
})

test('package legacy proof entrypoint exposes guarded factories, not upstream constructors or internal proof paths', async () => {
  const m0Exports = [
    'MESSAGEBOX_KEY_ID',
    'MESSAGEBOX_PROTOCOL',
    'OUTBOUND_SEND_STATES',
    'PAID_TRANSPORT_UNSUPPORTED_CODE',
    'PaidTransportUnsupportedError',
    'bodyHash',
    'canonicalRecordKey',
    'createFreeOnlyMessageBoxClient',
    'createMessageBoxHttpSendCapability',
    'decryptArchivedBody',
    'extractEncryptedMessage',
    'plaintextText',
    'prepareEncryptedBody',
    'sendPreparedHttpOnce',
  ]
  // M1 additive minor: shared protocol constants (no upstream constructors).
  const m1AdditiveExports = [
    'CURSOR_DOMAIN',
    'DELIVERY_STATES',
    'DIRECTIONS',
    'ERROR_CODES',
    'FEEDS',
    'JSON_SCHEMAS',
    'LIMITS',
    'M0_VECTOR',
    'PROTOCOL_VERSION',
    'RECORD_DOMAIN',
    'ROUTES',
  ]
  for (const name of m0Exports) {
    assert.equal(Object.hasOwn(publicApi, name), true, `missing M0 export ${name}`)
  }
  assert.deepEqual(Object.keys(publicApi).sort(), [...m0Exports, ...m1AdditiveExports].sort())
  for (const name of ['AuthFetch', 'MessageBoxClient', 'createAction', 'createPaidAuthFetch', 'sendLiveMessage']) {
    assert.equal(Object.hasOwn(publicApi, name), false)
  }

  await assert.rejects(
    import('message-box-store/src/free-only-transport.mjs'),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  )
})

test('typed package root exposes the browser-safe guarded transport runtime', async () => {
  const typed = await import('message-box-store')
  for (const name of [
    'bodyHash',
    'canonicalRecordKey',
    'createFreeOnlyMessageBoxClient',
    'createMessageBoxHttpSendCapability',
    'decryptArchivedBody',
    'prepareEncryptedBody',
    'sendPreparedHttpOnce',
    'PROTOCOL_VERSION',
    'RECORD_DOMAIN',
    'LIMITS',
    'ERROR_CODES',
    'ROUTES',
  ]) {
    assert.equal(Object.hasOwn(typed, name), true, `missing typed root export ${name}`)
  }
  for (const name of ['AuthFetch', 'MessageBoxClient', 'createAction', 'sendLiveMessage', 'createPaymentDisabledWallet', 'createFreeOnlyAuthFetch']) {
    assert.equal(Object.hasOwn(typed, name), false, `typed root must not expose ${name}`)
  }
})
