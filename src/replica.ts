import type {
  HistoryChangesOptions,
  SnapshotPageOptions,
} from './client.js'
import type {
  HistoryPage,
  HistoryRecord,
  SnapshotCreateResponse,
  SnapshotFilter,
} from './protocol.js'
import type {
  LocalReplica,
  ReplicaCoverage,
  ReplicaExpectedVersion,
  ReplicaFilter,
  ReplicaScope,
  ReplicaVersion,
} from './replica-store.js'

const UINT64 = /^(0|[1-9][0-9]*)$/
const UINT64_MAX = 18_446_744_073_709_551_615n

export interface HistoryReplicaClient {
  createSnapshot(filter?: SnapshotFilter): Promise<SnapshotCreateResponse>
  listSnapshotPage(options: SnapshotPageOptions): Promise<HistoryPage>
  listChanges(options?: HistoryChangesOptions): Promise<HistoryPage>
}

export interface SyncHistoryOptions {
  owner: string
  historyClient: HistoryReplicaClient
  localReplica: LocalReplica
  filter?: SnapshotFilter
  /** Total snapshot and change pages allowed in this cycle. */
  maxPages?: number
  /** Cooperative fence; in-flight HTTP may finish, but no later local write occurs. */
  signal?: AbortSignal
}

export interface SyncHistoryResult {
  status: 'complete' | 'partial' | 'cancelled'
  mode: 'snapshot' | 'incremental'
  pages: number
  records: number
  coverage: ReplicaCoverage | null
}

export class ReplicaSyncError extends Error {
  readonly code: 'ERR_REPLICA_PAGE_INCONSISTENT'

  constructor(message: string) {
    super(message)
    this.name = 'ReplicaSyncError'
    this.code = 'ERR_REPLICA_PAGE_INCONSISTENT'
  }
}

export function normalizeReplicaFilter(filter: SnapshotFilter = {}): ReplicaFilter {
  return {
    direction: filter.direction ?? null,
    messageBox: filter.messageBox ?? null,
    participant: filter.participant ?? null,
  }
}

function wireFilter(filter: ReplicaFilter): SnapshotFilter {
  return {
    ...(filter.direction === null ? {} : { direction: filter.direction }),
    ...(filter.messageBox === null ? {} : { messageBox: filter.messageBox }),
    ...(filter.participant === null ? {} : { participant: filter.participant }),
  }
}

function replicaVersion(coverage: ReplicaCoverage): ReplicaVersion {
  return {
    epoch: coverage.epoch,
    checkpoint: coverage.checkpoint,
    generation: coverage.generation,
    continuation: coverage.continuation,
  }
}

function decimal(value: string, field: string): bigint {
  if (!UINT64.test(value)) throw new ReplicaSyncError(`${field} is not a canonical uint64 decimal`)
  const parsed = BigInt(value)
  if (parsed > UINT64_MAX) throw new ReplicaSyncError(`${field} exceeds uint64`)
  return parsed
}

function eventSequence(record: HistoryPage['records'][number]): string {
  return 'body' in record ? record.changeSequence : record.sequence
}

function orderedEvents(page: HistoryPage): HistoryPage['records'] {
  const checkpoint = decimal(page.checkpoint, 'page checkpoint')
  return page.records
    .map((record, index) => ({ record, index, sequence: decimal(eventSequence(record), 'record sequence') }))
    .sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : left.index - right.index)
    .map(({ record, sequence }) => {
      if (sequence > checkpoint) throw new ReplicaSyncError('record sequence exceeds page checkpoint')
      return record
    })
}

function assertPageShape(page: HistoryPage): void {
  decimal(page.checkpoint, 'page checkpoint')
  decimal(page.watermark, 'page watermark')
  if (page.hasMore !== (page.nextCursor !== null)) {
    throw new ReplicaSyncError('page continuation fields disagree')
  }
  if (decimal(page.checkpoint, 'page checkpoint') > decimal(page.watermark, 'page watermark')) {
    throw new ReplicaSyncError('page checkpoint exceeds watermark')
  }
  if (!page.hasMore && page.checkpoint !== page.watermark) {
    throw new ReplicaSyncError('terminal page checkpoint must equal watermark')
  }
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function isResnapshotError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === 'ERR_CURSOR_EXPIRED' || code === 'ERR_EPOCH_CHANGED'
}

