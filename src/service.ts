/**
 * M2.1b auth binding (mbs-8g5.3.1.2) through M2.1e capabilities and
 * operational endpoints (mbs-8g5.3.1.5) over the M2.1a composition boundary
 * (mbs-8g5.3.1.1): standalone Express service, MySQL repository construction,
 * BRC-103/BRC-104 owner-scoped request context, versioned archive/state/
 * deletion plus read routes, authenticated capabilities, public liveness and
 * non-sensitive MySQL readiness.
 *
 * Scope: validated configuration, Knex/MySQL repository construction,
 * migration verification plus a non-sensitive database probe before readiness,
 * Express app/router assembly with the authenticated capabilities route,
 * explicit start/stop ownership, public auth middleware integration behind an
 * unsigned-request gate, one request-context adapter (verified identity is
 * the only owner selector), conflicting-owner rejection, inbound-recipient/
 * outbound-sender enforcement before repository calls, the shared replay
 * window, four mutation routes over the existing M1 repository (archive
 * batch, delivery-state patch, delete one, delete all), five retrieval
 * routes over the same repository (browse, changes, snapshot creation,
 * snapshot paging, storage usage), and the M2.1e capabilities route that
 * publishes effective protocol/limits/retention/epoch/feature configuration
 * for the authenticated owner only, and the M2.2a.1 ingress layer (exact
 * configured origin/CORS policy plus early HTTP body, batch-item and
 * batch-byte bounds before authentication or repository work). Reuses M1
 * protocol, limits, cursors, filters, migrations and repository adapters;
 * adds no rate or concurrency controls, no cleanup or logging (.3.2.2), no
 * metrics, discovery, pricing, deployment, client synchronization, policy
 * framework, workers, tombstone endpoint, live-send/ack, alternate
 * databases, TLS termination, or new storage behavior.
 *
 * Server-only subpath: express/middleware/sdk/knex are loaded lazily so
 * `import 'message-box-store/server'` succeeds in a clean consumer without
 * server peers installed; calling createService() requires them. Never
 * imported by browser-safe root, protocol, client or canonical modules.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import { LIMITS, PROTOCOL_VERSION, isIdentityKey, isRecordKey, isUint64DecimalString } from './canonical.js'
import type { Capabilities } from './protocol.js'
import type { HistoryRepository } from './storage.js'

export const SERVICE_VERSION = '0.0.0-m2.2a.1'
export const SERVICE_CONFIG_CODE = 'ERR_STORAGE_CONFIGURATION'
export const SERVICE_MYSQL_CODE = 'ERR_MYSQL_CONFIG'
export const SERVICE_MIGRATION_CODE = 'ERR_MIGRATION_STRUCTURE'
export const SERVICE_UNAVAILABLE_CODE = 'ERR_UNAVAILABLE'
export const SERVICE_AUTH_CODE = 'ERR_AUTHENTICATION_REQUIRED'
export const SERVICE_FORBIDDEN_CODE = 'ERR_FORBIDDEN'
export const SERVICE_INVALID_CODE = 'ERR_INVALID_RECORD'
export const SERVICE_TOO_LARGE_CODE = 'ERR_REQUEST_TOO_LARGE'
export const SERVICE_QUOTA_CODE = 'ERR_QUOTA_EXCEEDED'
export const SERVICE_CONFLICT_CODE = 'ERR_IMMUTABLE_CONFLICT'
export const SERVICE_REVISION_CODE = 'ERR_REVISION_CONFLICT'
export const SERVICE_EPOCH_CODE = 'ERR_EPOCH_CHANGED'
export const SERVICE_IDEMPOTENCY_CODE = 'ERR_IDEMPOTENCY_CONFLICT'
export const SERVICE_EPOCH_EXHAUSTED_CODE = 'ERR_EPOCH_EXHAUSTED'
export const SERVICE_RATE_LIMITED_CODE = 'ERR_RATE_LIMITED'
export const SERVICE_CURSOR_EXPIRED_CODE = 'ERR_CURSOR_EXPIRED'
export const SERVICE_INVALID_CURSOR_CODE = 'ERR_INVALID_CURSOR'
export const SERVICE_INTERNAL_CODE = 'ERR_INTERNAL'

/**
 * M2.1e supported features (mbs-8g5.3.1.5): the actual implemented service
 * surface the capabilities route publishes. Static and configuration-free by
 * construction, so the document can never reflect another owner's state, a
 * dependency, or connection detail. Each entry maps to a route or frozen
 * behavior that exists in this composition; nothing speculative is listed.
 */
export const SERVICE_SUPPORTED_FEATURES: readonly string[] = Object.freeze([
  'archiveBatch',
  'browse',
  'changes',
  'snapshotCreate',
  'snapshotPage',
  'patchState',
  'deleteRecord',
  'deleteAll',
  'usage',
  'capabilities',
  'epoch',
  'idempotency',
])

/** M2.1b test probe (not part of the frozen history API). */
export const AUTH_PROBE_PATH = '/v1/history/auth-context'

/** Exact archive-batch path used by the M2.2a.1 early batch bounds. */
export const ARCHIVE_BATCH_PATH = '/v1/history/records'

/**
 * M2.2a.1 exact CORS contract (mbs-8g5.3.2.1.1). Response-headers mirror
 * the pinned BRC-103/BRC-104 request-header contract so an allowed browser
 * origin can both send and verify the signed exchange. Methods cover the
 * frozen M2.1 mutation/retrieval surface only. No Allow-Credentials: the
 * exchange authenticates per request via signed headers, never cookies.
 */
const CORS_ALLOWED_METHODS = 'GET, POST, PATCH, DELETE'
const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'x-bsv-auth-version',
  'x-bsv-auth-identity-key',
  'x-bsv-auth-message-type',
  'x-bsv-auth-nonce',
  'x-bsv-auth-your-nonce',
  'x-bsv-auth-signature',
  'x-bsv-auth-request-id',
  'x-bsv-auth-requested-certificates',
].join(', ')
const CORS_EXPOSED_HEADERS = [
  'x-bsv-auth-version',
  'x-bsv-auth-identity-key',
  'x-bsv-auth-message-type',
  'x-bsv-auth-nonce',
  'x-bsv-auth-your-nonce',
  'x-bsv-auth-signature',
  'x-bsv-auth-request-id',
  'x-bsv-auth-requested-certificates',
].join(', ')
const CORS_PREFLIGHT_MAX_AGE = '600'

/**
 * Process-local bound for the M2.1b replay window (mbs-8g5.3.1.2.1). Each
 * service instance remembers this many recent verified BRC-104 request-ids
 * across all protected application requests and rejects a verbatim reuse
 * within the window with 401. AuthFetch mints a fresh 32-byte request-id per
 * call, so legitimate retries never collide. Single-process v1 only,
 * matching the middleware's default process-local session manager. Bounded
 * FIFO eviction; no auth material is logged.
 *
 * This is a window, not absolute single-use: after eviction an old id falls
 * back to upstream verification (live session plus valid signature still
 * required). Stolen material outside the window remains usable until session
 * rotation, which is the documented residual risk in the threat model.
 * Later beads (.3.1.3/.3.1.4) mount real routes behind the same reusable
 * guard, so the window covers every protected application route.
 */
export const REPLAY_CACHE_LIMIT = 5000

/** Exact handshake path. The replay window never applies to it. */
export const AUTH_HANDSHAKE_PATH = '/.well-known/auth'

/** Raw JSON bytes retained only long enough for upstream auth verification. */
const rawJsonBodies = new WeakMap<object, Buffer>()

/**
 * Pinned upstream replay semantics (@bsv/auth-express-middleware 2.2.3 over
 * @bsv/sdk 2.7.1 AuthFetch/Peer/SimplifiedFetchTransport): the BRC-104
 * request-id is a 32-byte base64 correlation value signed over
 * method/path/query/headers/body inside a mutual session. The middleware
 * verifies the signature and session binding and detects concurrently-active
 * duplicate request-ids (active general handles) plus handshake ids while
 * pending. Completed general request-ids are NOT retained as single-use
 * tokens, so an exact replay while the session lives verifies successfully
 * upstream. The default SessionManager is process-local with no TTL.
 */
export interface ReplayGuardOptions {
  /** Window size. Defaults to REPLAY_CACHE_LIMIT. */
  limit?: number
}

export interface ReplayGuard {
  middleware: RequestHandler
  /** Current window occupancy (for tests/observability; never leaks ids). */
  seenCount: () => number
}

/**
 * Create one reusable replay window for all protected application requests.
 * Mount after the auth middleware: handshake requests (exact
 * `/.well-known/auth` path) pass through untouched, every other request must
 * carry a fresh `x-bsv-auth-request-id` or it fails closed with 401, and a
 * previously seen id within the window fails closed with 401. Descriptions
 * are generic; ids and headers are never echoed or logged.
 */
