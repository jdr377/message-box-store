/**
 * Typed M1+ storage surface (mbs-8g5.2.2.1). Server-only subpath: repository
 * interface and migration types. Knex/MySQL are optional peers — type-only
 * here so browsers never pull the database graph.
 *
 * The proven runtime adapters remain `src/repository.mjs`,
 * `src/repository.sqlite.mjs` and `src/repository.mysql.mjs`; this module is
 * the typed boundary that mirrors their output shapes (including the
 * MySQL/SQLite `getRecord` parity proven in mbs-8g5.2.3.2.1).
 */
import type { ArchiveBatchRequest, ArchiveBatchResponse, HistoryPage, HistoryRecord, SnapshotFilter } from './protocol.js'

export interface Usage {
  recordCount: number
  byteCount: number
  epoch: string
  nextSequence: string
}

export interface SnapshotBinding {
  snapshotId: string
  owner: string
  expectedEpoch?: string
  expectedFeed?: 'snapshot' | 'changes'
  expectedFilter?: SnapshotFilter
  expectedWatermark?: string
}

export interface SnapshotCreateResult {
  snapshotId: string
  epoch: string
  feed: 'snapshot'
  filterHash: string
  watermark: string
  memberCount: number
  status: 'active' | 'invalidated'
}

export interface PurgeResult {
  purgedItems: number
  purgedSnapshots: number
  hasMore: boolean
}

export interface BrowseResult {
  items: HistoryRecord[]
  nextAfter: { createdAt: string; recordKey: string } | null
}

export interface ChangesPageOptions {
  owner: string
  serverSecret: string
  cursor?: string | null
  limit?: number
  filter?: SnapshotFilter
  nowSeconds?: number
  nowIso?: string
  ttlSeconds?: number
}

export interface SnapshotPageOptions {
  owner: string
  serverSecret: string
  snapshotId: string
  cursor?: string | null
  limit?: number
  nowSeconds?: number
  nowIso?: string
  ttlSeconds?: number
}

export interface StorageStats {
  live: Usage
  physical: {
    changeCount: number
    changeDetailCount: number
    tombstoneCount: number
    snapshotCount: number
    snapshotItemCount: number
  }
}

export interface ChangePurgeResult {
  purgedChanges: number
  examinedChanges: number
  hasMore: boolean
}

export interface HistoryRepository {
  archiveBatch(args: { owner: string; epoch: string; records: ArchiveBatchRequest['records'] }): Promise<ArchiveBatchResponse>
  deleteAll(args: { owner: string; idempotencyKey?: string; expectedEpoch?: string }): Promise<{ epoch: string; replayed?: boolean }>
  getUsage(args: { owner: string }): Promise<Usage> | Usage
  getRecord(args: { owner: string; recordKey: string }): Promise<HistoryRecord | null> | HistoryRecord | null
  createSnapshot(args: { owner: string; filter?: SnapshotFilter }): Promise<SnapshotCreateResult>
  getSnapshot(args: SnapshotBinding): Promise<(SnapshotCreateResult & { owner: string; createdAt: string; expiresAt: string }) | null>
  purgeExpiredSnapshots(args?: { nowIso?: string; batchSize?: number; maxItems?: number; maxSnapshots?: number }): Promise<PurgeResult> | PurgeResult
  listBrowse(args: { owner: string; filter?: SnapshotFilter; limit?: number; after?: { createdAt: string; recordKey: string } | null }): Promise<BrowseResult> | BrowseResult
  listChangesPage(args: ChangesPageOptions): Promise<HistoryPage>
  listSnapshotPage(args: SnapshotPageOptions): Promise<HistoryPage | null>
  getStorageStats(args: { owner: string }): Promise<StorageStats> | StorageStats
  purgeExpiredChanges(args: { owner: string; nowIso?: string; batchSize?: number; maxItems?: number }): Promise<ChangePurgeResult> | ChangePurgeResult
}

// Optional-peer note for tooling/consumers: install `knex` + `mysql2` to use
// the MySQL adapter, e.g. `bun add knex mysql2`. The SQLite adapter uses
// `node:sqlite` (Node 22+) and needs no peer.
export const STORAGE_PEERS = ['knex', 'mysql2'] as const
