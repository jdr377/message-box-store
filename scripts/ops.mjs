#!/usr/bin/env node

try {
  await import('dotenv/config')
} catch {
  // dotenv is optional when the environment is already exported
}

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const COMMANDS = new Set(['start', 'migrate', 'check-config'])

const OPERATIONAL_FAILURES = Object.freeze({
  ERR_STORAGE_CONFIGURATION: 'configuration is invalid',
  ERR_MYSQL_CONFIG: 'MySQL configuration is invalid',
  ERR_MIGRATION_CHECKSUM: 'migration verification failed',
  ERR_MIGRATION_STRUCTURE: 'migration verification failed',
  ERR_UNAVAILABLE: 'operation unavailable',
  ERR_INTERNAL: 'operation failed',
})

/** Map untrusted failures without serializing driver, SQL, or connection text. */
export function formatOperationalFailure(error) {
  const candidate = typeof error?.code === 'string' ? error.code : ''
  const code = Object.hasOwn(OPERATIONAL_FAILURES, candidate) ? candidate : 'ERR_INTERNAL'
  return { status: 'error', code, description: OPERATIONAL_FAILURES[code] }
}

function writeFailure(error) {
  process.stderr.write(`${JSON.stringify(formatOperationalFailure(error))}\n`)
}

function ok(fields) {
  process.stdout.write(`${JSON.stringify({ status: 'ok', ...fields })}\n`)
}

async function loadServer() {
  return import('../dist/server.js')
}

function parseListen() {
  const host = process.env.MESSAGE_BOX_STORE_HOST ?? '127.0.0.1'
  const rawPort = process.env.MESSAGE_BOX_STORE_PORT ?? '8080'
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    const error = new Error('MESSAGE_BOX_STORE_PORT must be an integer of 0..65535')
    error.code = 'ERR_STORAGE_CONFIGURATION'
    throw error
  }
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) {
    const error = new Error('MESSAGE_BOX_STORE_HOST is invalid')
    error.code = 'ERR_STORAGE_CONFIGURATION'
    throw error
  }
  return { host, port }
}

async function verifyExistingMigrations(knex) {
  const { MYSQL_MIGRATION_CHAIN, verifyMysqlSchema } = await import('../src/migrations.mjs')
  let rows = []
  try {
    rows = (await knex.raw('SELECT version FROM schema_migrations'))[0] ?? []
  } catch {
    const error = new Error('migrations have not been applied; run the migrate command first')
    error.code = 'ERR_MIGRATION_STRUCTURE'
    throw error
  }
  const recorded = new Set(rows.map((row) => row.version))
  const missing = MYSQL_MIGRATION_CHAIN.filter((entry) => !recorded.has(entry.version))
  if (missing.length > 0) {
    const error = new Error('migrations have not been applied; run the migrate command first')
    error.code = 'ERR_MIGRATION_STRUCTURE'
    throw error
  }
  await verifyMysqlSchema(knex)
  return MYSQL_MIGRATION_CHAIN.map((entry) => entry.version)
}

async function runCheckConfig() {
  const { loadServiceConfigFromEnv } = await loadServer()
  const config = loadServiceConfigFromEnv(process.env)
  ok({
    retention: config.retention,
    version: config.version,
    maxConcurrentRequests: config.maxConcurrentRequests,
    preAuthRatePerMinPerIp: config.preAuthRatePerMinPerIp,
    authRatePerMinPerIdentity: config.authRatePerMinPerIdentity,
    trustedProxy: config.trustedProxy,
    pool: { min: config.mysql.pool.min, max: config.mysql.pool.max },
    cleanupIntervalMs: config.cleanupIntervalMs,
    cleanupOwners: config.cleanupOwners.length,
    shutdownDrainTimeoutMs: config.shutdownDrainTimeoutMs,
    allowedOrigins: config.allowedOrigins.length,
  })
}

async function runMigrate() {
  const { loadServiceConfigFromEnv } = await loadServer()
  const config = loadServiceConfigFromEnv(process.env)
  const { createMysqlKnex, migrateMysql } = await import('../src/repository.mysql.mjs')
  const { verifyMysqlSchema } = await import('../src/migrations.mjs')
  const knex = await createMysqlKnex({ ...config.mysql })
  try {
    const versions = await migrateMysql(knex)
    await verifyMysqlSchema(knex)
    ok({ migrations: versions })
  } finally {
    await knex.destroy()
  }
}

async function runStart() {
  const { createService, loadServiceConfigFromEnv } = await loadServer()
  const config = loadServiceConfigFromEnv(process.env)
  const { host, port } = parseListen()
  const service = await createService({ config, migrate: verifyExistingMigrations })
  const server = await service.start(port, host)
  const address = server.address()
  const boundPort = address !== null && typeof address === 'object' ? address.port : port
  try {
    const migrations = await service.migrate()
    ok({ listening: true, host, port: boundPort, migrations })
  } catch (error) {
    const { code, description } = formatOperationalFailure(error)
    process.stderr.write(`${JSON.stringify({ status: 'error', level: 'warn', event: 'startup', fields: { ready: false, code, description } })}\n`)
    ok({ listening: true, host, port: boundPort, ready: false })
  }

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    try {
      await service.stop()
      await service.close()
    } catch {
      process.exitCode = 1
    }
    process.exit(process.exitCode ?? 0)
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

export async function main(command = process.argv[2]) {
  if (!COMMANDS.has(command)) {
    process.stderr.write(`${JSON.stringify({
      status: 'error',
      code: 'ERR_INVALID_RECORD',
      description: 'usage: ops.mjs start|migrate|check-config',
    })}\n`)
    return 1
  }

  try {
    if (command === 'check-config') await runCheckConfig()
    else if (command === 'migrate') await runMigrate()
    else await runStart()
    return 0
  } catch (error) {
    writeFailure(error)
    return 1
  }
}

const invokedUrl = process.argv[1] === undefined ? '' : pathToFileURL(resolve(process.argv[1])).href
if (invokedUrl === import.meta.url) process.exitCode = await main()