export function createReplayGuard(options?: ReplayGuardOptions): ReplayGuard {
  const limit = options?.limit ?? REPLAY_CACHE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('replay guard limit must be a positive safe integer')
  }
  const seenRequestIds = new Map<string, null>()
  const middleware: RequestHandler = (req, _res, next) => {
    try {
      if (req.path === AUTH_HANDSHAKE_PATH) {
        next()
        return
      }
      const header = req.headers['x-bsv-auth-request-id']
      if (typeof header !== 'string' || header.length === 0) {
        next(authError(401, SERVICE_AUTH_CODE, 'authentication required'))
        return
      }
      if (seenRequestIds.has(header)) {
        next(authError(401, SERVICE_AUTH_CODE, 'authentication required'))
        return
      }
      seenRequestIds.set(header, null)
      if (seenRequestIds.size > limit) {
        const oldest = seenRequestIds.keys().next()
        if (!oldest.done) seenRequestIds.delete(oldest.value)
      }
      next()
    } catch {
      next(authError(401, SERVICE_AUTH_CODE, 'authentication required'))
    }
  }
  return { middleware, seenCount: () => seenRequestIds.size }
}

export interface ServiceMysqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export interface ServiceConfig {
  serverSecret: string
  mysql: ServiceMysqlConfig
  /** Enforced active-record policy: only `permanent` until finite retention ships (mbs-8g5.3.1.5.2). */
  retention: 'permanent'
  version: string
  /**
   * Exact allowed browser origins for CORS (M2.2a.1). Each entry is a
   * canonical HTTPS origin only (`https://host[:port]`, no path); the
   * service matches Origin headers verbatim against this list. Empty (the
   * default) is the private non-browser contract: absent Origin proceeds,
   * any present Origin fails closed 403 without permissive headers.
   */
  allowedOrigins: readonly string[]
}

/** Minimal Knex surface the service needs; avoids a hard type dependency. */
export interface ServiceKnex {
  raw(...args: unknown[]): Promise<unknown>
  destroy(): Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface ServiceAuthOptions {
  /** BRC-100 server wallet for mutual auth. Defaults to an ephemeral key (never logged). */
  wallet?: unknown
  /** Session manager for the middleware. Defaults to a process-local instance. */
  sessionManager?: unknown
}

export interface ServiceOptions {
  config: unknown
  knex?: ServiceKnex
  store?: HistoryRepository
  migrate?: (knex: ServiceKnex) => Promise<string[]>
  auth?: ServiceAuthOptions
}

export interface ReadinessStatus {
  ready: boolean
  versions: string[] | null
}

export interface Service {
  app: Express
  config: ServiceConfig
  knex: ServiceKnex
  repository: HistoryRepository
  ownsKnex: boolean
  sessionManager: unknown
  migrate(): Promise<string[]>
  checkReadiness(): ReadinessStatus
  start(port?: number, host?: string): Promise<import('node:http').Server>
  stop(): Promise<void>
  close(): Promise<void>
}

export interface ServiceAppState {
  checkReadiness: () => ReadinessStatus
  version: string
  /**
   * Non-sensitive MySQL probe for GET /ready, evaluated only after the
   * migration gate passes. Must resolve true/false without ever throwing or
   * surfacing connection details; createService() always supplies it.
   * Required for a ready result (mbs-8g5.3.1.5.1): when absent, throwing or
   * false, readiness fails closed with the same redacted 503.
   */
  checkDatabase?: () => Promise<boolean>
  /** Public BRC-103/BRC-104 middleware. createService() always supplies it. */
  authMiddleware?: RequestHandler
  /** M1 repository for M2.1c mutation routes. Absent in unit probes only. */
  repository?: HistoryRepository
  /** Operator HMAC secret for M2.1d opaque cursors. createService() supplies it. */
  serverSecret?: string
  /**
   * Exact allowed browser origins (M2.2a.1). Defaults to none: the private
   * non-browser contract rejects any present Origin before authentication.
   */
  allowedOrigins?: readonly string[]
}

function configError(message: string, code: string = SERVICE_CONFIG_CODE): Error {
  const error = new TypeError(message) as Error & { code: string }
  error.code = code
  return error
}

function authError(statusCode: number, code: string, description: string): Error & { code: string; statusCode: number } {
  const error = new Error(description) as Error & { code: string; statusCode: number }
  error.code = code
  error.statusCode = statusCode
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse MESSAGE_BOX_STORE_RETENTION_DAYS. Only `permanent` — the single
 * actually enforced active-record policy — is accepted until finite
 * retention enforcement exists (mbs-8g5.3.1.5.2): a finite day count would
 * be advertised by capabilities without expiring any record, which FR-010
 * forbids. Finite values fail typed so config cannot carry an unenforced
 * boundary; default/empty resolves to `permanent`.
 */
export function parseRetentionDays(value: unknown): 'permanent' {
  if (value === undefined || value === null || value === '') return 'permanent'
  const text = String(value).trim()
  if (text === 'permanent') return 'permanent'
  throw configError('retention must be permanent until finite retention enforcement is available')
}

/**
 * Parse configured CORS origins (M2.2a.1): an exact list or a comma list of
 * canonical HTTPS origins, each validated as `new URL(origin).origin === entry`
 * so paths, queries, credentials, default ports, casing and non-HTTPS forms
 * fail typed. Empty/absent resolves to the private non-browser default ([]).
 * No wildcard or pattern forms exist — the policy is exact string matching
 * against what browsers send in the Origin header. Descriptions are generic
 * and never echo the supplied values (they are configuration, not secrets,
 * but one message covers every malformed case).
 */
export function parseAllowedOrigins(value: unknown): readonly string[] {
  if (value === undefined || value === null || value === '') return Object.freeze([])
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : null
  if (entries === null) throw configError('allowedOrigins must be exact HTTPS origins')
  const origins = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'string') throw configError('allowedOrigins must be exact HTTPS origins')
    const candidate = entry.trim()
    if (candidate.length === 0) continue
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw configError('allowedOrigins must be exact HTTPS origins')
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== candidate) {
      throw configError('allowedOrigins must be exact HTTPS origins')
    }
    origins.add(parsed.origin)
  }
  return Object.freeze([...origins])
}

function validatePort(value: unknown): number {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw configError('mysql port must be 1..65535')
  }
  return port
}

/**
 * Validate raw config input. Never echoes secrets: messages are generic and
 * never interpolate serverSecret, password, user, host or database values.
 */
export function validateServiceConfig(input: unknown): ServiceConfig {
  if (!isRecord(input)) throw configError('service configuration must be an object')
  const serverSecret = input['serverSecret']
  if (typeof serverSecret !== 'string' || serverSecret.length < 16) {
    throw configError('serverSecret must be at least 16 chars')
  }
  const mysqlRaw = input['mysql']
  if (!isRecord(mysqlRaw)) throw configError('mysql configuration is required', SERVICE_MYSQL_CODE)
  const user = mysqlRaw['user']
  const password = mysqlRaw['password']
  const database = mysqlRaw['database']
  if (typeof user !== 'string' || user.length === 0 || typeof password !== 'string' || password.length === 0 || typeof database !== 'string' || database.length === 0) {
    throw configError('MySQL user/password/database are required (via env, never committed)', SERVICE_MYSQL_CODE)
  }
  const hostRaw = mysqlRaw['host']
  const portRaw = mysqlRaw['port']
  const host = hostRaw === undefined ? '127.0.0.1' : String(hostRaw)
  if (host.length === 0 || host.length > 255) throw configError('mysql host is invalid', SERVICE_MYSQL_CODE)
  const port = portRaw === undefined ? 3306 : validatePort(portRaw)
  let retention: 'permanent' = 'permanent'
  try {
    retention = parseRetentionDays(input['retention'] ?? input['retentionDays'])
  } catch (error) {
    throw error
  }
  const versionRaw = input['version']
  const version = typeof versionRaw === 'string' && versionRaw.length > 0 ? versionRaw : SERVICE_VERSION
  const allowedOrigins = parseAllowedOrigins(input['allowedOrigins'])
  return {
    serverSecret,
    mysql: { host, port, user, password, database },
    retention,
    version,
    allowedOrigins,
  }
}

/** Load validated config from env. Secrets come from env only, never committed. */
export function loadServiceConfigFromEnv(env: Record<string, string | undefined> = process.env): ServiceConfig {
  return validateServiceConfig({
    serverSecret: env['MESSAGE_BOX_STORE_SERVER_SECRET'] ?? env['SERVER_SECRET'],
    mysql: {
      host: env['MYSQL_HOST'] ?? '127.0.0.1',
      port: env['MYSQL_PORT'] ?? 3306,
      user: env['MYSQL_USER'],
      password: env['MYSQL_PASSWORD'],
      database: env['MYSQL_DATABASE'],
    },
    retention: env['MESSAGE_BOX_STORE_RETENTION_DAYS'] ?? 'permanent',
    version: env['MESSAGE_BOX_STORE_VERSION'] ?? SERVICE_VERSION,
    allowedOrigins: env['MESSAGE_BOX_STORE_ALLOWED_ORIGINS'],
  })
}

/**
 * Derive the repository owner solely from the verified BRC-103 session.
 * The middleware sets req.auth.identityKey after verifying the signed
 * method/path/query/body; anything else (missing, 'unknown', malformed) is
 * a 401 with a generic description. Never logs or echoes auth material.
 */
export function resolveRequestOwner(req: { auth?: { identityKey?: unknown } | null }): { ownerIdentityKey: string } {
  const identityKey = req?.auth?.identityKey
  if (typeof identityKey !== 'string' || !isIdentityKey(identityKey)) {
    throw authError(401, SERVICE_AUTH_CODE, 'authentication required')
  }
  return { ownerIdentityKey: identityKey }
}

const OWNER_CLAIM_KEYS = ['owner', 'ownerIdentityKey', 'owner_identity_key'] as const

