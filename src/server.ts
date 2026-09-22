/**
 * Typed M1+ server surface (mbs-8g5.2.2.1) plus M2.1a composition boundary
 * (mbs-8g5.3.1.1), M2.1b auth binding (mbs-8g5.3.1.2), M2.1c mutations
 * (mbs-8g5.3.1.3), M2.1d retrieval routes (mbs-8g5.3.1.4), M2.1e
 * capabilities/liveness/readiness (mbs-8g5.3.1.5), M2.2a.1 exact
 * origin/CORS plus early body/batch ingress bounds (mbs-8g5.3.2.1.1),
 * M2.2a.2 finite active-request admission plus pool bounds
 * (mbs-8g5.3.2.1.2), and M2.2a.3 bounded process-local pre-auth IP plus
 * authenticated-identity rate limits (mbs-8g5.3.2.1.3). Server-only subpath: Express route adapter types and the standalone
 * service live here so browser bundles never include them.
 *
 * Runtime server dependencies (express, auth middleware, sdk, and other
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
// mutations, M2.1d retrieval routes, M2.1e capabilities, M2.2a.1
// ingress (exact origins/CORS, early body/batch bounds), M2.2a.2
// admission (finite active-request bound, finite pool min/max), and
// M2.2a.3 rate (bounded fixed-window pre-auth IP + identity limiters and
// the one trusted-proxy parse).
// Re-exported here so the single `message-box-store/server` subpath owns
// Express/MySQL/auth construction while browser-safe entrypoints stay free
// of server code. The Capabilities wire type itself lives on the browser-safe
// protocol subpath alongside the frozen schema it mirrors.
export {
  ARCHIVE_BATCH_PATH,
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
  SERVICE_SUPPORTED_FEATURES,
  SERVICE_TOO_LARGE_CODE,
  SERVICE_UNAVAILABLE_CODE,
  SERVICE_VERSION,
  assertArchiveOwnership,
  assertEarlyBatchBounds,
  assertNoOwnerOverride,
  buildCapabilities,
  createFixedWindowRateLimiter,
  createReplayGuard,
  createService,
  createServiceApp,
  loadServiceConfigFromEnv,
  mapRepositoryError,
  parseAllowedOrigins,
  parseRetentionDays,
  parseTrustedProxy,
  RATE_LIMIT_MAX_KEYS,
  RATE_LIMIT_MIN_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
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
export type { FixedWindowRateLimiter, FixedWindowRateLimiterOptions, RateLimitDecision, ReadinessStatus, ReplayGuard, ReplayGuardOptions, Service, ServiceAppState, ServiceAuthOptions, ServiceConfig, ServiceKnex, ServiceMysqlConfig, ServiceOptions } from './service.js'
