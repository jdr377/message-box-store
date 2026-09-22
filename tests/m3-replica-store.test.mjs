import { test } from 'node:test'
import {
  createTransactionalReplicaFixture,
  runReplicaStoreConformance,
} from './helpers/replica-store.mjs'

test('M3 atomic replica adapter contract', async (t) => {
  await runReplicaStoreConformance(t, createTransactionalReplicaFixture)
})
