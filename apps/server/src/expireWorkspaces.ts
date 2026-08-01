import { loadEnv } from './config/env.js'
import { createDatabase } from './database.js'
import { migrate } from './migrations.js'
import { expireInactiveWorkspaces } from './workspaceCleanup.js'

const database = await createDatabase(loadEnv())
try {
  await migrate(database)
  await expireInactiveWorkspaces(database)
} finally {
  await database.close()
}
