// M2.2b.1 bounded cleanup (mbs-8g5.3.2.2.1): one explicit interval-driven
// pass over the existing M1 bounded purge primitives with single-run
// exclusion — a tick or manual trigger that fires while a pass runs joins the
// in-flight promise instead of overlapping, the next tick is scheduled only
// after settle (failures advance on the interval, never as parallel retries),
// stop cancels pending work and drains an in-flight pass under a finite
// timeout while always resolving, outcomes stay compact and redacted with
// only bounded counts or a typed ERR_* code, the pass passes the accepted M1
// work bounds explicitly (batch 500 / items 1000 / snapshots 100), and the
// validated cleanupIntervalMs/cleanupOwners settings are observable on the
// composed service. Active records stay under the enforced `permanent`
// retention policy — no finite active-record retention is introduced.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { createMemoryStore } = await import('../src/repository.mjs')
const {
  SNAPSHOT_PURGE_BATCH,
  SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL,
  SNAPSHOT_PURGE_MAX_SNAPSHOTS_PER_CALL,
} = await import('../src/snapshots.mjs')
const {
  createCleanupScheduler,
  createRepositoryCleanup,
  createService,
  loadServiceConfigFromEnv,
  validateServiceConfig,
  SERVICE_CONFIG_CODE,
  CLEANUP_INTERVAL_DEFAULT_MS,
  CLEANUP_INTERVAL_MIN_MS,
  CLEANUP_OWNERS_MAX,
  CLEANUP_STOP_DEFAULT_TIMEOUT_MS,
} = await import('../dist/server.js')

const SECRET = 'test-server-secret-0123456789'
const PASSWORD = 'test-mysql-password-abcdef'
const CLIENT_KEY = '11'.repeat(32)
const OWNER_A = `02${'aa'.repeat(32)}`
const OWNER_B = `03${'bb'.repeat(32)}`
const DRIVER_SENTINEL = 'ER_ACCESS_DENIED_ERROR mbs_test@10.0.0.5'

function mysqlBase() {
  return { host: '127.0.0.1', port: 3306, user: 'mbs_test', password: PASSWORD, database: 'message_box_store_test' }
}

function baseConfig(overrides = {}) {
  return {
    serverSecret: SECRET,
    mysql: mysqlBase(),
    retention: 'permanent',
    ...overrides,
  }
}

function fakeKnex() {
  return { raw: async () => [[{ ok: 1 }]], destroy: async () => {} }
}

function emptyPass() {
  return { purgedSnapshots: 0, purgedItems: 0, purgedChanges: 0, hasMore: false }
}

function assertRedacted(value, label) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, PASSWORD, CLIENT_KEY, OWNER_A, OWNER_B, DRIVER_SENTINEL]) {
    assert.ok(!text.includes(secret), `${label} must not leak secret material`)
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function deferred() {
  let resolve = () => {}
  let reject = () => {}
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Deterministic fake-clock seam injected through CleanupTimerApi: time only
// moves when a test advances it, and due handlers run (with I/O flushes) in
// scheduling order so overlap, reschedule-after-settle and stop-timeout
// behaviour are all pinable without real sleeps.
function fakeTimers() {
  let now = 0
  let seq = 0
  const pending = new Map()
  return {
    setTimeout(handler, ms) {
      const id = ++seq
      pending.set(id, { at: now + ms, handler, seq: id })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    pendingCount: () => pending.size,
    async advance(ms) {
      now += ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= now)
          .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq)
        if (due.length === 0) break
        const [id, entry] = due[0]
        pending.delete(id)
        entry.handler()
        await flush()
      }
    },
  }
}

function spyPurgeStore() {
  const inner = createMemoryStore()
  const calls = { snapshots: [], changes: [] }
  const repository = new Proxy(inner, {
    get(target, prop) {
      const value = target[prop]
      if (prop === 'purgeExpiredSnapshots' && typeof value === 'function') {
        return (args) => {
          calls.snapshots.push(args)
          return value.apply(target, [args])
        }
      }
      if (prop === 'purgeExpiredChanges' && typeof value === 'function') {
        return (args) => {
          calls.changes.push(args)
          return value.apply(target, [args])
        }
      }
      return value
    },
  })
  return { repository, calls }
}

