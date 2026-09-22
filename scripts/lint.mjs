import { readFileSync, existsSync } from 'node:fs'

/** Browser-safe graph, package-export, and secret checks for public code. */
const BROWSER_SOURCES = [
  'mod.ts',
  'src/canonical.js',
  'src/canonical-runtime.js',
  'src/canonical.ts',
  'src/protocol.ts',
  'src/client.ts',
  'src/replica-store.ts',
  'src/replica.ts',
  'src/worker.ts',
  'src/envelope-runtime.js',
  'src/outbound-runtime.js',
  'src/free-only-transport.mjs',
]
const BROWSER_DIST = ['dist/mod.js', 'dist/protocol.js', 'dist/client.js', 'dist/canonical.js']
const BANNED = [
  "from 'node:",
  'from "node:',
  "from 'express",
  "from 'knex",
  "from 'mysql",
  "from 'sqlite",
  "from 'pg",
  'require(\'express',
  'require("express',
  'node:crypto',
  'node:sqlite',
]

let failed = 0
for (const rel of [...BROWSER_SOURCES, ...BROWSER_DIST]) {
  if (!existsSync(new URL(`../${rel}`, import.meta.url))) {
    console.error(`lint: missing ${rel} (run bun run build first)`)
    failed += 1
    continue
  }
  const source = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const needle of BANNED) {
    if (code.includes(needle)) {
      console.error(`lint: ${rel} contains banned import ${needle}`)
      failed += 1
    }
  }
  if (/\bBuffer\s*\.\s*(from|byteLength|alloc|concat)\b/.test(code)) {
    console.error(`lint: ${rel} requires Buffer (platform-neutral TextEncoder expected)`)
    failed += 1
  }
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  const values = typeof target === 'string' ? [target] : Object.values(target)
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith('./') || /^(?:[A-Za-z]:|[\\/]|(?:file|https?):)/.test(value)) {
      console.error(`lint: ${subpath} has an absolute or non-local export target ${String(value)}`)
      failed += 1
    }
  }
}

const SECRET_PATTERNS = [/-----BEGIN .*PRIVATE KEY-----/, /xprv[0-9A-Za-z]{50,}/]
const SCAN_FILES = [...BROWSER_SOURCES, 'src/server.ts', 'src/service.ts', 'src/storage.ts', 'tsdown.config.ts', 'tsconfig.json', 'package.json']
for (const rel of SCAN_FILES) {
  try {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    for (const re of SECRET_PATTERNS) {
      if (re.test(source)) {
        console.error(`lint: ${rel} looks like it contains a secret`)
        failed += 1
      }
    }
  } catch {}
}

if (failed > 0) {
  console.error(`lint: ${failed} problem(s)`)
  process.exit(1)
}
console.log('lint: browser-safe graph, local export, and secret scan ok')
