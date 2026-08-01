import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type AppInstance } from '../src/app.js'
import type { ServerEnv } from '../src/config/env.js'
import { createMemoryDatabase } from '../src/database.js'

const credential = 'synthetic-origin-credential-for-tests'
const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused', azureOriginCredential: credential,
  workspaceCookieSecret: 'synthetic-workspace-cookie-secret', geminiModel: 'stub', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000,
}

describe('Azure origin authentication', () => {
  let app: AppInstance | undefined

  afterEach(async () => {
    if (!app) return
    await new Promise<void>((resolve) => app?.server.close(() => resolve()))
    await app.database.close()
    app = undefined
  })

  it('keeps probe endpoints public while rejecting direct API and detailed health requests', async () => {
    app = await createApp({ database: createMemoryDatabase(), env })
    await new Promise<void>((resolve) => app?.server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/health`)).status).toBe(403)
    expect((await fetch(`${baseUrl}/api/requests`)).status).toBe(403)
    expect((await fetch(`${baseUrl}/api/requests`, { headers: { 'x-aed-origin-credential': 'wrong' } })).status).toBe(403)

    const authorized = await fetch(`${baseUrl}/api/requests`, { headers: { 'x-aed-origin-credential': credential } })
    expect(authorized.status).toBe(200)
    expect(authorized.headers.get('set-cookie')).toContain('aed_workspace=')
    await expect(authorized.json()).resolves.toEqual({ requests: [] })
  })

  it('requires strong workspace and origin credentials in production', async () => {
    const productionEnv: ServerEnv = { ...env, nodeEnv: 'production' }
    const database = createMemoryDatabase()

    try {
      await expect(createApp({ database, env: { ...productionEnv, workspaceCookieSecret: undefined } })).rejects.toThrow('WORKSPACE_COOKIE_SECRET must be at least 32 characters in production')
      await expect(createApp({ database, env: { ...productionEnv, azureOriginCredential: undefined } })).rejects.toThrow('AZURE_ORIGIN_CREDENTIAL must be at least 32 characters in production')
    } finally {
      await database.close()
    }
  })
})