/**
 * Reject conflicting owner claims in body/query/path. A claim that is absent
 * (or empty) is ignored; a claim that differs from the verified identity is
 * a 403. Claims never override the identity. Descriptions are generic and
 * never echo the supplied or verified values.
 */
export function assertNoOwnerOverride(args: { owner: string; body?: unknown; query?: unknown; params?: unknown }): void {
  if (!isIdentityKey(args.owner)) throw authError(401, SERVICE_AUTH_CODE, 'authentication required')
  for (const source of [args.body, args.query, args.params]) {
    if (!isRecord(source)) continue
    for (const key of OWNER_CLAIM_KEYS) {
      const value = source[key]
      if (value === undefined || value === null || value === '') continue
      if (value !== args.owner) {
        throw authError(403, SERVICE_FORBIDDEN_CODE, 'owner claim does not match the authenticated identity')
      }
    }
  }
}

/**
 * Enforce inbound-recipient/outbound-sender ownership before any repository
 * access (mirrors M1 assertOwnerDirection). Returns the checked count;
 * throws 400 on malformed records and 403 on ownership mismatch. Never
 * touches the repository and never echoes bodies or keys.
 */
export function assertArchiveOwnership(args: { owner: string; records?: unknown }): { checkedRecords: number } {
  const { owner, records } = args
  if (!isIdentityKey(owner)) throw authError(401, SERVICE_AUTH_CODE, 'authentication required')
  if (records === undefined) return { checkedRecords: 0 }
  if (!Array.isArray(records)) throw authError(400, SERVICE_INVALID_CODE, 'records must be an array')
  for (const record of records) {
    if (!isRecord(record)) throw authError(400, SERVICE_INVALID_CODE, 'record must be an object')
    const { direction, sender, recipient } = record
    if (direction !== 'inbound' && direction !== 'outbound') {
      throw authError(400, SERVICE_INVALID_CODE, 'direction must be inbound or outbound')
    }
    if (!isIdentityKey(sender) || !isIdentityKey(recipient)) {
      throw authError(400, SERVICE_INVALID_CODE, 'sender and recipient must be identity keys')
    }
    if (direction === 'inbound' && recipient !== owner) {
      throw authError(403, SERVICE_FORBIDDEN_CODE, 'inbound recipient must equal the authenticated owner')
    }
    if (direction === 'outbound' && sender !== owner) {
      throw authError(403, SERVICE_FORBIDDEN_CODE, 'outbound sender must equal the authenticated owner')
    }
  }
  return { checkedRecords: records.length }
}

/**
 * M2.1c mutation validation (mbs-8g5.3.1.3). HTTP-layer shape checks mirror
 * the frozen M1 JSON schemas; content validation (body JSON, hashes,
 * key recomputation, quotas) stays in the repository, which reports
 * per-record outcomes. Descriptions are generic and never echo bodies,
 * keys, or auth material.
 */

const EPOCH_RE = /^[A-Za-z0-9:_-]{1,128}$/
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{1,128}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const DELIVERY_STATES = new Set(['prepared', 'received', 'unknown', 'accepted', 'failed'])
const ARCHIVE_DELIVERY_STATES = new Set(['prepared', 'received'])

const ARCHIVE_ALLOWED_KEYS = new Set([
  'recordKey', 'messageId', 'messageBox', 'direction', 'sender', 'recipient', 'body', 'bodyHash', 'deliveryState',
])
const ARCHIVE_REQUIRED_KEYS = ['messageId', 'messageBox', 'direction', 'sender', 'recipient', 'body'] as const
const PATCH_ALLOWED_KEYS = new Set(['recordKey', 'newState', 'expectedRevision', 'idempotencyKey'])
const DELETE_ONE_BODY_ALLOWED_KEYS = new Set(['recordKey', 'idempotencyKey'])
const DELETE_ALL_BODY_ALLOWED_KEYS = new Set(['idempotencyKey', 'expectedEpoch'])
const ARCHIVE_QUERY_ALLOWED_KEYS = new Set<string>()
const PATCH_QUERY_ALLOWED_KEYS = new Set<string>()
const DELETE_ONE_QUERY_ALLOWED_KEYS = new Set(['idempotencyKey'])
const DELETE_ALL_QUERY_ALLOWED_KEYS = new Set(['idempotencyKey', 'expectedEpoch'])

function invalidError(description = 'invalid request'): Error & { code: string; statusCode: number } {
  return authError(400, SERVICE_INVALID_CODE, description)
}

function tooLargeError(description = 'request exceeds the configured limit'): Error & { code: string; statusCode: number } {
  return authError(413, SERVICE_TOO_LARGE_CODE, description)
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

/** Reject query parameters that are not part of the route's exact contract. */
function validateMutationQuery(query: unknown, allowed: ReadonlySet<string>): void {
  if (query === undefined || query === null) return
  if (!isPlainRecord(query)) throw invalidError('query must be an object')
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw invalidError('query carries unknown fields')
  }
}

/** Validate epoch shape (1..128 [A-Za-z0-9:_-]). */
export function validateEpochShape(value: unknown): string {
  if (typeof value !== 'string' || !EPOCH_RE.test(value)) {
    throw invalidError('epoch must be 1..128 [A-Za-z0-9:_-] chars')
  }
  return value
}

/** Validate idempotency-key shape (1..128 [A-Za-z0-9_-]). */
export function validateIdempotencyShape(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_RE.test(value)) {
    throw invalidError('idempotencyKey must be 1..128 [A-Za-z0-9_-] chars')
  }
  return value
}

/** Validate a path recordKey (64 lowercase hex). */
export function validatePathRecordKey(value: unknown): string {
  if (typeof value !== 'string' || !HEX64_RE.test(value) || !isRecordKey(value)) {
    throw invalidError('recordKey must be 64 lowercase hex chars')
  }
  return value
}

/**
 * Validate the archive-batch JSON shape. Returns the epoch and records for
 * the repository call. Throws 400 on malformed schema, 413 on batch
 * count/byte overflow. Per-record content (body JSON, hashes, ownership
 * values beyond direction presence) is validated by the repository and
 * reported as per-record outcomes; direction ownership is enforced
 * separately by assertArchiveOwnership (403) before any repository access.
 */
export function validateArchiveBatchBody(body: unknown): { epoch: string; records: Array<Record<string, unknown>> } {
  if (!isPlainRecord(body)) throw invalidError('request body must be a JSON object')
  const { epoch, records, ...rest } = body
  if (Object.keys(rest).length > 0) throw invalidError('request carries unknown fields')
  const validEpoch = validateEpochShape(epoch)
  if (!Array.isArray(records) || records.length === 0) throw invalidError('records must be a non-empty array')
  if (records.length > LIMITS.MAX_BATCH_RECORDS) {
    throw tooLargeError('batch exceeds the configured record bound')
  }
  let batchBytes = 0
  for (const record of records) {
    if (!isPlainRecord(record)) throw invalidError('record must be an object')
    for (const key of Object.keys(record)) {
      if (!ARCHIVE_ALLOWED_KEYS.has(key)) throw invalidError('record carries unknown fields')
    }
    for (const key of ARCHIVE_REQUIRED_KEYS) {
      if (record[key] === undefined) throw invalidError('record is missing required fields')
    }
    const { direction, sender, recipient, body: recordBody, recordKey, bodyHash, deliveryState, messageId, messageBox } = record
    if (direction !== 'inbound' && direction !== 'outbound') throw invalidError('direction must be inbound or outbound')
    if (typeof messageId !== 'string' || typeof messageBox !== 'string' || typeof recordBody !== 'string') {
      throw invalidError('record fields have invalid types')
    }
    if (!isIdentityKey(sender) || !isIdentityKey(recipient)) {
      throw invalidError('sender and recipient must be identity keys')
    }
    if (recordKey !== undefined && (typeof recordKey !== 'string' || !HEX64_RE.test(recordKey))) {
      throw invalidError('recordKey must be 64 lowercase hex chars')
    }
    if (bodyHash !== undefined && (typeof bodyHash !== 'string' || !HEX64_RE.test(bodyHash))) {
      throw invalidError('bodyHash must be 64 lowercase hex chars')
    }
    if (deliveryState !== undefined && !ARCHIVE_DELIVERY_STATES.has(deliveryState as string)) {
      throw invalidError('deliveryState must be prepared or received on archive')
    }
    if (typeof recordBody === 'string') batchBytes += utf8Length(recordBody)
  }
  if (batchBytes > LIMITS.MAX_BATCH_BYTES) {
    throw tooLargeError('batch exceeds the configured byte bound')
  }
  return { epoch: validEpoch, records: records as Array<Record<string, unknown>> }
}

/**
 * M2.2a.1 early batch bounds (mbs-8g5.3.2.1.1): the exact M1 batch-item
 * and batch-byte limits checked on the parsed archive body before
 * authentication, replay-window or repository work, so oversized batches
 * fail typed 413 without touching auth material or state. Shape and content
 * validation (empty records, epoch, per-record fields, direction ownership,
 * per-record MAX_BODY_BYTES outcomes) stay in validateArchiveBatchBody and
 * the repository exactly as before; non-archive or non-array bodies are
 * ignored here. The same typed/redacted ERR_REQUEST_TOO_LARGE envelope and
 * generic description as the route validator; never echoes bodies.
 */
