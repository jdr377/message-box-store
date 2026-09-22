import { MessageBoxClient } from '@bsv/message-box-client'
import { AuthFetch, stringifyBRC100 } from '@bsv/sdk'

export const PAID_TRANSPORT_UNSUPPORTED_CODE = 'ERR_PAID_TRANSPORT_UNSUPPORTED'

const freeOnlyWallets = new WeakSet()
const freeOnlyAuthFetches = new WeakSet()
const freeOnlyMessageBoxClients = new WeakSet()
const freeOnlyMessageBoxTransports = new WeakMap()
// State classification trusts only errors emitted by this guard, not public
// code/message lookalikes that a wallet or caller could throw themselves.
const guardedPaymentErrors = new WeakSet()
const guardedWalletPaymentDenials = new WeakMap()

const WALLET_INTERFACE_METHODS = Object.freeze([
  'getPublicKey',
  'revealCounterpartyKeyLinkage',
  'revealSpecificKeyLinkage',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'createSignature',
  'verifySignature',
  'createAction',
  'signAction',
  'abortAction',
  'listActions',
  'internalizeAction',
  'listOutputs',
  'relinquishOutput',
  'acquireCertificate',
  'listCertificates',
  'proveCertificate',
  'relinquishCertificate',
  'discoverByIdentityKey',
  'discoverByAttributes',
  'isAuthenticated',
  'waitForAuthentication',
  'getHeight',
  'getHeaderForHeight',
  'getNetwork',
  'getVersion',
])

const BLOCKED_ACTION_METHODS = new Set([
  'createAction',
  'signAction',
  'abortAction',
  'internalizeAction',
])

const BLOCKED_AUTHFETCH_OPTIONS = new Set([
  'paymentContext',
  'paymentRetryAttempts',
  'labels',
])

export class PaidTransportUnsupportedError extends Error {
  constructor() {
    super(`${PAID_TRANSPORT_UNSUPPORTED_CODE}: paid Message Box transport is not supported by message-box-store v1`)
    this.name = 'PaidTransportUnsupportedError'
    this.code = PAID_TRANSPORT_UNSUPPORTED_CODE
  }
}

export function isPaidTransportUnsupportedError(error) {
  return guardedPaymentErrors.has(error)
}

function paymentError() {
  const error = new PaidTransportUnsupportedError()
  guardedPaymentErrors.add(error)
  return error
}

function isPaymentDerivationKey(args) {
  return Array.isArray(args?.protocolID) &&
    args.protocolID[0] === 2 &&
    args.protocolID[1] === '3241645161d8'
}

function paymentDenialCount(wallet) {
  return guardedWalletPaymentDenials.get(wallet)?.count ?? 0
}

/**
 * Adapt a public WalletInterface without exposing the original wallet. Normal
 * identity, authentication, HMAC, and encryption operations delegate to the
 * caller's wallet. BRC-105's payment-specific key derivation and every
 * transaction action are fail-closed with a stable error.
 *
 * The exact AuthFetch 2.7.1 402 path is:
 * createNonce(createHmac([2, 'server hmac'])) -> getPublicKey([2,
 * '3241645161d8']) -> createAction(outputs) -> retry with x-bsv-payment.
 * BRC-103's ordinary authentication handshake also uses createNonce and the
 * same HMAC protocol, so createHmac must be forwarded. The payment-specific
 * derived key and every transaction action are blocked; AuthFetch therefore
 * fails before creating or retrying a payment. Unknown future wallet methods
 * are not forwarded.
 */
export function createPaymentDisabledWallet(walletClient) {
  if (walletClient === null || (typeof walletClient !== 'object' && typeof walletClient !== 'function')) {
    throw new TypeError('A public WalletInterface instance is required')
  }

  const paymentDenialState = { count: 0 }
  const facade = Object.create(null)
  for (const method of WALLET_INTERFACE_METHODS) {
    let implementation
    try {
      implementation = Reflect.get(walletClient, method, walletClient)
    } catch {
      implementation = undefined
    }

    let wrapped
    if (BLOCKED_ACTION_METHODS.has(method)) {
      wrapped = async () => { throw paymentError() }
    } else if (method === 'getPublicKey') {
      wrapped = async (args, ...rest) => {
        if (isPaymentDerivationKey(args)) {
          paymentDenialState.count += 1
          throw paymentError()
        }
        if (typeof implementation !== 'function') throw new TypeError('WalletInterface.getPublicKey is required')
        return Reflect.apply(implementation, walletClient, [args, ...rest])
      }
    } else {
      wrapped = async (...args) => {
        if (typeof implementation !== 'function') throw new TypeError(`WalletInterface.${method} is required`)
        return Reflect.apply(implementation, walletClient, args)
      }
    }

    Object.defineProperty(facade, method, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: wrapped,
    })
  }

  Object.freeze(facade)
  freeOnlyWallets.add(facade)
  guardedWalletPaymentDenials.set(facade, paymentDenialState)
  return facade
}

