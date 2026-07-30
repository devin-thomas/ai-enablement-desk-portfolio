import { loadEnv } from './config/env.js'
import { createDatabase } from './database.js'
import { migrate } from './migrations.js'

const database = await createDatabase(loadEnv())
try {
  const applied = await migrate(database)
  const versions = await database.query<{ version: string; applied_at: Date }>('select version, applied_at from schema_migrations order by version')
  console.log(JSON.stringify({ newlyApplied: applied, schemaVersions: versions.rows }, null, 2))
} finally {
  await database.close()
}
