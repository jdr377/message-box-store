import type { SnapshotFilter } from './protocol.js'
import { syncHistory } from './replica.js'
import type { HistoryReplicaClient, SyncHistoryResult } from './replica.js'
import type { LocalReplica } from './replica-store.js'

export interface ArchiveWorkerOptions {
  owner: string
  historyClient: HistoryReplicaClient
  localStore: LocalReplica
  filter?: SnapshotFilter
  maxPagesPerCycle?: number
  pollIntervalMs?: number
  maxBackoffMs?: number
}

export interface SyncOnceOptions {
  maxPages?: number
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value
}

/**
 * Small, single-flight polling lifecycle for bounded history reconciliation.
 * Cancellation is cooperative: an in-flight HTTP operation may finish, while
 * the abort fence prevents the following replica write or future poll.
 */
export class MessageBoxArchiveWorker {
  readonly #options: Required<Pick<ArchiveWorkerOptions, 'maxPagesPerCycle' | 'pollIntervalMs' | 'maxBackoffMs'>> & ArchiveWorkerOptions
  #timer: ReturnType<typeof setTimeout> | null = null
  #active: Promise<SyncHistoryResult> | null = null
  #controller: AbortController | null = null
  #started = false
  #stopped = false
  #failures = 0

  constructor(options: ArchiveWorkerOptions) {
    if (options.owner.length === 0) throw new TypeError('owner is required')
    const maxPagesPerCycle = positiveSafeInteger(options.maxPagesPerCycle ?? 100, 'maxPagesPerCycle')
    const pollIntervalMs = positiveSafeInteger(options.pollIntervalMs ?? 30_000, 'pollIntervalMs')
    const maxBackoffMs = positiveSafeInteger(options.maxBackoffMs ?? 300_000, 'maxBackoffMs')
    if (maxBackoffMs < pollIntervalMs) throw new TypeError('maxBackoffMs must be at least pollIntervalMs')
    this.#options = { ...options, maxPagesPerCycle, pollIntervalMs, maxBackoffMs }
  }

  start(): void {
    if (this.#stopped) throw new Error('worker has been stopped')
    if (this.#started) return
    this.#started = true
    this.#schedule(0)
  }

  syncOnce(options: SyncOnceOptions = {}): Promise<SyncHistoryResult> {
    if (this.#stopped) {
      return Promise.resolve({ status: 'cancelled', mode: 'incremental', pages: 0, records: 0, coverage: null })
    }
    if (this.#active !== null) return this.#active
    const maxPages = options.maxPages === undefined
      ? this.#options.maxPagesPerCycle
      : positiveSafeInteger(options.maxPages, 'maxPages')
    const controller = new AbortController()
    this.#controller = controller
    const active = syncHistory({
      owner: this.#options.owner,
      historyClient: this.#options.historyClient,
      localReplica: this.#options.localStore,
      ...(this.#options.filter === undefined ? {} : { filter: this.#options.filter }),
      maxPages,
      signal: controller.signal,
    })
    this.#active = active
    void active.finally(() => {
      if (this.#active === active) this.#active = null
      if (this.#controller === controller) this.#controller = null
    }).catch(() => {})
    return active
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#controller?.abort()
    try {
      await this.#active
    } catch {
      // The explicit sync caller receives the error; stop only drains it.
    }
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.syncOnce().then(
        () => {
          if (this.#stopped) return
          this.#failures = 0
          this.#schedule(this.#options.pollIntervalMs)
        },
        () => {
          if (this.#stopped) return
          this.#failures += 1
          const factor = 2 ** Math.min(this.#failures - 1, 20)
          this.#schedule(Math.min(this.#options.pollIntervalMs * factor, this.#options.maxBackoffMs))
        },
      )
    }, delayMs)
  }
}