function rawHostnameFromUrl(value) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value.trim())
  if (!match) return undefined

  const authority = match[1]
  if (authority.includes('@')) return undefined
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']')
    return closingBracket === -1 ? undefined : authority.slice(0, closingBracket + 1)
  }

  const portSeparator = authority.lastIndexOf(':')
  return portSeparator === -1 ? authority : authority.slice(0, portSeparator)
}

function isStrictIpv4Loopback(hostname) {
  const octets = hostname.split('.')
  if (octets.length !== 4) return false
  if (octets.some((octet) => !/^(?:0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255)) return false
  return Number(octets[0]) === 127
}

function isLoopbackHost(value, parsed) {
  const rawHostname = rawHostnameFromUrl(value)
  if (typeof rawHostname !== 'string') return false

  const normalizedRawHostname = rawHostname.toLowerCase()
  const parsedHostname = parsed.hostname.toLowerCase()
  if (normalizedRawHostname === 'localhost') return parsedHostname === 'localhost'
  if (normalizedRawHostname === '[::1]') return parsedHostname === '[::1]'
  return isStrictIpv4Loopback(rawHostname) && parsedHostname === rawHostname
}

function normalizeExplicitHost(host, { allowLoopbackHttpForTests = false } = {}) {
  if (typeof host !== 'string' || host.trim() === '') throw new TypeError('An explicit HTTPS host is required')
  const source = host.trim()
  let parsed
  try {
    parsed = new URL(source)
  } catch {
    throw new TypeError('Host must be an absolute HTTPS URL')
  }
  const localHttp = parsed.protocol === 'http:' && allowLoopbackHttpForTests === true && isLoopbackHost(source, parsed)
  if (parsed.protocol !== 'https:' && !localHttp) throw new TypeError('Host must use HTTPS (HTTP is allowed only for loopback tests)')
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError('Host must not contain credentials, query, or fragment')
  if (parsed.pathname !== '/') throw new TypeError('Configured hosts must be origins without a path')
  return parsed.origin
}

function endpointFor(host, route) {
  const base = new URL(host)
  base.pathname = route.startsWith('/') ? route : `/${route}`
  base.search = ''
  base.hash = ''
  return base.toString()
}

function validateRequestUrl(url, authorize, allowLoopbackHttpForTests, config) {
  if (typeof url !== 'string') throw new TypeError('AuthFetch URL must be an absolute URL string')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError('AuthFetch URL must be an absolute URL string')
  }
  const localHttp = parsed.protocol === 'http:' && allowLoopbackHttpForTests === true && isLoopbackHost(url, parsed)
  if (parsed.protocol !== 'https:' && !localHttp) throw new TypeError('AuthFetch requests require HTTPS (HTTP is allowed only for loopback tests)')
  if (parsed.username || parsed.password || parsed.hash) throw new TypeError('AuthFetch URL must not contain credentials or a fragment')
  if (typeof authorize !== 'function' || authorize(parsed, config) !== true) {
    throw new TypeError('AuthFetch request is not authorized for this origin, route, and method')
  }
  return parsed.toString()
}

