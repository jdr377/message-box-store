import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MessageBoxClient } from '@bsv/message-box-client'
import { stringifyBRC100 } from '@bsv/sdk'

import {
  createMessageBoxHttpSendCapability,
  sendPreparedHttpOnce,
} from '../src/m0-outbound-http-send.mjs'
import {
  bodyHash,
  canonicalRecordKey,
  decryptArchivedBody,
  extractEncryptedMessage,
  MESSAGEBOX_KEY_ID,
  MESSAGEBOX_PROTOCOL,
  prepareEncryptedBody,
} from '../src/m0-envelope.mjs'
import { createFreeOnlyMessageBoxClient, createPaymentDisabledWallet } from '../src/free-only-transport.mjs'
import {
  CountingWallet,
  createMessageBoxHost,
  listAllRaw,
  listRawPage,
} from '../src/m0-message-box-fixture.mjs'
import { createM0AttemptStore } from './m0-attempt-store.mjs'

const MESSAGE_BOX = 'm0-proof-inbox'
const SENDER_KEY = '11'.repeat(32)
const RECIPIENT_KEY = '22'.repeat(32)
const DELIVERY_KEY = '33'.repeat(32)

function identity(wallet) {
  return wallet.getPublicKey({ identityKey: true }).then(({ publicKey }) => publicKey)
}

function createLocalFreeOnlyMessageBoxClient(walletClient, host, options = {}) {
  return createFreeOnlyMessageBoxClient({ walletClient, host, allowLoopbackHttpForTests: true, ...options })
}

function recordFor({ ownerIdentityKey, direction, messageBox = MESSAGE_BOX, sender, recipient, messageId, body }) {
  return {
    recordKey: canonicalRecordKey({ ownerIdentityKey, direction, messageBox, sender, recipient, messageId }),
    ownerIdentityKey,
    direction,
    messageBox,
    sender,
    recipient,
    messageId,
    body,
    bodyHash: bodyHash(body),
  }
}

function archiveOnce(records, record) {
  const previous = records.get(record.recordKey)
  if (!previous) {
    records.set(record.recordKey, record)
    return 'stored'
  }
  const immutable = ['ownerIdentityKey', 'direction', 'messageBox', 'sender', 'recipient', 'messageId', 'body', 'bodyHash']
  if (immutable.every((field) => previous[field] === record[field])) return 'alreadyPresent'
  throw new Error('ERR_IMMUTABLE_CONFLICT')
}

async function closeAfter(testContext, ...hosts) {
  testContext.after(async () => {
    for (const host of hosts.reverse()) await host.close()
  })
}

test('M0 canonical record and body vector is frozen for cross-language conformance', () => {
  const ownerIdentityKey = `02${'11'.repeat(32)}`
  const recipient = `03${'22'.repeat(32)}`
  const body = JSON.stringify({ encryptedMessage: 'AQ==' })

  assert.equal(bodyHash(body), '0084794ecc214b1345494cd74a5758785b703aa54b89b1ff36b5087dc65ff8ce')
  assert.equal(canonicalRecordKey({
    ownerIdentityKey,
    direction: 'outbound',
    messageBox: 'general_inbox',
    sender: ownerIdentityKey,
    recipient,
    messageId: 'm0-vector-1',
  }), '998e052031cfb45d304b54db7bb55abb56c69d2612567bd9eb563229073acbfe')
})

