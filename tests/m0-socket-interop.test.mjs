import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MessageBoxClient } from '@bsv/message-box-client'
import { stringifyBRC100 } from '@bsv/sdk'

import {
  bodyHash,
  canonicalRecordKey,
  prepareEncryptedBody,
} from '../src/m0-envelope.mjs'
import {
  attachAuthSocketMessageBox,
} from '../src/m0-authsocket-fixture.mjs'
import {
  CountingWallet,
  createMessageBoxHost,
  listRawPage,
} from '../src/m0-message-box-fixture.mjs'

const MESSAGE_BOX = 'm0-proof-inbox'
const SENDER_KEY = '11'.repeat(32)
const RECIPIENT_KEY = '22'.repeat(32)
const DELIVERY_KEY = '33'.repeat(32)

function identity(wallet) {
  return wallet.getPublicKey({ identityKey: true }).then(({ publicKey }) => publicKey)
}

function recordKey({ owner, direction, sender, recipient, messageId }) {
  return canonicalRecordKey({
    ownerIdentityKey: owner,
    direction,
    messageBox: MESSAGE_BOX,
    sender,
    recipient,
    messageId,
  })
}

function waitForValue(timeoutMs = 5_000) {
  let resolveValue
  let rejectValue
  const promise = new Promise((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  const timeout = setTimeout(() => rejectValue(new Error('Timed out waiting for live Message Box event')), timeoutMs)
  return {
    promise: promise.finally(() => clearTimeout(timeout)),
    resolve: resolveValue,
  }
}

function closeSocketFixtureAfter(testContext, socketHost, ...clients) {
  testContext.after(async () => {
    for (const client of clients) await client.disconnectWebSocket().catch(() => {})
    await socketHost.close()
  })
}

// These direct sendLiveMessage calls characterize the upstream 2.5.1 client
// only. The message-box-store outbound policy never accepts or calls this API.
test('Upstream characterization only: live send and inbound wake-up followed by raw HTTP archival before ack', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const httpHost = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  const socketHost = attachAuthSocketMessageBox(httpHost)

  const senderIdentity = await identity(sender)
  const recipientIdentity = await identity(recipient)
  const senderClient = new MessageBoxClient({ host: httpHost.host, walletClient: sender })
  const recipientClient = new MessageBoxClient({ host: httpHost.host, walletClient: recipient })
  closeSocketFixtureAfter(testContext, socketHost, senderClient, recipientClient)
  const plaintext = { text: 'authenticated live café' }
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext, counterparty: recipientIdentity })
  const messageId = 'm0-live-prepared-1'
  const archive = new Map()
  const events = []
  const liveReceived = waitForValue()

  await recipientClient.listenForLiveMessages({
    messageBox: MESSAGE_BOX,
    onMessage: (message) => liveReceived.resolve(message),
  })
  await socketHost.waitForRoom(`${recipientIdentity}-${MESSAGE_BOX}`)

  const outboundKey = recordKey({ owner: senderIdentity, direction: 'outbound', sender: senderIdentity, recipient: recipientIdentity, messageId })
  events.push('outbound:archive')
  archive.set(outboundKey, { body: prepared.body, bodyHash: bodyHash(prepared.body) })
  const sendResult = await senderClient.sendLiveMessage({
    recipient: recipientIdentity,
    messageBox: MESSAGE_BOX,
    messageId,
    body: prepared.body,
    skipEncryption: true,
    checkPermissions: false,
  }, httpHost.host)
  events.push('live:accepted')

  assert.equal(sendResult.messageId, messageId)
  assert.equal(sender.calls.encrypt.length, 1, 'the live public send must not re-encrypt the prepared body')
  assert.equal(httpHost.state.socketRequests.length, 1)
  assert.equal(httpHost.state.socketRequests[0].message.messageId, messageId)
  assert.equal(httpHost.state.socketRequests[0].message.body, prepared.body)
  assert.equal(httpHost.state.requests.filter((request) => request.route === '/sendMessage').length, 0)
  assert.equal(archive.get(outboundKey).body, prepared.body)

  const liveMessage = await liveReceived.promise
  assert.equal(liveMessage.sender, senderIdentity)
  assert.equal(liveMessage.messageId, messageId)
  assert.equal(liveMessage.body, stringifyBRC100(plaintext), 'the public live callback exposes decrypted content')
  assert.equal(recipient.calls.decrypt.length, 1)

  const rawPage = await listRawPage(recipientClient, httpHost.host, { messageBox: MESSAGE_BOX })
  assert.equal(rawPage.messages.length, 1)
  const rawMessage = rawPage.messages[0]
  assert.equal(rawMessage.body, prepared.body, 'authenticated raw HTTP is the archive source after the live wake-up')
  events.push('inbound:archive')
  archive.set(recordKey({ owner: recipientIdentity, direction: 'inbound', sender: senderIdentity, recipient: recipientIdentity, messageId }), {
    body: rawMessage.body,
    bodyHash: bodyHash(rawMessage.body),
  })
  assert.equal(archive.size, 2)

  await recipientClient.acknowledgeMessage({ messageIds: [messageId], host: httpHost.host })
  events.push('inbound:ack')
  assert.deepEqual(events, ['outbound:archive', 'live:accepted', 'inbound:archive', 'inbound:ack'])
  assert.equal(httpHost.state.acknowledgements.length, 1)
  assert.equal((await listRawPage(recipientClient, httpHost.host, { messageBox: MESSAGE_BOX })).messages.length, 0)
})