test('M2.2b.1 cleanup configuration validates finitely, redacted, with accepted defaults', async () => {
  const defaults = validateServiceConfig(baseConfig())
  assert.equal(defaults.cleanupIntervalMs, CLEANUP_INTERVAL_DEFAULT_MS)
  assert.equal(defaults.cleanupIntervalMs, 3_600_000)
  assert.deepEqual([...defaults.cleanupOwners], [])
  assert.ok(Object.isFrozen(defaults.cleanupOwners), 'cleanupOwners is a frozen exact list')

  const configured = validateServiceConfig(baseConfig({
    cleanupIntervalMs: 5_000,
    cleanupOwners: [OWNER_A, OWNER_B],
  }))
  assert.equal(configured.cleanupIntervalMs, 5_000)
  assert.deepEqual([...configured.cleanupOwners], [OWNER_A, OWNER_B])

  const coerced = validateServiceConfig(baseConfig({ cleanupIntervalMs: '7000' }))
  assert.equal(coerced.cleanupIntervalMs, 7_000, 'env-style string interval coerces')

  const commaParsed = validateServiceConfig(baseConfig({
    cleanupOwners: `${OWNER_A}, ${OWNER_B} ,${OWNER_A}`,
  }))
  assert.deepEqual([...commaParsed.cleanupOwners], [OWNER_A, OWNER_B], 'comma list trims and dedups')

  const noOwners = validateServiceConfig(baseConfig({ cleanupOwners: ['', '  '] }))
  assert.deepEqual([...noOwners.cleanupOwners], [])

  for (const bad of [0, -1, CLEANUP_INTERVAL_MIN_MS - 1, 1.5, NaN, Infinity, 'abc', true, {}, [], Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => validateServiceConfig(baseConfig({ cleanupIntervalMs: bad })), (error) => {
      assert.equal(error.code, SERVICE_CONFIG_CODE, `interval ${String(bad)} rejects typed`)
      assert.equal(error.message, 'cleanupIntervalMs must be an integer of at least 1000')
      assertRedacted({ message: error.message }, `interval ${String(bad)} rejection`)
      return true
    })
  }
  assert.ok(CLEANUP_INTERVAL_MIN_MS >= 1000, 'the documented floor is enforced by the parser message')

  const notAKey = ['junk', `${OWNER_A},junk`, 42, { id: OWNER_A }, [OWNER_A, 'nope']]
  for (const bad of notAKey) {
    assert.throws(() => validateServiceConfig(baseConfig({ cleanupOwners: bad })), (error) => {
      assert.equal(error.code, SERVICE_CONFIG_CODE, `owners ${JSON.stringify(bad)} rejects typed`)
      assert.equal(error.message, 'cleanupOwners must be identity keys')
      assertRedacted({ message: error.message }, `owners ${JSON.stringify(bad)} rejection`)
      return true
    })
  }

  const atMax = Array.from({ length: CLEANUP_OWNERS_MAX }, (_, i) => `02${i.toString(16).padStart(64, '0')}`)
  const overMax = Array.from({ length: CLEANUP_OWNERS_MAX + 1 }, (_, i) => `03${i.toString(16).padStart(64, '0')}`)
  const maxConfig = validateServiceConfig(baseConfig({ cleanupOwners: atMax }))
  assert.equal(maxConfig.cleanupOwners.length, CLEANUP_OWNERS_MAX)
  assert.throws(() => validateServiceConfig(baseConfig({ cleanupOwners: overMax })), (error) => {
    assert.equal(error.code, SERVICE_CONFIG_CODE)
    assert.equal(error.message, `cleanupOwners accepts at most ${CLEANUP_OWNERS_MAX} identity keys`)
    return true
  })

  const envBase = {
    MESSAGE_BOX_STORE_SERVER_SECRET: SECRET,
    MYSQL_USER: 'mbs_test',
    MYSQL_PASSWORD: PASSWORD,
    MYSQL_DATABASE: 'message_box_store_test',
  }
  const fromEnv = loadServiceConfigFromEnv({
    ...envBase,
    MESSAGE_BOX_STORE_CLEANUP_INTERVAL_MS: '4000',
    MESSAGE_BOX_STORE_CLEANUP_OWNERS: `${OWNER_A},${OWNER_B}`,
  })
  assert.equal(fromEnv.cleanupIntervalMs, 4_000)
  assert.deepEqual([...fromEnv.cleanupOwners], [OWNER_A, OWNER_B])

  const envDefaults = loadServiceConfigFromEnv(envBase)
  assert.equal(envDefaults.cleanupIntervalMs, CLEANUP_INTERVAL_DEFAULT_MS)
  assert.deepEqual([...envDefaults.cleanupOwners], [])

  assert.throws(() => loadServiceConfigFromEnv({ ...envBase, MESSAGE_BOX_STORE_CLEANUP_INTERVAL_MS: 'nope' }), (error) => {
    assert.equal(error.code, SERVICE_CONFIG_CODE)
    assertRedacted({ message: error.message }, 'env interval rejection')
    return true
  })
  assert.throws(() => loadServiceConfigFromEnv({ ...envBase, MESSAGE_BOX_STORE_CLEANUP_OWNERS: 'junk' }), (error) => {
    assert.equal(error.code, SERVICE_CONFIG_CODE)
    assert.equal(error.message, 'cleanupOwners must be identity keys')
    return true
  })
})

