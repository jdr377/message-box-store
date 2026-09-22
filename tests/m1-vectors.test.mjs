import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import { bodyHash, canonicalRecordKey } from '../src/protocol.mjs'

const golden = JSON.parse(readFileSync(new URL('../vectors/m1-golden.json', import.meta.url), 'utf8'))

function findPython() {
  for (const binary of ['python3', 'python']) {
    try {
      execFileSync(binary, ['--version'], { stdio: 'ignore' })
      return binary
    } catch {
      // try next
    }
  }
  return null
}

test('M1 golden vectors match the JS implementation', () => {
  assert.equal(golden.version, 1)
  assert.ok(golden.vectors.length >= 5)
  for (const vector of golden.vectors) {
    assert.equal(bodyHash(vector.body), vector.bodyHash, vector.name)
    assert.equal(
      canonicalRecordKey({
        ownerIdentityKey: vector.ownerIdentityKey,
        direction: vector.direction,
        messageBox: vector.messageBox,
        sender: vector.sender,
        recipient: vector.recipient,
        messageId: vector.messageId,
      }),
      vector.recordKey,
      vector.name,
    )
  }
  const m0 = golden.vectors.find((v) => v.name === 'm0-vector-1')
  assert.equal(m0.bodyHash, '0084794ecc214b1345494cd74a5758785b703aa54b89b1ff36b5087dc65ff8ce')
  assert.equal(m0.recordKey, '998e052031cfb45d304b54db7bb55abb56c69d2612567bd9eb563229073acbfe')
})

test('M1 independent Python implementation verifies golden vectors', { skip: findPython() === null ? 'no python available' : false }, () => {
  const output = execFileSync(findPython(), ['vectors/verify.py', 'vectors/m1-golden.json'], { encoding: 'utf8' })
  assert.match(output, /5 vectors verified/)
})