test('Upstream hazard characterization: negative AuthSocket acknowledgement falls back through HTTP with the same ID and body', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const httpHost = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  const socketHost = attachAuthSocketMessageBox(httpHost, { behavior: 'reject' })

  const recipientIdentity = await identity(recipient)
  const senderClient = new MessageBoxClient({ host: httpHost.host, walletClient: sender })
  closeSocketFixtureAfter(testContext, socketHost, senderClient)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { fallback: true }, counterparty: recipientIdentity })
  const messageId = 'm0-live-http-fallback-1'

  const result = await senderClient.sendLiveMessage({
    recipient: recipientIdentity,
    messageBox: MESSAGE_BOX,
    messageId,
    body: prepared.body,
    skipEncryption: true,
    checkPermissions: false,
  }, httpHost.host)

  assert.equal(result.messageId, messageId)
  assert.equal(sender.calls.encrypt.length, 1)
  assert.equal(httpHost.state.socketRequests.length, 1)
  assert.equal(httpHost.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  const httpSend = httpHost.state.requests.find((request) => request.route === '/sendMessage')
  assert.equal(httpSend.payload.message.messageId, messageId)
  assert.equal(httpSend.payload.message.body, prepared.body)
  assert.equal(bodyHash([...httpHost.state.records.values()][0].body), bodyHash(prepared.body))
})

test('Upstream hazard characterization: AuthSocket fallback carries checkPermissions to the paid HTTP gate', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY, { failCreateAction: true })
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const paidQuote = { recipientFee: 3, deliveryFee: 2 }
  const httpHost = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner, quote: paidQuote })
  const socketHost = attachAuthSocketMessageBox(httpHost, { behavior: 'reject' })

  const recipientIdentity = await identity(recipient)
  const senderClient = new MessageBoxClient({ host: httpHost.host, walletClient: sender })
  closeSocketFixtureAfter(testContext, socketHost, senderClient)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { paidFallback: true }, counterparty: recipientIdentity })
  const messageId = 'm0-live-paid-fallback-1'

  await assert.rejects(senderClient.sendLiveMessage({
    recipient: recipientIdentity,
    messageBox: MESSAGE_BOX,
    messageId,
    body: prepared.body,
    skipEncryption: true,
    checkPermissions: true,
  }, httpHost.host), /Permission check failed/)

  assert.equal(sender.calls.encrypt.length, 1, 'the prepared body is not re-encrypted by the live path')
  assert.equal(httpHost.state.socketRequests.length, 1)
  assert.equal(httpHost.state.socketRequests[0].message.messageId, messageId)
  assert.equal(httpHost.state.socketRequests[0].message.body, prepared.body)
  const quoteRequest = httpHost.state.requests.find((request) => request.route === '/permissions/quote')
  assert.deepEqual(quoteRequest.query, { messageBox: MESSAGE_BOX, recipient: recipientIdentity })
  assert.equal(sender.calls.createAction, 1, 'the positive quote reaches the wallet payment boundary')
  assert.equal(httpHost.state.requests.filter((request) => request.route === '/sendMessage').length, 0, 'no message or payment is sent when wallet payment creation refuses')
  assert.equal(httpHost.state.records.size, 0)
})

