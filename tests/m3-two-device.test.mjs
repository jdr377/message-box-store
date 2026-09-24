import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PrivateKey, ProtoWallet, SessionManager } from '@bsv/sdk'
import { createMessageBoxHost } from '../src/m0-message-box-fixture.mjs'
import { createMemoryStore } from '../src/repository.mjs'
import { createPackedPackageFixture } from './helpers/packed-package.mjs'

const IDENTITY_KEY = '22'.repeat(32)
const SENDER_KEY = '11'.repeat(32)
const PEER_KEY = '33'.repeat(32)
const HISTORY_KEY = '44'.repeat(32)
const BOX = 'private-history'
const FAILURE_BOX = 'private-history-failure'

function walletFor(hex) {
  return new ProtoWallet(PrivateKey.fromHex(hex))
}

async function identityOf(wallet) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

function version(coverage) {
  return {
    epoch: coverage.epoch,
    checkpoint: coverage.checkpoint,
    generation: coverage.generation,
    continuation: coverage.continuation,
  }
}

function sameVersion(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Minimal disposable LocalReplica used only by this packed consumer proof. */
function createLocalReplica() {
  let coverage = null
  let records = new Map()
  let staging = null
  const nextGeneration = () => ((coverage === null ? 0n : BigInt(coverage.generation)) + 1n).toString()
  return {
    async readCoverage() {
      return coverage === null ? null : structuredClone(coverage)
    },
    async beginSnapshot(input) {
      if (!sameVersion(coverage === null ? null : version(coverage), input.expected)) {
        throw Object.assign(new Error('stale replica'), { code: 'ERR_REPLICA_CAS_MISMATCH' })
      }
      staging = { ref: structuredClone(input), records: new Map() }
    },
    async stageSnapshotPage(input) {
      if (staging?.ref.snapshotId !== input.snapshotId) throw new Error('snapshot is not staged')
      for (const record of input.records) staging.records.set(record.recordKey, structuredClone(record))
    },
    async discardSnapshot(input) {
      if (staging?.ref.snapshotId === input.snapshotId) staging = null
    },
    async commitSnapshot(input) {
      if (staging?.ref.snapshotId !== input.snapshotId) throw new Error('snapshot is not staged')
      if (!sameVersion(coverage === null ? null : version(coverage), staging.ref.expected)) {
        throw Object.assign(new Error('stale replica'), { code: 'ERR_REPLICA_CAS_MISMATCH' })
      }
      records = new Map(staging.records)
      coverage = {
        scope: structuredClone(input.scope),
        epoch: input.epoch,
        checkpoint: input.checkpoint,
        generation: nextGeneration(),
        continuation: null,
        complete: true,
      }
      staging = null
      return structuredClone(coverage)
    },
    async applyIncrementalPage(input) {
      if (coverage === null || !sameVersion(version(coverage), input.expected)) {
        throw Object.assign(new Error('stale replica'), { code: 'ERR_REPLICA_CAS_MISMATCH' })
      }
      const next = new Map(records)
      for (const event of input.records) {
        if ('body' in event) next.set(event.recordKey, structuredClone(event))
        else next.delete(event.recordKey)
      }
      records = next
      coverage = {
        ...coverage,
        epoch: input.epoch,
        checkpoint: input.checkpoint,
        generation: nextGeneration(),
        continuation: structuredClone(input.continuation),
      }
      return structuredClone(coverage)
    },
    inspect() {
      return [...records.values()].map((record) => structuredClone(record))
    },
  }
}

test('M3 private packed package proves the two-device encrypted-history outcomes', { timeout: 30_000 }, async (t) => {
  const packed = createPackedPackageFixture()
  t.after(() => packed.cleanup())
  assert.match(packed.require.resolve('@jdr377/message-box-store'), /node_modules[\\/]@jdr377[\\/]message-box-store[\\/]dist[\\/]mod\.cjs$/)
  const root = packed.require('@jdr377/message-box-store')
  const clientApi = packed.require('@jdr377/message-box-store/client')
  const serverApi = packed.require('@jdr377/message-box-store/server')
  for (const api of [root, clientApi]) {
    for (const name of ['syncPending', 'sendOutboundOnce', 'syncHistory', 'decryptArchivedBody']) {
      assert.equal(typeof api[name], 'function', `${name} is available from the packed public client surface`)
    }
  }
  assert.equal(typeof serverApi.createService, 'function')

  const walletA = walletFor(IDENTITY_KEY)
  const walletB = walletFor(IDENTITY_KEY)
  assert.notEqual(walletA, walletB)
  const owner = await identityOf(walletA)
  assert.equal(await identityOf(walletB), owner, 'separate devices hold the same wallet identity')
  const senderWallet = walletFor(SENDER_KEY)
  const sender = await identityOf(senderWallet)
  const peer = await identityOf(walletFor(PEER_KEY))

  const innerStore = createMemoryStore()
  let expireNextChanges = false
  const store = new Proxy(innerStore, {
    get(target, property) {
      if (property === 'listChangesPage') {
        return async (args) => {
          if (expireNextChanges) {
            expireNextChanges = false
            throw Object.assign(new Error('fixture retained-range gap'), { code: 'ERR_CURSOR_EXPIRED' })
          }
          return target.listChangesPage(args)
        }
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const service = await serverApi.createService({
    config: {
      serverSecret: 'm3-two-device-server-secret-0123456789',
      mysql: { host: '127.0.0.1', port: 3306, user: 'private-proof', password: 'not-used', database: 'private-proof' },
      retention: 'permanent',
    },
    knex: { raw: async () => [[{ ok: 1 }]], destroy: async () => {} },
    store,
    migrate: async () => ['001-init'],
    auth: { wallet: walletFor(HISTORY_KEY), sessionManager: new SessionManager() },
  })
  t.after(() => service.close())
  const server = await service.start(0, '127.0.0.1')
  const historyHost = `http://127.0.0.1:${server.address().port}`
  const historyA = new root.MessageBoxStoreClient({ walletClient: walletA, host: historyHost, allowLoopbackHttpForTests: true })
  const historyB = new root.MessageBoxStoreClient({ walletClient: walletB, host: historyHost, allowLoopbackHttpForTests: true })

  const messageHost = await createMessageBoxHost()
  t.after(() => messageHost.close())
  const messageA = root.createFreeOnlyMessageBoxClient({
    walletClient: walletA,
    host: messageHost.host,
    allowLoopbackHttpForTests: true,
  })
  const events = []
  const observedMessageA = {
    host: messageA.host,
    trustedHosts: messageA.trustedHosts,
    getIdentityKey: messageA.getIdentityKey.bind(messageA),
    listRawPage: messageA.listRawPage.bind(messageA),
    async acknowledgeMessage(input) {
      events.push('acknowledge')
      return messageA.acknowledgeMessage(input)
    },
  }
  const observedHistoryA = {
    capabilities: historyA.capabilities.bind(historyA),
    async archiveBatch(input) {
      const result = await historyA.archiveBatch(input)
      events.push('archive')
      return result
    },
  }

  const inboundText = 'hello from device-independent encrypted history'
  const inbound = await root.prepareEncryptedBody({ wallet: senderWallet, plaintext: inboundText, counterparty: owner })
  const inboundRow = { messageId: 'packed-inbound-1', sender, recipient: owner, messageBox: BOX, body: inbound.body }
  messageHost.seedMessage(inboundRow)
  const received = await root.syncPending({
    messageBoxClient: observedMessageA,
    historyClient: observedHistoryA,
    messageBoxes: [BOX],
    acknowledgeAfterArchive: true,
  })
  assert.equal(received.archived, 1)
  assert.equal(received.acknowledged, 1)
  assert.deepEqual(events, ['archive', 'acknowledge'], 'archive commit precedes transport acknowledgement')
  assert.equal(messageHost.state.records.size, 0)

  messageHost.seedMessage(inboundRow)
  const replay = await root.syncPending({
    messageBoxClient: messageA,
    historyClient: historyA,
    messageBoxes: [BOX],
    acknowledgeAfterArchive: true,
  })
  assert.equal(replay.outcomes[0].archive, 'alreadyPresent')
  assert.equal((await historyA.usage()).recordCount, 1, 'transport replay does not duplicate history')

  const failedInbound = await root.prepareEncryptedBody({ wallet: senderWallet, plaintext: 'must remain pending', counterparty: owner })
  messageHost.seedMessage({ messageId: 'packed-inbound-failure', sender, recipient: owner, messageBox: FAILURE_BOX, body: failedInbound.body })
  const outage = await root.syncPending({
    messageBoxClient: messageA,
    historyClient: {
      capabilities: historyA.capabilities.bind(historyA),
      async archiveBatch() { throw new Error('simulated private service outage') },
    },
    messageBoxes: [FAILURE_BOX],
    acknowledgeAfterArchive: true,
  })
  assert.equal(outage.incomplete, true)
  assert.equal(outage.acknowledged, 0)
  assert.ok([...messageHost.state.records.values()].some((row) => row.messageId === 'packed-inbound-failure'))

  const localB = createLocalReplica()
  const initialSync = await root.syncHistory({ owner, historyClient: historyB, localReplica: localB, maxPages: 10 })
  assert.equal(initialSync.status, 'complete')
  const inboundRecord = localB.inspect().find((record) => record.messageId === inboundRow.messageId)
  assert.ok(inboundRecord)
  assert.equal(await root.decryptArchivedBody({ wallet: walletB, body: inboundRecord.body, counterparty: sender }), inboundText)

  const outboundText = 'outbound text recovered on device B'
  const outbound = await root.sendOutboundOnce({
    wallet: walletA,
    messageBoxClient: messageA,
    historyClient: historyA,
    recipient: peer,
    messageBox: BOX,
    plaintext: outboundText,
    messageId: 'packed-outbound-1',
  })
  assert.equal(outbound.state, 'accepted')
  await root.syncHistory({ owner, historyClient: historyB, localReplica: localB, maxPages: 10 })
  const outboundRecord = localB.inspect().find((record) => record.recordKey === outbound.recordKey)
  assert.ok(outboundRecord)
  assert.equal(await root.decryptArchivedBody({ wallet: walletB, body: outboundRecord.body, counterparty: peer }), outboundText)

  const sendsBeforeUnknown = messageHost.state.requests.filter((request) => request.route === '/sendMessage').length
  messageHost.state.dropNextSendResponse = true
  const deterministicWallet = { async encrypt() { return { ciphertext: [9, 9, 9] } } }
  const unknown = await root.sendOutboundOnce({
    wallet: deterministicWallet,
    messageBoxClient: messageA,
    historyClient: historyA,
    recipient: peer,
    messageBox: BOX,
    plaintext: 'ambiguous',
    messageId: 'packed-outbound-unknown',
  })
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.attempted, true)
  const repeatedUnknown = await root.sendOutboundOnce({
    wallet: deterministicWallet,
    messageBoxClient: messageA,
    historyClient: historyA,
    recipient: peer,
    messageBox: BOX,
    plaintext: 'ambiguous',
    messageId: 'packed-outbound-unknown',
  })
  assert.equal(repeatedUnknown.attempted, false)
  assert.equal(messageHost.state.requests.filter((request) => request.route === '/sendMessage').length, sendsBeforeUnknown + 1)

  await root.syncHistory({ owner, historyClient: historyB, localReplica: localB, maxPages: 10 })
  const deletion = await historyA.deleteRecord({ recordKey: inboundRecord.recordKey, idempotencyKey: 'packed-delete-one' })
  assert.equal(deletion.deleted, true)
  expireNextChanges = true
  const snapshotRecovery = await root.syncHistory({ owner, historyClient: historyB, localReplica: localB, maxPages: 10 })
  assert.equal(snapshotRecovery.mode, 'snapshot', 'expired change history forces complete snapshot reconciliation')
  assert.ok(!localB.inspect().some((record) => record.recordKey === inboundRecord.recordKey), 'absent-row snapshot prevents body resurrection')

  const epochBeforeDeleteAll = (await historyA.capabilities()).epoch
  const deleteAll = await historyA.deleteAll({ expectedEpoch: epochBeforeDeleteAll, idempotencyKey: 'packed-delete-all' })
  assert.notEqual(deleteAll.epoch, epochBeforeDeleteAll)
  const afterDeleteAll = await root.syncHistory({ owner, historyClient: historyB, localReplica: localB, maxPages: 10 })
  assert.equal(afterDeleteAll.mode, 'snapshot')
  assert.deepEqual(localB.inspect(), [], 'delete-all epoch reset converges without cached-body resurrection')
})
