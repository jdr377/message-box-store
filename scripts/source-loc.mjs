import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const baselinePath = join(root, 'docs', 'REFACTOR_LOC_BASELINE.json')
const fixturePaths = new Set([
  'src/m0-authsocket-fixture.mjs',
  'src/m0-envelope.mjs',
  'src/m0-message-box-fixture.mjs',
  'src/m0-outbound-http-send.mjs',
])

function sourcePaths(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourcePaths(path)
    if (!entry.isFile() || !/\.(?:[cm]?js|[cm]?ts)$/.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name)) return []
    return [path]
  })
}

function measure() {
  const files = sourcePaths(join(root, 'src')).map((path) => {
    const name = relative(root, path).split(sep).join('/')
    const content = readFileSync(path)
    return {
      path: name,
      kind: fixturePaths.has(name) ? 'test-fixture' : 'production',
      nonblankLines: content.toString('utf8').split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0).length,
      sha256: createHash('sha256').update(content).digest('hex'),
    }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const production = files.filter((file) => file.kind === 'production').reduce((sum, file) => sum + file.nonblankLines, 0)
  const fixtures = files.filter((file) => file.kind === 'test-fixture').reduce((sum, file) => sum + file.nonblankLines, 0)
  return {
    scope: 'Recursive src/*.{js,mjs,cjs,ts,mts,cts}; declarations excluded; nonblank means trim().length > 0',
    totals: { gross: production + fixtures, production, testFixtures: fixtures, fileCount: files.length },
    files,
  }
}

const current = measure()
if (process.argv.includes('--snapshot')) {
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const sourceStatus = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim()
  process.stdout.write(`${JSON.stringify({ ...current, capturedAt: new Date().toISOString(), gitHead, sourceStatus }, null, 2)}\n`)
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const oldFiles = new Map(baseline.files.map((file) => [file.path, file]))
  const newFiles = new Map(current.files.map((file) => [file.path, file]))
  console.log('Path | Kind | Baseline | Current | Delta')
  console.log('--- | --- | ---: | ---: | ---:')
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const before = oldFiles.get(path)?.nonblankLines ?? 0
    const after = newFiles.get(path)?.nonblankLines ?? 0
    console.log(`${path} | ${newFiles.get(path)?.kind ?? oldFiles.get(path)?.kind} | ${before} | ${after} | ${after - before >= 0 ? '+' : ''}${after - before}`)
  }
  console.log(`GROSS | | ${baseline.totals.gross} | ${current.totals.gross} | ${current.totals.gross - baseline.totals.gross}`)
  console.log(`PRODUCTION | | ${baseline.totals.production} | ${current.totals.production} | ${current.totals.production - baseline.totals.production}`)
  console.log(`TEST FIXTURES | | ${baseline.totals.testFixtures} | ${current.totals.testFixtures} | ${current.totals.testFixtures - baseline.totals.testFixtures}`)
  if (process.argv.includes('--check-baseline')) {
    const same = JSON.stringify(baseline.totals) === JSON.stringify(current.totals)
      && baseline.files.length === current.files.length
      && current.files.every((file) => oldFiles.get(file.path)?.sha256 === file.sha256)
    if (!same) process.exitCode = 1
  }
}
