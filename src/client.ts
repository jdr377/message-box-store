/**
 * Typed M1+ client surface (mbs-8g5.2.2.1). Browser-safe: types only plus
 * re-exports of platform-neutral protocol helpers. No `node:` built-ins,
 * no `Buffer`, no server/database imports.
 *
 * The M3 archive worker and HTTP client are not implemented yet; this module
 * defines the stable option/result shapes so applications can adopt the types
 * without pulling server code into the browser bundle.
 */
export type { ArchiveBatchRequest, ArchiveBatchResponse, DeleteEvent, HistoryPage, HistoryRecord, SnapshotFilter, StoreError } from './protocol.js'

export interface MessageBoxStoreClientOptions {
  /** Existing BRC-100 wallet; the store never takes keys. */
  walletClient: unknown
  /** Explicit HTTPS store origin, e.g. `https://history.example.com`. */
  host: string
}

export interface HistoryListOptions {
  messageBox?: string
  direction?: 'inbound' | 'outbound'
  participant?: string
  limit?: number
  cursor?: string | null
}

export interface ArchiveWorkerOptions {
  messageBoxClient: unknown
  historyClient: unknown
  messageBoxes: string[]
  /** Injectable local cache (IndexedDB, SQLite, or app store); never bundled. */
  localStore?: unknown
}

export interface SyncOnceOptions {
  acknowledgeAfterArchive?: boolean
}
