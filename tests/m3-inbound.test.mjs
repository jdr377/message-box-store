import assert from 'node:assert/strict'
import { test } from 'node:test'

const { ProtoWallet, PrivateKey, SessionManager } = await import('@bsv/sdk')
const { createFreeOnlyMessageBoxClient } = await import('../src/free-only-transport.mjs')
const { createMessageBoxHost, CountingWallet } = await import('../src/m0-message-box-fixture.mjs')
const { prepareEncryptedBody } = await import('../src/envelope-runtime.js')
const { createMemoryStore } = await import('../src/repository.mjs')
const { MessageBoxStoreClient, syncPending } = await import('../dist/client.js')

const SENDER_KEY = '11'.repeat(32)
const RECIPIENT_KEY = '22'.repeat(32)
const DELIVERY_KEY = '33'.repeat(32)
const HISTORY_KEY = '44'.repeat(32)
const BOX = 'm3-inbound'

function walletFor(hex) {
  return new ProtoWallet(PrivateKey.fromHex(hex))
}

async function identityOf(wallet) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

async function historyHarness(t, wallet) {
  const { createService } = await import('../dist/server.js')
  const store = createMemoryStore()
  const service = await createService({
    config: {
      serverSecret: 'm3-inbound-server-secret-0123456789',
      mysql: { host: '127.0.0.1', port: 3306, user: 'm3', password: 'hidden', database: 'm3' },
      retention: 'permanent',
    },
    knex: { raw: async () => [[{ ok: 1 }]], destroy: async () => {} },
    store,
    migrate: async () => ['001-init'],
    auth: { wallet: walletFor(HISTORY_KEY), sessionManager: new SessionManager() },
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  return {
    store,
    client: new MessageBoxStoreClient({
      walletClient: wallet,
      host: `http://127.0.0.1:${server.address().port}`,
      allowLoopbackHttpForTests: true,
    }),
  }
}

async function messageHarness(t, { duplicate = false } = {}) {
  const recipient = new CountingWallet(RECIPIENT_KEY)
  const deliveryWallet = new CountingWallet(DELIVERY_KEY).inner
  const first = await createMessageBoxHost({ wallet: deliveryWallet })
  const second = duplicate ? await createMessageBoxHost({ wallet: deliveryWallet }) : null
  t.after(async () => {
    await first.close()
    if (second !== null) await second.close()
  })
  return {
    recipient,
    first,
    second,
    client: createFreeOnlyMessageBoxClient({
      walletClient: recipient,
      host: first.host,
      ...(second === null ? {} : { trustedHosts: [second.host] }),
      allowLoopbackHttpForTests: true,
    }),
  }
}

async function encryptedFixture(recipientIdentityKey, messageId) {
  const sender = new CountingWallet(SENDER_KEY)
  const senderIdentityKey = await identityOf(sender)
  const prepared = await prepareEncryptedBody({ wallet: sender, plaintext: { messageId }, counterparty: recipientIdentityKey })
  return {
    senderIdentityKey,
    prepared,
    row: { messageId, sender: senderIdentityKey, recipient: recipientIdentityKey, messageBox: BOX, body: prepared.body },
  }
}

test('M3.2 defaults to no ack and archives the exact inner ciphertext before an explicit ack cycle', async (t) => {
  const message = await messageHarness(t)
  const owner = await identityOf(message.recipient)
  const history = await historyHarness(t, message.recipient)
  const fixture = await encryptedFixture(owner, 'm3-inbound-exact')
  message.first.seedMessage({ ...fixture.row, body: JSON.stringify({ message: fixture.prepared.body }) })

  const first = await syncPending({
    messageBoxClient: message.client,
    historyClient: history.client,
    messageBoxes: [BOX],
    pageSize: 10,
    maxPages: 2,
    maxMessages: 10,
  })
  assert.equal(first.archived, 1)
  assert.equal(first.acknowledged, 0)
  assert.equal(first.outcomes[0].acknowledgement, 'disabled')
  assert.equal(message.first.state.acknowledgements.length, 0)
  const stored = (await history.client.list()).records[0]
  assert.equal(stored.body, fixture.prepared.body, 'the transport wrapper is removed without reserializing the exact inner body')

  const second = await syncPending({
    messageBoxClient: message.client,
    historyClient: history.client,
    messageBoxes: [BOX],
    acknowledgeAfterArchive: true,
    pageSize: 10,
    maxPages: 2,
    maxMessages: 10,
  })
  assert.equal(second.outcomes[0].archive, 'alreadyPresent')
  assert.equal(second.acknowledged, 1)
  assert.equal(message.first.state.records.size, 0)
})

test('M3.2 history capability outage leaves the message pending until archive-before-ack recovery', async (t) => {
  const message = await messageHarness(t)
  const owner = await identityOf(message.recipient)
  const history = await historyHarness(t, message.recipient)
  const fixture = await encryptedFixture(owner, 'm3-capability-outage')
  message.first.seedMessage(fixture.row)

  let historyAvailable = false
  const events = []
  const messageBoxClient = {
    host: message.client.host,
    trustedHosts: message.client.trustedHosts,
    getIdentityKey: () => message.client.getIdentityKey(),
    listRawPage: async (input) => {
      events.push('list')
      return await message.client.listRawPage(input)
    },
    acknowledgeMessage: async (input) => {
      events.push('acknowledge')
      return await message.client.acknowledgeMessage(input)
    },
  }
  const historyClient = {
    capabilities: async (features) => {
      if (!historyAvailable) throw new Error('history unavailable')
      return await history.client.capabilities(features)
    },
    archiveBatch: async (request) => {
      const result = await history.client.archiveBatch(request)
      events.push('archive committed')
      return result
    },
  }
  const options = { messageBoxClient, historyClient, messageBoxes: [BOX], acknowledgeAfterArchive: true }

  await assert.rejects(syncPending(options), /history unavailable/)
  assert.deepEqual(events, [], 'history readiness is checked before Message Box polling')
  assert.equal(message.first.state.records.size, 1)
  assert.equal(message.first.state.acknowledgements.length, 0)
  assert.equal((await history.client.list()).records.length, 0)

  historyAvailable = true
  const recovered = await syncPending(options)
  assert.equal(recovered.archived, 1)
  assert.equal(recovered.acknowledged, 1)
  assert.deepEqual(events.slice(0, 3), ['list', 'archive committed', 'acknowledge'])
  assert.deepEqual((await history.client.list()).records.map((record) => record.messageId), [fixture.row.messageId])
  assert.equal(message.first.state.records.size, 0)

  const again = await syncPending(options)
  assert.equal(again.messagesRead, 0)
  assert.equal(again.acknowledged, 0)
  assert.equal((await history.client.usage()).recordCount, 1)
  assert.equal(events.filter((event) => event === 'archive committed').length, 1)
  assert.equal(events.filter((event) => event === 'acknowledge').length, 1)
})

test('M3.2 accepts Message Box pages that omit the optional nextOffset field', async (t) => {
  const message = await messageHarness(t)
  const owner = await identityOf(message.recipient)
  const history = await historyHarness(t, message.recipient)
  const fixture = await encryptedFixture(owner, 'm3-no-next-offset')
  message.first.seedMessage(fixture.row)
  const client = {
    host: message.client.host,
    trustedHosts: message.client.trustedHosts,
    getIdentityKey: () => message.client.getIdentityKey(),
    acknowledgeMessage: (input) => message.client.acknowledgeMessage(input),
    async listRawPage(input) {
      const { nextOffset, ...page } = await message.client.listRawPage(input)
      return page
    },
  }
  const first = await syncPending({
    messageBoxClient: client,
    historyClient: history.client,
    messageBoxes: [BOX],
    acknowledgeAfterArchive: true,
    maxPages: 3,
    maxMessages: 3,
  })
  assert.equal(first.incomplete, false)
  assert.equal(first.acknowledged, 1)
  assert.equal((await history.client.list()).records.length, 1)
  const empty = await syncPending({
    messageBoxClient: client,
    historyClient: history.client,
    messageBoxes: [BOX],
    maxPages: 2,
    maxMessages: 1,
  })
  assert.equal(empty.incomplete, false)
  assert.equal(empty.outcomes.length, 0)
})

test('M3.2 drains from offset zero after ack and dedupes archival while acknowledging each source host', async (t) => {
  const message = await messageHarness(t, { duplicate: true })
  const owner = await identityOf(message.recipient)
  const history = await historyHarness(t, message.recipient)
  const first = await encryptedFixture(owner, 'm3-inbound-page-1')
  const second = await encryptedFixture(owner, 'm3-inbound-page-2')
  for (const host of [message.first, message.second]) host.seedMessage(first.row)
  message.first.seedMessage(second.row)

  const result = await syncPending({
    messageBoxClient: message.client,
    historyClient: history.client,
    messageBoxes: [BOX],
    acknowledgeAfterArchive: true,
    pageSize: 1,
    maxPages: 8,
    maxMessages: 8,
  })
  assert.equal(result.acknowledged, 3)
  assert.equal(result.outcomes.filter((outcome) => outcome.dedupedAcrossHosts).length, 1)
  assert.equal((await history.client.usage()).recordCount, 2)
  assert.ok(message.first.state.requests.filter((request) => request.route === '/listMessages').every((request) => request.payload.offset === 0))
  assert.ok(message.second.state.requests.filter((request) => request.route === '/listMessages').every((request) => request.payload.offset === 0))
})

test('M3.2 every archive failure or non-success outcome stays pending and stops without skipping', async (t) => {
  const cases = [
    ['conflict', { committed: false, outcomes: [{ index: 0, recordKey: null, outcome: 'conflict', errorCode: 'ERR_IMMUTABLE_CONFLICT' }] }],
    ['quota', { committed: false, outcomes: [{ index: 0, recordKey: null, outcome: 'quotaExceeded', errorCode: 'ERR_QUOTA_EXCEEDED' }] }],
    ['deleted', { committed: false, outcomes: [{ index: 0, recordKey: null, outcome: 'deleted' }] }],
    ['epoch', { committed: false, outcomes: [{ index: 0, recordKey: null, outcome: 'epochChanged', errorCode: 'ERR_EPOCH_CHANGED' }] }],
  ]
  for (const [name, response] of cases) {
    await t.test(name, async (st) => {
      const message = await messageHarness(st)
      const owner = await identityOf(message.recipient)
      const a = await encryptedFixture(owner, `m3-${name}-a`)
      const b = await encryptedFixture(owner, `m3-${name}-b`)
      message.first.seedMessage(a.row)
      message.first.seedMessage(b.row)
      let calls = 0
      const historyClient = {
        async capabilities() { return { epoch: 'gen-1' } },
        async archiveBatch() { calls += 1; return { epoch: 'gen-1', ...response } },
      }
      const result = await syncPending({
        messageBoxClient: message.client,
        historyClient,
        messageBoxes: [BOX],
        acknowledgeAfterArchive: true,
        pageSize: 1,
        maxPages: 5,
        maxMessages: 5,
      })
      assert.equal(result.incomplete, true)
      assert.equal(calls, 1, 'the blocked first row is not skipped to reach later rows')
      assert.equal(message.first.state.acknowledgements.length, 0)
      assert.equal(message.first.state.records.size, 2)
    })
  }

  await t.test('lost response', async (st) => {
    const message = await messageHarness(st)
    const owner = await identityOf(message.recipient)
    message.first.seedMessage((await encryptedFixture(owner, 'm3-lost-archive')).row)
    let calls = 0
    const result = await syncPending({
      messageBoxClient: message.client,
      historyClient: {
        async capabilities() { return { epoch: 'gen-1' } },
        async archiveBatch() { calls += 1; throw new Error('lost response with secret ciphertext') },
      },
      messageBoxes: [BOX],
      acknowledgeAfterArchive: true,
      maxPages: 2,
      maxMessages: 2,
    })
    assert.equal(result.outcomes[0].errorCode, 'ERR_UNAVAILABLE')
    assert.equal(calls, 1)
    assert.equal(message.first.state.acknowledgements.length, 0)
  })
})

test('M3.2 cancellation after archive success prevents the later acknowledgement side effect', async (t) => {
  const message = await messageHarness(t)
  const owner = await identityOf(message.recipient)
  const fixture = await encryptedFixture(owner, 'm3-cancel-after-archive')
  message.first.seedMessage(fixture.row)
  const controller = new AbortController()
  await assert.rejects(syncPending({
    messageBoxClient: message.client,
    historyClient: {
      async capabilities() { return { epoch: 'gen-1' } },
      async archiveBatch(request) {
        controller.abort()
        return {
          epoch: 'gen-1',
          committed: true,
          outcomes: [{
            index: 0,
            recordKey: request.records[0].recordKey,
            outcome: 'stored',
            bodyHash: request.records[0].bodyHash,
            bodyBytes: Buffer.byteLength(request.records[0].body, 'utf8'),
            sequence: '1',
          }],
        }
      },
    },
    messageBoxes: [BOX],
    acknowledgeAfterArchive: true,
    signal: controller.signal,
  }), (error) => error?.name === 'AbortError')
  assert.equal(message.first.state.acknowledgements.length, 0)
  assert.equal(message.first.state.records.size, 1)
})

test('M3.2 authenticated 402 on a receive host remains non-spending and incomplete', async (t) => {
  const message = await messageHarness(t)
  message.first.state.challengeNextList = true
  const result = await syncPending({
    messageBoxClient: message.client,
    historyClient: { async capabilities() { return { epoch: 'gen-1' } }, async archiveBatch() { throw new Error('must not run') } },
    messageBoxes: [BOX],
    acknowledgeAfterArchive: true,
    maxPages: 1,
    maxMessages: 1,
  })
  assert.equal(result.incomplete, true)
  assert.equal(result.outcomes[0].errorCode, 'ERR_PAID_TRANSPORT_UNSUPPORTED')
  assert.equal(message.recipient.calls.createAction, 0)
  assert.equal(message.recipient.calls.satoshisRequested, 0)
})
