import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { ProtoWallet, PrivateKey, SessionManager } = await import('@bsv/sdk')
const { MessageBoxStoreClient } = await import('../dist/client.js')
const { createMemoryStore } = await import('../src/repository.mjs')
const { createMessageBoxHost, CountingWallet } = await import('../src/m0-message-box-fixture.mjs')

const SERVER_KEY = '33'.repeat(32)
const CLIENT_KEY = '11'.repeat(32)
const OTHER_KEY = '22'.repeat(32)
const BODY = '{"encryptedMessage":"AQ=="}'

function walletFor(hex) {
  return new ProtoWallet(PrivateKey.fromHex(hex))
}

async function identityOf(wallet) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

function config() {
  return {
    serverSecret: 'm3-client-server-secret-0123456789',
    mysql: { host: '127.0.0.1', port: 3306, user: 'm3', password: 'not-logged', database: 'm3' },
    retention: 'permanent',
  }
}

function fakeKnex() {
  return { raw: async () => [[{ ok: 1 }]], destroy: async () => {} }
}

async function harness(t, archiveMode = 'normal') {
  const { createService } = await import('../dist/server.js')
  const inner = createMemoryStore()
  let archiveCalls = 0
  const store = new Proxy(inner, {
    get(target, property) {
      if (property === 'archiveBatch') {
        return async (args) => {
          archiveCalls += 1
          if (archiveMode === 'malformed') {
            return { epoch: args.epoch, committed: true, outcomes: [{ index: 0, outcome: 'stored', recordKey: 'remote-secret-malformed-key' }] }
          }
          const result = await target.archiveBatch(args)
          if (archiveMode === 'lost') throw new Error('hostile lost response with ciphertext and credentials')
          return result
        }
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const wallet = walletFor(CLIENT_KEY)
  const service = await createService({
    config: config(),
    knex: fakeKnex(),
    store,
    migrate: async () => ['001-init'],
    auth: { wallet: walletFor(SERVER_KEY), sessionManager: new SessionManager() },
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  const host = `http://127.0.0.1:${server.address().port}`
  return {
    client: new MessageBoxStoreClient({ walletClient: wallet, host, allowLoopbackHttpForTests: true }),
    owner: await identityOf(wallet),
    peer: await identityOf(walletFor(OTHER_KEY)),
    store: inner,
    get archiveCalls() { return archiveCalls },
  }
}

function outbound(owner, peer, messageId) {
  return { messageId, messageBox: 'inbox', direction: 'outbound', sender: owner, recipient: peer, body: BODY }
}

test('M3.5 client calls every authenticated history operation with explicit epochs and mutation guards', async (t) => {
  const h = await harness(t)
  const capabilities = await h.client.capabilities()
  assert.equal(capabilities.protocolVersion, '1')
  assert.equal(capabilities.epoch, 'gen-1')

  const archived = await h.client.archiveBatch({ epoch: capabilities.epoch, records: [outbound(h.owner, h.peer, 'm3-client-1')] })
  assert.equal(archived.committed, true)
  assert.equal(archived.outcomes[0].outcome, 'stored')
  const recordKey = archived.outcomes[0].recordKey

  const browse = await h.client.list({ direction: 'outbound', messageBox: 'inbox', limit: 1 })
  assert.equal(browse.records.length, 1)
  assert.equal(browse.records[0].recordKey, recordKey)

  const snapshot = await h.client.createSnapshot({ direction: 'outbound' })
  const snapshotPage = await h.client.listSnapshotPage({ snapshotId: snapshot.snapshotId, limit: 1 })
  assert.equal(snapshotPage.records.length, 1)
  const changes = await h.client.listChanges({ direction: 'outbound', limit: 1 })
  assert.equal(changes.records.length, 1)

  const patched = await h.client.patchState({
    recordKey,
    newState: 'accepted',
    expectedRevision: '1',
    idempotencyKey: 'm3-client-patch-1',
  })
  assert.equal(patched.recordKey, recordKey)
  assert.equal(patched.revision, '2')

  const usage = await h.client.usage()
  assert.equal(usage.recordCount, 1)
  const deleted = await h.client.deleteRecord({ recordKey, idempotencyKey: 'm3-client-delete-1' })
  assert.equal(deleted.deleted, true)

  const second = await h.client.archiveBatch({ epoch: deleted.epoch, records: [outbound(h.owner, h.peer, 'm3-client-2')] })
  assert.equal(second.outcomes[0].outcome, 'stored')
  const purged = await h.client.deleteAll({ expectedEpoch: deleted.epoch, idempotencyKey: 'm3-client-delete-all-1' })
  assert.notEqual(purged.epoch, deleted.epoch)
  assert.equal((await h.client.usage()).recordCount, 0)
  assert.equal(h.archiveCalls, 2, 'the client performs exactly one request per archive call')
})

test('M3.5 malformed and lost archive responses remain unconfirmed and are never retried', async (t) => {
  await t.test('malformed success', async (st) => {
    const h = await harness(st, 'malformed')
    await assert.rejects(
      h.client.archiveBatch({ epoch: 'gen-1', records: [outbound(h.owner, h.peer, 'm3-malformed')] }),
      (error) => error?.code === 'ERR_INTERNAL' && !error.message.includes('remote-secret-malformed-key'),
    )
    assert.equal(h.archiveCalls, 1)
    assert.equal((await h.store.getUsage({ owner: h.owner })).recordCount, 0)
  })

  await t.test('committed mutation with lost response', async (st) => {
    const h = await harness(st, 'lost')
    await assert.rejects(
      h.client.archiveBatch({ epoch: 'gen-1', records: [outbound(h.owner, h.peer, 'm3-lost')] }),
      (error) => error?.code === 'ERR_UNAVAILABLE' && !error.message.includes('ciphertext'),
    )
    assert.equal(h.archiveCalls, 1, 'an ambiguous mutation is not retried')
    assert.equal((await h.store.getUsage({ owner: h.owner })).recordCount, 1, 'the test proves commit can precede a lost response')
  })
})

test('M3.5 client keeps host authority explicit and refuses authenticated 402 payment', async (t) => {
  const wallet = new CountingWallet(CLIENT_KEY)
  assert.throws(() => new MessageBoxStoreClient({ walletClient: wallet, host: 'http://history.example' }), /HTTPS/)
  assert.throws(() => new MessageBoxStoreClient({ walletClient: wallet, host: 'http://127.0.0.01:3000', allowLoopbackHttpForTests: true }), /HTTPS/)

  const paidHost = await createMessageBoxHost()
  t.after(() => paidHost.close())
  const client = new MessageBoxStoreClient({ walletClient: wallet, host: paidHost.host, allowLoopbackHttpForTests: true })
  await assert.rejects(client.capabilities(), (error) => error?.code === 'ERR_PAID_TRANSPORT_UNSUPPORTED')
  assert.equal(wallet.calls.createAction, 0)
  assert.equal(wallet.calls.satoshisRequested, 0)
  assert.deepEqual(paidHost.state.paymentChallengeRequests, ['/v1/history/capabilities'])
  assert.deepEqual(paidHost.state.paymentHeaders, [null])
})
