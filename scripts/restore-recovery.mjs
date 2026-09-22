try {
  await import('dotenv/config')
} catch {
  // dotenv is optional when the environment is already exported.
}

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { applyMysqlRestoreRecovery } from '../src/restore-recovery.mjs'

function failure(error) {
  const code = typeof error?.code === 'string' && /^ERR_RECOVERY_/.test(error.code) ? error.code : 'ERR_RECOVERY_STATE'
  process.stderr.write(`${JSON.stringify({ status: 'error', code, description: error?.message ?? 'restore recovery failed' })}\n`)
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [manifestPath, confirmation, ...extra] = argv
  if (typeof manifestPath !== 'string' || confirmation !== '--confirm-service-offline' || extra.length > 0) {
    throw Object.assign(new Error('usage: restore-recovery.mjs <receipt-bundle.json> --confirm-service-offline'), { code: 'ERR_RECOVERY_MANIFEST' })
  }
  if (env.MESSAGE_BOX_STORE_RECOVERY_ENABLED !== '1') {
    throw Object.assign(new Error('set MESSAGE_BOX_STORE_RECOVERY_ENABLED=1 for this offline recovery invocation'), { code: 'ERR_RECOVERY_STATE' })
  }
  const bundle = JSON.parse(await readFile(resolve(manifestPath), 'utf8'))
  const { createMysqlKnex } = await import('../src/repository.mysql.mjs')
  const knex = await createMysqlKnex({
    host: env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(env.MYSQL_PORT ?? 3306),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  })
  try {
    const { verifyMysqlSchema } = await import('../src/migrations.mjs')
    await verifyMysqlSchema(knex)
    const result = await applyMysqlRestoreRecovery({ knex, bundle })
    process.stdout.write(`${JSON.stringify({ status: 'ok', ...result })}\n`)
    return 0
  } finally {
    await knex.destroy()
  }
}

const invokedUrl = process.argv[1] === undefined ? '' : pathToFileURL(resolve(process.argv[1])).href
if (invokedUrl === import.meta.url) {
  try {
    process.exitCode = await main()
  } catch (error) {
    failure(error)
    process.exitCode = 1
  }
}
