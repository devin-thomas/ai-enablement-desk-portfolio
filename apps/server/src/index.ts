import { createApp } from './app.js'
import { loadEnv } from './config/env.js'

const env = loadEnv()
const app = await createApp({ env })
app.server.listen(env.port, () => {
  const migrations = app.appliedMigrations.length > 0 ? app.appliedMigrations.join(', ') : 'schema current'
  console.log(`AI Enablement server listening on http://localhost:${env.port} (${migrations})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.server.close(() => void app.database.close().finally(() => process.exit(0)))
  })
}