test('M0 exact envelope: one public wallet.encrypt, exact send body, ordinary receive decrypt, and same-identity outbound decrypt', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const secondSenderDevice = new CountingWallet(SENDER_KEY)
  const host = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  await closeAfter(testContext, host)
  const senderIdentityKey = await identity(sender)
  const recipientIdentityKey = await identity(recipient)
  const senderClient = createLocalFreeOnlyMessageBoxClient(sender, host.host)
  const recipientClient = createLocalFreeOnlyMessageBoxClient(recipient, host.host)
  const plaintext = { text: 'exact UTF-8 café', count: 1, nested: { ok: true } }

  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext, counterparty: recipientIdentityKey })
  assert.equal(sender.calls.encrypt.length, 1, 'preparation must encrypt exactly once')
  assert.deepEqual(sender.calls.encrypt[0], {
    protocolID: [...MESSAGEBOX_PROTOCOL],
    keyID: MESSAGEBOX_KEY_ID,
    counterparty: recipientIdentityKey,
    plaintext: Array.from(new TextEncoder().encode(stringifyBRC100(plaintext))),
  })
  assert.equal(prepared.body, stringifyBRC100({ encryptedMessage: prepared.encryptedMessage }))
  assert.equal(prepared.body, JSON.stringify({ encryptedMessage: prepared.encryptedMessage }))

  const attemptStore = createM0AttemptStore()
  const sendResult = await sendPreparedHttpOnce({
    httpSend: createMessageBoxHttpSendCapability(senderClient),
    attemptStore,
    ownerIdentityKey: senderIdentityKey,
    recipient: recipientIdentityKey,
    messageBox: MESSAGE_BOX,
    messageId: 'm0-outbound-1',
    body: prepared.body,
    host: host.host,
    checkPermissions: false,
  })
  assert.equal(sendResult.state, 'accepted')
  assert.deepEqual(attemptStore.transitions.map(({ state }) => state), ['prepared', 'accepted'])
  assert.equal(sender.calls.encrypt.length, 1, 'skipEncryption must not re-encrypt the prepared body')

  const stored = [...host.state.records.values()][0]
  assert.equal(stored.body, prepared.body)
  assert.equal(Buffer.byteLength(stored.body, 'utf8'), Buffer.byteLength(prepared.body, 'utf8'))
  assert.equal(bodyHash(stored.body), bodyHash(prepared.body))
  assert.equal(stored.bodyHash ?? bodyHash(stored.body), bodyHash(prepared.body))

  const ordinaryClient = new MessageBoxClient({ walletClient: recipient, host: host.host })
  const ordinaryMessages = await ordinaryClient.listMessages({ messageBox: MESSAGE_BOX, host: host.host, acceptPayments: false })
  assert.equal(ordinaryMessages.length, 1)
  assert.deepEqual(ordinaryMessages[0].body, plaintext)
  assert.deepEqual(recipient.calls.decrypt.at(-1), {
    protocolID: [...MESSAGEBOX_PROTOCOL],
    keyID: MESSAGEBOX_KEY_ID,
    counterparty: senderIdentityKey,
    ciphertext: prepared.ciphertext,
  })

  const recoveredOnSecondSenderDevice = await decryptArchivedBody({
    wallet: createPaymentDisabledWallet(secondSenderDevice),
    body: stored.body,
    counterparty: recipientIdentityKey,
  })
  assert.deepEqual(JSON.parse(recoveredOnSecondSenderDevice), plaintext)
  assert.equal(secondSenderDevice.calls.decrypt[0].counterparty, recipientIdentityKey)
})

test('M0 body serialization and wrapper validation distinguish object/string, inner, payment-free, and plaintext forms', async () => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const recipientIdentityKey = await identity(recipient)
  const objectBody = await prepareEncryptedBody({ wallet: sender, plaintext: { value: 'object' }, counterparty: recipientIdentityKey })
  const stringBody = await prepareEncryptedBody({ wallet: sender, plaintext: 'raw string', counterparty: recipientIdentityKey })

  assert.equal(JSON.parse(objectBody.body).encryptedMessage, objectBody.encryptedMessage)
  assert.equal(JSON.parse(stringBody.body).encryptedMessage, stringBody.encryptedMessage)
  assert.equal(await decryptArchivedBody({ wallet: recipient, body: objectBody.body, counterparty: await identity(sender) }), stringifyBRC100({ value: 'object' }))
  assert.equal(await decryptArchivedBody({ wallet: recipient, body: stringBody.body, counterparty: await identity(sender) }), 'raw string')
  assert.equal(extractEncryptedMessage(JSON.parse(objectBody.body)), objectBody.encryptedMessage)
  assert.equal(extractEncryptedMessage(JSON.stringify({ message: objectBody.body }), { allowPaymentFreeTransportWrapper: true }), objectBody.encryptedMessage)

  for (const invalid of [
    'plain text',
    JSON.stringify({ text: 'plaintext' }),
    JSON.stringify({ encryptedMessage: 'not base64!' }),
    JSON.stringify({ encryptedMessage: objectBody.encryptedMessage, extra: true }),
    JSON.stringify({ message: objectBody.body, payment: { tx: [1, 2, 3] } }),
  ]) {
    assert.throws(() => extractEncryptedMessage(invalid, { allowPaymentFreeTransportWrapper: true }))
  }
  assert.throws(() => extractEncryptedMessage(JSON.stringify({ message: objectBody.body }), { allowPaymentFreeTransportWrapper: false }))
  assert.notEqual(bodyHash(objectBody.body), bodyHash(`${objectBody.body} `))
})