export function assertEarlyBatchBounds(body: unknown): void {
  if (!isRecord(body)) return
  const records = body['records']
  if (!Array.isArray(records)) return
  if (records.length > LIMITS.MAX_BATCH_RECORDS) {
    throw tooLargeError('batch exceeds the configured record bound')
  }
  let batchBytes = 0
  for (const record of records) {
    if (!isRecord(record)) continue
    const recordBody = record['body']
    if (typeof recordBody !== 'string') continue
    batchBytes += utf8Length(recordBody)
    if (batchBytes > LIMITS.MAX_BATCH_BYTES) {
      throw tooLargeError('batch exceeds the configured byte bound')
    }
  }
}

/**
 * Validate PATCH /records/{recordKey}/state input. The path key is
 * authoritative; a body recordKey when present must match it.
 */
export function validatePatchStateInput(args: { pathRecordKey: unknown; body: unknown; query?: unknown }): {
  recordKey: string
  newState: string
  expectedRevision: string
  idempotencyKey: string
} {
  validateMutationQuery(args.query, PATCH_QUERY_ALLOWED_KEYS)
  const recordKey = validatePathRecordKey(args.pathRecordKey)
  if (!isPlainRecord(args.body)) throw invalidError('request body must be a JSON object')
  for (const key of Object.keys(args.body)) {
    if (!PATCH_ALLOWED_KEYS.has(key)) throw invalidError('request carries unknown fields')
  }
  const { recordKey: bodyKey, newState, expectedRevision, idempotencyKey } = args.body
  if (bodyKey !== undefined && bodyKey !== recordKey) {
    throw authError(403, SERVICE_FORBIDDEN_CODE, 'record key does not match the authenticated request')
  }
  if (typeof newState !== 'string' || !DELIVERY_STATES.has(newState)) {
    throw invalidError('newState must be a known delivery state')
  }
  if (typeof expectedRevision !== 'string' || !isUint64DecimalString(expectedRevision)) {
    throw invalidError('expectedRevision must be a uint64 decimal string')
  }
  const validKey = validateIdempotencyShape(idempotencyKey)
  return { recordKey, newState, expectedRevision, idempotencyKey: validKey }
}

/**
 * Extract an optional idempotency key from query or JSON body. Only a key
 * that is absent from both locations is optional; a present value (including
 * null or '') must match the canonical shape instead of silently degrading
 * to an unguarded request.
 */
function optionalIdempotencyKey(query: unknown, body: unknown): string | undefined {
  let fromQuery: unknown
  let fromBody: unknown
  if (isPlainRecord(query)) fromQuery = query['idempotencyKey']
  if (isPlainRecord(body)) fromBody = body['idempotencyKey']
  if (fromQuery !== undefined && fromBody !== undefined && fromQuery !== fromBody) {
    throw invalidError('idempotencyKey must agree across query and body')
  }
  const value = fromBody !== undefined ? fromBody : fromQuery
  if (value === undefined) return undefined
  return validateIdempotencyShape(value)
}

/**
 * Validate DELETE /records/{recordKey} input. Path key is authoritative;
 * idempotencyKey arrives via query or JSON body.
 */
export function validateDeleteOneInput(args: { pathRecordKey: unknown; query: unknown; body: unknown }): {
  recordKey: string
  idempotencyKey: string | undefined
} {
  validateMutationQuery(args.query, DELETE_ONE_QUERY_ALLOWED_KEYS)
  const recordKey = validatePathRecordKey(args.pathRecordKey)
  if (args.body !== undefined && !isPlainRecord(args.body)) {
    throw invalidError('request body must be a JSON object')
  }
  if (isPlainRecord(args.body)) {
    for (const key of Object.keys(args.body)) {
      if (!DELETE_ONE_BODY_ALLOWED_KEYS.has(key)) throw invalidError('request carries unknown fields')
    }
    const { recordKey: bodyKey } = args.body
    if (bodyKey !== undefined && bodyKey !== recordKey) {
      throw authError(403, SERVICE_FORBIDDEN_CODE, 'record key does not match the authenticated request')
    }
  }
  return { recordKey, idempotencyKey: optionalIdempotencyKey(args.query, args.body) }
}

/**
 * Validate DELETE /records (delete-all) input. Both fields are optional;
 * expectedEpoch is carried into the repository's atomic compare-and-set
 * operation; the route must not pre-read live usage.
 */
export function validateDeleteAllInput(args: { query: unknown; body: unknown }): {
  idempotencyKey: string | undefined
  expectedEpoch: string | undefined
} {
  validateMutationQuery(args.query, DELETE_ALL_QUERY_ALLOWED_KEYS)
  if (args.body !== undefined && !isPlainRecord(args.body)) {
    throw invalidError('request body must be a JSON object')
  }
  if (isPlainRecord(args.body)) {
    for (const key of Object.keys(args.body)) {
      if (!DELETE_ALL_BODY_ALLOWED_KEYS.has(key)) throw invalidError('request carries unknown fields')
    }
  }
  const idempotencyKey = optionalIdempotencyKey(args.query, args.body)
  let fromQuery: unknown
  let fromBody: unknown
  if (isPlainRecord(args.query)) fromQuery = args.query['expectedEpoch']
  if (isPlainRecord(args.body)) fromBody = args.body['expectedEpoch']
  if (fromQuery !== undefined && fromBody !== undefined && fromQuery !== fromBody) {
    throw invalidError('expectedEpoch must agree across query and body')
  }
  const raw = fromBody !== undefined ? fromBody : fromQuery
  // Absent means neither location carried the key. A present null/'' would
  // otherwise drop the CAS guard and let a signed malformed request purge
  // without compare-and-set, so every present value is shape-validated.
  if (raw === undefined) return { idempotencyKey, expectedEpoch: undefined }
  return { idempotencyKey, expectedEpoch: validateEpochShape(raw) }
}

/**
 * M2.1d retrieval validation (mbs-8g5.3.1.4). HTTP-layer shape checks only;
 * cursor cryptography, filter identity, epoch binding, watermark pinning,
 * TTL/expiry, retention gaps and snapshot invalidation stay in M1. Opaque
 * cursors are delegated unchanged (never parsed or re-encoded here).
 * Descriptions are generic and never echo cursors, bodies, keys, filters,
 * or auth material.
 */

const SNAPSHOT_ID_RE = /^snap_[0-9a-f]{32}$/
/**
 * Canonical keyset timestamp grammar: exactly the UTC spellings repository
 * adapters emit (Date#toISOString, SQLite strftime %f, MySQL toIso) — full
 * date and second precision, optional 1..6-digit fraction, literal T and Z.
 * Date.parse alone would also admit '0', date-only, RFC-7231 and offset
 * forms; memory/SQLite compare the raw text while MySQL truncates to
 * seconds, so noncanonical values page differently per adapter.
 */
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/
const BROWSE_QUERY_KEYS = new Set(['direction', 'messageBox', 'participant', 'limit', 'afterCreatedAt', 'afterRecordKey'])
const CHANGES_QUERY_KEYS = new Set(['cursor', 'limit', 'direction', 'messageBox', 'participant'])
const SNAPSHOT_PAGE_QUERY_KEYS = new Set(['snapshotId', 'cursor', 'limit'])
const SNAPSHOT_CREATE_ALLOWED_KEYS = new Set(['filter'])
const SNAPSHOT_FILTER_ALLOWED_KEYS = new Set(['direction', 'messageBox', 'participant'])

function invalidCursorError(description = 'invalid request'): Error & { code: string; statusCode: number } {
  return authError(400, SERVICE_INVALID_CURSOR_CODE, description)
}

function expiredCursorError(description = 'cursor expired; take a full snapshot'): Error & { code: string; statusCode: number } {
  const error = new Error(description) as Error & { code: string; statusCode: number }
  error.code = SERVICE_CURSOR_EXPIRED_CODE
  error.statusCode = 410
  return error
}

function parseLimitParam(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw invalidError('limit must be an integer 1..1000')
  }
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > LIMITS.MAX_PAGE_RECORDS) {
    throw invalidError('limit must be an integer 1..1000')
  }
  return n
}

function parseCursorParam(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
    throw invalidCursorError('cursor is not valid for this request')
  }
  return value
}

function extractFeedFilter(query: Record<string, unknown>): { direction?: string; messageBox?: string; participant?: string } {
  const filter: { direction?: string; messageBox?: string; participant?: string } = {}
  if (query['direction'] !== undefined) {
    const direction = query['direction']
    if (direction !== 'inbound' && direction !== 'outbound') throw invalidError('direction must be inbound or outbound')
    filter.direction = direction as string
  }
  if (query['messageBox'] !== undefined) {
    const messageBox = query['messageBox']
    if (typeof messageBox !== 'string' || messageBox.length === 0) throw invalidError('messageBox must be a non-empty string')
    filter.messageBox = messageBox
  }
  if (query['participant'] !== undefined) {
    const participant = query['participant']
    if (typeof participant !== 'string' || !isIdentityKey(participant)) {
      throw invalidError('participant must be an identity key')
    }
    filter.participant = participant
  }
  return filter
}

/**
 * Validate GET /v1/history/records (browse) query. Live keyset over
 * (createdAt, recordKey); non-authoritative, never a convergence primitive.
 */
