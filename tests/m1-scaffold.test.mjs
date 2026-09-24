import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('M1 package targets GitHub Packages', () => {
  assert.notEqual(pkg.private, true)
  assert.equal(pkg.name, '@jdr377/message-box-store')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.license === 'UNLICENSED' || pkg.private === true)
  assert.equal(pkg.publishConfig?.registry, 'https://npm.pkg.github.com')
})

test('M1 exports resolve to existing browser-safe files', () => {
  assert.ok(pkg.exports['.'])
  assert.ok(pkg.exports['./protocol'])
  // mbs-8g5.2.2.1: explicit root/client/protocol/server/storage subpaths.
  for (const subpath of ['.', './protocol', './client', './server', './storage', './canonical']) {
    assert.ok(pkg.exports[subpath], `${subpath} export must exist`)
  }
  const targets = []
  for (const target of Object.values(pkg.exports)) {
    if (typeof target === 'string') targets.push(target)
    else {
      for (const key of ['browser', 'import', 'require', 'default', 'types']) {
        if (typeof target[key] === 'string') targets.push(target[key])
      }
    }
  }
  for (const target of [...new Set(targets)]) {
    const path = new URL(`../${target.replace('./', '')}`, import.meta.url)
    assert.ok(existsSync(path), `${target} must exist`)
  }
})

test('M1 root/browser graph excludes server/database code', () => {
  const roots = [
    '../src/index.mjs',
    '../src/protocol.mjs',
    '../src/m0-envelope.mjs',
    '../src/free-only-transport.mjs',
    '../src/m0-outbound-http-send.mjs',
  ]
  const banned = ['express', 'knex', 'sqlite', 'mysql', 'pg', 'postgres']
  for (const rel of roots) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8')
    for (const dep of banned) {
      assert.ok(
        !source.includes(`from '${dep}`) && !source.includes(`from "${dep}`) && !source.includes(`require('${dep}`),
        `${rel} must not import ${dep}`,
      )
    }
  }
  // Server-only deps may exist in package deps for M0 fixtures, but must not
  // enter the root import graph above. Full subpath isolation is an M4 gate.
})

test('M1 rereview .2.2.1: typed browser targets contain no Node built-ins or server graph', () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  // TS source boundary (platform-neutral, no Buffer, no node: imports).
  for (const rel of ['../mod.ts', '../src/canonical.ts', '../src/protocol.ts', '../src/client.ts']) {
    const code = stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))
    assert.ok(!code.includes("from 'node:") && !code.includes('from "node:'), `${rel} must not use node: built-ins`)
    assert.ok(!/\bBuffer\s*\.\s*(from|byteLength|alloc|concat)\b/.test(code), `${rel} must not require Buffer`)
    for (const dep of ['express', 'knex', 'mysql', 'sqlite', 'pg']) {
      assert.ok(!code.includes(`from '${dep}`) && !code.includes(`from "${dep}`), `${rel} must not import ${dep}`)
    }
  }
  // Built browser artifacts (require dist; run bun run build first).
  for (const rel of ['../dist/mod.js', '../dist/protocol.js', '../dist/client.js', '../dist/canonical.js']) {
    assert.ok(existsSync(new URL(rel, import.meta.url)), `${rel} must exist (bun run build)`)
    const code = stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))
    assert.ok(!code.includes('node:'), `${rel} must not contain node: built-ins`)
    assert.ok(!/\bBuffer\s*\.\s*(from|byteLength|alloc|concat)\b/.test(code), `${rel} must not require Buffer`)
  }
  // Server/storage subpaths declare usable optional-peer policy.
  assert.ok(pkg.peerDependencies?.knex, 'knex peer must be declared')
  assert.ok(pkg.peerDependencies?.mysql2, 'mysql2 peer must be declared')
  assert.equal(pkg.peerDependenciesMeta?.knex?.optional, true)
  assert.equal(pkg.peerDependenciesMeta?.mysql2?.optional, true)
})

test('M1 Node targets and reproducible test entrypoints', () => {
  assert.match(pkg.engines.node, /22/)
  const major = Number(process.versions.node.split('.')[0])
  assert.ok(major >= 22, `client target is Node 22+, running ${process.versions.node}`)
  assert.ok(pkg.scripts['test:m0'].includes('m0-'), 'M0 entrypoint documented')
  assert.ok(pkg.scripts['test:m1'].includes('m1-'), 'M1 entrypoint documented')
  assert.ok(pkg.scripts.test.includes('tests/*.test.mjs'), 'full entrypoint documented')
  for (const doc of ['../README.md', '../PRD.md', '../docs/M0-DECISIONS.md']) {
    assert.ok(existsSync(new URL(doc, import.meta.url)), `${doc} must exist`)
  }
})