test('M2.2b.1 repository cleanup passes the accepted M1 bounds explicitly and aggregates bounded counts', async () => {
  const stamp = '2030-01-01T00:00:00.000Z'
  const { repository, calls } = spyPurgeStore()
  const run = createRepositoryCleanup(repository, { owners: [OWNER_A, OWNER_B], nowIso: () => stamp })
  const result = await run()

  assert.equal(calls.snapshots.length, 1, 'one global snapshot purge per pass')
  const snapshotArgs = calls.snapshots[0]
  assert.equal(snapshotArgs.nowIso, stamp)
  assert.equal(snapshotArgs.batchSize, SNAPSHOT_PURGE_BATCH)
  assert.equal(snapshotArgs.batchSize, 500)
  assert.equal(snapshotArgs.maxItems, SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL)
  assert.equal(snapshotArgs.maxItems, 1000)
  assert.equal(snapshotArgs.maxSnapshots, SNAPSHOT_PURGE_MAX_SNAPSHOTS_PER_CALL)
  assert.equal(snapshotArgs.maxSnapshots, 100)

  assert.equal(calls.changes.length, 2, 'one bounded change purge per configured owner')
  assert.deepEqual(calls.changes.map((args) => args.owner), [OWNER_A, OWNER_B])
  for (const args of calls.changes) {
    assert.equal(args.nowIso, stamp)
    assert.equal(args.batchSize, SNAPSHOT_PURGE_BATCH)
    assert.equal(args.maxItems, SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL)
    assert.equal(args.batchSize <= 5000 && args.maxItems <= 5000, true, 'bounds stay inside the M1 clamp')
  }

  assert.equal(typeof result.purgedSnapshots, 'number')
  assert.equal(typeof result.purgedItems, 'number')
  assert.equal(typeof result.purgedChanges, 'number')
  assert.equal(typeof result.hasMore, 'boolean')
  assert.equal(result.purgedSnapshots, 0, 'empty store purges nothing')
  assert.equal(result.hasMore, false)
  assertRedacted(result, 'cleanup pass result')

  const snapshotsOnly = createRepositoryCleanup(repository, { nowIso: () => stamp })
  const before = calls.changes.length
  await snapshotsOnly()
  assert.equal(calls.changes.length, before, 'no owners means snapshot purge only')

  const malformed = createRepositoryCleanup({
    purgeExpiredSnapshots: () => ({ purgedSnapshots: -1, purgedItems: NaN, hasMore: 'yes' }),
    purgeExpiredChanges: () => ({ purgedChanges: -3, hasMore: 1 }),
  }, { owners: [OWNER_A] })
  const bounded = await malformed()
  assert.deepEqual(bounded, { purgedSnapshots: 0, purgedItems: 0, purgedChanges: 0, hasMore: false })

  const failing = createRepositoryCleanup({
    purgeExpiredSnapshots: () => { throw new Error(`boom ${DRIVER_SENTINEL} ${PASSWORD}`) },
  })
  await assert.rejects(() => failing(), /boom/)
})

