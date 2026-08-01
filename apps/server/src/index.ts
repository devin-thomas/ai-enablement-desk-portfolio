import { createApp } from './app.js'
import { loadEnv } from './config/env.js'

const env = loadEnv()
const app = await createApp({ env })
app.server.listen(env.port, env.host, () => {
  const migrations = app.appliedMigrations.length > 0 ? app.appliedMigrations.join(', ') : 'schema current'
  console.log(`AI Enablement server listening on http://${env.host}:${env.port} (${migrations})`)
})

let shuttingDown = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; draining HTTP connections`)

  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown exceeded 10 seconds; closing active connections')
    app.server.closeAllConnections()
    process.exit(1)
  }, 10_000)
  forceExit.unref()

  try {
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()))
    await app.database.close()
    clearTimeout(forceExit)
    process.exit(0)
  } catch (error) {
    console.error('Graceful shutdown failed', error)
    clearTimeout(forceExit)
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal))
}
