import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { MessageBoxStoreClient, prepareEncryptedBody } from '../dist/mod.js'

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  return 'http://127.0.0.1:' + server.address().port
}

test('the installed SDK refuses discovery and authenticated archive redirects without forwarding data', async t => {
  let sinkRequests = 0
  const sink = express()
  sink.use((_request, response) => {
    sinkRequests++
    response.json({ unexpected: true })
  })
  const sinkHost = await listen(t, sink)
  const selectedRequests = []
  const selected = express()
  selected.use(express.json())
  selected.use((request, response, next) => {
    response.once('finish', () => selectedRequests.push({ path: request.path, status: response.statusCode }))
    next()
  })
  selected.get('/v1/history/capabilities', (_request, response) => response.redirect(307, sinkHost + '/sink'))
  // An unsigned terminating edge can redirect after the successful handshake.
  selected.post('/v1/history/records', (_request, response) => response.redirect(307, sinkHost + '/sink'))
  selected.use(createAuthMiddleware({ wallet: new ProtoWallet(PrivateKey.fromRandom()), logLevel: 'error' }))
  const selectedHost = await listen(t, selected)
  const sender = new ProtoWallet(PrivateKey.fromRandom())
  const recipient = PrivateKey.fromRandom().toPublicKey().toString()
  const client = new MessageBoxStoreClient({ walletClient: sender, host: selectedHost, allowLoopbackHttpForTests: true })
  await assert.rejects(client.capabilities(), { code: 'ERR_UNAVAILABLE' })
  const { body } = await prepareEncryptedBody({ wallet: sender, counterparty: recipient, plaintext: 'Disposable redirect proof' })
  await assert.rejects(client.archiveBatch({
    epoch: 'disposable-redirect-proof',
    records: [{
      direction: 'outbound', messageBox: 'disposable-inbox',
      sender: (await sender.getPublicKey({ identityKey: true })).publicKey,
      recipient, messageId: 'redirect-proof', body, deliveryState: 'prepared',
    }],
  }), { code: 'ERR_UNAVAILABLE' })
  assert.ok(selectedRequests.some(r => r.path === '/.well-known/auth' && r.status === 200))
  assert.ok(selectedRequests.some(r => r.path === '/v1/history/records' && r.status === 307))
  assert.equal(sinkRequests, 0, 'neither identity/auth headers nor ciphertext reaches the alternate origin')
})