export function validateBrowseQuery(query: unknown): {
  filter: { direction?: string; messageBox?: string; participant?: string }
  limit: number | undefined
  after: { createdAt: string; recordKey: string } | null
} {
  if (!isPlainRecord(query)) throw invalidError('query must be an object')
  for (const key of Object.keys(query)) {
    if (!BROWSE_QUERY_KEYS.has(key)) throw invalidError('query carries unknown fields')
  }
  const record = query as Record<string, unknown>
  const filter = extractFeedFilter(record)
  const limit = parseLimitParam(record['limit'])
  const afterCreatedAt = record['afterCreatedAt']
  const afterRecordKey = record['afterRecordKey']
  if ((afterCreatedAt === undefined) !== (afterRecordKey === undefined)) {
    throw invalidError('afterCreatedAt and afterRecordKey must be supplied together')
  }
  if (afterCreatedAt === undefined || afterCreatedAt === null || afterCreatedAt === '') {
    if (afterRecordKey !== undefined && afterRecordKey !== null && afterRecordKey !== '') {
      throw invalidError('afterCreatedAt and afterRecordKey must be supplied together')
    }
    return { filter, limit, after: null }
  }
  if (typeof afterCreatedAt !== 'string' || !CANONICAL_TIMESTAMP_RE.test(afterCreatedAt)) {
    throw invalidError('afterCreatedAt must be an ISO timestamp')
  }
  // Reject out-of-range components ('2026-02-30…') that Date.parse would
  // silently roll over: the second-precision prefix must round-trip exactly.
  const parsed = Date.parse(afterCreatedAt)
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 19) !== afterCreatedAt.slice(0, 19)) {
    throw invalidError('afterCreatedAt must be an ISO timestamp')
  }
  if (typeof afterRecordKey !== 'string' || !HEX64_RE.test(afterRecordKey) || !isRecordKey(afterRecordKey)) {
    throw invalidError('afterRecordKey must be 64 lowercase hex chars')
  }
  return { filter, limit, after: { createdAt: afterCreatedAt, recordKey: afterRecordKey } }
}

/**
 * Validate GET /v1/history/changes query. The opaque cursor (when present)
 * is delegated unchanged to M1, which binds owner/epoch/feed/filter/W/
 * position/expiry; the accompanying filter fields must equal the cursor's
 * filter digest or M1 fails with ERR_INVALID_CURSOR.
 */
export function validateChangesQuery(query: unknown): {
  cursor: string | null
  limit: number | undefined
  filter: { direction?: string; messageBox?: string; participant?: string }
} {
  if (!isPlainRecord(query)) throw invalidError('query must be an object')
  for (const key of Object.keys(query)) {
    if (!CHANGES_QUERY_KEYS.has(key)) throw invalidError('query carries unknown fields')
  }
  const record = query as Record<string, unknown>
  const filter = extractFeedFilter(record)
  return { cursor: parseCursorParam(record['cursor']), limit: parseLimitParam(record['limit']), filter }
}

/** Validate a snapshotId query/body value (snap_ + 32 lowercase hex). */
export function validateSnapshotIdShape(value: unknown): string {
  if (typeof value !== 'string' || !SNAPSHOT_ID_RE.test(value)) {
    throw invalidCursorError('snapshot identifier is not valid for this request')
  }
  return value
}

/**
 * Validate GET /v1/history/snapshot paging query. Filter binding lives in
 * the stored snapshot (filterHash); no per-request filter is accepted here
 * so callers cannot smuggle a new filter onto an old watermark.
 */
export function validateSnapshotPageQuery(query: unknown): {
  snapshotId: string
  cursor: string | null
  limit: number | undefined
} {
  if (!isPlainRecord(query)) throw invalidError('query must be an object')
  for (const key of Object.keys(query)) {
    if (!SNAPSHOT_PAGE_QUERY_KEYS.has(key)) throw invalidError('query carries unknown fields')
  }
  const record = query as Record<string, unknown>
  const snapshotId = validateSnapshotIdShape(record['snapshotId'])
  return { snapshotId, cursor: parseCursorParam(record['cursor']), limit: parseLimitParam(record['limit']) }
}

/**
 * Validate POST /v1/history/snapshot creation body against the canonical
 * snapshotCreateRequest schema: an optional object filter and nothing else.
 * Filter values are checked for shape here; M1 validates canonical bounds
 * and hashes the canonical filter identity. Snapshot idempotency is not part
 * of the implemented repository contract, so idempotencyKey is rejected as
 * an unknown field instead of being silently discarded, and a present null
 * body/filter is rejected rather than normalized to an empty filter.
 */
export function validateSnapshotCreateBody(body: unknown): {
  filter: { direction?: string; messageBox?: string; participant?: string }
} {
  if (body === undefined) return { filter: {} }
  if (!isPlainRecord(body)) throw invalidError('request body must be a JSON object')
  for (const key of Object.keys(body)) {
    if (!SNAPSHOT_CREATE_ALLOWED_KEYS.has(key)) throw invalidError('request carries unknown fields')
  }
  const record = body as Record<string, unknown>
  const rawFilter = record['filter']
  if (rawFilter === undefined) return { filter: {} }
  if (!isPlainRecord(rawFilter)) throw invalidError('filter must be an object')
  for (const key of Object.keys(rawFilter)) {
    if (!SNAPSHOT_FILTER_ALLOWED_KEYS.has(key)) throw invalidError('filter carries unknown fields')
  }
  const typed = rawFilter as Record<string, unknown>
  const filter: { direction?: string; messageBox?: string; participant?: string } = {}
  if (typed['direction'] !== undefined) {
    if (typed['direction'] !== 'inbound' && typed['direction'] !== 'outbound') {
      throw invalidError('filter.direction must be inbound or outbound')
    }
    filter.direction = typed['direction'] as string
  }
  if (typed['messageBox'] !== undefined) {
    if (typeof typed['messageBox'] !== 'string' || (typed['messageBox'] as string).length === 0) {
      throw invalidError('filter.messageBox must be a non-empty string')
    }
    filter.messageBox = typed['messageBox'] as string
  }
  if (typed['participant'] !== undefined) {
    if (typeof typed['participant'] !== 'string' || !isIdentityKey(typed['participant'] as string)) {
      throw invalidError('filter.participant must be an identity key')
    }
    filter.participant = typed['participant'] as string
  }
  return { filter }
}

/** Validate GET /v1/history/usage query (no parameters; unknown keys reject). */
export function validateUsageQuery(query: unknown): Record<string, never> {
  if (query === undefined || query === null) return {}
  if (!isPlainRecord(query)) throw invalidError('query must be an object')
  if (Object.keys(query).length > 0) throw invalidError('query carries unknown fields')
  return {}
}

/**
 * M2.1e capabilities document (mbs-8g5.3.1.5). Built exclusively from the
 * canonical limits and protocol version, the enforced retention policy, the
 * frozen feature list, and the caller's own epoch. Carries no record/byte
 * counts, no other owner's state, no MySQL/connection detail and no auth
 * material; the frozen M1 capabilities schema rejects any extra field.
 *
 * Retention is always the enforced policy `permanent`
 * (mbs-8g5.3.1.5.2): finite active-record retention is deferred until it
 * expires records and releases quota through the existing deletion
 * primitives, so capabilities never advertises a value that no repository
 * operation honors (FR-010 effective-limits contract).
 */
export function buildCapabilities(args: { epoch: string }): Capabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    epoch: args.epoch,
    maxRecordsPerOwner: LIMITS.MAX_RECORDS_PER_OWNER,
    maxBytesPerOwner: LIMITS.MAX_BYTES_PER_OWNER,
    maxBodyBytes: LIMITS.MAX_BODY_BYTES,
    maxBatchRecords: LIMITS.MAX_BATCH_RECORDS,
    maxBatchBytes: LIMITS.MAX_BATCH_BYTES,
    maxPageRecords: LIMITS.MAX_PAGE_RECORDS,
    maxPageBytes: LIMITS.MAX_PAGE_BYTES,
    retention: 'permanent',
    supportedFeatures: [...SERVICE_SUPPORTED_FEATURES],
  }
}

/**
 * Map repository/adapter errors to stable HTTP envelopes. Known M1 codes
 * keep their code; descriptions stay generic and never echo bodies, keys,
 * cursors, or auth material. Unknown errors become 500 ERR_INTERNAL.
 *
 * Read-path mapping (mbs-8g5.3.1.4): tampered/cross-owner/watermark/feed
 * cursor misuse is 400 ERR_INVALID_CURSOR; purged retention gaps,
 * invalidated/expired snapshots and deleted-body convergence are 410
 * ERR_CURSOR_EXPIRED with a snapshot-recovery hint; epoch rotation is 409
 * ERR_EPOCH_CHANGED. Single-record page overflow stays 413.
 */