test('Upstream hazard characterization: paid live timeout can reach wallet action creation after acceptance', { timeout: 20_000 }, async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY, { failCreateAction: true })
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const paidQuote = { recipientFee: 3, deliveryFee: 2 }
  const httpHost = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner, quote: paidQuote })
  const socketHost = attachAuthSocketMessageBox(httpHost, { behavior: 'dropAck' })

  const recipientIdentity = await identity(recipient)
  const senderClient = new MessageBoxClient({ host: httpHost.host, walletClient: sender })
  closeSocketFixtureAfter(testContext, socketHost, senderClient)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { paidAmbiguous: true }, counterparty: recipientIdentity })
  const messageId = 'm0-live-paid-ambiguous-1'

  await assert.rejects(senderClient.sendLiveMessage({
    recipient: recipientIdentity,
    messageBox: MESSAGE_BOX,
    messageId,
    body: prepared.body,
    skipEncryption: true,
    checkPermissions: true,
  }, httpHost.host), /Permission check failed/)

  assert.equal(sender.calls.encrypt.length, 1)
  assert.equal(httpHost.state.socketRequests.length, 1)
  assert.equal(httpHost.state.records.size, 1, 'the fixture accepted the live send before dropping its acknowledgement')
  assert.equal(httpHost.state.requests.filter((request) => request.route === '/permissions/quote').length, 1, 'the built-in HTTP fallback requests payment after its timeout')
  assert.equal(sender.calls.createAction, 1, 'the ambiguous fallback reaches wallet action creation')
  assert.equal(httpHost.state.requests.filter((request) => request.route === '/sendMessage').length, 0, 'the fixture wallet refuses before the fallback sends')
})

test('Upstream hazard characterization: lost live ack triggers HTTP fallback and leaves accepted send ambiguous', { timeout: 20_000 }, async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const httpHost = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  const socketHost = attachAuthSocketMessageBox(httpHost, { behavior: 'dropAck' })

  const recipientIdentity = await identity(recipient)
  const senderClient = new MessageBoxClient({ host: httpHost.host, walletClient: sender })
  closeSocketFixtureAfter(testContext, socketHost, senderClient)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { ambiguous: true }, counterparty: recipientIdentity })
  const messageId = 'm0-live-ambiguous-1'

  await assert.rejects(senderClient.sendLiveMessage({
    recipient: recipientIdentity,
    messageBox: MESSAGE_BOX,
    messageId,
    body: prepared.body,
    skipEncryption: true,
    checkPermissions: false,
  }, httpHost.host), /HTTP 400/)

  assert.equal(sender.calls.encrypt.length, 1)
  assert.equal(httpHost.state.socketRequests.length, 1)
  assert.equal(httpHost.state.records.size, 1, 'the live server accepted the message before the ack was lost')
  const fallbacks = httpHost.state.requests.filter((request) => request.route === '/sendMessage')
  assert.equal(fallbacks.length, 1, 'the 2.5.1 client makes one HTTP fallback after its live ack timeout')
  assert.equal(fallbacks[0].payload.message.messageId, messageId)
  assert.equal(fallbacks[0].payload.message.body, prepared.body)
  assert.equal([...httpHost.state.records.values()][0].body, prepared.body)
})
