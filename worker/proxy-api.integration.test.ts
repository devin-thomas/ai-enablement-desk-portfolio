import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type AppInstance } from '../apps/server/src/app.js'
import type { ServerEnv } from '../apps/server/src/config/env.js'
import { createMemoryDatabase } from '../apps/server/src/database.js'
import { nativeFetch } from '../apps/server/test/browser.js'
import worker from './index'

const originCredential = 'synthetic-origin-credential-for-proxy-test'
const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused', azureOriginCredential: originCredential,
  workspaceCookieSecret: 'synthetic-workspace-secret-for-proxy-test', geminiModel: 'stub', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000,
}

describe('Cloudflare Worker to API boundary', () => {
  let app: AppInstance
  let apiBaseUrl: string

  beforeEach(async () => {
    app = await createApp({ database: createMemoryDatabase(), env })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    apiBaseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    vi.stubGlobal('fetch', async (request: Request) => {
      const upstreamUrl = new URL(request.url)
      const localUrl = new URL(`${upstreamUrl.pathname}${upstreamUrl.search}`, apiBaseUrl)
      return nativeFetch(new Request(localUrl, request))
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await new Promise<void>((resolve) => app.server.close(() => resolve()))
    await app.database.close()
  })

  it('injects origin authentication and preserves isolated browser workspaces', async () => {
    const bindings = {
      ASSETS: { fetch: vi.fn(async () => new Response('portfolio asset')) },
      AZURE_API_BASE_URL: 'https://api.azure.example',
      AZURE_ORIGIN_CREDENTIAL: originCredential,
    }

    expect((await nativeFetch(`${apiBaseUrl}/api/requests`)).status).toBe(403)

    const firstList = await worker.fetch(new Request('https://preview.example/api/requests'), bindings, {} as ExecutionContext)
    expect(firstList.status).toBe(200)
    const firstCookie = firstList.headers.get('set-cookie')?.split(';')[0]
    expect(firstCookie).toContain('aed_workspace=')
    await expect(firstList.json()).resolves.toEqual({ requests: [] })

    const reset = await worker.fetch(new Request('https://preview.example/api/demo/reset', { method: 'POST', headers: { cookie: firstCookie! } }), bindings, {} as ExecutionContext)
    expect(reset.status).toBe(200)
    await expect(reset.json()).resolves.toMatchObject({ requests: expect.arrayContaining([expect.objectContaining({ title: 'Maintenance field report triage' })]) })

    const firstWorkspace = await worker.fetch(new Request('https://preview.example/api/requests', { headers: { cookie: firstCookie! } }), bindings, {} as ExecutionContext)
    await expect(firstWorkspace.json()).resolves.toMatchObject({ requests: expect.arrayContaining([expect.objectContaining({ title: 'Maintenance field report triage' })]) })

    const secondWorkspace = await worker.fetch(new Request('https://preview.example/api/requests'), bindings, {} as ExecutionContext)
    await expect(secondWorkspace.json()).resolves.toEqual({ requests: [] })
  })
})
