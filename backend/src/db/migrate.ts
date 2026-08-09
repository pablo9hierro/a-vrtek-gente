import 'dotenv/config'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { pool } from './pool.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(here, '..', '..', 'migrations')

/** Roda todo .sql em migrations/ em ordem — idempotente (usa IF NOT EXISTS). */
export async function runMigrations() {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf-8')
    console.log(`[migrate] aplicando ${file}`)
    await pool.query(sql)
  }
  console.log('[migrate] concluído')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
