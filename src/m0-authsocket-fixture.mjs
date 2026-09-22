import { AuthSocketServer } from '@bsv/authsocket'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'

import { bodyHash } from './m0-envelope.mjs'

/**
 * Attach the public AuthSocket server to the real local HTTP fixture. This
 * exercises MessageBoxClient's public Socket.IO/AuthSocket path without
 * importing Message Box Server internals or replacing a client method.
 *
 * behavior:
 * - "accept": persist the envelope, notify any joined recipient, and ack.
 * - "reject": return a negative ack so the client exercises HTTP fallback.
 * - "dropAck": persist and notify, but omit the ack so the client exercises
 *   its timeout fallback against an already accepted message.
 */
export function attachAuthSocketMessageBox(host, { wallet, behavior = 'accept' } = {}) {
  if (!host?.server || !host?.state) throw new TypeError('HTTP Message Box fixture is required')
  if (!['accept', 'reject', 'dropAck'].includes(behavior)) throw new TypeError('Unsupported AuthSocket fixture behavior')

  const serverWallet = wallet ?? new ProtoWallet(PrivateKey.fromHex('44'.repeat(32)))
  const socketServer = new AuthSocketServer(host.server, {
    wallet: serverWallet,
    cors: { origin: '*' },
  })
  const rooms = new Map()
  const roomWaiters = new Map()

  socketServer.on('connection', (socket) => {
    socket.on('authenticated', async (data) => {
      const authenticatedIdentity = socket.identityKey
      if (typeof authenticatedIdentity !== 'string' || data?.identityKey !== authenticatedIdentity) {
        await socket.emit('authenticationFailed', { reason: 'Authenticated identity mismatch' })
        return
      }
      await socket.emit('authenticationSuccess', { status: 'success' })
    })

    socket.on('joinRoom', async (roomId) => {
      const authenticatedIdentity = socket.identityKey
      if (
        typeof authenticatedIdentity !== 'string' ||
        typeof roomId !== 'string' ||
        !roomId.startsWith(`${authenticatedIdentity}-`)
      ) {
        await socket.emit('joinFailed', { reason: 'Room is not owned by authenticated identity' })
        return
      }

      let members = rooms.get(roomId)
      if (!members) {
        members = new Set()
        rooms.set(roomId, members)
      }
      members.add(socket)
      const waiters = roomWaiters.get(roomId)
      if (waiters) {
        roomWaiters.delete(roomId)
        for (const resolve of waiters) resolve()
      }
      await socket.emit('joinedRoom', { roomId })
    })

    socket.on('sendMessage', async (payload) => {
      const authenticatedIdentity = socket.identityKey
      const roomId = payload?.roomId
      const message = payload?.message
      host.state.socketRequests.push({
        identityKey: authenticatedIdentity,
        roomId,
        message,
      })

      if (typeof roomId !== 'string' || !message || typeof message !== 'object') return
      const ackEvent = `sendMessageAck-${roomId}`
      if (behavior === 'reject') {
        await socket.emit(ackEvent, { status: 'error', code: 'ERR_FIXTURE_REJECTED' })
        return
      }

      if (
        typeof authenticatedIdentity !== 'string' ||
        typeof message.recipient !== 'string' ||
        typeof message.messageId !== 'string' ||
        typeof message.body !== 'string' ||
        !roomId.startsWith(`${message.recipient}-`)
      ) {
        await socket.emit(ackEvent, { status: 'error', code: 'ERR_FIXTURE_INVALID_MESSAGE' })
        return
      }

      const messageBox = roomId.slice(message.recipient.length + 1)
      const key = `${message.recipient}\u0000${messageBox}\u0000${message.messageId}`
      if (host.state.records.has(key)) {
        await socket.emit(ackEvent, { status: 'error', code: 'ERR_DUPLICATE_MESSAGE' })
        return
      }

      const now = new Date().toISOString()
      host.state.records.set(key, {
        messageId: message.messageId,
        sender: authenticatedIdentity,
        recipient: message.recipient,
        messageBox,
        body: message.body,
        bodyHash: bodyHash(message.body),
        created_at: now,
        updated_at: now,
      })

      if (behavior !== 'dropAck') {
        await socket.emit(ackEvent, { status: 'success', messageId: message.messageId })
      }

      const recipientRoom = `${message.recipient}-${messageBox}`
      const recipients = rooms.get(recipientRoom) ?? []
      await Promise.all(Array.from(recipients, async (recipientSocket) => {
        await recipientSocket.emit(`sendMessage-${recipientRoom}`, {
          sender: authenticatedIdentity,
          messageId: message.messageId,
          body: message.body,
        })
      }))
    })
  })

  return {
    rooms,
    async waitForRoom(roomId, timeoutMs = 5_000) {
      if (rooms.has(roomId)) return
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const waiters = roomWaiters.get(roomId)
          if (waiters) {
            const index = waiters.indexOf(onJoined)
            if (index >= 0) waiters.splice(index, 1)
            if (waiters.length === 0) roomWaiters.delete(roomId)
          }
          reject(new Error(`Timed out waiting for AuthSocket room ${roomId}`))
        }, timeoutMs)
        const onJoined = () => {
          clearTimeout(timeout)
          resolve()
        }
        const waiters = roomWaiters.get(roomId) ?? []
        waiters.push(onJoined)
        roomWaiters.set(roomId, waiters)
      })
    },
    close: () => socketServer.close(),
  }
}