function normalizeFreeOnlyFetchOptions(config) {
  if (config === undefined) return
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('AuthFetch options must be an object')

  for (const option of BLOCKED_AUTHFETCH_OPTIONS) {
    if (option in config) throw paymentError()
  }

  for (const key of Object.keys(config)) {
    if (!['method', 'headers', 'body', 'retryCounter'].includes(key)) {
      throw new TypeError(`Unsupported free-only AuthFetch option: ${key}`)
    }
  }

  const safeConfig = {}
  for (const key of ['method', 'headers', 'body', 'retryCounter']) {
    if (!Object.hasOwn(config, key)) continue
    const value = config[key]
    if (key !== 'headers') {
      safeConfig[key] = value
      continue
    }

    const headers = value
    if (headers === undefined) {
      safeConfig.headers = undefined
      continue
    }
    let entries
    if (headers instanceof Headers) {
      entries = [...headers.entries()]
    } else {
      if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new TypeError('AuthFetch headers must be a string-keyed object')
      }
      entries = Object.entries(headers)
    }
    for (const [name] of entries) {
      if (name.toLowerCase() === 'x-bsv-payment') throw paymentError()
    }
    // Snapshot caller-owned headers before AuthFetch's asynchronous BRC-103
    // handshake; otherwise a late mutation could add a payment header after
    // validation but before the SDK serializes the request.
    safeConfig.headers = Object.fromEntries(entries)
  }
  return safeConfig
}

function createSerialExecutor() {
  let previous = Promise.resolve()
  return (operation) => {
    const current = previous.then(operation, operation)
    previous = current.catch(() => {})
    return current
  }
}

function safeAuthFetch(rawAuthFetch, { authorize, allowLoopbackHttpForTests = false, serialize } = {}) {
  const facade = Object.freeze({
    async fetch(url, config = {}) {
      const safeConfig = normalizeFreeOnlyFetchOptions(config)
      const safeUrl = validateRequestUrl(url, authorize, allowLoopbackHttpForTests, safeConfig)
      const execute = async () => {
        try {
          return await rawAuthFetch.fetch(safeUrl, safeConfig ?? {})
        } catch (error) {
          if (isPaidTransportUnsupportedError(error)) throw paymentError()
          throw error
        }
      }
      return typeof serialize === 'function' ? serialize(execute) : execute()
    },
  })
  freeOnlyAuthFetches.add(facade)
  return facade
}

function requireFreeOnlyWallet(wallet) {
  if (!freeOnlyWallets.has(wallet)) throw new TypeError('Free-only AuthFetch construction requires createPaymentDisabledWallet()')
}

/**
 * Construct the only supported AuthFetch surface for a future store service.
 * A single explicit HTTPS origin is bound up front. Payment context and
 * payment headers cannot be supplied, and every 402 is stopped by the wallet
 * adapter before a payment retry can be made.
 */
export function createFreeOnlyAuthFetch({ walletClient, host, requestedCertificates, sessionManager, originator, allowLoopbackHttpForTests = false } = {}) {
  const normalizedHost = normalizeExplicitHost(host, { allowLoopbackHttpForTests })
  const wallet = createPaymentDisabledWallet(walletClient)
  requireFreeOnlyWallet(wallet)
  const rawAuthFetch = new AuthFetch(wallet, requestedCertificates, sessionManager, originator)
  const authFetch = safeAuthFetch(rawAuthFetch, {
    authorize: (parsed) => parsed.origin === new URL(normalizedHost).origin,
    allowLoopbackHttpForTests,
  })
  const facade = Object.freeze({ host: normalizedHost, wallet, fetch: authFetch.fetch })
  freeOnlyAuthFetches.add(facade)
  return facade
}

function assertNoPaidMessageFields(message) {
  if (message?.checkPermissions === true || (message !== null && typeof message === 'object' && 'payment' in message)) {
    throw paymentError()
  }
}

function jsonMessageResponse(response, operation) {
  return response.json().then((data) => {
    if (!response.ok || data?.status !== 'success') {
      throw new Error(`${operation} failed: HTTP ${response.status}`)
    }
    return data
  })
}

/**
 * Construct MessageBoxClient with the payment-disabled WalletInterface from
 * the outset. The returned narrow facade exposes no live send, permission,
 * quote, raw client, AuthFetch object, wallet facade, or generic fetch method.
 * It exposes only identity lookup and route-scoped list/ack operations; the
 * outbound transport remains module-private behind an opaque capability.
 */