async function stageSnapshot(args: {
  scope: ReplicaScope
  filter: SnapshotFilter
  historyClient: HistoryReplicaClient
  localReplica: LocalReplica
  expected: ReplicaExpectedVersion
  maxPages: number
  signal?: AbortSignal
}): Promise<SyncHistoryResult> {
  if (cancelled(args.signal)) {
    return { status: 'cancelled', mode: 'snapshot', pages: 0, records: 0, coverage: null }
  }
  const created = await args.historyClient.createSnapshot(args.filter)
  if (created.status !== 'active') throw new ReplicaSyncError('snapshot was invalidated before paging')
  decimal(created.watermark, 'snapshot watermark')
  const ref = { scope: args.scope, epoch: created.epoch, snapshotId: created.snapshotId }
  if (cancelled(args.signal)) {
    return { status: 'cancelled', mode: 'snapshot', pages: 0, records: 0, coverage: null }
  }
  await args.localReplica.beginSnapshot({ ...ref, expected: args.expected })
  let cursor: string | null = null
  let pages = 0
  let records = 0
  let committed = false
  try {
    while (pages < args.maxPages) {
      if (cancelled(args.signal)) {
        return { status: 'cancelled', mode: 'snapshot', pages, records, coverage: null }
      }
      const page = await args.historyClient.listSnapshotPage({
        snapshotId: created.snapshotId,
        ...(cursor === null ? {} : { cursor }),
      })
      assertPageShape(page)
      if (page.epoch !== created.epoch || page.watermark !== created.watermark || page.checkpoint !== created.watermark) {
        throw new ReplicaSyncError('snapshot page changed epoch or watermark')
      }
      const snapshotRecords = page.records as HistoryRecord[]
      if (snapshotRecords.some((record) => !('body' in record))) {
        throw new ReplicaSyncError('snapshot page contained a deletion event')
      }
      if (cancelled(args.signal)) {
        return { status: 'cancelled', mode: 'snapshot', pages, records, coverage: null }
      }
      await args.localReplica.stageSnapshotPage({ ...ref, records: snapshotRecords })
      pages += 1
      records += snapshotRecords.length
      if (!page.hasMore) {
        if (cancelled(args.signal)) {
          return { status: 'cancelled', mode: 'snapshot', pages, records, coverage: null }
        }
        const coverage = await args.localReplica.commitSnapshot({ ...ref, checkpoint: created.watermark })
        committed = true
        return { status: 'complete', mode: 'snapshot', pages, records, coverage }
      }
      cursor = page.nextCursor
    }
    return { status: 'partial', mode: 'snapshot', pages, records, coverage: null }
  } finally {
    if (!committed) await args.localReplica.discardSnapshot(ref)
  }
}

async function applyChanges(args: {
  scope: ReplicaScope
  filter: SnapshotFilter
  historyClient: HistoryReplicaClient
  localReplica: LocalReplica
  coverage: ReplicaCoverage
  maxPages: number
  signal?: AbortSignal
}): Promise<SyncHistoryResult> {
  let coverage = args.coverage
  let pages = 0
  let records = 0
  let fixedWatermark = coverage.continuation?.watermark ?? null

  while (pages < args.maxPages) {
    if (cancelled(args.signal)) return { status: 'cancelled', mode: 'incremental', pages, records, coverage }
    const page = await args.historyClient.listChanges({
      ...args.filter,
      ...(coverage.continuation === null
        ? { afterSequence: coverage.checkpoint, epoch: coverage.epoch }
        : { cursor: coverage.continuation.cursor }),
    })
    assertPageShape(page)
    if (page.epoch !== coverage.epoch) {
      throw Object.assign(new Error('history epoch changed'), { code: 'ERR_EPOCH_CHANGED' })
    }
    const expectedWatermark = fixedWatermark ?? page.watermark
    if (page.watermark !== expectedWatermark) throw new ReplicaSyncError('incremental pass watermark changed')
    fixedWatermark = expectedWatermark
    const ordered = orderedEvents(page)
    if (cancelled(args.signal)) return { status: 'cancelled', mode: 'incremental', pages, records, coverage }
    coverage = await args.localReplica.applyIncrementalPage({
      scope: args.scope,
      epoch: page.epoch,
      records: ordered,
      checkpoint: page.checkpoint,
      continuation: page.hasMore
        ? { cursor: page.nextCursor as string, watermark: page.watermark }
        : null,
      expected: replicaVersion(coverage),
    })
    pages += 1
    records += ordered.length
    if (!page.hasMore) return { status: 'complete', mode: 'incremental', pages, records, coverage }
  }
  return { status: 'partial', mode: 'incremental', pages, records, coverage }
}

/** Perform one bounded reconciliation cycle. No cached row is ever uploaded. */
export async function syncHistory(options: SyncHistoryOptions): Promise<SyncHistoryResult> {
  const maxPages = options.maxPages ?? 100
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new TypeError('maxPages must be a positive safe integer')
  if (options.owner.length === 0) throw new TypeError('owner is required')

  const normalized = normalizeReplicaFilter(options.filter)
  const scope = { owner: options.owner, filter: normalized }
  const filter = wireFilter(normalized)
  let coverage = await options.localReplica.readCoverage(scope)
  if (cancelled(options.signal)) {
    return { status: 'cancelled', mode: coverage === null ? 'snapshot' : 'incremental', pages: 0, records: 0, coverage }
  }

  if (coverage !== null) {
    try {
      return await applyChanges({
        scope,
        filter,
        historyClient: options.historyClient,
        localReplica: options.localReplica,
        coverage,
        maxPages,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (!isResnapshotError(error)) throw error
      coverage = await options.localReplica.readCoverage(scope)
    }
  }

  const snapshot = await stageSnapshot({
    scope,
    filter,
    historyClient: options.historyClient,
    localReplica: options.localReplica,
    expected: coverage === null ? null : replicaVersion(coverage),
    maxPages,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (snapshot.status !== 'complete' || snapshot.coverage === null || snapshot.pages >= maxPages) return snapshot

  const incremental = await applyChanges({
    scope,
    filter,
    historyClient: options.historyClient,
    localReplica: options.localReplica,
    coverage: snapshot.coverage,
    maxPages: maxPages - snapshot.pages,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return {
    ...incremental,
    mode: 'snapshot',
    pages: snapshot.pages + incremental.pages,
    records: snapshot.records + incremental.records,
  }
}