export function mapRepositoryError(error: unknown): { status: number; code: string; description: string } {
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string') {
    switch (code) {
      case SERVICE_INVALID_CODE:
      case SERVICE_INVALID_CURSOR_CODE:
        return { status: code === SERVICE_INVALID_CURSOR_CODE ? 400 : 400, code, description: 'invalid request' }
      case SERVICE_CURSOR_EXPIRED_CODE:
        return { status: 410, code, description: 'cursor expired; take a full snapshot' }
      case SERVICE_REVISION_CODE:
      case SERVICE_CONFLICT_CODE:
      case SERVICE_EPOCH_CODE:
      case SERVICE_IDEMPOTENCY_CODE:
      case SERVICE_EPOCH_EXHAUSTED_CODE:
      case SERVICE_QUOTA_CODE:
        return { status: 409, code, description: 'request conflicts with current state' }
      case SERVICE_TOO_LARGE_CODE:
        return { status: 413, code, description: 'request exceeds the configured limit' }
      case SERVICE_AUTH_CODE:
        return { status: 401, code, description: 'authentication required' }
      case SERVICE_FORBIDDEN_CODE:
        return { status: 403, code, description: 'forbidden' }
      case SERVICE_RATE_LIMITED_CODE:
        return { status: 429, code, description: 'rate limited' }
      case SERVICE_UNAVAILABLE_CODE:
        return { status: 503, code, description: 'service unavailable' }
      case SERVICE_INTERNAL_CODE:
        return { status: 500, code, description: 'internal error' }
      default:
        break
    }
    if (code.startsWith('ERR_')) {
      return { status: 500, code: SERVICE_UNAVAILABLE_CODE, description: 'service unavailable' }
    }
  }
  return { status: 500, code: SERVICE_INTERNAL_CODE, description: 'internal error' }
}

function placeholderError(description: string): { status: 'error'; code: string; description: string } {
  return { status: 'error', code: SERVICE_UNAVAILABLE_CODE, description }
}

async function defaultMigrate(knex: ServiceKnex): Promise<string[]> {
  // @ts-ignore - M1 runtime adapters are frozen .mjs; typed via storage.ts boundary
  const repository = (await import('./repository.mysql.mjs')) as {
    migrateMysql(knex: unknown, chain?: unknown, hooks?: unknown): Promise<string[]>
  }
  // @ts-ignore - M1 migration chain is frozen .mjs; checksums verified at runtime
  const migrations = (await import('./migrations.mjs')) as {
    verifyMysqlSchema(knex: unknown): Promise<boolean>
  }
  const versions = await repository.migrateMysql(knex as never)
  await migrations.verifyMysqlSchema(knex as never)
  return versions
}

async function defaultCreateKnex(mysql: ServiceMysqlConfig): Promise<ServiceKnex> {
  // @ts-ignore - M1 runtime adapters are frozen .mjs; typed via storage.ts boundary
  const repository = (await import('./repository.mysql.mjs')) as {
    createMysqlKnex(args: { host: string; port: number; user: string; password: string; database: string }): Promise<ServiceKnex>
  }
  return repository.createMysqlKnex({ ...mysql })
}

async function defaultCreateStore(knex: ServiceKnex, _config: ServiceConfig): Promise<HistoryRepository> {
  // @ts-ignore - M1 runtime adapters are frozen .mjs; typed via storage.ts boundary
  const repository = (await import('./repository.mysql.mjs')) as {
    createMysqlStore(knex: unknown, options?: unknown): HistoryRepository
  }
  return repository.createMysqlStore(knex as never)
}

async function defaultCreateServerWallet(): Promise<unknown> {
  const sdk = (await import('@bsv/sdk')) as unknown as {
    PrivateKey: { fromRandom(): unknown }
    ProtoWallet: new (key: unknown) => unknown
  }
  return new sdk.ProtoWallet(sdk.PrivateKey.fromRandom())
}

async function defaultCreateSessionManager(): Promise<unknown> {
  const sdk = (await import('@bsv/sdk')) as unknown as { SessionManager: new () => unknown }
  return new sdk.SessionManager()
}

async function defaultCreateAuthMiddleware(args: { wallet: unknown; sessionManager: unknown }): Promise<RequestHandler> {
  const mod = (await import('@bsv/auth-express-middleware')) as unknown as {
    createAuthMiddleware(options: { wallet: unknown; sessionManager: unknown }): RequestHandler
  }
  // No logger: lifecycle metadata without secret-bearing payloads is disabled
  // entirely rather than risking auth material in logs. Public middleware
  // errors are stable and never include headers, bodies, or wallet data.
  return mod.createAuthMiddleware({ wallet: args.wallet, sessionManager: args.sessionManager })
}

/**
 * Assemble the Express app. Public liveness (/healthz) performs no
 * dependency checks and never invokes checkReadiness or checkDatabase;
 * public readiness (/ready) is 503 until migrate() has verified MySQL
 * migrations AND a database probe that is present, non-throwing and true —
 * always with the same non-sensitive envelope (mbs-8g5.3.1.5.1 fail-closed). The four M2.1c mutation
 * routes, five M2.1d retrieval routes and the M2.1e capabilities route live
 * behind the unsigned-request gate, the public auth middleware and the
 * reusable replay window over the injected M1 repository.
 *
 * Auth layout: the exact `/.well-known/auth` handshake stays reachable
 * before the middleware; every other application request (capability,
 * mutation/read routes, probe, authenticated 404) must carry auth headers,
 * then passes the middleware plus the shared replay window, which skips only
 * the exact handshake path. Unauthenticated capability/mutation/read
 * requests fail with the service's schema-valid 401 before route resolution
 * (no existence oracle); conflicting owner claims fail 403 before any
 * repository access. Read routes delegate opaque cursors, filters, epoch,
 * watermark and TTL semantics to M1 without reimplementing them; the HTTP
 * layer validates only shapes (unknown fields, limit, snapshotId, after
 * keyset) and owner-claim agreement. Capabilities publish only canonical
 * limits, configured retention, frozen features and the caller's epoch.
 *
 * M2.2a.1 ingress (mbs-8g5.3.2.1.1): exact configured origin/CORS policy
 * plus early HTTP body, batch-item and batch-byte bounds run before any
 * authentication, replay-window or repository work. Exact HTTPS origins
 * from configuration get exact CORS headers (preflight answered before
 * authentication); an absent Origin keeps the private non-browser contract;
 * any other present Origin fails closed 403 without permissive headers.
 * The early bounds reuse the accepted M1 LIMITS constants and the existing
 * typed/redacted 413 envelope. Per-record MAX_BODY_BYTES outcomes, rate/
 * concurrency controls, cleanup and logging remain out of scope.
 *
 * Express/middleware are imported lazily so the server subpath remains
 * importable in a clean packed consumer without server peers installed.
 */
