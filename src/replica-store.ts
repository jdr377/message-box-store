import type { DeleteEvent, HistoryRecord } from './protocol.js'

/**
 * A canonical replica filter. Callers normalize omitted selectors to `null`
 * before addressing the adapter so equivalent filtered views share one key.
 */
export interface ReplicaFilter {
  direction: 'inbound' | 'outbound' | null
  messageBox: string | null
  participant: string | null
}

export interface ReplicaScope {
  /** Authenticated wallet identity. Record payloads are never trusted to select it. */
  owner: string
  filter: ReplicaFilter
}

export interface ReplicaContinuation {
  /** Server-signed opaque cursor. Local replicas never construct this value. */
  cursor: string
  /** Fixed watermark bound into the cursor, as a canonical uint64 decimal. */
  watermark: string
}

/** Checkpoint and generation are canonical uint64 decimals, never JS Numbers. */
export interface ReplicaVersion {
  epoch: string
  checkpoint: string
  generation: string
  /** Present only while a fixed-watermark incremental pass is incomplete. */
  continuation: ReplicaContinuation | null
}

export interface ReplicaCoverage extends ReplicaVersion {
  scope: ReplicaScope
  complete: true
}

/** `null` means that the caller expects no complete coverage for this scope. */
export type ReplicaExpectedVersion = ReplicaVersion | null

export interface ReplicaSnapshotRef {
  scope: ReplicaScope
  epoch: string
  snapshotId: string
}

export interface BeginReplicaSnapshot extends ReplicaSnapshotRef {
  expected: ReplicaExpectedVersion
}

export interface StageReplicaSnapshotPage extends ReplicaSnapshotRef {
  records: readonly HistoryRecord[]
}

export interface CommitReplicaSnapshot extends ReplicaSnapshotRef {
  checkpoint: string
}

export interface ApplyReplicaIncrementalPage {
  scope: ReplicaScope
  epoch: string
  records: readonly (HistoryRecord | DeleteEvent)[]
  checkpoint: string
  continuation: ReplicaContinuation | null
  expected: ReplicaVersion
}

/**
 * Atomic local replica boundary used by history reconciliation.
 *
 * Snapshot rows stay isolated until `commitSnapshot`. That commit compares the
 * version captured by `beginSnapshot`, replaces membership only for the named
 * coverage, prunes unreferenced rows, and installs its checkpoint as one
 * transaction. `applyIncrementalPage` likewise applies every upsert/delete and
 * its checkpoint/opaque continuation as one transaction. A mismatch must
 * reject without mutation. Adapters persist cursors verbatim and never mint or
 * interpret them.
 *
 * A successfully committed snapshot with a new owner epoch invalidates every
 * older-epoch coverage and checkpoint for that owner. This prevents stale
 * cached rows from being treated as upload candidates after delete-all or
 * restore. Unsent drafts are outside this interface and are never reconciled.
 */
export interface LocalReplica {
  readCoverage(scope: ReplicaScope): Promise<ReplicaCoverage | null>
  beginSnapshot(input: BeginReplicaSnapshot): Promise<void>
  stageSnapshotPage(input: StageReplicaSnapshotPage): Promise<void>
  discardSnapshot(input: ReplicaSnapshotRef): Promise<void>
  commitSnapshot(input: CommitReplicaSnapshot): Promise<ReplicaCoverage>
  applyIncrementalPage(input: ApplyReplicaIncrementalPage): Promise<ReplicaCoverage>
}
