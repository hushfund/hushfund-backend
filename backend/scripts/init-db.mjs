import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Configure your private database connection first.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
try {
  const schema = await readFile(new URL('../database/001-relay.sql', import.meta.url), 'utf8')
  await pool.query(schema)
  console.log('Hushfund relayer database schema is ready. No existing records were removed.')
} catch {
  console.error('Database initialization failed. Check database connectivity and schema permissions privately.')
  process.exitCode = 1
} finally {
  await pool.end()
}
