import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { stringifyBRC100, ProtoWallet, PrivateKey } from '@bsv/sdk'

import { bodyHash } from './m0-envelope.mjs'

/**
 * A small real HTTP Message Box fixture. It uses the public auth middleware
 * and the same route/body shapes used by MessageBoxClient 2.5.1. No client
 * fetch method is replaced or intercepted.
 */
export async function createMessageBoxHost({ wallet, quote = { recipientFee: 0, deliveryFee: 0 } } = {}) {
  const deliveryWallet = wallet ?? new ProtoWallet(PrivateKey.fromHex('33'.repeat(32)))
  const identityKey = (await deliveryWallet.getPublicKey({ identityKey: true })).publicKey
  const app = express()
  const state = {
    records: new Map(),
    requests: [],
    socketRequests: [],
    acknowledgements: [],
    permissions: new Map(),
    quote,
    dropNextSendResponse: false,
    challengeNextSend: false,
    challengeNextList: false,
    challengeNextAcknowledgement: false,
    paymentChallengeRequests: [],
    paymentHeaders: [],
    onSendMessage: undefined,
  }

  app.use(express.json({
    limit: '2mb',
    verify(request, _response, buffer) {
      request.rawBody = Buffer.from(buffer)
    },
  }))
  app.use(createAuthMiddleware({ wallet: deliveryWallet, logLevel: 'error' }))

  app.post('/sendMessage', (request, response) => {
    const identityKey = request.auth?.identityKey
    const payload = request.body
    const message = payload?.message
    state.requests.push({
      route: '/sendMessage',
      identityKey,
      authHeaders: pickAuthHeaders(request.headers),
      rawBody: request.rawBody?.toString('utf8'),
      payload,
    })
    state.paymentHeaders.push(request.headers['x-bsv-payment'] ?? null)
    state.onSendMessage?.(request)
    if (state.challengeNextSend) {
      state.challengeNextSend = false
      state.paymentChallengeRequests.push('/sendMessage')
      return respondPaymentRequired(response, identityKey)
    }
    if (!message || typeof message !== 'object' || typeof message.messageId !== 'string' || typeof message.recipient !== 'string' || typeof message.messageBox !== 'string' || typeof message.body !== 'string') {
      return response.status(400).json({ status: 'error', description: 'invalid message' })
    }
    const key = `${message.recipient}\u0000${message.messageBox}\u0000${message.messageId}`
    const existing = state.records.get(key)
    if (existing) {
      return response.status(400).json({ status: 'error', description: 'ERR_DUPLICATE_MESSAGE' })
    }
    const now = new Date().toISOString()
    state.records.set(key, {
      messageId: message.messageId,
      sender: identityKey,
      recipient: message.recipient,
      messageBox: message.messageBox,
      body: message.body,
      bodyHash: bodyHash(message.body),
      payment: payload?.payment,
      created_at: now,
      updated_at: now,
    })
    if (state.dropNextSendResponse) {
      state.dropNextSendResponse = false
      request.socket.destroy()
      return undefined
    }
    return response.json({ status: 'success', messageId: message.messageId })
  })

  app.post('/listMessages', (request, response) => {
    const identityKey = request.auth?.identityKey
    const messageBox = request.body?.messageBox
    const offset = Number.isSafeInteger(request.body?.offset) ? request.body.offset : 0
    const limit = Number.isSafeInteger(request.body?.limit) && request.body.limit > 0 ? request.body.limit : 1000
    state.requests.push({ route: '/listMessages', identityKey, authHeaders: pickAuthHeaders(request.headers), rawBody: request.rawBody?.toString('utf8'), payload: request.body })
    state.paymentHeaders.push(request.headers['x-bsv-payment'] ?? null)
    if (state.challengeNextList) {
      state.challengeNextList = false
      state.paymentChallengeRequests.push('/listMessages')
      return respondPaymentRequired(response, identityKey)
    }
    const rows = [...state.records.values()]
      .filter((row) => row.recipient === identityKey && row.messageBox === messageBox)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.messageId.localeCompare(right.messageId))
    const messages = rows.slice(offset, offset + limit).map(({ messageId, sender, body, created_at, updated_at }) => ({
      messageId,
      sender,
      body,
      createdAt: created_at,
      updatedAt: updated_at,
    }))
    return response.json({ status: 'success', messages, limit, offset, nextOffset: offset + messages.length, hasMore: offset + messages.length < rows.length })
  })

  app.post('/acknowledgeMessage', (request, response) => {
    const identityKey = request.auth?.identityKey
    const messageIds = request.body?.messageIds
    state.requests.push({ route: '/acknowledgeMessage', identityKey, authHeaders: pickAuthHeaders(request.headers), rawBody: request.rawBody?.toString('utf8'), payload: request.body })
    state.paymentHeaders.push(request.headers['x-bsv-payment'] ?? null)
    state.acknowledgements.push({ identityKey, messageIds, host: request.headers.host, authHeaders: pickAuthHeaders(request.headers) })
    if (state.challengeNextAcknowledgement) {
      state.challengeNextAcknowledgement = false
      state.paymentChallengeRequests.push('/acknowledgeMessage')
      return respondPaymentRequired(response, identityKey)
    }
    if (messageIds == null || (Array.isArray(messageIds) && messageIds.length === 0)) {
      return response.status(400).json({
        status: 'error',
        code: 'ERR_MESSAGE_ID_REQUIRED',
        description: 'Please provide the ID of the message(s) to acknowledge!',
      })
    }
    if (
      !Array.isArray(messageIds) ||
      messageIds.length > 1_000 ||
      messageIds.some((value) => typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > 256)
    ) {
      return response.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_MESSAGE_ID',
        description: 'Message IDs must be a non-empty array of non-empty strings no longer than 256 bytes each.',
      })
    }

    const uniqueMessageIds = [...new Set(messageIds)]
    let deleted = 0
    for (const [key, row] of state.records) {
      if (row.recipient === identityKey && uniqueMessageIds.includes(row.messageId)) {
        state.records.delete(key)
        deleted += 1
      }
    }
    if (deleted === 0) {
      return response.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_ACKNOWLEDGMENT',
        description: 'Message not found!',
      })
    }
    return response.json({ status: 'success' })
  })

  app.get('/permissions/quote', (request, response) => {
    state.requests.push({ route: '/permissions/quote', identityKey: request.auth?.identityKey, authHeaders: pickAuthHeaders(request.headers), query: { ...request.query } })
    return response.json({ status: 'success', quote: state.quote })
  })
  app.get('/permissions/get', (request, response) => {
    const key = `${request.auth?.identityKey}\u0000${request.query.messageBox}\u0000${request.query.sender ?? ''}`
    return response.json({ status: 'success', permission: state.permissions.get(key) ?? null })
  })
  app.post('/permissions/set', (request, response) => {
    const key = `${request.auth?.identityKey}\u0000${request.body?.messageBox}\u0000${request.body?.sender ?? ''}`
    state.permissions.set(key, request.body)
    return response.json({ status: 'success' })
  })

  const challengePayment = (request, response, route) => {
    state.requests.push({ route, identityKey: request.auth?.identityKey, authHeaders: pickAuthHeaders(request.headers), rawBody: request.rawBody?.toString('utf8'), payload: request.body })
    state.paymentHeaders.push(request.headers['x-bsv-payment'] ?? null)
    state.paymentChallengeRequests.push(route)
    return respondPaymentRequired(response, identityKey)
  }

  app.all('/__test__/brc105-402', (request, response) => challengePayment(request, response, '/__test__/brc105-402'))
  // Test-only future-service route shape; no production store route is implemented in M0.
  app.get('/v1/history/capabilities', (request, response) => challengePayment(request, response, '/v1/history/capabilities'))

  const server = await listenOnFetchAllowedPort(app)
  const address = server.address()
  const host = `http://127.0.0.1:${address.port}`
  return {
    app,
    server,
    host,
    identityKey,
    state,
    seedMessage({ messageId, sender, recipient, messageBox, body, createdAt = new Date().toISOString(), updatedAt = createdAt }) {
      state.records.set(`${recipient}\u0000${messageBox}\u0000${messageId}`, {
        messageId, sender, recipient, messageBox, body, bodyHash: bodyHash(body), payment: undefined,
        created_at: createdAt, updated_at: updatedAt,
      })
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function respondPaymentRequired(response, identityKey) {
  return response
    .set('x-bsv-payment-version', '1.0')
    .set('x-bsv-payment-satoshis-required', '1')
    .set('x-bsv-payment-derivation-prefix', 'm0-test-prefix')
    .set('x-bsv-auth-identity-key', identityKey)
    .status(402)
    .json({ status: 'error', code: 'PAYMENT_REQUIRED' })
}

async function listenOnFetchAllowedPort(app) {
  // Undici follows the Fetch forbidden-port list (which includes 1723).
  // Random OS ephemeral ports can land there on Windows, yielding a confusing
  // "bad port" instead of exercising the local Message Box fixture.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const port = 30_000 + Math.floor(Math.random() * 30_000)
    const server = app.listen(port, '127.0.0.1')
    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      return server
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error('Could not bind the local Message Box fixture to an available fetch-compatible port')
}

function pickAuthHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase().startsWith('x-bsv-auth-')))
}