test('M2.2b.1 scheduler runs on its interval, never overlaps joins, and reschedules only after settle', async () => {
  const timers = fakeTimers()
  const outcomes = []
  const gate = deferred()
  let runs = 0
  const scheduler = createCleanupScheduler({
    intervalMs: 100,
    run: async () => {
      runs += 1
      await gate.promise
      return { ...emptyPass(), purgedSnapshots: runs }
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    timers,
  })

  assert.equal(scheduler.isRunning(), false)
  assert.equal(await scheduler.runNow(), null, 'stopped scheduler excludes manual passes')

  scheduler.start()
  scheduler.start()
  assert.equal(timers.pendingCount(), 1, 'start is idempotent while started: exactly one pending tick')

  await timers.advance(99)
  assert.equal(runs, 0, 'no run before the interval elapses')
  await timers.advance(1)
  assert.equal(runs, 1, 'tick starts the first pass')
  assert.equal(scheduler.isRunning(), true)
  assert.equal(timers.pendingCount(), 0, 'no tick pending while the pass is in flight')

  const joinedA = scheduler.runNow()
  const joinedB = scheduler.runNow()
  await timers.advance(100)
  assert.equal(runs, 1, 'manual triggers and elapsed time join the in-flight pass instead of overlapping')

  gate.resolve()
  await flush()
  const [outA, outB] = await Promise.all([joinedA, joinedB])
  assert.equal(outA, outB, 'joined callers receive the same outcome')
  assert.equal(outA.ok, true)
  assert.equal(outA.purgedSnapshots, 1)
  assert.ok(outA.durationMs >= 0)
  assert.equal(scheduler.isRunning(), false)
  assert.equal(timers.pendingCount(), 1, 'next tick is scheduled only after the pass settles')
  assert.equal(outcomes.length, 1)
  assert.deepEqual(outcomes[0], outA)

  await timers.advance(100)
  assert.equal(runs, 2, 'the next interval runs a fresh pass')

  const stopped = await scheduler.stop()
  assert.deepEqual(stopped, { cancelled: true, drained: true })
  assert.equal(timers.pendingCount(), 0, 'stop cancels the pending tick')
  await timers.advance(10_000)
  assert.equal(runs, 2, 'no pass runs after stop')
  assert.equal(await scheduler.runNow(), null, 'manual passes stay excluded once stopped')
})

test('M2.2b.1 failing passes redact to a typed code, never retry in parallel, and callbacks cannot fail the run', async () => {
  const timers = fakeTimers()
  const outcomes = []
  const gate = deferred()
  let attempts = 0
  const driverError = Object.assign(new Error(`${DRIVER_SENTINEL} password ${PASSWORD}`), {
    code: 'ER_ACCESS_DENIED_ERROR',
  })
  const scheduler = createCleanupScheduler({
    intervalMs: 50,
    run: async () => {
      attempts += 1
      await gate.promise
      if (attempts === 1) throw driverError
      if (attempts === 2) {
        const typed = Object.assign(new Error(`quota ${SECRET}`), { code: 'ERR_QUOTA_EXCEEDED' })
        throw typed
      }
      return emptyPass()
    },
    onOutcome: (outcome) => {
      outcomes.push(outcome)
      if (outcome.ok === false) throw new Error(`callback leak ${PASSWORD}`)
    },
    timers,
  })

  scheduler.start()
  await timers.advance(50)
  assert.equal(attempts, 1)
  const joined = scheduler.runNow()
  await timers.advance(50)
  assert.equal(attempts, 1, 'a failing in-flight pass is never retried in parallel')

  gate.resolve()
  await flush()
  const failed = await joined
  assert.equal(failed.ok, false)
  assert.equal(failed.errorCode, 'ERR_UNAVAILABLE', 'driver codes degrade to the generic unavailable code')
  assert.equal(failed.purgedSnapshots, 0)
  assert.equal(failed.hasMore, false)
  assertRedacted(failed, 'failed outcome')
  assert.ok(!JSON.stringify(failed).includes('boom'), 'error message text never propagates')
  assert.equal(outcomes.length, 1, 'a throwing outcome callback never fails or duplicates the run')
  assert.equal(timers.pendingCount(), 1, 'failure still reschedules on the ordinary interval')

  await timers.advance(50)
  await flush()
  assert.equal(attempts, 2)
  const typedFailure = outcomes[1]
  assert.equal(typedFailure.ok, false)
  assert.equal(typedFailure.errorCode, 'ERR_QUOTA_EXCEEDED', 'valid ERR_* codes survive redaction')
  assertRedacted(typedFailure, 'typed failure outcome')

  await timers.advance(50)
  await flush()
  assert.equal(attempts, 3)
  assert.equal(outcomes[2].ok, true, 'the pass recovers on the next interval')

  await scheduler.stop()
})

test('M2.2b.1 stop cancels pending work, drains in-flight passes under a finite timeout, and always resolves', async () => {
  const idleTimers = fakeTimers()
  let idleRuns = 0
  const idle = createCleanupScheduler({
    intervalMs: 10,
    run: async () => {
      idleRuns += 1
      return emptyPass()
    },
    timers: idleTimers,
  })
  idle.start()
  assert.equal(idleTimers.pendingCount(), 1)
  const idleStop = await idle.stop()
  assert.equal(idleStop.cancelled, true)
  assert.equal(idleStop.drained, true)
  assert.equal(idleTimers.pendingCount(), 0)
  await idleTimers.advance(10_000)
  assert.equal(idleRuns, 0)
  assert.deepEqual(await idle.stop(), { cancelled: false, drained: true }, 'stop is idempotent')
  assert.equal(await idle.runNow(), null)

  const drainTimers = fakeTimers()
  const drainGate = deferred()
  let drainRuns = 0
  const drainOutcomes = []
  const draining = createCleanupScheduler({
    intervalMs: 100,
    run: async () => {
      drainRuns += 1
      await drainGate.promise
      return emptyPass()
    },
    onOutcome: (outcome) => drainOutcomes.push(outcome),
    timers: drainTimers,
  })
  draining.start()
  const inflight = draining.runNow()
  assert.equal(drainRuns, 1)
  assert.equal(draining.isRunning(), true)
  const drainStop = draining.stop({ timeoutMs: 5_000 })
  drainGate.resolve()
  await flush()
  assert.deepEqual(await drainStop, { cancelled: true, drained: true }, 'stop waits for the in-flight pass')
  const drainedOutcome = await inflight
  assert.equal(drainedOutcome.ok, true)
  assert.equal(drainOutcomes.length, 1)
  assert.equal(drainTimers.pendingCount(), 0)
  assert.equal(draining.isRunning(), false)

  const timeoutTimers = fakeTimers()
  const timeoutGate = deferred()
  const timeoutOutcomes = []
  let timeoutRuns = 0
  const timingOut = createCleanupScheduler({
    intervalMs: 100,
    run: async () => {
      timeoutRuns += 1
      await timeoutGate.promise
      return emptyPass()
    },
    onOutcome: (outcome) => timeoutOutcomes.push(outcome),
    timers: timeoutTimers,
  })
  timingOut.start()
  const stuck = timingOut.runNow()
  const timeoutStop = timingOut.stop({ timeoutMs: 50 })
  await timeoutTimers.advance(50)
  assert.deepEqual(await timeoutStop, { cancelled: true, drained: false }, 'a stuck pass reports undrained at the timeout')
  assert.equal(timeoutTimers.pendingCount(), 0)

  timeoutGate.resolve()
  await flush()
  const late = await stuck
  assert.equal(late.ok, true, 'an abandoned pass still settles safely')
  assert.equal(timeoutOutcomes.length, 1)
  await timeoutTimers.advance(10_000)
  assert.equal(timeoutRuns, 1, 'nothing reschedules after stop')
  assert.equal(await timingOut.runNow(), null)

  const zeroTimers = fakeTimers()
  const zeroGate = deferred()
  const zeroWait = createCleanupScheduler({
    intervalMs: 10,
    run: async () => {
      await zeroGate.promise
      return emptyPass()
    },
    timers: zeroTimers,
  })
  zeroWait.start()
  const zeroRun = zeroWait.runNow()
  assert.deepEqual(await zeroWait.stop({ timeoutMs: 0 }), { cancelled: true, drained: false }, 'timeoutMs 0 skips waiting')
  zeroGate.resolve()
  await flush()
  assert.equal((await zeroRun).ok, true)

  assert.throws(() => createCleanupScheduler({ intervalMs: 0, run: async () => emptyPass() }), TypeError)
  assert.throws(() => createCleanupScheduler({ intervalMs: -1, run: async () => emptyPass() }), TypeError)
  assert.throws(() => createCleanupScheduler({ intervalMs: 1.5, run: async () => emptyPass() }), TypeError)
  assert.throws(() => createCleanupScheduler({ intervalMs: NaN, run: async () => emptyPass() }), TypeError)
  assert.throws(() => createCleanupScheduler({ intervalMs: 10, run: 'nope' }), TypeError)
  const invalidTimeout = createCleanupScheduler({ intervalMs: 10, run: async () => emptyPass(), timers: fakeTimers() })
  await assert.rejects(() => invalidTimeout.stop({ timeoutMs: -1 }), TypeError)
  await assert.rejects(() => invalidTimeout.stop({ timeoutMs: 1.5 }), TypeError)
  assert.ok(CLEANUP_STOP_DEFAULT_TIMEOUT_MS > 0, 'the default stop timeout is finite')
})

test('M2.2b.1 scheduler drives the default global timers and composes on the service lifecycle', async (t) => {
  let resolveFirst
  const firstOutcome = new Promise((resolve) => {
    resolveFirst = resolve
  })
  const auto = createCleanupScheduler({
    intervalMs: 10,
    run: async () => emptyPass(),
    onOutcome: (outcome) => resolveFirst(outcome),
  })
  auto.start()
  const winner = await Promise.race([
    firstOutcome,
    new Promise((_, reject) => setTimeout(() => reject(new Error('interval never fired')), 3_000)),
  ])
  assert.equal(winner.ok, true, 'the default global timer seam fires without injection')
  await auto.stop()

  const { repository, calls } = spyPurgeStore()
  const service = await createService({
    config: baseConfig({ cleanupIntervalMs: 60_000, cleanupOwners: [OWNER_A] }),
    knex: fakeKnex(),
    store: repository,
    migrate: async () => ['001-m2-cleanup'],
  })
  t.after(() => service.close())

  assert.equal(service.config.cleanupIntervalMs, 60_000)
  assert.deepEqual([...service.config.cleanupOwners], [OWNER_A])
  assert.equal(service.cleanup.isRunning(), false)
  assert.equal(await service.cleanup.runNow(), null, 'no pass before start')

  await service.start(0, '127.0.0.1')
  assert.equal(service.cleanup.isRunning(), false, 'started scheduler idles between passes')
  const outcome = await service.cleanup.runNow()
  assert.equal(outcome.ok, true)
  assert.equal(calls.snapshots.length, 1)
  assert.equal(calls.snapshots[0].batchSize, SNAPSHOT_PURGE_BATCH)
  assert.equal(calls.snapshots[0].maxItems, SNAPSHOT_PURGE_MAX_ITEMS_PER_CALL)
  assert.equal(calls.snapshots[0].maxSnapshots, SNAPSHOT_PURGE_MAX_SNAPSHOTS_PER_CALL)
  assert.equal(calls.changes.length, 1)
  assert.equal(calls.changes[0].owner, OWNER_A)
  assertRedacted(outcome, 'service cleanup outcome')

  await service.stop()
  assert.equal(await service.cleanup.runNow(), null, 'stop excludes future cleanup work')
  await service.stop()
  await service.close()
})
