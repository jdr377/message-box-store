import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checksumMigration, EXPECTED_MIGRATION_CHECKSUMS, verifyMigrationChecksums } from '../src/migrations.mjs'
import { initializeMysqlUtcSession, isDeadlockError, withDeadlockRetry } from '../src/repository.mysql.mjs'

function deadlock() {
  const error = new Error('Deadlock found when trying to get lock')
  error.code = 'ER_LOCK_DEADLOCK'
  return error
}

test('M1 deadlock classification covers InnoDB codes only', () => {
  assert.equal(isDeadlockError({ code: 'ER_LOCK_DEADLOCK' }), true)
  assert.equal(isDeadlockError({ code: 'ER_LOCK_WAIT_TIMEOUT' }), true)
  assert.equal(isDeadlockError({ code: 'ER_DUP_ENTRY' }), false)
  assert.equal(isDeadlockError(new Error('boom')), false)
  assert.equal(isDeadlockError(null), false)
})

test('M1 bounded retry succeeds after transient deadlocks', async () => {
  let calls = 0
  const result = await withDeadlockRetry(async () => {
    calls += 1
    if (calls < 3) throw deadlock()
    return 'committed'
  })
  assert.equal(result, 'committed')
  assert.equal(calls, 3)
})

test('M1 non-deadlock errors propagate with no retry', async () => {
  let calls = 0
  const dup = new Error('Duplicate entry')
  dup.code = 'ER_DUP_ENTRY'
  await assert.rejects(withDeadlockRetry(async () => {
    calls += 1
    throw dup
  }), /Duplicate entry/)
  assert.equal(calls, 1)
})

test('M1 exhausted deadlock budget fails closed with ERR_UNAVAILABLE', async () => {
  let calls = 0
  const error = await withDeadlockRetry(async () => {
    calls += 1
    throw deadlock()
  }, 3).then(() => null, (e) => e)
  assert.equal(error?.code, 'ERR_UNAVAILABLE')
  assert.equal(calls, 3)
  assert.equal(error?.cause?.code, 'ER_LOCK_DEADLOCK')
})

test('M1 shipped migration SQL matches reviewed checksums', () => {
  const digests = verifyMigrationChecksums()
  assert.equal(Object.keys(digests).length, 8)
  for (const [key, digest] of Object.entries(digests)) {
    assert.equal(EXPECTED_MIGRATION_CHECKSUMS[key], digest, key)
    assert.match(digest, /^[0-9a-f]{64}$/)
  }
  // Checksum is content-sensitive: any edit changes the digest.
  assert.notEqual(checksumMigration('CREATE TABLE t (a INT);'), checksumMigration('CREATE TABLE t (a INT) ;'))
})

test('M1 MySQL UTC session initialization fails closed with a typed secret-free error', async () => {
  const secret = 'must-not-leak'
  const failure = await new Promise((resolve) => initializeMysqlUtcSession({
    query(_sql, callback) {
      const error = new Error(`driver rejected configuration ${secret}`)
      callback(error)
    },
  }, (error) => resolve(error)))
  assert.equal(failure?.code, 'ERR_STORAGE_CONFIGURATION')
  assert.equal(failure?.message, 'MySQL session UTC initialization failed')
  assert.ok(!failure.message.includes(secret))
})