export async function createServiceApp(state: ServiceAppState): Promise<Express> {
  const { default: express } = (await import('express')) as unknown as { default: typeof import('express') }
  const app = express()
  app.disable('x-powered-by')

  // M2.2a.1 exact origin/CORS gate (first middleware, mbs-8g5.3.2.1.1):
  // absent Origin keeps the private non-browser contract (proceed with no
  // Access-Control headers); an Origin exactly equal to a configured HTTPS
  // origin gets the exact CORS headers, with preflight answered here before
  // any body read, authentication or repository work; any other present
  // Origin (including null, malformed, path/case/port variants and entries
  // outside configuration) fails closed 403 with no permissive headers.
  // Vary: Origin is set on every present-Origin response so shared caches
  // never serve one origin's view to another. No wildcard forms exist.
  const allowedOrigins = new Set(state.allowedOrigins ?? [])
  app.use((req, res, next) => {
    const rawOrigin = req.headers['origin']
    if (rawOrigin === undefined) {
      next()
      return
    }
    res.setHeader('Vary', 'Origin')
    const origin = typeof rawOrigin === 'string' ? rawOrigin : ''
    if (!allowedOrigins.has(origin)) {
      next(authError(403, SERVICE_FORBIDDEN_CODE, 'forbidden'))
      return
    }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS)
    const requestedMethod = req.headers['access-control-request-method']
    if (req.method === 'OPTIONS' && typeof requestedMethod === 'string' && requestedMethod.length > 0) {
      res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS)
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
      res.setHeader('Access-Control-Max-Age', CORS_PREFLIGHT_MAX_AGE)
      res.status(204).end()
      return
    }
    next()
  })

  // M2.2a.1 early HTTP body bound from Content-Length before the body is
  // read or any authentication/repository work runs (mbs-8g5.3.2.1.1).
  // Non-numeric or absent Content-Length falls through to express.json's
  // streaming bound below, which is the enforcement of record for chunked
  // or understated bodies. Exact boundary (== limit) proceeds; +1 fails
  // typed 413 here. express.json stays registered for the parsed body the
  // routes need.
  app.use((req, _res, next) => {
    const contentLength = req.headers['content-length']
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > LIMITS.MAX_HTTP_BODY_BYTES) {
      next(tooLargeError())
      return
    }
    next()
  })

  // Parse every valid JSON value so route validators can consistently reject
  // primitive/array bodies with the authenticated typed error envelope. The
  // mutation contracts themselves still require plain JSON objects. The auth
  // middleware serializes primitive JSON bodies as raw bytes, so retain the
  // exact bytes and expose to it before protected routes run.
  app.use(express.json({
    limit: LIMITS.MAX_HTTP_BODY_BYTES,
    strict: false,
    verify(request, _response, buffer) {
      rawJsonBodies.set(request, Buffer.from(buffer))
    },
  }))

  // M2.2a.1 early batch bounds for the archive route, before authentication
  // (mbs-8g5.3.2.1.1). Route-level validateArchiveBatchBody keeps the full
  // shape/content contract (defense in depth plus per-record outcomes).
  app.use((req, _res, next) => {
    try {
      if (req.method === 'POST' && (req.path === ARCHIVE_BATCH_PATH || req.path === `${ARCHIVE_BATCH_PATH}/`)) {
        assertEarlyBatchBounds(req.body)
      }
      next()
    } catch (error) {
      next(error)
    }
  })

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', version: state.version })
  })

  // Readiness (mbs-8g5.3.1.5, fail-closed probe gate mbs-8g5.3.1.5.1):
  // public, two gates, no connection detail. First the migration gate
  // (verified schema versions), then the database probe. The probe is
  // REQUIRED for a ready result: absent, throwing and false all return the
  // same typed ERR_UNAVAILABLE 503 with a generic description — never host,
  // port, user, database, credential, driver text or probe error. Liveness
  // above stays dependency-free and invokes neither check.
  app.get('/ready', async (_req: Request, res: Response) => {
    const readiness = state.checkReadiness()
    if (!readiness.ready) {
      res.status(503).json(placeholderError('service not ready: migrations not verified'))
      return
    }
    let databaseReady = false
    if (state.checkDatabase) {
      try {
        databaseReady = (await state.checkDatabase()) === true
      } catch {
        databaseReady = false
      }
    }
    if (!databaseReady) {
      res.status(503).json(placeholderError('service not ready: database unavailable'))
      return
    }
    res.status(200).json({ status: 'ready', version: state.version })
  })

  const requireRepository = (): HistoryRepository => {
    if (!state.repository) {
      throw authError(501, SERVICE_UNAVAILABLE_CODE, 'service not ready: repository not configured')
    }
    return state.repository
  }

  const requireServerSecret = (): string => {
    if (typeof state.serverSecret !== 'string' || state.serverSecret.length < 16) {
      throw authError(501, SERVICE_UNAVAILABLE_CODE, 'service not ready: repository not configured')
    }
    return state.serverSecret
  }

  const sendRepositoryError = (error: unknown, next: NextFunction): void => {
    const mapped = mapRepositoryError(error)
    next(authError(mapped.status, mapped.code, mapped.description))
  }

  if (state.authMiddleware) {
    app.use((req, _res, next) => {
      if (req.is('application/json') &&
          (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body))) {
        const rawBody = rawJsonBodies.get(req)
        if (rawBody) req.body = rawBody
      }
      next()
    })
    // Unsigned-request gate ahead of the public middleware (mbs-8g5.3.1.5).
    // A header-less request (other than the exact handshake path) fails closed
    // with this service's schema-valid redacted 401 envelope, so every
    // protected route reports one error contract instead of the middleware's
    // upstream shape. Presence only: signatures, sessions and malformed or
    // expired material are still verified and classified by the middleware,
    // and the replay window still records only middleware-verified request ids.
    app.use((req, _res, next) => {
      if (req.path === AUTH_HANDSHAKE_PATH) {
        next()
        return
      }
      const signature = req.headers['x-bsv-auth-signature']
      const requestId = req.headers['x-bsv-auth-request-id']
      if ((typeof signature !== 'string' || signature.length === 0) ||
          (typeof requestId !== 'string' || requestId.length === 0)) {
        next(authError(401, SERVICE_AUTH_CODE, 'authentication required'))
        return
      }
      next()
    })
    app.use(state.authMiddleware)
    // One reusable replay window for every protected application request
    // behind this middleware (mbs-8g5.3.1.2.1). The guard skips the exact
    // handshake path and otherwise requires a fresh request-id; see
    // createReplayGuard for the window (not single-use) semantics.
    app.use(createReplayGuard().middleware)
  }

  const handleArchiveBatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      validateMutationQuery(req.query, ARCHIVE_QUERY_ALLOWED_KEYS)
      const { epoch, records } = validateArchiveBatchBody(req.body)
      // Ownership gate before any repository access (403 on direction
      // mismatch). Per-record content stays a repository outcome.
      assertArchiveOwnership({ owner: ownerIdentityKey, records })
      const repository = requireRepository()
      const result = await repository.archiveBatch({
        owner: ownerIdentityKey,
        epoch,
        records: records as unknown as Parameters<HistoryRepository['archiveBatch']>[0]['records'],
      })
      res.status(200).json(result)
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  const handlePatchState = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      const { recordKey, newState, expectedRevision, idempotencyKey } = validatePatchStateInput({
        pathRecordKey: (req.params as Record<string, unknown>)?.['recordKey'],
        query: req.query,
        body: req.body,
      })
      const repository = requireRepository()
      if (typeof (repository as { patchState?: unknown }).patchState !== 'function') {
        next(authError(501, SERVICE_UNAVAILABLE_CODE, 'service not ready: repository not configured'))
        return
      }
      const result = await (repository as HistoryRepository & {
        patchState(args: { owner: string; recordKey: string; newState: string; expectedRevision: string; idempotencyKey: string }): Promise<unknown>
      }).patchState({ owner: ownerIdentityKey, recordKey, newState, expectedRevision, idempotencyKey })
      res.status(200).json(result)
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  const handleDeleteOne = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      const { recordKey, idempotencyKey } = validateDeleteOneInput({
        pathRecordKey: (req.params as Record<string, unknown>)?.['recordKey'],
        query: req.query,
        body: req.body,
      })
      const repository = requireRepository()
      if (typeof (repository as { deleteRecord?: unknown }).deleteRecord !== 'function') {
        next(authError(501, SERVICE_UNAVAILABLE_CODE, 'service not ready: repository not configured'))
        return
      }
      const result = await (repository as HistoryRepository & {
        deleteRecord(args: { owner: string; recordKey: string; idempotencyKey?: string }): Promise<unknown>
      }).deleteRecord(idempotencyKey === undefined
        ? { owner: ownerIdentityKey, recordKey }
        : { owner: ownerIdentityKey, recordKey, idempotencyKey })
      res.status(200).json(result)
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  const handleDeleteAll = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      const { idempotencyKey, expectedEpoch } = validateDeleteAllInput({ query: req.query, body: req.body })
      const repository = requireRepository()
      if (typeof (repository as { deleteAll?: unknown }).deleteAll !== 'function') {
        next(authError(501, SERVICE_UNAVAILABLE_CODE, 'service not ready: repository not configured'))
        return
      }
      const result = await (repository as HistoryRepository & {
        deleteAll(args: { owner: string; idempotencyKey?: string; expectedEpoch?: string }): Promise<unknown>
      }).deleteAll({
        owner: ownerIdentityKey,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
      })
      res.status(200).json(result)
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  app.post(ARCHIVE_BATCH_PATH, handleArchiveBatch)
  app.patch('/v1/history/records/:recordKey/state', handlePatchState)
  app.delete('/v1/history/records/:recordKey', handleDeleteOne)
  app.delete('/v1/history/records', handleDeleteAll)

  /**
   * M2.1d retrieval routes (mbs-8g5.3.1.4). All five sit behind the same
   * auth + replay guard as mutations. Owner comes only from the verified
   * session; conflicting owner claims fail 403 before any repository
   * access. Opaque cursors pass through unchanged to M1, which enforces
   * owner/epoch/feed/filter/watermark/expiry binding, retention gaps and
   * snapshot invalidation. Error envelopes never echo cursors, bodies,
   * keys, filters or auth material.
   */

  const handleBrowse = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      const { filter, limit, after } = validateBrowseQuery(req.query)
      const repository = requireRepository()
      const result = await repository.listBrowse({
        owner: ownerIdentityKey,
        filter: filter as { direction?: 'inbound' | 'outbound'; messageBox?: string; participant?: string },
        ...(limit === undefined ? {} : { limit }),
        ...(after === null ? {} : { after }),
      })
      res.status(200).json({ records: result.items, nextAfter: result.nextAfter })
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  const handleChanges = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      const { cursor, limit, filter } = validateChangesQuery(req.query)
      const repository = requireRepository()
      const serverSecret = requireServerSecret()
      const page = await repository.listChangesPage({
        owner: ownerIdentityKey,
        serverSecret,
        cursor,
        ...(limit === undefined ? {} : { limit }),
        filter: filter as { direction?: 'inbound' | 'outbound'; messageBox?: string; participant?: string },
      })
      res.status(200).json(page)
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  const handleSnapshotCreate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      if (isPlainRecord(req.query) && Object.keys(req.query).length > 0) {
        throw invalidError('query carries unknown fields')
      }
      const { filter } = validateSnapshotCreateBody(req.body)
      const repository = requireRepository()
      const result = await repository.createSnapshot({
        owner: ownerIdentityKey,
        filter: filter as { direction?: 'inbound' | 'outbound'; messageBox?: string; participant?: string },
      })
      res.status(200).json(result)
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  const handleSnapshotPage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      const { snapshotId, cursor, limit } = validateSnapshotPageQuery(req.query)
      const repository = requireRepository()
      const serverSecret = requireServerSecret()
      const page = await repository.listSnapshotPage({
        owner: ownerIdentityKey,
        serverSecret,
        snapshotId,
        cursor,
        ...(limit === undefined ? {} : { limit }),
      })
      if (page === null) {
        next(authError(404, SERVICE_INVALID_CURSOR_CODE, 'invalid request'))
        return
      }
      res.status(200).json(page)
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  const handleUsage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      validateUsageQuery(req.query)
      const repository = requireRepository()
      const usage = await repository.getUsage({ owner: ownerIdentityKey })
      res.status(200).json(usage)
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  /**
   * M2.1e capabilities route (mbs-8g5.3.1.5), behind the same unsigned gate,
   * auth middleware and replay window as every other protected route. Owner
   * comes only from the verified session; conflicting owner claims fail 403
   * before repository access, and the route takes no query parameters. The
   * response is built by buildCapabilities from effective configuration plus
   * this owner's current epoch: no record/byte counts, no other owner's
   * state, no MySQL/connection detail, no auth material. Retention is the
   * enforced policy only (`permanent`, mbs-8g5.3.1.5.2). A repository epoch
   * that violates the canonical epoch grammar fails closed as 500 rather
   * than emitting a schema-invalid document.
   */
  const handleCapabilities = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      validateUsageQuery(req.query)
      const repository = requireRepository()
      const usage = await repository.getUsage({ owner: ownerIdentityKey })
      const epoch = usage.epoch
      if (typeof epoch !== 'string' || !EPOCH_RE.test(epoch)) {
        const error = new TypeError('repository reported a non-canonical epoch') as Error & { code: string }
        error.code = SERVICE_INTERNAL_CODE
        throw error
      }
      res.status(200).json(buildCapabilities({ epoch }))
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode
      if (Number.isSafeInteger(statusCode)) {
        next(error)
        return
      }
      sendRepositoryError(error, next)
    }
  }

  // Browse shares the archive collection path with a different method:
  // POST archives, GET browses the live keyset (non-authoritative).
  app.get('/v1/history/records', handleBrowse)
  app.get('/v1/history/changes', handleChanges)
  app.post('/v1/history/snapshot', handleSnapshotCreate)
  app.get('/v1/history/snapshot', handleSnapshotPage)
  app.get('/v1/history/usage', handleUsage)
  app.get('/v1/history/capabilities', handleCapabilities)

  // M2.1b test probe (not frozen API): proves the verified identity is the
  // only owner selector and that ownership is enforced before any repository
  // access. Never calls the repository. Later beads implement real routes
  // over the same adapter and move them behind the middleware.
  const probeRecords = (req: Request): unknown => {
    if (!isRecord(req.body)) return undefined
    return (req.body as Record<string, unknown>)['records']
  }
  const handleProbe = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const { ownerIdentityKey } = resolveRequestOwner(req as { auth?: { identityKey?: unknown } | null })
      assertNoOwnerOverride({ owner: ownerIdentityKey, body: req.body, query: req.query, params: req.params })
      const { checkedRecords } = assertArchiveOwnership({ owner: ownerIdentityKey, records: probeRecords(req) })
      res.status(200).json({ status: 'ok', ownerIdentityKey, checkedRecords })
    } catch (error) {
      next(error)
    }
  }
  app.get(AUTH_PROBE_PATH, handleProbe)
  app.post(AUTH_PROBE_PATH, handleProbe)
  // Path-claim variant: the `:owner` param name intentionally matches the
  // rejected claim key so body/query/path overrides share one check.
  app.get(`${AUTH_PROBE_PATH}/:owner`, handleProbe)

  // Typed JSON 404 without leaking paths or bodies.
  app.use((_req: Request, res: Response) => {
    res.status(404).json(placeholderError('unknown route'))
  })

  // Typed JSON error boundary without stack traces, body echo, or auth
  // material. Adapter errors carry a stable statusCode; everything else keeps
  // the M2.1 mapping with generic descriptions. Read-path additions: 404
  // preserves the repository code for unknown snapshotIds; 410 carries the
  // snapshot-recovery hint for retention gaps and invalidated/expired
  // snapshots.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
    const statusCode = (err as { statusCode?: unknown })?.statusCode
    const code = (err as { code?: unknown })?.code
    if (Number.isSafeInteger(statusCode) && typeof code === 'string') {
      if (statusCode === 401) {
        res.status(401).json({ status: 'error', code, description: 'authentication required' })
        return
      }
      if (statusCode === 403) {
        res.status(403).json({ status: 'error', code, description: 'forbidden' })
        return
      }
      if (statusCode === 400) {
        res.status(400).json({ status: 'error', code, description: 'invalid request' })
        return
      }
      if (statusCode === 404) {
        res.status(404).json({ status: 'error', code, description: 'invalid request' })
        return
      }
      if (statusCode === 409) {
        res.status(409).json({ status: 'error', code, description: 'request conflicts with current state' })
        return
      }
      if (statusCode === 410) {
        res.status(410).json({ status: 'error', code, description: 'cursor expired; take a full snapshot' })
        return
      }
      if (statusCode === 413) {
        res.status(413).json({ status: 'error', code, description: 'request exceeds the configured limit' })
        return
      }
      if (statusCode === 429) {
        res.status(429).json({ status: 'error', code, description: 'rate limited' })
        return
      }
      if (statusCode === 501) {
        res.status(501).json({ status: 'error', code, description: 'service not ready: repository not configured' })
        return
      }
      if (statusCode === 503) {
        res.status(503).json({ status: 'error', code, description: 'service unavailable' })
        return
      }
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ status: 'error', code: 'ERR_INVALID_RECORD', description: 'request body is not valid JSON' })
      return
    }
    if (err instanceof Error && (err as Error & { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ status: 'error', code: 'ERR_REQUEST_TOO_LARGE', description: 'request body exceeds the configured limit' })
      return
    }
    if (typeof code === 'string' && code.length > 0) {
      res.status(500).json({ status: 'error', code: SERVICE_UNAVAILABLE_CODE, description: 'service unavailable' })
      return
    }
    res.status(500).json({ status: 'error', code: 'ERR_INTERNAL', description: 'internal error' })
  })

  return app
}

