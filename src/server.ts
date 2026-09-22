/**
 * Typed M1+ server surface (mbs-8g5.2.2.1) plus M2.1a composition boundary
 * (mbs-8g5.3.1.1), M2.1b auth binding (mbs-8g5.3.1.2), M2.1c mutations
 * (mbs-8g5.3.1.3) and M2.1d retrieval routes (mbs-8g5.3.1.4). Server-only
 * subpath: Express route adapter types and the standalone service live here
 * so browser bundles never include them.
 *
 * Runtime server dependencies (express, auth middleware, sdk, and later
 * authenticated-route deps) are optional peers: a browser/clean consumer
 * without them can still resolve types, while a service install provides
 * them. Browser-safe modules (mod/protocol/client/canonical) must never
 * import this subpath.
 */
import type { ArchiveBatchRequest, ArchiveBatchResponse, HistoryPage, StoreError } from './protocol.js'

export interface AuthenticatedIdentity {
  ownerIdentityKey: string
}

export interface HistoryRoutesOptions {
  /** Shared secret for HMAC cursor integrity (operator secret, never logged). */
  serverSecret: string
}

export interface RouteResult<T> {
  status: number
  body: T | StoreError
}

// Route shapes reference the shared wire types; the Express adapter itself is
// implemented in M2 and is not part of this M1 typing bead.
export type ArchiveRoute = (identity: AuthenticatedIdentity, body: ArchiveBatchRequest, options: HistoryRoutesOptions) => Promise<RouteResult<ArchiveBatchResponse>>
export type SnapshotRoute = (identity: AuthenticatedIdentity, query: Record<string, string | undefined>, options: HistoryRoutesOptions) => Promise<RouteResult<HistoryPage>>
export type ChangesRoute = (identity: AuthenticatedIdentity, query: Record<string, string | undefined>, options: HistoryRoutesOptions) => Promise<RouteResult<HistoryPage>>

// M2.1a standalone composition boundary plus M2.1b auth binding, M2.1c
// mutations and M2.1d retrieval routes.
// Re-exported here so the single `message-box-store/server` subpath owns
// Express/MySQL/auth construction while browser-safe entrypoints stay free
// of server code.
export {
  AUTH_HANDSHAKE_PATH,
  AUTH_PROBE_PATH,
  REPLAY_CACHE_LIMIT,
  SERVICE_AUTH_CODE,
  SERVICE_CONFLICT_CODE,
  SERVICE_CURSOR_EXPIRED_CODE,
  SERVICE_EPOCH_CODE,
  SERVICE_EPOCH_EXHAUSTED_CODE,
  SERVICE_FORBIDDEN_CODE,
  SERVICE_IDEMPOTENCY_CODE,
  SERVICE_INTERNAL_CODE,
  SERVICE_INVALID_CODE,
  SERVICE_INVALID_CURSOR_CODE,
  SERVICE_MYSQL_CODE,
  SERVICE_CONFIG_CODE,
  SERVICE_MIGRATION_CODE,
  SERVICE_QUOTA_CODE,
  SERVICE_RATE_LIMITED_CODE,
  SERVICE_REVISION_CODE,
  SERVICE_TOO_LARGE_CODE,
  SERVICE_UNAVAILABLE_CODE,
  SERVICE_VERSION,
  assertArchiveOwnership,
  assertNoOwnerOverride,
  createReplayGuard,
  createService,
  createServiceApp,
  loadServiceConfigFromEnv,
  mapRepositoryError,
  parseRetentionDays,
  resolveRequestOwner,
  validateArchiveBatchBody,
  validateBrowseQuery,
  validateChangesQuery,
  validateDeleteAllInput,
  validateDeleteOneInput,
  validateEpochShape,
  validateIdempotencyShape,
  validatePatchStateInput,
  validatePathRecordKey,
  validateServiceConfig,
  validateSnapshotCreateBody,
  validateSnapshotIdShape,
  validateSnapshotPageQuery,
  validateUsageQuery,
} from './service.js'
export type { ReadinessStatus, ReplayGuard, ReplayGuardOptions, Service, ServiceAppState, ServiceAuthOptions, ServiceConfig, ServiceKnex, ServiceMysqlConfig, ServiceOptions } from './service.js'
