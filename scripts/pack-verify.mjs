import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Verify the actual package artifact from a clean consumer. This intentionally
 * never imports a checkout path or a dist file: all consumer source imports
 * resolve only by the published package name and export map.
 */

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const expectedBodyHash = '0084794ecc214b1345494cd74a5758785b703aa54b89b1ff36b5087dc65ff8ce'
const expectedOwner = '021111111111111111111111111111111111111111111111111111111111111111'
const expectedPeer = '032222222222222222222222222222222222222222222222222222222222222222'
const expectedRecordKey = '998e052031cfb45d304b54db7bb55abb56c69d2612567bd9eb563229073acbfe'

function fail(message, result) {
  const details = result ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : ''
  throw new Error(`${message}${details}`.trim())
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    shell: options.shell ?? (process.platform === 'win32' && command.endsWith('.cmd')),
    windowsHide: true,
  })
  if (result.error || result.status !== 0) fail(`${command} ${args.join(' ')} failed`, result)
  return result
}

function targetValues(target) {
  if (typeof target === 'string') return [target]
  return ['types', 'browser', 'import', 'require', 'default'].flatMap((condition) => (target[condition] ? [target[condition]] : []))
}

function assertPackageTargets(packageRoot) {
  for (const [subpath, target] of Object.entries(packageJson.exports ?? {})) {
    for (const value of targetValues(target)) {
      if (typeof value !== 'string' || !value.startsWith('./')) fail(`invalid non-relative export target ${subpath} -> ${String(value)}`)
      if (/^(?:[A-Za-z]:|[\\/]|(?:file|https?):)/.test(value)) fail(`absolute export target ${subpath} -> ${value}`)
      const targetPath = join(packageRoot, value.slice(2))
      if (!existsSync(targetPath)) fail(`missing packed export target ${subpath} -> ${value}`)
    }
  }
}

function runConsumerNode(script, consumerRoot, args = []) {
  const env = { ...process.env }
  delete env.NODE_PATH
  run(process.execPath, [...args, script], { cwd: consumerRoot, env })
}

function linkInstalledDependencies(consumerRoot) {
  const sourceModules = join(root, 'node_modules')
  const consumerModules = join(consumerRoot, 'node_modules')
  const linked = new Set()
  const linkPackage = (name, optional = false) => {
    if (linked.has(name)) return
    const source = join(sourceModules, ...name.split('/'))
    if (!existsSync(source)) {
      if (optional) return
      fail(`locked dependency is not installed: ${name}`)
    }
    linked.add(name)
    const destination = join(consumerModules, name)
    mkdirSync(resolve(destination, '..'), { recursive: true })
    if (!existsSync(destination)) {
      symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) linkPackage(dependency)
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) linkPackage(dependency, true)
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      linkPackage(dependency, manifest.peerDependenciesMeta?.[dependency]?.optional === true)
    }
  }
  for (const name of Object.keys(packageJson.dependencies ?? {})) linkPackage(name)
  for (const name of Object.keys(packageJson.optionalDependencies ?? {})) linkPackage(name, true)
  for (const name of Object.keys(packageJson.peerDependencies ?? {})) {
    linkPackage(name, packageJson.peerDependenciesMeta?.[name]?.optional === true)
  }
}