/** Read a raw page through the MessageBoxClient's public AuthFetch property. */
export async function listRawPage(client, host, { messageBox, offset = 0, limit = 100 } = {}) {
  if (typeof client?.listRawPage === 'function') {
    return client.listRawPage({ messageBox, offset, limit, host })
  }
  const response = await client.authFetch.fetch(new URL('/listMessages', host).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stringifyBRC100({ messageBox, offset, limit }),
  })
  const data = await response.json()
  if (!response.ok || data.status !== 'success') throw new Error(`Message Box list failed: HTTP ${response.status}`)
  return data
}

export async function listAllRaw(client, host, messageBox, limit = 100) {
  const pages = []
  let offset = 0
  while (true) {
    const page = await listRawPage(client, host, { messageBox, offset, limit })
    pages.push(page)
    if (!page.hasMore) return pages
    if (page.nextOffset !== offset + page.messages.length || page.messages.length === 0) throw new Error('Message Box page offsets are not contiguous')
    offset = page.nextOffset
  }
}

/** A delegating fixture wallet with public-call counters, not a client patch. */
export class CountingWallet {
  constructor(privateKeyHex, { failCreateAction = false } = {}) {
    this.inner = new ProtoWallet(PrivateKey.fromHex(privateKeyHex))
    this.calls = {
      encrypt: [],
      decrypt: [],
      getPublicKey: [],
      createAction: 0,
      createActionOutputs: [],
      satoshisRequested: 0,
      signAction: 0,
      createSignature: 0,
      abortAction: 0,
      internalizeAction: 0,
      createHmac: [],
    }
    this.failCreateAction = failCreateAction
    return new Proxy(this, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
        const value = Reflect.get(target.inner, property, target.inner)
        return typeof value === 'function' ? value.bind(target.inner) : value
      },
    })
  }

  getPublicKey(args, ...rest) { this.calls.getPublicKey.push(args); return this.inner.getPublicKey(args, ...rest) }
  createSignature(...args) { this.calls.createSignature += 1; return this.inner.createSignature(...args) }
  verifySignature(...args) { return this.inner.verifySignature(...args) }
  encrypt(args, ...rest) { this.calls.encrypt.push(args); return this.inner.encrypt(args, ...rest) }
  decrypt(args, ...rest) { this.calls.decrypt.push(args); return this.inner.decrypt(args, ...rest) }
  createHmac(args, ...rest) { this.calls.createHmac.push(args); return this.inner.createHmac(args, ...rest) }
  verifyHmac(...args) { return this.inner.verifyHmac(...args) }
  createAction(...args) {
    this.calls.createAction += 1
    this.calls.createActionOutputs.push(args[0]?.outputs ?? [])
    this.calls.satoshisRequested += (args[0]?.outputs ?? []).reduce((total, output) => {
      return total + (typeof output?.satoshis === 'number' ? output.satoshis : 0)
    }, 0)
    if (this.failCreateAction) throw new Error('fixture refuses payment creation')
    return this.inner.createAction(...args)
  }
  signAction(...args) { this.calls.signAction += 1; return this.inner.signAction(...args) }
  abortAction(...args) { this.calls.abortAction += 1; return this.inner.abortAction(...args) }
  internalizeAction(...args) { this.calls.internalizeAction += 1; return this.inner.internalizeAction(...args) }
}
