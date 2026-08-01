import { access } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { createApp } from '../apps/server/src/app.js'
import type { ServerEnv } from '../apps/server/src/config/env.js'
import { createMemoryDatabase } from '../apps/server/src/database.js'

await access(resolve('dist/index.html'))
const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused',
  geminiModel: 'smoke', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000,
}
const app = await createApp({ database: createMemoryDatabase(), env })
await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen))
const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

try {
  const health = await (await fetch(`${baseUrl}/health`)).json() as { ok: boolean; providers: Record<string, string> }
  if (!health.ok || health.providers.gemini !== 'unavailable_key' || health.providers.n8n !== 'disabled' || health.providers.fishAudio !== 'disabled') throw new Error('Provider degradation health check failed.')
  const created = await fetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    title: 'Synthetic smoke request', requestType: 'tool_access', department: 'Demo', requesterName: 'Synthetic Requester', requesterRole: 'Tester',
    businessProblem: 'Verify the trusted persistence boundary.', desiredOutcome: 'Persist and retrieve a synthetic record.',
    currentProcess: null, intendedUsers: ['Demo tester'], dataSources: ['Synthetic data'], syntheticDemoSafe: true,
  }) })
  if (created.status !== 201) throw new Error(`Request smoke check failed with HTTP ${created.status}.`)
  const workspaceCookie = created.headers.get('set-cookie')?.split(';')[0]
  if (!workspaceCookie) throw new Error('Workspace cookie was not issued.')
  const list = await (await fetch(`${baseUrl}/api/requests`, { headers: { cookie: workspaceCookie } })).json() as { requests: unknown[] }
  if (list.requests.length !== 1) throw new Error('Database smoke check did not retrieve the request.')
  console.log('Smoke test passed: web build, server, embedded Postgres, and degraded provider boundaries are healthy.')
} finally {
  await new Promise<void>((resolveClose) => app.server.close(() => resolveClose()))
  await app.database.close()
}