export function createFreeOnlyMessageBoxClient({ walletClient, host, trustedHosts = [], originator, allowLoopbackHttpForTests = false } = {}) {
  if (!Array.isArray(trustedHosts)) throw new TypeError('trustedHosts must be an array of explicit HTTPS origins')
  const hostOptions = { allowLoopbackHttpForTests }
  const normalizedHost = normalizeExplicitHost(host, hostOptions)
  const configuredHosts = [normalizedHost]
  const allowedOrigins = new Set([new URL(normalizedHost).origin])
  for (const trustedHost of trustedHosts) {
    const normalizedTrustedHost = normalizeExplicitHost(trustedHost, hostOptions)
    const trustedOrigin = new URL(normalizedTrustedHost).origin
    if (!allowedOrigins.has(trustedOrigin)) {
      allowedOrigins.add(trustedOrigin)
      configuredHosts.push(normalizedTrustedHost)
    }
  }
  const normalizeTrustedDestination = (hostOverride) => {
    const destination = normalizeExplicitHost(hostOverride, hostOptions)
    if (!allowedOrigins.has(new URL(destination).origin)) {
      throw new TypeError('Message Box destination must use the primary or an explicitly trusted origin')
    }
    return destination
  }
  // Keep both guard wallets private. The client wallet protects the SDK send
  // path; the route wallet protects the narrowly exposed list/ack path.
  const wallet = createPaymentDisabledWallet(walletClient)
  const clientWallet = createPaymentDisabledWallet(walletClient)
  requireFreeOnlyWallet(wallet)
  requireFreeOnlyWallet(clientWallet)
  const client = new MessageBoxClient({ walletClient: clientWallet, host: normalizedHost, originator })
  const serialize = createSerialExecutor()
  const primaryOrigin = new URL(normalizedHost).origin
  const authFetch = safeAuthFetch(client.authFetch, {
    authorize(parsed, config) {
      const method = (config?.method ?? 'GET').toUpperCase()
      if (parsed.origin === primaryOrigin) return method === 'POST' && ['/listMessages', '/acknowledgeMessage'].includes(parsed.pathname) && parsed.search === ''
      return allowedOrigins.has(parsed.origin) && method === 'POST' && ['/listMessages', '/acknowledgeMessage'].includes(parsed.pathname) && parsed.search === ''
    },
    allowLoopbackHttpForTests,
    serialize,
  })

  const facade = Object.freeze({
    host: normalizedHost,
    trustedHosts: Object.freeze(configuredHosts.slice(1)),
    getIdentityKey: () => client.getIdentityKey(),
    async listRawPage({ messageBox, offset = 0, limit = 100, host: hostOverride = normalizedHost } = {}) {
      if (typeof messageBox !== 'string' || messageBox.trim() === '') throw new TypeError('messageBox is required')
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative safe integer')
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer')
      const destination = normalizeTrustedDestination(hostOverride)
      const response = await authFetch.fetch(endpointFor(destination, '/listMessages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyBRC100({ messageBox, offset, limit }),
      })
      return jsonMessageResponse(response, 'Message Box list')
    },
    async acknowledgeMessage({ messageIds, host: hostOverride = normalizedHost } = {}) {
      if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new TypeError('messageIds must be a non-empty array of non-empty strings')
      }
      const destination = normalizeTrustedDestination(hostOverride)
      const response = await authFetch.fetch(endpointFor(destination, '/acknowledgeMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyBRC100({ messageIds }),
      })
      return (await jsonMessageResponse(response, 'Message Box acknowledgement')).status
    },
  })

  freeOnlyMessageBoxClients.add(facade)
  freeOnlyMessageBoxTransports.set(facade, Object.freeze({
    host: normalizedHost,
    async sendMessage(params, hostOverride = normalizedHost) {
      assertNoPaidMessageFields(params)
      const destination = normalizeExplicitHost(hostOverride, hostOptions)
      if (destination !== normalizedHost) throw new TypeError('Outbound Message Box send must use the primary origin')
      return serialize(async () => {
        const paymentDenialsBefore = paymentDenialCount(clientWallet)
        try {
          return await client.sendMessage({ ...params, checkPermissions: false }, destination)
        } catch (error) {
          if (paymentDenialCount(clientWallet) > paymentDenialsBefore || isPaidTransportUnsupportedError(error)) throw paymentError()
          throw error
        }
      })
    },
  }))
  return facade
}

/** Internal capability check used by M0 policy code; omitted from package root exports. */
export function isFreeOnlyMessageBoxClient(client) {
  return freeOnlyMessageBoxClients.has(client)
}

/** Package-internal retrieval; this module is not a supported package subpath. */
export function getFreeOnlyMessageBoxTransport(client) {
  return freeOnlyMessageBoxTransports.get(client)
}

/** Internal capability check used by package-surface tests; omitted from root exports. */
export function isFreeOnlyAuthFetch(client) {
  return freeOnlyAuthFetches.has(client)
}