/**
 * Compose the standalone service. Validates config, resolves Knex/store
 * (injected fakes for tests or real MySQL otherwise), binds the public
 * BRC-103/BRC-104 middleware with an injectable server wallet and session
 * manager, assembles the router, and returns explicit start/stop ownership.
 * Migrations are verified via migrate() and the MySQL probe must still
 * succeed before checkReadiness()-gated GET /ready reports ready; the probe
 * is required for ready (absent/throwing/false fail closed) and never
 * exposes connection detail. Capabilities publish only the enforced
 * retention policy (`permanent` until finite enforcement ships).
 */
export async function createService(options: ServiceOptions): Promise<Service> {
  const config = validateServiceConfig(options.config)
  const migrateFn = options.migrate ?? defaultMigrate
  let knex = options.knex ?? null
  let ownsKnex = options.knex === undefined
  if (!knex && !options.store) {
    knex = await defaultCreateKnex(config.mysql)
    ownsKnex = true
  }
  let repository = options.store ?? null
  if (!repository) {
    if (!knex) {
      throw configError('knex or store is required when mysql construction is deferred', SERVICE_MYSQL_CODE)
    }
    repository = await defaultCreateStore(knex, config)
  }
  // When only a store is injected (unit tests), knex may remain null until a
  // real migration is requested. Readiness stays false until migrate() can
  // verify against a knex handle.
  const resolvedKnex = knex as ServiceKnex | null
  const resolvedStore = repository as HistoryRepository
  let versions: string[] | null = null
  let server: import('node:http').Server | null = null

  const sessionManager = options.auth?.sessionManager ?? await defaultCreateSessionManager()
  const wallet = options.auth?.wallet ?? await defaultCreateServerWallet()
  const authMiddleware = await defaultCreateAuthMiddleware({ wallet, sessionManager })

  const checkReadiness = (): ReadinessStatus => ({ ready: versions !== null, versions })

  // Non-sensitive MySQL readiness probe (mbs-8g5.3.1.5): a trivial round-trip
  // against the resolved Knex handle. Resolves a boolean and never throws or
  // logs, so driver/host/credential text can never reach the response.
  const checkDatabase = async (): Promise<boolean> => {
    if (!resolvedKnex) return false
    try {
      await resolvedKnex.raw('select 1')
      return true
    } catch {
      return false
    }
  }

  const app = await createServiceApp({
    checkReadiness,
    version: config.version,
    checkDatabase,
    authMiddleware,
    repository: resolvedStore,
    serverSecret: config.serverSecret,
    allowedOrigins: config.allowedOrigins,
  })

  async function migrate(): Promise<string[]> {
    const target = resolvedKnex ?? options.knex ?? null
    if (!target) {
      const error = configError('migrations require a knex handle', SERVICE_MIGRATION_CODE) as Error & { code: string }
      error.code = SERVICE_MIGRATION_CODE
      throw error
    }
    try {
      versions = await migrateFn(target)
    } catch (error) {
      versions = null
      throw error
    }
    return versions
  }

  async function start(port = 0, host = '127.0.0.1'): Promise<import('node:http').Server> {
    if (server) return server
    server = await new Promise<import('node:http').Server>((resolve, reject) => {
      const created = app.listen(port, host, () => resolve(created))
      created.once('error', reject)
    })
    return server
  }

  async function stop(): Promise<void> {
    if (!server) return
    const closing = server
    server = null
    await new Promise<void>((resolve, reject) => {
      closing.close((error?: Error) => (error ? reject(error) : resolve()))
    })
  }

  async function close(): Promise<void> {
    await stop()
    if (ownsKnex && resolvedKnex) {
      await resolvedKnex.destroy()
    }
  }

  return {
    app,
    config,
    knex: (resolvedKnex ?? options.knex ?? { raw: async () => { throw configError('knex not configured', SERVICE_MYSQL_CODE) }, destroy: async () => {} }) as ServiceKnex,
    repository: resolvedStore,
    ownsKnex,
    sessionManager,
    migrate,
    checkReadiness,
    start,
    stop,
    close,
  }
}
