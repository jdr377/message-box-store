import assert from 'node:assert/strict'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { test } from 'node:test'

import { createAdmissionTracker, createFixedWindowRateLimiter, createServiceApp } from '../dist/server.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function request(app, { path = '/v1/history/records', method = 'POST', headers = {}, body } = {}) {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = path
  req.headers = headers
  const res = new ServerResponse(req)
  let finish
  const done = new Promise(resolve => { finish = resolve })
  res.end = function(chunk) {
    this.result = chunk === undefined ? null : JSON.parse(String(chunk))
    this.emit('finish')
    finish({ status: this.statusCode, body: this.result, headers: this.getHeaders() })
    return this
  }
  app.handle(req, res)
  if (body !== undefined) { req.push(Buffer.from(body)); req.push(null) }
  return { req, res, done }
}
const state = { version: 'security-regression', checkReadiness: () => ({ ready: true, versions: [] }) }

test('F1 partial body readers occupy admission; rejected streams are not parsed and abort releases once', async () => {
  const admission = createAdmissionTracker()
  let rateCalls = 0
  const app = await createServiceApp({ ...state, admission, maxConcurrentRequests: 1, ipRateLimiter: { consume() { rateCalls++; return { allowed: true } } } })
  const first = request(app, { headers: { 'content-type': 'application/json', 'content-length': '1048576' } })
  first.req.push(Buffer.from('{"pending":"' + 'a'.repeat(128 * 1024)))
  await tick()
  assert.equal(admission.active(), 1)
  assert.equal(rateCalls, 1)
  const second = request(app, { headers: { 'content-type': 'application/json', 'content-length': '8' } })
  assert.equal((await second.done).status, 503)
  assert.equal(second.req.listenerCount('data'), 0)
  assert.equal(rateCalls, 1)
  first.req.destroy()
  await tick()
  assert.equal(admission.active(), 0)
  first.res.emit('close')
  assert.equal(admission.active(), 0)
  const third = request(app, { path: '/v1/history/usage', method: 'GET' })
  assert.equal((await third.done).status, 401)
  assert.equal(admission.active(), 0)
})

test('F1 malformed JSON consumes the IP allowance and parser errors release admission', async () => {
  const admission = createAdmissionTracker()
  const app = await createServiceApp({ ...state, admission, maxConcurrentRequests: 1, ipRateLimiter: createFixedWindowRateLimiter({ limit: 2 }) })
  for (const expected of [400, 400, 429, 429]) {
    const pending = request(app, { headers: { 'content-type': 'application/json', 'content-length': '8' }, body: '{invalid' })
    assert.equal((await pending.done).status, expected)
    assert.equal(admission.active(), 0)
  }
})

test('F1 CORS preflight and liveness bypass parsing/admission; handshake and auth body framing remain intact', async () => {
  const admission = createAdmissionTracker()
  let authCalls = 0
  let rateCalls = 0
  const seen = []
  const app = await createServiceApp({ ...state, admission, maxConcurrentRequests: 1, allowedOrigins: ['https://app.example.com'], ipRateLimiter: { consume() { rateCalls++; return { allowed: true } } }, authMiddleware(req, res) {
    authCalls++
    seen.push(req.body)
    res.status(200).json({ accepted: true })
  } })
  admission.beginDrain()
  const health = request(app, { path: '/healthz', method: 'GET', headers: { 'content-type': 'application/json', 'content-length': '1024' } })
  assert.equal((await health.done).status, 200)
  assert.equal(health.req.listenerCount('data'), 0)
  const cors = await request(app, { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } }).done
  assert.equal(cors.status, 204)
  assert.equal(cors.headers['access-control-allow-origin'], 'https://app.example.com')
  assert.equal(authCalls, 0)
  assert.equal(rateCalls, 0)
  admission.clearDrain()
  assert.equal((await request(app, { path: '/.well-known/auth', headers: { 'content-type': 'application/json', 'content-length': '2' }, body: '{}' }).done).status, 200)
  const signedHeaders = { 'x-bsv-auth-signature': 'fixture-only', 'x-bsv-auth-request-id': 'fixture-only', 'content-type': 'application/json', 'content-length': '9' }
  await request(app, { headers: signedHeaders, body: ' [1, 2]  ' }).done
  assert.ok(Buffer.isBuffer(seen[1]))
  assert.equal(seen[1].toString(), ' [1, 2]  ', 'auth receives exact original primitive/array JSON bytes')
  assert.equal(admission.active(), 0)
  const denied = await request(app, { headers: { origin: 'https://denied.example' } }).done
  assert.equal(denied.status, 403)
  assert.equal(authCalls, 2)
})
