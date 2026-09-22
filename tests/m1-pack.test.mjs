import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('M1 rereview .2.2.1: TypeScript entrypoints generate ESM/CJS/declarations from one source', async () => {
  // Entry sources exist and are strict TypeScript (no wholesale M0 conversion).
  for (const rel of ['../mod.ts', '../src/canonical.ts', '../src/protocol.ts', '../src/client.ts', '../src/server.ts', '../src/storage.ts', '../tsconfig.json', '../tsdown.config.ts']) {
    assert.ok(existsSync(new URL(rel, import.meta.url)), `${rel} must exist`)
  }
  const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'))
  assert.equal(tsconfig.compilerOptions.strict, true)
  // M0 proof fixtures remain .mjs and unchanged in role (not converted).
  for (const rel of ['../src/m0-envelope.mjs', '../src/free-only-transport.mjs', '../src/m0-outbound-http-send.mjs', '../src/m0-message-box-fixture.mjs', '../src/m0-authsocket-fixture.mjs']) {
    assert.ok(existsSync(new URL(rel, import.meta.url)), `${rel} frozen fixture must remain`)
  }
  // Built artifacts from one source: ESM + CJS + declarations for each entry.
  for (const base of ['mod', 'protocol', 'client', 'server', 'storage', 'canonical']) {
    assert.ok(existsSync(new URL(`../dist/${base}.js`, import.meta.url)), `dist/${base}.js (ESM) must exist`)
    assert.ok(existsSync(new URL(`../dist/${base}.cjs`, import.meta.url)), `dist/${base}.cjs (CJS) must exist`)
    assert.ok(existsSync(new URL(`../dist/${base}.d.ts`, import.meta.url)), `dist/${base}.d.ts must exist`)
  }
  // ESM and CJS share one behavior: frozen vectors match from both.
  const esm = await import('../dist/mod.js')
  const cjs = await import('../dist/mod.cjs')
  // CJS namespace may be default-exported; handle both shapes.
  const esmHash = esm.bodyHash('{"encryptedMessage":"AQ=="}')
  const cjsHash = (cjs.bodyHash ?? cjs.default?.bodyHash)('{"encryptedMessage":"AQ=="}')
  assert.equal(esmHash, '0084794ecc214b1345494cd74a5758785b703aa54b89b1ff36b5087dc65ff8ce')
  assert.equal(cjsHash, esmHash, 'ESM/CJS share one behavior source')
  const esmKey = esm.canonicalRecordKey({
    ownerIdentityKey: '021111111111111111111111111111111111111111111111111111111111111111',
    direction: 'outbound',
    messageBox: 'general_inbox',
    sender: '021111111111111111111111111111111111111111111111111111111111111111',
    recipient: '032222222222222222222222222222222222222222222222222222222222222222',
    messageId: 'm0-vector-1',
  })
  assert.equal(esmKey, '998e052031cfb45d304b54db7bb55abb56c69d2612567bd9eb563229073acbfe')
})

test('M1 rereview .2.2.1: platform-neutral canonical matches frozen vectors (no Buffer/node:crypto)', async () => {
  const { bodyHash, canonicalRecordKey, isCanonicalBase64 } = await import('../dist/canonical.js')
  assert.equal(bodyHash('{"encryptedMessage":"AQ=="}'), '0084794ecc214b1345494cd74a5758785b703aa54b89b1ff36b5087dc65ff8ce')
  assert.equal(isCanonicalBase64('AQ=='), true)
  assert.equal(isCanonicalBase64('!!!'), false)
  // Multibyte messageId vector (exact UTF-8 bytes, no normalization).
  const vectors = JSON.parse(readFileSync(new URL('../vectors/m1-golden.json', import.meta.url), 'utf8'))
  for (const v of vectors.vectors) {
    assert.equal(bodyHash(v.body), v.bodyHash, `bodyHash ${v.name}`)
    assert.equal(
      canonicalRecordKey({
        ownerIdentityKey: v.ownerIdentityKey,
        direction: v.direction,
        messageBox: v.messageBox,
        sender: v.sender,
        recipient: v.recipient,
        messageId: v.messageId,
      }),
      v.recordKey,
      `recordKey ${v.name}`,
    )
  }
})

test('M1 rereview .2.2.1: protocol and adapters use the one canonical runtime implementation', async () => {
  const runtime = await import('../src/canonical-runtime.js')
  const protocol = await import('../src/protocol.mjs')
  assert.equal(protocol.bodyHash, runtime.bodyHash)
  assert.equal(protocol.canonicalRecordKey, runtime.canonicalRecordKey)
  assert.equal(protocol.utf8ByteLength, runtime.utf8ByteLength)
  assert.equal(protocol.validateEncryptedBody, runtime.validateEncryptedBody)
  assert.equal(protocol.assertNoDuplicateTopLevelKeys, runtime.assertNoDuplicateTopLevelKeys)
})

test('M1 rereview .2.2.1: packed clean-consumer verification', async () => {
  // Runs the real package-consumer verification: supported imports resolve
  // from a tarball without checkout-relative URLs or optional peers.
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync(process.execPath, ['scripts/pack-verify.mjs'], { stdio: 'pipe' })
  } catch (error) {
    const out = `${error?.stdout ?? ''}${error?.stderr ?? ''}${error?.message ?? ''}`
    assert.fail(`pack-verify failed: ${out.slice(0, 2000)}`)
  }
  // Documented Bun commands exist (frozen install, build, typecheck, lint, tests).
  assert.ok(pkg.scripts.build?.includes('tsdown'), 'bun run build documented')
  assert.ok(pkg.scripts.typecheck?.includes('tsc'), 'bun run typecheck documented')
  assert.ok(pkg.scripts.lint, 'bun run lint documented')
  assert.ok(pkg.scripts.test?.includes('tests/*.test.mjs'), 'bun run test documented')
  // Node 24 verification explicitly deferred (not a gate here).
  assert.match(pkg.engines.node, /22/)
})
