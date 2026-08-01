import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createApp, type AppInstance } from '../src/app.js'
import { createMemoryDatabase } from '../src/database.js'
import type { ServerEnv } from '../src/config/env.js'

const validRequest = {
  title: 'Maintenance report summarization',
  requestType: 'ai_project',
  department: 'Operations Excellence',
  requesterName: 'Synthetic Requester',
  requesterRole: 'Maintenance Manager',
  businessProblem: 'Maintenance managers need a faster way to review long synthetic field reports.',
  desiredOutcome: 'Surface important issues for human review.',
  currentProcess: 'Managers read every synthetic report manually.',
  intendedUsers: ['Maintenance managers'],
  dataSources: ['Synthetic field reports'],
} as const

const testEnv: ServerEnv = {
  nodeEnv: 'test',
  port: 3001,
  demoMode: true,
  demoDatabasePath: 'unused',
  geminiModel: 'stub-model', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000,
}

describe('request intake API', () => {
  let app: AppInstance
  let baseUrl: string

  beforeEach(async () => {
    app = await createApp({ database: createMemoryDatabase(), env: testEnv })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    if (!app) return
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()))
    await app.database.close()
  })

  it('creates, lists, and retrieves a durable request with a requester audit event', async () => {
    const createdResponse = await fetch(`${baseUrl}/api/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validRequest),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json()
    expect(created.request.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.request.auditEvents).toContainEqual(expect.objectContaining({ actorType: 'requester', actorName: 'Synthetic Requester', eventType: 'request_submitted' }))

    const list = await (await fetch(`${baseUrl}/api/requests`)).json()
    expect(list.requests).toHaveLength(1)
    expect(list.requests[0].id).toBe(created.request.id)

    const detail = await (await fetch(`${baseUrl}/api/requests/${created.request.id}`)).json()
    expect(detail.request).toEqual(created.request)
  })

  it('accepts tool access requests through the same persisted boundary', async () => {
    const response = await fetch(`${baseUrl}/api/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validRequest, requestType: 'tool_access', title: 'AI writing tool access' }),
    })
    expect(response.status).toBe(201)
    expect((await response.json()).request.requestType).toBe('tool_access')
  })

  it('rejects invalid payloads on the server', async () => {
    const response = await fetch(`${baseUrl}/api/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...validRequest, businessProblem: 'too short' }),
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'Request validation failed' })
    expect((await (await fetch(`${baseUrl}/api/requests`)).json()).requests).toHaveLength(0)
  })

  it('returns not found for unknown request IDs', async () => {
    const response = await fetch(`${baseUrl}/api/requests/00000000-0000-0000-0000-000000000000`)
    expect(response.status).toBe(404)
  })

  it('keeps demo reset disabled by default', async () => {
    const health = await fetch(`${baseUrl}/health`)
    await expect(health.json()).resolves.toMatchObject({ features: { demoReset: false } })
    const response = await fetch(`${baseUrl}/api/demo/reset`, { method: 'POST' })
    expect(response.status).toBe(403)
  })

  it('allows the isolated production preview reset only when explicitly enabled', async () => {
    const credential = 'synthetic-origin-credential-for-preview-tests'
    const productionApp = await createApp({
      database: createMemoryDatabase(),
      env: {
        ...testEnv,
        nodeEnv: 'production',
        demoMode: false,
        demoResetEnabled: true,
        workspaceCookieSecret: 'synthetic-workspace-cookie-secret-for-preview-tests',
        azureOriginCredential: credential,
      },
    })
    try {
      await new Promise<void>((resolve) => productionApp.server.listen(0, '127.0.0.1', resolve))
      const productionBaseUrl = `http://127.0.0.1:${(productionApp.server.address() as AddressInfo).port}`
      const headers = { 'x-aed-origin-credential': credential }
      const health = await fetch(`${productionBaseUrl}/health`, { headers })
      await expect(health.json()).resolves.toMatchObject({ features: { demoReset: true } })

      const response = await fetch(`${productionBaseUrl}/api/demo/reset`, { method: 'POST', headers })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ requests: expect.arrayContaining([expect.objectContaining({ syntheticDemoSafe: true })]) })
    } finally {
      await new Promise<void>((resolve) => productionApp.server.close(() => resolve()))
      await productionApp.database.close()
    }
  })
})