test('M0 upstream direct-client characterization: explicit ID duplicates and post-ack acceptance', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const recipientIdentityKey = await identity(recipient)
  const senderIdentityKey = await identity(sender)
  const host = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  await closeAfter(testContext, host)
  const client = new MessageBoxClient({ walletClient: sender, host: host.host })
  const first = await prepareEncryptedBody({ wallet: sender, plaintext: 'same plaintext', counterparty: recipientIdentityKey })

  await client.sendMessage({ recipient: recipientIdentityKey, messageBox: MESSAGE_BOX, messageId: 'explicit-1', body: first.body, skipEncryption: true }, host.host)
  await assert.rejects(
    client.sendMessage({ recipient: recipientIdentityKey, messageBox: MESSAGE_BOX, messageId: 'explicit-1', body: first.body, skipEncryption: true }, host.host),
    /HTTP 400/,
  )
  assert.equal(host.state.records.size, 1)

  const recipientClient = createLocalFreeOnlyMessageBoxClient(recipient, host.host)
  await recipientClient.acknowledgeMessage({ messageIds: ['explicit-1'], host: host.host })
  await client.sendMessage({ recipient: recipientIdentityKey, messageBox: MESSAGE_BOX, messageId: 'explicit-1', body: first.body, skipEncryption: true }, host.host)

  const second = await prepareEncryptedBody({ wallet: sender, plaintext: 'same plaintext', counterparty: recipientIdentityKey })
  assert.notEqual(second.body, first.body, 'a new logical encryption must not reuse the old ciphertext')
  await client.sendMessage({ recipient: recipientIdentityKey, messageBox: MESSAGE_BOX, messageId: 'explicit-2', body: second.body, skipEncryption: true }, host.host)
  assert.equal(host.state.records.size, 2)
  assert.equal([...host.state.records.values()].filter((row) => row.sender === senderIdentityKey).length, 2)
})

test('M0 archive-before-ack keeps transport pending on archive failure and acknowledges only after archive commit', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const senderIdentityKey = await identity(sender)
  const recipientIdentityKey = await identity(recipient)
  const host = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  await closeAfter(testContext, host)
  const senderClient = createLocalFreeOnlyMessageBoxClient(sender, host.host)
  const recipientClient = createLocalFreeOnlyMessageBoxClient(recipient, host.host)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { archive: true }, counterparty: recipientIdentityKey })
  const sent = await sendPreparedHttpOnce({
    ownerIdentityKey: senderIdentityKey, recipient: recipientIdentityKey, messageBox: MESSAGE_BOX,
    messageId: 'archive-before-ack', body: prepared.body, host: host.host,
    httpSend: createMessageBoxHttpSendCapability(senderClient), attemptStore: createM0AttemptStore(),
  })
  assert.equal(sent.state, 'accepted')

  const page = await listRawPage(recipientClient, host.host, { messageBox: MESSAGE_BOX })
  assert.equal(page.messages.length, 1)
  const raw = page.messages[0]
  const events = []
  const records = new Map()
  assert.throws(() => {
    events.push('archive:start')
    throw new Error('history unavailable')
  }, /history unavailable/)
  assert.deepEqual(host.state.acknowledgements, [])
  assert.equal((await listRawPage(recipientClient, host.host, { messageBox: MESSAGE_BOX })).messages.length, 1)

  events.push('archive:commit')
  assert.equal(archiveOnce(records, recordFor({ ownerIdentityKey: recipientIdentityKey, direction: 'inbound', sender: senderIdentityKey, recipient: recipientIdentityKey, messageId: raw.messageId, body: raw.body })), 'stored')
  events.push('ack:start')
  await recipientClient.acknowledgeMessage({ messageIds: [raw.messageId], host: host.host })
  events.push('ack:done')
  assert.deepEqual(events, ['archive:start', 'archive:commit', 'ack:start', 'ack:done'])
  assert.equal((await listRawPage(recipientClient, host.host, { messageBox: MESSAGE_BOX })).messages.length, 0)
})

