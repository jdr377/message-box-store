import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`.trim())
  }
  return result
}

function linkRuntimeDependencies(consumerRoot, packageJson) {
  const sourceModules = join(repositoryRoot, 'node_modules')
  const consumerModules = join(consumerRoot, 'node_modules')
  const linked = new Set()
  const linkPackage = (name, optional = false) => {
    if (linked.has(name)) return
    const source = join(sourceModules, ...name.split('/'))
    if (!existsSync(source)) {
      if (optional) return
      throw new Error(`packed fixture dependency is not installed: ${name}`)
    }
    linked.add(name)
    const destination = join(consumerModules, name)
    mkdirSync(resolve(destination, '..'), { recursive: true })
    if (!existsSync(destination)) symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) linkPackage(dependency)
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) linkPackage(dependency, true)
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      linkPackage(dependency, manifest.peerDependenciesMeta?.[dependency]?.optional === true)
    }
  }
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) linkPackage(dependency)
  for (const dependency of Object.keys(packageJson.optionalDependencies ?? {})) linkPackage(dependency, true)
  for (const dependency of Object.keys(packageJson.peerDependencies ?? {})) {
    linkPackage(dependency, packageJson.peerDependenciesMeta?.[dependency]?.optional === true)
  }
}

/** Install the actual npm tarball into a disposable, dependency-complete consumer. */
export function createPackedPackageFixture() {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'message-box-store-two-device-'))
  const packDir = join(tempRoot, 'pack')
  const stagingDir = join(tempRoot, 'staging')
  const consumerRoot = join(tempRoot, 'consumer')
  const npmCacheDir = join(tempRoot, 'npm-cache')
  for (const directory of [packDir, stagingDir, join(consumerRoot, 'node_modules'), npmCacheDir]) {
    mkdirSync(directory, { recursive: true })
  }
  try {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const result = run(npmCommand, ['pack', '--json', '--pack-destination', packDir], {
      cwd: repositoryRoot,
      env: { ...process.env, NPM_CONFIG_CACHE: npmCacheDir, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    })
    const metadata = JSON.parse(result.stdout)
    const filename = metadata?.[0]?.filename
    if (typeof filename !== 'string') throw new Error('npm pack did not report a tarball')
    run('tar', ['-xzf', join(packDir, filename), '-C', stagingDir], { cwd: repositoryRoot, env: process.env })
    const installedRoot = join(consumerRoot, 'node_modules', packageJson.name)
    mkdirSync(dirname(installedRoot), { recursive: true })
    renameSync(join(stagingDir, 'package'), installedRoot)
    linkRuntimeDependencies(consumerRoot, packageJson)
    const require = createRequire(join(consumerRoot, 'package.json'))
    return {
      consumerRoot,
      installedRoot,
      require,
      cleanup() {
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      },
    }
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error
  }
}