function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'message-box-store-pack-'))
  try {
    const packDir = join(tempRoot, 'pack')
    const npmCacheDir = join(tempRoot, 'npm-cache')
    const stagingDir = join(tempRoot, 'staging')
    const consumerRoot = join(tempRoot, 'consumer')
    mkdirSync(packDir, { recursive: true })
    mkdirSync(npmCacheDir, { recursive: true })
    mkdirSync(stagingDir, { recursive: true })
    mkdirSync(join(consumerRoot, 'node_modules'), { recursive: true })

    const packEnv = { ...process.env, NPM_CONFIG_CACHE: npmCacheDir, NPM_CONFIG_UPDATE_NOTIFIER: 'false' }
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const packResult = run(npmCommand, ['pack', '--json', '--pack-destination', packDir], { cwd: root, env: packEnv })
    let packMetadata
    try {
      packMetadata = JSON.parse(packResult.stdout)
    } catch {
      fail('npm pack did not return JSON metadata', packResult)
    }
    const packName = packMetadata?.[0]?.filename
    if (typeof packName !== 'string' || !packName.endsWith('.tgz')) fail('npm pack did not report a tarball', packResult)
    const tarball = resolve(packDir, packName)
    if (!existsSync(tarball)) fail(`reported package tarball does not exist: ${tarball}`)

    run('tar', ['-xzf', tarball, '-C', stagingDir], { cwd: root, env: process.env })
    const packedRoot = join(stagingDir, 'package')
    if (!existsSync(join(packedRoot, 'package.json'))) fail('tarball did not contain package/package.json')
    assertPackageTargets(packedRoot)
    const packedPackageJson = JSON.parse(readFileSync(join(packedRoot, 'package.json'), 'utf8'))
    if (packedPackageJson.name !== packageJson.name) fail('packed package name changed')
    if (packedPackageJson.version !== packageJson.version) fail('packed package version changed')
    if (packedPackageJson.private !== true) fail('package-private boundary changed')
    if (existsSync(join(packedRoot, '.env'))) fail('secret .env was included in package artifact')
    renameSync(packedRoot, join(consumerRoot, 'node_modules', packageJson.name))
    // npm would install declared runtime dependencies beside the tarball. Link
    // the repository's locked installation to model that state without a
    // registry/network dependency in this verifier.
    linkInstalledDependencies(consumerRoot)
    writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({ name: 'message-box-store-clean-consumer', private: true, type: 'module' }))

    const esmScript = join(consumerRoot, 'consumer-esm.mjs')
    writeFileSync(esmScript, `
import assert from 'node:assert/strict'
import * as root from 'message-box-store'
import * as protocol from 'message-box-store/protocol'
import * as client from 'message-box-store/client'
import * as canonical from 'message-box-store/canonical'
import * as server from 'message-box-store/server'
import * as storage from 'message-box-store/storage'
assert.match(await import.meta.resolve('message-box-store'), /[\\/]node_modules[\\/]message-box-store[\\/]dist[\\/]mod\\.js$/)
assert.equal(root.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(protocol.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(canonical.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(root.canonicalRecordKey({ ownerIdentityKey: '${expectedOwner}', direction: 'outbound', messageBox: 'general_inbox', sender: '${expectedOwner}', recipient: '${expectedPeer}', messageId: 'm0-vector-1' }), '${expectedRecordKey}')
for (const entry of [root, client]) {
  assert.equal(typeof entry.prepareEncryptedBody, 'function')
  assert.equal(typeof entry.decryptArchivedBody, 'function')
  assert.equal(typeof entry.createFreeOnlyMessageBoxClient, 'function')
  assert.equal(typeof entry.createMessageBoxHttpSendCapability, 'function')
  assert.equal(typeof entry.sendPreparedHttpOnce, 'function')
  for (const name of ['AuthFetch', 'MessageBoxClient', 'createFreeOnlyAuthFetch', 'createPaymentDisabledWallet', 'sendLiveMessage']) {
    assert.equal(Object.hasOwn(entry, name), false)
  }
}
assert.equal(typeof root.MessageBoxStoreClient, 'function')
assert.equal(typeof client.MessageBoxStoreClient, 'function')
assert.equal(typeof root.syncPending, 'function')
assert.equal(typeof client.syncPending, 'function')
assert.equal(typeof root.sendOutboundOnce, 'function')
assert.equal(typeof client.sendOutboundOnce, 'function')
const wallet = {
  async encrypt() { return { ciphertext: [1, 2, 3] } },
  async decrypt() { return { plaintext: new TextEncoder().encode('packed') } },
}
const prepared = await root.prepareEncryptedBody({ wallet, plaintext: 'hello', counterparty: '${expectedPeer}' })
assert.equal(prepared.body, '{"encryptedMessage":"AQID"}')
assert.equal(await client.decryptArchivedBody({ wallet, body: prepared.body, counterparty: '${expectedPeer}' }), 'packed')
assert.equal(typeof server, 'object')
assert.equal(typeof storage, 'object')
`)
    runConsumerNode(esmScript, consumerRoot)

    const browserScript = join(consumerRoot, 'consumer-browser.mjs')
    writeFileSync(browserScript, `
import assert from 'node:assert/strict'
assert.match(await import.meta.resolve('message-box-store'), /[\\/]dist[\\/]mod\\.js$/)
assert.match(await import.meta.resolve('message-box-store/protocol'), /[\\/]dist[\\/]protocol\\.js$/)
assert.match(await import.meta.resolve('message-box-store/client'), /[\\/]dist[\\/]client\\.js$/)
assert.match(await import.meta.resolve('message-box-store/canonical'), /[\\/]dist[\\/]canonical\\.js$/)
const root = await import('message-box-store')
const protocol = await import('message-box-store/protocol')
const client = await import('message-box-store/client')
const canonical = await import('message-box-store/canonical')
assert.equal(root.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(protocol.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(canonical.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(root.plaintextText({ browser: true }), '{"browser":true}')
assert.equal(client.extractEncryptedMessage('{"encryptedMessage":"AQ=="}'), 'AQ==')
assert.equal(typeof root.sendPreparedHttpOnce, 'function')
assert.equal(typeof client.createFreeOnlyMessageBoxClient, 'function')
assert.equal(typeof client.MessageBoxStoreClient, 'function')
assert.equal(typeof client.syncPending, 'function')
assert.equal(typeof client.sendOutboundOnce, 'function')
`)
    runConsumerNode(browserScript, consumerRoot, ['--conditions=browser'])

    const cjsScript = join(consumerRoot, 'consumer-cjs.cjs')
    writeFileSync(cjsScript, `
const assert = require('node:assert/strict')
const root = require('message-box-store')
const protocol = require('message-box-store/protocol')
const client = require('message-box-store/client')
const canonical = require('message-box-store/canonical')
assert.equal(root.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(protocol.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(canonical.bodyHash('{"encryptedMessage":"AQ=="}'), '${expectedBodyHash}')
assert.equal(typeof root.prepareEncryptedBody, 'function')
assert.equal(typeof client.sendPreparedHttpOnce, 'function')
assert.equal(typeof root.MessageBoxStoreClient, 'function')
assert.equal(typeof client.MessageBoxStoreClient, 'function')
assert.equal(typeof root.syncPending, 'function')
assert.equal(typeof client.syncPending, 'function')
assert.equal(typeof client.sendOutboundOnce, 'function')
`)
    runConsumerNode(cjsScript, consumerRoot)

    const typesScript = join(consumerRoot, 'consumer-types.ts')
    writeFileSync(typesScript, `
import {
  bodyHash,
  canonicalRecordKey,
  createMessageBoxHttpSendCapability,
  prepareEncryptedBody,
  sendPreparedHttpOnce,
  MessageBoxStoreClient,
  syncPending,
  sendOutboundOnce,
} from 'message-box-store'
import type { FreeOnlyMessageBoxClient, OutboundAttemptStore, PreparedEncryptedBody, WalletInterface } from 'message-box-store/client'
import type { SnapshotCreateResponse } from 'message-box-store/protocol'
import type { HistoryRepository } from 'message-box-store/storage'
const hash: string = bodyHash('{"encryptedMessage":"AQ=="}')
const key: string = canonicalRecordKey({ ownerIdentityKey: '${expectedOwner}', direction: 'outbound', messageBox: 'general_inbox', sender: '${expectedOwner}', recipient: '${expectedPeer}', messageId: 'types-vector' })
const snapshot: SnapshotCreateResponse = { snapshotId: 's', epoch: 'e', feed: 'snapshot', filterHash: 'f', watermark: '1', memberCount: 0, status: 'active' }
declare const repository: HistoryRepository
declare const messageBoxClient: FreeOnlyMessageBoxClient
declare const attemptStore: OutboundAttemptStore
declare const wallet: Parameters<typeof prepareEncryptedBody>[0]['wallet']
declare const walletClient: WalletInterface
const history = new MessageBoxStoreClient({ walletClient, host: 'https://history.example.com' })
const capabilities = history.capabilities()
const resumedChanges = history.listChanges({ afterSequence: '0', epoch: 'gen-1' })
const inboundOperation = syncPending
const outboundOperation = sendOutboundOnce
const capability = createMessageBoxHttpSendCapability(messageBoxClient)
const prepared: Promise<PreparedEncryptedBody> = prepareEncryptedBody({ wallet, plaintext: 'packed types', counterparty: '${expectedPeer}' })
const sent = sendPreparedHttpOnce({
  httpSend: capability,
  attemptStore,
  ownerIdentityKey: '${expectedOwner}',
  recipient: '${expectedPeer}',
  messageBox: 'general_inbox',
  messageId: 'types-vector',
  body: '{"encryptedMessage":"AQ=="}',
  host: 'https://messagebox.example',
})
const stats = await repository.getStorageStats({ owner: '${expectedOwner}' })
const physicalCounts: [number, number, number, number, number] = [
  stats.physical.changeCount,
  stats.physical.changeDetailCount,
  stats.physical.tombstoneCount,
  stats.physical.snapshotCount,
  stats.physical.snapshotItemCount,
]
void hash
void key
void snapshot
void prepared
void sent
void physicalCounts
void capabilities
void resumedChanges
void inboundOperation
void outboundOperation
`)
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
    if (!existsSync(tsc)) fail('TypeScript compiler is not installed for declaration verification')
    run(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--lib', 'ES2022,DOM', typesScript], { cwd: consumerRoot, env: process.env })

    console.log('pack-verify: real tarball consumer ESM/CJS/browser/declarations ok')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

try {
  main()
} catch (error) {
  console.error(`pack-verify: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