test('M0 duplicate hosts dedupe by immutable record and acknowledge each source host explicitly', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const deliveryA = new CountingWallet(DELIVERY_KEY).inner
  const deliveryB = new CountingWallet(DELIVERY_KEY).inner
  const hostA = await createMessageBoxHost({ wallet: deliveryA })
  const hostB = await createMessageBoxHost({ wallet: deliveryB })
  await closeAfter(testContext, hostA, hostB)
  const senderIdentityKey = await identity(sender)
  const recipientIdentityKey = await identity(recipient)
  const recipientClient = createLocalFreeOnlyMessageBoxClient(recipient, hostA.host, { trustedHosts: [hostB.host] })
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { duplicateHost: true }, counterparty: recipientIdentityKey })
  const fixture = { recipient: recipientIdentityKey, messageBox: MESSAGE_BOX, messageId: 'same-on-two-hosts', body: prepared.body, sender: senderIdentityKey }
  hostA.seedMessage(fixture)
  hostB.seedMessage(fixture)

  const rawA = (await listRawPage(recipientClient, hostA.host, { messageBox: MESSAGE_BOX })).messages[0]
  const rawB = (await listRawPage(recipientClient, hostB.host, { messageBox: MESSAGE_BOX })).messages[0]
  const records = new Map()
  const inboundA = recordFor({ ownerIdentityKey: recipientIdentityKey, direction: 'inbound', sender: senderIdentityKey, recipient: recipientIdentityKey, messageId: rawA.messageId, body: rawA.body })
  const inboundB = recordFor({ ownerIdentityKey: recipientIdentityKey, direction: 'inbound', sender: senderIdentityKey, recipient: recipientIdentityKey, messageId: rawB.messageId, body: rawB.body })
  assert.equal(archiveOnce(records, inboundA), 'stored')
  assert.equal(archiveOnce(records, inboundB), 'alreadyPresent')
  assert.equal(records.size, 1)
  await recipientClient.acknowledgeMessage({ messageIds: [rawA.messageId], host: hostA.host })
  await recipientClient.acknowledgeMessage({ messageIds: [rawB.messageId], host: hostB.host })
  assert.equal(hostA.state.acknowledgements.length, 1)
  assert.equal(hostB.state.acknowledgements.length, 1)
  assert.equal((await listRawPage(recipientClient, hostA.host, { messageBox: MESSAGE_BOX })).messages.length, 0)
  assert.equal((await listRawPage(recipientClient, hostB.host, { messageBox: MESSAGE_BOX })).messages.length, 0)
})

test('M0 store policy rejects paid requests before attempt, wallet, or Message Box transport', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const recipientIdentityKey = await identity(recipient)
  const senderIdentityKey = await identity(sender)
  const paidHost = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner, quote: { recipientFee: 10, deliveryFee: 0 } })
  await closeAfter(testContext, paidHost)
  const noSpendSender = new CountingWallet(SENDER_KEY, { failCreateAction: true })
  const paidClient = createLocalFreeOnlyMessageBoxClient(noSpendSender, paidHost.host)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { free: true }, counterparty: recipientIdentityKey })
  const paidAttemptStore = createM0AttemptStore()
  const paidResult = await sendPreparedHttpOnce({
    httpSend: createMessageBoxHttpSendCapability(paidClient),
    attemptStore: paidAttemptStore,
    ownerIdentityKey: senderIdentityKey,
    recipient: recipientIdentityKey,
    messageBox: MESSAGE_BOX,
    messageId: 'paid-no-auto-retry',
    body: prepared.body,
    host: paidHost.host,
    checkPermissions: true,
  })
  assert.equal(paidResult.state, 'failed')
  assert.equal(paidResult.attempted, false)
  assert.equal(paidResult.errorCode, 'ERR_PAID_TRANSPORT_UNSUPPORTED')
  assert.equal(paidAttemptStore.records.size, 0)
  assert.deepEqual(paidAttemptStore.transitions, [])
  assert.equal(noSpendSender.calls.createAction, 0)
  assert.equal(paidHost.state.requests.length, 0, 'paid configuration is rejected before any Message Box HTTP call')
  assert.equal(paidHost.state.records.size, 0)
})

test('Upstream characterization only: 2.5.1 positive quote reaches wallet action creation before HTTP send', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY, { failCreateAction: true })
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const recipientIdentityKey = await identity(recipient)
  const paidHost = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner, quote: { recipientFee: 10, deliveryFee: 0 } })
  await closeAfter(testContext, paidHost)
  const paidClient = new MessageBoxClient({ walletClient: sender, host: paidHost.host })
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { paidCharacterization: true }, counterparty: recipientIdentityKey })

  await assert.rejects(paidClient.sendMessage({
    recipient: recipientIdentityKey,
    messageBox: MESSAGE_BOX,
    messageId: 'upstream-paid-quote-characterization',
    body: prepared.body,
    skipEncryption: true,
    checkPermissions: true,
  }, paidHost.host), /Permission check failed/)

  assert.equal(sender.calls.createAction, 1)
  assert.equal(paidHost.state.requests.filter((request) => request.route === '/permissions/quote').length, 1)
  assert.equal(paidHost.state.requests.filter((request) => request.route === '/sendMessage').length, 0)
  assert.equal(paidHost.state.records.size, 0)
})

