import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Database } from './database.js'
import { repositoryRoot } from './paths.js'

export async function migrate(database: Database, migrationsDirectory = resolve(repositoryRoot, 'database/migrations')): Promise<string[]> {
  await database.query(`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`)

  const entries = (await readdir(migrationsDirectory)).filter((entry) => /^\d+_.+\.sql$/.test(entry)).sort()
  const applied = await database.query<{ version: string }>('select version from schema_migrations')
  const appliedVersions = new Set(applied.rows.map((row) => row.version))
  const newlyApplied: string[] = []

  for (const entry of entries) {
    if (appliedVersions.has(entry)) continue
    const sql = await readFile(resolve(migrationsDirectory, entry), 'utf8')
    await database.transaction(async (transaction) => {
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await transaction.query(statement)
      }
      await transaction.query('insert into schema_migrations (version) values ($1)', [entry])
    })
    newlyApplied.push(entry)
  }
  return newlyApplied
}
