import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { PrivateKey, ProtoWallet, SessionManager } = await import('@bsv/sdk')
const {
  MessageBoxStoreClient,
  createFreeOnlyMessageBoxClient,
  decryptArchivedBody,
  sendOutboundOnce,
} = await import('../dist/client.js')
const { createMemoryStore, createSqliteStore } = await import('../src/repository.mjs')
const { createMessageBoxHost, CountingWallet } = await import('../src/m0-message-box-fixture.mjs')

const SERVER_KEY = '33'.repeat(32)
const SENDER_KEY = '11'.repeat(32)
const RECIPIENT_KEY = '22'.repeat(32)

function walletFor(hex) {
  return new ProtoWallet(PrivateKey.fromHex(hex))
}

async function identityOf(wallet) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

function config() {
  return {
    serverSecret: 'm3-outbound-server-secret-0123456789',
    mysql: { host: '127.0.0.1', port: 3306, user: 'm3', password: 'not-logged', database: 'm3' },
    retention: 'permanent',
  }
}

function fakeKnex() {
  return { raw: async () => [[{ ok: 1 }]], destroy: async () => {} }
}

async function harness(t, mode = 'normal') {
  const { createService } = await import('../dist/server.js')
  const inner = createMemoryStore()
  let archiveCalls = 0
  let patchCalls = 0
  const store = new Proxy(inner, {
    get(target, property) {
      if (property === 'archiveBatch') {
        return async (args) => {
          archiveCalls += 1
          const result = await target.archiveBatch(args)
          if (mode === 'lostArchive') throw new Error('lost archive response containing hostile remote details')
          return result
        }
      }
      if (property === 'patchState') {
        return async (args) => {
          patchCalls += 1
          const result = await target.patchState(args)
          if (mode === 'lostPatch') throw new Error('lost patch response containing hostile remote details')
          return result
        }
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const senderWallet = new CountingWallet(SENDER_KEY)
  const service = await createService({
    config: config(),
    knex: fakeKnex(),
    store,
    migrate: async () => ['001-init'],
    auth: { wallet: walletFor(SERVER_KEY), sessionManager: new SessionManager() },
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  const historyHost = `http://127.0.0.1:${server.address().port}`
  const messageBoxHost = await createMessageBoxHost()
  t.after(() => messageBoxHost.close())
  const historyClient = () => new MessageBoxStoreClient({ walletClient: senderWallet, host: historyHost, allowLoopbackHttpForTests: true })
  const messageBoxClient = () => createFreeOnlyMessageBoxClient({
    walletClient: senderWallet,
    host: messageBoxHost.host,
    allowLoopbackHttpForTests: true,
  })
  return {
    senderWallet,
    sender: await identityOf(senderWallet),
    recipient: await identityOf(walletFor(RECIPIENT_KEY)),
    historyClient,
    messageBoxClient,
    messageBoxHost,
    store: inner,
    get archiveCalls() { return archiveCalls },
    get patchCalls() { return patchCalls },
  }
}

function send(h, overrides = {}) {
  return sendOutboundOnce({
    wallet: h.senderWallet,
    messageBoxClient: h.messageBoxClient(),
    historyClient: h.historyClient(),
    recipient: h.recipient,
    messageBox: 'inbox',
    plaintext: 'hello from M3',
    messageId: 'm3-outbound-1',
    ...overrides,
  })
}

test('M3.3 simultaneous devices dispatch once and the unobserved loser never PATCHes', async (t) => {
  const h = await harness(t)
  const deterministicWallet = { async encrypt() { return { ciphertext: [1, 2, 3, 4] } } }
  const [left, right] = await Promise.all([
    send(h, { wallet: deterministicWallet }),
    send(h, { wallet: deterministicWallet }),
  ])
  assert.deepEqual([left.attempted, right.attempted].sort(), [false, true])
  const loser = left.attempted ? right : left
  assert.deepEqual(
    { state: loser.state, reused: loser.reused, statePersisted: loser.statePersisted },
    { state: 'unknown', reused: true, statePersisted: false },
  )
  assert.equal(h.messageBoxHost.state.requests.filter((request) => request.route === '/sendMessage').length, 1)
  assert.equal(h.patchCalls, 1, 'only the invocation that owns revision 1 may PATCH')
  const record = h.store.getRecord({ owner: h.sender, recordKey: left.recordKey })
  assert.equal(record.deliveryState, 'accepted')
  assert.equal(record.revision, '2')

  const repeat = await send(h, { wallet: deterministicWallet })
  assert.equal(repeat.attempted, false)
  assert.equal(repeat.state, 'unknown')
  assert.equal(h.patchCalls, 1, 'an existing accepted record is never patched or downgraded')
})

test('M3.3 lost archive response and an old explicit ID never authorize a send', async (t) => {
  const h = await harness(t, 'lostArchive')
  const first = await send(h)
  assert.equal(first.attempted, false)
  assert.equal(first.state, 'failed')
  assert.equal(first.statePersisted, false)
  assert.equal(h.messageBoxHost.state.records.size, 0)
  assert.equal(h.patchCalls, 0)
  assert.equal(h.store.getUsage({ owner: h.sender }).recordCount, 1, 'reservation may commit before its response is lost')

  const second = await send(h)
  assert.equal(second.attempted, false)
  assert.equal(h.messageBoxHost.state.records.size, 0)
  assert.equal(h.patchCalls, 0)
})

test('M3.3 ambiguous transport outcomes persist unknown once and never resend', async (t) => {
  const h = await harness(t)
  h.messageBoxHost.state.dropNextSendResponse = true
  const first = await send(h)
  assert.equal(first.attempted, true)
  assert.equal(first.state, 'unknown')
  assert.equal(first.statePersisted, true)
  assert.equal(h.messageBoxHost.state.records.size, 1)
  assert.equal(h.patchCalls, 1)

  const duplicate = await send(h)
  assert.equal(duplicate.attempted, false)
  assert.equal(duplicate.state, 'failed', 'a newly encrypted body on an old ID is an immutable conflict')
  assert.equal(h.messageBoxHost.state.records.size, 1)
  assert.equal(h.patchCalls, 1)
})

test('M3.3 duplicate transport response is ambiguous and reservation failures never send', async (t) => {
  const h = await harness(t)
  h.messageBoxHost.seedMessage({
    messageId: 'm3-transport-duplicate',
    sender: h.sender,
    recipient: h.recipient,
    messageBox: 'inbox',
    body: '{"encryptedMessage":"AQ=="}',
  })
  const duplicate = await send(h, { messageId: 'm3-transport-duplicate' })
  assert.equal(duplicate.attempted, true)
  assert.equal(duplicate.state, 'unknown')
  assert.equal(duplicate.statePersisted, true)

  const baselineRequests = h.messageBoxHost.state.requests.filter((request) => request.route === '/sendMessage').length
  for (const outcome of ['conflict', 'deleted', 'epochChanged', 'quotaExceeded', 'invalid', 'failed', 'malformed']) {
    let patchCalls = 0
    const historyClient = {
      async capabilities() { return { epoch: 'gen-1' } },
      async archiveBatch(request) {
        const input = request.records[0]
        return {
          epoch: 'gen-1',
          committed: true,
          outcomes: [{
            index: 0,
            outcome: outcome === 'malformed' ? 'stored' : outcome,
            recordKey: outcome === 'malformed' ? 'f'.repeat(64) : input.recordKey,
            bodyHash: input.bodyHash,
          }],
        }
      },
      async patchState() { patchCalls += 1; return { recordKey: 'f'.repeat(64), revision: '2', sequence: '1' } },
    }
    const result = await send(h, { historyClient, messageId: `m3-rejected-${outcome}` })
    assert.equal(result.attempted, false, outcome)
    assert.equal(result.state, 'failed', outcome)
    assert.equal(result.statePersisted, false, outcome)
    assert.equal(patchCalls, 0, outcome)
  }
  assert.equal(
    h.messageBoxHost.state.requests.filter((request) => request.route === '/sendMessage').length,
    baselineRequests,
  )
})

test('M3.3 successful send with lost PATCH response remains unknown and unpersisted to the caller', async (t) => {
  const h = await harness(t, 'lostPatch')
  const result = await send(h)
  assert.equal(result.attempted, true)
  assert.equal(result.state, 'unknown')
  assert.equal(result.statePersisted, false)
  assert.equal(result.errorCode, 'OUTCOME_PERSISTENCE_FAILED')
  assert.equal(h.messageBoxHost.state.records.size, 1)
  assert.equal(h.patchCalls, 1)
  const record = h.store.getRecord({ owner: h.sender, recordKey: result.recordKey })
  assert.equal(record.deliveryState, 'accepted', 'the server may have committed before the response was lost')
})

test('M3.3 authenticated HTTP 402 spends nothing and second-device decryption uses the recipient counterparty', async (t) => {
  const h = await harness(t)
  h.messageBoxHost.state.challengeNextSend = true
  const blocked = await send(h, { messageId: 'm3-paid-blocked' })
  assert.equal(blocked.state, 'failed')
  assert.equal(blocked.errorCode, 'ERR_PAID_TRANSPORT_UNSUPPORTED')
  assert.equal(h.senderWallet.calls.createAction, 0)
  assert.equal(h.senderWallet.calls.satoshisRequested, 0)
  assert.deepEqual(h.messageBoxHost.state.paymentChallengeRequests, ['/sendMessage'])

  const delivered = await send(h, { messageId: 'm3-decryptable', plaintext: { private: 'second device' } })
  assert.equal(delivered.state, 'accepted')
  const archived = h.store.getRecord({ owner: h.sender, recordKey: delivered.recordKey })
  const decrypted = await decryptArchivedBody({
    wallet: walletFor(RECIPIENT_KEY),
    body: archived.body,
    counterparty: h.sender,
  })
  assert.equal(decrypted, '{"private":"second device"}')
})

test('M3.3 omission creates fresh message IDs while explicit reuse cannot resend', async (t) => {
  const h = await harness(t)
  const ids = ['fresh-event-a', 'fresh-event-b']
  const first = await send(h, { messageId: undefined, createMessageId: () => ids.shift() })
  const second = await send(h, { messageId: undefined, createMessageId: () => ids.shift() })
  assert.notEqual(first.messageId, second.messageId)
  assert.equal(first.state, 'accepted')
  assert.equal(second.state, 'accepted')
  assert.equal(h.messageBoxHost.state.records.size, 2)
  const old = await send(h, { messageId: first.messageId })
  assert.equal(old.attempted, false)
  assert.equal(h.messageBoxHost.state.records.size, 2)
})

async function proveInitialRevision(store, owner, peer, messageId) {
  const response = await store.archiveBatch({
    owner,
    epoch: (await store.getUsage({ owner })).epoch,
    records: [{
      messageId,
      messageBox: 'inbox',
      direction: 'outbound',
      sender: owner,
      recipient: peer,
      body: '{"encryptedMessage":"AQ=="}',
      deliveryState: 'prepared',
    }],
  })
  assert.equal(response.outcomes[0].outcome, 'stored')
  const record = await store.getRecord({ owner, recordKey: response.outcomes[0].recordKey })
  assert.equal(record.revision, '1')
}

test('M3.3 fresh memory and SQLite reservations start at revision 1', async () => {
  const owner = `02${'41'.repeat(32)}`
  const peer = `03${'42'.repeat(32)}`
  await proveInitialRevision(createMemoryStore(), owner, peer, 'm3-revision-memory')
  await proveInitialRevision(await createSqliteStore(), owner, peer, 'm3-revision-sqlite')
})

test('M3.3 fresh MySQL reservation starts at revision 1 (gated)', {
  skip: process.env.MESSAGE_BOX_STORE_MYSQL !== '1' ? 'set MESSAGE_BOX_STORE_MYSQL=1 with MYSQL_* to run' : false,
}, async (t) => {
  const { createMysqlKnex, createMysqlStore, migrateMysql } = await import('../src/repository.mysql.mjs')
  const knex = await createMysqlKnex({
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  })
  t.after(() => knex.destroy())
  await migrateMysql(knex)
  const owner = `02${'43'.repeat(32)}`
  const peer = `03${'44'.repeat(32)}`
  await proveInitialRevision(createMysqlStore(knex), owner, peer, `m3-revision-mysql-${Date.now()}`)
})