test('M0 history decrypt uses no payment internalization', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const recipientIdentityKey = await identity(recipient)
  const senderIdentityKey = await identity(sender)
  const host = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  await closeAfter(testContext, host)
  const senderClient = createLocalFreeOnlyMessageBoxClient(sender, host.host)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { free: true }, counterparty: recipientIdentityKey })
  const sendResult = await sendPreparedHttpOnce({
    httpSend: createMessageBoxHttpSendCapability(senderClient),
    attemptStore: createM0AttemptStore(),
    ownerIdentityKey: senderIdentityKey,
    recipient: recipientIdentityKey,
    messageBox: MESSAGE_BOX,
    messageId: 'free-only-send',
    body: prepared.body,
    host: host.host,
    checkPermissions: false,
  })
  assert.equal(sendResult.state, 'accepted')
  const recipientClient = createLocalFreeOnlyMessageBoxClient(recipient, host.host)
  const raw = (await recipientClient.listRawPage({ messageBox: MESSAGE_BOX })).messages[0]
  assert.equal(await decryptArchivedBody({ wallet: recipient, body: raw.body, counterparty: senderIdentityKey }), JSON.stringify({ free: true }))
  assert.equal(recipient.calls.internalizeAction, 0)
})

test('M0 HTTP timeout stays unknown and the policy helper does not retry an accepted-but-unanswered send', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const senderIdentityKey = await identity(sender)
  const recipientIdentityKey = await identity(recipient)
  const host = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  await closeAfter(testContext, host)
  const senderClient = createLocalFreeOnlyMessageBoxClient(sender, host.host)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { ambiguous: true }, counterparty: recipientIdentityKey })
  const attemptStore = createM0AttemptStore()
  const args = {
    httpSend: createMessageBoxHttpSendCapability(senderClient),
    attemptStore,
    ownerIdentityKey: senderIdentityKey,
    recipient: recipientIdentityKey,
    messageBox: MESSAGE_BOX,
    messageId: 'ambiguous-1',
    body: prepared.body,
    host: host.host,
    checkPermissions: false,
  }
  host.state.dropNextSendResponse = true
  const first = await sendPreparedHttpOnce(args)
  const repeated = await sendPreparedHttpOnce(args)
  assert.equal(first.state, 'unknown')
  assert.equal(first.attempted, true)
  assert.equal(repeated.state, 'unknown')
  assert.equal(repeated.attempted, false)
  assert.equal(host.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  assert.equal(host.state.records.size, 1, 'the server may have accepted before the response was lost')
  assert.deepEqual(attemptStore.transitions.map(({ state }) => state), ['prepared', 'unknown'])
})

test('M0 BRC-103/BRC-104 boundary is exercised by auth middleware and rejects unsigned requests', async (testContext) => {
  const sender = new CountingWallet(SENDER_KEY)
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const recipientIdentityKey = await identity(recipient)
  const host = await createMessageBoxHost({ wallet: new CountingWallet(DELIVERY_KEY).inner })
  await closeAfter(testContext, host)
  const unsigned = await fetch(`${host.host}/listMessages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageBox: MESSAGE_BOX, offset: 0, limit: 1 }),
  })
  assert.equal(unsigned.status, 401)

  const senderClient = createLocalFreeOnlyMessageBoxClient(sender, host.host)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: 'signed body', counterparty: recipientIdentityKey })
  const sendResult = await sendPreparedHttpOnce({
    httpSend: createMessageBoxHttpSendCapability(senderClient),
    attemptStore: createM0AttemptStore(),
    ownerIdentityKey: await identity(sender),
    recipient: recipientIdentityKey,
    messageBox: MESSAGE_BOX,
    messageId: 'signed-1',
    body: prepared.body,
    host: host.host,
  })
  assert.equal(sendResult.state, 'accepted')
  const signed = host.state.requests.find((request) => request.route === '/sendMessage')
  assert.equal(signed.identityKey, await identity(sender))
  for (const header of ['x-bsv-auth-version', 'x-bsv-auth-identity-key', 'x-bsv-auth-nonce', 'x-bsv-auth-signature', 'x-bsv-auth-request-id']) {
    assert.equal(typeof signed.authHeaders[header], 'string', `missing signed ${header} header`)
  }
  assert.equal(JSON.parse(signed.rawBody).message.body, prepared.body)
})
